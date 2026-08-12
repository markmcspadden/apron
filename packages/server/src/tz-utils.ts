/**
 * Timezone utilities — canonical conversion between display abbreviations,
 * IANA timezone IDs, and UTC timestamps.
 *
 * Every game stores a `timezone` field as an IANA ID (e.g. "America/Chicago").
 * HH:MM fields on a game (startTime, expectedEndTime, lobbyCallTime) are
 * wall-clock times in that timezone.  This module converts them to/from UTC
 * and handles display formatting.
 */

// ---------------------------------------------------------------------------
// Abbreviation ↔ IANA mapping
// ---------------------------------------------------------------------------

/** Display abbreviation → IANA timezone identifier. */
const ABBREV_TO_IANA: Record<string, string> = {
  ET: 'America/New_York',
  CT: 'America/Chicago',
  MT: 'America/Denver',
  PT: 'America/Los_Angeles',
  // Arizona doesn't observe DST — Phoenix, Chase Field
  AZ: 'America/Phoenix',
};

/** IANA timezone → canonical display abbreviation. */
const IANA_TO_ABBREV: Record<string, string> = {
  'America/New_York': 'ET',
  'America/Chicago': 'CT',
  'America/Denver': 'MT',
  'America/Los_Angeles': 'PT',
  'America/Phoenix': 'AZ',
};

/**
 * Convert a display abbreviation (ET, CT, MT, PT) to an IANA timezone ID.
 * Returns 'America/New_York' if the abbreviation is unknown.
 */
export function abbrevToIANA(abbrev: string): string {
  return ABBREV_TO_IANA[abbrev.toUpperCase()] ?? 'America/New_York';
}

/**
 * Convert an IANA timezone ID to a display abbreviation.
 * Returns 'ET' if the timezone is unknown.
 */
export function ianaToAbbrev(iana: string): string {
  return IANA_TO_ABBREV[iana] ?? 'ET';
}

// ---------------------------------------------------------------------------
// Wall-clock → UTC conversion
// ---------------------------------------------------------------------------

/**
 * Convert a game date ("YYYY-MM-DD") + time ("HH:MM") in the given IANA
 * timezone to a UTC timestamp in milliseconds.
 *
 * Uses Intl.DateTimeFormat so it works regardless of the server's own TZ
 * setting and handles DST transitions automatically.
 */
export function localTimeToUtcMs(
  dateStr: string,
  timeStr: string,
  timezone: string,
): number {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);

  // Build a UTC date with the raw numbers, then figure out what offset
  // the target timezone has at that approximate instant.
  const approxUtcMs = Date.UTC(year!, month! - 1, day!, hour!, minute!);

  // Format that UTC instant in the target timezone to discover the offset
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(approxUtcMs));

  const tzH = parseInt(parts.find(p => p.type === 'hour')!.value);
  const tzM = parseInt(parts.find(p => p.type === 'minute')!.value);

  // offset = TZ_value − UTC_value  (e.g. EDT → −4h → −240min)
  let offsetMin = (tzH * 60 + tzM) - (hour! * 60 + minute!);
  if (offsetMin > 720) offsetMin -= 1440;
  if (offsetMin < -720) offsetMin += 1440;

  // We want: the UTC instant when the local clock reads hour:minute.
  // local = UTC + offset  →  UTC = local − offset
  return approxUtcMs - offsetMin * 60_000;
}

/**
 * Convert a game date + time to a UTC ISO 8601 string.
 */
export function localTimeToUtcIso(
  dateStr: string,
  timeStr: string,
  timezone: string,
): string {
  return new Date(localTimeToUtcMs(dateStr, timeStr, timezone)).toISOString();
}

// ---------------------------------------------------------------------------
// UTC → wall-clock conversion
// ---------------------------------------------------------------------------

/**
 * Format a UTC timestamp (ISO string or ms) as HH:MM in the given timezone.
 */
export function utcToLocalHHMM(
  utcTime: string | number,
  timezone: string,
): string {
  const d = typeof utcTime === 'number' ? new Date(utcTime) : new Date(utcTime);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d);

  const h = parts.find(p => p.type === 'hour')!.value;
  const m = parts.find(p => p.type === 'minute')!.value;
  return `${h}:${m}`;
}

/**
 * Get the local hour (0-23) from a UTC timestamp in a given timezone.
 * Useful for time-of-day rule checks (midnight crossings, etc.).
 */
export function utcToLocalHour(
  utcTime: string | number,
  timezone: string,
): number {
  const d = typeof utcTime === 'number' ? new Date(utcTime) : new Date(utcTime);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
  }).formatToParts(d);

  return parseInt(parts.find(p => p.type === 'hour')!.value);
}

// ---------------------------------------------------------------------------
// Timezone offset helpers
// ---------------------------------------------------------------------------

/**
 * Get the UTC offset in minutes for a given IANA timezone at a given instant.
 * Positive = east of UTC, negative = west.
 * E.g. EDT = -240, CDT = -300, PDT = -420.
 */
export function getTimezoneOffsetMinutes(
  timezone: string,
  atTime: Date = new Date(),
): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(atTime);

  const tzH = parseInt(parts.find(p => p.type === 'hour')!.value);
  const tzM = parseInt(parts.find(p => p.type === 'minute')!.value);
  const tzDay = parseInt(parts.find(p => p.type === 'day')!.value);

  const utcH = atTime.getUTCHours();
  const utcM = atTime.getUTCMinutes();
  const utcDay = atTime.getUTCDate();

  let offsetMin = (tzH * 60 + tzM) - (utcH * 60 + utcM);
  // Adjust for day boundary crossing
  if (tzDay !== utcDay) {
    if (tzDay > utcDay || (utcDay > 27 && tzDay === 1)) {
      offsetMin += 1440; // TZ is ahead by a day
    } else {
      offsetMin -= 1440; // TZ is behind by a day
    }
  }

  return offsetMin;
}

/**
 * Get the offset difference between two timezones in minutes.
 * E.g. ET→CT = -60 (CT is 1 hour behind ET).
 */
export function getTimezoneOffsetDelta(
  fromTz: string,
  toTz: string,
  atTime: Date = new Date(),
): number {
  return getTimezoneOffsetMinutes(toTz, atTime) - getTimezoneOffsetMinutes(fromTz, atTime);
}

// ---------------------------------------------------------------------------
// Venue → timezone inference
// ---------------------------------------------------------------------------

/** Map city/venue names to IANA timezones (lowercase keys). */
const VENUE_TIMEZONES: Record<string, string> = {
  // ET venues
  'cleveland': 'America/New_York', 'progressive field': 'America/New_York',
  'new york': 'America/New_York', 'yankee stadium': 'America/New_York', 'citi field': 'America/New_York',
  'boston': 'America/New_York', 'fenway park': 'America/New_York',
  'philadelphia': 'America/New_York', 'citizens bank park': 'America/New_York',
  'atlanta': 'America/New_York', 'truist park': 'America/New_York',
  'detroit': 'America/New_York', 'comerica park': 'America/New_York',
  'miami': 'America/New_York', 'loandepot park': 'America/New_York', 'hard rock stadium': 'America/New_York',
  'pittsburgh': 'America/New_York', 'pnc park': 'America/New_York',
  'charlotte': 'America/New_York', 'bank of america stadium': 'America/New_York',
  'orlando': 'America/New_York', 'amway center': 'America/New_York',
  'washington': 'America/New_York', 'nationals park': 'America/New_York',
  'baltimore': 'America/New_York', 'oriole park': 'America/New_York', 'camden yards': 'America/New_York',
  'tampa': 'America/New_York', 'tropicana field': 'America/New_York', 'raymond james stadium': 'America/New_York',

  // CT venues
  'kansas city': 'America/Chicago', 'arrowhead': 'America/Chicago', 'kauffman stadium': 'America/Chicago',
  'chicago': 'America/Chicago', 'wrigley field': 'America/Chicago', 'guaranteed rate field': 'America/Chicago',
  'arlington': 'America/Chicago', 'globe life field': 'America/Chicago',
  'houston': 'America/Chicago', 'minute maid park': 'America/Chicago',
  'minneapolis': 'America/Chicago', 'target field': 'America/Chicago', 'u.s. bank stadium': 'America/Chicago',
  'nashville': 'America/Chicago', 'nissan stadium': 'America/Chicago',
  'st. louis': 'America/Chicago', 'busch stadium': 'America/Chicago',
  'milwaukee': 'America/Chicago', 'american family field': 'America/Chicago',
  'cincinnati': 'America/New_York', 'great american ball park': 'America/New_York',
  'san antonio': 'America/Chicago',

  // MT venues
  'denver': 'America/Denver', 'coors field': 'America/Denver', 'ball arena': 'America/Denver', 'empower field': 'America/Denver',
  'phoenix': 'America/Phoenix', 'chase field': 'America/Phoenix',
  'salt lake city': 'America/Denver',

  // PT venues
  'los angeles': 'America/Los_Angeles', 'dodger stadium': 'America/Los_Angeles', 'sofi stadium': 'America/Los_Angeles',
  'san francisco': 'America/Los_Angeles', 'oracle park': 'America/Los_Angeles',
  'seattle': 'America/Los_Angeles', 't-mobile park': 'America/Los_Angeles', 'lumen field': 'America/Los_Angeles',
  'san diego': 'America/Los_Angeles', 'petco park': 'America/Los_Angeles',
};

/**
 * Infer IANA timezone from a venue or city name.
 * Returns null if the venue isn't recognized.
 */
export function inferTimezone(venue: string): string | null {
  const lower = venue.toLowerCase().trim();
  return VENUE_TIMEZONES[lower] ?? null;
}
