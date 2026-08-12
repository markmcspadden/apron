import type { RulePack, RuleCheckResult, TimeOfDayRule } from './types.js';

// ---------------------------------------------------------------------------
// Helpers — local-hour extraction using Intl (server-TZ-independent)
// ---------------------------------------------------------------------------

/** Get the wall-clock hour (0–23) for a UTC timestamp in a given IANA timezone. */
function getLocalHour(utcMs: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date(utcMs));
  const hourPart = parts.find(p => p.type === 'hour');
  const h = parseInt(hourPart?.value ?? '0', 10);
  return h === 24 ? 0 : h; // Intl can return 24 for midnight in hour12:false
}

/**
 * Count how many hours of a [startMs, endMs] interval fall inside the
 * overnight window [overnightStart, overnightEnd) in venue local time.
 *
 * Handles midnight crossing: if overnightStart > overnightEnd (e.g. 22–6),
 * the window wraps around midnight.
 */
function overnightHoursInRange(
  startMs: number,
  endMs: number,
  timezone: string,
  tod: TimeOfDayRule,
): number {
  if (tod.overnightMultiplier === 0) return 0;
  if (endMs <= startMs) return 0;

  // Walk in 15-minute increments for accuracy near boundary crossings
  const STEP = 15 * 60_000; // 15 min
  let overnightMs = 0;

  const start = tod.overnightStartHour;
  const end = tod.overnightEndHour;
  const wraps = start >= end; // e.g. 22–6 wraps around midnight

  for (let t = startMs; t < endMs; t += STEP) {
    const chunkEnd = Math.min(t + STEP, endMs);
    const chunkMs = chunkEnd - t;
    const h = getLocalHour(t, timezone);

    let inWindow: boolean;
    if (wraps) {
      inWindow = h >= start || h < end;
    } else {
      inWindow = h >= start && h < end;
    }

    if (inWindow) overnightMs += chunkMs;
  }

  return overnightMs / 3_600_000;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class RuleEngine {
  private pack: RulePack;

  constructor(pack: RulePack) {
    this.pack = pack;
  }

  /**
   * Standard turnaround check — pure duration math.
   * For timezone-aware checks with overnight provisions, use checkTurnaroundLocal.
   */
  checkTurnaround(wrapTime: Date, callTime: Date, travelMinutes: number): RuleCheckResult {
    const totalMinutes = (callTime.getTime() - wrapTime.getTime()) / 60000;
    const workMinutes = this.pack.turnaround.travelCountsAs === 'work' ? travelMinutes : 0;
    const restMinutes = totalMinutes - workMinutes;
    const requiredMinutes = this.pack.turnaround.minimumHours * 60;

    if (restMinutes >= requiredMinutes) {
      return {
        passes: true,
        rule: `${this.pack.agreement} turnaround`,
        detail: `${Math.floor(restMinutes / 60)}h${Math.round(restMinutes % 60)}m rest, ${this.pack.turnaround.minimumHours}h required`,
      };
    }

    return {
      passes: false,
      rule: `${this.pack.agreement} turnaround`,
      detail: `${Math.floor(restMinutes / 60)}h${Math.round(restMinutes % 60)}m rest, ${this.pack.turnaround.minimumHours}h required`,
      violation: {
        type: 'turnaround',
        hoursShort: (requiredMinutes - restMinutes) / 60,
        penaltyExposure: this.pack.rest.penaltyType,
      },
    };
  }

  /**
   * Timezone-aware turnaround check.
   * Uses the overnight rest minimum (if set) when the rest window falls inside
   * the overnight window in venue local time.
   */
  checkTurnaroundLocal(
    wrapTime: Date,
    callTime: Date,
    travelMinutes: number,
    timezone: string,
  ): RuleCheckResult {
    const tod = this.pack.timeOfDay;
    if (!tod || !tod.overnightRestMinimumHours) {
      // No overnight rest provision — fall back to standard check
      return this.checkTurnaround(wrapTime, callTime, travelMinutes);
    }

    const totalMinutes = (callTime.getTime() - wrapTime.getTime()) / 60000;
    const workMinutes = this.pack.turnaround.travelCountsAs === 'work' ? travelMinutes : 0;
    const restMinutes = totalMinutes - workMinutes;

    // Determine if the rest period falls inside the overnight window
    const restStartMs = wrapTime.getTime() + workMinutes * 60000;
    const restEndMs = callTime.getTime();
    const overnightHrs = overnightHoursInRange(restStartMs, restEndMs, timezone, tod);
    const restHours = restMinutes / 60;

    // Use overnight minimum if majority of rest is overnight
    const isOvernightRest = overnightHrs > restHours * 0.5;
    const requiredHours = isOvernightRest
      ? tod.overnightRestMinimumHours
      : this.pack.turnaround.minimumHours;
    const requiredMinutes = requiredHours * 60;

    const label = isOvernightRest ? 'overnight turnaround' : 'turnaround';

    if (restMinutes >= requiredMinutes) {
      return {
        passes: true,
        rule: `${this.pack.agreement} ${label}`,
        detail: `${Math.floor(restMinutes / 60)}h${Math.round(restMinutes % 60)}m rest, ${requiredHours}h required (${label})`,
      };
    }

    return {
      passes: false,
      rule: `${this.pack.agreement} ${label}`,
      detail: `${Math.floor(restMinutes / 60)}h${Math.round(restMinutes % 60)}m rest, ${requiredHours}h required (${label})`,
      violation: {
        type: label,
        hoursShort: (requiredMinutes - restMinutes) / 60,
        penaltyExposure: this.pack.rest.penaltyType,
      },
    };
  }

  /**
   * Calculate overnight premium hours for a work period.
   * Returns the number of hours inside the overnight window and whether
   * a forced call / golden time condition is triggered.
   */
  checkOvernight(
    shiftStartMs: number,
    shiftEndMs: number,
    timezone: string,
    restHoursSinceLastShift?: number,
  ): {
    overnightHours: number;
    overnightCost: number;
    forcedCallTriggered: boolean;
    forcedCallCost: number;
  } {
    const tod = this.pack.timeOfDay;
    if (!tod) {
      return { overnightHours: 0, overnightCost: 0, forcedCallTriggered: false, forcedCallCost: 0 };
    }

    let overnightHours: number;
    if (tod.midnightCrossingProRata) {
      // Only count the post-midnight portion at the premium rate
      const midnightLocalMs = getMidnightMs(shiftStartMs, timezone);
      if (midnightLocalMs > shiftStartMs && midnightLocalMs < shiftEndMs) {
        // Shift crosses midnight — only count midnight→end in the overnight window
        overnightHours = overnightHoursInRange(midnightLocalMs, shiftEndMs, timezone, tod);
      } else {
        overnightHours = overnightHoursInRange(shiftStartMs, shiftEndMs, timezone, tod);
      }
    } else {
      overnightHours = overnightHoursInRange(shiftStartMs, shiftEndMs, timezone, tod);
    }

    // Premium cost = overnight hours × (multiplier - 1) × base rate
    // (multiplier - 1 because the base rate is already counted in regular pay)
    const BASE_RATE = 50; // $/hr fallback
    const premiumDelta = Math.max(0, tod.overnightMultiplier - 1.0);
    const overnightCost = overnightHours * premiumDelta * BASE_RATE;

    // Forced call / golden time
    let forcedCallTriggered = false;
    let forcedCallCost = 0;
    if (
      tod.forcedCallMultiplier > 0 &&
      tod.forcedCallRestThresholdHours > 0 &&
      restHoursSinceLastShift != null &&
      restHoursSinceLastShift < tod.forcedCallRestThresholdHours
    ) {
      forcedCallTriggered = true;
      const shiftHours = (shiftEndMs - shiftStartMs) / 3_600_000;
      const goldenDelta = Math.max(0, tod.forcedCallMultiplier - 1.0);
      forcedCallCost = shiftHours * goldenDelta * BASE_RATE;
    }

    return { overnightHours, overnightCost, forcedCallTriggered, forcedCallCost };
  }

  checkRest(availableHours: number): RuleCheckResult {
    if (availableHours >= this.pack.rest.minimumHours) {
      return {
        passes: true,
        rule: `${this.pack.agreement} rest`,
        detail: `${availableHours.toFixed(1)}h available, ${this.pack.rest.minimumHours}h required`,
      };
    }

    return {
      passes: false,
      rule: `${this.pack.agreement} rest`,
      detail: `${availableHours.toFixed(1)}h available, ${this.pack.rest.minimumHours}h required`,
      violation: {
        type: 'rest',
        hoursShort: this.pack.rest.minimumHours - availableHours,
        penaltyExposure: this.pack.rest.penaltyType,
      },
    };
  }

  getPack(): RulePack {
    return this.pack;
  }
}

// ---------------------------------------------------------------------------
// Midnight helper
// ---------------------------------------------------------------------------

/** Get the UTC ms timestamp of the next midnight in venue local time after `afterMs`. */
function getMidnightMs(afterMs: number, timezone: string): number {
  // Get the local date parts at `afterMs`
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(afterMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '0';
  const year = parseInt(get('year'), 10);
  const month = parseInt(get('month'), 10);
  const day = parseInt(get('day'), 10);

  // Next midnight = start of the next calendar day in this timezone
  // Use Intl to find the offset, then compute UTC ms
  const nextDayStr = `${year}-${String(month).padStart(2, '0')}-${String(day + 1).padStart(2, '0')}T00:00:00`;

  // Find UTC offset at roughly midnight
  const roughMs = afterMs + 24 * 3_600_000;
  const offsetParts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(roughMs));
  const tzName = offsetParts.find(p => p.type === 'timeZoneName')?.value ?? '+00:00';
  // Parse "GMT+05:30" or "GMT-04:00" etc.
  const match = tzName.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
  if (!match) return afterMs + 24 * 3_600_000; // fallback: just add 24h

  const sign = match[1] === '+' ? 1 : -1;
  const hrs = parseInt(match[2] ?? '0', 10);
  const mins = parseInt(match[3] ?? '0', 10);
  const offsetMs = sign * (hrs * 3_600_000 + mins * 60_000);

  // Midnight local = midnight UTC - offset
  const midnightUtc = new Date(nextDayStr + 'Z').getTime() - offsetMs;
  return midnightUtc;
}
