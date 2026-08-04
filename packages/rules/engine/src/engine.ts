import type { RulePack, RuleCheckResult } from './types.js';

export class RuleEngine {
  private pack: RulePack;

  constructor(pack: RulePack) {
    this.pack = pack;
  }

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
