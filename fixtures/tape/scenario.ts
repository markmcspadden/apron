import type { FixtureScenario } from '@apron/types';

/**
 * TAPE — three-minute demo fixture.
 *
 * Same ALCS Gm 4 game but starts at Bot 10th (already in extras) and models
 * all 22 traveling crew so the board roster fills the screen when scrolled.
 *
 * Key differences from alcs-gm4:
 *   • 22 crew rows (not 14) — 8 additional T2 positions
 *   • Initial gameState is Bot 10th, not Bot 9th
 *   • All 4 external calls remain NOT BROKERABLE — production seat shows
 *     "External call · withheld" for all four at the Act 3 seat switch
 *   • Steps tuned to match the narrated video beats
 */
export const scenario: FixtureScenario = {
  id: 'tape',
  title: 'ALCS Gm 4 · Demo Tape',
  description: 'Three-minute demo tape. Twelve-inning ALCS game at Progressive Field. 22 traveling crew. Four A-list positions breach mandatory rest for a Monday Night Football call in Kansas City.',

  shows: [
    { id: 'alcs', net: 'FOX', title: 'ALCS Gm 4 · Rangers @ Guardians', venue: 'Progressive Field · Cleveland',
      gameState: 'Bot 10th · 4–4', live: true, crewCount: 22, state: 'watch', alert: null, hero: true },
    { id: 'snf', net: 'NBC', title: 'Sunday Night Football · Ravens @ Chiefs', venue: 'Arrowhead · Kansas City',
      gameState: 'Q4 · 28–24', live: true, crewCount: 34, state: 'clear', alert: null, hero: false },
    { id: 'nba', net: 'ESPN', title: 'Celtics @ Nuggets', venue: 'Ball Arena · Denver',
      gameState: 'Q3 · 71–68', live: true, crewCount: 19, state: 'clear', alert: null, hero: false },
    { id: 'pga', net: 'GOLF', title: "Shriners Children's Open · R4", venue: 'TPC Summerlin · Las Vegas',
      gameState: 'Wrapped 21:12', live: false, crewCount: 31, state: 'watch',
      alert: '<b>TRAFFIC:</b> LAS ground stop lifted 21:40. 3 crew rebooked, all clear.', hero: false },
    { id: 'b1g', net: 'FOX', title: 'Michigan @ Penn State', venue: 'Beaver Stadium · State College',
      gameState: 'Wrapped 19:48', live: false, crewCount: 26, state: 'clear', alert: null, hero: false },
    { id: 'nhl', net: 'VIC+', title: 'Stars @ Avalanche', venue: 'Ball Arena · Denver',
      gameState: 'Wrapped 22:02', live: false, crewCount: 15, state: 'clear', alert: null, hero: false },
  ],

  // ─── 22 crew members ──────────────────────────────────────────────────────────
  //
  //  14 on 06:05–06:40 departures  ·  8 on later flights
  //   4 A-list with external MNF calls (all NOT BROKERABLE)
  //   3 key positions going to ALCS Gm 5 in Arlington
  //  15 T2 going home or on soft holds
  //
  crew: [
    // ── A-list / Key positions with external calls (4) ──────────────
    { id: 'marcus-vale', position: 'TD', keyPosition: true, name: 'Marcus Vale', externalCall: true, disclosed: false,
      provenance: ['external', '⧉', 'External network · validated · Fri 14:22<span class="nobrk">NOT BROKERABLE</span>'],
      homeMarket: 'Truck · A-unit', tier: 'T1',
      nextCall: 'External call · <span class="redact">production withheld</span><br><span class="sub2">Arr MCI by Mon 13:00 CT</span>',
      routing: 'UA 4412 · 06:05 CLE→ORD→MCI', arrival: 'arr 09:48', slackMinutes: 225 },

    { id: 'dana-roarke', position: 'A1', keyPosition: true, name: 'Dana Roarke', externalCall: true, disclosed: false,
      provenance: ['external', '⧉', 'External network · validated · Fri 14:22<span class="nobrk">NOT BROKERABLE</span>'],
      homeMarket: 'Audio booth', tier: 'T1',
      nextCall: 'External call · <span class="redact">production withheld</span><br><span class="sub2">Arr MCI by Mon 13:00 CT</span>',
      routing: 'UA 4412 · 06:05 CLE→ORD→MCI', arrival: 'arr 09:48', slackMinutes: 225 },

    { id: 'hal-brennan', position: 'DIR', keyPosition: true, name: 'Hal Brennan', externalCall: true, disclosed: false,
      provenance: ['external', '⧉', 'External network · validated · Fri 14:22<span class="nobrk">NOT BROKERABLE</span>'],
      homeMarket: 'Truck · A-unit', tier: 'T1',
      nextCall: 'External call · <span class="redact">production withheld</span><br><span class="sub2">Arr MCI by Mon 13:00 CT</span>',
      routing: 'UA 4412 · 06:05 CLE→ORD→MCI', arrival: 'arr 09:48', slackMinutes: 225 },

    { id: 'priya-raman', position: 'LEAD EVS', keyPosition: true, name: 'Priya Raman', externalCall: true, disclosed: false,
      provenance: ['inferred', '⚠', 'Inferred from return routing'],
      homeMarket: 'Tape room', tier: 'T1',
      nextCall: 'External call · <span class="redact">production withheld</span><br><span class="sub2">Arr MCI by Mon 13:00 CT</span>',
      routing: 'UA 4412 · 06:05 CLE→ORD→MCI', arrival: 'arr 09:48', slackMinutes: 225 },

    // ── Key positions, no external call (3) ─────────────────────────
    { id: 'sal-ferreira', position: 'EIC', keyPosition: true, name: 'Sal Ferreira', externalCall: false, disclosed: false,
      provenance: ['sheet', '▪', 'FOX crew sheet · Thu 09:10'],
      homeMarket: 'Truck · engineering', tier: 'T1',
      nextCall: 'ALCS Gm 5 · Arlington<br><span class="sub2">Tue 09:00 CT</span>',
      routing: 'AA 1188 · 07:20 CLE→DFW', arrival: 'arr 09:15', slackMinutes: 300 },

    { id: 'beth-calloway', position: 'TECH MGR', keyPosition: false, name: 'Beth Calloway', externalCall: false, disclosed: false,
      provenance: ['sheet', '▪', 'FOX crew sheet · Thu 09:10'],
      homeMarket: 'Compound', tier: 'T1',
      nextCall: 'ALCS Gm 5 · Arlington<br><span class="sub2">Tue 09:00 CT</span>',
      routing: 'AA 1188 · 07:20 CLE→DFW', arrival: 'arr 09:15', slackMinutes: 300 },

    { id: 'nina-kowalski', position: 'A2', keyPosition: false, name: 'Nina Kowalski', externalCall: false, disclosed: false,
      provenance: ['sheet', '▪', 'FOX crew sheet · Thu 09:10'],
      homeMarket: 'Field', tier: 'T1',
      nextCall: 'ALCS Gm 5 · Arlington<br><span class="sub2">Tue 09:00 CT</span>',
      routing: 'AA 1188 · 07:20 CLE→DFW', arrival: 'arr 09:15', slackMinutes: 300 },

    // ── T2 crew — original ALCS positions (7) ───────────────────────
    { id: 'terrence-ott', position: 'V1 SHADE', keyPosition: false, name: 'Terrence Ott', externalCall: false, disclosed: false,
      provenance: ['none', '—', 'No commitment on record'],
      homeMarket: 'Truck · video', tier: 'T2',
      nextCall: 'Home · PHX<br><span class="sub2">No call held</span>',
      routing: 'AA 2244 · 06:40 CLE→PHX', arrival: 'arr 08:55', slackMinutes: 260 },

    { id: 'chris-bell', position: 'EVS 2', keyPosition: false, name: 'Chris Bell', externalCall: false, disclosed: false,
      provenance: ['none', '—', 'No commitment on record'],
      homeMarket: 'Tape room', tier: 'T2',
      nextCall: 'Home · ATL<br><span class="sub2">No call held</span>',
      routing: 'DL 1907 · 06:15 CLE→ATL', arrival: 'arr 08:12', slackMinutes: 235 },

    { id: 'ray-nkemdirim', position: 'EVS 3', keyPosition: false, name: 'Ray Nkemdirim', externalCall: false, disclosed: false,
      provenance: ['sheet', '▪', 'FOX crew sheet · soft hold'],
      homeMarket: 'Tape room', tier: 'T2',
      nextCall: 'Home · DFW<br><span class="sub2">Thu 12:00 held</span>',
      routing: 'AA 1188 · 07:20 CLE→DFW', arrival: 'arr 09:15', slackMinutes: 300 },

    { id: 'joel-amado', position: 'GFX', keyPosition: false, name: 'Joel Amado', externalCall: false, disclosed: false,
      provenance: ['none', '—', 'No commitment on record'],
      homeMarket: 'Graphics', tier: 'T2',
      nextCall: 'Home · CLT<br><span class="sub2">No call held</span>',
      routing: 'AA 1620 · 09:05 CLE→CLT', arrival: 'arr 10:52', slackMinutes: 405 },

    { id: 'danny-osei', position: 'RF ENG', keyPosition: false, name: 'Danny Osei', externalCall: false, disclosed: false,
      provenance: ['none', '—', 'No commitment on record'],
      homeMarket: 'Field', tier: 'T2',
      nextCall: 'Home · BNA<br><span class="sub2">No call held</span>',
      routing: 'WN 2210 · 10:15 CLE→BNA', arrival: 'arr 11:34', slackMinutes: 475 },

    { id: 'sofia-vance', position: 'A2 FIELD', keyPosition: false, name: 'Sofia Vance', externalCall: false, disclosed: false,
      provenance: ['none', '—', 'No commitment on record'],
      homeMarket: 'Field', tier: 'T2',
      nextCall: 'Home · MSP<br><span class="sub2">No call held</span>',
      routing: 'DL 2016 · 06:25 CLE→MSP', arrival: 'arr 07:58', slackMinutes: 245 },

    { id: 'ellen-mabry', position: 'PROD', keyPosition: false, name: 'Ellen Mabry', externalCall: false, disclosed: false,
      provenance: ['none', '—', 'No commitment on record'],
      homeMarket: 'Truck · A-unit', tier: 'T2',
      nextCall: 'Home · LGA<br><span class="sub2">No call held</span>',
      routing: 'DL 1422 · 08:30 CLE→LGA', arrival: 'arr 10:05', slackMinutes: 370 },

    // ── T2 crew — additional tape positions (8) ─────────────────────
    { id: 'mia-torres', position: 'AP', keyPosition: false, name: 'Mia Torres', externalCall: false, disclosed: false,
      provenance: ['sheet', '▪', 'FOX crew sheet · soft hold'],
      homeMarket: 'Truck · A-unit', tier: 'T2',
      nextCall: 'ALCS Gm 5 · Arlington<br><span class="sub2">Tue 09:00 CT · soft hold</span>',
      routing: 'WN 1804 · 06:10 CLE→MDW', arrival: 'arr 06:35', slackMinutes: 180 },

    { id: 'jalen-brooks', position: 'FONT OP', keyPosition: false, name: 'Jalen Brooks', externalCall: false, disclosed: false,
      provenance: ['none', '—', 'No commitment on record'],
      homeMarket: 'Graphics', tier: 'T2',
      nextCall: 'Home · DTW<br><span class="sub2">No call held</span>',
      routing: 'DL 1850 · 06:30 CLE→DTW', arrival: 'arr 07:15', slackMinutes: 210 },

    { id: 'lena-cho', position: 'SHADER 2', keyPosition: false, name: 'Lena Cho', externalCall: false, disclosed: false,
      provenance: ['none', '—', 'No commitment on record'],
      homeMarket: 'Truck · video', tier: 'T2',
      nextCall: 'Home · DCA<br><span class="sub2">No call held</span>',
      routing: 'UA 1523 · 06:20 CLE→IAD', arrival: 'arr 08:05', slackMinutes: 265 },

    { id: 'aaron-finch', position: 'STAGE MGR', keyPosition: false, name: 'Aaron Finch', externalCall: false, disclosed: false,
      provenance: ['sheet', '▪', 'FOX crew sheet · Thu 09:10'],
      homeMarket: 'Compound', tier: 'T2',
      nextCall: 'Home · DCA<br><span class="sub2">Wed soft hold</span>',
      routing: 'AA 1701 · 06:35 CLE→DCA', arrival: 'arr 08:15', slackMinutes: 270 },

    { id: 'kenji-watanabe', position: 'UTIL', keyPosition: false, name: 'Kenji Watanabe', externalCall: false, disclosed: false,
      provenance: ['none', '—', 'No commitment on record'],
      homeMarket: 'Compound', tier: 'T2',
      nextCall: 'Home · ATL<br><span class="sub2">No call held</span>',
      routing: 'DL 1907 · 06:15 CLE→ATL', arrival: 'arr 08:12', slackMinutes: 235 },

    { id: 'delia-santos', position: 'CAM 1', keyPosition: false, name: 'Delia Santos', externalCall: false, disclosed: false,
      provenance: ['none', '—', 'No commitment on record'],
      homeMarket: 'Field', tier: 'T2',
      nextCall: 'Home · BWI<br><span class="sub2">No call held</span>',
      routing: 'WN 1288 · 06:25 CLE→BWI', arrival: 'arr 07:58', slackMinutes: 250 },

    { id: 'ravi-agarwal', position: 'CAM 5', keyPosition: false, name: 'Ravi Agarwal', externalCall: false, disclosed: false,
      provenance: ['none', '—', 'No commitment on record'],
      homeMarket: 'Field', tier: 'T2',
      nextCall: 'Home · PHX<br><span class="sub2">No call held</span>',
      routing: 'AA 2244 · 06:40 CLE→PHX', arrival: 'arr 08:55', slackMinutes: 260 },

    { id: 'tanya-bridges', position: 'SPOT', keyPosition: false, name: 'Tanya Bridges', externalCall: false, disclosed: false,
      provenance: ['none', '—', 'No commitment on record'],
      homeMarket: 'Compound', tier: 'T2',
      nextCall: 'Home · CLT<br><span class="sub2">No call held</span>',
      routing: 'AA 1620 · 09:05 CLE→CLT', arrival: 'arr 10:52', slackMinutes: 405 },
  ],

  chain: [
    { label: 'Final out', baseTime: '22:58', revisedTime: '01:05' },
    { label: 'Strike complete', baseTime: '00:13', revisedTime: '02:20' },
    { label: 'Shuttle rolls', baseTime: '00:28', revisedTime: '02:35' },
    { label: 'Airport hotel', baseTime: '00:55', revisedTime: '03:02' },
    { label: 'Rest before 04:30 lobby', baseTime: '3h50m', revisedTime: '1h28m', midTime: '2h11m', isDuration: true },
  ],

  offlineAgents: {
    CUSTOMS: 'Carnet, work permit and border-clearance watch. Not provisioned: CLE is domestic and all 22 next calls stay inside the US.',
  },

  crewNote: '<b>CUSTOMS is off for this show</b> — no border crossing on the wrap or on any of the 22 next calls. It provisions for Toronto, London, Mexico City and any cross-border next call, and carries the gear carnet with it.',

  handoffText: `<b>To:</b> CTM Entertainment · Sports &amp; Entertainment Desk
<b>Re:</b> FOX / ALCS Gm 4 · Progressive Field · crew backhaul

Game ran to 01:05 ET. 22 crew affected by extended wrap.
ORD has a ground delay program 06:00–09:00 — do not reroute via ORD.

<b>GROUP A — rebook, hard call time (4 pax)</b>
  VALE/MARCUS      PNR K7Q2XP    UA4412 → <b>DL1140 08:50 CLE-DTW-MCI</b>
  ROARKE/DANA      PNR K7Q2XR    UA4412 → <b>DL1140</b>
  BRENNAN/HAL      PNR K7Q2XS    UA4412 → <b>DL1140</b>
  RAMAN/PRIYA      PNR K7Q2XT    UA4412 → <b>DL1140</b>
  ↳ Must be MCI by 12:40. External call 14:00 CT.

<b>GROUP B — hold as booked (3 pax)</b>
  FERREIRA/SAL · CALLOWAY/BETH · KOWALSKI/NINA — AA1188 07:20 CLE-DFW stands.

<b>GROUP C — same-day rebook, no hard call (15 pax)</b>
  Push to first available after 10:00. Comfort over speed. Detail attached.

Hotel: 22 rooms extended to 09:00 checkout, central bill.
Ground: shuttle re-called for <b>07:15</b> lobby.`,

  optionGroups: [
    {
      crewNames: 'TD · Marcus Vale  ·  A1 · Dana Roarke  ·  DIR · Hal Brennan  ·  LEAD EVS · Priya Raman',
      constraint: 'External call · arrive <b>MCI by Mon 13:00 CT</b> · mandatory rest 8h · liability external',
      options: [
        { route: 'AA 2287 · 09:15 CLE→DFW→MCI · arr 14:32', rationale: 'Cheapest available seat at current fare class',
          verdict: 'Misses call by 32m', verdictPass: false, costDelta: '+$418', totalCost: '—', recommended: false },
        { route: 'DL 1140 · 08:50 CLE→DTW→MCI · arr 12:40', rationale: 'Clears call with 7h20m rest · ground plan intact',
          verdict: 'Clears · no penalty', verdictPass: true, costDelta: '+$602', totalCost: '+$602', recommended: true },
        { route: 'Hold overnight · 9h drive CLE→MCI', rationale: 'Zero fare cost, but a 9-hour drive after a 14-hour day',
          verdict: 'Clears · fatigue risk', verdictPass: false, costDelta: '+$0', totalCost: '—', recommended: false },
      ],
    },
    {
      crewNames: 'EIC · Sal Ferreira  ·  TECH MGR · Beth Calloway  ·  A2 · Nina Kowalski',
      constraint: 'ALCS Gm 5 · Arlington · call <b>Tue 09:00 CT</b> · 29h available',
      options: [
        { route: 'AA 1188 · 07:20 CLE→DFW · arr 09:15 (as booked)', rationale: 'Departure holds. Push lobby call to 05:45.',
          verdict: 'Clears · no change', verdictPass: true, costDelta: '$0', totalCost: '$0', recommended: true },
        { route: 'AA 1420 · 11:40 CLE→DFW · arr 13:35', rationale: 'Adds 4h sleep · still clears Tuesday call by 19h',
          verdict: 'Clears · more rest', verdictPass: true, costDelta: '+$96', totalCost: '+$96', recommended: false },
      ],
    },
  ],

  // ─── Steps — sequenced to match the three-minute video beats ───────────────
  //
  //  Cold open  → Act 1 WATCH → Act 2 DECIDE → Handoff → CLEAR
  //
  steps: [
    // ── Cold open: Bot 10th, board already live ─────────────────────
    { timestamp: '22:38', agent: 'ADVANCE',
      message: 'Roster locked for FOX / ALCS Gm 4. <b>22 traveling · 6 hold a next call.</b> 4 from network crew sheets, 1 confirmed by crew, <span class="hl">1 inferred from return routing — Raman/Priya, unconfirmed.</span>' },

    { timestamp: '22:41', agent: 'SPOTTER',
      message: 'Bot 10th, tied 4–4. Projected final revised <b>22:58 → 23:20</b>. Chain recomputed for 22 traveling crew.',
      gameState: ['Bot 10th · 4–4', 'live'], showState: 'watch', metrics: { risk: 0, exposed: 0 } },

    // ── Act 1 · WATCH ───────────────────────────────────────────────
    { timestamp: '23:52', agent: 'SPOTTER',
      message: '11th inning. Projected final <b>00:35</b>. Wrap-to-gate chain now lands crew at the airport hotel <b>03:02</b>. Gemini confidence: 78 %.',
      gameState: ['Bot 11th · 4–4', 'live'], chainLevel: 1, showState: 'watch', slackDelta: -130 },

    { timestamp: '23:54', agent: 'TRAFFIC',
      message: '<b>14 of 22</b> crew are on 06:05–06:40 departures. At a 03:02 hotel arrival that is <span class="hl">90 minutes of sleep</span> before a 04:30 lobby call.',
      showState: 'risk', metrics: { risk: 14, exposed: 0 }, crewStates: { T2: 'WATCH', T1: 'RISK' } },

    // ── Act 2 · DECIDE ──────────────────────────────────────────────
    { timestamp: '00:47', agent: 'SPOTTER',
      message: '12th inning. Projected final <b>01:05</b>. Strike complete 02:20. This is now the longest ALCS game since 2018.',
      gameState: ['Top 12th · 4–4', 'live'], chainLevel: 2, showState: 'risk' },

    { timestamp: '00:49', agent: 'STEWARD',
      message: 'Turnaround check against <b>NABET-CWA Art. 8.3</b>. Schedule was built for a 22:58 wrap — now 01:05. Travel counts as work, not rest. <span class="hl">4 A-list positions breach mandatory rest for a 14:00 CT call in Kansas City.</span>',
      metrics: { exposed: 4 }, crewStates: { MNF: 'BROKEN' }, agentStates: { STEWARD: 'hot' } },

    { timestamp: '00:50', agent: 'ADVANCE',
      message: 'Hold — one of those four is <b>inferred, not confirmed</b>. Raman/Priya\'s external call came from return routing, never validated. Requesting confirmation before STEWARD acts on it.',
      agentStates: { ADVANCE: 'hot', STEWARD: 'hot' } },

    { timestamp: '00:51', agent: 'WRANGLER',
      message: 'Raman is <b>live on the show</b> — tape room, 12th inning. Holding contact until the half-inning break. Will not interrupt a working position for a data confirmation.',
      agentStates: { WRANGLER: 'hot', ADVANCE: 'hot' } },

    { timestamp: '00:52', agent: 'WRANGLER',
      message: 'Confirmed by Raman during the break — <b>arrival MCI by 13:00 CT</b>. Constraint confirmed; production not volunteered. All four external calls remain redacted in the production view.',
      provenance: { 'Priya Raman': ['confirmed', '✓', 'Crew-confirmed · Sun 00:52<span class="nobrk">NOT BROKERABLE</span>'] } },

    { timestamp: '00:53', agent: 'ADVANCE',
      message: 'Provenance upgraded for Raman — confirmed, no longer inferred. Still <b>not brokerable</b>: she confirmed the constraint but did not name the production. Vale, Roarke, and Brennan stay network-validated. Count stands at 4.' },

    { timestamp: '00:54', agent: 'STEWARD',
      message: 'All four hold <b>external calls</b> — the penalty tier lands on the calling network, <b>not on FOX</b>. Contractual exposure to FOX tonight: <b>$0</b>. FOX\'s exposure is <span class="hl">four A-list positions burned</span> and unavailable for the Gm 5 turnaround.',
      showState: 'down' },

    { timestamp: '00:56', agent: 'TRAFFIC',
      message: '<span class="hl">ORD ground delay program issued 06:00–09:00</span> — low ceilings. The 06:05 CLE→ORD→MCI connection is no longer viable for any of the four.',
      metrics: { risk: 14, exposed: 4 } },

    { timestamp: '00:57', agent: 'FIXER',
      message: 'Generating alternatives. Constraint set per crew member: next call time, contractual rest, ground plan at destination, seat availability at current fare class.',
      agentStates: { FIXER: 'hot' }, showOptions: true },

    { timestamp: '00:59', agent: 'FIXER',
      message: '<b>3 viable paths</b> for the Kansas City four. Recommending DL 1140 via DTW — lands MCI 12:40, clears the external call with <b>7h20m</b> rest, zero rest breach, +$602 fare delta to keep four A-list positions callable.',
      crewStates: { MNF: 'SOLVED' }, metrics: { risk: 10, exposed: 0 },
      routes: { MNF: { route: 'DL 1140 · 08:50 CLE→DTW→MCI', arrival: 'arr 12:40 · rebooked' } } },

    // ── Handoff ─────────────────────────────────────────────────────
    { timestamp: '01:01', agent: 'RUNNER',
      message: 'Desk instruction composed for <b>CTM Entertainment · Sports Desk</b>. PNRs grouped by carrier. Awaiting your release.',
      agentStates: { RUNNER: 'hot' }, showHandoff: true },

    { timestamp: '01:06', agent: 'RUNNER',
      message: 'Released to desk. Agent <b>M. Iyer</b> acknowledged, 22 crew notified by SMS with new lobby call <b>07:15</b>. All 22 routed, 0 call times exposed.',
      gameState: ['Final · 5–4 (12)', 'wrapped 01:05'],
      crewStates: { all: 'SOLVED' }, metrics: { risk: 0, exposed: 0 }, showState: 'clear', done: true },
  ],
};
