/**
 * TRAFFIC agent — monitors flight status for crew travel routing.
 *
 * Two modes:
 *   1. Fixture replay (process) — plays back scripted fixture steps
 *   2. Live monitoring (startWatching/stopWatching) — polls AviationStack for
 *      flight status updates on crew routing, emits delay/cancellation events
 *
 * Security: TRAFFIC is a read-only agent. Per agent-separation.md, it reads
 * carrier status, ground ops, and airport conditions. It NEVER receives crew
 * identity, next calls, or fare data. The server provides only anonymized
 * flight references (carrier + number + date + airports).
 */

import { BaseAgent } from '@apron/orchestrator';
import type { FixtureStep, BoardStatus } from '@apron/types';
import type { AviationStackClient, FlightStatusUpdate, FlightStatusValue } from '@apron/integration-aviationstack';

// Re-export flight schedule utilities for server-side use
export { findFlights, findBestFlight, findConnectingFlights, hasDirectRoute, getKnownAirports } from './flight-schedule.js';
export type { ScheduledFlight } from './flight-schedule.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** How often to poll flight status (ms) — 3 minutes. */
const FLIGHT_POLL_INTERVAL = 3 * 60 * 1000;

/** How often the heartbeat re-emits a summary (ms) — 30 minutes. */
const HEARTBEAT_INTERVAL = 30 * 60 * 1000;

/** Max log entries to keep in the ring buffer. */
const MAX_LOG_ENTRIES = 200;

/** Delay threshold for alerts (minutes). */
const DELAY_ALERT_THRESHOLD = 30;

/** Delay threshold for escalation (minutes). */
const DELAY_ESCALATION_THRESHOLD = 60;

// ---------------------------------------------------------------------------
// Log entry — structured record of everything the TRAFFIC agent does
// ---------------------------------------------------------------------------

export type TrafficLogLevel = 'info' | 'flight' | 'delay' | 'cancel' | 'alert' | 'error';

export interface TrafficLogEntry {
  timestamp: string;
  level: TrafficLogLevel;
  message: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Status snapshot — full picture of a TRAFFIC instance
// ---------------------------------------------------------------------------

export interface TrafficStatus {
  watching: boolean;
  startedAt: string | null;
  config: {
    showId: string;
    flightCount: number;
    apiEnabled: boolean;
  } | null;
  /** Summary of tracked flights by status. */
  flightSummary: {
    total: number;
    onTime: number;
    delayed: number;
    cancelled: number;
    landed: number;
    active: number;
  };
  /** Individual flight statuses (anonymized — no crew identity). */
  flights: FlightWatch[];
  log: TrafficLogEntry[];
  logTotal: number;
}

// ---------------------------------------------------------------------------
// Watch config — what the TRAFFIC agent needs to monitor flights
// ---------------------------------------------------------------------------

/**
 * A flight to monitor. Contains ONLY carrier/flight information.
 * No crew identity, no next call details, no fare data.
 */
export interface MonitoredFlight {
  /** Flight IATA code (e.g. "DL1140"). */
  flightIata: string;
  /** Carrier IATA (e.g. "DL"). */
  carrier: string;
  /** Flight number (e.g. "1140"). */
  flightNumber: string;
  /** Date (YYYY-MM-DD). */
  date: string;
  /** Departure airport IATA. */
  depAirport: string;
  /** Arrival airport IATA. */
  arrAirport: string;
  /** Scheduled departure HH:MM (local). */
  scheduledDep: string;
  /** Scheduled arrival HH:MM (local). */
  scheduledArr: string;
}

export interface TrafficWatchConfig {
  /** Game/show ID. */
  showId: string;
  /** Flights to monitor — anonymized, no crew data. */
  flights: MonitoredFlight[];
  /** AviationStack client (reads API key from env). */
  aviationStack?: AviationStackClient;
}

// ---------------------------------------------------------------------------
// Internal flight tracking state
// ---------------------------------------------------------------------------

interface FlightWatch {
  /** Flight IATA code. */
  flightIata: string;
  /** Route display (e.g. "CLE→DFW"). */
  route: string;
  /** Current status. */
  status: FlightStatusValue;
  /** Previous status (for change detection). */
  previousStatus: FlightStatusValue | null;
  /** Departure delay in minutes. */
  depDelay: number;
  /** Arrival delay in minutes. */
  arrDelay: number;
  /** Scheduled departure HH:MM. */
  scheduledDep: string;
  /** Current effective departure HH:MM. */
  effectiveDep: string;
  /** Scheduled arrival HH:MM. */
  scheduledArr: string;
  /** Current effective arrival HH:MM. */
  effectiveArr: string;
  /** Gate info. */
  depGate: string | null;
  arrGate: string | null;
  /** Whether an alert has been raised for this flight. */
  alerted: boolean;
  /** Last API update timestamp. */
  lastUpdated: string | null;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class TrafficAgent extends BaseAgent {
  private watchConfig: TrafficWatchConfig | null = null;
  private watchStartedAt: string | null = null;
  private flightStates = new Map<string, FlightWatch>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private logBuffer: TrafficLogEntry[] = [];
  private logTotal = 0;

  constructor() {
    super('TRAFFIC');
  }

  // -----------------------------------------------------------------------
  // Live monitoring lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start monitoring flights for a live game.
   *
   * The server provides a list of flights (carrier + number + date + airports).
   * TRAFFIC tracks their status and emits events on delays/cancellations.
   * No crew identity is ever received or stored.
   */
  startWatching(config: TrafficWatchConfig): void {
    this.watchConfig = config;
    this.watchStartedAt = new Date().toISOString();
    this.flightStates.clear();
    this.logBuffer = [];
    this.logTotal = 0;

    // Initialize flight watch state for each flight
    for (const flight of config.flights) {
      this.flightStates.set(flight.flightIata, {
        flightIata: flight.flightIata,
        route: `${flight.depAirport}→${flight.arrAirport}`,
        status: 'scheduled',
        previousStatus: null,
        depDelay: 0,
        arrDelay: 0,
        scheduledDep: flight.scheduledDep,
        effectiveDep: flight.scheduledDep,
        scheduledArr: flight.scheduledArr,
        effectiveArr: flight.scheduledArr,
        depGate: null,
        arrGate: null,
        alerted: false,
        lastUpdated: null,
      });
    }

    this.log('info', `Flight monitoring started — tracking ${config.flights.length} flights`);

    this.emit({
      type: 'agent-status',
      message: `TRAFFIC monitoring started — ${config.flights.length} flights`,
      agentStates: { TRAFFIC: 'on' },
    });

    // Emit initial flight summary
    this.emitFlightSummary();

    // Start polling if API is available
    if (config.aviationStack?.isEnabled()) {
      this.log('info', 'AviationStack API connected — live flight data enabled');
      // Run first poll immediately
      void this.pollFlights();
      // Then poll on interval
      this.pollTimer = setInterval(() => {
        void this.pollFlights();
      }, FLIGHT_POLL_INTERVAL);
    } else {
      this.log('info', 'No flight API configured — monitoring from schedule data only');
    }

    // Heartbeat — re-emit flight summary every 30 minutes as a backstop
    this.heartbeatTimer = setInterval(() => {
      this.log('info', 'Heartbeat — flight status check');
      this.emitFlightSummary();
    }, HEARTBEAT_INTERVAL);
  }

  /**
   * Stop monitoring and clean up.
   */
  stopWatching(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.watchConfig) {
      this.log('info', 'Flight monitoring stopped');
      this.emit({
        type: 'agent-status',
        message: 'TRAFFIC monitoring stopped',
        agentStates: { TRAFFIC: 'done' },
      });
    }
    this.watchConfig = null;
  }

  /**
   * Get the current status snapshot.
   */
  getStatus(): TrafficStatus {
    if (!this.watchConfig) {
      return {
        watching: false,
        startedAt: null,
        config: null,
        flightSummary: { total: 0, onTime: 0, delayed: 0, cancelled: 0, landed: 0, active: 0 },
        flights: [],
        log: this.logBuffer.slice(-30),
        logTotal: this.logTotal,
      };
    }

    const flights = [...this.flightStates.values()];
    return {
      watching: true,
      startedAt: this.watchStartedAt,
      config: {
        showId: this.watchConfig.showId,
        flightCount: this.watchConfig.flights.length,
        apiEnabled: this.watchConfig.aviationStack?.isEnabled() ?? false,
      },
      flightSummary: this.computeSummary(),
      flights,
      log: this.logBuffer.slice(-30),
      logTotal: this.logTotal,
    };
  }

  /**
   * Get log entries.
   */
  getLog(n?: number): TrafficLogEntry[] {
    return this.logBuffer.slice(-(n ?? MAX_LOG_ENTRIES));
  }

  // -----------------------------------------------------------------------
  // Flight polling
  // -----------------------------------------------------------------------

  private async pollFlights(): Promise<void> {
    if (!this.watchConfig?.aviationStack) return;

    const client = this.watchConfig.aviationStack;
    const flights = this.watchConfig.flights;

    this.log('info', `Polling ${flights.length} flights...`);

    let updatedCount = 0;
    let errorCount = 0;

    for (const flight of flights) {
      try {
        const status = await client.getFlightStatus(flight.flightIata, flight.date);
        if (status) {
          this.applyStatusUpdate(flight.flightIata, status);
          updatedCount++;
        }
      } catch (err) {
        errorCount++;
        const msg = err instanceof Error ? err.message : String(err);
        this.log('error', `Failed to poll ${flight.flightIata}: ${msg}`);
      }
    }

    if (errorCount > 0) {
      this.log('info', `Poll complete: ${updatedCount} updated, ${errorCount} errors`);
    } else {
      this.log('info', `Poll complete: ${updatedCount} flights updated`);
    }

    // Emit updated summary after each poll cycle
    this.emitFlightSummary();
  }

  private applyStatusUpdate(flightIata: string, update: FlightStatusUpdate): void {
    const state = this.flightStates.get(flightIata);
    if (!state) return;

    const prevStatus = state.status;
    const prevDepDelay = state.depDelay;

    // Update the flight state
    state.previousStatus = prevStatus;
    state.status = update.status;
    state.depDelay = update.depDelay ?? 0;
    state.arrDelay = update.arrDelay ?? 0;
    state.effectiveDep = extractTime(update.effectiveDep) ?? state.scheduledDep;
    state.effectiveArr = extractTime(update.effectiveArr) ?? state.scheduledArr;
    state.depGate = update.depGate;
    state.arrGate = update.arrGate;
    state.lastUpdated = update.lastUpdated;

    // Detect and report changes
    if (prevStatus !== state.status) {
      this.onStatusChange(state, prevStatus);
    } else if (state.depDelay !== prevDepDelay && state.depDelay >= DELAY_ALERT_THRESHOLD) {
      this.onDelayChange(state);
    }
  }

  private onStatusChange(state: FlightWatch, prevStatus: FlightStatusValue): void {
    const flight = `${state.flightIata} ${state.route}`;

    switch (state.status) {
      case 'cancelled': {
        this.log('cancel', `✕ CANCELLED: ${flight}`);
        this.emit({
          type: 'show-state',
          message: `Flight ${state.flightIata} ${state.route} cancelled`,
          state: 'risk',
          alert: `Flight ${state.flightIata} cancelled — crew routing broken`,
        });
        this.emitFlightEvent('cancelled', state);
        break;
      }
      case 'diverted': {
        this.log('alert', `⚠ DIVERTED: ${flight}`);
        this.emit({
          type: 'show-state',
          message: `Flight ${state.flightIata} ${state.route} diverted`,
          state: 'risk',
          alert: `Flight ${state.flightIata} diverted — crew arrival uncertain`,
        });
        this.emitFlightEvent('diverted', state);
        break;
      }
      case 'active': {
        const delayNote = state.depDelay > 0 ? ` (${state.depDelay}m late)` : '';
        this.log('flight', `✈ DEPARTED: ${flight}${delayNote}`);
        this.emitFlightEvent('departed', state);
        break;
      }
      case 'landed': {
        const delayNote = state.arrDelay > 0 ? ` (${state.arrDelay}m late)` : ' (on time)';
        this.log('flight', `✓ LANDED: ${flight}${delayNote}`);
        this.emitFlightEvent('landed', state);
        break;
      }
      default: {
        this.log('flight', `Status: ${flight} → ${state.status}`);
      }
    }
  }

  private onDelayChange(state: FlightWatch): void {
    const flight = `${state.flightIata} ${state.route}`;

    if (state.depDelay >= DELAY_ESCALATION_THRESHOLD && !state.alerted) {
      state.alerted = true;
      this.log('delay', `⚠ MAJOR DELAY: ${flight} — ${state.depDelay}m, now dep ${state.effectiveDep}`);
      this.emit({
        type: 'show-state',
        message: `Flight ${state.flightIata} delayed ${state.depDelay}m`,
        state: 'watch',
        alert: `${state.flightIata} ${state.route} delayed ${state.depDelay}m — crew arrival at risk`,
      });
      this.emitFlightEvent('major-delay', state);
    } else if (state.depDelay >= DELAY_ALERT_THRESHOLD) {
      this.log('delay', `⏱ Delay: ${flight} — ${state.depDelay}m, now dep ${state.effectiveDep}`);
      this.emitFlightEvent('delay', state);
    }
  }

  // -----------------------------------------------------------------------
  // Event emission
  // -----------------------------------------------------------------------

  private emitFlightSummary(): void {
    const summary = this.computeSummary();
    this.emit({
      type: 'metrics',
      message: `Flights: ${summary.onTime} on time, ${summary.delayed} delayed, ${summary.cancelled} cancelled`,
      risk: summary.delayed + summary.cancelled,
      exposed: summary.cancelled,
    });
  }

  private emitFlightEvent(
    event: 'departed' | 'landed' | 'delay' | 'major-delay' | 'cancelled' | 'diverted',
    state: FlightWatch,
  ): void {
    // Emit as a crew-state update so the board can update crew routing status.
    // The key is the flight IATA — the server maps this back to affected crew.
    const boardStatus: BoardStatus = event === 'cancelled' || event === 'diverted'
      ? 'BROKEN'
      : event === 'major-delay'
        ? 'RISK'
        : event === 'delay'
          ? 'WATCH'
          : 'CLEAR';

    this.emit({
      type: 'crew-state',
      message: `${state.flightIata} ${state.route}: ${event}${state.depDelay > 0 ? ` (+${state.depDelay}m)` : ''}`,
      updates: { [`flight:${state.flightIata}`]: boardStatus },
    });
  }

  private computeSummary() {
    const flights = [...this.flightStates.values()];
    return {
      total: flights.length,
      onTime: flights.filter(f => f.status === 'scheduled' && f.depDelay < DELAY_ALERT_THRESHOLD).length,
      delayed: flights.filter(f => f.depDelay >= DELAY_ALERT_THRESHOLD && f.status !== 'cancelled' && f.status !== 'landed').length,
      cancelled: flights.filter(f => f.status === 'cancelled' || f.status === 'diverted').length,
      landed: flights.filter(f => f.status === 'landed').length,
      active: flights.filter(f => f.status === 'active').length,
    };
  }

  // -----------------------------------------------------------------------
  // Logging
  // -----------------------------------------------------------------------

  private log(level: TrafficLogLevel, message: string, data?: Record<string, unknown>): void {
    const entry: TrafficLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
    };
    this.logBuffer.push(entry);
    this.logTotal++;

    // Trim ring buffer
    if (this.logBuffer.length > MAX_LOG_ENTRIES) {
      this.logBuffer = this.logBuffer.slice(-MAX_LOG_ENTRIES);
    }

    console.log(`[traffic] ${message}`);
  }

  // -----------------------------------------------------------------------
  // Fixture processing (existing behavior)
  // -----------------------------------------------------------------------

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

    if (step.showState) {
      this.emit({
        type: 'show-state' as const,
        message: step.message,
        state: step.showState,
        alert: step.showState === 'risk'
          ? '14 crew at risk. Projected wrap 01:05 · 06:05 departures no longer reachable with rest.'
          : null,
      });
    }

    if (step.crewStates) {
      this.emit({
        type: 'crew-state',
        message: step.message,
        updates: step.crewStates,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract HH:MM from an ISO datetime string. */
function extractTime(iso: string): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}`;
  } catch {
    return null;
  }
}
