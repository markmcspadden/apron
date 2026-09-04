/**
 * Grafana Agent Observability — real SDK integration.
 *
 * Uses @grafana/agento11y to trace every Gemini generation, sending
 * normalized LLM telemetry (input/output, tokens, latency, model) to
 * Grafana Cloud Agent Observability.
 *
 * The SDK auto-reads AGENTO11Y_* env vars when constructed with no args,
 * but we configure explicitly for clarity.
 *
 * Env vars:
 *   AGENTO11Y_ENDPOINT   — e.g. https://agento11y-prod-us-east-3.grafana.net
 *   AGENTO11Y_PROTOCOL   — "http" (default)
 *   AGENTO11Y_AUTH_MODE   — "basic"
 *   AGENTO11Y_AUTH_TENANT_ID — Grafana Cloud instance ID
 *   AGENTO11Y_AUTH_TOKEN  — Grafana Cloud API token
 */

import { Agento11yClient } from '@grafana/agento11y';
import type { GenerationRecorder, GenerationStart, GenerationResult } from '@grafana/agento11y';

// Re-export the recorder types for use in GeminiClient
export type { GenerationRecorder, GenerationStart, GenerationResult };

// ---------------------------------------------------------------------------
// Agent definitions — metadata for tagging generations
// ---------------------------------------------------------------------------

interface AgentDefinition {
  /** Agent name (e.g. "SPOTTER") */
  name: string;
  /** Human-readable description */
  description: string;
  /** System prompt or role summary */
  systemPrompt: string;
  /** Tools/capabilities this agent has */
  tools: { name: string; description: string }[];
}

/**
 * The 8 Apron agents, their roles, and their tool schemas.
 * These match the architecture described in CLAUDE.md.
 */
const APRON_AGENTS: AgentDefinition[] = [
  {
    name: 'SPOTTER',
    description: 'Monitors live game state, weather, and predicts end time. Drives the wrap-to-gate chain.',
    systemPrompt: `SPOTTER monitors live sporting events for crew operations. It polls ESPN for real-time scores, Weather.gov for venue conditions, and uses Gemini to predict game end times. Its predictions drive the wrap-to-gate chain that determines crew departure windows. SPOTTER escalates show state (clear → watch → risk → down) based on game conditions (extra innings, weather delays, overtime).`,
    tools: [
      { name: 'pollScore', description: 'Fetch current game state from ESPN scoreboard API' },
      { name: 'pollWeather', description: 'Fetch weather conditions from Weather.gov for the game venue' },
      { name: 'runPrediction', description: 'Use Gemini to predict game end time based on current state, pace, and weather' },
      { name: 'recomputeChain', description: 'Recalculate the wrap-to-gate chain based on new predicted end time' },
      { name: 'emitGameState', description: 'Broadcast game state update to all connected clients' },
    ],
  },
  {
    name: 'TRAFFIC',
    description: 'Monitors flight status for crew travel routing. Read-only — never sees crew identity.',
    systemPrompt: `TRAFFIC monitors flight status for crew travel. It polls AviationStack API for real-time flight data (delays, cancellations, gate changes). Per agent-separation rules, TRAFFIC is strictly read-only and never receives crew identity, next calls, or fare data — only anonymized flight references (carrier + number + date + airports). It emits delay/cancellation events that the server maps back to affected crew.`,
    tools: [
      { name: 'pollFlights', description: 'Poll AviationStack API for status of all monitored flights' },
      { name: 'emitFlightSummary', description: 'Broadcast flight summary metrics (on-time, delayed, cancelled)' },
      { name: 'emitFlightEvent', description: 'Emit a specific flight status change (delay, cancel, depart, land)' },
    ],
  },
  {
    name: 'ADVANCE',
    description: 'Roster state intelligence with provenance-aware disclosure. Manages what each seat can see.',
    systemPrompt: `ADVANCE reads crew sheets, call sheets, and roster data to determine where each crew member is heading next. Its core job is enforcing the disclosure model: what it can tell which audience about a crew member's next call, based on how that information was gathered. Redaction is enforced at the data layer, not the display layer.`,
    tools: [
      { name: 'scanRoster', description: 'Scan all crew assignments and build a provenance-aware roster snapshot' },
      { name: 'applyDisclosure', description: 'Apply seat-aware disclosure rules to a roster entry' },
      { name: 'emitRosterUpdate', description: 'Broadcast roster snapshot with per-seat visibility' },
    ],
  },
  {
    name: 'WRANGLER',
    description: 'Constraint gathering via crew outreach. Moves facts up the provenance table.',
    systemPrompt: `WRANGLER moves facts up the provenance table by turning unconfirmed inferences into confirmed constraints through crew outreach. It contacts crew members whose next calls are inferred or unknown and gathers confirmed constraints ("must be at MCI by Mon 13:00 CT") without requiring them to disclose who they work for.`,
    tools: [
      { name: 'scanForOutreach', description: 'Identify crew members with inferred/unknown next calls needing outreach' },
      { name: 'initiateOutreach', description: 'Send outreach message to crew member via configured channel (simulated/SMS)' },
      { name: 'parseResponse', description: 'Use Gemini to parse natural-language crew response into structured constraint' },
      { name: 'updateProvenance', description: 'Update crew member provenance from inferred → confirmed based on response' },
    ],
  },
  {
    name: 'STEWARD',
    description: 'Compliance monitoring for labor agreements. Tracks turnaround, overtime, and rest compression.',
    systemPrompt: `STEWARD monitors compliance with collective bargaining agreements (NABET-CWA Art. 8.3). It evaluates crew turnaround times, overtime exposure, meal penalties, and rest compression using Gemini to analyze the operational context against extracted agreement rules.`,
    tools: [
      { name: 'runEvaluation', description: 'Evaluate compliance for all crew against agreement rules using Gemini' },
      { name: 'evaluateImpact', description: 'Calculate turnaround, overtime, meal, and penalty impact for each crew member' },
      { name: 'emitComplianceUpdate', description: 'Broadcast compliance snapshot with per-crew status and exposure totals' },
    ],
  },
  {
    name: 'FIXER',
    description: 'Generates rebooking options for at-risk crew. Works with tokenized travelers.',
    systemPrompt: `FIXER generates rebooking options when crew members are at risk of missing their next call. It works with tokenized travelers (never sees identity directly) to find alternative routes using the curated flight schedule.`,
    tools: [
      { name: 'generateOptions', description: 'Generate rebooking option groups for at-risk crew using flight schedule' },
      { name: 'emitOptions', description: 'Present rebooking options to TMC desk for approval' },
      { name: 'emitRouteUpdate', description: 'Update crew route after human-approved rebook' },
    ],
  },
  {
    name: 'RUNNER',
    description: 'Composes and delivers post-game handoff communications.',
    systemPrompt: `RUNNER composes the handoff communication — the final operational summary that goes to crew after a game wraps. It aggregates state from all other agents (game result, chain times, rebookings, compliance status) into a structured handoff document.`,
    tools: [
      { name: 'composeHandoff', description: 'Aggregate state from all agents into a structured handoff document' },
      { name: 'emitHandoff', description: 'Deliver the handoff communication to connected clients' },
    ],
  },
  {
    name: 'CUSTOMS',
    description: 'Handles cross-border logistics. Dormant for domestic shows.',
    systemPrompt: `CUSTOMS manages cross-border crew logistics — gear carnets, visa requirements, customs declarations. It activates for international shows (Toronto, London, Mexico City) and any cross-border next call.`,
    tools: [],
  },
];

// ---------------------------------------------------------------------------
// Health tracking
// ---------------------------------------------------------------------------

export interface AgentO11yHealth {
  enabled: boolean;
  endpoint: string | null;
  status: 'not_configured' | 'ready' | 'error';
  generationsExported: number;
  lastError: string | null;
  startedAt: string | null;
}

const _health: AgentO11yHealth = {
  enabled: false,
  endpoint: null,
  status: 'not_configured',
  generationsExported: 0,
  lastError: null,
  startedAt: null,
};

/** Return the current Agent O11y health state. */
export function getAgentO11yHealth(): AgentO11yHealth {
  return { ..._health };
}

// ---------------------------------------------------------------------------
// Singleton client
// ---------------------------------------------------------------------------

let _client: Agento11yClient | null = null;

/**
 * Initialize the Agent O11y SDK client.
 *
 * The SDK reads AGENTO11Y_* env vars automatically. We configure
 * explicitly from env for clarity and to support the health endpoint.
 *
 * Call once at server startup. Returns the client (or null if not configured).
 */
export function initAgentO11y(): Agento11yClient | null {
  const endpoint = process.env['AGENTO11Y_ENDPOINT'];
  const protocol = (process.env['AGENTO11Y_PROTOCOL'] ?? 'http') as 'http' | 'grpc';
  const authMode = (process.env['AGENTO11Y_AUTH_MODE'] ?? 'basic') as 'basic' | 'bearer' | 'none';
  const tenantId = process.env['AGENTO11Y_AUTH_TENANT_ID'];
  const token = process.env['AGENTO11Y_AUTH_TOKEN'];

  if (!endpoint || !token) {
    console.log('[agento11y] Disabled — missing AGENTO11Y_ENDPOINT or AGENTO11Y_AUTH_TOKEN');
    _health.status = 'not_configured';
    return null;
  }

  try {
    _client = new Agento11yClient({
      generationExport: {
        protocol,
        endpoint,
        auth: {
          mode: authMode,
          tenantId,
          basicPassword: token,
        },
      },
      // Tags applied to every generation
      tags: {
        project: 'apron',
        hackathon: 'agentic-cinema-2026',
      },
    });

    _health.enabled = true;
    _health.endpoint = endpoint;
    _health.status = 'ready';
    _health.startedAt = new Date().toISOString();

    console.log(`[agento11y] Client initialized — endpoint: ${endpoint}, protocol: ${protocol}`);
    return _client;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[agento11y] Failed to initialize client: ${msg}`);
    _health.status = 'error';
    _health.lastError = msg;
    return null;
  }
}

/** Get the singleton client (null if not initialized or not configured). */
export function getAgentO11yClient(): Agento11yClient | null {
  return _client;
}

/**
 * Record a successful generation export.
 * Called by the GeminiClient after a traced generation completes.
 */
export function recordGenerationExported(): void {
  _health.generationsExported++;
}

/**
 * Record an error during generation tracing.
 */
export function recordGenerationError(err: string): void {
  _health.lastError = err;
}

/** Expose the agent definitions for external use (e.g. Closeout report). */
export function getAgentDefinitions(): AgentDefinition[] {
  return [...APRON_AGENTS];
}

/**
 * Get the O11y tool definitions for a specific agent.
 * These are passed to startGeneration() so the Agent O11y dashboard
 * shows what tools each agent has available.
 */
export function getAgentToolDefs(agentName: string): { name: string; description?: string }[] {
  const agent = APRON_AGENTS.find(a => a.name === agentName);
  if (!agent) return [];
  return agent.tools.map(t => ({ name: t.name, description: t.description }));
}

/**
 * Graceful shutdown — flush pending generations.
 */
export async function shutdownAgentO11y(): Promise<void> {
  if (_client) {
    await _client.shutdown();
    console.log('[agento11y] Client shut down');
  }
}
