import type { AgentName, Credential } from '@apron/types';
import { CredentialBroker } from '@apron/credentials';
import { MessageBus } from './bus.js';
import type { BaseAgent, AgentContext } from './agent.js';

export class AgentRuntime {
  private agents = new Map<AgentName, BaseAgent>();
  private broker: CredentialBroker;
  private bus: MessageBus;
  private showId: string;

  constructor(showId: string, bus: MessageBus, broker: CredentialBroker) {
    this.showId = showId;
    this.bus = bus;
    this.broker = broker;
  }

  register(agent: BaseAgent): void {
    if (!this.broker.isProvisioned(agent.name)) {
      console.log(`[runtime] ${agent.name} not provisioned for ${this.showId}, skipping`);
      return;
    }

    const credential = this.broker.issue(agent.name);
    const ctx: AgentContext = {
      bus: this.bus,
      credential,
      showId: this.showId,
    };

    agent.bind(ctx);
    this.agents.set(agent.name, agent);
    console.log(`[runtime] ${agent.name} registered with ${credential.grant.capabilities.length} capabilities`);
  }

  getAgent(name: AgentName): BaseAgent | undefined {
    return this.agents.get(name);
  }

  getProvisionedAgents(): AgentName[] {
    return [...this.agents.keys()];
  }

  getBus(): MessageBus {
    return this.bus;
  }

  async dispatch(agentName: AgentName, input: Record<string, unknown>): Promise<void> {
    const agent = this.agents.get(agentName);
    if (!agent) {
      throw new Error(`Agent ${agentName} is not registered`);
    }
    await agent.process(input);
  }
}
