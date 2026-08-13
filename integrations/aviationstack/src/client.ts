/**
 * AviationStack API client.
 *
 * Reads the API key from `process.env.FLIGHT_STATUS_API_KEY`.
 * Never exposes the key in logs, errors, or responses.
 *
 * Free tier: 100 calls/month, HTTP only (no HTTPS).
 * Built-in response cache to minimize API usage.
 */

import type {
  FlightData,
  FlightSearchParams,
  FlightStatusUpdate,
  FlightStatusValue,
  AviationStackResponse,
} from './types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Free tier uses HTTP; paid tiers can use HTTPS. */
const BASE_URL = 'http://api.aviationstack.com/v1';

/** Cache TTL: 2 minutes for active flights, 10 minutes otherwise. */
const CACHE_TTL_ACTIVE_MS = 2 * 60 * 1000;
const CACHE_TTL_DEFAULT_MS = 10 * 60 * 1000;

/** Maximum results per request. */
const MAX_RESULTS = 100;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
  ttlMs: number;
}

class ResponseCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private maxSize = 500;

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > entry.ttlMs) {
      this.store.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    // Evict oldest entries if at capacity
    if (this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest != null) this.store.delete(oldest);
    }
    this.store.set(key, { data, fetchedAt: Date.now(), ttlMs });
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class AviationStackClient {
  private cache = new ResponseCache();
  private callCount = 0;

  /** Check whether an API key is configured. */
  isEnabled(): boolean {
    return !!process.env['FLIGHT_STATUS_API_KEY'];
  }

  /** Return the number of API calls made this session (for monitoring). */
  getCallCount(): number {
    return this.callCount;
  }

  /**
   * Search for flights matching the given parameters.
   * Returns raw API flight data.
   */
  async searchFlights(params: FlightSearchParams): Promise<FlightData[]> {
    const key = this.getApiKey();
    if (!key) return [];

    const cacheKey = `flights:${JSON.stringify(params)}`;
    const cached = this.cache.get<FlightData[]>(cacheKey);
    if (cached) return cached;

    const searchParams = new URLSearchParams({ access_key: key });
    if (params.dep_iata) searchParams.set('dep_iata', params.dep_iata);
    if (params.arr_iata) searchParams.set('arr_iata', params.arr_iata);
    if (params.airline_iata) searchParams.set('airline_iata', params.airline_iata);
    if (params.flight_iata) searchParams.set('flight_iata', params.flight_iata);
    if (params.flight_date) searchParams.set('flight_date', params.flight_date);
    if (params.flight_status) searchParams.set('flight_status', params.flight_status);
    searchParams.set('limit', String(params.limit ?? MAX_RESULTS));
    if (params.offset) searchParams.set('offset', String(params.offset));

    const url = `${BASE_URL}/flights?${searchParams.toString()}`;

    try {
      this.callCount++;
      console.log(`[aviationstack] API call #${this.callCount}: flights (${params.dep_iata ?? ''}→${params.arr_iata ?? ''}, ${params.flight_iata ?? ''}, ${params.flight_date ?? ''})`);

      const resp = await fetch(url);

      if (!resp.ok) {
        console.error(`[aviationstack] HTTP ${resp.status}: ${resp.statusText}`);
        return [];
      }

      const body = await resp.json() as AviationStackResponse<FlightData> | { error: { code: string; message: string } };

      // API returns errors as 200 with an error object
      if ('error' in body) {
        console.error(`[aviationstack] API error: ${body.error.code} — ${body.error.message}`);
        return [];
      }

      const data = body.data ?? [];
      const hasActive = data.some(f => f.flight_status === 'active');
      this.cache.set(cacheKey, data, hasActive ? CACHE_TTL_ACTIVE_MS : CACHE_TTL_DEFAULT_MS);

      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[aviationstack] Fetch error: ${msg}`);
      return [];
    }
  }

  /**
   * Look up the current status of a specific flight by IATA code.
   * Returns a simplified status update, or null if not found.
   */
  async getFlightStatus(flightIata: string, date?: string): Promise<FlightStatusUpdate | null> {
    const params: FlightSearchParams = { flight_iata: flightIata };
    if (date) params.flight_date = date;

    const flights = await this.searchFlights(params);
    if (flights.length === 0) return null;

    // Pick the most relevant result (prefer matching date)
    const flight = date
      ? flights.find(f => f.flight_date === date) ?? flights[0]!
      : flights[0]!;

    return toStatusUpdate(flight);
  }

  /**
   * Look up flights between two airports on a given date.
   * Useful for the crew-generator to find real flight options.
   */
  async findRouteFlights(
    depIata: string,
    arrIata: string,
    date: string,
    airline?: string,
  ): Promise<FlightStatusUpdate[]> {
    const params: FlightSearchParams = {
      dep_iata: depIata,
      arr_iata: arrIata,
      flight_date: date,
    };
    if (airline) params.airline_iata = airline;

    const flights = await this.searchFlights(params);
    return flights.map(toStatusUpdate);
  }

  /**
   * Batch-check status for multiple flights. Deduplicates requests
   * and uses the cache aggressively.
   */
  async batchFlightStatus(
    flights: Array<{ flightIata: string; date: string }>,
  ): Promise<Map<string, FlightStatusUpdate>> {
    const results = new Map<string, FlightStatusUpdate>();

    // Process sequentially to respect rate limits
    for (const { flightIata, date } of flights) {
      const status = await this.getFlightStatus(flightIata, date);
      if (status) {
        results.set(flightIata, status);
      }
    }

    return results;
  }

  /** Clear the response cache. */
  clearCache(): void {
    this.cache.clear();
  }

  // ---- Private ----

  private getApiKey(): string | null {
    const key = process.env['FLIGHT_STATUS_API_KEY'];
    if (!key) {
      // Silent — don't log the absence repeatedly
      return null;
    }
    return key;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert raw API FlightData to our simplified FlightStatusUpdate. */
function toStatusUpdate(f: FlightData): FlightStatusUpdate {
  return {
    flightIata: f.flight.iata,
    carrier: f.airline.iata,
    flightNumber: f.flight.number,
    status: normalizeStatus(f.flight_status),
    depAirport: f.departure.iata,
    arrAirport: f.arrival.iata,
    depDelay: f.departure.delay,
    arrDelay: f.arrival.delay,
    scheduledDep: f.departure.scheduled,
    effectiveDep: f.departure.actual ?? f.departure.estimated ?? f.departure.scheduled,
    scheduledArr: f.arrival.scheduled,
    effectiveArr: f.arrival.actual ?? f.arrival.estimated ?? f.arrival.scheduled,
    depTerminal: f.departure.terminal,
    depGate: f.departure.gate,
    arrTerminal: f.arrival.terminal,
    arrGate: f.arrival.gate,
    lastUpdated: new Date().toISOString(),
  };
}

function normalizeStatus(raw: string): FlightStatusValue {
  const known: FlightStatusValue[] = ['scheduled', 'active', 'landed', 'cancelled', 'incident', 'diverted'];
  const lower = (raw ?? '').toLowerCase() as FlightStatusValue;
  return known.includes(lower) ? lower : 'unknown';
}
