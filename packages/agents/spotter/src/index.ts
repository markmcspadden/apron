import { BaseAgent } from '@apron/orchestrator';
import type { FixtureStep, FixtureScenario } from '@apron/types';

export class SpotterAgent extends BaseAgent {
  constructor() {
    super('SPOTTER');
  }

  async process(input: Record<string, unknown>): Promise<void> {
    const step = input['step'] as FixtureStep;
    const scenario = input['scenario'] as FixtureScenario;

    if (step.gameState) {
      this.emit({
        type: 'game-state',
        message: step.message,
        gameState: step.gameState[0],
        live: step.gameState[1] === 'live',
      });
    }

    if (step.chainLevel !== undefined) {
      this.emit({
        type: 'chain-update',
        message: step.message,
        level: step.chainLevel,
        nodes: scenario.chain,
      });
    }

    if (step.showState) {
      this.emit({
        type: 'show-state' as const,
        message: step.message,
        state: step.showState,
        alert: this.buildAlert(step),
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

    if (step.slackDelta !== undefined) {
      this.emit({
        type: 'crew-state',
        message: step.message,
        updates: {},
      });
    }
  }

  private buildAlert(step: FixtureStep): string | null {
    if (step.showState === 'watch') return 'Extra innings. Chain recomputing for 22 traveling crew.';
    if (step.showState === 'risk') return '14 crew at risk. Projected wrap 01:05 · 06:05 departures no longer reachable with rest.';
    if (step.showState === 'down') return '4 call times exposed. TD, A1, DIR and Lead EVS breach mandatory rest for a 14:00 CT call in Kansas City.';
    return null;
  }
}
