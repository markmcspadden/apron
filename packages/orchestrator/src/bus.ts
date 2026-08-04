import { EventEmitter } from 'node:events';
import type { AgentEvent } from '@apron/types';

export type BusListener = (event: AgentEvent) => void | Promise<void>;

export class MessageBus {
  private emitter = new EventEmitter();
  private log: AgentEvent[] = [];

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  publish(event: AgentEvent): void {
    this.log.push(event);
    this.emitter.emit('event', event);
    this.emitter.emit(`event:${event.type}`, event);
    this.emitter.emit(`agent:${event.agent}`, event);
  }

  subscribe(listener: BusListener): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  subscribeToType(type: AgentEvent['type'], listener: BusListener): () => void {
    this.emitter.on(`event:${type}`, listener);
    return () => this.emitter.off(`event:${type}`, listener);
  }

  subscribeToAgent(agent: string, listener: BusListener): () => void {
    this.emitter.on(`agent:${agent}`, listener);
    return () => this.emitter.off(`agent:${agent}`, listener);
  }

  getLog(): readonly AgentEvent[] {
    return this.log;
  }

  clear(): void {
    this.log = [];
  }
}
