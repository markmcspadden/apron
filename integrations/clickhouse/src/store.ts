import type { AgentEvent } from '@apron/types';

interface StoreConfig {
  url?: string;
  username?: string;
  password?: string;
  database?: string;
}

type ClickHouseClient = {
  command(opts: { query: string }): Promise<unknown>;
  insert(opts: { table: string; values: unknown[]; format: string }): Promise<unknown>;
  query(opts: { query: string; format: string }): Promise<{ json(): Promise<unknown[]> }>;
  close(): Promise<void>;
};

export class ClickhouseAuditStore {
  private client: ClickHouseClient | null = null;
  private buffer: Array<Record<string, unknown>> = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private enabled: boolean;

  constructor(config?: Partial<StoreConfig>) {
    this.enabled = !!process.env['CLICKHOUSE_URL'];

    if (this.enabled) {
      const url = config?.url ?? process.env['CLICKHOUSE_URL'] ?? 'http://localhost:8123';
      const username = config?.username ?? process.env['CLICKHOUSE_USER'] ?? 'default';
      const password = config?.password ?? process.env['CLICKHOUSE_PASSWORD'] ?? '';
      const database = config?.database ?? process.env['CLICKHOUSE_DATABASE'] ?? 'apron';

      import('@clickhouse/client').then(({ createClient }) => {
        this.client = createClient({ url, username, password, database }) as unknown as ClickHouseClient;
        this.flushInterval = setInterval(() => this.flush(), 5_000);
      }).catch(() => {
        console.log('[clickhouse] @clickhouse/client not available');
        this.enabled = false;
      });
    }
  }

  async ensureSchema(): Promise<void> {
    if (!this.enabled || !this.client) return;

    const { SCHEMA } = await import('./schema.js');
    await this.client.command({ query: `CREATE DATABASE IF NOT EXISTS ${SCHEMA.database}` });
    for (const ddl of Object.values(SCHEMA.tables)) {
      await this.client.command({ query: ddl as string });
    }
  }

  record(event: AgentEvent): void {
    this.buffer.push({
      sequence: this.seq++,
      received_at: new Date().toISOString(),
      event_id: event.id,
      event_type: event.type,
      show_id: event.showId,
      agent: event.agent,
      timestamp: event.timestamp,
      message: event.message,
      payload: JSON.stringify(event),
    });

    if (this.buffer.length >= 50) this.flush();
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    if (!this.enabled || !this.client) {
      this.buffer = [];
      return;
    }

    const batch = this.buffer.splice(0);
    try {
      await this.client.insert({
        table: 'audit_log',
        values: batch,
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[clickhouse] Failed to insert audit batch:', err);
      this.buffer.unshift(...batch);
    }
  }

  async query(sql: string): Promise<unknown[]> {
    if (!this.enabled || !this.client) return [];
    const result = await this.client.query({ query: sql, format: 'JSONEachRow' });
    return result.json();
  }

  async getShowAudit(showId: string): Promise<unknown[]> {
    return this.query(
      `SELECT * FROM audit_log WHERE show_id = '${showId}' ORDER BY sequence`
    );
  }

  async getAgentActivity(showId: string): Promise<unknown[]> {
    return this.query(
      `SELECT agent, count() as events, min(timestamp) as first_event, max(timestamp) as last_event
       FROM audit_log WHERE show_id = '${showId}'
       GROUP BY agent ORDER BY first_event`
    );
  }

  getBuffer(): readonly Record<string, unknown>[] {
    return this.buffer;
  }

  async stop(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    await this.flush();
    await this.client?.close();
  }
}
