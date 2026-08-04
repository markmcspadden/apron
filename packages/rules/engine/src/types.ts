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

export interface RulePack {
  id: string;
  name: string;
  agreement: string;
  local: string;
  turnaround: TurnaroundRule;
  rest: RestRule;
  travelTime: TravelTimeRule;
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
