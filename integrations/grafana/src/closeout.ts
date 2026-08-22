/**
 * Closeout report — post-game operational chronology.
 *
 * After a game ends, the Closeout queries Loki for the full agent decision
 * trail and builds a structured summary: what happened, when the system
 * knew it, and how it responded.
 *
 * The report is served at /api/closeout/:gameId and can also be pushed
 * back to Grafana as an annotation on the game's timeline.
 */

import type { LokiLogger } from './loki.js';

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
  constructor(private loki: LokiLogger) {}

  /**
   * Generate a Closeout report for a completed game.
   *
   * Queries Loki for all events related to the game and synthesizes
   * a chronological operational report.
   */
  async generate(
    gameId: string,
    opts?: { from?: Date; to?: Date },
  ): Promise<CloseoutReport> {
    const entries = await this.loki.queryGameLogs(gameId, {
      from: opts?.from,
      to: opts?.to,
      limit: 2000,
    });

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
    };
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
