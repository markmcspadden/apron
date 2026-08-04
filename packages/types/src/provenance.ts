import type { AgentName, ProvenanceLevel } from './domain.js';

export type ConfidenceLevel = 'confirmed' | 'high' | 'medium' | 'low' | 'inferred';

export interface ProvenanceSource {
  agent: AgentName;
  sourceType: string;
  sourceId: string;
  timestamp: string;
}

export interface ProvenanceEnvelope {
  factId: string;
  source: ProvenanceSource;
  confidence: ConfidenceLevel;
  provenanceLevel: ProvenanceLevel;
  visibility: AgentName[];
  brokerable: boolean;
  humanVerified: boolean;
  expiresAt?: string;
}
