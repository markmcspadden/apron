/**
 * Crew itinerary types — structured models for Next Call and Travel Routing.
 *
 * These replace the HTML-baked strings in the fixture data with proper typed
 * objects that agents (ADVANCE, TRAFFIC, STEWARD, WRANGLER) can reason about.
 */

import type { ProvenanceLevel, BoardStatus } from './domain.js';

// ---------------------------------------------------------------------------
// Next Call — what the crew member does after this show
// ---------------------------------------------------------------------------

export type NextCallType = 'external' | 'same-production' | 'home';

/**
 * A crew member's next commitment after the current show.
 *
 * - `external`: working for another network/production (may or may not be disclosed)
 * - `same-production`: next game/show in the same series for the same network
 * - `home`: heading home, no upcoming call (may have a soft hold)
 */
export interface NextCall {
  type: NextCallType;

  /** Destination airport IATA code (e.g. "MCI", "DFW", "PHX"). */
  destinationAirport: string;
  /** Destination city (e.g. "Kansas City", "Arlington", "Phoenix"). */
  destinationCity: string;

  /**
   * The production they're going to, if known. For `external` calls this may
   * be null (withheld) or populated (crew chose to disclose). For
   * `same-production` calls this is always populated.
   */
  production: {
    name: string;           // "Monday Night Football", "ALCS Gm 5"
    shortName: string;      // "MNF", "ALCS Gm 5"
    network?: string;       // "ESPN", "FOX" — absent for withheld externals
    venue?: string;         // "Arrowhead · Kansas City"
  } | null;

  /**
   * When the crew member needs to report.
   * Absent for `home` type with no upcoming hold.
   */
  callTime?: {
    /** ISO datetime of the call (e.g. "2026-10-21T19:00:00Z"). */
    iso: string;
    /** Human-readable local time (e.g. "Mon 14:00 CT"). */
    display: string;
    /** Timezone abbreviation (e.g. "CT", "ET", "PT"). */
    tz: string;
  };

  /**
   * Hard arrival deadline — when the crew member must be at the destination.
   * Usually earlier than callTime to allow for ground transport, check-in, etc.
   */
  arrivalDeadline?: {
    /** ISO datetime. */
    iso: string;
    /** Human-readable (e.g. "Mon 13:00 CT"). */
    display: string;
  };

  /**
   * For `home` type — a future hold that isn't an immediate next call.
   * e.g. "Thu 12:00 held" for a crew member going home but with a show Thursday.
   */
  softHold?: {
    display: string;        // "Thu 12:00 held"
    iso?: string;
  };

  /** Provenance of this next-call information. */
  provenance: NextCallProvenance;

  /**
   * Whether the crew member disclosed the production name.
   * - true: production is visible to the production seat
   * - false: production seat sees "External call · withheld"
   *
   * Only meaningful for `external` type. Always true for `same-production`.
   */
  disclosed: boolean;
}

// ---------------------------------------------------------------------------
// Provenance — who said it, how confident are we, who can see it
// ---------------------------------------------------------------------------

export interface NextCallProvenance {
  /** How the information was obtained. */
  level: ProvenanceLevel;

  /**
   * Where the information came from.
   * - "network-crew-sheet": from the network's official crew sheet
   * - "crew-confirmed": crew member confirmed directly
   * - "return-routing": inferred from booked return flight
   * - "tmc-sheet": from the TMC's internal sheet
   * - "none": no commitment on record
   */
  source: string;

  /** Human-readable source description (e.g. "FOX crew sheet · Thu 09:10"). */
  sourceDisplay: string;

  /** When this information was observed/received. ISO datetime. */
  observedAt: string;

  /**
   * Whether this fact can be shared with the production seat.
   * External-network facts are only brokerable if the crew member disclosed them.
   */
  brokerable: boolean;
}

// ---------------------------------------------------------------------------
// Travel Routing — how the crew member gets to their next call
// ---------------------------------------------------------------------------

export interface TravelLeg {
  /** Carrier IATA code (e.g. "DL", "UA", "AA", "WN"). */
  carrier: string;
  /** Flight number (e.g. "1140"). */
  flightNumber: string;

  departure: {
    airport: string;        // IATA code
    time: string;           // "HH:MM" local
    date: string;           // "YYYY-MM-DD"
  };

  arrival: {
    airport: string;
    time: string;
    date: string;
  };

  /** Duration in minutes. */
  durationMinutes: number;
}

export type TravelStatus =
  | 'booked'                // original booking, confirmed
  | 'held'                  // hold placed by FIXER, not yet ticketed
  | 'rebooked'             // rebooked by desk (confirmed)
  | 'broken'               // cannot make this flight (rest, delay, etc.)
  | 'cancelled';           // flight cancelled by carrier

export interface TravelRouting {
  /** Ordered list of flight legs. */
  legs: TravelLeg[];

  /** Current status of this routing. */
  status: TravelStatus;

  // ---- Computed display fields ----

  /** First leg carrier + flight number (e.g. "DL 1140"). */
  carrierDisplay: string;
  /** First leg departure time (e.g. "08:50"). */
  departureTime: string;
  /** Route summary with arrows (e.g. "CLE→DTW→MCI"). */
  routeSummary: string;
  /** Final arrival time (e.g. "12:40"). */
  arrivalTime: string;

  // ---- Timing ----

  /**
   * Minutes of slack between arrival and next-call deadline.
   * Negative means the crew member arrives after their deadline.
   * Null when there's no hard deadline (e.g. going home with no call held).
   */
  slackMinutes: number | null;

  /**
   * If rebooked, the original routing that was replaced.
   * Allows the board to show "was UA 4412, now DL 1140".
   */
  originalRouting?: Pick<TravelRouting, 'carrierDisplay' | 'departureTime' | 'routeSummary' | 'arrivalTime' | 'legs'>;
}

// ---------------------------------------------------------------------------
// Crew Game Assignment — the full per-crew-per-game state
// ---------------------------------------------------------------------------

/**
 * Everything the board needs to render one row of the CREW table.
 * Produced by combining static crew data (from admin store) with
 * live game-specific data from agents.
 */
export interface CrewGameAssignment {
  /** Crew member ID (from admin store). */
  crewId: string;
  /** Display name. */
  name: string;
  /** Position code for the badge (e.g. "TD", "A1", "DIR", "LEAD EVS"). */
  position: string;
  /** Whether this is a key/A-list position. */
  keyPosition: boolean;
  /** Department/location (e.g. "Truck · A-unit", "Audio booth", "Field"). */
  department: string;
  /** Home market airport IATA (e.g. "PHX", "ATL"). */
  homeAirport: string;
  /** Crew tier for prioritization. */
  tier: 'T1' | 'T2';
  /** E.164 phone number for SMS outreach (e.g. "+14155551234"). */
  phone?: string;

  /** What they do after this show. */
  nextCall: NextCall;
  /** How they get there. */
  routing: TravelRouting;

  /** Current board status for this crew member. */
  status: BoardStatus;
}
