/**
 * Closeout report — post-game operational chronology.
 *
 * After a game ends, the Closeout queries the agent decision trail via
 * the Grafana Cloud MCP server (LogQL + PromQL tools) and builds a
 * structured summary: what happened, when the system knew it, and how
 * it responded.
 *
 * Primary path:  Grafana MCP server → query_loki_logs / query_prometheus
 * Fallback:      Direct Loki HTTP API (when MCP is unavailable)
 *
 * The report is served at /api/closeout/:gameId and rendered in the
 * Closeout Reports admin view.
 */

import type { LokiLogger } from './loki.js';
import type { GrafanaMcpClient, PromQueryResult } from './mcp-client.js';

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export interface CloseoutReport {
  gameId: string;
  generatedAt: string;
  /** Human-readable game summary */
  gameSummary: string;
  /** Chronological list of significant operational events */
  timeline: TimelineEntry[];
  /** Agent activity summary — how many events each agent produced */
  agentActivity: Record<string, number>;
  /** Key operational decisions and their outcomes */
  decisions: Decision[];
  /** Compliance summary (from STEWARD events) */
  compliance: ComplianceSummary | null;
  /** Flight summary (from TRAFFIC events) */
  flights: FlightSummary | null;
  /** Overall operational grade */
  grade: OperationalGrade;
  /** Prometheus metrics snapshot from game window (via MCP) */
  metrics: MetricsSnapshot | null;
  /** Link to Grafana dashboard (via MCP dashboard search) */
  dashboardUrl: string | null;
  /** Data source — 'mcp' if Grafana MCP was used, 'direct' if HTTP fallback */
  source: 'mcp' | 'direct';
}

export interface MetricsSnapshot {
  /** Peak crew-at-risk count during game */
  peakCrewAtRisk: number;
  /** Total show state changes */
  stateChanges: number;
  /** Mean agent processing latency (ms) */
  meanAgentLatencyMs: number;
  /** Total agent events recorded */
  totalAgentEvents: number;
}

export interface TimelineEntry {
  timestamp: string;
  agent: string;
  eventType: string;
  summary: string;
  significance: 'routine' | 'notable' | 'critical';
}

export interface Decision {
  timestamp: string;
  agent: string;
  description: string;
  outcome: string;
}

export interface ComplianceSummary {
  totalCrew: number;
  violations: number;
  atRisk: number;
  compliant: number;
  totalExposure: string;
}

export interface FlightSummary {
  total: number;
  onTime: number;
  delayed: number;
  cancelled: number;
}

export interface OperationalGrade {
  letter: 'A' | 'B' | 'C' | 'D' | 'F';
  score: number;
  rationale: string;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class CloseoutBuilder {
  private mcp: GrafanaMcpClient | null = null;

  constructor(private loki: LokiLogger) {}

  /** Attach the Grafana MCP client for primary data access. */
  setMcpClient(mcp: GrafanaMcpClient): void {
    this.mcp = mcp;
  }

  /**
   * Generate a Closeout report for a completed game.
   *
   * Primary path:  Grafana MCP server (query_loki_logs + query_prometheus)
   * Fallback:      Direct Loki HTTP API
   *
   * When MCP is available the report is enriched with Prometheus metrics
   * (crew-at-risk peak, state changes, agent latency) and a link to the
   * Grafana ops dashboard.
   */
  async generate(
    gameId: string,
    opts?: { from?: Date; to?: Date },
  ): Promise<CloseoutReport> {
    let usedMcp = false;
    let entries: Array<{ timestamp: string; labels: Record<string, string>; body: Record<string, unknown> }>;

    // ---- Primary path: Grafana MCP server ----
    if (this.mcp?.isEnabled()) {
      console.log(`[closeout] Querying via Grafana MCP server for game ${gameId}`);
      const mcpEntries = await this.mcp.queryLokiLogs(gameId, {
        from: opts?.from,
        to: opts?.to,
        limit: 2000,
      });
      if (mcpEntries.length > 0) {
        entries = mcpEntries;
        usedMcp = true;
        console.log(`[closeout] MCP returned ${entries.length} log entries`);
      } else {
        // MCP returned empty — fall through to direct HTTP
        console.log('[closeout] MCP returned no entries — falling back to direct Loki HTTP');
        entries = await this.loki.queryGameLogs(gameId, {
          from: opts?.from,
          to: opts?.to,
          limit: 2000,
        });
      }
    } else {
      // ---- Fallback: direct Loki HTTP ----
      entries = await this.loki.queryGameLogs(gameId, {
        from: opts?.from,
        to: opts?.to,
        limit: 2000,
      });
    }

    const timeline: TimelineEntry[] = [];
    const agentActivity: Record<string, number> = {};
    const decisions: Decision[] = [];
    let compliance: ComplianceSummary | null = null;
    let flights: FlightSummary | null = null;
    let gameSummary = `Game ${gameId}`;

    // Process each log entry
    for (const entry of entries) {
      const agent = entry.labels['agent'] ?? 'unknown';
      const eventType = entry.labels['event_type'] ?? 'unknown';

      // Count agent activity
      agentActivity[agent] = (agentActivity[agent] ?? 0) + 1;

      // Classify significance
      const significance = classifySignificance(eventType, entry.body);

      // Build timeline entry
      const summary = buildSummary(eventType, entry.body);
      if (significance !== 'routine' || timeline.length < 50) {
        timeline.push({
          timestamp: entry.timestamp,
          agent,
          eventType,
          summary,
          significance,
        });
      }

      // Extract decisions (provenance changes, state escalations, rebookings)
      if (isDecision(eventType, entry.body)) {
        decisions.push({
          timestamp: entry.timestamp,
          agent,
          description: buildDecisionDescription(eventType, entry.body),
          outcome: buildDecisionOutcome(eventType, entry.body),
        });
      }

      // Extract game summary from the last game-state event
      if (eventType === 'game-state' || eventType === 'GameStateUpdate') {
        const msg = entry.body['message'] as string | undefined;
        if (msg) gameSummary = msg;
      }

      // Extract compliance from the last compliance event
      if (eventType === 'compliance-update' || eventType === 'ComplianceUpdate') {
        const totals = entry.body['totals'] as Record<string, unknown> | undefined;
        const crew = entry.body['crew'] as Array<Record<string, unknown>> | undefined;
        if (totals && crew) {
          compliance = {
            totalCrew: crew.length,
            violations: crew.filter(c => {
              const t = c['turnaround'] as Record<string, unknown> | undefined;
              return t?.['status'] === 'violation';
            }).length,
            atRisk: crew.filter(c => {
              const t = c['turnaround'] as Record<string, unknown> | undefined;
              return t?.['status'] === 'at_risk';
            }).length,
            compliant: crew.filter(c => {
              const t = c['turnaround'] as Record<string, unknown> | undefined;
              return t?.['status'] === 'compliant';
            }).length,
            totalExposure: `$${totals['totalExposure'] ?? 0}`,
          };
        }
      }

      // Extract flight summary from the last metrics event with flight data
      if (agent === 'TRAFFIC' && (eventType === 'metrics' || eventType === 'MetricsUpdate')) {
        const msg = entry.body['message'] as string | undefined;
        if (msg && msg.includes('Flights:')) {
          const match = msg.match(/(\d+) on time.*?(\d+) delayed.*?(\d+) cancelled/);
          if (match) {
            flights = {
              total: parseInt(match[1]!) + parseInt(match[2]!) + parseInt(match[3]!),
              onTime: parseInt(match[1]!),
              delayed: parseInt(match[2]!),
              cancelled: parseInt(match[3]!),
            };
          }
        }
      }
    }

    // Grade the operation
    const grade = computeGrade(compliance, flights, decisions);

    // ---- Enrich with Prometheus metrics via MCP ----
    let metrics: MetricsSnapshot | null = null;
    let dashboardUrl: string | null = null;

    if (usedMcp && this.mcp?.isEnabled()) {
      metrics = await this.queryMetricsSnapshot(gameId, opts);
      dashboardUrl = await this.findDashboardUrl();
    }

    return {
      gameId,
      generatedAt: new Date().toISOString(),
      gameSummary,
      timeline,
      agentActivity,
      decisions,
      compliance,
      flights,
      grade,
      metrics,
      dashboardUrl,
      source: usedMcp ? 'mcp' : 'direct',
    };
  }

  // ---- MCP-powered Prometheus metric queries ----

  private async queryMetricsSnapshot(
    gameId: string,
    opts?: { from?: Date; to?: Date },
  ): Promise<MetricsSnapshot | null> {
    if (!this.mcp?.isEnabled()) return null;

    try {
      // Query crew-at-risk peak
      const crewAtRisk = await this.mcp.queryPrometheus(
        'max_over_time(apron_crew_at_risk[24h])',
        { from: opts?.from, to: opts?.to, step: '300s' },
      );
      const peakCrewAtRisk = extractPeakValue(crewAtRisk);

      // Query total show state changes
      const stateChanges = await this.mcp.queryPrometheus(
        'count_over_time(apron_show_state_change[24h])',
        { from: opts?.from, to: opts?.to, step: '300s' },
      );
      const totalStateChanges = extractPeakValue(stateChanges);

      // Query mean agent latency
      const latency = await this.mcp.queryPrometheus(
        'avg_over_time(apron_agent_process_duration_ms[24h])',
        { from: opts?.from, to: opts?.to, step: '300s' },
      );
      const meanLatency = extractMeanValue(latency);

      // Query total agent events
      const events = await this.mcp.queryPrometheus(
        'count_over_time(apron_agent_event[24h])',
        { from: opts?.from, to: opts?.to, step: '300s' },
      );
      const totalEvents = extractPeakValue(events);

      console.log(`[closeout] Prometheus metrics: peak crew-at-risk=${peakCrewAtRisk}, state-changes=${totalStateChanges}, mean-latency=${meanLatency}ms, events=${totalEvents}`);

      return {
        peakCrewAtRisk,
        stateChanges: totalStateChanges,
        meanAgentLatencyMs: Math.round(meanLatency),
        totalAgentEvents: totalEvents,
      };
    } catch (err) {
      console.error('[closeout] Prometheus enrichment failed:', err);
      return null;
    }
  }

  private async findDashboardUrl(): Promise<string | null> {
    if (!this.mcp?.isEnabled()) return null;

    try {
      const dashboards = await this.mcp.searchDashboards('apron');
      if (dashboards.length > 0) {
        const grafanaUrl = process.env['GRAFANA_URL'] ?? '';
        const d = dashboards[0]!;
        return d.url ? `${grafanaUrl}${d.url}` : null;
      }
    } catch {
      // Dashboard search is best-effort
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifySignificance(
  eventType: string,
  body: Record<string, unknown>,
): 'routine' | 'notable' | 'critical' {
  // Critical events
  if (eventType === 'provenance_change') return 'notable';
  if (eventType === 'show-state' || eventType === 'ShowStateChange') {
    const state = body['state'] as string | undefined;
    if (state === 'risk' || state === 'down') return 'critical';
    if (state === 'watch') return 'notable';
  }
  if (eventType === 'compliance-update' || eventType === 'ComplianceUpdate') return 'notable';
  if (body['cancelled'] || body['status'] === 'cancelled') return 'critical';
  if (body['delayed'] || body['depDelay']) {
    const delay = body['depDelay'] as number | undefined;
    if (delay && delay >= 60) return 'critical';
    if (delay && delay >= 30) return 'notable';
  }

  // Notable events
  if (eventType === 'route-update' || eventType === 'RouteUpdate') return 'notable';
  if (eventType === 'options' || eventType === 'OptionsGenerated') return 'notable';
  if (eventType === 'handoff' || eventType === 'HandoffComposed') return 'notable';

  return 'routine';
}

function buildSummary(eventType: string, body: Record<string, unknown>): string {
  const msg = body['message'] as string | undefined;
  if (msg) return msg;

  switch (eventType) {
    case 'provenance_change':
      return `${body['field']} changed: ${body['from_state']} → ${body['to_state']} (${body['source']})`;
    case 'game-state':
    case 'GameStateUpdate':
      return `Game: ${body['gameState'] ?? 'update'}`;
    case 'show-state':
    case 'ShowStateChange':
      return `Show state → ${body['state']}`;
    default:
      return `${eventType}: ${JSON.stringify(body).slice(0, 100)}`;
  }
}

function isDecision(eventType: string, body: Record<string, unknown>): boolean {
  return (
    eventType === 'provenance_change'
    || eventType === 'ShowStateChange' || eventType === 'show-state'
    || eventType === 'RouteUpdate' || eventType === 'route-update'
    || eventType === 'OptionsGenerated' || eventType === 'options'
    || eventType === 'HandoffComposed' || eventType === 'handoff'
  );
}

function buildDecisionDescription(eventType: string, body: Record<string, unknown>): string {
  switch (eventType) {
    case 'provenance_change':
      return `Updated ${body['field']} for crew ${body['crew_id']}: ${body['from_state']} → ${body['to_state']}`;
    case 'show-state':
    case 'ShowStateChange':
      return `Escalated show state to ${body['state']}`;
    case 'route-update':
    case 'RouteUpdate':
      return `Rebooked route for group ${body['group']}`;
    case 'options':
    case 'OptionsGenerated':
      return 'Generated rebooking options';
    case 'handoff':
    case 'HandoffComposed':
      return 'Composed handoff communication';
    default:
      return eventType;
  }
}

function buildDecisionOutcome(eventType: string, body: Record<string, unknown>): string {
  const msg = body['message'] as string | undefined;
  return msg ?? 'completed';
}

function extractPeakValue(results: PromQueryResult[]): number {
  let peak = 0;
  for (const series of results) {
    for (const v of series.values) {
      if (v.value > peak) peak = v.value;
    }
  }
  return Math.round(peak);
}

function extractMeanValue(results: PromQueryResult[]): number {
  let sum = 0;
  let count = 0;
  for (const series of results) {
    for (const v of series.values) {
      if (v.value > 0) {
        sum += v.value;
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 0;
}

function computeGrade(
  compliance: ComplianceSummary | null,
  flights: FlightSummary | null,
  decisions: Decision[],
): OperationalGrade {
  let score = 100;
  const issues: string[] = [];

  // Compliance penalties
  if (compliance) {
    if (compliance.violations > 0) {
      score -= compliance.violations * 15;
      issues.push(`${compliance.violations} compliance violation(s)`);
    }
    if (compliance.atRisk > 0) {
      score -= compliance.atRisk * 5;
      issues.push(`${compliance.atRisk} crew at risk`);
    }
  }

  // Flight penalties
  if (flights) {
    if (flights.cancelled > 0) {
      score -= flights.cancelled * 20;
      issues.push(`${flights.cancelled} flight(s) cancelled`);
    }
    if (flights.delayed > 0) {
      score -= flights.delayed * 5;
      issues.push(`${flights.delayed} flight(s) delayed`);
    }
  }

  // Bonus for proactive decisions
  const proactiveDecisions = decisions.filter(d =>
    d.description.includes('Rebooked') || d.description.includes('provenance'),
  );
  if (proactiveDecisions.length > 0) {
    score = Math.min(100, score + proactiveDecisions.length * 3);
  }

  score = Math.max(0, Math.min(100, score));

  const letter: OperationalGrade['letter'] =
    score >= 90 ? 'A' :
    score >= 80 ? 'B' :
    score >= 70 ? 'C' :
    score >= 60 ? 'D' : 'F';

  const rationale = issues.length > 0
    ? `Score impacted by: ${issues.join(', ')}`
    : 'Clean operation — no violations, delays, or cancellations';

  return { letter, score, rationale };
}
