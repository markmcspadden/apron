import { BaseAgent } from '@apron/orchestrator';
import type { FixtureStep, ComplianceUpdate, CrewComplianceEntry } from '@apron/types';
import type { GeminiClient } from '@apron/integration-google-cloud';
import type { ComplianceSnapshot } from './agreement.js';
import { evaluateImpact } from './agreement.js';

/** How often the heartbeat re-evaluates (ms) — 30 minutes */
const HEARTBEAT_INTERVAL = 30 * 60 * 1000;

export interface StewardWatchConfig {
  /** Game ID */
  gameId: string;
  /** Account ID */
  accountId: string;
  /** Gemini client for evaluation */
  gemini: GeminiClient;
  /** Function to gather current operational context */
  getOperationalContext: () => Promise<Record<string, unknown>>;
}

export class StewardAgent extends BaseAgent {
  private watchConfig: StewardWatchConfig | null = null;
  private lastSnapshot: ComplianceSnapshot | null = null;
  private evaluating = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Track the last predicted end we evaluated against — only re-evaluate on change */
  private lastPredictedEnd: string | null = null;
  /** Pending trigger that was skipped because an evaluation was in progress */
  private pendingTrigger: ComplianceUpdate['trigger'] | null = null;

  constructor() {
    super('STEWARD');
  }

  /**
   * Start proactive compliance monitoring.
   *
   * Three evaluation triggers:
   *   1. Startup baseline — runs immediately
   *   2. Heartbeat — every 30 minutes as a backstop
   *   3. Event-driven — when SPOTTER's predicted end time changes
   */
  startWatching(config: StewardWatchConfig): void {
    this.watchConfig = config;
    this.lastSnapshot = null;
    this.evaluating = false;
    this.lastPredictedEnd = null;

    console.log(`[steward] Compliance monitoring started for game ${config.gameId}`);

    this.emit({
      type: 'agent-status',
      message: 'STEWARD compliance monitoring started',
      agentStates: { STEWARD: 'on' },
    });

    // 1. Run initial baseline evaluation
    void this.runEvaluation('game-started');

    // 2. Start heartbeat timer — re-evaluate every 30 minutes as a backstop
    this.heartbeatTimer = setInterval(() => {
      console.log(`[steward] Heartbeat evaluation for game ${config.gameId}`);
      void this.runEvaluation('chain-update');
    }, HEARTBEAT_INTERVAL);
  }

  /**
   * Stop proactive monitoring.
   */
  stopWatching(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.watchConfig) {
      console.log(`[steward] Compliance monitoring stopped for game ${this.watchConfig.gameId}`);
      this.emit({
        type: 'agent-status',
        message: 'STEWARD compliance monitoring stopped',
        agentStates: { STEWARD: 'off' },
      });
    }
    this.watchConfig = null;
    this.lastSnapshot = null;
    this.lastPredictedEnd = null;
    this.pendingTrigger = null;
  }

  /**
   * Called by the server when SPOTTER's predicted end time changes.
   * Only triggers evaluation if the prediction actually shifted.
   */
  onPredictionChanged(predictedEnd: string): void {
    if (predictedEnd === this.lastPredictedEnd) {
      return; // No change — skip
    }

    console.log(`[steward] Predicted end changed: ${this.lastPredictedEnd ?? '(none)'} → ${predictedEnd}`);
    this.lastPredictedEnd = predictedEnd;
    void this.runEvaluation('chain-update');
  }

  /**
   * Called by the server when a chain-update event is received from SPOTTER.
   * Debounces — if an evaluation is already running, skips.
   * @deprecated Use onPredictionChanged() for smarter triggering
   */
  async onChainUpdate(): Promise<void> {
    await this.runEvaluation('chain-update');
  }

  /**
   * Called when a crew member is rebooked by FIXER.
   */
  async onCrewRebooked(): Promise<void> {
    await this.runEvaluation('crew-rebooked');
  }

  /**
   * Get the last compliance snapshot.
   */
  getLastSnapshot(): ComplianceSnapshot | null {
    return this.lastSnapshot;
  }

  /**
   * Run a compliance evaluation and emit the result.
   */
  private async runEvaluation(trigger: ComplianceUpdate['trigger']): Promise<void> {
    if (!this.watchConfig) return;
    if (this.evaluating) {
      console.log(`[steward] Evaluation already in progress — queuing ${trigger}`);
      this.pendingTrigger = trigger;
      return;
    }

    this.evaluating = true;

    try {
      const context = await this.watchConfig.getOperationalContext();

      if (!context['extractedRules']) {
        console.log('[steward] No extracted rules available — skipping evaluation');
        return;
      }

      const snapshot = await evaluateImpact(this.watchConfig.gemini, context);

      if (!snapshot) {
        console.warn('[steward] Evaluation returned no result');
        return;
      }

      this.lastSnapshot = snapshot;

      // Determine show state from results
      const hasViolation = snapshot.crew.some(c => c.turnaround.status === 'violation');
      const hasRisk = snapshot.crew.some(c => c.turnaround.status === 'at_risk');
      const hasUnknown = snapshot.crew.some(c => c.turnaround.status === 'unknown');

      // Emit compliance-update event
      const crewEntries: CrewComplianceEntry[] = snapshot.crew.map(c => ({
        name: c.name,
        position: c.position,
        turnaround: c.turnaround,
        overtime: c.overtime,
        meals: c.meals,
        penalties: c.penalties,
      }));

      this.emit({
        type: 'compliance-update',
        message: snapshot.summary,
        trigger,
        crew: crewEntries,
        totals: snapshot.totals,
        restCompression: snapshot.restCompression,
        summary: snapshot.summary,
      });

      // Escalate show state if needed
      if (hasViolation) {
        this.emit({
          type: 'show-state',
          message: snapshot.summary,
          state: 'down',
          alert: snapshot.summary,
        });
      } else if (hasRisk || hasUnknown) {
        this.emit({
          type: 'show-state',
          message: snapshot.summary,
          state: 'watch',
          alert: snapshot.summary,
        });
      }

      console.log(`[steward] Evaluation complete (${trigger}): $${snapshot.totals.totalExposure} exposure, ${snapshot.crew.filter(c => c.turnaround.status === 'violation').length} violations — ${snapshot.latencyMs}ms`);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[steward] Evaluation error (${trigger}):`, msg);
    } finally {
      this.evaluating = false;

      // If a trigger was queued while we were evaluating, run it now
      if (this.pendingTrigger) {
        const queued = this.pendingTrigger;
        this.pendingTrigger = null;
        console.log(`[steward] Running queued evaluation: ${queued}`);
        void this.runEvaluation(queued);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Fixture processing (existing behavior)
  // ---------------------------------------------------------------------------

  async process(input: Record<string, unknown>): Promise<void> {
    const step = input['step'] as FixtureStep;

    if (step.metrics) {
      this.emit({
        type: 'metrics',
        message: step.message,
        risk: step.metrics.risk ?? 0,
        exposed: step.metrics.exposed ?? 0,
      });
    }

    if (step.crewStates) {
      this.emit({
        type: 'crew-state',
        message: step.message,
        updates: step.crewStates,
      });
    }

    if (step.agentStates) {
      this.emit({
        type: 'agent-status',
        message: step.message,
        agentStates: step.agentStates,
      });
    }

    if (step.showState) {
      this.emit({
        type: 'show-state' as const,
        message: step.message,
        state: step.showState,
        alert: step.showState === 'down'
          ? '4 call times exposed. TD, A1, DIR and Lead EVS breach mandatory rest for a 14:00 CT call in Kansas City.'
          : null,
      });
    }
  }
}
