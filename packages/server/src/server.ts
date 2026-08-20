import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { Orchestrator } from '@apron/orchestrator';
import { SpotterAgent } from '@apron/agent-spotter';
import { TrafficAgent } from '@apron/agent-traffic';
import type { TrafficWatchConfig, MonitoredFlight } from '@apron/agent-traffic';
import { AviationStackClient } from '@apron/integration-aviationstack';
import { AdvanceAgent } from '@apron/agent-advance';
import { WranglerAgent } from '@apron/agent-wrangler';
import type { WranglerWatchConfig } from '@apron/agent-wrangler';
import { StewardAgent } from '@apron/agent-steward';
import { FixerAgent } from '@apron/agent-fixer';
import { RunnerAgent } from '@apron/agent-runner';
import { CustomsAgent } from '@apron/agent-customs';
import { AuditLog } from './audit.js';
import { GrafanaReporter } from '@apron/integration-grafana';
import { ClickhouseAuditStore } from '@apron/integration-clickhouse';
import { GeminiClient } from '@apron/integration-google-cloud';
import { TwilioClient } from '@apron/integration-twilio';
import type { AgentEvent, FixtureScenario, ChainNode } from '@apron/types';
import type { SpotterWatchConfig } from '@apron/agent-spotter';
import type { StewardWatchConfig } from '@apron/agent-steward';
import { GAME_TYPE_DEFAULTS, type GameType } from './admin-store.js';
import { initAdminStore, buildOperationalContext, loadDefaultAgreement, setCrewChangeCallback } from './admin-api.js';
import { extractRules, buildAgreementMeta } from '@apron/agent-steward/agreement';
import { localTimeToUtcMs, inferTimezone, ianaToAbbrev } from './tz-utils.js';

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
  let scenario = await loadScenario();
  const orchestrator = new Orchestrator('alcs-gm4', ['CUSTOMS']);

  const demoSpotter = new SpotterAgent();
  orchestrator.registerAgent(demoSpotter);

  /** Live SPOTTER instances — one per watched game, keyed by gameId. */
  const spotters = new Map<string, SpotterAgent>();
  /** Live STEWARD instances — one per watched game, keyed by gameId. */
  const stewards = new Map<string, StewardAgent>();
  /** Live TRAFFIC instances — one per watched game, keyed by gameId. */
  const traffics = new Map<string, TrafficAgent>();
  /** Live ADVANCE instances — one per watched game, keyed by gameId. */
  const advances = new Map<string, AdvanceAgent>();
  /** Live WRANGLER instances — one per watched game, keyed by gameId. */
  const wranglers = new Map<string, WranglerAgent>();
  /** AviationStack client — reads API key from env, never exposes it. */
  const aviationStack = new AviationStackClient();
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
  const twilioClient = new TwilioClient();

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
  const adminStore = initAdminStore(firestore, gemini);

  // ---- Reusable TRAFFIC (re)start — called from startWatch() and crew-change callback ----
  async function startOrRestartTraffic(accountId: string, gameId: string): Promise<void> {
    try {
      const crewAssignments = await adminStore.listCrewAssignments(accountId, gameId);
      const monitoredFlights: MonitoredFlight[] = [];
      const seenFlights = new Set<string>();

      for (const ca of crewAssignments) {
        if (!ca.routing?.legs) continue;
        for (const leg of ca.routing.legs) {
          const iata = `${leg.carrier}${leg.flightNumber}`;
          if (seenFlights.has(iata)) continue;
          seenFlights.add(iata);
          monitoredFlights.push({
            flightIata: iata,
            carrier: leg.carrier,
            flightNumber: leg.flightNumber,
            date: leg.departure.date,
            depAirport: leg.departure.airport,
            arrAirport: leg.arrival.airport,
            scheduledDep: leg.departure.time,
            scheduledArr: leg.arrival.time,
          });
        }
      }

      if (monitoredFlights.length === 0) {
        console.log(`[traffic] No crew flights found for game ${gameId} — skipping`);
        return;
      }

      const prevTraffic = traffics.get(gameId);
      if (prevTraffic) prevTraffic.stopWatching();

      const liveTraffic = new TrafficAgent();
      const tNow = new Date();
      const trafficCred: import('@apron/types').Credential = {
        agent: 'TRAFFIC',
        showId: gameId,
        grant: { agent: 'TRAFFIC', capabilities: ['read:carrier-status', 'read:ground-ops'], role: 'reader', neverReceives: ['crew-identity', 'next-calls', 'fare-data'] },
        issuedAt: tNow.toISOString(),
        expiresAt: new Date(tNow.getTime() + 86400000).toISOString(),
      };
      const bus = orchestrator.getRuntime().getBus();
      liveTraffic.bind({ bus, credential: trafficCred, showId: gameId });

      const trafficConfig: TrafficWatchConfig = {
        showId: gameId,
        flights: monitoredFlights,
        aviationStack: aviationStack.isEnabled() ? aviationStack : undefined,
      };
      liveTraffic.startWatching(trafficConfig);
      traffics.set(gameId, liveTraffic);

      const startedAt = new Date().toISOString();
      void adminStore.setAgentAssignment(accountId, gameId, 'TRAFFIC', {
        status: 'active', startedAt,
      });
      void adminStore.setAgentRecord(accountId, gameId, 'TRAFFIC', {
        status: 'active',
        startedAt,
        flightCount: monitoredFlights.length,
        apiEnabled: aviationStack.isEnabled(),
      });

      console.log(`[traffic] Monitoring ${monitoredFlights.length} flights for game ${gameId}`);
    } catch (err) {
      console.error('[traffic] Failed to start flight monitoring:', err);
    }
  }

  // ---- Reusable ADVANCE (re)start — called from startWatch() and crew-change callback ----
  async function startOrRestartAdvance(accountId: string, gameId: string): Promise<void> {
    try {
      const prevAdvance = advances.get(gameId);
      if (prevAdvance) prevAdvance.stopWatching();

      const liveAdvance = new AdvanceAgent();
      const tNow = new Date();
      const advanceCred: import('@apron/types').Credential = {
        agent: 'ADVANCE',
        showId: gameId,
        grant: { agent: 'ADVANCE', capabilities: ['read:crew-sheets', 'read:call-sheets', 'read:roster', 'write:roster-state'], role: 'state', neverReceives: ['payment-instruments', 'fare-detail', 'hr-records'] },
        issuedAt: tNow.toISOString(),
        expiresAt: new Date(tNow.getTime() + 86400000).toISOString(),
      };
      const bus = orchestrator.getRuntime().getBus();
      liveAdvance.bind({ bus, credential: advanceCred, showId: gameId });

      liveAdvance.startWatching({
        gameId,
        accountId,
        getCrewAssignments: () => adminStore.listCrewAssignments(accountId, gameId),
      });
      advances.set(gameId, liveAdvance);

      const startedAt = new Date().toISOString();
      void adminStore.setAgentAssignment(accountId, gameId, 'ADVANCE', {
        status: 'active', startedAt,
      });

      console.log(`[advance] Roster monitoring started for game ${gameId}`);
    } catch (err) {
      console.error('[advance] Failed to start roster monitoring:', err);
    }
  }

  // ---- Reusable WRANGLER (re)start — called from startWatch() and crew-change callback ----
  async function startOrRestartWrangler(accountId: string, gameId: string): Promise<void> {
    try {
      const prevWrangler = wranglers.get(gameId);
      if (prevWrangler) prevWrangler.stopWatching();

      const liveWrangler = new WranglerAgent();
      const tNow = new Date();
      const wranglerCred: import('@apron/types').Credential = {
        agent: 'WRANGLER',
        showId: gameId,
        grant: { agent: 'WRANGLER', capabilities: ['read:constraints', 'write:constraints'], role: 'state', neverReceives: ['undisclosed-next-call', 'third-party-call-sheets'] },
        issuedAt: tNow.toISOString(),
        expiresAt: new Date(tNow.getTime() + 86400000).toISOString(),
      };
      const bus = orchestrator.getRuntime().getBus();
      liveWrangler.bind({ bus, credential: wranglerCred, showId: gameId });

      const wranglerConfig: WranglerWatchConfig = {
        gameId,
        accountId,
        gemini,
        twilio: twilioClient.isEnabled() ? twilioClient : undefined,
        getCrewAssignments: () => adminStore.listCrewAssignments(accountId, gameId),
        channel: twilioClient.isEnabled() ? 'sms' : 'simulated',
      };
      liveWrangler.startWatching(wranglerConfig);
      wranglers.set(gameId, liveWrangler);

      const startedAt = new Date().toISOString();
      void adminStore.setAgentAssignment(accountId, gameId, 'WRANGLER', {
        status: 'active', startedAt,
      });

      console.log(`[wrangler] Constraint monitoring started for game ${gameId}`);
    } catch (err) {
      console.error('[wrangler] Failed to start constraint monitoring:', err);
    }
  }

  // Notify STEWARD + TRAFFIC + ADVANCE + WRANGLER when crew data changes
  setCrewChangeCallback((accountId, gameId) => {
    const activeSteward = stewards.get(gameId);
    if (activeSteward) {
      console.log(`[steward] Crew data changed for game ${gameId} — triggering re-evaluation`);
      void activeSteward.onCrewRebooked();
    }

    // (Re)start TRAFFIC if this game is being watched — picks up new/changed flights
    if (spotters.has(gameId)) {
      console.log(`[traffic] Crew data changed for game ${gameId} — refreshing flight monitor`);
      void startOrRestartTraffic(accountId, gameId);
    }

    // Notify ADVANCE — triggers roster re-scan with updated disclosure model
    const activeAdvance = advances.get(gameId);
    if (activeAdvance) {
      console.log(`[advance] Crew data changed for game ${gameId} — re-scanning roster`);
      activeAdvance.onCrewChanged();
    }

    // Notify WRANGLER — triggers constraint re-scan
    const activeWrangler = wranglers.get(gameId);
    if (activeWrangler) {
      console.log(`[wrangler] Crew data changed for game ${gameId} — re-scanning constraints`);
      activeWrangler.onCrewChanged();
    }
  });

  if (gemini.isEnabled()) {
    console.log(`[google-cloud] Gemini client connected (${gemini.getMode()})`);
  } else {
    console.log('[google-cloud] Fixture mode — Gemini responses are stubbed');
  }

  if (aviationStack.isEnabled()) {
    console.log('[aviationstack] Flight status API connected');
  } else {
    console.log('[aviationstack] No API key — TRAFFIC will use schedule data only');
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

  // ---------------------------------------------------------------------------
  // startWatch() — shared logic used by both the HTTP endpoint and the
  // auto-scheduler.  Returns { ok: true } on success, or { ok: false, error }.
  // ---------------------------------------------------------------------------
  type WatchableGame = import('./admin-store.js').Game;

  function startWatch(
    game: WatchableGame,
    accountId: string,
  ): { ok: true } | { ok: false; error: string } {
    if (!game.espnEventId) {
      return { ok: false, error: 'Game has no espnEventId — set it in the admin console first' };
    }
    if (!game.gameType || !['baseball', 'football', 'basketball', 'hockey', 'soccer'].includes(game.gameType)) {
      return { ok: false, error: `gameType must be baseball, football, basketball, hockey, or soccer (got: ${game.gameType})` };
    }

    const defaults = GAME_TYPE_DEFAULTS[game.gameType as GameType];
    const gameChain = buildGameChain(game, defaults);

    const config: SpotterWatchConfig = {
      showId: game.id,
      sport: game.gameType as 'baseball' | 'football' | 'basketball' | 'hockey' | 'soccer',
      espnEventId: game.espnEventId,
      scheduledStart: new Date(
        localTimeToUtcMs(game.date, game.startTime ?? '19:00', resolveGameTimezone(game)),
      ).toISOString(),
      expectedDurationMinutes: game.expectedDuration ?? defaults.duration,
      strikeDurationMinutes: game.strikeDuration ?? defaults.strike,
      chain: gameChain,
      crewCount: game.crewCount ?? 22,
      gemini: gemini.isEnabled() ? gemini : undefined,
      timezone: resolveGameTimezone(game),
    };

    // Stop existing watcher for this game if already running
    const prev = spotters.get(game.id);
    if (prev) prev.stopWatching();

    const liveSpotter = new SpotterAgent();
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

    // Persist active state
    const watchStartedAt = new Date().toISOString();
    void adminStore.setAgentAssignment(accountId, game.id, 'SPOTTER', {
      status: 'active', startedAt: watchStartedAt,
    });
    void adminStore.setAgentRecord(accountId, game.id, 'SPOTTER', {
      status: 'active',
      startedAt: watchStartedAt,
      sport: config.sport,
      espnEventId: config.espnEventId,
    });

    // ---- Start STEWARD compliance monitoring alongside SPOTTER ----
    const prevSteward = stewards.get(game.id);
    if (prevSteward) prevSteward.stopWatching();

    // Fire async — ensure agreement rules exist (auto-provision if needed), then start watching
    const stewardGameId = game.id;
    const stewardAcctId = accountId;
    void (async () => {
      try {
        let stewardRecord = await adminStore.getAgentRecord(stewardAcctId, stewardGameId, 'STEWARD');
        let hasRules = stewardRecord?.['rules'] != null;

        // Auto-provision: load default agreement + extract rules if missing
        if (!hasRules && gemini.isEnabled()) {
          const hasAgreement = stewardRecord?.['agreementText'] != null;

          // Step 1: Load default agreement if none loaded
          if (!hasAgreement) {
            console.log(`[steward] No agreement for game ${stewardGameId} — loading default`);
            try {
              const defaultAgmt = loadDefaultAgreement();
              const meta = buildAgreementMeta(defaultAgmt.name, defaultAgmt.text, defaultAgmt.source);
              await adminStore.setAgentRecord(stewardAcctId, stewardGameId, 'STEWARD', {
                agreement: meta,
                agreementText: defaultAgmt.text,
              });
              console.log(`[steward] Default agreement loaded for game ${stewardGameId} (${meta.textLength} chars)`);
            } catch (err) {
              console.error('[steward] Failed to load default agreement:', err);
            }
          }

          // Step 2: Extract rules from the agreement text
          stewardRecord = await adminStore.getAgentRecord(stewardAcctId, stewardGameId, 'STEWARD');
          const agreementText = stewardRecord?.['agreementText'] as string | undefined;
          if (agreementText) {
            console.log(`[steward] Extracting rules for game ${stewardGameId}...`);
            try {
              const rules = await extractRules(gemini, agreementText);
              if (rules) {
                await adminStore.setAgentRecord(stewardAcctId, stewardGameId, 'STEWARD', { rules });
                stewardRecord = await adminStore.getAgentRecord(stewardAcctId, stewardGameId, 'STEWARD');
                hasRules = true;
                console.log(`[steward] Rules extracted for game ${stewardGameId}`);
              } else {
                console.warn(`[steward] Rule extraction returned no result for game ${stewardGameId}`);
              }
            } catch (err) {
              console.error('[steward] Rule extraction failed:', err);
            }
          }
        }

        if (!hasRules) {
          console.log(`[steward] No rules available for game ${stewardGameId} — skipping compliance monitoring`);
          return;
        }

        const liveSteward = new StewardAgent();
        const stewardCred: import('@apron/types').Credential = {
          agent: 'STEWARD',
          showId: stewardGameId,
          grant: { agent: 'STEWARD', capabilities: ['read:rule-packs', 'read:roster'], role: 'reader', neverReceives: [] },
          issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 86400000).toISOString(),
        };
        liveSteward.bind({ bus, credential: stewardCred, showId: stewardGameId });

        const stewardConfig: StewardWatchConfig = {
          gameId: stewardGameId,
          accountId: stewardAcctId,
          gemini,
          getOperationalContext: async () => {
            const ctx = await buildOperationalContext(stewardAcctId, stewardGameId, stewardRecord);
            // Inject SPOTTER's current predicted end time for variance calculation
            const spotter = spotters.get(stewardGameId);
            if (spotter) {
              const spotterStatus = spotter.getStatus();
              if (spotterStatus.prediction?.predictedEnd) {
                ctx['currentPredictedEnd'] = spotterStatus.prediction.predictedEnd;
              }
              if (spotterStatus.prediction?.showState) {
                ctx['currentShowState'] = spotterStatus.prediction.showState;
              }
            }
            return ctx;
          },
        };
        liveSteward.startWatching(stewardConfig);
        stewards.set(stewardGameId, liveSteward);

        void adminStore.setAgentAssignment(stewardAcctId, stewardGameId, 'STEWARD', {
          status: 'active', startedAt: watchStartedAt,
        });
      } catch (err) {
        console.error('[steward] Failed to start compliance monitoring:', err);
      }
    })();

    // ---- Start TRAFFIC flight monitoring alongside SPOTTER ----
    void startOrRestartTraffic(accountId, game.id);

    // ---- Start ADVANCE roster monitoring alongside SPOTTER ----
    void startOrRestartAdvance(accountId, game.id);

    // ---- Start WRANGLER constraint monitoring alongside SPOTTER ----
    void startOrRestartWrangler(accountId, game.id);

    // Broadcast SPOTTER events to WebSocket clients + auto-cleanup on game end
    const watchedGameId = game.id;
    const watchedAcctId = accountId;
    bus.subscribe((event: AgentEvent) => {
      // Forward SPOTTER events to WebSocket clients
      if (event.agent === 'SPOTTER') {
        const msg = JSON.stringify({ type: 'agent-event', event });
        for (const ws of clients) {
          if (ws.readyState === ws.OPEN) ws.send(msg);
        }

        // Trigger STEWARD evaluation when SPOTTER's predicted end time changes
        if (event.type === 'chain-update' && event.showId === watchedGameId) {
          const activeSteward = stewards.get(watchedGameId);
          const currentSpotter = spotters.get(watchedGameId);
          if (activeSteward && currentSpotter) {
            const pred = currentSpotter.getStatus().prediction;
            if (pred?.predictedEnd) {
              activeSteward.onPredictionChanged(pred.predictedEnd);
            }
          }
        }

        if (event.type === 'agent-status' && event.agentStates.SPOTTER === 'done' && event.showId === watchedGameId) {
          const finished = spotters.get(watchedGameId);
          const snap = finished?.getStatus();
          const fullLog = finished?.getLog() ?? [];
          spotters.delete(watchedGameId);
          console.log(`[spotter] Game ended — removed watch for ${watchedGameId} (${spotters.size} remaining)`);

          // Stop STEWARD when SPOTTER finishes
          const finishedSteward = stewards.get(watchedGameId);
          if (finishedSteward) {
            finishedSteward.stopWatching();
            stewards.delete(watchedGameId);
            void adminStore.setAgentAssignment(watchedAcctId, watchedGameId, 'STEWARD', {
              status: 'done',
              startedAt: watchStartedAt,
              stoppedAt: new Date().toISOString(),
            });
            const lastSnap = finishedSteward.getLastSnapshot();
            if (lastSnap) {
              void adminStore.setAgentRecord(watchedAcctId, watchedGameId, 'STEWARD', {
                lastSnapshot: lastSnap,
              });
            }
          }

          // Stop TRAFFIC when SPOTTER finishes
          const finishedTraffic = traffics.get(watchedGameId);
          if (finishedTraffic) {
            const trafficSnap = finishedTraffic.getStatus();
            const trafficLog = finishedTraffic.getLog();
            finishedTraffic.stopWatching();
            traffics.delete(watchedGameId);
            const trafficStoppedAt = new Date().toISOString();
            void adminStore.setAgentAssignment(watchedAcctId, watchedGameId, 'TRAFFIC', {
              status: 'done',
              startedAt: trafficSnap.startedAt ?? watchStartedAt,
              stoppedAt: trafficStoppedAt,
            });
            void adminStore.setAgentRecord(watchedAcctId, watchedGameId, 'TRAFFIC', {
              status: 'done',
              stoppedAt: trafficStoppedAt,
              flightSummary: trafficSnap.flightSummary,
              flights: trafficSnap.flights,
              log: trafficLog,
            });
          }

          // Stop ADVANCE when SPOTTER finishes
          const finishedAdvance = advances.get(watchedGameId);
          if (finishedAdvance) {
            const advanceLog = JSON.parse(JSON.stringify(finishedAdvance.getLog()));
            const advanceSnapshot = JSON.parse(JSON.stringify(finishedAdvance.getLastSnapshot() ?? null));
            finishedAdvance.stopWatching();
            advances.delete(watchedGameId);
            const advanceStoppedAt = new Date().toISOString();
            void adminStore.setAgentAssignment(watchedAcctId, watchedGameId, 'ADVANCE', {
              status: 'done',
              startedAt: watchStartedAt,
              stoppedAt: advanceStoppedAt,
            });
            void adminStore.setAgentRecord(watchedAcctId, watchedGameId, 'ADVANCE', {
              status: 'done',
              stoppedAt: advanceStoppedAt,
              lastSnapshot: advanceSnapshot,
              log: advanceLog,
            });
          }

          // Stop WRANGLER when SPOTTER finishes
          const finishedWrangler = wranglers.get(watchedGameId);
          if (finishedWrangler) {
            const wranglerLog = JSON.parse(JSON.stringify(finishedWrangler.getLog()));
            const wranglerSnapshot = JSON.parse(JSON.stringify(finishedWrangler.getLastSnapshot() ?? null));
            finishedWrangler.stopWatching();
            wranglers.delete(watchedGameId);
            const wranglerStoppedAt = new Date().toISOString();
            void adminStore.setAgentAssignment(watchedAcctId, watchedGameId, 'WRANGLER', {
              status: 'done',
              startedAt: watchStartedAt,
              stoppedAt: wranglerStoppedAt,
            });
            void adminStore.setAgentRecord(watchedAcctId, watchedGameId, 'WRANGLER', {
              status: 'done',
              stoppedAt: wranglerStoppedAt,
              lastSnapshot: wranglerSnapshot,
              log: wranglerLog,
            });
          }

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

      // Forward STEWARD events to WebSocket clients
      if (event.agent === 'STEWARD' && event.showId === watchedGameId) {
        const msg = JSON.stringify({ type: 'agent-event', event });
        for (const ws of clients) {
          if (ws.readyState === ws.OPEN) ws.send(msg);
        }
      }

      // Forward TRAFFIC events to WebSocket clients
      if (event.agent === 'TRAFFIC' && event.showId === watchedGameId) {
        const msg = JSON.stringify({ type: 'agent-event', event });
        for (const ws of clients) {
          if (ws.readyState === ws.OPEN) ws.send(msg);
        }
      }

      // Forward ADVANCE events to WebSocket clients
      if (event.agent === 'ADVANCE' && event.showId === watchedGameId) {
        const msg = JSON.stringify({ type: 'agent-event', event });
        for (const ws of clients) {
          if (ws.readyState === ws.OPEN) ws.send(msg);
        }
      }

      // Forward WRANGLER events to WebSocket clients
      if (event.agent === 'WRANGLER' && event.showId === watchedGameId) {
        const msg = JSON.stringify({ type: 'agent-event', event });
        for (const ws of clients) {
          if (ws.readyState === ws.OPEN) ws.send(msg);
        }
      }
    });

    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Game auto-scheduler — scans Firestore every 60s for games that should be
  // watched.  A game qualifies when:
  //   1. It has an espnEventId and a valid gameType
  //   2. Its date is today (server local time)
  //   3. Its startTime is ≤ 15 minutes from now, OR already in the past
  //   4. It isn't already being watched (in the `spotters` Map)
  //   5. It hasn't already finished (SPOTTER status !== 'done')
  //
  // This survives Cloud Run instance recycling — on startup the scan picks up
  // any games that should already be live.  No timers to lose.
  //
  // Timezone: game HH:MM fields are wall-clock times in the game's timezone.
  // resolveGameTimezone() reads game.timezone or infers from venue.
  // localTimeToUtcMs() (from tz-utils) converts to UTC using Intl.
  // ---------------------------------------------------------------------------
  const SCHEDULER_INTERVAL_MS = 60_000;
  const SCHEDULER_LEAD_MINUTES = 15;
  /** Don't auto-start games more than 6 hours past their start — they're over. */
  const SCHEDULER_MAX_PAST_MINUTES = 360;

  /**
   * Resolve the IANA timezone for a game — uses the stored timezone field,
   * falls back to venue inference, defaults to America/New_York.
   */
  function resolveGameTimezone(game: WatchableGame): string {
    if (game.timezone) return game.timezone;
    return inferTimezone(game.venue) ?? 'America/New_York';
  }

  async function scanAndStartGames(): Promise<void> {
    try {
      const accounts = await adminStore.listAccounts();
      const nowMs = Date.now();

      for (const acct of accounts) {
        const games = await adminStore.listGames(acct.id);
        for (const game of games) {
          // Skip: no ESPN ID, wrong game type, already watching, already done
          if (!game.espnEventId) continue;
          if (!game.gameType || !['baseball', 'football', 'basketball', 'hockey', 'soccer'].includes(game.gameType)) continue;
          if (spotters.has(game.id)) continue;
          if (game.agents?.SPOTTER?.status === 'done') continue;

          // Compute minutes until game start (timezone-safe)
          const startTimeStr = game.startTime ?? '19:00';
          const gameStartMs = localTimeToUtcMs(game.date, startTimeStr, resolveGameTimezone(game));
          const minsUntilStart = (gameStartMs - nowMs) / 60_000;

          // Start if within lead window and not too far in the past
          if (minsUntilStart <= SCHEDULER_LEAD_MINUTES && minsUntilStart > -SCHEDULER_MAX_PAST_MINUTES) {
            console.log(`[scheduler] Auto-starting SPOTTER for "${game.title}" (${game.id}) — ${minsUntilStart <= 0 ? 'game already started' : `starts in ${Math.round(minsUntilStart)}m`}`);
            const result = startWatch(game, acct.id);
            if (!result.ok) {
              console.log(`[scheduler] Skipped "${game.title}": ${result.error}`);
            }
          }
        }
      }
    } catch (err) {
      console.error('[scheduler] Error scanning games:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Build a live board scenario from today's Firestore games, replacing the
  // fixture scenario so the board grid shows real productions.
  // ---------------------------------------------------------------------------
  async function buildLiveScenario(): Promise<void> {
    try {
      const accounts = await adminStore.listAccounts();
      if (!accounts.length) return;

      const today = new Date().toISOString().slice(0, 10);
      const allShows: import('@apron/types').Show[] = [];
      const allCrew: import('@apron/types').CrewMember[] = [];
      let firstChain: import('@apron/types').ChainNode[] | null = null;

      for (const acct of accounts) {
        const games = await adminStore.listGames(acct.id);
        const todayGames = games.filter(g => g.date === today);
        if (!todayGames.length) continue;

        const crew = await adminStore.listCrew(acct.id);
        const crewMap = new Map(crew.map(c => [c.id, c]));

        for (const game of todayGames) {
          // Determine game state label
          const spotter = spotters.get(game.id);
          const snap = spotter?.getStatus();
          let gameState = 'Pre-game';
          let live = false;
          if (snap?.prediction) {
            gameState = snap.prediction.showState ?? 'In progress';
            live = true;
          } else if (game.agents?.SPOTTER?.status === 'done') {
            gameState = 'Final';
            live = false;
          }

          // Count assigned crew
          let crewCount = 0;
          try {
            const assignments = await adminStore.listAssignments(acct.id, game.id);
            crewCount = assignments.length;

            // Build crew roster for the first/hero game
            if (allShows.length === 0) {
              const crewAssignments = await adminStore.listCrewAssignments(acct.id, game.id);
              for (const ca of crewAssignments) {
                const member = crewMap.get(ca.crewId);
                allCrew.push({
                  id: ca.crewId,
                  position: ca.position ?? 'UTIL',
                  keyPosition: ['TD', 'A1', 'DIR', 'LEAD EVS', 'EIC'].includes(ca.position ?? ''),
                  name: member?.name ?? ca.crewId,
                  externalCall: ca.nextCall?.type === 'external',
                  disclosed: ca.nextCall?.disclosed ?? false,
                  provenance: ca.nextCall?.provenance
                    ? [ca.nextCall.provenance.level as import('@apron/types').ProvenanceLevel, '▪', `${ca.nextCall.provenance.level} source`]
                    : ['none' as import('@apron/types').ProvenanceLevel, '—', 'No provenance data'],
                  homeMarket: member?.homeMarket ?? ca.department ?? '',
                  tier: (member?.tier ?? 'A-list') as import('@apron/types').CrewTier,
                  nextCall: ca.nextCall
                    ? `${ca.nextCall.production?.name ?? ca.nextCall.type}<br><span class="sub2">${ca.nextCall.callTime?.display ?? ''}</span>`
                    : 'No next call',
                  routing: ca.routing
                    ? `${ca.routing.carrierDisplay ?? ''} · ${ca.routing.routeSummary ?? ''}`
                    : '—',
                  arrival: ca.routing?.arrivalTime ? `arr ${ca.routing.arrivalTime}` : '—',
                  slackMinutes: ca.routing?.slackMinutes ?? 0,
                });
              }
            }
          } catch { /* no assignments yet */ }

          const defaults = GAME_TYPE_DEFAULTS[game.gameType as GameType] ?? GAME_TYPE_DEFAULTS.baseball;
          if (!firstChain) {
            firstChain = buildGameChain(game, defaults);
          }

          allShows.push({
            id: game.id,
            net: game.network ?? '',
            title: game.title,
            venue: game.venue ?? '',
            gameState,
            live,
            crewCount: crewCount || 22,
            state: 'clear',
            alert: null,
            hero: allShows.length === 0,
          });
        }
      }

      if (allShows.length === 0) return;

      const dayName = new Intl.DateTimeFormat('en-US', { weekday: 'long', day: 'numeric', month: 'long' })
        .format(new Date());

      scenario = {
        id: `live-${today}`,
        title: `${dayName} · Live`,
        description: `Live board for ${dayName}`,
        shows: allShows,
        crew: allCrew,
        chain: firstChain ?? [{ label: 'Final out', baseTime: '22:00', revisedTime: '22:00' }],
        offlineAgents: {},
        crewNote: '',
        handoffText: '',
        optionGroups: [],
        steps: [],
      };

      orchestrator.loadScenario(scenario);

      // Push to all connected WebSocket clients
      const initMsg = JSON.stringify({ type: 'reset', scenario });
      for (const ws of clients) {
        if (ws.readyState === ws.OPEN) ws.send(initMsg);
      }

      console.log(`[live-board] Built scenario from ${allShows.length} games for ${today}`);
    } catch (err) {
      console.error('[live-board] Error building live scenario:', err);
    }
  }

  // Start the scheduler unless in demo mode (no Firestore to scan)
  if (!opts.demoMode) {
    // Run once at startup (delayed 5s to let Firestore settle)
    setTimeout(() => {
      void scanAndStartGames().then(() => buildLiveScenario());
    }, 5_000);
    // Then every 60s
    const schedulerTimer = setInterval(() => {
      void scanAndStartGames().then(() => buildLiveScenario());
    }, SCHEDULER_INTERVAL_MS);
    // Don't keep the process alive just for the scheduler
    schedulerTimer.unref();
    console.log(`[scheduler] Game auto-start enabled — scanning every ${SCHEDULER_INTERVAL_MS / 1000}s with ${SCHEDULER_LEAD_MINUTES}m lead`);
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
      const watches: Array<{ gameId: string; timezone: string; status: ReturnType<SpotterAgent['getStatus']> }> = [];
      for (const [gid, s] of spotters) {
        const tz = s.getWatchConfig()?.timezone ?? 'America/New_York';
        watches.push({ gameId: gid, timezone: tz, status: s.getStatus() });
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

    // ---- TRAFFIC flight monitoring API ----
    if (path === '/api/traffic/status') {
      // Active flight monitors from in-memory Map
      const watches: Array<{ gameId: string; status: ReturnType<TrafficAgent['getStatus']> }> = [];
      for (const [gid, t] of traffics) {
        watches.push({ gameId: gid, status: t.getStatus() });
      }

      // Completed TRAFFIC records from Firestore
      const completed: Array<{
        gameId: string;
        accountId: string;
        title: string;
        agent: import('./admin-store.js').AgentAssignment;
        record?: Record<string, unknown>;
      }> = [];
      try {
        const doneGames = await adminStore.listGamesByAgentStatus('TRAFFIC', ['done', 'idle']);
        for (const g of doneGames) {
          if (!traffics.has(g.id) && g.agents?.TRAFFIC) {
            const record = await adminStore.getAgentRecord(g.accountId, g.id, 'TRAFFIC');
            const summary = record ? { ...record } : undefined;
            if (summary) delete summary['log'];
            completed.push({
              gameId: g.id,
              accountId: g.accountId,
              title: g.title,
              agent: g.agents.TRAFFIC,
              record: summary,
            });
          }
        }
      } catch { /* Firestore unavailable */ }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ watches, completed }));
      return;
    }

    if (path === '/api/traffic/log') {
      const params = new URL(req.url ?? '/', `http://${req.headers.host}`).searchParams;
      const count = parseInt(params.get('n') ?? '200', 10);
      const gameId = params.get('gameId');
      if (gameId && traffics.has(gameId)) {
        const t = traffics.get(gameId)!;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ entries: t.getLog(count), total: t.getStatus().logTotal }));
      } else {
        const all: Array<ReturnType<TrafficAgent['getLog']>[number] & { gameId: string }> = [];
        for (const [gid, t] of traffics) {
          for (const entry of t.getLog(count)) {
            all.push({ ...entry, gameId: gid });
          }
        }
        all.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        const total = Array.from(traffics.values()).reduce((sum, t) => sum + t.getStatus().logTotal, 0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ entries: all.slice(-count), total }));
      }
      return;
    }

    if (path === '/api/traffic/record') {
      const params = new URL(req.url ?? '/', `http://${req.headers.host}`).searchParams;
      const accountId = params.get('accountId');
      const gameId = params.get('gameId');
      if (!accountId || !gameId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'accountId and gameId required' }));
        return;
      }
      try {
        const record = await adminStore.getAgentRecord(accountId, gameId, 'TRAFFIC');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ record }));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to fetch agent record' }));
      }
      return;
    }

    // ---- STEWARD compliance dashboard API ----
    if (path === '/api/steward/status') {
      // Active compliance monitors from in-memory Map (enrich with game title + tz)
      const activeMonitors: Array<{ gameId: string; title: string; timezone: string; snapshot: ReturnType<StewardAgent['getLastSnapshot']> }> = [];
      // Build a gameId→title/tz lookup from all active STEWARD games
      const gameInfo = new Map<string, { title: string; timezone: string }>();
      try {
        const activeGames = await adminStore.listGamesByAgentStatus('STEWARD', ['active']);
        for (const g of activeGames) gameInfo.set(g.id, { title: g.title, timezone: resolveGameTimezone(g) });
      } catch { /* ok */ }
      for (const [gid, s] of stewards) {
        const info = gameInfo.get(gid);
        activeMonitors.push({ gameId: gid, title: info?.title ?? gid, timezone: info?.timezone ?? 'America/New_York', snapshot: s.getLastSnapshot() });
      }

      // Completed STEWARD agents from Firestore
      const completed: Array<{
        gameId: string;
        accountId: string;
        title: string;
        agent: import('./admin-store.js').AgentAssignment;
        lastSnapshot?: Record<string, unknown>;
      }> = [];
      try {
        const doneGames = await adminStore.listGamesByAgentStatus('STEWARD', ['done', 'idle']);
        for (const g of doneGames) {
          if (!stewards.has(g.id) && g.agents?.STEWARD) {
            const record = await adminStore.getAgentRecord(g.accountId, g.id, 'STEWARD');
            completed.push({
              gameId: g.id,
              accountId: g.accountId,
              title: g.title,
              agent: g.agents.STEWARD,
              lastSnapshot: record?.['lastSnapshot'] as Record<string, unknown> | undefined,
            });
          }
        }
      } catch { /* Firestore unavailable */ }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ active: activeMonitors, completed }));
      return;
    }

    // ---- ADVANCE roster monitoring API ----
    if (path === '/api/advance/status') {
      // Active roster monitors from in-memory Map
      const activeMonitors: Array<{ gameId: string; title: string; timezone: string; snapshot: ReturnType<AdvanceAgent['getLastSnapshot']> }> = [];
      const advGameInfo = new Map<string, { title: string; timezone: string }>();
      try {
        const activeGames = await adminStore.listGamesByAgentStatus('ADVANCE', ['active']);
        for (const g of activeGames) advGameInfo.set(g.id, { title: g.title, timezone: resolveGameTimezone(g) });
      } catch { /* ok */ }
      for (const [gid, a] of advances) {
        const info = advGameInfo.get(gid);
        activeMonitors.push({ gameId: gid, title: info?.title ?? gid, timezone: info?.timezone ?? 'America/New_York', snapshot: a.getLastSnapshot() });
      }

      // Completed ADVANCE agents from Firestore
      const completed: Array<{
        gameId: string;
        accountId: string;
        title: string;
        agent: import('./admin-store.js').AgentAssignment;
        lastSnapshot?: Record<string, unknown>;
      }> = [];
      try {
        const doneGames = await adminStore.listGamesByAgentStatus('ADVANCE', ['done', 'idle']);
        for (const g of doneGames) {
          if (!advances.has(g.id) && g.agents?.ADVANCE) {
            const record = await adminStore.getAgentRecord(g.accountId, g.id, 'ADVANCE');
            completed.push({
              gameId: g.id,
              accountId: g.accountId,
              title: g.title,
              agent: g.agents.ADVANCE,
              lastSnapshot: record?.['lastSnapshot'] as Record<string, unknown> | undefined,
            });
          }
        }
      } catch { /* Firestore unavailable */ }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ active: activeMonitors, completed }));
      return;
    }

    if (path === '/api/advance/log') {
      const params = new URL(req.url ?? '/', `http://${req.headers.host}`).searchParams;
      const count = parseInt(params.get('n') ?? '200', 10);
      const gameId = params.get('gameId');
      if (gameId && advances.has(gameId)) {
        const a = advances.get(gameId)!;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ entries: a.getLog(count), total: a.getStatus().logTotal }));
      } else {
        const all: Array<ReturnType<AdvanceAgent['getLog']>[number] & { gameId: string }> = [];
        for (const [gid, a] of advances) {
          for (const entry of a.getLog(count)) {
            all.push({ ...entry, gameId: gid });
          }
        }
        all.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        const total = Array.from(advances.values()).reduce((sum, a) => sum + a.getStatus().logTotal, 0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ entries: all.slice(-count), total }));
      }
      return;
    }

    if (path === '/api/advance/record') {
      const params = new URL(req.url ?? '/', `http://${req.headers.host}`).searchParams;
      const accountId = params.get('accountId');
      const gameId = params.get('gameId');
      if (!accountId || !gameId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'accountId and gameId required' }));
        return;
      }
      try {
        const record = await adminStore.getAgentRecord(accountId, gameId, 'ADVANCE');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ record }));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to fetch agent record' }));
      }
      return;
    }

    // ---- WRANGLER constraint monitoring API ----
    if (path === '/api/wrangler/status') {
      // Active constraint monitors from in-memory Map
      const activeMonitors: Array<{ gameId: string; title: string; snapshot: ReturnType<WranglerAgent['getLastSnapshot']> }> = [];
      const wrGameInfo = new Map<string, string>();
      try {
        const activeGames = await adminStore.listGamesByAgentStatus('WRANGLER', ['active']);
        for (const g of activeGames) wrGameInfo.set(g.id, g.title);
      } catch { /* ok */ }
      for (const [gid, w] of wranglers) {
        activeMonitors.push({ gameId: gid, title: wrGameInfo.get(gid) ?? gid, snapshot: w.getLastSnapshot() });
      }

      // Completed WRANGLER agents from Firestore
      const completed: Array<{
        gameId: string;
        accountId: string;
        title: string;
        agent: import('./admin-store.js').AgentAssignment;
        lastSnapshot?: Record<string, unknown>;
      }> = [];
      try {
        const doneGames = await adminStore.listGamesByAgentStatus('WRANGLER', ['done', 'idle']);
        for (const g of doneGames) {
          if (!wranglers.has(g.id) && g.agents?.WRANGLER) {
            const record = await adminStore.getAgentRecord(g.accountId, g.id, 'WRANGLER');
            completed.push({
              gameId: g.id,
              accountId: g.accountId,
              title: g.title,
              agent: g.agents.WRANGLER,
              lastSnapshot: record?.['lastSnapshot'] as Record<string, unknown> | undefined,
            });
          }
        }
      } catch { /* Firestore unavailable */ }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ active: activeMonitors, completed }));
      return;
    }

    if (path === '/api/wrangler/log') {
      const params = new URL(req.url ?? '/', `http://${req.headers.host}`).searchParams;
      const count = parseInt(params.get('n') ?? '200', 10);
      const gameId = params.get('gameId');
      if (gameId && wranglers.has(gameId)) {
        const w = wranglers.get(gameId)!;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ entries: w.getLog(count), total: w.getStatus().logTotal }));
      } else {
        const all: Array<ReturnType<WranglerAgent['getLog']>[number] & { gameId: string }> = [];
        for (const [gid, w] of wranglers) {
          for (const entry of w.getLog(count)) {
            all.push({ ...entry, gameId: gid });
          }
        }
        all.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        const total = Array.from(wranglers.values()).reduce((sum, w) => sum + w.getStatus().logTotal, 0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ entries: all.slice(-count), total }));
      }
      return;
    }

    if (path === '/api/wrangler/record') {
      const params = new URL(req.url ?? '/', `http://${req.headers.host}`).searchParams;
      const accountId = params.get('accountId');
      const gameId = params.get('gameId');
      if (!accountId || !gameId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'accountId and gameId required' }));
        return;
      }
      try {
        const record = await adminStore.getAgentRecord(accountId, gameId, 'WRANGLER');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ record }));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to fetch agent record' }));
      }
      return;
    }

    // ---- WRANGLER manual outreach trigger ----
    if (path === '/api/wrangler/outreach' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const { gameId, crewId } = JSON.parse(body);
          if (!gameId || !crewId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'gameId and crewId required' }));
            return;
          }
          const w = wranglers.get(gameId);
          if (!w) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `No active WRANGLER for game ${gameId}` }));
            return;
          }
          const result = await w.requestOutreach(crewId);
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
      return;
    }

    // ---- Twilio SMS webhook — incoming crew replies ----
    if (path === '/api/wrangler/sms-webhook' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          // Validate webhook signature if Twilio is configured
          if (twilioClient.isEnabled()) {
            const sig = req.headers['x-twilio-signature'] as string ?? '';
            const webhookUrl = `https://${req.headers.host}${path}`;
            const params: Record<string, string> = {};
            for (const [k, v] of new URLSearchParams(body)) params[k] = v;
            if (!twilioClient.validateWebhook(sig, webhookUrl, params)) {
              console.warn('[twilio] Webhook signature validation failed');
              // Don't reject — signature may fail behind proxies; log and continue
            }
          }

          const parsed = TwilioClient.parseIncomingSms(body);
          if (!parsed) {
            res.writeHead(400, { 'Content-Type': 'text/xml' });
            res.end('<Response/>');
            return;
          }

          console.log(`[twilio] Incoming SMS from ${parsed.from}: "${parsed.text}"`);

          // Find which WRANGLER instance has a pending outreach for this phone
          let handled = false;
          for (const [_gid, w] of wranglers) {
            const match = w.findByPhone(parsed.from);
            if (match) {
              await w.handleIncomingSms(parsed.from, parsed.text);
              handled = true;
              break;
            }
          }

          if (!handled) {
            console.log(`[twilio] No pending outreach found for ${parsed.from}`);
          }

          // Respond with empty TwiML (required by Twilio)
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          res.end('<Response/>');
        } catch (err) {
          console.error('[twilio] Webhook error:', err);
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          res.end('<Response/>');
        }
      });
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

        // Also stop TRAFFIC when unwatching
        const existingTraffic = traffics.get(gameId!);
        if (existingTraffic) {
          const trafficSnap = existingTraffic.getStatus();
          const trafficLog = existingTraffic.getLog();
          existingTraffic.stopWatching();
          traffics.delete(gameId!);
          const trafficStoppedAt = new Date().toISOString();
          void adminStore.setAgentAssignment(acctId!, gameId!, 'TRAFFIC', {
            status: 'idle',
            startedAt: trafficSnap.startedAt ?? trafficStoppedAt,
            stoppedAt: trafficStoppedAt,
          });
          void adminStore.setAgentRecord(acctId!, gameId!, 'TRAFFIC', {
            status: 'idle',
            stoppedAt: trafficStoppedAt,
            flightSummary: trafficSnap.flightSummary,
            flights: trafficSnap.flights,
            log: trafficLog,
          });
        }

        // Also stop ADVANCE when unwatching
        const existingAdvance = advances.get(gameId!);
        if (existingAdvance) {
          const advanceLog = JSON.parse(JSON.stringify(existingAdvance.getLog()));
          const advanceSnapshot = JSON.parse(JSON.stringify(existingAdvance.getLastSnapshot() ?? null));
          existingAdvance.stopWatching();
          advances.delete(gameId!);
          const advanceStoppedAt = new Date().toISOString();
          void adminStore.setAgentAssignment(acctId!, gameId!, 'ADVANCE', {
            status: 'idle',
            startedAt: advanceStoppedAt,
            stoppedAt: advanceStoppedAt,
          });
          void adminStore.setAgentRecord(acctId!, gameId!, 'ADVANCE', {
            status: 'idle',
            stoppedAt: advanceStoppedAt,
            lastSnapshot: advanceSnapshot,
            log: advanceLog,
          });
        }

        // Also stop WRANGLER when unwatching
        const existingWrangler = wranglers.get(gameId!);
        if (existingWrangler) {
          const wranglerLog = JSON.parse(JSON.stringify(existingWrangler.getLog()));
          const wranglerSnapshot = JSON.parse(JSON.stringify(existingWrangler.getLastSnapshot() ?? null));
          existingWrangler.stopWatching();
          wranglers.delete(gameId!);
          const wranglerStoppedAt = new Date().toISOString();
          void adminStore.setAgentAssignment(acctId!, gameId!, 'WRANGLER', {
            status: 'idle',
            startedAt: wranglerStoppedAt,
            stoppedAt: wranglerStoppedAt,
          });
          void adminStore.setAgentRecord(acctId!, gameId!, 'WRANGLER', {
            status: 'idle',
            stoppedAt: wranglerStoppedAt,
            lastSnapshot: wranglerSnapshot,
            log: wranglerLog,
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

        const result = startWatch(game, acctId!);
        if (!result.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: result.error }));
          return;
        }

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
    } else if (path === '/steward' || path === '/steward.html') {
      filePath = join(ROOT, 'packages', 'board', 'steward.html');
    } else if (path === '/traffic' || path === '/traffic.html') {
      filePath = join(ROOT, 'packages', 'board', 'traffic.html');
    } else if (path === '/advance' || path === '/advance.html') {
      filePath = join(ROOT, 'packages', 'board', 'advance.html');
    } else if (path === '/wrangler' || path === '/wrangler.html') {
      filePath = join(ROOT, 'packages', 'board', 'wrangler.html');
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
