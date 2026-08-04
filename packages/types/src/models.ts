import type {
  ShowId,
  CrewMemberId,
  CrewTier,
  ShowState,
  BoardStatus,
  ProvenanceLevel,
} from './domain.js';

export interface Show {
  id: ShowId;
  net: string;
  title: string;
  venue: string;
  gameState: string;
  live: boolean;
  crewCount: number;
  state: ShowState;
  alert: string | null;
  hero: boolean;
}

export interface CrewMember {
  id: CrewMemberId;
  position: string;
  keyPosition: boolean;
  name: string;
  externalCall: boolean;
  disclosed: boolean;
  provenance: [ProvenanceLevel, string, string];
  homeMarket: string;
  tier: CrewTier;
  nextCall: string;
  routing: string;
  arrival: string;
  slackMinutes: number;
}

export interface ChainNode {
  label: string;
  baseTime: string;
  revisedTime: string;
  midTime?: string;
  isDuration?: boolean;
}

export interface TravelOption {
  route: string;
  rationale: string;
  verdict: string;
  verdictPass: boolean;
  costDelta: string;
  totalCost: string;
  recommended: boolean;
}

export interface OptionGroup {
  crewNames: string;
  constraint: string;
  options: TravelOption[];
}

export interface Roster {
  showId: ShowId;
  crew: CrewMember[];
}

export interface ShowConfig {
  showId: ShowId;
  domestic: boolean;
  rulePack: string;
  agents: string[];
}
