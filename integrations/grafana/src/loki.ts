/**
 * Loki structured log pusher for Grafana Cloud.
 *
 * Pushes structured JSON log entries to Loki's HTTP API.
 * Each entry carries labels (agent, game_id, event_type) and a JSON body
 * with the full event payload — forming the epistemic history trail
 * that the Closeout report queries.
 *
 * Requires: GRAFANA_LOKI_URL, GRAFANA_LOKI_USER, GRAFANA_CLOUD_API_KEY
 */

export interface LokiConfig {
  /** Loki push URL, e.g. https://logs-prod-006.grafana.net */
  url: string;
  /** Loki user ID (numeric) */
  user: string;
  /** Grafana Cloud API key */
  apiKey: string;
}

interface LokiStream {
  stream: Record<string, string>;
  values: [string, string][]; // [nanosecond_ts, line]
}

export class LokiLogger {
  private config: LokiConfig | null;
  private buffer: LokiStream[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const url = process.env['GRAFANA_LOKI_URL'];
    const user = process.env['GRAFANA_LOKI_USER'];
    const apiKey = process.env['GRAFANA_CLOUD_API_KEY'];

    if (url && user && apiKey) {
      this.config = { url, user, apiKey };
      this.flushInterval = setInterval(() => void this.flush(), 5_000);
      console.log('[grafana-loki] Enabled — pushing to', url);
    } else {
      this.config = null;
      console.log('[grafana-loki] Disabled — missing GRAFANA_LOKI_URL, GRAFANA_LOKI_USER, or GRAFANA_CLOUD_API_KEY');
    }
  }

  get enabled(): boolean {
    return this.config !== null;
  }

  /**
   * Log an agent decision or state change.
   * Labels are indexed (searchable), body is the full payload.
   */
  log(labels: Record<string, string>, body: Record<string, unknown>): void {
    if (!this.config) return;

    const tsNano = String(Date.now()) + '000000'; // ms → ns
    this.buffer.push({
      stream: {
        app: 'apron',
        ...labels,
      },
      values: [[tsNano, JSON.stringify(body)]],
    });

    if (this.buffer.length >= 50) void this.flush();
  }

  /**
   * Log an agent event with standard labels extracted.
   */
  logAgentEvent(
    agent: string,
    eventType: string,
    gameId: string,
    payload: Record<string, unknown>,
  ): void {
    this.log(
      {
        agent,
        event_type: eventType,
        game_id: gameId,
        level: 'info',
      },
      {
        agent,
        event_type: eventType,
        game_id: gameId,
        timestamp: new Date().toISOString(),
        ...payload,
      },
    );
  }

  /**
   * Log a provenance/epistemic change — the core of the Closeout trail.
   * Tracks how a fact evolved: unknown → inferred → confirmed.
   */
  logProvenanceChange(
    gameId: string,
    crewId: string,
    field: string,
    change: {
      from: string;
      to: string;
      source: string;
      confidence?: number;
      agent: string;
    },
  ): void {
    this.log(
      {
        agent: change.agent,
        event_type: 'provenance_change',
        game_id: gameId,
        crew_id: crewId,
        level: 'info',
      },
      {
        agent: change.agent,
        game_id: gameId,
        crew_id: crewId,
        field,
        from_state: change.from,
        to_state: change.to,
        source: change.source,
        confidence: change.confidence,
        timestamp: new Date().toISOString(),
      },
    );
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0 || !this.config) return;

    const batch = this.buffer.splice(0);
    const payload = { streams: batch };

    try {
      const auth = Buffer.from(`${this.config.user}:${this.config.apiKey}`).toString('base64');
      const res = await fetch(`${this.config.url}/loki/api/v1/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${auth}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error(`[grafana-loki] Push failed: ${res.status} ${text}`);
        // Re-queue on failure
        this.buffer.unshift(...batch);
      }
    } catch (err) {
      console.error('[grafana-loki] Push error:', err);
      this.buffer.unshift(...batch);
    }
  }

  /**
   * Query Loki logs for a specific game — used by Closeout.
   * Returns log entries sorted by time.
   */
  async queryGameLogs(
    gameId: string,
    opts?: { from?: Date; to?: Date; limit?: number },
  ): Promise<Array<{ timestamp: string; labels: Record<string, string>; body: Record<string, unknown> }>> {
    if (!this.config) return [];

    const now = Date.now();
    const from = opts?.from?.getTime() ?? now - 24 * 60 * 60 * 1000;
    const to = opts?.to?.getTime() ?? now;
    const limit = opts?.limit ?? 1000;

    const query = `{app="apron",game_id="${gameId}"}`;
    const params = new URLSearchParams({
      query,
      start: String(Math.floor(from / 1000)),
      end: String(Math.floor(to / 1000)),
      limit: String(limit),
      direction: 'forward',
    });

    try {
      const auth = Buffer.from(`${this.config.user}:${this.config.apiKey}`).toString('base64');
      const res = await fetch(`${this.config.url}/loki/api/v1/query_range?${params}`, {
        headers: { 'Authorization': `Basic ${auth}` },
      });

      if (!res.ok) {
        console.error(`[grafana-loki] Query failed: ${res.status}`);
        return [];
      }

      const data = await res.json() as {
        data: {
          result: Array<{
            stream: Record<string, string>;
            values: [string, string][];
          }>;
        };
      };

      const entries: Array<{ timestamp: string; labels: Record<string, string>; body: Record<string, unknown> }> = [];
      for (const stream of data.data.result) {
        for (const [tsNano, line] of stream.values) {
          try {
            entries.push({
              timestamp: new Date(Number(tsNano) / 1_000_000).toISOString(),
              labels: stream.stream,
              body: JSON.parse(line),
            });
          } catch {
            entries.push({
              timestamp: new Date(Number(tsNano) / 1_000_000).toISOString(),
              labels: stream.stream,
              body: { raw: line },
            });
          }
        }
      }

      // Sort by timestamp
      entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      return entries;
    } catch (err) {
      console.error('[grafana-loki] Query error:', err);
      return [];
    }
  }

  stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }
}
