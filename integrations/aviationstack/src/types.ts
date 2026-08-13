/**
 * AviationStack API response types.
 *
 * Docs: https://aviationstack.com/documentation
 * Free tier: 100 calls/month, HTTP only, no historical data.
 */

// ---------------------------------------------------------------------------
// API response envelope
// ---------------------------------------------------------------------------

export interface AviationStackPagination {
  limit: number;
  offset: number;
  count: number;
  total: number;
}

export interface AviationStackResponse<T> {
  pagination: AviationStackPagination;
  data: T[];
}

export interface AviationStackError {
  error: {
    code: string;
    message: string;
    context?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Flight data
// ---------------------------------------------------------------------------

export type FlightStatusValue =
  | 'scheduled'
  | 'active'
  | 'landed'
  | 'cancelled'
  | 'incident'
  | 'diverted'
  | 'unknown';

export interface FlightEndpoint {
  airport: string;       // full name: "San Francisco International"
  timezone: string;      // IANA: "America/Los_Angeles"
  iata: string;          // "SFO"
  icao: string;          // "KSFO"
  terminal: string | null;
  gate: string | null;
  baggage?: string | null;
  delay: number | null;  // minutes
  scheduled: string;     // ISO datetime
  estimated: string | null;
  actual: string | null;
  estimated_runway: string | null;
  actual_runway: string | null;
}

export interface FlightAirline {
  name: string;          // "American Airlines"
  iata: string;          // "AA"
  icao: string;          // "AAL"
}

export interface FlightInfo {
  number: string;        // "1004"
  iata: string;          // "AA1004"
  icao: string;          // "AAL1004"
  codeshared: {
    airline_name: string;
    airline_iata: string;
    flight_number: string;
    flight_iata: string;
  } | null;
}

export interface FlightLive {
  updated: string;
  latitude: number;
  longitude: number;
  altitude: number;
  direction: number;
  speed_horizontal: number;
  speed_vertical: number;
  is_ground: boolean;
}

export interface FlightData {
  flight_date: string;           // "2026-08-12"
  flight_status: FlightStatusValue;
  departure: FlightEndpoint;
  arrival: FlightEndpoint;
  airline: FlightAirline;
  flight: FlightInfo;
  aircraft: {
    registration: string;
    iata: string;
    icao: string;
    icao24: string;
  } | null;
  live: FlightLive | null;
}

// ---------------------------------------------------------------------------
// Query parameters for /v1/flights
// ---------------------------------------------------------------------------

export interface FlightSearchParams {
  /** Filter by departure airport IATA code. */
  dep_iata?: string;
  /** Filter by arrival airport IATA code. */
  arr_iata?: string;
  /** Filter by airline IATA code. */
  airline_iata?: string;
  /** Filter by flight IATA code (e.g. "AA1004"). */
  flight_iata?: string;
  /** Filter by flight date (YYYY-MM-DD). */
  flight_date?: string;
  /** Filter by status: scheduled, active, landed, cancelled, incident, diverted. */
  flight_status?: FlightStatusValue;
  /** Results per page (max 100). */
  limit?: number;
  /** Pagination offset. */
  offset?: number;
}

// ---------------------------------------------------------------------------
// Simplified flight status — what TRAFFIC surfaces to the system
// ---------------------------------------------------------------------------

export interface FlightStatusUpdate {
  /** Flight IATA code (e.g. "AA1004"). */
  flightIata: string;
  /** Carrier IATA (e.g. "AA"). */
  carrier: string;
  /** Flight number (e.g. "1004"). */
  flightNumber: string;
  /** Current status. */
  status: FlightStatusValue;
  /** Departure airport IATA. */
  depAirport: string;
  /** Arrival airport IATA. */
  arrAirport: string;
  /** Departure delay in minutes (0 = on time, null = unknown). */
  depDelay: number | null;
  /** Arrival delay in minutes (0 = on time, null = unknown). */
  arrDelay: number | null;
  /** Scheduled departure ISO. */
  scheduledDep: string;
  /** Estimated/actual departure ISO (or scheduled if unknown). */
  effectiveDep: string;
  /** Scheduled arrival ISO. */
  scheduledArr: string;
  /** Estimated/actual arrival ISO (or scheduled if unknown). */
  effectiveArr: string;
  /** Departure terminal. */
  depTerminal: string | null;
  /** Departure gate. */
  depGate: string | null;
  /** Arrival terminal. */
  arrTerminal: string | null;
  /** Arrival gate. */
  arrGate: string | null;
  /** When this data was last fetched. */
  lastUpdated: string;
}
