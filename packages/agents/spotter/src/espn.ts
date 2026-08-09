/**
 * ESPN public API client — fetches live scores and game state.
 *
 * Uses the undocumented but stable site.api.espn.com endpoint.
 * No API key required. Supports MLB, NFL, NBA, NHL.
 */

// ---------------------------------------------------------------------------
// Sport-to-ESPN path mapping
// ---------------------------------------------------------------------------

const SPORT_PATHS: Record<string, string> = {
  baseball: 'baseball/mlb',
  football: 'football/nfl',
  basketball: 'basketball/nba',
  hockey: 'hockey/nhl',
};

// ---------------------------------------------------------------------------
// Types — minimal surface of what we need from ESPN's response
// ---------------------------------------------------------------------------

export interface ESPNGameState {
  /** ESPN event ID (numeric string) */
  eventId: string;

  /** e.g. "ATL @ NYY" */
  shortName: string;

  /** ISO 8601 game start time */
  startTime: string;

  /** 'pre' | 'in' | 'post' */
  state: 'pre' | 'in' | 'post';

  /** e.g. "STATUS_SCHEDULED", "STATUS_IN_PROGRESS", "STATUS_FINAL" */
  statusName: string;

  /** Human-readable detail, e.g. "Bot 7th", "Final", "8/8 - 3:05 PM EDT" */
  detail: string;

  /** Short detail, e.g. "Bot 7th", "Final" */
  shortDetail: string;

  /** Current period (inning for MLB, quarter for NFL/NBA, period for NHL) */
  period: number;

  /** Display clock ("0:00" for baseball, "12:45" for timed sports) */
  clock: string;

  /** Home team */
  home: TeamScore;

  /** Away team */
  away: TeamScore;

  /** Venue info */
  venue: VenueInfo;
}

export interface TeamScore {
  abbreviation: string;
  displayName: string;
  score: number;
}

export interface VenueInfo {
  name: string;
  city: string;
  state: string;
  indoor: boolean;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const BASE_URL = 'https://site.api.espn.com/apis/site/v2/sports';

export class ESPNClient {
  /**
   * Fetch the scoreboard for a sport and find a specific game by event ID.
   * Returns null if the game isn't found (wrong date, bad ID, etc.).
   */
  async getGame(sport: string, eventId: string): Promise<ESPNGameState | null> {
    const path = SPORT_PATHS[sport];
    if (!path) {
      console.warn(`[espn] Unknown sport: ${sport}`);
      return null;
    }

    try {
      const res = await fetch(`${BASE_URL}/${path}/scoreboard`);
      if (!res.ok) {
        console.warn(`[espn] Scoreboard fetch failed: ${res.status}`);
        return null;
      }

      const data = await res.json() as ESPNScoreboardResponse;

      for (const event of data.events ?? []) {
        if (event.id === eventId) {
          return parseEvent(event);
        }
      }

      // Not found on today's scoreboard — might be a different date
      return null;
    } catch (err) {
      console.warn(`[espn] Fetch error:`, err);
      return null;
    }
  }

  /**
   * Fetch all games on the scoreboard for a sport.
   */
  async getScoreboard(sport: string): Promise<ESPNGameState[]> {
    const path = SPORT_PATHS[sport];
    if (!path) return [];

    try {
      const res = await fetch(`${BASE_URL}/${path}/scoreboard`);
      if (!res.ok) return [];

      const data = await res.json() as ESPNScoreboardResponse;
      return (data.events ?? []).map(parseEvent);
    } catch {
      return [];
    }
  }

  /**
   * Find a game by team abbreviations (e.g. "TEX", "CLE") on today's scoreboard.
   * Useful when you don't have the ESPN event ID.
   */
  async findGame(sport: string, teamAbbr: string): Promise<ESPNGameState | null> {
    const games = await this.getScoreboard(sport);
    const upper = teamAbbr.toUpperCase();
    return games.find(g =>
      g.home.abbreviation === upper || g.away.abbreviation === upper
    ) ?? null;
  }

  /**
   * Find live/upcoming games across all sports (or one sport).
   * Returns a compact summary suitable for picking games to watch.
   */
  async findLiveGames(sport?: string): Promise<LiveGameSummary[]> {
    const sports = sport ? [sport] : Object.keys(SPORT_PATHS);
    const results: LiveGameSummary[] = [];

    for (const s of sports) {
      const games = await this.getScoreboard(s);
      for (const g of games) {
        results.push({
          sport: s,
          espnEventId: g.eventId,
          shortName: g.shortName,
          state: g.state,
          detail: g.shortDetail,
          startTime: g.startTime,
          homeTeam: g.home.abbreviation,
          homeScore: g.home.score,
          awayTeam: g.away.abbreviation,
          awayScore: g.away.score,
          venue: g.venue.name,
          indoor: g.venue.indoor,
        });
      }
    }

    return results;
  }
}

export interface LiveGameSummary {
  sport: string;
  espnEventId: string;
  shortName: string;
  state: 'pre' | 'in' | 'post';
  detail: string;
  startTime: string;
  homeTeam: string;
  homeScore: number;
  awayTeam: string;
  awayScore: number;
  venue: string;
  indoor: boolean;
}

// ---------------------------------------------------------------------------
// Internal parse helpers
// ---------------------------------------------------------------------------

interface ESPNScoreboardResponse {
  events?: ESPNEvent[];
}

interface ESPNEvent {
  id: string;
  shortName?: string;
  date?: string;
  status?: {
    type?: {
      name?: string;
      state?: string;
      description?: string;
      detail?: string;
      shortDetail?: string;
    };
    period?: number;
    displayClock?: string;
  };
  competitions?: Array<{
    competitors?: Array<{
      homeAway?: string;
      score?: string;
      team?: {
        abbreviation?: string;
        displayName?: string;
      };
    }>;
    venue?: {
      fullName?: string;
      indoor?: boolean;
      address?: {
        city?: string;
        state?: string;
      };
    };
  }>;
}

function parseEvent(event: ESPNEvent): ESPNGameState {
  const status = event.status ?? {};
  const statusType = status.type ?? {};
  const comp = (event.competitions ?? [])[0] ?? {};
  const competitors = comp.competitors ?? [];
  const venue = comp.venue ?? {};

  const home = competitors.find(c => c.homeAway === 'home');
  const away = competitors.find(c => c.homeAway === 'away');

  return {
    eventId: event.id,
    shortName: event.shortName ?? '',
    startTime: event.date ?? '',
    state: (statusType.state as 'pre' | 'in' | 'post') ?? 'pre',
    statusName: statusType.name ?? '',
    detail: statusType.detail ?? '',
    shortDetail: statusType.shortDetail ?? '',
    period: status.period ?? 0,
    clock: status.displayClock ?? '0:00',
    home: {
      abbreviation: home?.team?.abbreviation ?? '',
      displayName: home?.team?.displayName ?? '',
      score: parseInt(home?.score ?? '0', 10) || 0,
    },
    away: {
      abbreviation: away?.team?.abbreviation ?? '',
      displayName: away?.team?.displayName ?? '',
      score: parseInt(away?.score ?? '0', 10) || 0,
    },
    venue: {
      name: venue.fullName ?? '',
      city: venue.address?.city ?? '',
      state: venue.address?.state ?? '',
      indoor: venue.indoor ?? false,
    },
  };
}
