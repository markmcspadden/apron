import type { AgentEvent } from '@apron/types';

interface GrafanaConfig {
  endpoint: string;
  apiKey?: string;
  orgId?: string;
}

interface MetricPoint {
  name: string;
  value: number;
  timestamp: number;
  labels: Record<string, string>;
}

export class GrafanaReporter {
  private config: GrafanaConfig;
  private buffer: MetricPoint[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private enabled: boolean;

  constructor(config?: Partial<GrafanaConfig>) {
    this.config = {
      endpoint: config?.endpoint ?? process.env['GRAFANA_ENDPOINT'] ?? 'http://localhost:3100',
      apiKey: config?.apiKey ?? process.env['GRAFANA_API_KEY'],
      orgId: config?.orgId ?? process.env['GRAFANA_ORG_ID'],
    };
    this.enabled = !!this.config.apiKey;

    if (this.enabled) {
      this.flushInterval = setInterval(() => this.flush(), 10_000);
    }
  }

  recordEvent(event: AgentEvent): void {
    this.push({
      name: 'apron_agent_event',
      value: 1,
      timestamp: Date.now(),
      labels: {
        agent: event.agent,
        event_type: event.type,
        show_id: event.showId,
      },
    });

    if (event.type === 'metrics') {
      this.push({
        name: 'apron_crew_at_risk',
        value: event.risk,
        timestamp: Date.now(),
        labels: { show_id: event.showId },
      });
      this.push({
        name: 'apron_call_times_exposed',
        value: event.exposed,
        timestamp: Date.now(),
        labels: { show_id: event.showId },
      });
    }

    if (event.type === 'show-state') {
      this.push({
        name: 'apron_show_state_change',
        value: 1,
        timestamp: Date.now(),
        labels: {
          show_id: event.showId,
          state: event.state,
        },
      });
    }
  }

  recordAgentLatency(agent: string, durationMs: number): void {
    this.push({
      name: 'apron_agent_process_duration_ms',
      value: durationMs,
      timestamp: Date.now(),
      labels: { agent },
    });
  }

  private push(point: MetricPoint): void {
    this.buffer.push(point);
    if (this.buffer.length >= 100) this.flush();
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    if (!this.enabled) {
      this.buffer = [];
      return;
    }

    const batch = this.buffer.splice(0);
    const body = batch
      .map(p => {
        const labels = Object.entries(p.labels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(',');
        return `${p.name}{${labels}} ${p.value} ${p.timestamp}`;
      })
      .join('\n');

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'text/plain',
      };
      if (this.config.apiKey) {
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      }
      if (this.config.orgId) {
        headers['X-Scope-OrgID'] = this.config.orgId;
      }

      await fetch(`${this.config.endpoint}/api/v1/push`, {
        method: 'POST',
        headers,
        body,
      });
    } catch (err) {
      console.error('[grafana] Failed to push metrics:', err);
      this.buffer.unshift(...batch);
    }
  }

  getBuffer(): readonly MetricPoint[] {
    return this.buffer;
  }

  stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }
}
