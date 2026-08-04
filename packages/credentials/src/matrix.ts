import type { CapabilityMatrix } from '@apron/types';

export const CAPABILITY_MATRIX: CapabilityMatrix = {
  SPOTTER: {
    agent: 'SPOTTER',
    capabilities: ['read:game-feeds', 'read:weather'],
    role: 'reader',
    neverReceives: ['crew-identity', 'pnr', 'personal-data'],
  },
  TRAFFIC: {
    agent: 'TRAFFIC',
    capabilities: ['read:carrier-status', 'read:ground-ops'],
    role: 'reader',
    neverReceives: ['crew-identity', 'next-calls', 'fare-data'],
  },
  ADVANCE: {
    agent: 'ADVANCE',
    capabilities: ['read:crew-sheets', 'read:call-sheets', 'read:roster', 'write:roster-state'],
    role: 'state',
    neverReceives: ['payment-instruments', 'fare-detail', 'hr-records'],
  },
  WRANGLER: {
    agent: 'WRANGLER',
    capabilities: ['read:constraints', 'write:constraints'],
    role: 'state',
    neverReceives: ['undisclosed-next-call', 'third-party-call-sheets'],
  },
  STEWARD: {
    agent: 'STEWARD',
    capabilities: ['read:rule-packs', 'read:timestamps', 'write:rule-flags'],
    role: 'state',
    neverReceives: ['contact-info', 'payment', 'personnel-files'],
  },
  FIXER: {
    agent: 'FIXER',
    capabilities: ['read:inventory', 'read:fare-rules', 'read:policy', 'read:tokenized-traveler', 'write:hold'],
    role: 'actor',
    neverReceives: ['names', 'contact-details', 'payment-instruments'],
  },
  RUNNER: {
    agent: 'RUNNER',
    capabilities: ['read:decision-record', 'write:handoff'],
    role: 'actor',
    neverReceives: ['outbound-channel-to-crew'],
  },
  CUSTOMS: {
    agent: 'CUSTOMS',
    capabilities: ['read:carnet-requirements', 'read:border-rules', 'write:doc-flags'],
    role: 'state',
    neverReceives: ['fare-data', 'payment', 'financial-records'],
  },
};
