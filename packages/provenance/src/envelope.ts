import type { ProvenanceEnvelope, ProvenanceSource, ConfidenceLevel } from '@apron/types';
import type { AgentName, ProvenanceLevel } from '@apron/types';
import { randomUUID } from 'node:crypto';

export function createEnvelope(opts: {
  agent: AgentName;
  sourceType: string;
  sourceId: string;
  confidence: ConfidenceLevel;
  provenanceLevel: ProvenanceLevel;
  visibility: AgentName[];
  brokerable?: boolean;
  humanVerified?: boolean;
  expiresAt?: string;
}): ProvenanceEnvelope {
  const source: ProvenanceSource = {
    agent: opts.agent,
    sourceType: opts.sourceType,
    sourceId: opts.sourceId,
    timestamp: new Date().toISOString(),
  };

  return {
    factId: randomUUID(),
    source,
    confidence: opts.confidence,
    provenanceLevel: opts.provenanceLevel,
    visibility: opts.visibility,
    brokerable: opts.brokerable ?? false,
    humanVerified: opts.humanVerified ?? false,
    expiresAt: opts.expiresAt,
  };
}

export function validateEnvelope(envelope: ProvenanceEnvelope): string[] {
  const errors: string[] = [];

  if (!envelope.factId) errors.push('Missing factId');
  if (!envelope.source?.agent) errors.push('Missing source agent');
  if (!envelope.source?.timestamp) errors.push('Missing source timestamp');
  if (!envelope.confidence) errors.push('Missing confidence level');
  if (!envelope.provenanceLevel) errors.push('Missing provenance level');
  if (!Array.isArray(envelope.visibility)) errors.push('Visibility must be an array');

  return errors;
}

export function isActionable(envelope: ProvenanceEnvelope): boolean {
  if (envelope.provenanceLevel === 'inferred') return false;
  if (envelope.provenanceLevel === 'none') return false;
  if (envelope.confidence === 'low' || envelope.confidence === 'inferred') return false;
  return true;
}
