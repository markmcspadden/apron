import type { AgentName, SeatView } from '@apron/types';

interface VisibilityRule {
  agents: AgentName[];
  seats: SeatView[];
}

export const VISIBILITY_RULES: Record<string, VisibilityRule> = {
  'game-state': {
    agents: ['SPOTTER', 'ADVANCE', 'STEWARD', 'FIXER', 'RUNNER'],
    seats: ['tmc', 'production'],
  },
  'carrier-status': {
    agents: ['TRAFFIC', 'FIXER', 'RUNNER'],
    seats: ['tmc'],
  },
  'crew-identity': {
    agents: ['ADVANCE', 'WRANGLER', 'RUNNER'],
    seats: ['tmc'],
  },
  'external-call': {
    agents: ['ADVANCE', 'WRANGLER'],
    seats: ['tmc'],
  },
  'external-call-disclosed': {
    agents: ['ADVANCE', 'WRANGLER', 'STEWARD', 'FIXER', 'RUNNER'],
    seats: ['tmc', 'production'],
  },
  'fare-data': {
    agents: ['FIXER'],
    seats: ['tmc'],
  },
  'payment-instruments': {
    agents: [],
    seats: ['tmc'],
  },
  'rule-flags': {
    agents: ['STEWARD', 'FIXER', 'RUNNER'],
    seats: ['tmc', 'production'],
  },
  'tokenized-traveler': {
    agents: ['FIXER'],
    seats: ['tmc'],
  },
};
