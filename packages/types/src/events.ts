import type { AgentName, ShowState, BoardStatus, ProvenanceLevel, ShowId } from './domain.js';
import type { OptionGroup, ChainNode } from './models.js';

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
  | ComplianceUpdate;

export interface BoardEvent {
  type: 'agent-event';
  event: AgentEvent;
}
