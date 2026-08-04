import { BaseAgent } from '@apron/orchestrator';

export class CustomsAgent extends BaseAgent {
  constructor() {
    super('CUSTOMS');
  }

  async process(_input: Record<string, unknown>): Promise<void> {
    // CUSTOMS is not provisioned for domestic shows.
    // This agent wakes for Toronto, London, Mexico City, and any
    // cross-border next call — and carries the gear carnet with it.
  }
}
