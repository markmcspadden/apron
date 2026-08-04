export type AgentName =
  | 'SPOTTER'
  | 'TRAFFIC'
  | 'ADVANCE'
  | 'WRANGLER'
  | 'STEWARD'
  | 'FIXER'
  | 'RUNNER'
  | 'CUSTOMS';

export type AgentCapability =
  | 'read:game-feeds'
  | 'read:weather'
  | 'read:carrier-status'
  | 'read:ground-ops'
  | 'read:crew-sheets'
  | 'read:call-sheets'
  | 'read:roster'
  | 'read:constraints'
  | 'read:rule-packs'
  | 'read:timestamps'
  | 'read:inventory'
  | 'read:fare-rules'
  | 'read:policy'
  | 'read:tokenized-traveler'
  | 'read:decision-record'
  | 'read:carnet-requirements'
  | 'read:border-rules'
  | 'write:roster-state'
  | 'write:constraints'
  | 'write:rule-flags'
  | 'write:hold'
  | 'write:handoff'
  | 'write:doc-flags';

export type AgentRole = 'reader' | 'state' | 'actor';

export type ShowId = string;
export type CrewMemberId = string;

export type ProvenanceLevel =
  | 'confirmed'
  | 'sheet'
  | 'inferred'
  | 'external'
  | 'none';

export type ShowState = 'clear' | 'watch' | 'risk' | 'down';

export type CrewTier = 'T1' | 'T2';

export type BoardStatus = 'CLEAR' | 'WATCH' | 'RISK' | 'BROKEN' | 'SOLVED';

export type CrewStatus = BoardStatus;

export type SeatView = 'tmc' | 'production';
