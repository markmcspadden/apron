import type { AgentName, AgentEvent, Credential } from '@apron/types';
import type { MessageBus } from './bus.js';
import { randomUUID } from 'node:crypto';

export interface AgentContext {
  bus: MessageBus;
  credential: Credential;
  showId: string;
}

export abstract class BaseAgent {
  readonly name: AgentName;
  protected ctx!: AgentContext;

  constructor(name: AgentName) {
    this.name = name;
  }

  bind(ctx: AgentContext): void {
    this.ctx = ctx;
  }

  protected emit(
    event: Omit<AgentEvent, 'id' | 'timestamp' | 'showId' | 'agent'>,
  ): void {
    const full = {
      ...event,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      showId: this.ctx.showId,
      agent: this.name,
    } as AgentEvent;
    this.ctx.bus.publish(full);
  }

  abstract process(input: Record<string, unknown>): Promise<void>;
}
