/**
 * Agreement loader and Gemini-powered rule extraction for the STEWARD agent.
 *
 * Two extraction modes, both using Gemini:
 *   1. One-time structured extraction — pulls turnaround, overtime, meal,
 *      penalty, and schedule-change rules into a machine-evaluable RulePack
 *   2. Live query — sends agreement text + operational context to Gemini
 *      for ad-hoc questions during a game
 *
 * The full agreement text is stored in the STEWARD agent record on the game
 * document so it's available for live queries without re-reading the PDF.
 */

import type { GeminiClient } from '@apron/integration-google-cloud';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata about an agreement document tied to a game. */
export interface AgreementMeta {
  id: string;
  name: string;
  parties: string;
  effectiveDate: string;
  expirationDate: string;
  /** Size of the full text in characters */
  textLength: number;
  /** When the agreement was loaded */
  loadedAt: string;
  /** Source URL or file path */
  source: string;
}

/** Structured rules extracted from the agreement via Gemini. */
export interface ExtractedRules {
  turnaround: {
    /** Minimum hours between end of schedule and start of next */
    minimumHours: number;
    /** Day-off minimum consecutive hours */
    dayOffHours: number;
    /** Two-day-off minimum consecutive hours */
    twoDayOffHours: number;
    /** Penalty rate per hour for encroachment */
    penaltyPerHour: number;
    /** Higher penalty rate for first 4 hours after schedule end */
    earlyPenaltyPerHour: number;
    /** Article/section reference */
    citation: string;
  };
  overtime: {
    /** Hours in a regular work day before OT kicks in */
    regularDayHours: number;
    /** OT multiplier (e.g. 1.5 = time and a half) */
    multiplier: number;
    /** Computed in 1/10 hour segments */
    computationSegment: string;
    citation: string;
  };
  meals: {
    /** Per diem for overnight away assignments */
    perDiem: number;
    /** Laundry allowance per day (8+ consecutive days) */
    laundryPerDay: number;
    /** Meal payment after 11 elapsed hours */
    mealAfter11h: number;
    /** Meal payment after 15 elapsed hours */
    mealAfter15h: number;
    citation: string;
  };
  scheduleChanges: {
    /** Hours of advance notice required for start-time changes */
    advanceNoticeHours: number;
    /** Penalty for insufficient notice of schedule change */
    insufficientNoticePenalty: number;
    /** Hours notice required for day-off work */
    dayOffNoticeHours: number;
    /** Penalty for day-off work with insufficient notice */
    dayOffPenalty: number;
    /** Cancellation penalty amount */
    cancellationPenalty: number;
    citation: string;
  };
  excessiveAssignments: {
    /** Max consecutive days before day off required */
    maxConsecutiveDays: number;
    /** Penalty type for exceeding */
    penaltyType: string;
    citation: string;
  };
  /** The specific local/individual article variant, if any */
  entertainmentProduction?: {
    turnaroundMinimumHours: number;
    dayOffHours: number;
    twoDayOffHours: number;
    penaltyPerHour: number;
    earlyPenaltyPerHour: number;
    expiresDate: string;
    citation: string;
  };
  /**
   * Time-of-day-dependent provisions — overnight premiums, forced call,
   * midnight crossing rules. All hours are wall-clock local time (0–23).
   */
  timeOfDay?: {
    /** Start of overnight window (e.g. 0 for midnight). Default 0 if not specified. */
    overnightStartHour: number;
    /** End of overnight window (e.g. 6 for 6 AM). Default 6 if not specified. */
    overnightEndHour: number;
    /** Premium multiplier for hours worked inside the overnight window (e.g. 2.0 = double time) */
    overnightMultiplier: number;
    /**
     * "Forced call" / "golden time" — when a crew member is called back to work
     * during their rest period with less than the forced-call notice threshold.
     * Multiplier that applies (e.g. 2.0 = double time from forced-call to next rest).
     */
    forcedCallMultiplier: number;
    /** Minimum rest hours that must pass before a callback is NOT a forced call */
    forcedCallRestThresholdHours: number;
    /**
     * If true, work that starts before midnight and crosses midnight triggers
     * overnight premiums for the post-midnight portion only. If false, the
     * entire shift pays the overnight rate once any part falls in the window.
     */
    midnightCrossingProRata: boolean;
    /**
     * Some agreements define a "split day" boundary (e.g. 2 AM) for calculating
     * which calendar day work belongs to. Null means midnight (hour 0) is the boundary.
     */
    dayBoundaryHour: number | null;
    /** Minimum rest hours specifically for overnight turnarounds (may be longer than standard) */
    overnightRestMinimumHours: number | null;
    /** Article/section reference for time-of-day provisions */
    citation: string;
  };
  /** Raw Gemini extraction metadata */
  extractedAt: string;
  extractionModel: string;
  extractionTokens: number;
}

/** A live query result from Gemini about the agreement. */
export interface AgreementQueryResult {
  answer: string;
  citations: string[];
  confidence: 'high' | 'medium' | 'low';
  model: string;
  tokensUsed: number;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Gemini extraction prompts
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM = `You are a labor agreement analyst specializing in broadcast and entertainment production union contracts. Extract precise, machine-readable rules from the agreement text provided.

Be exact with numbers — hours, dollar amounts, multipliers, notice periods. Always include the article and section number as a citation (e.g. "Art. VIII §8.3"). If a rule changed on a specific date (e.g. "effective April 1, 2024"), use the current/latest value.

For entertainment productions ("New Entertainment Productions"), extract the alternate turnaround rules separately if they exist.

Pay special attention to TIME-OF-DAY provisions:
- Overnight / late-night premium rates (work between midnight and early morning)
- "Forced call" or "golden time" — when crew is called back during rest period
- Midnight crossing rules — how pay is calculated when a shift spans midnight
- Calendar day boundaries for pay purposes (some agreements use 2 AM, not midnight)
- Extended rest requirements after overnight work
If the agreement does not mention overnight/time-of-day provisions, use sensible defaults: overnight window 0–6, multiplier 0 (no premium), and set forcedCallMultiplier to 0.`;

const EXTRACTION_QUERY = `Extract the following structured rules from this labor agreement. Return valid JSON matching this schema exactly:

{
  "turnaround": {
    "minimumHours": <number - current minimum turnaround hours>,
    "dayOffHours": <number - consecutive hours for a day off>,
    "twoDayOffHours": <number - consecutive hours for two days off>,
    "penaltyPerHour": <number - dollar penalty per hour of encroachment>,
    "earlyPenaltyPerHour": <number - higher penalty for first 4 hours after schedule end>,
    "citation": "<string - article and section reference>"
  },
  "overtime": {
    "regularDayHours": <number>,
    "multiplier": <number>,
    "computationSegment": "<string>",
    "citation": "<string>"
  },
  "meals": {
    "perDiem": <number - current per diem amount>,
    "laundryPerDay": <number>,
    "mealAfter11h": <number>,
    "mealAfter15h": <number>,
    "citation": "<string>"
  },
  "scheduleChanges": {
    "advanceNoticeHours": <number>,
    "insufficientNoticePenalty": <number>,
    "dayOffNoticeHours": <number>,
    "dayOffPenalty": <number>,
    "cancellationPenalty": <number>,
    "citation": "<string>"
  },
  "excessiveAssignments": {
    "maxConsecutiveDays": <number>,
    "penaltyType": "<string>",
    "citation": "<string>"
  },
  "entertainmentProduction": {
    "turnaroundMinimumHours": <number>,
    "dayOffHours": <number>,
    "twoDayOffHours": <number>,
    "penaltyPerHour": <number>,
    "earlyPenaltyPerHour": <number>,
    "expiresDate": "<string>",
    "citation": "<string>"
  },
  "timeOfDay": {
    "overnightStartHour": <number 0-23 — start of overnight/premium window, e.g. 0 for midnight. Default 0>,
    "overnightEndHour": <number 0-23 — end of overnight window, e.g. 6 for 6 AM. Default 6>,
    "overnightMultiplier": <number — premium multiplier for overnight hours, e.g. 2.0 for double time. 0 if no overnight premium>,
    "forcedCallMultiplier": <number — multiplier when called back during rest with insufficient notice, e.g. 2.0. 0 if not specified>,
    "forcedCallRestThresholdHours": <number — minimum rest hours that must pass before callback is NOT forced call. 0 if not specified>,
    "midnightCrossingProRata": <boolean — true if only post-midnight portion gets overnight rate; false if entire shift pays overnight once any part crosses>,
    "dayBoundaryHour": <number or null — hour that defines the calendar-day boundary for pay purposes (e.g. 2 for 2 AM). null means midnight>,
    "overnightRestMinimumHours": <number or null — if overnight turnarounds require MORE rest than standard, that number; null if same as standard>,
    "citation": "<string — article/section reference for overnight/time-of-day provisions>"
  }
}`;

// ---------------------------------------------------------------------------
// Gemini Structured Output schema — enforces valid JSON keys/types
// ---------------------------------------------------------------------------

const RULE_CITATION = {
  type: 'OBJECT',
  properties: {
    citation: { type: 'STRING' },
  },
  required: ['citation'],
};

const EXTRACTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    turnaround: {
      type: 'OBJECT',
      properties: {
        minimumHours: { type: 'NUMBER' },
        dayOffHours: { type: 'NUMBER' },
        twoDayOffHours: { type: 'NUMBER' },
        penaltyPerHour: { type: 'NUMBER' },
        earlyPenaltyPerHour: { type: 'NUMBER' },
        citation: { type: 'STRING' },
      },
      required: ['minimumHours', 'dayOffHours', 'twoDayOffHours', 'penaltyPerHour', 'earlyPenaltyPerHour', 'citation'],
    },
    overtime: {
      type: 'OBJECT',
      properties: {
        regularDayHours: { type: 'NUMBER' },
        multiplier: { type: 'NUMBER' },
        computationSegment: { type: 'STRING' },
        citation: { type: 'STRING' },
      },
      required: ['regularDayHours', 'multiplier', 'computationSegment', 'citation'],
    },
    meals: {
      type: 'OBJECT',
      properties: {
        perDiem: { type: 'NUMBER' },
        laundryPerDay: { type: 'NUMBER' },
        mealAfter11h: { type: 'NUMBER' },
        mealAfter15h: { type: 'NUMBER' },
        citation: { type: 'STRING' },
      },
      required: ['perDiem', 'laundryPerDay', 'mealAfter11h', 'mealAfter15h', 'citation'],
    },
    scheduleChanges: {
      type: 'OBJECT',
      properties: {
        advanceNoticeHours: { type: 'NUMBER' },
        insufficientNoticePenalty: { type: 'NUMBER' },
        dayOffNoticeHours: { type: 'NUMBER' },
        dayOffPenalty: { type: 'NUMBER' },
        cancellationPenalty: { type: 'NUMBER' },
        citation: { type: 'STRING' },
      },
      required: ['advanceNoticeHours', 'insufficientNoticePenalty', 'dayOffNoticeHours', 'dayOffPenalty', 'cancellationPenalty', 'citation'],
    },
    excessiveAssignments: {
      type: 'OBJECT',
      properties: {
        maxConsecutiveDays: { type: 'NUMBER' },
        penaltyType: { type: 'STRING' },
        citation: { type: 'STRING' },
      },
      required: ['maxConsecutiveDays', 'penaltyType', 'citation'],
    },
    entertainmentProduction: {
      type: 'OBJECT',
      properties: {
        turnaroundMinimumHours: { type: 'NUMBER' },
        dayOffHours: { type: 'NUMBER' },
        twoDayOffHours: { type: 'NUMBER' },
        penaltyPerHour: { type: 'NUMBER' },
        earlyPenaltyPerHour: { type: 'NUMBER' },
        expiresDate: { type: 'STRING' },
        citation: { type: 'STRING' },
      },
      required: ['turnaroundMinimumHours', 'dayOffHours', 'twoDayOffHours', 'penaltyPerHour', 'earlyPenaltyPerHour', 'expiresDate', 'citation'],
    },
    timeOfDay: {
      type: 'OBJECT',
      properties: {
        overnightStartHour: { type: 'NUMBER' },
        overnightEndHour: { type: 'NUMBER' },
        overnightMultiplier: { type: 'NUMBER' },
        forcedCallMultiplier: { type: 'NUMBER' },
        forcedCallRestThresholdHours: { type: 'NUMBER' },
        midnightCrossingProRata: { type: 'BOOLEAN' },
        dayBoundaryHour: { type: 'NUMBER', nullable: true },
        overnightRestMinimumHours: { type: 'NUMBER', nullable: true },
        citation: { type: 'STRING' },
      },
      required: ['overnightStartHour', 'overnightEndHour', 'overnightMultiplier', 'forcedCallMultiplier', 'forcedCallRestThresholdHours', 'midnightCrossingProRata', 'citation'],
    },
  },
  required: ['turnaround', 'overtime', 'meals', 'scheduleChanges', 'excessiveAssignments'],
};

const LIVE_QUERY_SYSTEM = `You are the STEWARD agent — a labor agreement specialist for live sports and entertainment production operations. You have the EXTRACTED RULES from the applicable collective bargaining agreement — structured data with specific hours, dollar amounts, penalties, and article citations.

You also receive OPERATIONAL CONTEXT about the current game/show, including:
- Game details: venue, start/end times, timing chain (strike, shuttle, hotel), departure airport
- Crew roster: each crew member's name, position, home market, next call (destination, call time, arrival deadline), travel routing (flights, departure/arrival times, slack minutes), and current board status

When answering questions:
1. Always cite the specific article, section, and subsection from the extracted rules
2. Apply the rules to the SPECIFIC crew members and their situations — name them, reference their next calls and flight times
3. Calculate actual turnaround gaps: compare the game's expected end time (plus strike/transport) against each crew member's next call time
4. Flag specific penalties and dollar amounts that would apply
5. If a crew member's turnaround is unknown (no next call data), flag it as UNKNOWN RISK — do not assume compliance
6. Note if different rules apply to entertainment productions vs. standard operations
7. When the question involves timing scenarios (e.g. "runs long by 2 hours"), recalculate the chain and evaluate each crew member against the adjusted timeline

Be precise, operational, and crew-specific — the TMC desk needs actionable answers about real people in real time, not generic agreement summaries.`;

/** Fallback system instruction when extracted rules are not available — uses full agreement text. */
const LIVE_QUERY_SYSTEM_FULL_TEXT = `You are the STEWARD agent — a labor agreement specialist for live sports and entertainment production operations. You have the full text of the applicable collective bargaining agreement.

When answering questions:
1. Always cite the specific article, section, and subsection
2. Quote the exact contractual language when relevant
3. Flag any penalties, dollar amounts, or time constraints
4. Note if different rules apply to entertainment productions vs. standard operations
5. If the answer depends on facts not provided (e.g. employee classification, home office location), say what additional information is needed

Be precise and operational — the TMC desk needs actionable answers in real time.`;

// ---------------------------------------------------------------------------
// Agreement operations
// ---------------------------------------------------------------------------

/**
 * Extract structured rules from agreement text using Gemini.
 * This is the one-time extraction that produces machine-evaluable rules.
 */
export async function extractRules(
  gemini: GeminiClient,
  agreementText: string,
): Promise<ExtractedRules | null> {
  const start = Date.now();

  const result = await gemini.promptJSON<Omit<ExtractedRules, 'extractedAt' | 'extractionModel' | 'extractionTokens'>>({
    agent: 'STEWARD',
    systemInstruction: EXTRACTION_SYSTEM,
    context: { agreementText },
    query: EXTRACTION_QUERY,
    maxOutputTokens: 8192,
    responseSchema: EXTRACTION_SCHEMA,
  });

  if (!result) return null;

  return {
    ...result,
    extractedAt: new Date().toISOString(),
    extractionModel: 'gemini-2.5-flash',
    extractionTokens: 0, // filled by caller from Gemini metadata
  };
}

/**
 * Query the agreement live using Gemini.
 *
 * Context strategy:
 *   - When extracted rules are available (in operationalContext.extractedRules),
 *     use those as the primary agreement reference — they're compact and structured.
 *   - Only include full agreement text when rules haven't been extracted yet.
 *   - Always include operational context (game, crew, timing) when available.
 */
export async function queryAgreement(
  gemini: GeminiClient,
  agreementText: string,
  question: string,
  operationalContext?: Record<string, unknown>,
): Promise<AgreementQueryResult> {
  const start = Date.now();

  const hasExtractedRules = operationalContext?.['extractedRules'] != null;
  const contextPayload: Record<string, unknown> = {};

  if (hasExtractedRules) {
    // Extracted rules are the distilled, structured version — much smaller than full text.
    // Full text is 700KB+; extracted rules are ~2KB. Use rules as primary reference.
    contextPayload['extractedRules'] = operationalContext!['extractedRules'];
  } else {
    // No rules extracted yet — fall back to full agreement text
    contextPayload['agreementText'] = agreementText;
  }

  // Add operational context (game, crew, timing) minus the rules we already included
  if (operationalContext) {
    const { extractedRules: _rules, ...restContext } = operationalContext;
    if (Object.keys(restContext).length > 0) {
      Object.assign(contextPayload, restContext);
    }
  }

  const result = await gemini.promptJSON<{
    answer: string;
    citations: string[];
    confidence: 'high' | 'medium' | 'low';
  }>({
    agent: 'STEWARD',
    systemInstruction: hasExtractedRules ? LIVE_QUERY_SYSTEM : LIVE_QUERY_SYSTEM_FULL_TEXT,
    context: contextPayload,
    query: question,
    maxOutputTokens: 4096,
    responseSchema: {
      type: 'OBJECT',
      properties: {
        answer: { type: 'STRING' },
        citations: { type: 'ARRAY', items: { type: 'STRING' } },
        confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
      },
      required: ['answer', 'citations', 'confidence'],
    },
  });

  const latencyMs = Date.now() - start;

  if (!result) {
    return {
      answer: `[error] STEWARD query failed — Gemini returned no result. Try again or simplify the question.`,
      citations: [],
      confidence: 'low',
      model: 'error',
      tokensUsed: 0,
      latencyMs,
    };
  }

  return {
    answer: result.answer,
    citations: result.citations ?? [],
    confidence: result.confidence ?? 'medium',
    model: 'gemini-2.5-flash',
    tokensUsed: 0,
    latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Proactive compliance evaluation
// ---------------------------------------------------------------------------

const EVALUATE_SYSTEM = `You are the STEWARD agent evaluating VARIANCE FROM THE ORIGINAL PLAN caused by game timing changes in a live sports/entertainment production.

CRITICAL: You are NOT evaluating absolute compliance. You are evaluating what CHANGED vs. what was already planned. The original plan is assumed fully compliant — costs and obligations that would have existed under the planned timing are NOT flagged.

## Timezone and local-time awareness

ALL time-of-day evaluations MUST be done in the VENUE'S LOCAL TIME. The context includes:
- "timezone" — the IANA timezone of the venue (e.g. "America/Chicago")
- All ISO timestamps in the context are UTC — convert to venue local time before evaluating time-of-day rules

When the context includes "extractedRules.timeOfDay", use those provisions:
- overnightStartHour / overnightEndHour — the local-clock window for overnight premiums
- overnightMultiplier — premium rate for hours falling inside the overnight window
- forcedCallMultiplier / forcedCallRestThresholdHours — "golden time" for callbacks during rest
- midnightCrossingProRata — if true, only post-midnight portion of a shift gets overnight rate
- dayBoundaryHour — which local hour marks the calendar-day boundary for pay (null = midnight)
- overnightRestMinimumHours — if set, overnight turnarounds require more rest than standard

## How to determine the variance

The context includes:
- "game.expectedEndTime" — the PLANNED end time when the game was scheduled (the baseline)
- "currentPredictedEnd" — SPOTTER's CURRENT predicted end time as the game progresses
- "timingChain" — the wrap-to-gate chain computed from the planned end time

Calculate the OVERRUN: how many minutes/hours the current predicted end exceeds the planned end. If there is no overrun (game on schedule or early), all variance values should be zero.

For each crew member, push the entire timing chain forward by the overrun amount and assess:

1. TURNAROUND: Using the SHIFTED end-of-duty (hotel arrival pushed by the overrun), compare against next call time. Status:
   - "violation" if gap < minimum turnaround hours from the agreement (use overnightRestMinimumHours if the rest period falls inside the overnight window)
   - "at_risk" if gap < minimum + 2 hours
   - "clear" if gap >= minimum + 2 hours
   - "unknown" if next call time is not available
   gapHours = the actual gap with the shifted timing, or null if unknown.

2. OVERTIME: Only the INCREMENTAL overtime caused by the overrun. Calculate hours worked under the plan vs. hours worked with the overrun. Only the difference counts. Use $50/hr base if not in rules.

3. MEALS: Only flag meal thresholds NEWLY crossed because of the overrun. If the planned timing already triggered a meal (e.g., crew was always going to work 12h), that is NOT a variance. Only flag if the overrun pushes past a threshold that the plan didn't reach. Set incrementalCost to $0 if no new thresholds crossed.

4. OVERNIGHT / TIME-OF-DAY: Convert the shifted timing chain to venue local time. Check:
   - Does the OVERRUN push work INTO the overnight window (overnightStartHour–overnightEndHour)?
     If the planned timing already covered those hours, this is NOT a variance.
     Only flag hours NEWLY inside the overnight window because of the overrun.
   - Apply midnightCrossingProRata: if true, only count post-midnight hours at the premium rate.
   - Calculate incrementalOvernightCost = newly-overnight-hours × (overnightMultiplier - 1.0) × base rate.
   - "forcedCall": if the overrun compresses rest below forcedCallRestThresholdHours AND the crew member
     is then called back, flag forcedCallTriggered = true and compute golden-time cost.

5. PENALTIES: Only penalties caused by the overrun — turnaround encroachment penalties from the shifted end-of-duty. Schedule change penalties only if call time itself changed with insufficient notice, not from game overrun.

6. REST COMPRESSION: Calculate rest window using the SHIFTED hotel arrival vs. lobby call. This IS a variance since overrun directly compresses rest. If overnightRestMinimumHours is set and the rest period is overnight, use that higher minimum.

ALL dollar amounts must be INCREMENTAL — the cost ABOVE what was already budgeted for the planned end time. If currentPredictedEnd is not available or equals the planned end, report $0 across the board. When data is missing, flag as unknown.`;

/** Gemini Structured Output schema for compliance evaluation. */
const EVALUATE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    crew: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          position: { type: 'STRING' },
          turnaround: {
            type: 'OBJECT',
            properties: {
              status: { type: 'STRING', enum: ['violation', 'at_risk', 'clear', 'unknown'] },
              gapHours: { type: 'NUMBER', nullable: true },
              minimumHours: { type: 'NUMBER' },
              nextCallTime: { type: 'STRING', nullable: true },
            },
            required: ['status', 'minimumHours'],
          },
          overtime: {
            type: 'OBJECT',
            properties: {
              triggered: { type: 'BOOLEAN' },
              hoursWorked: { type: 'NUMBER' },
              regularDayHours: { type: 'NUMBER' },
              otCost: { type: 'NUMBER' },
            },
            required: ['triggered', 'hoursWorked', 'regularDayHours', 'otCost'],
          },
          meals: {
            type: 'OBJECT',
            properties: {
              perDiemTriggered: { type: 'BOOLEAN' },
              mealAfter11h: { type: 'BOOLEAN' },
              mealAfter15h: { type: 'BOOLEAN' },
              incrementalCost: { type: 'NUMBER' },
            },
            required: ['perDiemTriggered', 'mealAfter11h', 'mealAfter15h', 'incrementalCost'],
          },
          overnight: {
            type: 'OBJECT',
            properties: {
              overnightHoursPlanned: { type: 'NUMBER' },
              overnightHoursActual: { type: 'NUMBER' },
              incrementalOvernightHours: { type: 'NUMBER' },
              incrementalOvernightCost: { type: 'NUMBER' },
              forcedCallTriggered: { type: 'BOOLEAN' },
              forcedCallCost: { type: 'NUMBER' },
            },
            required: ['overnightHoursPlanned', 'overnightHoursActual', 'incrementalOvernightHours', 'incrementalOvernightCost', 'forcedCallTriggered', 'forcedCallCost'],
          },
          penalties: {
            type: 'OBJECT',
            properties: {
              turnaroundPenalty: { type: 'NUMBER' },
              scheduleChangePenalty: { type: 'NUMBER' },
              totalPenalty: { type: 'NUMBER' },
            },
            required: ['turnaroundPenalty', 'scheduleChangePenalty', 'totalPenalty'],
          },
        },
        required: ['name', 'position', 'turnaround', 'overtime', 'meals', 'overnight', 'penalties'],
      },
    },
    totals: {
      type: 'OBJECT',
      properties: {
        turnaroundPenalties: { type: 'NUMBER' },
        overtimeCost: { type: 'NUMBER' },
        mealCost: { type: 'NUMBER' },
        overnightCost: { type: 'NUMBER' },
        forcedCallCost: { type: 'NUMBER' },
        scheduleChangePenalties: { type: 'NUMBER' },
        totalExposure: { type: 'NUMBER' },
      },
      required: ['turnaroundPenalties', 'overtimeCost', 'mealCost', 'overnightCost', 'forcedCallCost', 'scheduleChangePenalties', 'totalExposure'],
    },
    restCompression: {
      type: 'OBJECT',
      properties: {
        hotelArrival: { type: 'STRING', nullable: true },
        lobbyCall: { type: 'STRING', nullable: true },
        restHours: { type: 'NUMBER', nullable: true },
        minimumRest: { type: 'NUMBER' },
        compressed: { type: 'BOOLEAN' },
      },
      required: ['minimumRest', 'compressed'],
    },
    summary: { type: 'STRING' },
  },
  required: ['crew', 'totals', 'restCompression', 'summary'],
};

/** Result of a proactive compliance evaluation. */
export interface ComplianceSnapshot {
  crew: Array<{
    name: string;
    position: string;
    turnaround: {
      status: 'violation' | 'at_risk' | 'clear' | 'unknown';
      gapHours: number | null;
      minimumHours: number;
      nextCallTime: string | null;
    };
    overtime: {
      triggered: boolean;
      hoursWorked: number;
      regularDayHours: number;
      otCost: number;
    };
    meals: {
      perDiemTriggered: boolean;
      mealAfter11h: boolean;
      mealAfter15h: boolean;
      incrementalCost: number;
    };
    overnight: {
      overnightHoursPlanned: number;
      overnightHoursActual: number;
      incrementalOvernightHours: number;
      incrementalOvernightCost: number;
      forcedCallTriggered: boolean;
      forcedCallCost: number;
    };
    penalties: {
      turnaroundPenalty: number;
      scheduleChangePenalty: number;
      totalPenalty: number;
    };
  }>;
  totals: {
    turnaroundPenalties: number;
    overtimeCost: number;
    mealCost: number;
    overnightCost: number;
    forcedCallCost: number;
    scheduleChangePenalties: number;
    totalExposure: number;
  };
  restCompression: {
    hotelArrival: string | null;
    lobbyCall: string | null;
    restHours: number | null;
    minimumRest: number;
    compressed: boolean;
  };
  summary: string;
  evaluatedAt: string;
  latencyMs: number;
}

/**
 * Proactive compliance evaluation — called when game timing changes.
 *
 * Uses extracted rules + operational context (same compact payload as live query)
 * to evaluate every crew member's compliance status against the agreement.
 */
export async function evaluateImpact(
  gemini: GeminiClient,
  operationalContext: Record<string, unknown>,
): Promise<ComplianceSnapshot | null> {
  if (!gemini.isEnabled()) return null;

  const rules = operationalContext['extractedRules'];
  if (!rules) {
    console.warn('[steward] evaluateImpact called without extracted rules — skipping');
    return null;
  }

  const start = Date.now();

  // Retry up to 2 times — Gemini structured output can intermittently produce malformed JSON
  let result: Omit<ComplianceSnapshot, 'evaluatedAt' | 'latencyMs'> | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    result = await gemini.promptJSON<Omit<ComplianceSnapshot, 'evaluatedAt' | 'latencyMs'>>({
      agent: 'STEWARD',
      systemInstruction: EVALUATE_SYSTEM,
      context: operationalContext,
      query: 'Evaluate compliance impact for the current timing chain. Assess every crew member.',
      maxOutputTokens: 8192,
      responseSchema: EVALUATE_SCHEMA,
    });
    if (result) break;
    if (attempt < 2) {
      console.log(`[steward] evaluateImpact — retry ${attempt}/2`);
    }
  }

  const latencyMs = Date.now() - start;

  if (!result) {
    console.warn(`[steward] evaluateImpact — Gemini returned no result after retries (${latencyMs}ms)`);
    return null;
  }

  return {
    ...result,
    evaluatedAt: new Date().toISOString(),
    latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Agreement metadata
// ---------------------------------------------------------------------------

/**
 * Build agreement metadata from the text content and source.
 */
export function buildAgreementMeta(
  name: string,
  text: string,
  source: string,
  extractedParties?: { parties: string; effectiveDate: string; expirationDate: string },
): AgreementMeta {
  return {
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
    name,
    parties: extractedParties?.parties ?? '',
    effectiveDate: extractedParties?.effectiveDate ?? '',
    expirationDate: extractedParties?.expirationDate ?? '',
    textLength: text.length,
    loadedAt: new Date().toISOString(),
    source,
  };
}
