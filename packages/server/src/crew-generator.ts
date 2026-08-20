/**
 * Crew itinerary generator — produces realistic dummy crew assignments
 * for a given game, complete with next calls, travel routing, provenance,
 * and disclosure status.
 *
 * Used by the server to populate crew data for games that don't have
 * manually entered itineraries.
 */

import type {
  NextCall,
  NextCallType,
  NextCallProvenance,
  TravelLeg,
  TravelRouting,
  CrewGameAssignment,
  BoardStatus,
  ProvenanceLevel,
} from '@apron/types';
import type { Game, CrewRecord } from './admin-store.js';
import { abbrevToIANA, localTimeToUtcIso, getTimezoneOffsetDelta } from './tz-utils.js';
import { findBestFlight, findConnectingFlights, hasDirectRoute } from '@apron/agent-traffic';

// ---------------------------------------------------------------------------
// Reference data — airports, airlines, cities, positions
// ---------------------------------------------------------------------------

/** Major US airports with city names and timezone abbreviations. */
const AIRPORTS: Record<string, { city: string; tz: string }> = {
  ATL: { city: 'Atlanta', tz: 'ET' },
  BNA: { city: 'Nashville', tz: 'CT' },
  BOS: { city: 'Boston', tz: 'ET' },
  CLT: { city: 'Charlotte', tz: 'ET' },
  CLE: { city: 'Cleveland', tz: 'ET' },
  DEN: { city: 'Denver', tz: 'MT' },
  DFW: { city: 'Dallas/Fort Worth', tz: 'CT' },
  DTW: { city: 'Detroit', tz: 'ET' },
  EWR: { city: 'Newark', tz: 'ET' },
  HOU: { city: 'Houston', tz: 'CT' },
  IAD: { city: 'Washington', tz: 'ET' },
  JFK: { city: 'New York', tz: 'ET' },
  LAX: { city: 'Los Angeles', tz: 'PT' },
  LGA: { city: 'New York', tz: 'ET' },
  MCI: { city: 'Kansas City', tz: 'CT' },
  MCO: { city: 'Orlando', tz: 'ET' },
  MDW: { city: 'Chicago', tz: 'CT' },
  MIA: { city: 'Miami', tz: 'ET' },
  MSP: { city: 'Minneapolis', tz: 'CT' },
  ORD: { city: 'Chicago', tz: 'CT' },
  PHL: { city: 'Philadelphia', tz: 'ET' },
  PHX: { city: 'Phoenix', tz: 'MT' },
  PIT: { city: 'Pittsburgh', tz: 'ET' },
  SEA: { city: 'Seattle', tz: 'PT' },
  SFO: { city: 'San Francisco', tz: 'PT' },
  STL: { city: 'St. Louis', tz: 'CT' },
  TPA: { city: 'Tampa', tz: 'ET' },
};

/** Map venue city names to their nearest airport IATA code. */
const VENUE_TO_AIRPORT: Record<string, string> = {
  'cleveland': 'CLE', 'progressive field': 'CLE',
  'atlanta': 'ATL', 'truist park': 'ATL',
  'arlington': 'DFW', 'globe life field': 'DFW',
  'kansas city': 'MCI', 'arrowhead': 'MCI', 'kauffman stadium': 'MCI',
  'new york': 'JFK', 'yankee stadium': 'JFK', 'citi field': 'LGA',
  'boston': 'BOS', 'fenway park': 'BOS',
  'chicago': 'ORD', 'wrigley field': 'ORD', 'guaranteed rate field': 'ORD',
  'los angeles': 'LAX', 'dodger stadium': 'LAX', 'sofi stadium': 'LAX',
  'san francisco': 'SFO', 'oracle park': 'SFO',
  'houston': 'HOU', 'minute maid park': 'HOU',
  'philadelphia': 'PHL', 'citizens bank park': 'PHL',
  'phoenix': 'PHX', 'chase field': 'PHX',
  'denver': 'DEN', 'coors field': 'DEN', 'ball arena': 'DEN', 'empower field': 'DEN',
  'detroit': 'DTW', 'comerica park': 'DTW',
  'miami': 'MIA', 'loandepot park': 'MIA', 'hard rock stadium': 'MIA',
  'minneapolis': 'MSP', 'target field': 'MSP', 'u.s. bank stadium': 'MSP',
  'seattle': 'SEA', 't-mobile park': 'SEA', 'lumen field': 'SEA',
  'pittsburgh': 'PIT', 'pnc park': 'PIT',
  'st. louis': 'STL', 'busch stadium': 'STL',
  'tampa': 'TPA', 'tropicana field': 'TPA', 'raymond james stadium': 'TPA',
  'nashville': 'BNA', 'nissan stadium': 'BNA',
  'charlotte': 'CLT', 'bank of america stadium': 'CLT',
  'orlando': 'MCO', 'amway center': 'MCO',
  'san diego': 'SAN', 'petco park': 'SAN',
  'milwaukee': 'MKE', 'american family field': 'MKE',
  'cincinnati': 'CVG', 'great american ball park': 'CVG',
  'washington': 'IAD', 'nationals park': 'IAD',
  'baltimore': 'BWI', 'oriole park': 'BWI', 'camden yards': 'BWI',
};

/** US carriers with realistic flight number ranges. */
const CARRIERS = [
  { code: 'AA', name: 'American', range: [100, 2999] },
  { code: 'DL', name: 'Delta', range: [100, 2599] },
  { code: 'UA', name: 'United', range: [100, 2499] },
  { code: 'WN', name: 'Southwest', range: [100, 4999] },
  { code: 'AS', name: 'Alaska', range: [100, 1499] },
  { code: 'B6', name: 'JetBlue', range: [100, 1999] },
] as const;

/** Common hub connections for major carriers. */
const CARRIER_HUBS: Record<string, string[]> = {
  AA: ['DFW', 'CLT', 'ORD', 'MIA', 'PHL'],
  DL: ['ATL', 'DTW', 'MSP', 'JFK', 'SEA'],
  UA: ['ORD', 'EWR', 'IAD', 'DEN', 'SFO'],
  WN: ['MDW', 'DAL', 'BWI', 'DEN'],
  AS: ['SEA', 'SFO', 'LAX'],
  B6: ['JFK', 'BOS', 'MCO'],
};

/** Positions that are typically key/A-list. */
const KEY_POSITIONS = new Set([
  'TD', 'DIR', 'A1', 'A2', 'LEAD EVS', 'EIC', 'PROD', 'TECH MGR',
]);

/** Position → department mapping. */
const POSITION_DEPARTMENTS: Record<string, string> = {
  'TD': 'Truck · A-unit',
  'DIR': 'Truck · A-unit',
  'A1': 'Audio booth',
  'A2': 'Field',
  'EIC': 'Truck · engineering',
  'LEAD EVS': 'Tape room',
  'EVS': 'Tape room',
  'EVS 2': 'Tape room',
  'EVS 3': 'Tape room',
  'TECH MGR': 'Compound',
  'V1 SHADE': 'Truck · video',
  'GFX': 'Graphics',
  'RF ENG': 'Field',
  'PROD': 'Truck · A-unit',
  'FONT COORD': 'Graphics',
  'UTIL': 'Field',
  'CAMERA': 'Field',
  'STAGE MGR': 'Field',
};

/** Productions for external calls — realistic upcoming shows. */
const EXTERNAL_PRODUCTIONS = [
  { shortName: 'MNF', name: 'Monday Night Football', network: 'ESPN', venues: ['MCI', 'ATL', 'DEN', 'LAX', 'PHX'] },
  { shortName: 'TNF', name: 'Thursday Night Football', network: 'PRIME', venues: ['SEA', 'LAX', 'SFO', 'DEN'] },
  { shortName: 'SNF', name: 'Sunday Night Football', network: 'NBC', venues: ['DFW', 'PHX', 'MCI', 'DEN', 'BOS'] },
  { shortName: 'CFB', name: 'College Football', network: 'FOX', venues: ['ORD', 'ATL', 'DFW', 'LAX', 'MCO'] },
  { shortName: 'NBA', name: 'NBA on ESPN', network: 'ESPN', venues: ['LAX', 'BOS', 'DEN', 'MIA', 'PHX'] },
  { shortName: 'NHL', name: 'NHL on TNT', network: 'TNT', venues: ['DTW', 'BOS', 'DEN', 'SEA', 'MSP'] },
  { shortName: 'CFP', name: 'College Football Playoff', network: 'ESPN', venues: ['ATL', 'DFW', 'PHX', 'LAX'] },
];

// ---------------------------------------------------------------------------
// Seeded random — deterministic per crew+game for consistent results
// ---------------------------------------------------------------------------

function seededRandom(seed: string): () => number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(31, h) + seed.charCodeAt(i) | 0;
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 13), 0x45d9f3b);
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
  };
}

function pick<T>(arr: readonly T[], rand: () => number): T {
  return arr[Math.floor(rand() * arr.length)]!;
}

function randInt(min: number, max: number, rand: () => number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

// ---------------------------------------------------------------------------
// Flight time estimation
// ---------------------------------------------------------------------------

/** Rough flight times in minutes between US airport pairs. */
function estimateFlightMinutes(from: string, to: string, rand: () => number): number {
  // Rough distance buckets based on US geography
  const eastCoast = new Set(['BOS', 'JFK', 'LGA', 'EWR', 'PHL', 'IAD', 'CLT', 'ATL', 'MIA', 'MCO', 'TPA', 'PIT', 'CLE', 'DTW', 'BWI']);
  const central = new Set(['ORD', 'MDW', 'MSP', 'MCI', 'STL', 'BNA', 'DFW', 'HOU', 'MKE', 'CVG']);
  const west = new Set(['LAX', 'SFO', 'SEA', 'DEN', 'PHX', 'SAN']);

  if (from === to) return 0;

  const fromRegion = eastCoast.has(from) ? 'E' : central.has(from) ? 'C' : 'W';
  const toRegion = eastCoast.has(to) ? 'E' : central.has(to) ? 'C' : 'W';

  if (fromRegion === toRegion) return randInt(80, 150, rand);
  if ((fromRegion === 'E' && toRegion === 'C') || (fromRegion === 'C' && toRegion === 'E')) return randInt(120, 180, rand);
  if ((fromRegion === 'C' && toRegion === 'W') || (fromRegion === 'W' && toRegion === 'C')) return randInt(150, 210, rand);
  // East ↔ West
  return randInt(240, 320, rand);
}

// ---------------------------------------------------------------------------
// Time formatting helpers
// ---------------------------------------------------------------------------

function formatHHMM(totalMinutes: number): string {
  const h = Math.floor((totalMinutes % 1440 + 1440) % 1440 / 60);
  const m = (totalMinutes % 1440 + 1440) % 1440 % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

function parseHHMM(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h! * 60 + (m ?? 0);
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayOfWeek(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  return DAY_NAMES[d.getUTCDay()]!;
}

/**
 * Build a proper UTC ISO string from a date + HH:MM + timezone abbreviation.
 * Replaces the old pattern of `${date}T${HH}:${MM}:00Z` which falsely
 * labeled local times as UTC.
 */
function toUtcIso(dateStr: string, hour: number, minute: number, tzAbbrev: string): string {
  const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
  return localTimeToUtcIso(dateStr, timeStr, abbrevToIANA(tzAbbrev));
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export interface GeneratorOptions {
  /** Fraction of crew with external calls (0–1). Default 0.2. */
  externalCallRate?: number;
  /** Fraction of external calls that are disclosed. Default 0.3. */
  disclosureRate?: number;
  /** Whether to include a "same production" next call for some crew. Default true. */
  includeSameProduction?: boolean;
  /** The "same production" next show details, if any. */
  nextShow?: {
    title: string;          // "ALCS Gm 5"
    shortName: string;      // "ALCS Gm 5"
    venue: string;          // "Arlington"
    airport: string;        // "DFW"
    callTime: string;       // "09:00"
    callDate: string;       // "2026-10-22"
    tz: string;             // "CT"
  };
}

/**
 * Generate realistic crew game assignments for a roster against a game.
 *
 * Each crew member gets:
 * - A next call (external, same-production, or home)
 * - Travel routing from the game venue to their destination
 * - Provenance and disclosure appropriate to the call type
 * - A board status (initially CLEAR)
 *
 * Results are deterministic for a given crew+game combination (seeded random).
 */
export function generateCrewAssignments(
  crew: CrewRecord[],
  game: Game,
  opts: GeneratorOptions = {},
): CrewGameAssignment[] {
  const {
    externalCallRate = 0.2,
    disclosureRate = 0.3,
    includeSameProduction = true,
    nextShow,
  } = opts;

  // Determine the game's departure airport
  const originAirport = resolveAirport(game.venue) ?? 'JFK';
  const gameDate = game.date;
  const nextDay = addDays(gameDate, 1);
  const nextDayName = dayOfWeek(nextDay);

  // Expected wrap time — used to compute departure windows
  const expectedEndMin = game.expectedEndTime
    ? parseHHMM(game.expectedEndTime)
    : game.startTime
      ? parseHHMM(game.startTime) + (game.expectedDuration ?? 180)
      : 23 * 60; // 11pm fallback

  // Earliest realistic departure = wrap + strike + transport + rest + lobby
  const strikeMins = game.strikeDuration ?? 75;
  const transportMins = (game.venueToTransport ?? 15) + (game.transportDuration ?? 27);
  const minRestMins = (game.minRestHours ?? 8) * 60;
  const earliestDepartureMin = expectedEndMin + strikeMins + transportMins + minRestMins + 45; // 45m for lobby/checkin

  // Departure window: earliest feasible to mid-morning next day
  const depWindowStart = Math.max(earliestDepartureMin % 1440, 5 * 60 + 30); // not before 05:30
  const depWindowEnd = 11 * 60; // 11:00

  const assignments: CrewGameAssignment[] = [];

  for (const member of crew) {
    const rand = seededRandom(`${member.id}:${game.id}`);
    const position = member.position || 'UTIL';
    const isKey = KEY_POSITIONS.has(position);
    const department = POSITION_DEPARTMENTS[position] ?? member.department ?? 'Field';
    const homeAirport = resolveAirportFromMarket(member.homeMarket) ?? pick(Object.keys(AIRPORTS).filter(a => a !== originAirport), rand);
    const tier = (member.tier === 'T1' || member.tier === 'T2') ? member.tier : (isKey ? 'T1' : 'T2');

    // Decide next call type
    let callType: NextCallType;
    const roll = rand();
    if (roll < externalCallRate) {
      callType = 'external';
    } else if (includeSameProduction && nextShow && roll < externalCallRate + 0.3) {
      callType = 'same-production';
    } else {
      callType = 'home';
    }

    // Build the next call
    const nextCall = buildNextCall(callType, {
      rand,
      gameDate,
      nextDay,
      nextDayName,
      originAirport,
      homeAirport,
      disclosureRate,
      nextShow,
    });

    // Build travel routing
    const routing = buildRouting({
      rand,
      originAirport,
      destinationAirport: nextCall.destinationAirport,
      departureDate: nextDay,
      depWindowStart,
      depWindowEnd,
      arrivalDeadlineMin: nextCall.arrivalDeadline
        ? parseHHMM(nextCall.arrivalDeadline.display.split(' ').find(p => p.includes(':')) ?? '13:00')
        : undefined,
    });

    const assignment: CrewGameAssignment = {
      crewId: member.id,
      name: member.name,
      position,
      keyPosition: isKey,
      department,
      homeAirport,
      tier,
      nextCall,
      routing,
      status: 'CLEAR' as BoardStatus,
    };
    if (member.phone) assignment.phone = member.phone;
    assignments.push(assignment);
  }

  return assignments;
}

// ---------------------------------------------------------------------------
// Internal builders
// ---------------------------------------------------------------------------

interface NextCallContext {
  rand: () => number;
  gameDate: string;
  nextDay: string;
  nextDayName: string;
  originAirport: string;
  homeAirport: string;
  disclosureRate: number;
  nextShow?: GeneratorOptions['nextShow'];
}

function buildNextCall(type: NextCallType, ctx: NextCallContext): NextCall {
  const { rand, gameDate, nextDay, nextDayName, homeAirport, disclosureRate, nextShow } = ctx;

  switch (type) {
    case 'external': {
      const prod = pick(EXTERNAL_PRODUCTIONS, rand);
      const destAirport = pick(prod.venues, rand);
      const dest = AIRPORTS[destAirport] ?? { city: destAirport, tz: 'ET' };
      const disclosed = rand() < disclosureRate;

      // Call time: next day, afternoon
      const callHour = randInt(13, 19, rand);
      const callMin = pick([0, 0, 30], rand);
      const callTimeStr = `${nextDayName} ${callHour}:${callMin.toString().padStart(2, '0')} ${dest.tz}`;

      // Arrival deadline: 1 hour before call
      const arrHour = callHour - 1;
      const arrTimeStr = `${nextDayName} ${arrHour}:${callMin.toString().padStart(2, '0')} ${dest.tz}`;
      const arrIso = toUtcIso(nextDay, arrHour, callMin, dest.tz);

      const provLevel: ProvenanceLevel = disclosed
        ? (rand() < 0.5 ? 'external' : 'confirmed')
        : (rand() < 0.3 ? 'inferred' : 'external');

      const provenance = buildProvenance(provLevel, disclosed, gameDate, rand);

      return {
        type: 'external',
        destinationAirport: destAirport,
        destinationCity: dest.city,
        // Always populate production — `disclosed` controls visibility, not data
        production: {
          shortName: prod.shortName,
          name: prod.name,
          network: prod.network,
          venue: `${dest.city}`,
        },
        callTime: {
          iso: toUtcIso(nextDay, callHour, callMin, dest.tz),
          display: callTimeStr,
          tz: dest.tz,
        },
        arrivalDeadline: {
          iso: arrIso,
          display: arrTimeStr,
        },
        provenance,
        disclosed,
      };
    }

    case 'same-production': {
      if (!nextShow) {
        // Fallback to home if no next show configured
        return buildNextCall('home', ctx);
      }

      const dest = AIRPORTS[nextShow.airport] ?? { city: nextShow.venue, tz: nextShow.tz };
      const callDay = dayOfWeek(nextShow.callDate);
      const callTimeStr = `${callDay} ${nextShow.callTime} ${nextShow.tz}`;
      const callMin = parseHHMM(nextShow.callTime);
      // Arrive 1 hour before call
      const arrMin = callMin - 60;
      const arrTimeStr = `${callDay} ${formatHHMM(arrMin)} ${nextShow.tz}`;
      const arrHH = Math.floor(((arrMin % 1440) + 1440) % 1440 / 60);
      const arrMM = ((arrMin % 1440) + 1440) % 1440 % 60;
      const arrIso = toUtcIso(nextShow.callDate, arrHH, arrMM, nextShow.tz);
      const [callH, callM] = nextShow.callTime.split(':').map(Number);

      return {
        type: 'same-production',
        destinationAirport: nextShow.airport,
        destinationCity: dest.city,
        production: {
          shortName: nextShow.shortName,
          name: nextShow.title,
          venue: `${nextShow.venue}`,
        },
        callTime: {
          iso: toUtcIso(nextShow.callDate, callH!, callM!, nextShow.tz),
          display: callTimeStr,
          tz: nextShow.tz,
        },
        arrivalDeadline: {
          iso: arrIso,
          display: arrTimeStr,
        },
        provenance: buildProvenance('sheet', true, gameDate, rand),
        disclosed: true,
      };
    }

    case 'home': {
      const dest = AIRPORTS[homeAirport] ?? { city: homeAirport, tz: 'ET' };
      const hasSoftHold = rand() < 0.25;

      let softHold: NextCall['softHold'] | undefined;
      if (hasSoftHold) {
        const holdDaysOut = randInt(2, 5, rand);
        const holdDate = addDays(gameDate, holdDaysOut);
        const holdDay = dayOfWeek(holdDate);
        const holdHour = randInt(9, 14, rand);
        softHold = {
          display: `${holdDay} ${holdHour}:00 held`,
          iso: toUtcIso(holdDate, holdHour, 0, dest.tz),
        };
      }

      return {
        type: 'home',
        destinationAirport: homeAirport,
        destinationCity: dest.city,
        production: null,
        softHold,
        provenance: buildProvenance(hasSoftHold ? 'sheet' : 'none', false, gameDate, rand),
        disclosed: false,
      };
    }
  }
}

function buildProvenance(
  level: ProvenanceLevel,
  brokerable: boolean,
  gameDate: string,
  rand: () => number,
): NextCallProvenance {
  const daysBack = randInt(0, 4, rand);
  const observedDate = addDays(gameDate, -daysBack);
  const observedDay = dayOfWeek(observedDate);
  const observedHour = randInt(8, 18, rand);
  const observedMin = randInt(0, 59, rand);
  const observedTimeStr = `${observedHour.toString().padStart(2, '0')}:${observedMin.toString().padStart(2, '0')}`;
  const observedAt = `${observedDate}T${observedTimeStr}:00Z`;

  switch (level) {
    case 'confirmed':
      return {
        level: 'confirmed',
        source: 'crew-confirmed',
        sourceDisplay: `Crew-confirmed · ${observedDay} ${observedTimeStr}`,
        observedAt,
        brokerable,
      };
    case 'external':
      return {
        level: 'external',
        source: 'network-crew-sheet',
        sourceDisplay: `External network · validated · ${observedDay} ${observedTimeStr}`,
        observedAt,
        brokerable,
      };
    case 'sheet':
      return {
        level: 'sheet',
        source: 'network-crew-sheet',
        sourceDisplay: `${pick(['FOX', 'ESPN', 'NBC', 'CBS'], rand)} crew sheet · ${observedDay} ${observedTimeStr}`,
        observedAt,
        brokerable: true,
      };
    case 'inferred':
      return {
        level: 'inferred',
        source: 'return-routing',
        sourceDisplay: 'Inferred from return routing',
        observedAt,
        brokerable: false,
      };
    case 'none':
    default:
      return {
        level: 'none',
        source: 'none',
        sourceDisplay: 'No commitment on record',
        observedAt,
        brokerable: false,
      };
  }
}

interface RoutingContext {
  rand: () => number;
  originAirport: string;
  destinationAirport: string;
  departureDate: string;
  depWindowStart: number;   // minutes since midnight
  depWindowEnd: number;
  arrivalDeadlineMin?: number;
}

function buildRouting(ctx: RoutingContext): TravelRouting {
  const { rand, originAirport, destinationAirport, departureDate, depWindowStart, depWindowEnd } = ctx;

  // Timezone offset helper: adjust arrival time from origin TZ to destination TZ
  function tzAdjust(fromAirport: string, toAirport: string, minInOriginTz: number): number {
    const fromTz = AIRPORTS[fromAirport]?.tz ?? 'ET';
    const toTz = AIRPORTS[toAirport]?.tz ?? 'ET';
    if (fromTz === toTz) return minInOriginTz;
    const delta = getTimezoneOffsetDelta(abbrevToIANA(fromTz), abbrevToIANA(toTz));
    return minInOriginTz + delta;
  }

  const minDepTime = formatHHMM(Math.max(depWindowStart, 5 * 60 + 30));
  const legs: TravelLeg[] = [];

  // ---- Try real flight schedule first ----
  const realRouting = buildRoutingFromSchedule(
    originAirport, destinationAirport, departureDate, minDepTime, rand,
  );
  if (realRouting) return realRouting;

  // ---- Fallback: synthetic routing (original logic) ----
  const carrier = pick(CARRIERS, rand);
  const flightMin = estimateFlightMinutes(originAirport, destinationAirport, rand);
  const needsConnection = flightMin > 200 || (flightMin > 120 && rand() < 0.3);
  const depMin = randInt(depWindowStart, depWindowEnd, rand);
  const depTime = formatHHMM(depMin);

  if (needsConnection) {
    const hubs = CARRIER_HUBS[carrier.code] ?? ['ORD', 'ATL', 'DFW'];
    const hub = pick(hubs.filter(h => h !== originAirport && h !== destinationAirport), rand) ?? 'ORD';

    const leg1Duration = estimateFlightMinutes(originAirport, hub, rand);
    const leg1ArrMin = tzAdjust(originAirport, hub, depMin + leg1Duration);
    const layoverMin = randInt(45, 90, rand);
    const leg2DepMin = leg1ArrMin + layoverMin;
    const leg2Duration = estimateFlightMinutes(hub, destinationAirport, rand);
    const leg2ArrMin = tzAdjust(hub, destinationAirport, leg2DepMin + leg2Duration);

    const flightNum1 = randInt(carrier.range[0], carrier.range[1], rand).toString();
    const flightNum2 = randInt(carrier.range[0], carrier.range[1], rand).toString();

    legs.push({
      carrier: carrier.code,
      flightNumber: flightNum1,
      departure: { airport: originAirport, time: depTime, date: departureDate },
      arrival: { airport: hub, time: formatHHMM(leg1ArrMin), date: departureDate },
      durationMinutes: leg1Duration,
    });
    legs.push({
      carrier: carrier.code,
      flightNumber: flightNum2,
      departure: { airport: hub, time: formatHHMM(leg2DepMin), date: departureDate },
      arrival: { airport: destinationAirport, time: formatHHMM(leg2ArrMin), date: departureDate },
      durationMinutes: leg2Duration,
    });
  } else {
    const flightNum = randInt(carrier.range[0], carrier.range[1], rand).toString();
    const arrMin = tzAdjust(originAirport, destinationAirport, depMin + flightMin);

    legs.push({
      carrier: carrier.code,
      flightNumber: flightNum,
      departure: { airport: originAirport, time: depTime, date: departureDate },
      arrival: { airport: destinationAirport, time: formatHHMM(arrMin), date: departureDate },
      durationMinutes: flightMin,
    });
  }

  return finishRouting(legs, ctx);
}

/**
 * Build routing from the curated real flight schedule.
 * Returns null if no suitable flight is found (falls back to synthetic).
 */
function buildRoutingFromSchedule(
  origin: string,
  destination: string,
  date: string,
  minDepTime: string,
  rand: () => number,
): TravelRouting | null {
  // Try direct flight first
  if (hasDirectRoute(origin, destination)) {
    const flight = findBestFlight(origin, destination, minDepTime);
    if (flight) {
      const legs: TravelLeg[] = [{
        carrier: flight.carrier,
        flightNumber: flight.flightNumber,
        departure: { airport: flight.dep, time: flight.depTime, date },
        arrival: { airport: flight.arr, time: flight.arrTime, date },
        durationMinutes: flight.durationMin,
      }];
      return finishRouting(legs, null);
    }
  }

  // Try connecting flight through hubs
  const connection = findConnectingFlights(origin, destination, minDepTime);
  if (connection) {
    const [leg1, leg2] = connection;
    const legs: TravelLeg[] = [
      {
        carrier: leg1.carrier,
        flightNumber: leg1.flightNumber,
        departure: { airport: leg1.dep, time: leg1.depTime, date },
        arrival: { airport: leg1.arr, time: leg1.arrTime, date },
        durationMinutes: leg1.durationMin,
      },
      {
        carrier: leg2.carrier,
        flightNumber: leg2.flightNumber,
        departure: { airport: leg2.dep, time: leg2.depTime, date },
        arrival: { airport: leg2.arr, time: leg2.arrTime, date },
        durationMinutes: leg2.durationMin,
      },
    ];
    return finishRouting(legs, null);
  }

  return null; // No real flight found — caller uses synthetic
}

/** Assemble the final TravelRouting from a set of legs. */
function finishRouting(legs: TravelLeg[], ctx: RoutingContext | null): TravelRouting {
  const firstLeg = legs[0]!;
  const lastLeg = legs[legs.length - 1]!;

  const routeSummary = legs.map(l => l.departure.airport).concat(lastLeg.arrival.airport).join('→');

  const arrivalMin = parseHHMM(lastLeg.arrival.time);
  const slackMinutes = ctx?.arrivalDeadlineMin != null
    ? ctx.arrivalDeadlineMin - arrivalMin
    : null;

  return {
    legs,
    status: 'booked',
    carrierDisplay: `${firstLeg.carrier} ${firstLeg.flightNumber}`,
    departureTime: firstLeg.departure.time,
    routeSummary,
    arrivalTime: lastLeg.arrival.time,
    slackMinutes,
  };
}

// ---------------------------------------------------------------------------
// Venue → airport resolution
// ---------------------------------------------------------------------------

/** Resolve a venue string to an IATA airport code. */
export function resolveAirport(venue: string): string | null {
  const lower = venue.toLowerCase();
  for (const [key, code] of Object.entries(VENUE_TO_AIRPORT)) {
    if (lower.includes(key)) return code;
  }
  return null;
}

/** Resolve a home market string like "PHX" or "Dallas" to an IATA code. */
function resolveAirportFromMarket(homeMarket: string): string | null {
  if (!homeMarket) return null;
  const upper = homeMarket.toUpperCase();
  // Direct IATA match
  if (AIRPORTS[upper]) return upper;
  // City name match
  return resolveAirport(homeMarket);
}

// ---------------------------------------------------------------------------
// Display helpers — render structured data into the format the board expects
// ---------------------------------------------------------------------------

/**
 * Render a NextCall into display strings matching the board's CREW table format.
 * Returns { nextCallHtml, nextCallSub } for the two lines of the Next Call column.
 */
export function renderNextCallDisplay(
  nc: NextCall,
  seatView: 'tmc' | 'production',
): { line1: string; line2: string } {
  switch (nc.type) {
    case 'external': {
      // Disclosed externals are visible to everyone
      // Withheld externals: TMC sees full detail, production sees redacted
      if (nc.disclosed || seatView === 'tmc') {
        return {
          line1: nc.production
            ? `${nc.production.shortName} · ${nc.destinationCity}`
            : `External · ${nc.destinationCity}`,
          line2: nc.callTime
            ? `${nc.callTime.display} · arr ${nc.destinationAirport} by ${nc.arrivalDeadline?.display.split(' ').slice(1).join(' ') ?? ''}`
            : '',
        };
      }
      // Production seat — withheld external
      return {
        line1: 'External call · withheld',
        line2: nc.arrivalDeadline
          ? `Arr ${nc.destinationAirport} by ${nc.arrivalDeadline.display}`
          : '',
      };
    }

    case 'same-production': {
      return {
        line1: `${nc.production!.shortName} · ${nc.production!.venue ?? nc.destinationCity}`,
        line2: nc.callTime ? nc.callTime.display : '',
      };
    }

    case 'home': {
      return {
        line1: `Home · ${nc.destinationAirport}`,
        line2: nc.softHold ? nc.softHold.display : 'No call held',
      };
    }
  }
}

/**
 * Render a TravelRouting into display strings matching the board's Routing column.
 * Returns { line1, line2 } for the two lines.
 */
export function renderRoutingDisplay(
  routing: TravelRouting,
): { line1: string; line2: string } {
  const statusSuffix = routing.status === 'rebooked' ? ' · rebooked' : '';
  const slackSuffix = routing.slackMinutes != null
    ? ` · ${routing.slackMinutes >= 0 ? '+' : ''}${routing.slackMinutes}m`
    : '';
  return {
    line1: `${routing.carrierDisplay} · ${routing.departureTime} ${routing.routeSummary}`,
    line2: `arr ${routing.arrivalTime}${slackSuffix}${statusSuffix}`,
  };
}

/**
 * Render provenance into the three-element tuple the fixture board uses:
 * [level, icon, description].
 */
export function renderProvenanceTuple(
  prov: NextCallProvenance,
): [ProvenanceLevel, string, string] {
  const icon = {
    confirmed: '✓',
    external: '⧉',
    sheet: '▪',
    inferred: '⚠',
    none: '—',
  }[prov.level] ?? '—';

  const brokerTag = prov.level === 'external' || prov.level === 'confirmed'
    ? (prov.brokerable ? '<span class="brk">BROKERABLE</span>' : '<span class="nobrk">NOT BROKERABLE</span>')
    : '';

  return [prov.level, icon, `${prov.sourceDisplay}${brokerTag}`];
}
