import type { AgentEvent } from '@apron/types';

export interface AuditEntry {
  sequence: number;
  receivedAt: string;
  event: AgentEvent;
}

export class AuditLog {
  private entries: AuditEntry[] = [];
  private seq = 0;

  append(event: AgentEvent): AuditEntry {
    const entry: AuditEntry = {
      sequence: this.seq++,
      receivedAt: new Date().toISOString(),
      event,
    };
    this.entries.push(entry);
    return entry;
  }

  getAll(): readonly AuditEntry[] {
    return this.entries;
  }

  count(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
    this.seq = 0;
  }

  getByAgent(agent: string): AuditEntry[] {
    return this.entries.filter(e => e.event.agent === agent);
  }

  getSince(timestamp: string): AuditEntry[] {
    return this.entries.filter(e => e.receivedAt >= timestamp);
  }
}
