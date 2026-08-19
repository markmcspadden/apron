/**
 * ADVANCE agent — roster state intelligence with provenance-aware disclosure.
 *
 * ADVANCE reads crew sheets, call sheets, and roster data to determine where
 * each crew member is heading next. Its core job is enforcing the disclosure
 * model: what it can tell which audience about a crew member's next call,
 * based on how that information was gathered.
 *
 * Two modes:
 *   1. Fixture replay (process) — plays back scripted provenance/agent-status steps
 *   2. Live monitoring (startWatching/stopWatching) — scans crew assignments,
 *      builds a roster snapshot with seat-aware disclosure, heartbeats every 30 min
 *
 * Disclosure rules (from provenance.md):
 *   - Next call on your own show → both seats see full detail
 *   - External call, crew disclosed → both seats see full detail
 *   - External call, not disclosed → production sees "External call · withheld"
 *   - Brokered constraint → both seats see constraint only, not who for
 *   - Inferred next call → marked inferred, not actionable
 *
 * "Redaction is enforced at the data layer, not the display layer."
 */

import { BaseAgent } from '@apron/orchestrator';
import { isActionable, createEnvelope } from '@apron/provenance';
import type { FixtureStep, CrewGameAssignment, RosterEntry } from '@apron/types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** How often the heartbeat re-scans crew roster (ms) — 30 minutes */
const HEARTBEAT_INTERVAL = 30 * 60 * 1000;

/** Max log entries to keep in the ring buffer */
const MAX_LOG_ENTRIES = 200;

// ---------------------------------------------------------------------------
// Log entry
// ---------------------------------------------------------------------------

export type AdvanceLogLevel = 'info' | 'roster' | 'disclosure' | 'alert' | 'error';

export interface AdvanceLogEntry {
  timestamp: string;
  level: AdvanceLogLevel;
  message: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Config & status
// ---------------------------------------------------------------------------

export interface AdvanceWatchConfig {
  /** Game ID. */
  gameId: string;
  /** Account ID. */
  accountId: string;
  /** Injected by server — loads current crew assignments from the store. */
  getCrewAssignments: () => Promise<CrewGameAssignment[]>;
}

/** Roster summary — the ADVANCE snapshot. */
export interface RosterSnapshot {
  /** When this snapshot was built. */
  timestamp: string;
  /** What triggered it. */
  trigger: 'game-started' | 'heartbeat' | 'crew-changed';
  /** Per-crew entries with seat-aware disclosure. */
  crew: RosterEntry[];
  /** Aggregate counts. */
  summary: {
    total: number;
    withNextCall: number;
    external: number;
    externalDisclosed: number;
    externalRedacted: number;
    inferred: number;
    sameProduction: number;
    home: number;
  };
  /** Human-readable summary line. */
  summaryText: string;
}

export interface AdvanceStatus {
  watching: boolean;
  startedAt: string | null;
  config: {
    gameId: string;
    accountId: string;
  } | null;
  lastSnapshot: RosterSnapshot | null;
  logTotal: number;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class AdvanceAgent extends BaseAgent {
  private watchConfig: AdvanceWatchConfig | null = null;
  private watchStartedAt: string | null = null;
  private lastSnapshot: RosterSnapshot | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private evaluating = false;
  private logBuffer: AdvanceLogEntry[] = [];
  private logTotal = 0;

  constructor() {
    super('ADVANCE');
  }

  // ---- Logging ----

  private log(level: AdvanceLogLevel, message: string, data?: Record<string, unknown>): void {
    const entry: AdvanceLogEntry = { timestamp: new Date().toISOString(), level, message };
    if (data) entry.data = data;
    this.logBuffer.push(entry);
    this.logTotal++;
    if (this.logBuffer.length > MAX_LOG_ENTRIES) {
      this.logBuffer = this.logBuffer.slice(-MAX_LOG_ENTRIES);
    }
  }

  // ---- Public API ----

  /**
   * Start live roster monitoring.
   *
   * Three triggers:
   *   1. Startup — runs immediately
   *   2. Heartbeat — every 30 minutes
   *   3. Crew change — server calls onCrewChanged()
   */
  startWatching(config: AdvanceWatchConfig): void {
    this.watchConfig = config;
    this.watchStartedAt = new Date().toISOString();
    this.lastSnapshot = null;
    this.evaluating = false;
    this.logBuffer = [];
    this.logTotal = 0;

    this.log('info', `Roster monitoring started for game ${config.gameId}`);
    console.log(`[advance] Roster monitoring started for game ${config.gameId}`);

    this.emit({
      type: 'agent-status',
      message: 'ADVANCE roster monitoring started',
      agentStates: { ADVANCE: 'on' },
    });

    // 1. Initial roster scan
    void this.buildAndEmit('game-started');

    // 2. Heartbeat timer
    this.heartbeatTimer = setInterval(() => {
      this.log('info', 'Heartbeat — roster re-scan');
      console.log(`[advance] Heartbeat for game ${config.gameId}`);
      void this.buildAndEmit('heartbeat');
    }, HEARTBEAT_INTERVAL);
  }

  /**
   * Stop monitoring.
   */
  stopWatching(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.watchConfig) {
      this.log('info', `Roster monitoring stopped for game ${this.watchConfig.gameId}`);
      console.log(`[advance] Roster monitoring stopped for game ${this.watchConfig.gameId}`);
      this.emit({
        type: 'agent-status',
        message: 'ADVANCE roster monitoring stopped',
        agentStates: { ADVANCE: 'off' },
      });
    }
    this.watchConfig = null;
  }

  /**
   * Called by the server when crew data changes (new assignment, routing update, etc.).
   */
  onCrewChanged(): void {
    if (!this.watchConfig) return;
    this.log('info', 'Crew data changed — re-scanning roster');
    console.log(`[advance] Crew change trigger for game ${this.watchConfig.gameId}`);
    void this.buildAndEmit('crew-changed');
  }

  /**
   * Get the last roster snapshot.
   */
  getLastSnapshot(): RosterSnapshot | null {
    return this.lastSnapshot;
  }

  /**
   * Get current status.
   */
  getStatus(): AdvanceStatus {
    return {
      watching: this.watchConfig !== null,
      startedAt: this.watchStartedAt,
      config: this.watchConfig ? {
        gameId: this.watchConfig.gameId,
        accountId: this.watchConfig.accountId,
      } : null,
      lastSnapshot: this.lastSnapshot,
      logTotal: this.logTotal,
    };
  }

  /**
   * Get log entries.
   */
  getLog(n: number = MAX_LOG_ENTRIES): AdvanceLogEntry[] {
    return this.logBuffer.slice(-n);
  }

  isWatching(): boolean {
    return this.watchConfig !== null;
  }

  // ---- Core logic ----

  /**
   * Build the roster snapshot and emit it.
   */
  private async buildAndEmit(trigger: RosterSnapshot['trigger']): Promise<void> {
    if (!this.watchConfig) return;
    if (this.evaluating) {
      this.log('info', `Scan already in progress — skipping ${trigger}`);
      return;
    }

    this.evaluating = true;

    try {
      const assignments = await this.watchConfig.getCrewAssignments();

      if (assignments.length === 0) {
        this.log('info', 'No crew assignments found');
        this.evaluating = false;
        return;
      }

      // Build per-crew entries with disclosure model applied
      const crew: RosterEntry[] = assignments.map(ca => this.applyDisclosureModel(ca));

      // Compute summary
      const summary = {
        total: crew.length,
        withNextCall: crew.filter(c => c.tmc.nextCallType !== 'home' || c.tmc.callTime !== null).length,
        external: crew.filter(c => c.tmc.nextCallType === 'external').length,
        externalDisclosed: crew.filter(c => c.tmc.nextCallType === 'external' && !c.production.redacted).length,
        externalRedacted: crew.filter(c => c.tmc.nextCallType === 'external' && c.production.redacted).length,
        inferred: crew.filter(c => c.provenanceLevel === 'inferred').length,
        sameProduction: crew.filter(c => c.tmc.nextCallType === 'same-production').length,
        home: crew.filter(c => c.tmc.nextCallType === 'home').length,
      };

      // Build human-readable summary
      const parts: string[] = [`${summary.total} crew tracked`];
      if (summary.external > 0) {
        parts.push(`${summary.external} external call${summary.external !== 1 ? 's' : ''} (${summary.externalDisclosed} disclosed, ${summary.externalRedacted} withheld)`);
      }
      if (summary.inferred > 0) {
        parts.push(`${summary.inferred} inferred`);
      }
      if (summary.sameProduction > 0) {
        parts.push(`${summary.sameProduction} same-show`);
      }
      const summaryText = parts.join(' · ');

      const snapshot: RosterSnapshot = {
        timestamp: new Date().toISOString(),
        trigger,
        crew,
        summary,
        summaryText,
      };

      this.lastSnapshot = snapshot;

      // Log disclosure summary
      this.log('roster', summaryText, {
        total: summary.total,
        external: summary.external,
        disclosed: summary.externalDisclosed,
        redacted: summary.externalRedacted,
        inferred: summary.inferred,
      });

      // Log individual disclosure decisions for external calls
      for (const entry of crew) {
        if (entry.tmc.nextCallType === 'external') {
          if (entry.production.redacted) {
            this.log('disclosure', `${entry.name} (${entry.position}): external call withheld from production — source: ${entry.tmc.source}`, {
              crewId: entry.crewId,
              provenanceLevel: entry.provenanceLevel,
              brokerable: entry.tmc.brokerable,
            });
          } else {
            this.log('disclosure', `${entry.name} (${entry.position}): external call disclosed — ${entry.tmc.production ?? 'unknown'} via ${entry.tmc.source}`, {
              crewId: entry.crewId,
              provenanceLevel: entry.provenanceLevel,
              brokerable: entry.tmc.brokerable,
            });
          }
        }
        if (entry.provenanceLevel === 'inferred') {
          this.log('disclosure', `${entry.name} (${entry.position}): next call is inferred — not actionable`, {
            crewId: entry.crewId,
          });
        }
      }

      // Emit roster-update event
      this.emit({
        type: 'roster-update',
        message: summaryText,
        trigger,
        crew,
        summary,
      });

      console.log(`[advance] Roster scan complete (${trigger}): ${summaryText}`);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `Roster scan failed: ${msg}`);
      console.error(`[advance] Roster scan error (${trigger}):`, msg);
    } finally {
      this.evaluating = false;
    }
  }

  /**
   * The disclosure model — the heart of ADVANCE.
   *
   * Applies provenance-based rules to determine what each seat can see
   * about a crew member's next call. This is where the security model
   * from provenance.md is enforced.
   */
  private applyDisclosureModel(ca: CrewGameAssignment): RosterEntry {
    const nc = ca.nextCall;
    const prov = nc.provenance;

    // Check actionability via the provenance package
    const envelope = createEnvelope({
      agent: 'ADVANCE',
      sourceType: prov.source,
      sourceId: ca.crewId,
      confidence: prov.level === 'confirmed' ? 'confirmed'
        : prov.level === 'sheet' ? 'high'
        : prov.level === 'external' ? 'medium'
        : prov.level === 'inferred' ? 'inferred'
        : 'low',
      provenanceLevel: prov.level,
      visibility: ['ADVANCE'],
      brokerable: prov.brokerable,
    });
    const actionable = isActionable(envelope);

    // ---- TMC desk: always sees full detail ----
    const tmc = {
      nextCallType: nc.type,
      destination: nc.destinationCity || nc.destinationAirport || '',
      production: nc.production?.name ?? null,
      network: nc.production?.network ?? null,
      callTime: nc.callTime?.display ?? null,
      source: prov.sourceDisplay,
      brokerable: prov.brokerable,
    };

    // ---- Production seat: enforce disclosure ----
    let prodRedacted = false;
    let prodDestination: string | null = nc.destinationCity || nc.destinationAirport || null;
    let prodProduction: string | null = null;
    let prodCallTime: string | null = nc.callTime?.display ?? null;

    if (nc.type === 'external') {
      if (nc.disclosed && prov.brokerable) {
        // Crew voluntarily disclosed this call — production can see it
        // This is the "external-call-disclosed" visibility path
        prodProduction = nc.production?.name ?? null;
      } else {
        // Network crew sheet data or undisclosed — production gets redacted
        // "External call · withheld" — the production coordinator doesn't
        // need to know (and shouldn't know) who else this person works for
        prodRedacted = true;
        prodDestination = null;
        prodProduction = null;
        prodCallTime = null;
      }
    } else if (nc.type === 'same-production') {
      // Same show — both seats always see full detail
      prodProduction = nc.production?.name ?? null;
    }
    // type === 'home': destination is visible, no production to show

    const production = {
      nextCallType: nc.type,
      destination: prodDestination,
      production: prodProduction,
      callTime: prodCallTime,
      redacted: prodRedacted,
    };

    return {
      crewId: ca.crewId,
      name: ca.name,
      position: ca.position,
      keyPosition: ca.keyPosition,
      tier: ca.tier,
      homeAirport: ca.homeAirport,
      provenanceLevel: prov.level,
      actionable,
      tmc,
      production,
    };
  }

  // ---------------------------------------------------------------------------
  // Fixture processing (existing behavior)
  // ---------------------------------------------------------------------------

  async process(input: Record<string, unknown>): Promise<void> {
    const step = input['step'] as FixtureStep;

    if (step.provenance) {
      for (const [crewName, prov] of Object.entries(step.provenance)) {
        this.emit({
          type: 'provenance',
          message: step.message,
          crewName,
          provenance: prov,
          nextCall: step.calls?.[crewName],
        });
      }
    }

    if (step.agentStates) {
      this.emit({
        type: 'agent-status',
        message: step.message,
        agentStates: step.agentStates,
      });
    }
  }
}
