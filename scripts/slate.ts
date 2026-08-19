#!/usr/bin/env tsx
/**
 * Fetch today's games from ESPN and create a slate on the APRON server.
 *
 * Usage:
 *   pnpm slate                  # 4 games, prod
 *   pnpm slate --count 6        # 6 games
 *   pnpm slate --local          # target localhost:3000
 *   pnpm slate --dry            # preview without creating
 *   pnpm slate --sports mlb,mls # only MLB + MLS
 */

const PROD_URL = 'https://apron-203460075246.us-central1.run.app';
const LOCAL_URL = 'http://localhost:3000';

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const FETCH_HEADERS = { 'User-Agent': 'curl/8.7.1', 'Accept': 'application/json' };

interface ESPNGame {
  id: string;
  away: string;
  home: string;
  venue: string;
  time: string;      // HH:MM local
  timezone: string;   // IANA
  status: string;
  sport: 'baseball' | 'football' | 'soccer';
  network: string;
  displayName: string;
}

// ---------------------------------------------------------------------------
// ESPN fetch
// ---------------------------------------------------------------------------

const SPORT_CONFIGS: Array<{
  key: string;
  path: string;
  sport: 'baseball' | 'football' | 'soccer';
  network: string;
}> = [
  { key: 'mlb', path: 'baseball/mlb', sport: 'baseball', network: 'MLB.TV' },
  { key: 'nfl', path: 'football/nfl', sport: 'football', network: 'NFL Network' },
  { key: 'mls', path: 'soccer/usa.1', sport: 'soccer', network: 'MLS Season Pass' },
];

// Map ESPN venue names to IANA timezones (best-effort)
const VENUE_TZ: Record<string, string> = {
  // ET venues
  'Oriole Park at Camden Yards': 'America/New_York',
  'Yankee Stadium': 'America/New_York',
  'Citi Field': 'America/New_York',
  'Citizens Bank Park': 'America/New_York',
  'Fenway Park': 'America/New_York',
  'PNC Park': 'America/New_York',
  'Tropicana Field': 'America/New_York',
  'Progressive Field': 'America/New_York',
  'Subaru Park': 'America/New_York',
  'MetLife Stadium': 'America/New_York',
  'Gillette Stadium': 'America/New_York',
  'Audi Field': 'America/New_York',
  'Red Bull Arena': 'America/New_York',
  'Inter&Co Stadium': 'America/New_York',
  'BMO Field': 'America/New_York',
  'TQL Stadium': 'America/New_York',
  'Highmark Stadium': 'America/New_York',
  'Mercedes-Benz Stadium': 'America/New_York',
  'Paycor Stadium': 'America/New_York',
  'M&T Bank Stadium': 'America/New_York',
  'Caesars Superdome': 'America/New_York',
  'ScottsMiracle-Gro Field': 'America/New_York',
  // CT venues
  'Wrigley Field': 'America/Chicago',
  'Guaranteed Rate Field': 'America/Chicago',
  'Target Field': 'America/Chicago',
  'Kauffman Stadium': 'America/Chicago',
  'American Family Field': 'America/Chicago',
  'Great American Ball Park': 'America/New_York',
  'Soldier Field': 'America/Chicago',
  'GEHA Field at Arrowhead Stadium': 'America/Chicago',
  'Sporting Park': 'America/Chicago',
  'Allianz Field': 'America/Chicago',
  'NRG Stadium': 'America/Chicago',
  'Daikin Park': 'America/Chicago',
  // MT venues
  'Coors Field': 'America/Denver',
  'Chase Field': 'America/Phoenix',
  'Allegiant Stadium': 'America/Los_Angeles',
  "Dick's Sporting Goods Park": 'America/Denver',
  'Dicks Sporting Goods Park': 'America/Denver',
  'America First Field': 'America/Denver',
  // PT venues
  'Dodger Stadium': 'America/Los_Angeles',
  'Oracle Park': 'America/Los_Angeles',
  'Angel Stadium': 'America/Los_Angeles',
  'T-Mobile Park': 'America/Los_Angeles',
  'Petco Park': 'America/Los_Angeles',
  "Levi's Stadium": 'America/Los_Angeles',
  'Lumen Field': 'America/Los_Angeles',
  'Dignity Health Sports Park': 'America/Los_Angeles',
  'Providence Park': 'America/Los_Angeles',
  'BC Place': 'America/Los_Angeles',
  'Globe Life Field': 'America/Chicago',
  'Northwest Stadium': 'America/New_York',
  'Acrisure Stadium': 'America/New_York',
};

function inferTz(venue: string): string {
  return VENUE_TZ[venue] ?? 'America/New_York';
}

function parseESPNTime(dateStr: string, tz: string): string {
  // ESPN gives us full ISO or "8/19 - 6:35 PM EDT" style
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      const fmt = new Intl.DateTimeFormat('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz,
      });
      return fmt.format(d);
    }
  } catch { /* fall through */ }
  return '19:00';
}

async function fetchGames(sportConfig: typeof SPORT_CONFIGS[0], dateStr: string): Promise<ESPNGame[]> {
  const url = `${ESPN_BASE}/${sportConfig.path}/scoreboard?dates=${dateStr}`;
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) return [];
  const data = await res.json() as any;
  const events = data.events ?? [];

  return events.map((ev: any) => {
    const comp = ev.competitions?.[0];
    const away = comp?.competitors?.find((t: any) => t.homeAway === 'away');
    const home = comp?.competitors?.find((t: any) => t.homeAway === 'home');
    const venue = comp?.venue?.fullName ?? '';
    const tz = inferTz(venue);
    const status = comp?.status?.type?.name ?? '';
    const startDate = comp?.date ?? ev.date ?? '';

    const awayAbbr = away?.team?.abbreviation ?? '?';
    const homeAbbr = home?.team?.abbreviation ?? '?';

    return {
      id: ev.id,
      away: awayAbbr,
      home: homeAbbr,
      venue,
      time: parseESPNTime(startDate, tz),
      timezone: tz,
      status,
      sport: sportConfig.sport,
      network: sportConfig.network,
      displayName: `${awayAbbr} @ ${homeAbbr}`,
    };
  });
}

// ---------------------------------------------------------------------------
// Slate picker — prefer evening games, variety
// ---------------------------------------------------------------------------

function pickSlate(allGames: ESPNGame[], count: number): ESPNGame[] {
  // Filter to scheduled/pre-game only (skip Final, In Progress)
  const upcoming = allGames.filter(g =>
    g.status === 'STATUS_SCHEDULED' || g.status === 'STATUS_PREGAME'
  );

  // If not enough upcoming, include in-progress
  const pool = upcoming.length >= count
    ? upcoming
    : [...upcoming, ...allGames.filter(g => g.status === 'STATUS_IN_PROGRESS')];

  if (pool.length === 0) {
    // Everything is final — just grab the last N
    return allGames.slice(-count);
  }

  // Sort by start time (evening first for better demo), then shuffle within time bands
  pool.sort((a, b) => a.time.localeCompare(b.time));

  // Try to get variety across sports
  const bySport = new Map<string, ESPNGame[]>();
  for (const g of pool) {
    if (!bySport.has(g.sport)) bySport.set(g.sport, []);
    bySport.get(g.sport)!.push(g);
  }

  const picked: ESPNGame[] = [];
  const sports = [...bySport.keys()];

  // Round-robin across sports
  let sportIdx = 0;
  while (picked.length < count && picked.length < pool.length) {
    const sport = sports[sportIdx % sports.length]!;
    const sportGames = bySport.get(sport)!;
    const next = sportGames.find(g => !picked.includes(g));
    if (next) {
      picked.push(next);
    }
    sportIdx++;
    // Break if we've gone around with nothing added
    if (sportIdx > sports.length * count) break;
  }

  return picked.slice(0, count);
}

// ---------------------------------------------------------------------------
// Create games via API
// ---------------------------------------------------------------------------

async function getAccountId(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/admin/accounts`);
  const accounts = await res.json() as any[];
  if (!accounts.length) throw new Error('No accounts found — run POST /api/admin/seed first');
  return accounts[0].id;
}

async function createGame(baseUrl: string, accountId: string, game: ESPNGame, date: string) {
  const title = game.sport === 'soccer'
    ? `${game.displayName} (MLS)`
    : game.displayName;

  const res = await fetch(`${baseUrl}/api/admin/accounts/${accountId}/games`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      date,
      startTime: game.time,
      venue: game.venue,
      gameType: game.sport,
      espnEventId: game.id,
      timezone: game.timezone,
      network: game.network,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(`Failed to create ${title}: ${err.error ?? res.statusText}`);
  }

  return await res.json() as any;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const flags = {
    count: 4,
    local: false,
    dry: false,
    sports: ['mlb', 'nfl', 'mls'] as string[],
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--count' && args[i + 1]) { flags.count = parseInt(args[++i]!, 10); }
    else if (args[i] === '--local') { flags.local = true; }
    else if (args[i] === '--dry') { flags.dry = true; }
    else if (args[i] === '--sports' && args[i + 1]) { flags.sports = args[++i]!.split(','); }
  }

  const baseUrl = flags.local ? LOCAL_URL : PROD_URL;
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
  const datePretty = today.toISOString().slice(0, 10);

  console.log(`\n⚾ Fetching games for ${datePretty}...\n`);

  // Fetch from all configured sports
  const allGames: ESPNGame[] = [];
  for (const config of SPORT_CONFIGS) {
    if (!flags.sports.includes(config.key)) continue;
    const games = await fetchGames(config, dateStr);
    const scheduled = games.filter(g => g.status !== 'STATUS_FINAL' && g.status !== 'STATUS_POSTPONED');
    console.log(`  ${config.key.toUpperCase()}: ${games.length} total, ${scheduled.length} upcoming`);
    allGames.push(...games);
  }

  if (allGames.length === 0) {
    console.log('\n  No games found. Check --sports flag or try another day.\n');
    process.exit(1);
  }

  const slate = pickSlate(allGames, flags.count);

  console.log(`\n📋 Slate (${slate.length} games):\n`);
  for (const g of slate) {
    const sportIcon = g.sport === 'baseball' ? '⚾' : g.sport === 'football' ? '🏈' : '⚽';
    console.log(`  ${sportIcon}  ${g.displayName.padEnd(16)} ${g.time}  ${g.venue}  (${g.id})`);
  }

  if (flags.dry) {
    console.log('\n  --dry mode: no games created.\n');
    process.exit(0);
  }

  console.log(`\n🚀 Creating on ${flags.local ? 'localhost' : 'prod'}...\n`);

  const accountId = await getAccountId(baseUrl);

  for (const g of slate) {
    try {
      const result = await createGame(baseUrl, accountId, g, datePretty);
      console.log(`  ✅ ${result.title} → ${result.id}`);
    } catch (err: any) {
      console.log(`  ❌ ${err.message}`);
    }
  }

  console.log(`\n  Done. Auto-scheduler will start them ~15m before game time.\n`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
