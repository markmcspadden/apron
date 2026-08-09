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
import type { AgentEvent, FixtureScenario, ChainNode } from '@apron/types';
import type { SpotterWatchConfig } from '@apron/agent-spotter';
import { GAME_TYPE_DEFAULTS, type GameType } from './admin-store.js';
import { initAdminStore } from './admin-api.js';

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
  /** Force in-memory store, skip Firebase — for demo mode. */
  demoMode?: boolean;
}

export async function createServer(opts: ServerOptions = {}) {
  const scenario = await loadScenario();
  const orchestrator = new Orchestrator('alcs-gm4', ['CUSTOMS']);

  const demoSpotter = new SpotterAgent();
  orchestrator.registerAgent(demoSpotter);

  /** Live SPOTTER instances — one per watched game, keyed by gameId. */
  const spotters = new Map<string, SpotterAgent>();
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

  // Firebase integration — skip entirely in demo mode so the demo never
  // accidentally writes to Firestore even if ADC is configured locally.
  const auth = (!opts.demoMode && FirebaseAuth) ? new FirebaseAuth() : null;
  const firestore = (!opts.demoMode && FirestoreStore) ? new FirestoreStore() : null;
  const clientConfig = (!opts.demoMode && getClientConfig) ? getClientConfig() : null;

  // Await Firestore initialization before checking — isEnabled() is synchronous
  // and will return false if the async init hasn't finished yet.
  if (firestore) {
    await firestore.waitReady();
  }

  await clickhouse.ensureSchema().catch(() => {
    console.log('[clickhouse] Not connected — audit log will use in-memory store only');
  });

  // Initialize admin store eagerly so the SPOTTER watch endpoint can use it
  const adminStore = initAdminStore(firestore);

  if (gemini.isEnabled()) {
    console.log(`[google-cloud] Gemini client connected (${gemini.getMode()})`);
  } else {
    console.log('[google-cloud] Fixture mode — Gemini responses are stubbed');
  }

  if (opts.demoMode) {
    console.log('[firebase] Demo mode — using in-memory store (Firestore skipped)');
  } else if (auth?.isEnabled()) {
    console.log('[firebase] Auth enabled — tokens will be verified');
  } else {
    console.log('[firebase] Auth not configured — running unauthenticated');
  }

  if (!opts.demoMode && firestore?.isEnabled()) {
    console.log('[firebase] Firestore connected');
  } else if (!opts.demoMode) {
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

    // ---- ESPN live games lookup ----
    if (path === '/api/espn/live') {
      const sport = url.searchParams.get('sport') ?? undefined;
      try {
        const { ESPNClient } = await import('@apron/agent-spotter');
        const espn = new ESPNClient();
        const games = await espn.findLiveGames(sport);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ games }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to fetch ESPN games' }));
      }
      return;
    }

    // ---- SPOTTER dashboard API (multi-instance) ----
    if (path === '/api/spotter/status') {
      // Active watchers from in-memory Map
      const watches: Array<{ gameId: string; status: ReturnType<SpotterAgent['getStatus']> }> = [];
      for (const [gid, s] of spotters) {
        watches.push({ gameId: gid, status: s.getStatus() });
      }

      // Inactive SPOTTER agents from Firestore (done = game ended, idle = manually stopped)
      const completed: Array<{
        gameId: string;
        accountId: string;
        title: string;
        agent: import('./admin-store.js').AgentAssignment;
        record?: Record<string, unknown>;
      }> = [];
      try {
        const doneGames = await adminStore.listGamesByAgentStatus('SPOTTER', ['done', 'idle']);
        for (const g of doneGames) {
          // Skip games that are currently active in-memory
          if (!spotters.has(g.id) && g.agents?.SPOTTER) {
            // Don't include the full log in the status poll — it's fetched on demand
            const record = await adminStore.getAgentRecord(g.accountId, g.id, 'SPOTTER');
            const summary = record ? { ...record } : undefined;
            if (summary) delete summary['log']; // strip log from poll response
            completed.push({
              gameId: g.id,
              accountId: g.accountId,
              title: g.title,
              agent: g.agents.SPOTTER,
              record: summary,
            });
          }
        }
      } catch { /* Firestore unavailable — no history */ }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ watches, completed }));
      return;
    }

    if (path === '/api/spotter/log') {
      const params = new URL(req.url ?? '/', `http://${req.headers.host}`).searchParams;
      const count = parseInt(params.get('n') ?? '200', 10);
      const gameId = params.get('gameId');
      if (gameId && spotters.has(gameId)) {
        const s = spotters.get(gameId)!;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ entries: s.getLog(count), total: s.getStatus().logTotal }));
      } else {
        // Return combined logs from all spotters, sorted by timestamp
        const all: Array<ReturnType<SpotterAgent['getLog']>[number] & { gameId: string }> = [];
        for (const [gid, s] of spotters) {
          for (const entry of s.getLog(count)) {
            all.push({ ...entry, gameId: gid });
          }
        }
        all.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        const total = Array.from(spotters.values()).reduce((sum, s) => sum + s.getStatus().logTotal, 0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ entries: all.slice(-count), total }));
      }
      return;
    }

    // Fetch a persisted agent record (for completed SPOTTER logs, etc.)
    // GET /api/spotter/record?accountId=...&gameId=...
    if (path === '/api/spotter/record') {
      const params = new URL(req.url ?? '/', `http://${req.headers.host}`).searchParams;
      const accountId = params.get('accountId');
      const gameId = params.get('gameId');
      if (!accountId || !gameId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'accountId and gameId required' }));
        return;
      }
      try {
        const record = await adminStore.getAgentRecord(accountId, gameId, 'SPOTTER');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ record }));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to fetch agent record' }));
      }
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

    // ---- SPOTTER live watch API ----
    const watchMatch = path.match(/^\/api\/admin\/accounts\/([^/]+)\/games\/([^/]+)\/(watch|unwatch)$/);
    if (watchMatch && req.method === 'POST') {
      const [, acctId, gameId, action] = watchMatch;

      if (action === 'unwatch') {
        const existing = spotters.get(gameId!);
        if (existing) {
          const snap = existing.getStatus();
          const fullLog = existing.getLog();
          existing.stopWatching();
          spotters.delete(gameId!);

          // Persist to both levels: game doc (lifecycle) + agent record (detail + log)
          const stoppedAt = new Date().toISOString();
          void adminStore.setAgentAssignment(acctId!, gameId!, 'SPOTTER', {
            status: 'idle',
            startedAt: snap.startedAt ?? stoppedAt,
            stoppedAt,
          });
          void adminStore.setAgentRecord(acctId!, gameId!, 'SPOTTER', {
            status: 'idle',
            stoppedAt,
            lastScore: snap.game ? `${snap.game.awayTeam} ${snap.game.awayScore}, ${snap.game.homeTeam} ${snap.game.homeScore}` : null,
            lastDetail: snap.game?.detail ?? null,
            lastPrediction: snap.prediction?.predictedEnd ?? null,
            lastShowState: snap.prediction?.showState ?? null,
            log: fullLog,
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, watching: false }));
        return;
      }

      // action === 'watch' — start live SPOTTER for this game
      try {
        const games = await adminStore.listGames(acctId!);
        const game = games.find(g => g.id === gameId);

        if (!game) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Game not found' }));
          return;
        }

        if (!game.espnEventId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Game has no espnEventId — set it in the admin console first' }));
          return;
        }

        if (!game.gameType || !['baseball', 'football', 'basketball', 'hockey'].includes(game.gameType)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `gameType must be baseball, football, basketball, or hockey (got: ${game.gameType})` }));
          return;
        }

        const defaults = GAME_TYPE_DEFAULTS[game.gameType as GameType];

        // Build game-specific chain from game timing data (not the fixture)
        const gameChain = buildGameChain(game, defaults);

        const config: SpotterWatchConfig = {
          showId: game.id,
          sport: game.gameType as 'baseball' | 'football' | 'basketball' | 'hockey',
          espnEventId: game.espnEventId,
          scheduledStart: game.startTime
            ? new Date(`${game.date}T${game.startTime}`).toISOString()
            : new Date(`${game.date}T19:00`).toISOString(),
          expectedDurationMinutes: game.expectedDuration ?? defaults.duration,
          strikeDurationMinutes: game.strikeDuration ?? defaults.strike,
          chain: gameChain,
          crewCount: game.crewCount ?? 22,
          gemini: gemini.isEnabled() ? gemini : undefined,
        };

        // Stop existing watcher for this game if already running
        const prev = spotters.get(game.id);
        if (prev) prev.stopWatching();

        const liveSpotter = new SpotterAgent();
        // Bind to the orchestrator's bus so emit() works
        const bus = orchestrator.getRuntime().getBus();
        const now = new Date();
        const cred: import('@apron/types').Credential = {
          agent: 'SPOTTER',
          showId: game.id,
          grant: { agent: 'SPOTTER', capabilities: ['read:game-feeds', 'read:weather'], role: 'reader', neverReceives: [] },
          issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 86400000).toISOString(),
        };
        liveSpotter.bind({ bus, credential: cred, showId: game.id });
        liveSpotter.startWatching(config);
        spotters.set(game.id, liveSpotter);

        // Persist active state to both levels
        const watchStartedAt = new Date().toISOString();
        void adminStore.setAgentAssignment(acctId!, game.id, 'SPOTTER', {
          status: 'active', startedAt: watchStartedAt,
        });
        void adminStore.setAgentRecord(acctId!, game.id, 'SPOTTER', {
          status: 'active',
          startedAt: watchStartedAt,
          sport: config.sport,
          espnEventId: config.espnEventId,
        });

        // Broadcast SPOTTER events to WebSocket clients + auto-cleanup on game end
        const watchedGameId = game.id;
        const watchedAcctId = acctId!;
        orchestrator.getRuntime().getBus().subscribe((event: AgentEvent) => {
          if (event.agent === 'SPOTTER') {
            const msg = JSON.stringify({ type: 'agent-event', event });
            for (const ws of clients) {
              if (ws.readyState === ws.OPEN) ws.send(msg);
            }

            // Auto-remove from the Map when the agent signals it's done (game ended)
            if (event.type === 'agent-status' && event.agentStates.SPOTTER === 'done' && event.showId === watchedGameId) {
              const finished = spotters.get(watchedGameId);
              const snap = finished?.getStatus();
              const fullLog = finished?.getLog() ?? [];
              spotters.delete(watchedGameId);
              console.log(`[spotter] Game ended — removed watch for ${watchedGameId} (${spotters.size} remaining)`);

              // Persist done state to both levels (detail + full log)
              const stoppedAt = new Date().toISOString();
              void adminStore.setAgentAssignment(watchedAcctId, watchedGameId, 'SPOTTER', {
                status: 'done',
                startedAt: snap?.startedAt ?? watchStartedAt,
                stoppedAt,
              });
              void adminStore.setAgentRecord(watchedAcctId, watchedGameId, 'SPOTTER', {
                status: 'done',
                stoppedAt,
                lastScore: snap?.game ? `${snap.game.awayTeam} ${snap.game.awayScore}, ${snap.game.homeTeam} ${snap.game.homeScore}` : null,
                lastDetail: snap?.game?.detail ?? null,
                lastPrediction: snap?.prediction?.predictedEnd ?? null,
                lastShowState: snap?.prediction?.showState ?? null,
                log: fullLog,
              });
            }
          }
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          watching: true,
          game: game.title,
          gameId: game.id,
          espnEventId: game.espnEventId,
          sport: game.gameType,
          activeWatches: spotters.size,
        }));
        return;
      } catch (err) {
        console.error('[spotter-watch] Error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to start SPOTTER watch' }));
        return;
      }
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
    } else if (path === '/spotter' || path === '/spotter.html') {
      filePath = join(ROOT, 'packages', 'board', 'spotter.html');
    } else if (path === '/demo' || path === '/demo.html') {
      filePath = join(ROOT, 'packages', 'board', 'index.html');
    } else if (path === '/login' || path === '/login.html') {
      filePath = join(ROOT, 'packages', 'board', 'login.html');
    } else if (path === '/dashboard' || path === '/dashboard.html') {
      filePath = join(ROOT, 'packages', 'board', 'dashboard.html');
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

    // Auto-play for demo connections (query param ?demo=1) or server-wide autoPlay
    const wsUrl = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const isDemo = wsUrl.searchParams.get('demo') === '1';
    if ((opts.autoPlay || isDemo) && !orchestrator.isPlaying() && orchestrator.getCurrentStep() < 0) {
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

// ---------------------------------------------------------------------------
// Build a game-specific wrap-to-gate chain in ChainNode format
// (baseTime/revisedTime) from the game's timing fields.
// Falls back to the fixture scenario chain if not enough data.
// ---------------------------------------------------------------------------
function buildGameChain(
  game: { startTime?: string; expectedEndTime?: string; expectedDuration?: number;
    strikeDuration?: number; venueToTransport?: number; transportDuration?: number;
    overnightLabel?: string; lobbyCallTime?: string; minRestHours?: number;
    gameType?: string },
  defaults: { duration: number; strike: number },
): ChainNode[] {
  // Compute expected end in minutes since midnight
  let endMin: number;
  if (game.expectedEndTime) {
    const [h, m] = game.expectedEndTime.split(':').map(Number);
    endMin = h! * 60 + (m ?? 0);
  } else if (game.startTime) {
    const [h, m] = game.startTime.split(':').map(Number);
    const startMin = h! * 60 + (m ?? 0);
    const dur = game.expectedDuration ?? defaults.duration;
    endMin = startMin + dur;
  } else {
    // Not enough data — return a minimal chain
    return [{ label: 'Final out', baseTime: '23:00', revisedTime: '23:00' }];
  }

  const strikeMins = game.strikeDuration ?? defaults.strike;
  const venueToTransport = game.venueToTransport ?? 15;
  const transportDur = game.transportDuration ?? 27;

  const strikeEnd = endMin + strikeMins;
  const shuttleRolls = strikeEnd + venueToTransport;
  const overnightArr = shuttleRolls + transportDur;

  const fmt = (totalMin: number): string => {
    const h = Math.floor((totalMin % 1440) / 60);
    const m = totalMin % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  };

  const chain: ChainNode[] = [
    { label: 'Final out', baseTime: fmt(endMin), revisedTime: fmt(endMin) },
    { label: 'Strike complete', baseTime: fmt(strikeEnd), revisedTime: fmt(strikeEnd) },
    { label: 'Shuttle rolls', baseTime: fmt(shuttleRolls), revisedTime: fmt(shuttleRolls) },
    { label: game.overnightLabel ?? 'Airport hotel', baseTime: fmt(overnightArr), revisedTime: fmt(overnightArr) },
  ];

  // Add rest duration node if lobby call time is set
  if (game.lobbyCallTime) {
    const [lh, lm] = game.lobbyCallTime.split(':').map(Number);
    const lobbyMin = lh! * 60 + (lm ?? 0);
    let restMins = lobbyMin - (overnightArr % 1440);
    if (restMins < 0) restMins += 1440;
    const rh = Math.floor(restMins / 60);
    const rm = restMins % 60;
    const durStr = rm > 0 ? `${rh}h${rm.toString().padStart(2, '0')}m` : `${rh}h`;
    chain.push({
      label: `Rest before ${game.lobbyCallTime} lobby`,
      baseTime: durStr,
      revisedTime: durStr,
      isDuration: true,
    });
  }

  return chain;
}

async function loadScenario(): Promise<FixtureScenario> {
  const { scenario } = await import(
    join(ROOT, 'fixtures', 'alcs-gm4', 'scenario.ts')
  );
  return scenario as FixtureScenario;
}
