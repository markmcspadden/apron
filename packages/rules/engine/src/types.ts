export interface TurnaroundRule {
  minimumHours: number;
  measureFrom: 'wrap' | 'last-out';
  measureTo: 'call' | 'first-in';
  travelCountsAs: 'work' | 'rest';
}

export interface RestRule {
  minimumHours: number;
  penaltyType: 'meal' | 'overtime' | 'grievance';
  penaltyRate: number;
}

export interface TravelTimeRule {
  countsAsWork: boolean;
  maxDriveHours: number;
  requiresRest: boolean;
}

/** Time-of-day-dependent provisions for overnight premiums and forced call. */
export interface TimeOfDayRule {
  /** Start of overnight premium window (local hour, 0–23). Default 0 (midnight). */
  overnightStartHour: number;
  /** End of overnight premium window (local hour, 0–23). Default 6. */
  overnightEndHour: number;
  /** Premium multiplier for hours in the overnight window (e.g. 2.0). 0 = no premium. */
  overnightMultiplier: number;
  /** Multiplier for forced-call / golden-time callbacks during rest. */
  forcedCallMultiplier: number;
  /** Minimum rest hours before a callback is NOT a forced call. */
  forcedCallRestThresholdHours: number;
  /** If true, only post-midnight portion of a midnight-crossing shift gets the premium. */
  midnightCrossingProRata: boolean;
  /** Local hour that defines the calendar-day boundary for pay (null = midnight). */
  dayBoundaryHour: number | null;
  /** Minimum rest hours specifically for overnight turnarounds (null = use standard). */
  overnightRestMinimumHours: number | null;
}

export interface RulePack {
  id: string;
  name: string;
  agreement: string;
  local: string;
  turnaround: TurnaroundRule;
  rest: RestRule;
  travelTime: TravelTimeRule;
  /** Time-of-day rules. Optional — omit if the agreement has no overnight provisions. */
  timeOfDay?: TimeOfDayRule;
}

export interface RuleCheckResult {
  passes: boolean;
  rule: string;
  detail: string;
  violation?: {
    type: string;
    hoursShort: number;
    penaltyExposure: string;
  };
}
