/**
 * SPOTTER agent — monitors live game state, weather, and predicts end time.
 *
 * Two modes:
 *   1. Fixture replay (process) — plays back scripted fixture steps
 *   2. Live monitoring (startWatching/stopWatching) — polls ESPN + Weather.gov,
 *      uses Gemini for end-time prediction
 */

import { BaseAgent } from '@apron/orchestrator';
import type { FixtureStep, FixtureScenario, ShowState, ChainNode } from '@apron/types';
import { ESPNClient, type ESPNGameState } from './espn.js';
import { WeatherClient, type WeatherConditions } from './weather.js';
import type { GeminiClient } from '@apron/integration-google-cloud';

// Re-export ESPN client for server-side use
export { ESPNClient } from './espn.js';
export type { ESPNGameState, LiveGameSummary } from './espn.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** How often to poll ESPN for score updates (ms) */
const SCORE_POLL_INTERVAL = 60_000; // 1 min

/** How often to poll weather (ms) — weather changes slowly */
const WEATHER_POLL_INTERVAL = 300_000; // 5 min

/** How often to run end-time prediction when game is live (ms) */
const PREDICTION_INTERVAL = 60_000; // 1 min

/** Max log entries to keep in the ring buffer */
const MAX_LOG_ENTRIES = 200;

// ---------------------------------------------------------------------------
// Log entry — structured record of everything the SPOTTER does
// ---------------------------------------------------------------------------

export type SpotterLogLevel = 'info' | 'score' | 'weather' | 'prediction' | 'alert' | 'error';

export interface SpotterLogEntry {
  timestamp: string;
  level: SpotterLogLevel;
  message: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Status snapshot — full picture of a SPOTTER instance
// ---------------------------------------------------------------------------

export interface SpotterStatus {
  watching: boolean;
  startedAt: string | null;
  config: {
    showId: string;
    sport: string;
    espnEventId: string;
    scheduledStart: string;
    expectedDurationMinutes: number;
    crewCount: number;
    geminiEnabled: boolean;
  } | null;
  game: {
    shortName: string;
    state: 'pre' | 'in' | 'post';
    detail: string;
    homeTeam: string;
    homeScore: number;
    awayTeam: string;
    awayScore: number;
    period: number;
    clock: string;
    venue: string;
    indoor: boolean;
  } | null;
  weather: {
    temperatureF: number;
    feelsLikeF: number;
    windSpeedMph: number;
    windDirection: string;
    shortForecast: string;
    precipChance: number;
    delayRisk: string;
    delayDetail: string;
  } | null;
  prediction: {
    predictedEnd: string;
    showState: string;
  } | null;
  log: SpotterLogEntry[];
  logTotal: number;
}

// ---------------------------------------------------------------------------
// Watch config — what the SPOTTER needs to monitor a game
// ---------------------------------------------------------------------------

export interface SpotterWatchConfig {
  /** Apron show/game ID */
  showId: string;

  /** Sport type for ESPN lookup */
  sport: 'baseball' | 'football' | 'basketball' | 'hockey' | 'soccer';

  /** ESPN event ID (numeric string) */
  espnEventId: string;

  /** Scheduled game start time (ISO 8601) */
  scheduledStart: string;

  /** Expected duration in minutes (from game type defaults or override) */
  expectedDurationMinutes: number;

  /** Strike/load-out duration in minutes */
  strikeDurationMinutes: number;

  /** The wrap-to-gate chain nodes for recomputing */
  chain: ChainNode[];

  /** Number of traveling crew */
  crewCount: number;

  /** Optional Gemini client for end-time prediction */
  gemini?: GeminiClient;

  /** IANA timezone for the game venue (e.g. "America/Chicago").
   *  Chain times (HH:MM) are wall-clock in this timezone. */
  timezone?: string;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class SpotterAgent extends BaseAgent {
  private espn = new ESPNClient();
  private weather = new WeatherClient();

  // Live-watch state
  private scoreTimer: ReturnType<typeof setInterval> | null = null;
  private weatherTimer: ReturnType<typeof setInterval> | null = null;
  private predictionTimer: ReturnType<typeof setInterval> | null = null;
  private watchConfig: SpotterWatchConfig | null = null;
  private watchStartedAt: string | null = null;

  // Tracking for change detection
  private lastScoreState: string = '';
  private lastWeather: WeatherConditions | null = null;
  private lastPredictedEnd: string = '';
  private lastShowState: ShowState = 'clear';
  private lastGame: ESPNGameState | null = null;

  // Structured log buffer (ring)
  private logBuffer: SpotterLogEntry[] = [];
  private logTotal = 0;

  constructor() {
    super('SPOTTER');
  }

  // =========================================================================
  // Log & status (used by the dashboard API)
  // =========================================================================

  private log(level: SpotterLogLevel, message: string, data?: Record<string, unknown>): void {
    const entry: SpotterLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(data ? { data } : {}),
    };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > MAX_LOG_ENTRIES) {
      this.logBuffer.shift();
    }
    this.logTotal++;
  }

  /** Return the last `n` log entries (most recent last). */
  getLog(n?: number): SpotterLogEntry[] {
    if (n == null || n >= this.logBuffer.length) return [...this.logBuffer];
    return this.logBuffer.slice(-n);
  }

  /** Expose watch config for timezone resolution. */
  getWatchConfig(): SpotterWatchConfig | null {
    return this.watchConfig;
  }

  /** Full structured status snapshot for the dashboard. */
  getStatus(): SpotterStatus {
    const cfg = this.watchConfig;
    return {
      watching: cfg !== null,
      startedAt: this.watchStartedAt,
      config: cfg ? {
        showId: cfg.showId,
        sport: cfg.sport,
        espnEventId: cfg.espnEventId,
        scheduledStart: cfg.scheduledStart,
        expectedDurationMinutes: cfg.expectedDurationMinutes,
        crewCount: cfg.crewCount,
        geminiEnabled: cfg.gemini?.isEnabled() ?? false,
      } : null,
      game: this.lastGame ? {
        shortName: this.lastGame.shortName,
        state: this.lastGame.state,
        detail: this.lastGame.detail,
        homeTeam: this.lastGame.home.abbreviation,
        homeScore: this.lastGame.home.score,
        awayTeam: this.lastGame.away.abbreviation,
        awayScore: this.lastGame.away.score,
        period: this.lastGame.period,
        clock: this.lastGame.clock,
        venue: this.lastGame.venue.name,
        indoor: this.lastGame.venue.indoor,
      } : null,
      weather: this.lastWeather ? {
        temperatureF: this.lastWeather.temperatureF,
        feelsLikeF: this.lastWeather.feelsLikeF,
        windSpeedMph: this.lastWeather.windSpeedMph,
        windDirection: this.lastWeather.windDirection,
        shortForecast: this.lastWeather.shortForecast,
        precipChance: this.lastWeather.precipChance,
        delayRisk: this.lastWeather.delayRisk,
        delayDetail: this.lastWeather.delayDetail,
      } : null,
      prediction: this.lastPredictedEnd ? {
        predictedEnd: this.lastPredictedEnd,
        showState: this.lastShowState,
      } : null,
      log: this.logBuffer.slice(-30), // last 30 for the dashboard card
      logTotal: this.logTotal,
    };
  }

  // =========================================================================
  // Fixture replay mode — existing behavior, untouched
  // =========================================================================

  async process(input: Record<string, unknown>): Promise<void> {
    const step = input['step'] as FixtureStep;
    const scenario = input['scenario'] as FixtureScenario;

    if (step.gameState) {
      this.emit({
        type: 'game-state',
        message: step.message,
        gameState: step.gameState[0],
        live: step.gameState[1] === 'live',
      });
    }

    if (step.chainLevel !== undefined) {
      this.emit({
        type: 'chain-update',
        message: step.message,
        level: step.chainLevel,
        nodes: scenario.chain,
      });
    }

    if (step.showState) {
      this.emit({
        type: 'show-state' as const,
        message: step.message,
        state: step.showState,
        alert: this.buildAlert(step),
      });
    }

    if (step.metrics) {
      this.emit({
        type: 'metrics',
        message: step.message,
        risk: step.metrics.risk ?? 0,
        exposed: step.metrics.exposed ?? 0,
      });
    }

    if (step.slackDelta !== undefined) {
      this.emit({
        type: 'crew-state',
        message: step.message,
        updates: {},
      });
    }
  }

  private buildAlert(step: FixtureStep): string | null {
    if (step.showState === 'watch') return 'Extra innings. Chain recomputing for 22 traveling crew.';
    if (step.showState === 'risk') return '14 crew at risk. Projected wrap 01:05 · 06:05 departures no longer reachable with rest.';
    if (step.showState === 'down') return '4 call times exposed. TD, A1, DIR and Lead EVS breach mandatory rest for a 14:00 CT call in Kansas City.';
    return null;
  }

  // =========================================================================
  // Live monitoring mode
  // =========================================================================

  /**
   * Start watching a live game. Begins polling ESPN, weather, and running
   * Gemini predictions on interval.
   */
  startWatching(config: SpotterWatchConfig): void {
    this.stopWatching(); // clean up any existing watch

    this.watchConfig = config;
    this.watchStartedAt = new Date().toISOString();
    this.lastScoreState = '';
    this.lastWeather = null;
    this.lastPredictedEnd = '';
    this.lastShowState = 'clear';
    this.lastGame = null;

    this.log('info', `Live watch started: ${config.sport} event ${config.espnEventId}`, {
      sport: config.sport, espnEventId: config.espnEventId, crewCount: config.crewCount,
    });
    console.log(`[spotter] Starting live watch: ${config.sport} event ${config.espnEventId}`);

    // Emit initial agent status
    this.emit({
      type: 'agent-status',
      message: 'SPOTTER live monitoring started',
      agentStates: { SPOTTER: 'on' },
    });

    // Run immediately, then on interval
    void this.pollScore();
    void this.pollWeather();

    this.scoreTimer = setInterval(() => void this.pollScore(), SCORE_POLL_INTERVAL);
    this.weatherTimer = setInterval(() => void this.pollWeather(), WEATHER_POLL_INTERVAL);
    this.predictionTimer = setInterval(() => void this.runPrediction(), PREDICTION_INTERVAL);
  }

  /**
   * Stop watching. Clears all polling timers.
   */
  stopWatching(): void {
    if (this.scoreTimer) { clearInterval(this.scoreTimer); this.scoreTimer = null; }
    if (this.weatherTimer) { clearInterval(this.weatherTimer); this.weatherTimer = null; }
    if (this.predictionTimer) { clearInterval(this.predictionTimer); this.predictionTimer = null; }

    if (this.watchConfig) {
      this.log('info', `Stopped watching event ${this.watchConfig.espnEventId}`);
      console.log(`[spotter] Stopped watching event ${this.watchConfig.espnEventId}`);
      this.emit({
        type: 'agent-status',
        message: 'SPOTTER monitoring stopped',
        agentStates: { SPOTTER: 'off' },
      });
      this.watchConfig = null;
      this.watchStartedAt = null;
    }
  }

  /** Whether the agent is actively watching a game. */
  isWatching(): boolean {
    return this.watchConfig !== null;
  }

  // -------------------------------------------------------------------------
  // Score polling
  // -------------------------------------------------------------------------

  private async pollScore(): Promise<void> {
    if (!this.watchConfig) return;
    const { sport, espnEventId } = this.watchConfig;

    try {
      const game = await this.espn.getGame(sport, espnEventId);
      if (!game) {
        this.log('error', `Game ${espnEventId} not found on scoreboard`);
        console.warn(`[spotter] Game ${espnEventId} not found on scoreboard`);
        return;
      }

      this.lastGame = game;
      const stateKey = `${game.state}|${game.period}|${game.clock}|${game.home.score}-${game.away.score}`;
      const changed = stateKey !== this.lastScoreState;

      if (changed) {
        this.lastScoreState = stateKey;
      }

      // Always emit game-state so new WebSocket clients catch up quickly;
      // only run full change processing (log, show-state, prediction) on actual changes.
      this.emitGameState(game);
      if (changed) {
        this.onScoreChange(game);
      }
    } catch (err) {
      this.log('error', `Score poll error: ${err instanceof Error ? err.message : String(err)}`);
      console.warn('[spotter] Score poll error:', err);
    }
  }

  /** Emit game-state event (called every poll so new WS clients catch up quickly). */
  private emitGameState(game: ESPNGameState): void {
    const scoreDisplay = `${game.away.abbreviation} ${game.away.score}, ${game.home.abbreviation} ${game.home.score}`;
    this.emit({
      type: 'game-state',
      message: `${game.shortDetail} — ${scoreDisplay}`,
      gameState: game.shortDetail,
      score: scoreDisplay,
      awayTeam: game.away.abbreviation,
      awayScore: game.away.score,
      homeTeam: game.home.abbreviation,
      homeScore: game.home.score,
      live: game.state === 'in',
    });
  }

  /** Full change processing — log, show-state, prediction, done check. */
  private onScoreChange(game: ESPNGameState): void {
    const config = this.watchConfig!;
    const scoreDisplay = `${game.away.abbreviation} ${game.away.score}, ${game.home.abbreviation} ${game.home.score}`;

    this.log('score', `${game.shortDetail} — ${scoreDisplay}`, {
      state: game.state, period: game.period, clock: game.clock,
      home: game.home.score, away: game.away.score,
    });

    // Update show state based on game state
    const newShowState = this.assessShowState(game);
    if (newShowState !== this.lastShowState) {
      this.lastShowState = newShowState;
      this.emit({
        type: 'show-state',
        message: this.buildLiveAlert(game, newShowState) ?? `Game state: ${game.shortDetail}`,
        state: newShowState,
        alert: this.buildLiveAlert(game, newShowState),
      });

      // When state escalates, mark agent as hot
      if (newShowState === 'watch' || newShowState === 'risk') {
        this.emit({
          type: 'agent-status',
          message: `SPOTTER escalated to ${newShowState}`,
          agentStates: { SPOTTER: 'hot' },
        });
      }
    }

    // If game ended, run final prediction and auto-stop
    if (game.state === 'post') {
      this.log('alert', `Game ended: ${game.shortDetail}`, { score: scoreDisplay });
      console.log(`[spotter] Game ended: ${game.shortDetail} — stopping`);

      // One last prediction with the final state, then shut down
      void this.runPrediction().finally(() => {
        this.stopWatching();

        // Tell the server we're done so it can clean up the Map entry
        this.emit({
          type: 'agent-status',
          message: `SPOTTER: game ended (${game.shortDetail})`,
          agentStates: { SPOTTER: 'done' },
        });
      });
      return; // skip the duplicate prediction below
    }

    // Run prediction immediately on score changes
    void this.runPrediction();
  }

  // -------------------------------------------------------------------------
  // Weather polling
  // -------------------------------------------------------------------------

  private async pollWeather(): Promise<void> {
    if (!this.watchConfig) return;

    // We need the latest game data for venue info
    const { sport, espnEventId } = this.watchConfig;
    const game = await this.espn.getGame(sport, espnEventId);
    if (!game) return;

    // Skip indoor venues
    if (game.venue.indoor) return;

    const conditions = await this.weather.getConditions(
      game.venue.name,
      game.venue.city,
      game.venue.state,
      game.venue.indoor,
    );

    if (!conditions) return;

    // Only emit if conditions changed meaningfully
    if (this.weatherChanged(conditions)) {
      this.lastWeather = conditions;

      this.log('weather', `${conditions.shortForecast}, ${conditions.temperatureF}°F, wind ${conditions.windSpeedMph} mph ${conditions.windDirection}`, {
        temperatureF: conditions.temperatureF, precipChance: conditions.precipChance,
        delayRisk: conditions.delayRisk, wind: conditions.windSpeedMph,
      });

      // If there's a delay risk, escalate
      if (conditions.delayRisk !== 'none') {
        const msg = `Weather alert at ${game.venue.name}: ${conditions.delayDetail}`;
        this.log('alert', msg, { delayRisk: conditions.delayRisk });
        console.log(`[spotter] ${msg}`);

        // Weather risk escalates show state
        if (conditions.delayRisk === 'high' && this.lastShowState !== 'risk' && this.lastShowState !== 'down') {
          this.lastShowState = 'risk';
          this.emit({
            type: 'show-state',
            message: msg,
            state: 'risk',
            alert: msg,
          });
        } else if (conditions.delayRisk === 'moderate' && this.lastShowState === 'clear') {
          this.lastShowState = 'watch';
          this.emit({
            type: 'show-state',
            message: msg,
            state: 'watch',
            alert: msg,
          });
        }
      }
    }
  }

  private weatherChanged(conditions: WeatherConditions): boolean {
    if (!this.lastWeather) return true;
    // Meaningful change = risk level changed, or temp shifted >5°F, or precip chance shifted >20%
    return (
      conditions.delayRisk !== this.lastWeather.delayRisk
      || Math.abs(conditions.temperatureF - this.lastWeather.temperatureF) > 5
      || Math.abs(conditions.precipChance - this.lastWeather.precipChance) > 20
    );
  }

  // -------------------------------------------------------------------------
  // End-time prediction (Gemini)
  // -------------------------------------------------------------------------

  private async runPrediction(): Promise<void> {
    if (!this.watchConfig) return;
    const config = this.watchConfig;
    const gemini = config.gemini;

    // Get latest game state
    const game = await this.espn.getGame(config.sport, config.espnEventId);
    if (!game) return;

    let predictedEnd: string;
    let predictedDurationMinutes: number;

    if (gemini?.isEnabled()) {
      // Use Gemini for intelligent prediction
      const prediction = await this.geminiPredict(gemini, game, config);
      if (prediction) {
        predictedEnd = prediction.predictedEndTime;
        predictedDurationMinutes = prediction.predictedDurationMinutes;
      } else {
        // Gemini failed — fall back to simple math
        const simple = this.simplePrediction(game, config);
        predictedEnd = simple.end;
        predictedDurationMinutes = simple.durationMinutes;
      }
    } else {
      // No Gemini — use simple math
      const simple = this.simplePrediction(game, config);
      predictedEnd = simple.end;
      predictedDurationMinutes = simple.durationMinutes;
    }

    // Only emit chain updates when the prediction actually changes
    if (predictedEnd !== this.lastPredictedEnd) {
      this.lastPredictedEnd = predictedEnd;

      // Recompute chain with new predicted end
      const updatedChain = this.recomputeChain(config.chain, predictedEnd, config.strikeDurationMinutes);

      this.emit({
        type: 'chain-update',
        message: `Predicted end: ${predictedEnd} (${predictedDurationMinutes}m)`,
        level: this.computeChainLevel(game, config),
        nodes: updatedChain,
      });

      this.log('prediction', `Predicted end: ${predictedEnd} (${predictedDurationMinutes}m)`, {
        predictedEnd, predictedDurationMinutes,
      });
      console.log(`[spotter] End-time prediction: ${predictedEnd} (${predictedDurationMinutes}m total)`);
    }
  }

  /**
   * Use Gemini to predict game end time based on current state.
   *
   * Feeds anchoring context (elapsed time, pace, prior prediction) so the
   * model converges instead of wandering on each call.
   */
  private async geminiPredict(
    gemini: GeminiClient,
    game: ESPNGameState,
    config: SpotterWatchConfig,
  ): Promise<{ predictedEndTime: string; predictedDurationMinutes: number } | null> {
    // Compute elapsed time and pace for anchoring
    const espnStartMs = game.startTime ? new Date(game.startTime).getTime() : NaN;
    const configStartMs = new Date(config.scheduledStart).getTime();
    const startMs = (!isNaN(espnStartMs) && espnStartMs > 0) ? espnStartMs : configStartMs;
    const elapsedMs = Date.now() - startMs;
    const elapsedMinutes = Math.max(0, Math.round(elapsedMs / 60_000));

    const context: Record<string, unknown> = {
      sport: config.sport,
      scheduledStart: config.scheduledStart,
      actualStartTime: !isNaN(espnStartMs) ? new Date(espnStartMs).toISOString() : null,
      expectedDurationMinutes: config.expectedDurationMinutes,
      currentState: game.state,
      currentPeriod: game.period,
      currentClock: game.clock,
      detail: game.detail,
      homeTeam: game.home.abbreviation,
      homeScore: game.home.score,
      awayTeam: game.away.abbreviation,
      awayScore: game.away.score,
      venue: game.venue.name,
      indoor: game.venue.indoor,
      // Anchoring: elapsed time and pace
      elapsedMinutes,
      currentTimeUTC: new Date().toISOString(),
    };

    // Sport-specific pace metrics
    // Baseball: only send minutesPerInning after 3+ completed innings — earlier
    // pace is unreliable (inflated by pregame, first-pitch ceremony, warmups).
    // Clamp to 8–30 min/inning (MLB reality: fastest ~13, slowest ~25).
    if (config.sport === 'baseball' && game.state === 'in') {
      const completedInnings = Math.max(0, game.period - 1);
      context['completedInnings'] = completedInnings;
      if (completedInnings >= 3) {
        const rawPace = Math.round(elapsedMinutes / completedInnings);
        context['minutesPerInning'] = Math.max(8, Math.min(30, rawPace));
      } else {
        context['earlyGame'] = true;
        context['note_pace'] = 'Too early for reliable pace — use sport baseline (~20 min/inning for MLB).';
      }
    } else if (game.state === 'in' && game.period > 0) {
      const totalPeriods = config.sport === 'hockey' ? 3 : 4;
      context['fractionComplete'] = Math.round((game.period / totalPeriods) * 100) / 100;
    }

    // Anchoring: prior prediction so the model doesn't wander
    if (this.lastPredictedEnd) {
      context['priorPrediction'] = {
        predictedEndTime: this.lastPredictedEnd,
        note: 'Only revise significantly if game state materially changed (extra innings, delay, blowout pace shift).',
      };
    }

    if (this.lastWeather) {
      context['weather'] = {
        temperature: this.lastWeather.temperatureF,
        wind: this.lastWeather.windSpeedMph,
        forecast: this.lastWeather.shortForecast,
        precipChance: this.lastWeather.precipChance,
        delayRisk: this.lastWeather.delayRisk,
      };
    }

    try {
      return await gemini.promptJSON<{
        predictedEndTime: string;
        predictedDurationMinutes: number;
      }>({
        agent: 'SPOTTER',
        systemInstruction: PREDICTION_SYSTEM_PROMPT,
        context,
        query: `Given the current game state, predict when this ${config.sport} game will end. Return the predicted end time as an ISO 8601 string and the total predicted duration in minutes.`,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const shortErr = errMsg.length > 200 ? errMsg.slice(0, 200) + '…' : errMsg;
      this.log('error', `Gemini prediction failed — falling back to simple math. ${shortErr}`);
      console.warn('[spotter] Gemini prediction error:', shortErr);
      return null;
    }
  }

  /**
   * Simple math-based prediction when Gemini is unavailable.
   * Uses sport-specific heuristics.
   *
   * Prefers the actual ESPN start time over config.scheduledStart so
   * predictions stay sane when the two don't match (e.g. game already
   * started but config says tonight).
   */
  private simplePrediction(
    game: ESPNGameState,
    config: SpotterWatchConfig,
  ): { end: string; durationMinutes: number } {
    // Use ESPN's actual start time when available and valid
    const espnStartMs = game.startTime ? new Date(game.startTime).getTime() : NaN;
    const configStartMs = new Date(config.scheduledStart).getTime();
    const startMs = (!isNaN(espnStartMs) && espnStartMs > 0) ? espnStartMs : configStartMs;

    let durationMinutes = config.expectedDurationMinutes;

    if (game.state === 'post') {
      // Game is over — use actual end time (now)
      const endMs = Date.now();
      const actualDuration = Math.round((endMs - startMs) / 60_000);
      return {
        end: new Date(endMs).toISOString(),
        durationMinutes: Math.max(0, actualDuration),
      };
    }

    if (game.state === 'pre') {
      // Game hasn't started — use expected duration from the actual start
      return {
        end: new Date(startMs + durationMinutes * 60_000).toISOString(),
        durationMinutes,
      };
    }

    // Game is in progress — estimate based on sport
    const elapsedMs = Date.now() - startMs;

    // Guard: if elapsed is negative or zero, the start time is in the
    // future or exactly now — can't extrapolate, use expected duration.
    if (elapsedMs <= 0) {
      return {
        end: new Date(Date.now() + durationMinutes * 60_000).toISOString(),
        durationMinutes,
      };
    }

    if (config.sport === 'baseball') {
      // Baseball: estimate minutes-per-inning from elapsed time
      const currentInning = game.period;
      const totalInnings = Math.max(9, currentInning); // at least 9
      const elapsedInnings = Math.max(1, currentInning - 1); // completed innings
      // Clamp pace to 8–30 min/inning; early innings inflate the raw number
      // (pregame, ceremony, warmups) and produce absurd predictions.
      const rawPace = (elapsedMs / 60_000) / elapsedInnings;
      const minsPerInning = elapsedInnings >= 3
        ? Math.max(8, Math.min(30, rawPace))
        : 20; // MLB baseline when too early for real pace
      const remainingInnings = totalInnings - currentInning + 1;

      // If score is tied in 9th+, add expected extra innings
      if (currentInning >= 9 && game.home.score === game.away.score) {
        durationMinutes = Math.round((elapsedMs / 60_000) + minsPerInning * (remainingInnings + 1));
      } else {
        durationMinutes = Math.round((elapsedMs / 60_000) + minsPerInning * remainingInnings);
      }
    } else {
      // Timed sports: use proportion of game elapsed
      const totalPeriods = config.sport === 'hockey' ? 3 : 4;
      const fraction = game.period / totalPeriods;
      if (fraction > 0) {
        durationMinutes = Math.round((elapsedMs / 60_000) / fraction);
      }
    }

    // Add weather delay buffer
    if (this.lastWeather?.delayRisk === 'high') {
      durationMinutes += 45; // rain delay buffer
    } else if (this.lastWeather?.delayRisk === 'moderate') {
      durationMinutes += 20;
    }

    // Clamp to sane range: at least elapsed time, at most 2× expected duration
    const elapsedMin = Math.round(elapsedMs / 60_000);
    const maxDuration = config.expectedDurationMinutes * 2;
    durationMinutes = Math.max(elapsedMin, Math.min(durationMinutes, maxDuration));

    return {
      end: new Date(startMs + durationMinutes * 60_000).toISOString(),
      durationMinutes,
    };
  }

  // -------------------------------------------------------------------------
  // Chain and state helpers
  // -------------------------------------------------------------------------

  /**
   * Assess the show state based on game progress.
   */
  private assessShowState(game: ESPNGameState): ShowState {
    const config = this.watchConfig!;

    if (game.state === 'post') return 'clear'; // game over, chain is final
    if (game.state === 'pre') return 'clear'; // not started yet

    // Baseball: extra innings
    if (config.sport === 'baseball' && game.period > 9) {
      return 'watch';
    }

    // Tied game in late innings/quarters
    if (game.home.score === game.away.score) {
      const lateGame = (config.sport === 'baseball' && game.period >= 8)
        || (config.sport === 'football' && game.period >= 4)
        || (config.sport === 'basketball' && game.period >= 4)
        || (config.sport === 'hockey' && game.period >= 3);

      if (lateGame) return 'watch';
    }

    // Weather risk escalation
    if (this.lastWeather?.delayRisk === 'high') return 'risk';
    if (this.lastWeather?.delayRisk === 'moderate') return 'watch';

    return 'clear';
  }

  /**
   * Build an alert message for a show state change.
   */
  private buildLiveAlert(game: ESPNGameState, state: ShowState): string | null {
    const config = this.watchConfig!;

    if (state === 'clear') return null;

    if (state === 'watch' && config.sport === 'baseball' && game.period > 9) {
      return `Extra innings (${game.shortDetail}). Chain recomputing for ${config.crewCount} traveling crew.`;
    }

    if (state === 'watch' && game.home.score === game.away.score) {
      return `Tied game in late period (${game.shortDetail}). Potential overtime/extras.`;
    }

    if (state === 'risk' && this.lastWeather?.delayRisk === 'high') {
      return `${this.lastWeather.delayDetail}. Chain may need recomputing.`;
    }

    if (state === 'watch' && this.lastWeather?.delayRisk === 'moderate') {
      return `${this.lastWeather.delayDetail}. Monitoring conditions.`;
    }

    return `Game state: ${game.shortDetail}`;
  }

  /**
   * Compute chain level (0 = on time, higher = more delay).
   */
  private computeChainLevel(game: ESPNGameState, config: SpotterWatchConfig): number {
    if (game.state === 'pre') return 0;
    if (game.state === 'post') return 0;

    // Baseball extras
    if (config.sport === 'baseball' && game.period > 9) {
      return Math.min(game.period - 9, 3); // 1-3 based on how many extras
    }

    // Overtime potential
    if (game.home.score === game.away.score) {
      const lateGame = (config.sport === 'football' && game.period >= 4)
        || (config.sport === 'basketball' && game.period >= 4)
        || (config.sport === 'hockey' && game.period >= 3);
      if (lateGame) return 1;
    }

    // Weather delays
    if (this.lastWeather?.delayRisk === 'high') return 2;
    if (this.lastWeather?.delayRisk === 'moderate') return 1;

    return 0;
  }

  /**
   * Recompute chain times based on a new predicted end time.
   */
  private recomputeChain(
    baseChain: ChainNode[],
    predictedEnd: string,
    strikeDurationMinutes: number,
  ): ChainNode[] {
    const endMs = new Date(predictedEnd).getTime();
    const tz = this.watchConfig?.timezone ?? 'America/New_York';
    const refDate = new Date(endMs); // anchor HH:MM parsing to game day

    // Walk the chain and shift times from the predicted end
    // Duration nodes (isDuration: true) are recomputed as the gap between
    // the preceding node's revised time and a fixed reference, not shifted.
    const result: ChainNode[] = [];

    for (let i = 0; i < baseChain.length; i++) {
      const node = baseChain[i]!;

      if (node.isDuration) {
        // Duration node: recompute from the previous node's revised arrival
        // and the lobby call time embedded in the label (e.g. "Rest before 04:30 lobby")
        const prevRevised = result.length > 0 ? result[result.length - 1]! : null;
        const lobbyMatch = node.label.match(/(\d{1,2}:\d{2})/);
        if (prevRevised && lobbyMatch) {
          const prevMs = parseChainTime(prevRevised.revisedTime, tz, refDate);
          const lobbyMs = parseChainTime(lobbyMatch[1]!, tz, refDate);
          let restMs = lobbyMs - prevMs;
          if (restMs < 0) restMs += 24 * 60 * 60 * 1000; // wrap past midnight
          const restMins = Math.round(restMs / 60_000);
          const rh = Math.floor(restMins / 60);
          const rm = restMins % 60;
          const durStr = rm > 0 ? `${rh}h${rm.toString().padStart(2, '0')}m` : `${rh}h`;
          result.push({ ...node, revisedTime: durStr });
        } else {
          result.push({ ...node }); // can't compute — keep as-is
        }
        continue;
      }

      if (i === 0) {
        // First node is the game end — update its revised time
        result.push({ ...node, revisedTime: formatChainTime(endMs, tz) });
        continue;
      }

      // Subsequent nodes cascade from the end
      // Offset from the first node stays constant, revised time shifts
      const firstNode = baseChain[0];
      if (!firstNode) { result.push({ ...node }); continue; }
      const baseEnd = parseChainTime(firstNode.baseTime, tz, refDate);
      const baseOffset = parseChainTime(node.baseTime, tz, refDate) - baseEnd;
      const revisedMs = endMs + baseOffset;

      result.push({ ...node, revisedTime: formatChainTime(revisedMs, tz) });
    }

    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a chain time (HH:MM in venue-local, or ISO 8601) to UTC milliseconds.
 * Uses Intl to interpret HH:MM in the game's timezone, so it works correctly
 * regardless of the server's own timezone (e.g. UTC on Cloud Run).
 */
function parseChainTime(time: string, timezone: string, refDate?: Date): number {
  // Handle HH:MM format — interpret in the game's venue timezone
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    const h = parseInt(match[1]!, 10);
    const m = parseInt(match[2]!, 10);
    const ref = refDate ?? new Date();
    // Build a date string in the venue timezone's "today"
    const dateParts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(ref);
    const year = dateParts.find(p => p.type === 'year')!.value;
    const month = dateParts.find(p => p.type === 'month')!.value;
    const day = dateParts.find(p => p.type === 'day')!.value;
    const dateStr = `${year}-${month}-${day}`;
    // Convert venue-local HH:MM to UTC ms
    return localTimeToUtcMs(dateStr, `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`, timezone);
  }
  // Try ISO 8601
  return new Date(time).getTime();
}

/**
 * Format a UTC timestamp as HH:MM in the game's venue timezone.
 */
function formatChainTime(ms: number, timezone: string): string {
  return utcToLocalHHMM(ms, timezone);
}

// Lazy imports — tz-utils lives in the server package, but the functions are
// simple enough to inline.  We duplicate the two needed helpers here to avoid
// a cross-package dependency from agents → server.

function localTimeToUtcMs(dateStr: string, timeStr: string, timezone: string): number {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);
  const approxUtcMs = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(approxUtcMs));
  const tzH = parseInt(parts.find(p => p.type === 'hour')!.value);
  const tzM = parseInt(parts.find(p => p.type === 'minute')!.value);
  let offsetMin = (tzH * 60 + tzM) - (hour! * 60 + minute!);
  if (offsetMin > 720) offsetMin -= 1440;
  if (offsetMin < -720) offsetMin += 1440;
  return approxUtcMs - offsetMin * 60_000;
}

function utcToLocalHHMM(utcTime: string | number, timezone: string): string {
  const d = typeof utcTime === 'number' ? new Date(utcTime) : new Date(utcTime);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(d);
  return `${parts.find(p => p.type === 'hour')!.value}:${parts.find(p => p.type === 'minute')!.value}`;
}

// ---------------------------------------------------------------------------
// Gemini system prompt for end-time prediction
// ---------------------------------------------------------------------------

const PREDICTION_SYSTEM_PROMPT = `You are SPOTTER, a sports game timing analyst for a live production crew operations desk.

Your job is to predict when a live sporting event will end. You are called repeatedly during the game — your predictions drive crew travel scheduling, so consistency matters as much as accuracy.

## Sport-specific baselines
- **Baseball**: Average 9-inning game is ~3 hours. Use the minutesPerInning pace from context to extrapolate. Extra innings add ~20 min each. Blowouts may be slightly shorter (fewer pitching changes).
- **Football**: Average game is 3.5 hours. Overtime adds ~15-20 min. Close 4th-quarter games run longer (clock stoppages).
- **Basketball**: Average game is 2.5 hours. Overtime adds ~5-8 min per OT. Close games run longer (intentional fouls).
- **Hockey**: Average game is 2.5 hours. Regular-season OT is 5 min + shootout. Playoff OT is 20-min sudden-death periods.

## Weather (outdoor venues only)
- Rain delays: 30-90+ minutes
- Lightning delays: 30 min clear required before resuming
- Factor weather only when delayRisk is "moderate" or "high"

## Prediction stability
You will receive elapsedMinutes, pace metrics (e.g. minutesPerInning for baseball), and your own priorPrediction if one exists. Use the pace data as your primary signal — it reflects the actual game tempo.

**When a priorPrediction is present**: anchor to it. Only shift by more than 10 minutes if the game state materially changed — extra innings began, a rain delay started, pace changed significantly, or a blowout is accelerating the game. Small score changes within the same inning/period should NOT cause large swings.

## Output
Return a JSON object with exactly these fields:
- predictedEndTime: ISO 8601 timestamp of when you predict the game will end
- predictedDurationMinutes: total predicted game duration from actual start to predicted end, in minutes

Be conservative — overestimate slightly rather than underestimate, as crew travel depends on these predictions.`;
