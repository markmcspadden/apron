/**
 * Grafana Agent Observability registration.
 *
 * Registers Apron's 8 agents with Grafana's Agent Observability product,
 * providing the system prompt and tool schema for each agent. This lets
 * Grafana's AI tools understand what each agent does, and enables eval
 * rules for quality tracking.
 *
 * Requires: GRAFANA_URL (Grafana instance), GRAFANA_CLOUD_API_KEY
 */

interface AgentDefinition {
  /** Agent name (e.g. "SPOTTER") */
  name: string;
  /** Human-readable description */
  description: string;
  /** System prompt or role summary */
  systemPrompt: string;
  /** Tools/capabilities this agent has */
  tools: ToolDefinition[];
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

interface AgentO11yConfig {
  /** Grafana instance URL (e.g. https://modestsalmon3417.grafana.net) */
  grafanaUrl: string;
  /** API key with agent-observability write scope */
  apiKey: string;
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
    systemPrompt: `ADVANCE reads crew sheets, call sheets, and roster data to determine where each crew member is heading next. Its core job is enforcing the disclosure model: what it can tell which audience about a crew member's next call, based on how that information was gathered. Redaction is enforced at the data layer, not the display layer. Disclosure rules: next call on own show → full detail; external disclosed → full detail; external not disclosed → "External call · withheld"; brokered → constraint only; inferred → marked inferred.`,
    tools: [
      { name: 'scanRoster', description: 'Scan all crew assignments and build a provenance-aware roster snapshot' },
      { name: 'applyDisclosure', description: 'Apply seat-aware disclosure rules to a roster entry' },
      { name: 'emitRosterUpdate', description: 'Broadcast roster snapshot with per-seat visibility' },
    ],
  },
  {
    name: 'WRANGLER',
    description: 'Constraint gathering via crew outreach. Moves facts up the provenance table.',
    systemPrompt: `WRANGLER moves facts up the provenance table by turning unconfirmed inferences into confirmed constraints through crew outreach. It contacts crew members whose next calls are inferred or unknown and gathers confirmed constraints ("must be at MCI by Mon 13:00 CT") without requiring them to disclose who they work for. Supports simulated outreach (Gemini for demo) and SMS (Twilio for production). Gemini parses natural-language crew responses into structured constraints.`,
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
    systemPrompt: `STEWARD monitors compliance with collective bargaining agreements (NABET-CWA Art. 8.3). It evaluates crew turnaround times, overtime exposure, meal penalties, and rest compression using Gemini to analyze the operational context against extracted agreement rules. Evaluations are triggered by game state changes, chain updates, and crew rebooking events. STEWARD escalates show state when violations are detected.`,
    tools: [
      { name: 'runEvaluation', description: 'Evaluate compliance for all crew against agreement rules using Gemini' },
      { name: 'evaluateImpact', description: 'Calculate turnaround, overtime, meal, and penalty impact for each crew member' },
      { name: 'emitComplianceUpdate', description: 'Broadcast compliance snapshot with per-crew status and exposure totals' },
    ],
  },
  {
    name: 'FIXER',
    description: 'Generates rebooking options for at-risk crew. Works with tokenized travelers.',
    systemPrompt: `FIXER generates rebooking options when crew members are at risk of missing their next call. It works with tokenized travelers (never sees identity directly) to find alternative routes using the curated flight schedule. Options are grouped and presented to the TMC desk for human approval. Nothing irreversible happens without explicit human confirmation.`,
    tools: [
      { name: 'generateOptions', description: 'Generate rebooking option groups for at-risk crew using flight schedule' },
      { name: 'emitOptions', description: 'Present rebooking options to TMC desk for approval' },
      { name: 'emitRouteUpdate', description: 'Update crew route after human-approved rebook' },
    ],
  },
  {
    name: 'RUNNER',
    description: 'Composes and delivers post-game handoff communications.',
    systemPrompt: `RUNNER composes the handoff communication — the final operational summary that goes to crew after a game wraps. It aggregates state from all other agents (game result, chain times, rebookings, compliance status) into a structured handoff document. RUNNER is the last agent to act after a show closes.`,
    tools: [
      { name: 'composeHandoff', description: 'Aggregate state from all agents into a structured handoff document' },
      { name: 'emitHandoff', description: 'Deliver the handoff communication to connected clients' },
    ],
  },
  {
    name: 'CUSTOMS',
    description: 'Handles cross-border logistics. Dormant for domestic shows.',
    systemPrompt: `CUSTOMS manages cross-border crew logistics — gear carnets, visa requirements, customs declarations. It activates for international shows (Toronto, London, Mexico City) and any cross-border next call. Dormant and not provisioned for domestic shows.`,
    tools: [],
  },
];

// ---------------------------------------------------------------------------
// Health tracking
// ---------------------------------------------------------------------------

export interface AgentO11yHealth {
  enabled: boolean;
  url: string | null;
  status: 'not_configured' | 'pending' | 'registered' | 'partial' | 'failed';
  registered: number;
  total: number;
  lastError: string | null;
  attemptedAt: string | null;
}

const _health: AgentO11yHealth = {
  enabled: !!(process.env['GRAFANA_URL'] && process.env['GRAFANA_CLOUD_API_KEY']),
  url: process.env['GRAFANA_URL'] ?? null,
  status: (process.env['GRAFANA_URL'] && process.env['GRAFANA_CLOUD_API_KEY']) ? 'pending' : 'not_configured',
  registered: 0,
  total: APRON_AGENTS.length,
  lastError: null,
  attemptedAt: null,
};

/** Return the current Agent O11y health state. */
export function getAgentO11yHealth(): AgentO11yHealth {
  return { ..._health };
}

/**
 * Register all Apron agents with Grafana Agent Observability.
 *
 * Uses the agento11y API to create/update agent definitions so Grafana
 * can track agent behavior and enable eval rules.
 *
 * Returns the number of agents successfully registered.
 */
export async function registerAgents(): Promise<number> {
  const grafanaUrl = process.env['GRAFANA_URL'];
  const apiKey = process.env['GRAFANA_CLOUD_API_KEY'];

  if (!grafanaUrl || !apiKey) {
    console.log('[grafana-agento11y] Disabled — missing GRAFANA_URL or GRAFANA_CLOUD_API_KEY');
    _health.status = 'not_configured';
    return 0;
  }

  _health.attemptedAt = new Date().toISOString();
  const config: AgentO11yConfig = { grafanaUrl, apiKey };
  let registered = 0;
  let lastErr: string | null = null;

  for (const agent of APRON_AGENTS) {
    try {
      await registerAgent(config, agent);
      registered++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[grafana-agento11y] Failed to register ${agent.name}: ${msg}`);
      lastErr = `${agent.name}: ${msg}`;
    }
  }

  _health.registered = registered;
  _health.lastError = lastErr;
  if (registered === APRON_AGENTS.length) {
    _health.status = 'registered';
  } else if (registered > 0) {
    _health.status = 'partial';
  } else {
    _health.status = 'failed';
  }

  console.log(`[grafana-agento11y] Registered ${registered}/${APRON_AGENTS.length} agents`);
  return registered;
}

async function registerAgent(config: AgentO11yConfig, agent: AgentDefinition): Promise<void> {
  const payload = {
    name: `apron-${agent.name.toLowerCase()}`,
    display_name: `Apron ${agent.name}`,
    description: agent.description,
    system_prompt: agent.systemPrompt,
    tools: agent.tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? {},
    })),
    metadata: {
      project: 'apron',
      hackathon: 'agentic-cinema-2026',
    },
  };

  const res = await fetch(`${config.grafanaUrl}/api/plugins/grafana-agentobservability-app/resources/agents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (res.status === 409) {
    // Already registered — try PUT to update
    await fetch(`${config.grafanaUrl}/api/plugins/grafana-agentobservability-app/resources/agents/${payload.name}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    console.log(`[grafana-agento11y] Updated ${agent.name}`);
  } else if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  } else {
    console.log(`[grafana-agento11y] Registered ${agent.name}`);
  }
}

/** Expose the agent definitions for external use (e.g. Closeout report). */
export function getAgentDefinitions(): AgentDefinition[] {
  return [...APRON_AGENTS];
}
