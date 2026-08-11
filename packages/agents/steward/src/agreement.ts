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

For entertainment productions ("New Entertainment Productions"), extract the alternate turnaround rules separately if they exist.`;

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
