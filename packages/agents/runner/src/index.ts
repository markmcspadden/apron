import { BaseAgent } from '@apron/orchestrator';
import type { FixtureStep, FixtureScenario } from '@apron/types';

export class RunnerAgent extends BaseAgent {
  constructor() {
    super('RUNNER');
  }

  async process(input: Record<string, unknown>): Promise<void> {
    const step = input['step'] as FixtureStep;
    const scenario = input['scenario'] as FixtureScenario;

    if (step.showHandoff) {
      this.emit({
        type: 'handoff',
        message: step.message,
        instruction: scenario.handoffText,
      });
    }

    if (step.gameState) {
      this.emit({
        type: 'game-state',
        message: step.message,
        gameState: step.gameState[0],
        live: step.gameState[1] === 'live',
      });
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

    if (step.done) {
      this.emit({
        type: 'show-closed',
        message: step.message,
      });

      this.emit({
        type: 'show-state' as const,
        message: step.message,
        state: 'clear',
        alert: null,
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
