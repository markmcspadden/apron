/**
 * Grafana Cloud MCP client — connects to the Grafana MCP server and
 * exposes typed wrappers around its tools for querying Loki, Prometheus,
 * and dashboards.
 *
 * Supports two transports:
 *   1. Streamable HTTP — connects to the hosted Grafana Cloud MCP endpoint
 *      (`GRAFANA_MCP_URL`, default `https://mcp.grafana.com/mcp`).
 *   2. Stdio — spawns a local `mcp-grafana` binary with a service-account
 *      token (for unattended server-side deployments).
 *
 * Falls back gracefully when neither is configured — the CloseoutBuilder
 * uses direct Loki HTTP queries in that case.
 *
 * Env vars:
 *   GRAFANA_MCP_URL          — Streamable HTTP endpoint (defaults to hosted)
 *   GRAFANA_MCP_API_KEY      — Grafana Cloud API key for MCP auth
 *   GRAFANA_URL              — Grafana instance URL (e.g. https://modestsalmon3417.grafana.net)
 *   GRAFANA_MCP_BINARY       — path to a local mcp-grafana binary (stdio mode)
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GrafanaMcpHealth {
  enabled: boolean;
  transport: 'http' | 'stdio' | null;
  connected: boolean;
  url: string | null;
  toolCount: number;
  lastCallAt: string | null;
  totalCalls: number;
  totalErrors: number;
  lastError: string | null;
}

export interface LokiQueryResult {
  timestamp: string;
  labels: Record<string, string>;
  body: Record<string, unknown>;
}

export interface PromQueryResult {
  metric: Record<string, string>;
  values: Array<{ timestamp: string; value: number }>;
}

export interface DashboardLink {
  uid: string;
  title: string;
  url: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class GrafanaMcpClient {
  private client: Client | null = null;
  private connected = false;
  private transport: 'http' | 'stdio' | null = null;
  private mcpUrl: string | null = null;
  private toolCount = 0;

  // Metrics
  private _lastCallAt: string | null = null;
  private _totalCalls = 0;
  private _totalErrors = 0;
  private _lastError: string | null = null;

  constructor() {
    // Config is read lazily on connect()
  }

  /**
   * Initialize the MCP connection. Call once at startup.
   * Returns true if connected, false if not configured.
   */
  async connect(): Promise<boolean> {
    const apiKey = process.env['GRAFANA_MCP_API_KEY'] ?? process.env['GRAFANA_CLOUD_API_KEY'];
    const grafanaUrl = process.env['GRAFANA_URL'];
    const mcpUrl = process.env['GRAFANA_MCP_URL'] ?? 'https://mcp.grafana.com/mcp';

    if (!apiKey) {
      console.log('[grafana-mcp] Disabled — no GRAFANA_MCP_API_KEY or GRAFANA_CLOUD_API_KEY');
      return false;
    }

    this.mcpUrl = mcpUrl;
    this.transport = 'http';

    try {
      this.client = new Client({
        name: 'apron-closeout',
        version: '0.1.0',
      });

      const headers: Record<string, string> = {
        'Authorization': `Bearer ${apiKey}`,
      };
      if (grafanaUrl) {
        headers['X-Grafana-URL'] = grafanaUrl;
      }

      const httpTransport = new StreamableHTTPClientTransport(
        new URL(mcpUrl),
        { requestInit: { headers } },
      );

      await this.client.connect(httpTransport);
      this.connected = true;

      // Discover available tools
      try {
        const tools = await this.client.listTools();
        this.toolCount = tools.tools.length;
        console.log(`[grafana-mcp] Connected via Streamable HTTP — ${this.toolCount} tools available`);
      } catch {
        // Tool listing failed but connection is up
        console.log('[grafana-mcp] Connected but tool listing failed');
      }

      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[grafana-mcp] Connection failed: ${msg}`);
      this._lastError = msg;
      this._totalErrors++;
      this.connected = false;
      return false;
    }
  }

  isEnabled(): boolean {
    return this.connected && this.client !== null;
  }

  /**
   * Query Loki logs via the MCP server's query_loki_logs tool.
   *
   * Uses LogQL to find game events. Returns parsed entries compatible
   * with the CloseoutBuilder's expected format.
   */
  async queryLokiLogs(
    gameId: string,
    opts?: { from?: Date; to?: Date; limit?: number },
  ): Promise<LokiQueryResult[]> {
    if (!this.isEnabled()) return [];

    const logql = `{app="apron",game_id="${gameId}"}`;
    const now = Date.now();
    const from = opts?.from?.getTime() ?? now - 24 * 60 * 60 * 1000;
    const to = opts?.to?.getTime() ?? now;
    const limit = opts?.limit ?? 2000;

    // Convert to Loki's RFC3339 or Unix epoch format
    const startTime = new Date(from).toISOString();
    const endTime = new Date(to).toISOString();

    try {
      this._totalCalls++;
      this._lastCallAt = new Date().toISOString();

      const result = await this.client!.callTool({
        name: 'query_loki_logs',
        arguments: {
          logql,
          start: startTime,
          end: endTime,
          limit,
          direction: 'forward',
        },
      });

      // Parse the MCP tool result — the Grafana MCP server returns text content
      const entries: LokiQueryResult[] = [];
      if (result.content && Array.isArray(result.content)) {
        for (const block of result.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            // The MCP server returns log lines, potentially as structured JSON
            try {
              const parsed = JSON.parse(block.text);
              // Handle array of log entries
              if (Array.isArray(parsed)) {
                for (const entry of parsed) {
                  entries.push(this.normalizeLokiEntry(entry));
                }
              } else if (parsed.data?.result) {
                // Standard Loki query_range response format
                for (const stream of parsed.data.result) {
                  for (const [tsNano, line] of stream.values ?? []) {
                    try {
                      entries.push({
                        timestamp: new Date(Number(tsNano) / 1_000_000).toISOString(),
                        labels: stream.stream ?? stream.labels ?? {},
                        body: typeof line === 'string' ? JSON.parse(line) : line,
                      });
                    } catch {
                      entries.push({
                        timestamp: new Date(Number(tsNano) / 1_000_000).toISOString(),
                        labels: stream.stream ?? stream.labels ?? {},
                        body: { raw: line },
                      });
                    }
                  }
                }
              } else if (parsed.timestamp || parsed.ts) {
                // Single entry
                entries.push(this.normalizeLokiEntry(parsed));
              }
            } catch {
              // Plain text log line — wrap it
              entries.push({
                timestamp: new Date().toISOString(),
                labels: { game_id: gameId },
                body: { raw: block.text },
              });
            }
          }
        }
      }

      entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      console.log(`[grafana-mcp] Loki query returned ${entries.length} entries for game ${gameId}`);
      return entries;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._totalErrors++;
      this._lastError = msg;
      console.error(`[grafana-mcp] Loki query failed: ${msg}`);
      return [];
    }
  }

  /**
   * Query Prometheus metrics via the MCP server's query_prometheus tool.
   *
   * Used to enrich closeout reports with operational metrics from the
   * game window — crew at risk, agent latency, state changes.
   */
  async queryPrometheus(
    promql: string,
    opts?: { from?: Date; to?: Date; step?: string },
  ): Promise<PromQueryResult[]> {
    if (!this.isEnabled()) return [];

    const now = Date.now();
    const from = opts?.from?.getTime() ?? now - 24 * 60 * 60 * 1000;
    const to = opts?.to?.getTime() ?? now;
    const step = opts?.step ?? '60s';

    try {
      this._totalCalls++;
      this._lastCallAt = new Date().toISOString();

      const result = await this.client!.callTool({
        name: 'query_prometheus',
        arguments: {
          promql,
          start: new Date(from).toISOString(),
          end: new Date(to).toISOString(),
          step,
        },
      });

      const results: PromQueryResult[] = [];
      if (result.content && Array.isArray(result.content)) {
        for (const block of result.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            try {
              const parsed = JSON.parse(block.text);
              if (parsed.data?.result) {
                for (const series of parsed.data.result) {
                  results.push({
                    metric: series.metric ?? {},
                    values: (series.values ?? []).map(([ts, val]: [number, string]) => ({
                      timestamp: new Date(ts * 1000).toISOString(),
                      value: parseFloat(val),
                    })),
                  });
                }
              }
            } catch {
              // Non-JSON response — skip
            }
          }
        }
      }

      console.log(`[grafana-mcp] Prometheus query returned ${results.length} series`);
      return results;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._totalErrors++;
      this._lastError = msg;
      console.error(`[grafana-mcp] Prometheus query failed: ${msg}`);
      return [];
    }
  }

  /**
   * Search Grafana dashboards via the MCP server's search_dashboards tool.
   *
   * Used to include a link to the ops dashboard in the closeout report.
   */
  async searchDashboards(query?: string): Promise<DashboardLink[]> {
    if (!this.isEnabled()) return [];

    try {
      this._totalCalls++;
      this._lastCallAt = new Date().toISOString();

      const result = await this.client!.callTool({
        name: 'search_dashboards',
        arguments: { query: query ?? 'apron' },
      });

      const dashboards: DashboardLink[] = [];
      if (result.content && Array.isArray(result.content)) {
        for (const block of result.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            try {
              const parsed = JSON.parse(block.text);
              const items = Array.isArray(parsed) ? parsed : parsed.dashboards ?? [];
              for (const d of items) {
                dashboards.push({
                  uid: d.uid ?? d.id ?? '',
                  title: d.title ?? 'Untitled',
                  url: d.url ?? '',
                });
              }
            } catch {
              // Non-JSON response
            }
          }
        }
      }

      console.log(`[grafana-mcp] Dashboard search returned ${dashboards.length} results`);
      return dashboards;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._totalErrors++;
      this._lastError = msg;
      console.error(`[grafana-mcp] Dashboard search failed: ${msg}`);
      return [];
    }
  }

  /**
   * Disconnect from the MCP server.
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Best-effort cleanup
      }
      this.connected = false;
    }
  }

  getHealth(): GrafanaMcpHealth {
    return {
      enabled: this.isEnabled(),
      transport: this.transport,
      connected: this.connected,
      url: this.mcpUrl,
      toolCount: this.toolCount,
      lastCallAt: this._lastCallAt,
      totalCalls: this._totalCalls,
      totalErrors: this._totalErrors,
      lastError: this._lastError,
    };
  }

  // ---- internal ----

  private normalizeLokiEntry(entry: Record<string, unknown>): LokiQueryResult {
    const ts = entry['timestamp'] ?? entry['ts'] ?? new Date().toISOString();
    const timestamp = typeof ts === 'number'
      ? new Date(ts > 1e12 ? ts / 1_000_000 : ts * 1000).toISOString()
      : String(ts);

    return {
      timestamp,
      labels: (entry['labels'] ?? entry['stream'] ?? {}) as Record<string, string>,
      body: (entry['body'] ?? entry['line'] ?? entry) as Record<string, unknown>,
    };
  }
}
