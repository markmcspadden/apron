/**
 * Prometheus metrics reporter for Grafana Cloud.
 *
 * Pushes metrics in Prometheus remote-write exposition format.
 * Supports both Grafana Cloud (Basic auth) and local Prometheus (Bearer/no auth).
 *
 * Grafana Cloud requires:
 *   GRAFANA_PROM_URL   — Remote Write endpoint (e.g. https://prometheus-prod-24-prod-us-east-0.grafana.net)
 *   GRAFANA_PROM_USER  — Prometheus username (numeric)
 *   GRAFANA_CLOUD_API_KEY — Grafana Cloud API key (shared with Loki)
 *
 * Legacy env vars (GRAFANA_ENDPOINT, GRAFANA_API_KEY) still work for local setups.
 */

import type { AgentEvent } from '@apron/types';

interface GrafanaConfig {
  endpoint: string;
  /** Grafana Cloud username (numeric) — null for local/Bearer setups */
  user: string | null;
  apiKey: string | null;
  orgId: string | null;
}

interface MetricPoint {
  name: string;
  value: number;
  timestamp: number;
  labels: Record<string, string>;
}

export interface GrafanaReporterHealth {
  enabled: boolean;
  endpoint: string;
  authMode: 'basic' | 'bearer' | 'none';
  bufferSize: number;
  totalPushed: number;
  totalErrors: number;
  lastPushAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

export class GrafanaReporter {
  private config: GrafanaConfig;
  private buffer: MetricPoint[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private enabled: boolean;
  private _totalPushed = 0;
  private _totalErrors = 0;
  private _lastPushAt: string | null = null;
  private _lastErrorAt: string | null = null;
  private _lastError: string | null = null;

  constructor(config?: Partial<GrafanaConfig>) {
    this.config = {
      // Grafana Cloud → local fallback
      endpoint: config?.endpoint
        ?? process.env['GRAFANA_PROM_URL']
        ?? process.env['GRAFANA_ENDPOINT']
        ?? 'http://localhost:3100',
      user: process.env['GRAFANA_PROM_USER'] ?? null,
      apiKey: config?.apiKey
        ?? process.env['GRAFANA_CLOUD_API_KEY']
        ?? process.env['GRAFANA_API_KEY']
        ?? null,
      orgId: config?.orgId ?? process.env['GRAFANA_ORG_ID'] ?? null,
    };
    this.enabled = !!this.config.apiKey;

    if (this.enabled) {
      this.flushInterval = setInterval(() => void this.flush(), 10_000);
      console.log('[grafana-prom] Enabled — pushing to', this.config.endpoint);
    } else {
      console.log('[grafana-prom] Disabled — no GRAFANA_CLOUD_API_KEY or GRAFANA_API_KEY');
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
    if (this.buffer.length >= 100) void this.flush();
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

      // Grafana Cloud: Basic auth (user:apiKey)
      // Local: Bearer token
      if (this.config.user && this.config.apiKey) {
        const auth = Buffer.from(`${this.config.user}:${this.config.apiKey}`).toString('base64');
        headers['Authorization'] = `Basic ${auth}`;
      } else if (this.config.apiKey) {
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      }

      if (this.config.orgId) {
        headers['X-Scope-OrgID'] = this.config.orgId;
      }

      const res = await fetch(`${this.config.endpoint}/api/v1/push`, {
        method: 'POST',
        headers,
        body,
      });

      if (!res.ok) {
        const text = await res.text();
        console.error(`[grafana-prom] Push failed: ${res.status} ${text}`);
        this._totalErrors++;
        this._lastErrorAt = new Date().toISOString();
        this._lastError = `${res.status} ${text.slice(0, 200)}`;
        this.buffer.unshift(...batch);
      } else {
        this._totalPushed += batch.length;
        this._lastPushAt = new Date().toISOString();
      }
    } catch (err) {
      console.error('[grafana-prom] Failed to push metrics:', err);
      this._totalErrors++;
      this._lastErrorAt = new Date().toISOString();
      this._lastError = err instanceof Error ? err.message : String(err);
      this.buffer.unshift(...batch);
    }
  }

  getBuffer(): readonly MetricPoint[] {
    return this.buffer;
  }

  getHealth(): GrafanaReporterHealth {
    return {
      enabled: this.enabled,
      endpoint: this.config.endpoint,
      authMode: this.config.user && this.config.apiKey ? 'basic' : this.config.apiKey ? 'bearer' : 'none',
      bufferSize: this.buffer.length,
      totalPushed: this._totalPushed,
      totalErrors: this._totalErrors,
      lastPushAt: this._lastPushAt,
      lastErrorAt: this._lastErrorAt,
      lastError: this._lastError,
    };
  }

  stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }
}
