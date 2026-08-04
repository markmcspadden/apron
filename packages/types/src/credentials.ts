import type { AgentName, AgentCapability, AgentRole } from './domain.js';

export interface CapabilityGrant {
  agent: AgentName;
  capabilities: AgentCapability[];
  role: AgentRole;
  neverReceives: string[];
}

export interface Credential {
  agent: AgentName;
  showId: string;
  grant: CapabilityGrant;
  issuedAt: string;
  expiresAt: string;
}

export type CapabilityMatrix = Record<AgentName, CapabilityGrant>;
