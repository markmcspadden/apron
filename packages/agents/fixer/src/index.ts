import { BaseAgent } from '@apron/orchestrator';
import type { FixtureStep, FixtureScenario } from '@apron/types';

export class FixerAgent extends BaseAgent {
  constructor() {
    super('FIXER');
  }

  async process(input: Record<string, unknown>): Promise<void> {
    const step = input['step'] as FixtureStep;
    const scenario = input['scenario'] as FixtureScenario;

    if (step.showOptions) {
      this.emit({
        type: 'options',
        message: step.message,
        groups: scenario.optionGroups,
      });
    }

    if (step.routes) {
      for (const [group, routeData] of Object.entries(step.routes)) {
        this.emit({
          type: 'route-update',
          message: step.message,
          group,
          route: routeData.route,
          arrival: routeData.arrival,
        });
      }
    }

    if (step.crewStates) {
      this.emit({
        type: 'crew-state',
        message: step.message,
        updates: step.crewStates,
      });
    }

    if (step.metrics) {
      this.emit({
        type: 'metrics',
        message: step.message,
        risk: step.metrics.risk ?? 0,
        exposed: step.metrics.exposed ?? 0,
      });
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
