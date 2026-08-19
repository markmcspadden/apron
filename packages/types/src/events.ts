import type { AgentName, ShowState, BoardStatus, ProvenanceLevel, ShowId } from './domain.js';
import type { OptionGroup, ChainNode } from './models.js';
import type { NextCallType } from './crew-itinerary.js';

interface BaseEvent {
  id: string;
  timestamp: string;
  showId: ShowId;
  agent: AgentName;
  message: string;
}

export interface GameStateUpdate extends BaseEvent {
  type: 'game-state';
  gameState: string;
  live: boolean;
}

export interface ChainUpdate extends BaseEvent {
  type: 'chain-update';
  level: number;
  nodes: ChainNode[];
}

export interface MetricsUpdate extends BaseEvent {
  type: 'metrics';
  risk: number;
  exposed: number;
}

export interface CrewStateUpdate extends BaseEvent {
  type: 'crew-state';
  updates: Record<string, BoardStatus>;
}

export interface ProvenanceUpdate extends BaseEvent {
  type: 'provenance';
  crewName: string;
  provenance: [ProvenanceLevel, string, string];
  nextCall?: string;
}

export interface RouteUpdate extends BaseEvent {
  type: 'route-update';
  group: string;
  route: string;
  arrival: string;
}

export interface OptionsGenerated extends BaseEvent {
  type: 'options';
  groups: OptionGroup[];
}

export interface HandoffComposed extends BaseEvent {
  type: 'handoff';
  instruction: string;
}

export interface ShowClosed extends BaseEvent {
  type: 'show-closed';
}

export interface AgentStatusChange extends BaseEvent {
  type: 'agent-status';
  agentStates: Partial<Record<AgentName, 'on' | 'hot' | 'off' | 'done'>>;
}

export interface ShowStateChange extends BaseEvent {
  type: 'show-state';
  state: ShowState;
  alert: string | null;
}

/** Per-crew compliance status from STEWARD proactive monitoring. */
export interface CrewComplianceEntry {
  name: string;
  position: string;
  turnaround: {
    status: 'violation' | 'at_risk' | 'clear' | 'unknown';
    gapHours: number | null;
    minimumHours: number;
    nextCallTime: string | null;
  };
  overtime: {
    triggered: boolean;
    hoursWorked: number;
    regularDayHours: number;
    otCost: number;
  };
  meals: {
    perDiemTriggered: boolean;
    mealAfter11h: boolean;
    mealAfter15h: boolean;
    incrementalCost: number;
  };
  penalties: {
    turnaroundPenalty: number;
    scheduleChangePenalty: number;
    totalPenalty: number;
  };
}

/** STEWARD compliance snapshot — emitted when game timing changes. */
export interface ComplianceUpdate extends BaseEvent {
  type: 'compliance-update';
  /** What triggered this evaluation */
  trigger: 'chain-update' | 'crew-rebooked' | 'game-started' | 'game-ended';
  /** Per-crew compliance assessments */
  crew: CrewComplianceEntry[];
  /** Aggregate cost exposure */
  totals: {
    turnaroundPenalties: number;
    overtimeCost: number;
    mealCost: number;
    scheduleChangePenalties: number;
    totalExposure: number;
  };
  /** Tonight's rest window — hotel arrival to lobby call */
  restCompression: {
    hotelArrival: string | null;
    lobbyCall: string | null;
    restHours: number | null;
    minimumRest: number;
    compressed: boolean;
  };
  /** Summary for the board alert bar */
  summary: string;
}

// ---------------------------------------------------------------------------
// ADVANCE — roster state with seat-aware disclosure
// ---------------------------------------------------------------------------

/** Per-crew next-call entry with separate TMC and production views. */
export interface RosterEntry {
  crewId: string;
  name: string;
  position: string;
  keyPosition: boolean;
  tier: 'T1' | 'T2';
  homeAirport: string;

  /** Provenance level of the next-call fact. */
  provenanceLevel: ProvenanceLevel;
  /** Whether FIXER/STEWARD may act on this (false for inferred/none). */
  actionable: boolean;

  /** TMC desk view — always sees full detail. */
  tmc: {
    nextCallType: NextCallType;
    destination: string;
    production: string | null;
    network: string | null;
    callTime: string | null;
    source: string;
    brokerable: boolean;
  };

  /**
   * Production seat view — external calls that are not brokerable are redacted.
   * "Redaction is enforced at the data layer, not the display layer."
   */
  production: {
    nextCallType: NextCallType;
    destination: string | null;
    production: string | null;
    callTime: string | null;
    redacted: boolean;
  };
}

/** ADVANCE roster snapshot — emitted on crew change or heartbeat. */
export interface RosterUpdate extends BaseEvent {
  type: 'roster-update';
  /** What triggered this scan. */
  trigger: 'game-started' | 'heartbeat' | 'crew-changed';
  /** Per-crew entries with seat-aware views. */
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
}

export type AgentEvent =
  | GameStateUpdate
  | ChainUpdate
  | MetricsUpdate
  | CrewStateUpdate
  | ProvenanceUpdate
  | RouteUpdate
  | OptionsGenerated
  | HandoffComposed
  | ShowClosed
  | AgentStatusChange
  | ShowStateChange
  | ComplianceUpdate
  | RosterUpdate;

export interface BoardEvent {
  type: 'agent-event';
  event: AgentEvent;
}
