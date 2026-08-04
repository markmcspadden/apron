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

  await clickhouse.ensureSchema().catch(() => {
    console.log('[clickhouse] Not connected — audit log will use in-memory store only');
  });

  if (gemini.isEnabled()) {
    console.log('[google-cloud] Gemini client connected');
  } else {
    console.log('[google-cloud] Fixture mode — Gemini responses are stubbed');
  }

  const clients = new Set<WebSocket>();

  orchestrator.onEvent((event: AgentEvent) => {
    audit.append(event);
    grafana.recordEvent(event);
    clickhouse.record(event);
  });

  orchestrator.onStepComplete((step, index) => {
    const msg = JSON.stringify({ type: 'step', step, index });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(msg);
      }
    }
  });

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;

    if (path === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        playing: orchestrator.isPlaying(),
        step: orchestrator.getCurrentStep(),
        totalSteps: orchestrator.getTotalSteps(),
        agents: orchestrator.getRuntime().getProvisionedAgents(),
        auditEntries: audit.count(),
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

    // Static files
    let filePath: string;
    if (path === '/board' || path === '/board.html') {
      filePath = join(ROOT, 'packages', 'board', 'index.html');
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

  wss.on('connection', (ws) => {
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
