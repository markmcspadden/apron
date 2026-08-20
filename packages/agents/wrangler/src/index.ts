/**
 * WRANGLER agent — constraint gathering with crew outreach.
 *
 * WRANGLER exists to move facts up the provenance table: it turns an
 * unconfirmed inference into a confirmed constraint without requiring the
 * crew member to disclose who they are working for.
 *
 * A constraint is enough to route correctly — "must be at MCI by Mon 13:00 CT"
 * — without revealing who they're working for.
 *
 * Two modes:
 *   1. Fixture replay (process) — plays back scripted provenance/agent-status steps
 *   2. Live monitoring (startWatching/stopWatching) — scans crew for inferred/none
 *      provenance, initiates outreach, and parses responses via Gemini
 *
 * Capabilities: read:constraints, write:constraints
 * Never receives: undisclosed-next-call, third-party-call-sheets
 *
 * Outreach channels (extensible):
 *   - simulated: Gemini generates realistic crew responses for demo/dev
 *   - sms: (future) sends SMS via Twilio/similar, parses natural-language replies
 *   - in-app: (future) in-app notification/response flow
 *
 * "WRANGLER reads constraints crew choose to disclose."
 */

import { BaseAgent } from '@apron/orchestrator';
import type { FixtureStep, CrewGameAssignment, OutreachStatus } from '@apron/types';
import type { GeminiClient } from '@apron/integration-google-cloud';
import type { TwilioClient } from '@apron/integration-twilio';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** How often the heartbeat re-scans crew for new outreach needs (ms) — 15 min */
const HEARTBEAT_INTERVAL = 15 * 60 * 1000;

/** How long to wait for a crew response before marking expired (ms) — 30 min */
const OUTREACH_TIMEOUT_MS = 30 * 60 * 1000;

/** Max log entries to keep in the ring buffer */
const MAX_LOG_ENTRIES = 200;

// ---------------------------------------------------------------------------
// Log entry
// ---------------------------------------------------------------------------

export type WranglerLogLevel = 'info' | 'outreach' | 'constraint' | 'alert' | 'error';

export interface WranglerLogEntry {
  timestamp: string;
  level: WranglerLogLevel;
  message: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Config & status
// ---------------------------------------------------------------------------

export interface WranglerWatchConfig {
  /** Game ID. */
  gameId: string;
  /** Account ID. */
  accountId: string;
  /** Gemini client for response parsing + simulated outreach. */
  gemini: GeminiClient;
  /** Twilio client for SMS outreach (optional — falls back to simulated). */
  twilio?: TwilioClient;
  /** Injected by server — loads current crew assignments from the store. */
  getCrewAssignments: () => Promise<CrewGameAssignment[]>;
  /** Outreach channel — defaults to 'simulated'. */
  channel?: 'simulated' | 'sms' | 'in-app';
}

/** Tracked outreach for one crew member. */
export interface OutreachRecord {
  crewId: string;
  name: string;
  position: string;
  homeAirport: string;
  /** E.164 phone number for SMS outreach. */
  phone: string | null;

  status: OutreachStatus;
  channel: string;
  sentAt: string | null;
  respondedAt: string | null;

  /** The inferred data we're trying to confirm. */
  inferredDestination: string | null;
  inferredCallTime: string | null;

  /** Parsed constraint from crew response. */
  constraint: {
    text: string;
    destinationAirport: string | null;
    deadlineIso: string | null;
    deadlineDisplay: string | null;
    attributed: boolean;
    attribution: string | null;
  } | null;

  previousProvenance: string;
  newProvenance: string;
}

/** WRANGLER constraint snapshot. */
export interface ConstraintSnapshot {
  timestamp: string;
  trigger: 'game-started' | 'heartbeat' | 'outreach-result' | 'crew-changed';
  crew: OutreachRecord[];
  summary: {
    total: number;
    needsOutreach: number;
    ready: number;
    pending: number;
    confirmed: number;
    declined: number;
    expired: number;
    notNeeded: number;
  };
  summaryText: string;
}

export interface WranglerStatus {
  watching: boolean;
  startedAt: string | null;
  config: {
    gameId: string;
    accountId: string;
    channel: string;
  } | null;
  lastSnapshot: ConstraintSnapshot | null;
  logTotal: number;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class WranglerAgent extends BaseAgent {
  private watchConfig: WranglerWatchConfig | null = null;
  private watchStartedAt: string | null = null;
  private lastSnapshot: ConstraintSnapshot | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private evaluating = false;
  private logBuffer: WranglerLogEntry[] = [];
  private logTotal = 0;

  /** Tracked outreach state — survives across scans. */
  private outreachMap = new Map<string, OutreachRecord>();

  constructor() {
    super('WRANGLER');
  }

  // ---- Logging ----

  private log(level: WranglerLogLevel, message: string, data?: Record<string, unknown>): void {
    const entry: WranglerLogEntry = { timestamp: new Date().toISOString(), level, message };
    if (data) entry.data = data;
    this.logBuffer.push(entry);
    this.logTotal++;
    if (this.logBuffer.length > MAX_LOG_ENTRIES) {
      this.logBuffer = this.logBuffer.slice(-MAX_LOG_ENTRIES);
    }
  }

  // ---- Public API ----

  /**
   * Start live constraint monitoring.
   *
   * Three triggers:
   *   1. Startup — runs immediately, identifies crew needing outreach
   *   2. Heartbeat — every 15 minutes, checks for new inferred data + timeouts
   *   3. Crew change — server calls onCrewChanged()
   */
  startWatching(config: WranglerWatchConfig): void {
    this.watchConfig = config;
    this.watchStartedAt = new Date().toISOString();
    this.lastSnapshot = null;
    this.evaluating = false;
    this.logBuffer = [];
    this.logTotal = 0;
    this.outreachMap.clear();

    this.log('info', `Constraint monitoring started for game ${config.gameId}`);
    console.log(`[wrangler] Constraint monitoring started for game ${config.gameId}`);

    this.emit({
      type: 'agent-status',
      message: 'WRANGLER constraint monitoring started',
      agentStates: { WRANGLER: 'on' },
    });

    // 1. Initial scan — identify crew needing outreach
    void this.scanAndOutreach('game-started');

    // 2. Heartbeat timer — check for new inferred data + expire old outreach
    this.heartbeatTimer = setInterval(() => {
      this.log('info', 'Heartbeat — constraint re-scan');
      console.log(`[wrangler] Heartbeat for game ${config.gameId}`);
      void this.scanAndOutreach('heartbeat');
    }, HEARTBEAT_INTERVAL);
  }

  /**
   * Stop monitoring.
   */
  stopWatching(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.watchConfig) {
      this.log('info', `Constraint monitoring stopped for game ${this.watchConfig.gameId}`);
      console.log(`[wrangler] Constraint monitoring stopped for game ${this.watchConfig.gameId}`);
      this.emit({
        type: 'agent-status',
        message: 'WRANGLER constraint monitoring stopped',
        agentStates: { WRANGLER: 'off' },
      });
    }
    this.watchConfig = null;
  }

  /**
   * Called by the server when crew data changes.
   */
  onCrewChanged(): void {
    if (!this.watchConfig) return;
    this.log('info', 'Crew data changed — re-scanning for constraint needs');
    console.log(`[wrangler] Crew change trigger for game ${this.watchConfig.gameId}`);
    void this.scanAndOutreach('crew-changed');
  }

  /**
   * Get the last constraint snapshot.
   */
  getLastSnapshot(): ConstraintSnapshot | null {
    return this.lastSnapshot;
  }

  /**
   * Get current status.
   */
  getStatus(): WranglerStatus {
    return {
      watching: this.watchConfig !== null,
      startedAt: this.watchStartedAt,
      config: this.watchConfig ? {
        gameId: this.watchConfig.gameId,
        accountId: this.watchConfig.accountId,
        channel: this.watchConfig.channel ?? 'simulated',
      } : null,
      lastSnapshot: this.lastSnapshot,
      logTotal: this.logTotal,
    };
  }

  /**
   * Get log entries.
   */
  getLog(n: number = MAX_LOG_ENTRIES): WranglerLogEntry[] {
    return this.logBuffer.slice(-n);
  }

  isWatching(): boolean {
    return this.watchConfig !== null;
  }

  /**
   * Request outreach for a specific crew member.
   *
   * Called when the operator clicks "Request Next Call" in the dashboard.
   * Transitions a 'ready' record to 'pending' and runs the simulation.
   */
  async requestOutreach(crewId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.watchConfig) {
      return { ok: false, error: 'WRANGLER is not watching' };
    }

    const record = this.outreachMap.get(crewId);
    if (!record) {
      return { ok: false, error: `No outreach record for crew ${crewId}` };
    }

    if (record.status === 'pending' || record.status === 'confirmed') {
      return { ok: false, error: `Crew ${record.name} is already ${record.status}` };
    }

    // Transition to pending (from ready, not-needed, expired, or declined)
    const previousStatus = record.status;
    record.status = 'pending';
    record.sentAt = new Date().toISOString();

    this.log('outreach', `${record.name} (${record.position}): operator requested outreach via ${record.channel}`, {
      crewId: record.crewId,
      inferredDestination: record.inferredDestination,
      inferredCallTime: record.inferredCallTime,
    });

    // Find the matching crew assignment for full context
    const assignments = await this.watchConfig.getCrewAssignments();
    const ca = assignments.find(a => a.crewId === crewId);

    if (!ca) {
      record.status = previousStatus;
      record.sentAt = null;
      return { ok: false, error: `Crew ${crewId} not found in assignments` };
    }

    // Fire and forget — initiateOutreach will update the record and emit events
    void this.initiateOutreach(record, ca);

    return { ok: true };
  }

  /**
   * Handle an incoming SMS response from a crew member.
   *
   * Called by the webhook when Twilio delivers a reply. Matches the phone
   * number to a pending outreach record, logs the raw text, and passes it
   * to Gemini for constraint extraction.
   */
  async handleIncomingSms(phone: string, text: string): Promise<{ ok: boolean; crewId?: string; error?: string }> {
    if (!this.watchConfig) {
      return { ok: false, error: 'WRANGLER is not watching' };
    }

    // Find the pending outreach record for this phone number
    let record: OutreachRecord | null = null;
    for (const r of this.outreachMap.values()) {
      if (r.phone === phone && r.status === 'pending' && r.channel === 'sms') {
        record = r;
        break;
      }
    }

    if (!record) {
      this.log('info', `Incoming SMS from ${phone} — no matching pending outreach`, { phone });
      return { ok: false, error: `No pending SMS outreach for phone ${phone}` };
    }

    this.log('outreach', `${record.name} responded via SMS: "${text}"`, {
      crewId: record.crewId,
      phone,
      rawResponse: text,
    });

    // Parse the response with Gemini
    const { gemini } = this.watchConfig;
    if (gemini.isEnabled()) {
      try {
        await this.parseAndApplyResponse(gemini, record, text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log('error', `SMS response parsing failed for ${record.name}: ${msg}`);
      }
    } else {
      // Fixture mode — auto-confirm
      record.respondedAt = new Date().toISOString();
      record.status = 'confirmed';
      record.newProvenance = 'confirmed';
      record.constraint = {
        text,
        destinationAirport: null,
        deadlineIso: null,
        deadlineDisplay: null,
        attributed: false,
        attribution: null,
      };
      this.log('constraint', `${record.name}: SMS response auto-confirmed (no Gemini) — "${text}"`, {
        crewId: record.crewId,
      });
      void this.scanAndOutreach('outreach-result');
    }

    return { ok: true, crewId: record.crewId };
  }

  /**
   * Find a crew member's outreach record by phone number.
   * Used by the server to route incoming SMS to the correct WRANGLER instance.
   */
  findByPhone(phone: string): OutreachRecord | null {
    for (const r of this.outreachMap.values()) {
      if (r.phone === phone && r.status === 'pending' && r.channel === 'sms') {
        return r;
      }
    }
    return null;
  }

  // ---- Core logic ----

  /**
   * Scan crew, identify those needing outreach, initiate or check outreach.
   */
  private async scanAndOutreach(trigger: ConstraintSnapshot['trigger']): Promise<void> {
    if (!this.watchConfig) return;
    if (this.evaluating) {
      this.log('info', `Scan already in progress — skipping ${trigger}`);
      return;
    }

    this.evaluating = true;

    try {
      const assignments = await this.watchConfig.getCrewAssignments();

      if (assignments.length === 0) {
        this.log('info', 'No crew assignments found');
        this.evaluating = false;
        return;
      }

      const now = new Date();

      // Process each crew member
      for (const ca of assignments) {
        const existing = this.outreachMap.get(ca.crewId);
        const prov = ca.nextCall.provenance;

        // Determine if this crew member needs outreach
        const needsOutreach = (prov.level === 'inferred' || prov.level === 'none')
          && ca.nextCall.type !== 'home';

        if (!needsOutreach) {
          // Already confirmed/sheet/external — no outreach needed
          if (!existing || existing.status === 'pending') {
            this.outreachMap.set(ca.crewId, {
              crewId: ca.crewId,
              name: ca.name,
              position: ca.position,
              homeAirport: ca.homeAirport,
              phone: ca.phone ?? null,
              status: 'not-needed',
              channel: this.watchConfig.channel ?? 'simulated',
              sentAt: null,
              respondedAt: null,
              inferredDestination: null,
              inferredCallTime: null,
              constraint: null,
              previousProvenance: prov.level,
              newProvenance: prov.level,
            });
          }
          continue;
        }

        // Already tracked and resolved — skip
        if (existing && (existing.status === 'confirmed' || existing.status === 'declined')) {
          continue;
        }

        // Check for timeout on pending outreach
        if (existing?.status === 'pending' && existing.sentAt) {
          const sentTime = new Date(existing.sentAt).getTime();
          if (now.getTime() - sentTime > OUTREACH_TIMEOUT_MS) {
            existing.status = 'expired';
            existing.newProvenance = existing.previousProvenance;
            this.log('outreach', `${ca.name} (${ca.position}): outreach expired — no response after ${OUTREACH_TIMEOUT_MS / 60000}min`, {
              crewId: ca.crewId,
            });
            continue;
          }
          // Still pending — leave it
          continue;
        }

        // New outreach needed — mark as ready (operator triggers via button)
        if (!existing || existing.status === 'expired') {
          const record: OutreachRecord = {
            crewId: ca.crewId,
            name: ca.name,
            position: ca.position,
            homeAirport: ca.homeAirport,
            phone: ca.phone ?? null,
            status: 'ready',
            channel: this.watchConfig.channel ?? 'simulated',
            sentAt: null,
            respondedAt: null,
            inferredDestination: ca.nextCall.destinationCity || ca.nextCall.destinationAirport || null,
            inferredCallTime: ca.nextCall.callTime?.display ?? null,
            constraint: null,
            previousProvenance: prov.level,
            newProvenance: prov.level,
          };

          this.outreachMap.set(ca.crewId, record);

          this.log('outreach', `${ca.name} (${ca.position}): ready for constraint outreach`, {
            crewId: ca.crewId,
            inferredDestination: record.inferredDestination,
            inferredCallTime: record.inferredCallTime,
          });
        }
      }

      // Build snapshot
      const crewEntries = Array.from(this.outreachMap.values());
      const summary = {
        total: crewEntries.length,
        needsOutreach: crewEntries.filter(c => c.status !== 'not-needed').length,
        ready: crewEntries.filter(c => c.status === 'ready').length,
        pending: crewEntries.filter(c => c.status === 'pending').length,
        confirmed: crewEntries.filter(c => c.status === 'confirmed').length,
        declined: crewEntries.filter(c => c.status === 'declined').length,
        expired: crewEntries.filter(c => c.status === 'expired').length,
        notNeeded: crewEntries.filter(c => c.status === 'not-needed').length,
      };

      const parts: string[] = [`${summary.total} crew tracked`];
      if (summary.needsOutreach > 0) {
        parts.push(`${summary.needsOutreach} need${summary.needsOutreach !== 1 ? '' : 's'} outreach`);
      }
      if (summary.ready > 0) parts.push(`${summary.ready} ready`);
      if (summary.pending > 0) parts.push(`${summary.pending} pending`);
      if (summary.confirmed > 0) parts.push(`${summary.confirmed} confirmed`);
      if (summary.declined > 0) parts.push(`${summary.declined} declined`);
      if (summary.expired > 0) parts.push(`${summary.expired} expired`);
      const summaryText = parts.join(' · ');

      const snapshot: ConstraintSnapshot = {
        timestamp: now.toISOString(),
        trigger,
        crew: crewEntries,
        summary,
        summaryText,
      };

      this.lastSnapshot = snapshot;

      this.log('constraint', summaryText, {
        total: summary.total,
        pending: summary.pending,
        confirmed: summary.confirmed,
        declined: summary.declined,
      });

      // Emit constraint-update event
      this.emit({
        type: 'constraint-update',
        message: summaryText,
        trigger,
        crew: crewEntries.map(c => ({
          crewId: c.crewId,
          name: c.name,
          position: c.position,
          outreach: {
            status: c.status,
            sentAt: c.sentAt,
            respondedAt: c.respondedAt,
            channel: c.channel,
          },
          constraint: c.constraint,
          previousProvenance: c.previousProvenance,
          newProvenance: c.newProvenance,
        })),
        summary,
      });

      console.log(`[wrangler] Scan complete (${trigger}): ${summaryText}`);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `Scan failed: ${msg}`);
      console.error(`[wrangler] Scan error (${trigger}):`, msg);
    } finally {
      this.evaluating = false;
    }
  }

  /**
   * Initiate outreach to a crew member.
   *
   * For now, uses Gemini to simulate a realistic crew response.
   * Future: SMS via Twilio, in-app notification, etc.
   */
  private async initiateOutreach(record: OutreachRecord, ca: CrewGameAssignment): Promise<void> {
    if (!this.watchConfig) return;
    const { gemini, twilio } = this.watchConfig;
    const channel = record.channel;

    // SMS channel — send a real text message via Twilio
    if (channel === 'sms' && twilio?.isEnabled() && record.phone) {
      try {
        const smsBody = `Hey ${record.name.split(' ')[0]}, it's the travel desk. Where do you need to be after tonight's show? Just the city and time is all we need.`;
        const result = await twilio.sendSms(record.phone, smsBody);
        if (result.ok) {
          this.log('outreach', `${record.name}: SMS sent to ${record.phone} (SID: ${result.sid})`, {
            crewId: record.crewId,
            phone: record.phone,
            smsSid: result.sid,
          });
          // Now waiting for webhook callback — record stays pending
        } else {
          this.log('error', `${record.name}: SMS failed — ${result.error}`, { crewId: record.crewId });
          // Fall back to simulated
          record.channel = 'simulated';
          this.log('info', `${record.name}: falling back to simulated outreach`);
          void this.initiateOutreach(record, ca);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log('error', `SMS outreach failed for ${record.name}: ${msg}`);
      }
      return;
    }

    // Simulated channel — Gemini or fixture mode
    if (!gemini.isEnabled()) {
      // Fixture mode — simulate a quick confirmation after a short delay
      setTimeout(() => {
        this.handleSimulatedResponse(record, ca);
      }, 3000 + Math.random() * 5000);
      return;
    }

    // Use Gemini to generate a realistic crew response
    try {
      const response = await this.generateCrewResponse(gemini, record, ca);
      if (response) {
        this.log('outreach', `${record.name} responded: "${response}"`, {
          crewId: record.crewId,
          rawResponse: response,
        });
        await this.parseAndApplyResponse(gemini, record, response);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `Outreach failed for ${record.name}: ${msg}`);
    }
  }

  /**
   * Generate a simulated crew response using Gemini.
   */
  private async generateCrewResponse(
    gemini: GeminiClient,
    record: OutreachRecord,
    ca: CrewGameAssignment,
  ): Promise<string | null> {
    const prompt = `You are simulating a freelance broadcast crew member responding to a travel coordinator's message asking about their next commitment after tonight's show.

The crew member is:
- Name: ${record.name}
- Position: ${record.position}
- Home airport: ${record.homeAirport}

We believe (inferred, not confirmed) they are heading to:
- Destination: ${record.inferredDestination ?? 'unknown'}
- Call time: ${record.inferredCallTime ?? 'unknown'}

The crew member's actual next call type is: ${ca.nextCall.type}
${ca.nextCall.production ? `Their actual production: ${ca.nextCall.production.name}` : ''}
${ca.nextCall.destinationCity ? `Their actual destination: ${ca.nextCall.destinationCity}` : ''}
${ca.nextCall.callTime ? `Their actual call time: ${ca.nextCall.callTime.display}` : ''}

IMPORTANT: The crew member should respond naturally as a person would to a text message. They should share their CONSTRAINT (when and where they need to be) but may or may not name the specific production — that's their choice.

Do NOT include timezone abbreviations (PT, CT, ET, MT, etc.) in the response — real crew just say the time without the timezone, e.g. "by Monday 1pm" not "by Monday 1pm CT". The constraint system infers timezone from the destination city.

About 70% of the time, crew share just the constraint: "Need to be in KC by Monday 1pm"
About 20% of the time, they attribute it: "Yeah I've got MNF in KC, call is 2pm Monday"
About 10% of the time, they decline: "I'll sort it out myself" or "Haven't confirmed yet"

Respond with ONLY the crew member's text message reply, nothing else. Keep it casual, like a real text — 1-2 sentences max.`;

    try {
      const result = await gemini.prompt({
        agent: 'WRANGLER',
        query: prompt,
        context: {
          crewName: record.name,
          position: record.position,
          homeAirport: record.homeAirport,
        },
        systemInstruction: 'You are simulating a freelance broadcast crew member. Respond with ONLY their text message reply, nothing else.',
      });
      return result?.text ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Parse a crew member's natural-language response into a structured constraint.
   */
  private async parseAndApplyResponse(
    gemini: GeminiClient,
    record: OutreachRecord,
    response: string,
  ): Promise<void> {
    const parsePrompt = `Parse this crew member's text message response about their next commitment after tonight's show. Extract a structured constraint.

Crew member: ${record.name} (${record.position})
Home airport: ${record.homeAirport}
Response: "${response}"

Respond in JSON format:
{
  "status": "confirmed" | "declined",
  "constraintText": "human-readable constraint, e.g. 'must be at MCI by Mon 13:00 CT'",
  "destinationAirport": "IATA code or null",
  "deadlineDisplay": "e.g. 'Mon 13:00 CT' or null",
  "attributed": true/false (did they name a specific show/production?),
  "attribution": "show name if attributed, e.g. 'MNF · Kansas City', or null"
}

If the crew member declined or was vague, use status "declined" and leave constraint fields null.
Respond with ONLY the JSON, no other text.`;

    try {
      const parsed = await gemini.promptJSON<{
        status: 'confirmed' | 'declined';
        constraintText: string | null;
        destinationAirport: string | null;
        deadlineDisplay: string | null;
        attributed: boolean;
        attribution: string | null;
      }>({
        agent: 'WRANGLER',
        query: parsePrompt,
        context: {
          crewName: record.name,
          position: record.position,
          homeAirport: record.homeAirport,
          response,
        },
        systemInstruction: 'Parse the crew member response into a structured constraint. Return valid JSON only.',
      });

      if (!parsed) return;

      // Log the extraction result
      this.log('constraint',
        `${record.name}: extraction → status=${parsed.status}, constraint="${parsed.constraintText ?? '—'}", dest=${parsed.destinationAirport ?? '—'}, deadline=${parsed.deadlineDisplay ?? '—'}, attributed=${parsed.attributed}${parsed.attribution ? ` (${parsed.attribution})` : ''}`,
        { crewId: record.crewId, parsed },
      );

      record.respondedAt = new Date().toISOString();

      if (parsed.status === 'confirmed' && parsed.constraintText) {
        record.status = 'confirmed';
        record.newProvenance = 'confirmed';
        record.constraint = {
          text: parsed.constraintText,
          destinationAirport: parsed.destinationAirport,
          deadlineIso: null, // Would need timezone resolution
          deadlineDisplay: parsed.deadlineDisplay,
          attributed: parsed.attributed,
          attribution: parsed.attribution,
        };

        const attrSuffix = parsed.attributed && parsed.attribution
          ? ` (attributed: ${parsed.attribution})`
          : ' (constraint only — production not disclosed)';

        this.log('constraint',
          `${record.name} (${record.position}): constraint confirmed — "${parsed.constraintText}"${attrSuffix}`,
          {
            crewId: record.crewId,
            constraint: parsed.constraintText,
            attributed: parsed.attributed,
          },
        );

        // Emit provenance upgrade
        this.emit({
          type: 'provenance',
          message: `WRANGLER confirmed constraint for ${record.name}`,
          crewName: record.name,
          provenance: ['confirmed', 'crew-confirmed', `WRANGLER outreach · ${record.respondedAt}`],
          nextCall: parsed.constraintText,
        });

      } else {
        record.status = 'declined';
        record.newProvenance = record.previousProvenance;

        this.log('outreach',
          `${record.name} (${record.position}): declined to share constraint`,
          { crewId: record.crewId },
        );
      }

      // Re-emit snapshot with updated results
      void this.scanAndOutreach('outreach-result');

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `Response parsing failed for ${record.name}: ${msg}`);
    }
  }

  /**
   * Simulate a crew response in fixture/demo mode (no Gemini).
   */
  private handleSimulatedResponse(record: OutreachRecord, ca: CrewGameAssignment): void {
    if (!this.watchConfig) return;

    record.respondedAt = new Date().toISOString();

    // Simulate realistic response distribution
    const roll = Math.random();

    if (roll < 0.10) {
      // 10% decline
      const declineText = 'Haven\'t confirmed my next one yet, I\'ll sort it out';
      this.log('outreach', `${record.name} responded: "${declineText}" (simulated)`, {
        crewId: record.crewId, rawResponse: declineText,
      });

      record.status = 'declined';
      record.newProvenance = record.previousProvenance;

      this.log('constraint', `${record.name}: extraction → status=declined (simulated)`, {
        crewId: record.crewId,
      });
    } else {
      // 90% confirm (70% constraint only, 20% attributed)
      const dest = ca.nextCall.destinationCity || ca.nextCall.destinationAirport || 'unknown';
      const callTime = ca.nextCall.callTime?.display ?? 'TBD';
      const destAirport = ca.nextCall.destinationAirport;
      const attributed = roll >= 0.80; // 20% attribute the show

      const constraintText = `must be at ${destAirport ?? dest} by ${callTime}`;
      const attribution = attributed && ca.nextCall.production
        ? `${ca.nextCall.production.shortName ?? ca.nextCall.production.name} · ${ca.nextCall.destinationCity ?? ''}`
        : null;

      // Log the simulated crew text message — strip timezone abbreviations
      const callTimeNoTz = callTime.replace(/\s+[A-Z]{2,4}$/, '');
      const simText = attributed && attribution
        ? `Yeah I've got ${attribution}, need to be there by ${callTimeNoTz}`
        : `Need to be in ${dest} by ${callTimeNoTz}`;
      this.log('outreach', `${record.name} responded: "${simText}" (simulated)`, {
        crewId: record.crewId, rawResponse: simText,
      });

      record.status = 'confirmed';
      record.newProvenance = 'confirmed';

      record.constraint = {
        text: constraintText,
        destinationAirport: destAirport,
        deadlineIso: ca.nextCall.callTime?.iso ?? null,
        deadlineDisplay: callTime,
        attributed,
        attribution,
      };

      // Log the extraction
      this.log('constraint',
        `${record.name}: extraction → status=confirmed, constraint="${constraintText}", dest=${destAirport ?? '—'}, deadline=${callTime}${attributed && attribution ? `, attributed (${attribution})` : ', constraint only'} (simulated)`,
        { crewId: record.crewId, constraint: constraintText, attributed },
      );

      // Emit provenance upgrade
      this.emit({
        type: 'provenance',
        message: `WRANGLER confirmed constraint for ${record.name}`,
        crewName: record.name,
        provenance: ['confirmed', 'crew-confirmed', `WRANGLER outreach · ${record.respondedAt}`],
        nextCall: constraintText,
      });
    }

    // Re-emit snapshot
    void this.scanAndOutreach('outreach-result');
  }

  // ---------------------------------------------------------------------------
  // Fixture processing (existing behavior)
  // ---------------------------------------------------------------------------

  async process(input: Record<string, unknown>): Promise<void> {
    const step = input['step'] as FixtureStep;

    if (step.provenance) {
      for (const [crewName, prov] of Object.entries(step.provenance)) {
        this.emit({
          type: 'provenance',
          message: step.message,
          crewName,
          provenance: prov,
          nextCall: step.calls?.[crewName],
        });
      }
    }

    if (step.agentStates) {
      this.emit({
        type: 'agent-status',
        message: step.message,
        agentStates: step.agentStates,
      });
    }
  }
}
