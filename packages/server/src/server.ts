import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { Orchestrator } from '@apron/orchestrator';
import { SpotterAgent } from '@apron/agent-spotter';
import { TrafficAgent } from '@apron/agent-traffic';
import { AdvanceAgent } from '@apron/agent-advance';
import { WranglerAgent } from '@apron/agent-wrangler';
import { StewardAgent } from '@apron/agent-steward';
import { FixerAgent } from '@apron/agent-fixer';
import { RunnerAgent } from '@apron/agent-runner';
import { CustomsAgent } from '@apron/agent-customs';
import { AuditLog } from './audit.js';
import { GrafanaReporter } from '@apron/integration-grafana';
import { ClickhouseAuditStore } from '@apron/integration-clickhouse';
import { GeminiClient } from '@apron/integration-google-cloud';
import type { AgentEvent, FixtureScenario } from '@apron/types';

let FirebaseAuth: typeof import('@apron/integration-firebase').FirebaseAuth | undefined;
let FirestoreStore: typeof import('@apron/integration-firebase').FirestoreStore | undefined;
let getClientConfig: typeof import('@apron/integration-firebase').getClientConfig | undefined;

try {
  const fb = await import('@apron/integration-firebase');
  FirebaseAuth = fb.FirebaseAuth;
  FirestoreStore = fb.FirestoreStore;
  getClientConfig = fb.getClientConfig;
} catch {
  // Firebase integration not available — running in demo mode
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

interface ServerOptions {
  autoPlay?: boolean;
}

export async function createServer(opts: ServerOptions = {}) {
  const scenario = await loadScenario();
  const orchestrator = new Orchestrator('alcs-gm4', ['CUSTOMS']);

  orchestrator.registerAgent(new SpotterAgent());
  orchestrator.registerAgent(new TrafficAgent());
  orchestrator.registerAgent(new AdvanceAgent());
  orchestrator.registerAgent(new WranglerAgent());
  orchestrator.registerAgent(new StewardAgent());
  orchestrator.registerAgent(new FixerAgent());
  orchestrator.registerAgent(new RunnerAgent());

  try {
    orchestrator.registerAgent(new CustomsAgent());
  } catch {
    // CUSTOMS not provisioned for domestic show
  }

  orchestrator.loadScenario(scenario);

  const audit = new AuditLog();
  const grafana = new GrafanaReporter();
  const clickhouse = new ClickhouseAuditStore();
  const gemini = new GeminiClient();

  // Firebase integration (optional)
  const auth = FirebaseAuth ? new FirebaseAuth() : null;
  const firestore = FirestoreStore ? new FirestoreStore() : null;
  const clientConfig = getClientConfig ? getClientConfig() : null;

  await clickhouse.ensureSchema().catch(() => {
    console.log('[clickhouse] Not connected — audit log will use in-memory store only');
  });

  if (gemini.isEnabled()) {
    console.log('[google-cloud] Gemini client connected');
  } else {
    console.log('[google-cloud] Fixture mode — Gemini responses are stubbed');
  }

  if (auth?.isEnabled()) {
    console.log('[firebase] Auth enabled — tokens will be verified');
  } else {
    console.log('[firebase] Auth not configured — running unauthenticated');
  }

  if (firestore?.isEnabled()) {
    console.log('[firebase] Firestore connected');
  } else {
    console.log('[firebase] Firestore not connected — using in-memory state only');
  }

  const clients = new Set<WebSocket>();

  orchestrator.onEvent((event: AgentEvent) => {
    audit.append(event);
    grafana.recordEvent(event);
    clickhouse.record(event);
    firestore?.recordAuditEvent({
      ...event,
      _showId: event.showId,
    }).catch(() => { /* best-effort */ });
  });

  orchestrator.onStepComplete((step, index) => {
    const msg = JSON.stringify({ type: 'step', step, index });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(msg);
      }
    }
  });

  // Helper: verify auth if configured, pass through if not
  async function verifyRequest(req: { headers: Record<string, string | string[] | undefined> }): Promise<{ uid: string; email?: string; name?: string } | null> {
    if (!auth?.isEnabled()) return null; // no auth configured, allow all

    const authHeader = req.headers['authorization'];
    const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null;

    if (!token) return null; // no token provided
    return auth.verifyToken(token);
  }

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;

    // CORS for API routes
    if (path.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    // Firebase client config endpoint — serves to the board for client-side auth
    if (path === '/api/auth/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ config: clientConfig }));
      return;
    }

    if (path === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        playing: orchestrator.isPlaying(),
        step: orchestrator.getCurrentStep(),
        totalSteps: orchestrator.getTotalSteps(),
        agents: orchestrator.getRuntime().getProvisionedAgents(),
        auditEntries: audit.count(),
        auth: auth?.isEnabled() ?? false,
      }));
      return;
    }

    if (path === '/api/scenario') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(scenario));
      return;
    }

    if (path === '/api/audit') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(audit.getAll()));
      return;
    }

    if (path === '/api/play' && req.method === 'POST') {
      orchestrator.play();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (path === '/api/pause' && req.method === 'POST') {
      orchestrator.stop();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (path === '/api/next' && req.method === 'POST') {
      const step = await orchestrator.nextStep();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, step }));
      return;
    }

    if (path === '/api/reset' && req.method === 'POST') {
      orchestrator.reset();
      audit.clear();
      const msg = JSON.stringify({ type: 'reset', scenario });
      for (const ws of clients) {
        if (ws.readyState === ws.OPEN) ws.send(msg);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Admin API routes
    if (path.startsWith('/api/admin/')) {
      try {
        const { handleAdminRoutes } = await import('./admin-api.js');
        const handled = await handleAdminRoutes(req, res, firestore);
        if (handled) return;
      } catch {
        // admin-api module not available
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Static files
    let filePath: string;
    if (path === '/board' || path === '/board.html') {
      filePath = join(ROOT, 'packages', 'board', 'index.html');
    } else if (path === '/admin' || path === '/admin.html') {
      filePath = join(ROOT, 'packages', 'board', 'admin.html');
    } else if (path === '/' || path === '/index.html') {
      filePath = join(ROOT, 'site', 'index.html');
    } else {
      filePath = join(ROOT, 'site', path);
    }

    try {
      const content = await readFile(filePath);
      const ext = extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', async (ws, req) => {
    // Verify auth on WebSocket connect if configured
    if (auth?.isEnabled()) {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const token = url.searchParams.get('token');
      if (token) {
        try {
          await auth.verifyToken(token);
        } catch {
          ws.close(4001, 'Unauthorized');
          return;
        }
      }
      // If no token but auth is enabled, allow for now (demo compatibility)
      // In production, uncomment the next line:
      // else { ws.close(4001, 'Token required'); return; }
    }

    clients.add(ws);
    console.log(`[ws] Client connected (${clients.size} total)`);

    const currentStep = orchestrator.getCurrentStep();
    ws.send(JSON.stringify({
      type: 'init',
      scenario,
      currentStep,
      playing: orchestrator.isPlaying(),
    }));

    if (opts.autoPlay && !orchestrator.isPlaying() && orchestrator.getCurrentStep() < 0) {
      orchestrator.play();
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.action === 'play') orchestrator.play();
        else if (msg.action === 'pause') orchestrator.stop();
        else if (msg.action === 'next') orchestrator.nextStep();
        else if (msg.action === 'reset') {
          orchestrator.reset();
          audit.clear();
          const resetMsg = JSON.stringify({ type: 'reset', scenario });
          for (const c of clients) {
            if (c.readyState === c.OPEN) c.send(resetMsg);
          }
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[ws] Client disconnected (${clients.size} total)`);
    });
  });

  return httpServer;
}

async function loadScenario(): Promise<FixtureScenario> {
  const { scenario } = await import(
    join(ROOT, 'fixtures', 'alcs-gm4', 'scenario.ts')
  );
  return scenario as FixtureScenario;
}
