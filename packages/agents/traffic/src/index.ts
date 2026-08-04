import { BaseAgent } from '@apron/orchestrator';
import type { FixtureStep } from '@apron/types';

export class TrafficAgent extends BaseAgent {
  constructor() {
    super('TRAFFIC');
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

    if (step.showState) {
      this.emit({
        type: 'show-state' as const,
        message: step.message,
        state: step.showState,
        alert: step.showState === 'risk'
          ? '14 crew at risk. Projected wrap 01:05 · 06:05 departures no longer reachable with rest.'
          : null,
      });
    }

    if (step.crewStates) {
      this.emit({
        type: 'crew-state',
        message: step.message,
        updates: step.crewStates,
      });
    }
  }
}
