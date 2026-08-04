import { BaseAgent } from '@apron/orchestrator';
import type { FixtureStep } from '@apron/types';

export class WranglerAgent extends BaseAgent {
  constructor() {
    super('WRANGLER');
  }

  async process(input: Record<string, unknown>): Promise<void> {
    const step = input['step'] as FixtureStep;

    if (step.provenance) {
      for (const [crewName, prov] of Object.entries(step.provenance)) {
        this.emit({
          type: 'provenance',
          message: step.message,
          crewName,
          provenance: prov,
          nextCall: step.calls?.[crewName],
        });
      }
    }

    if (step.agentStates) {
      this.emit({
        type: 'agent-status',
        message: step.message,
        agentStates: step.agentStates,
      });
    }
  }
}
