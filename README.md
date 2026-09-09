# Apron

**Crew integrity for live sports and entertainment production.**

The game went long. Wrap slipped two hours. Twenty-two people in that compound
have somewhere to be tomorrow, in eleven different cities — and some of them are
going to a different network's show.

Apron is an **irregular operations desk** for live production travel. It does
not book your original travel; that's a solved problem. It watches the show, the
itinerary, and everything that impacts whether the plan holds — then keeps every
next call intact.

*Named for the apron — the ground where aircraft turn, and the stage that
reaches past the curtain.*

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Commercial license available](https://img.shields.io/badge/commercial-available-green.svg)](COMMERCIAL.md)

> Built for [Agentic Cinema: The Blockbuster Hackathon](https://agentic-cinema.devpost.com/).
> Partner tracks: **Grafana** + **Clickhouse** — *see [Partner &amp; Google Cloud usage](#partner--google-cloud-usage).*

---

## Contents

- [The problem](#the-problem)
- [Quick start](#quick-start)
- [The agent crew](#the-agent-crew)
- [Agent separation — the security model](#agent-separation--the-security-model)
- [Provenance and disclosure](#provenance-and-disclosure)
- [Partner & Google Cloud usage](#partner--google-cloud-usage)
- [Observability — the Grafana pipeline](#observability--the-grafana-pipeline)
- [What's here, and what isn't](#whats-here-and-what-isnt)
- [Repository layout](#repository-layout)
- [Contributing](#contributing)
- [License](#license)

---

## The problem

Original booking works. Your travel management company does it well, weeks out,
against a schedule everyone agreed to.

The failure is in the four hours *after* a live event decides to run long, and
the person holding it is an on-site production coordinator standing in a truck
compound with a phone and a spreadsheet. Three things break:

1. **An uncovered position.** The A1 misses Monday's call. You backfill with a
   local who has never mixed that booth.
2. **A turnaround violation you find out about later.** IATSE and NABET-CWA
   measure turnaround wrap-to-call, and travel time counts as work, not rest. A
   generic travel tool will happily book a flight that satisfies the schedule and
   breaks the contract.
3. **The 3:00 AM phone tree.** Twenty-two crew, eleven destinations, one
   after-hours desk.

Unlike team travel, the crew **disperses**. There's no single group itinerary to
fix — there are twenty-two individual ones.

---

## Quick start

Runs entirely offline against synthetic fixtures. No TMC, no carrier
credentials, and no live game feed required to see the full scenario.

```bash
git clone https://github.com/markmcspadden/apron.git
cd apron/apron-starter
pnpm install
pnpm demo                   # replays the ALCS Gm 4 twelve-inning night
```

Then open <http://localhost:3000/demo> for the watch board. The scenario
auto-plays when a client connects. Use the seat switch in the header to move
between the **TMC desk** and the **production seat** and watch the same incident
change shape depending on who is allowed to see what. The marketing site is at
<http://localhost:3000/>.

### Demo tape — the 3-minute video scenario

```bash
pnpm tape                   # 22-crew fixture on port 3002
```

The tape fixture is purpose-built for the demo video: 22 traveling crew (not 14),
game starts at Bot 10th already in extras, all four external calls remain NOT
BROKERABLE so the production seat shows four `External call · withheld` rows at
the seat switch. Same game, same chain, same agents — a tighter cut that fills
every beat of the three-minute narration.

### Running against live services

```bash
cp .env.example .env        # add credentials + partner keys
pnpm dev                    # full server on :3000 — Firestore-backed
```

Dev mode starts the full server with Firestore persistence, the admin console at
`/admin`, the live board at `/board`, agent dashboards at `/traffic`,
`/wrangler`, `/spotter`, `/steward`, and the demo fixture at `/demo`.

Every variable is documented in [`.env.example`](.env.example) with where to
find each credential. The services, grouped:

| Service | Credentials needed | What lights up |
|---|---|---|
| **Google Cloud** | `GOOGLE_CLOUD_PROJECT`, ADC or service account JSON | Gemini reasoning for all agents, Firestore persistence |
| **Grafana — Prometheus** | `GRAFANA_PROM_URL`, `GRAFANA_PROM_USER`, `GRAFANA_PROM_API_KEY` (metrics:write) | Agent event metrics, crew risk gauges, LLM latency |
| **Grafana — Loki** | `GRAFANA_LOKI_URL`, `GRAFANA_LOKI_USER`, `GRAFANA_CLOUD_API_KEY` | Structured agent logs, closeout reports |
| **Grafana — Agent O11y** | `AGENTO11Y_ENDPOINT`, `AGENTO11Y_AUTH_TENANT_ID`, `AGENTO11Y_AUTH_TOKEN` | Per-generation LLM tracing (token usage, latency) |
| **Firebase** | `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY` | Auth (Google sign-in), Firestore data store |
| **AviationStack** | `FLIGHT_STATUS_API_KEY` | Live flight status for TRAFFIC agent |
| **Twilio** | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | SMS outreach for WRANGLER agent |

Each integration degrades gracefully — if a key is missing, that service
disables with a log line and the rest of the system continues. Fixture mode
(`pnpm demo` / `pnpm tape`) needs **none** of them.

See [`docs/runtime.md`](docs/runtime.md) for IAM roles and deployment details.

> **Fixture mode is the supported demo path.** Live mode requires credentials we
> cannot distribute; see [What's here, and what isn't](#whats-here-and-what-isnt).

---

## The agent crew

Not one model with a large prompt. Eight specialists, each owning one domain,
holding one credential, reading only what its job requires. **Crew is provisioned
per show** — a domestic regular-season game doesn't call `CUSTOMS` to work.

| Agent | Owns | Live integrations |
|---|---|---|
| `SPOTTER` | The show: game state, clock, weather delay, rundown overrun → projected final | ESPN scores, Weather.gov, Gemini end-time prediction |
| `TRAFFIC` | The network: flight status, ground stops, airport ops, last-shuttle timing | AviationStack API, curated 28-airport route network |
| `ADVANCE` | The roster and the next call — and *how we know* (crew sheet, crew-confirmed, or inferred) | Firestore crew/assignment store |
| `WRANGLER` | Brokering constraints with crew without requiring them to disclose the commitment | Twilio SMS, Gemini NL constraint parsing |
| `STEWARD` | The rule set: turnaround, rest, meal penalty, travel-time treatment | Gemini agreement interpretation |
| `FIXER` | Alternatives: inventory, fare rules, policy compliance, seat holds | Gemini option generation and ranking |
| `RUNNER` | Carrying the decided plan to a human desk for execution | TMC handoff protocol |
| `CUSTOMS` | Carnets, work permits, border clearance — *off for domestic shows* | — |

Each agent emits structured events to the message bus. Every event records the
agent, the type, the show, a timestamp, and a provenance envelope — forming a
complete epistemic trail that Grafana Loki indexes and the closeout report
queries.

---

## Agent separation — the security model

The crew is split for a security reason, not an org-chart reason. An agent that
reads live external feeds is an agent that can be fed something hostile. An agent
that can book travel is an agent that can spend money. **Apron never makes
them the same agent.**

### The three invariants

1. **The agents that read the outside world cannot act on it.**
   `SPOTTER` and `TRAFFIC` ingest untrusted third-party data — scoreboard feeds,
   weather services, carrier status APIs. Zero write authority, zero access to
   personal data. Content arriving in those feeds is treated as an observation to
   be evaluated, never as an instruction to be followed.

2. **The agent with booking authority never sees a name.**
   `FIXER` searches inventory and places holds against *tokenized* travelers — a
   loyalty tier, a home market, a rest window, a gear profile. Re-identification
   happens desk-side, behind the human gate.

3. **Nothing irreversible happens without a person.**
   Agents hold; people ticket. Every action that spends money, cancels inventory,
   or reaches a crew member passes a named human with the full option set in
   front of them. The autonomy is in the analysis, not the authority.

### Capability matrix

Enforced by the scoped credential broker in
[`packages/credentials/`](packages/credentials), not by prompt instruction.

| Agent | Reads | Authority | Never receives |
|---|---|---|---|
| `SPOTTER` | Game feeds, clock, weather, rundown | read-only | Crew identity · PNRs · personal data |
| `TRAFFIC` | Carrier status, ground ops | read-only | Crew identity · next calls · fare data |
| `ADVANCE` | Crew sheets, call sheets, provenance | roster state | Payment instruments · fare detail · HR records |
| `STEWARD` | Rule packs, wrap/call timestamps | rule flags | Contact info · payment · personnel files |
| `WRANGLER` | Constraints crew choose to disclose | constraints | Undisclosed next-call detail · third-party call sheets |
| `FIXER` | Inventory, fare rules, policy, tokenized traveler | **hold only** | Names · contact details · payment instruments |
| `RUNNER` | The approved decision record | handoff | *No outbound channel to crew, ever* |
| `CUSTOMS` | Carnet requirements, permits, border rules | doc flags | Fare data · payment · financial records |

Full write-up: [`docs/agent-separation.md`](docs/agent-separation.md).

---

## Provenance and disclosure

Every fact on the board records **which agent produced it, which source it came
from, how confident it is, and who is allowed to see it.** Two consequences:

- **Inferred ≠ confirmed.** Apron can infer a likely next call from return
  routing. It marks that inference in plain sight and refuses to rebook against
  it until a human or the crew member confirms. Guesses don't spend money.
- **Whoever owns the fact decides who sees it.** If a crew member's next call is
  on another network's show, the production seat sees `External call · withheld`
  — never the network, the show, or the client. The system still solves for it,
  because `WRANGLER` can broker the *constraint* ("must be at MCI by Mon 13:00
  CT") without the commitment behind it.

Envelope schema: [`docs/provenance.md`](docs/provenance.md).

### What this repository deliberately does not collect

No crew location tracking. No message or SMS interception. No rate or day-rate
data. No performance or reliability scoring of individual crew. This protects
call times; it is not a surveillance layer on freelancers.

---

## Partner & Google Cloud usage

All three are imported and called at runtime, not just named here.

| | Where | What it does |
|---|---|---|
| **Google Cloud** — Gemini&nbsp;2.5&nbsp;Flash | [`integrations/google-cloud/`](integrations/google-cloud) | Reasoning for every agent: end-time prediction in `SPOTTER`, agreement interpretation in `STEWARD`, natural-language constraint parsing in `WRANGLER`, option generation and ranking in `FIXER`. Stubs responses in fixture mode so the demo runs without credentials. |
| **Grafana** | [`integrations/grafana/`](integrations/grafana) | Three telemetry pipelines: **Prometheus** metrics (agent events, crew risk, call exposure, show state, LLM latency), **Loki** structured logs (the epistemic trail — how every operational fact evolved), and **Agent Observability** SDK (per-generation token usage, latency, input/output tracing via `@grafana/agento11y`). Plus a game **closeout report** that queries Loki to build a chronological operational narrative. Importable dashboard JSON in [`dashboards/`](integrations/grafana/dashboards). |
| **Clickhouse** | [`integrations/clickhouse/`](integrations/clickhouse) | Append-only audit log. Every agent event is written to an `audit_log` table with MergeTree engine and 90-day TTL. Schema auto-creates on startup. |

Entry points:

- [`packages/server/src/server.ts`](packages/server/src/server.ts) — where agents are registered and integrations are bound
- [`packages/orchestrator/src/runtime.ts`](packages/orchestrator/src/runtime.ts) — agent runtime, credential broker, dispatch with latency tracking
- [`integrations/grafana/src/reporter.ts`](integrations/grafana/src/reporter.ts) — Prometheus remote write (Influx line protocol)
- [`integrations/grafana/src/loki.ts`](integrations/grafana/src/loki.ts) — structured log push to Loki
- [`integrations/grafana/src/agento11y.ts`](integrations/grafana/src/agento11y.ts) — `@grafana/agento11y` SDK initialization
- [`integrations/grafana/src/closeout.ts`](integrations/grafana/src/closeout.ts) — game closeout report builder
- [`integrations/clickhouse/src/store.ts`](integrations/clickhouse/src/store.ts) — audit log buffer, flush, and query

---

## Observability — the Grafana pipeline

Apron treats observability as a first-class product concern, not a debug
afterthought. Three pipelines run in parallel:

### 1. Prometheus metrics

Every agent event pushes an `apron_agent_event` sample via Influx line protocol
to Grafana Cloud's remote-write endpoint. Additional metrics track crew risk in
real time:

| Metric | Type | What it measures |
|---|---|---|
| `apron_agent_event` | gauge | One sample per agent action, tagged by agent + event type |
| `apron_crew_at_risk` | gauge | Current count of crew members at risk per show |
| `apron_call_times_exposed` | gauge | Crew whose next call is breached |
| `apron_show_state_change` | gauge | State transitions: clear → watch → risk → down |
| `apron_agent_process_duration_ms` | gauge | LLM processing latency per agent dispatch |

### 2. Loki structured logs

Every agent event is logged with structured labels (`agent`, `event_type`,
`game_id`, `show_id`), JSON-parsed at query time. This forms the **epistemic
history** — not a debug log but a queryable record of how operational facts
evolved: when the projected final shifted, when a constraint was confirmed, when
a provenance level was upgraded.

The closeout report (`GET /api/closeout/:gameId`) queries this trail to build a
chronological narrative: timeline, decisions, compliance summary, flight
disruptions, and an operational grade.

### 3. Agent O11y (LLM generation tracing)

The `@grafana/agento11y` SDK (v0.13.0) instruments every Gemini generation with:
normalized prompt and completion text, token usage (input/output/total), latency,
model version, and per-agent tagging. Telemetry flows to the Grafana Cloud
Agent Observability endpoint.

### Dashboard

An importable dashboard ships at
[`integrations/grafana/dashboards/apron-ops-overview.json`](integrations/grafana/dashboards/apron-ops-overview.json):
show status row (crew-at-risk, call-times-exposed, state changes), agent
activity (events/min time series, events-by-type bar gauge), Gemini LLM
performance (latency time series, P95 per agent), and a Loki log panel.

---

## What's here, and what isn't

This repository is **complete and runnable**. Nothing is stubbed to hide it. What
is not here is not here for a reason we can state:

| Not included | Why |
|---|---|
| **Production rule packs** (encoded provisions for specific agreements and locals) | Collective bargaining agreements are copyrighted works of their parties. We don't republish them. A clearly-marked **sample pack** ships in `packages/rules/packs/sample-local/` and runs the demo. |
| **Real TMC adapters** | Built against specific mid-office/GDS environments under NDA. A **mock adapter** in `integrations/tmc/mock/` runs the full scenario. |
| **Credentials and service configuration** | Obvious. `.env.example` documents every variable. |
| **Any real crew, itinerary, or PNR data** | Personal data. Fixtures are synthetic. |

The rule **engine** is here. The orchestrator is here. The credential broker is
here. All eight agents are here. The board is here.

---

## Repository layout

```
packages/
  types/              shared TypeScript types and interfaces
  orchestrator/       agent runtime, message bus, scenario playback
  credentials/        scoped credential broker  ← enforces the capability matrix
  provenance/         envelope schema + validators
  agents/
    spotter/  traffic/  customs/      external-world readers, read-only
    advance/  wrangler/  steward/     roster, constraints, rule evaluation
    fixer/    runner/                 options/holds, human handoff
  rules/
    engine/           the interpreter
    packs/sample-local/   illustrative only — see NOTICE
  server/             HTTP + WebSocket server (no Express — native node:http)
  board/              watch board, admin console, agent dashboards
    index.html          TMC desk + production seat
    admin.html          account/game/crew/assignment management
    traffic.html        TRAFFIC flight status monitor
    wrangler.html       WRANGLER constraint gathering
    spotter.html        SPOTTER game prediction
    steward.html        STEWARD compliance view
fixtures/
  alcs-gm4/           twelve-inning night (16 steps, 14 crew, 6 shows)
  tape/               demo tape variant (16 steps, 22 crew, full seat-switch)
integrations/
  google-cloud/       Gemini via Vertex AI (stubs in fixture mode)
  grafana/            Prometheus + Loki + Agent O11y + closeout report
    dashboards/         importable Grafana dashboard JSON
  clickhouse/         append-only audit log with MergeTree schema
  firebase/           Firestore persistence (accounts, crew, games, assignments)
  aviationstack/      AviationStack flight status API (TRAFFIC agent)
  twilio/             Twilio SMS (WRANGLER crew outreach)
  tmc/mock/           runs the demo without a live TMC
site/                 marketing site (static HTML)
docs/
  architecture.md     system architecture + diagram
  agent-separation.md security model deep-dive
  provenance.md       envelope schema + disclosure rules
  runtime.md          env vars, IAM roles, deployment
```

---

## Contributing

Contributions are welcome. Because Apron is dual-licensed, **all
contributors must sign the CLA before a pull request can be merged** — see
[CONTRIBUTING.md](CONTRIBUTING.md). Without it we lose the ability to offer the
commercial terms in [COMMERCIAL.md](COMMERCIAL.md).

---

## License

[GNU AGPL-3.0](LICENSE). If you run a modified version as a network service, you
must make your modified source available to that service's users.

A commercial license is available if those terms don't fit — see
[COMMERCIAL.md](COMMERCIAL.md).

Trademarks are reserved and are **not** granted by the AGPL. Forks must be
renamed; see [NOTICE](NOTICE).

---

*The sample rule pack is illustrative and must not be relied on to determine any
real obligation under any collective bargaining agreement or employment
contract.*
