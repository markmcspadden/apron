import type { AgentName, FixtureScenario, FixtureStep, AgentEvent } from '@apron/types';
import { CredentialBroker } from '@apron/credentials';
import { MessageBus } from './bus.js';
import { AgentRuntime } from './runtime.js';
import type { BaseAgent } from './agent.js';

export interface OrchestratorCallbacks {
  onEvent?: (event: AgentEvent) => void;
  onStepComplete?: (step: FixtureStep, index: number) => void;
  onComplete?: () => void;
}

export class Orchestrator {
  private runtime: AgentRuntime;
  private bus: MessageBus;
  private broker: CredentialBroker;
  private scenario: FixtureScenario | null = null;
  private stepIndex = -1;
  private playing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private callbacks: OrchestratorCallbacks = {};

  constructor(showId: string, offlineAgents: AgentName[] = []) {
    this.bus = new MessageBus();
    this.broker = new CredentialBroker(showId, offlineAgents);
    this.runtime = new AgentRuntime(showId, this.bus, this.broker);
  }

  getBus(): MessageBus {
    return this.bus;
  }

  getRuntime(): AgentRuntime {
    return this.runtime;
  }

  getBroker(): CredentialBroker {
    return this.broker;
  }

  registerAgent(agent: BaseAgent): void {
    this.runtime.register(agent);
  }

  loadScenario(scenario: FixtureScenario): void {
    this.scenario = scenario;
    this.stepIndex = -1;
    console.log(`[orchestrator] Loaded scenario: ${scenario.title} (${scenario.steps.length} steps)`);
  }

  onEvent(cb: OrchestratorCallbacks['onEvent']): void {
    this.callbacks.onEvent = cb;
    if (cb) this.bus.subscribe(cb);
  }

  onStepComplete(cb: OrchestratorCallbacks['onStepComplete']): void {
    this.callbacks.onStepComplete = cb;
  }

  onComplete(cb: OrchestratorCallbacks['onComplete']): void {
    this.callbacks.onComplete = cb;
  }

  async nextStep(): Promise<FixtureStep | null> {
    if (!this.scenario) return null;
    this.stepIndex++;
    if (this.stepIndex >= this.scenario.steps.length) {
      this.callbacks.onComplete?.();
      return null;
    }

    const step = this.scenario.steps[this.stepIndex]!;
    try {
      await this.runtime.dispatch(step.agent, { step, scenario: this.scenario });
    } catch {
      // Agent not registered — still broadcast the step for the board
    }
    this.callbacks.onStepComplete?.(step, this.stepIndex);
    return step;
  }

  play(intervalMs = 2900): void {
    if (this.playing) return;
    this.playing = true;

    const tick = async () => {
      const step = await this.nextStep();
      if (!step) {
        this.stop();
      }
    };

    tick();
    this.timer = setInterval(tick, intervalMs);
  }

  stop(): void {
    this.playing = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  reset(): void {
    this.stop();
    this.stepIndex = -1;
    this.bus.clear();
  }

  isPlaying(): boolean {
    return this.playing;
  }

  getCurrentStep(): number {
    return this.stepIndex;
  }

  getTotalSteps(): number {
    return this.scenario?.steps.length ?? 0;
  }

  getScenario(): FixtureScenario | null {
    return this.scenario;
  }
}
