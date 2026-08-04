import { BaseAgent } from '@apron/orchestrator';
import type { FixtureStep } from '@apron/types';

export class StewardAgent extends BaseAgent {
  constructor() {
    super('STEWARD');
  }

  async process(input: Record<string, unknown>): Promise<void> {
    const step = input['step'] as FixtureStep;

    if (step.metrics) {
      this.emit({
        type: 'metrics',
        message: step.message,
        risk: step.metrics.risk ?? 0,
        exposed: step.metrics.exposed ?? 0,
      });
    }

    if (step.crewStates) {
      this.emit({
        type: 'crew-state',
        message: step.message,
        updates: step.crewStates,
      });
    }

    if (step.agentStates) {
      this.emit({
        type: 'agent-status',
        message: step.message,
        agentStates: step.agentStates,
      });
    }

    if (step.showState) {
      this.emit({
        type: 'show-state' as const,
        message: step.message,
        state: step.showState,
        alert: step.showState === 'down'
          ? '4 call times exposed. TD, A1, DIR and Lead EVS breach mandatory rest for a 14:00 CT call in Kansas City.'
          : null,
      });
    }
  }
}
