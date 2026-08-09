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
  | ShowStateChange;

export interface BoardEvent {
  type: 'agent-event';
  event: AgentEvent;
}
