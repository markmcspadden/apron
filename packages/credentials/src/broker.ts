import { randomUUID } from 'node:crypto';
import type { AgentName, Credential, CapabilityGrant, AgentCapability } from '@apron/types';
import { CAPABILITY_MATRIX } from './matrix.js';

export class CredentialBroker {
  private issued = new Map<string, Credential>();
  private showId: string;
  private offlineAgents: Set<AgentName>;

  constructor(showId: string, offlineAgents: AgentName[] = []) {
    this.showId = showId;
    this.offlineAgents = new Set(offlineAgents);
  }

  issue(agent: AgentName): Credential {
    if (this.offlineAgents.has(agent)) {
      throw new Error(
        `Agent ${agent} is not provisioned for show ${this.showId}. ` +
        `Offline agents do not receive credentials.`
      );
    }

    const grant = CAPABILITY_MATRIX[agent];
    if (!grant) {
      throw new Error(`Unknown agent: ${agent}`);
    }

    const now = new Date();
    const credential: Credential = {
      agent,
      showId: this.showId,
      grant,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    };

    const id = randomUUID();
    this.issued.set(id, credential);
    return credential;
  }

  check(credential: Credential, capability: AgentCapability): boolean {
    return credential.grant.capabilities.includes(capability);
  }

  checkNeverReceives(credential: Credential, dataType: string): boolean {
    return credential.grant.neverReceives.includes(dataType);
  }

  revoke(agent: AgentName): void {
    for (const [id, cred] of this.issued) {
      if (cred.agent === agent) {
        this.issued.delete(id);
      }
    }
  }

  getGrant(agent: AgentName): CapabilityGrant {
    return CAPABILITY_MATRIX[agent]!;
  }

  isProvisioned(agent: AgentName): boolean {
    return !this.offlineAgents.has(agent);
  }

  getProvisionedAgents(): AgentName[] {
    const all: AgentName[] = [
      'SPOTTER', 'TRAFFIC', 'ADVANCE', 'WRANGLER',
      'STEWARD', 'FIXER', 'RUNNER', 'CUSTOMS',
    ];
    return all.filter(a => !this.offlineAgents.has(a));
  }
}
