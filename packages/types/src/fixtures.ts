import type { AgentName, ShowState, BoardStatus, ProvenanceLevel } from './domain.js';
import type { Show, CrewMember, ChainNode, OptionGroup } from './models.js';

export interface FixtureStep {
  timestamp: string;
  agent: AgentName;
  message: string;
  gameState?: [string, string];
  showState?: ShowState;
  chainLevel?: number;
  slackDelta?: number;
  metrics?: { risk?: number; exposed?: number };
  crewStates?: Record<string, BoardStatus>;
  provenance?: Record<string, [ProvenanceLevel, string, string]>;
  calls?: Record<string, string>;
  routes?: Record<string, { route: string; arrival: string }>;
  agentStates?: Partial<Record<AgentName, 'on' | 'hot' | 'off'>>;
  showOptions?: boolean;
  showHandoff?: boolean;
  done?: boolean;
}

export interface FixtureScenario {
  id: string;
  title: string;
  description: string;
  shows: Show[];
  crew: CrewMember[];
  chain: ChainNode[];
  offlineAgents: Record<string, string>;
  crewNote: string;
  handoffText: string;
  optionGroups: OptionGroup[];
  steps: FixtureStep[];
}
