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
> Partner track: **`<PARTNER>`** — *see [Partner &amp; Google Cloud usage](#partner--google-cloud-usage).*

---

## Contents

- [The problem](#the-problem)
- [Quick start](#quick-start)
- [The agent crew](#the-agent-crew)
- [Agent separation — the security model](#agent-separation--the-security-model)
- [Provenance and disclosure](#provenance-and-disclosure)
- [Partner & Google Cloud usage](#partner--google-cloud-usage)
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
git clone https://github.com/<org>/apron.git
cd apron
pnpm install                # TODO: confirm package manager
cp .env.example .env        # fixture mode needs no real keys
pnpm demo                   # replays the ALCS Gm 4 twelve-inning night
```

Then open <http://localhost:3000> for the watch board. Use the seat switch in
the header to move between the **TMC desk** and the **production seat** and watch
the same incident change shape depending on who is allowed to see what.

### Running against live services

```bash
cp .env.example .env.local  # add GOOGLE_APPLICATION_CREDENTIALS + partner keys
pnpm dev --live
```

See [`docs/runtime.md`](docs/runtime.md) for the full variable list and the
minimum IAM roles.

> **Fixture mode is the supported demo path.** Live mode requires credentials we
> cannot distribute; see [What's here, and what isn't](#whats-here-and-what-isnt).

---

## The agent crew

Not one model with a large prompt. Eight specialists, each owning one domain,
holding one credential, reading only what its job requires. **Crew is provisioned
per show** — a domestic regular-season game doesn't call `CUSTOMS` to work.

| Agent | Owns |
|---|---|
| `ADVANCE` | The roster and the next call — and *how we know* (crew sheet, crew-confirmed, or inferred) |
| `WRANGLER` | Brokering constraints with crew without requiring them to disclose the commitment |
| `SPOTTER` | The show: game state, clock, weather delay, rundown overrun → projected final |
| `TRAFFIC` | The network: flight status, ground stops, airport ops, last-shuttle timing |
| `STEWARD` | The rule set: turnaround, rest, meal penalty, travel-time treatment |
| `FIXER` | Alternatives: inventory, fare rules, policy compliance, seat holds |
| `RUNNER` | Carrying the decided plan to a human desk for execution |
| `CUSTOMS` | Carnets, work permits, border clearance — *off for domestic shows* |

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

Both are imported and called at runtime, not just named here.

| | Where | What it does |
|---|---|---|
| **Google Cloud** — Gemini via Agent Builder | [`integrations/google-cloud/`](integrations/google-cloud) | Reasoning for every agent; option generation and ranking in `FIXER`; rule interpretation in `STEWARD` |
| **`<PARTNER>`** | [`integrations/<partner>/`](integrations) | *TODO: one line on the exact call path* |

Entry points:

- `packages/orchestrator/src/runtime.ts` — where agents are constructed and the
  Google Cloud client is bound
- `integrations/<partner>/src/client.ts` — the partner client
- Trace any demo run with `pnpm demo --trace` to see both called live

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
  orchestrator/       agent runtime, message bus, scheduler
  credentials/        scoped credential broker  ← enforces the capability matrix
  provenance/         envelope schema + validators
  agents/
    spotter/  traffic/  customs/      external-world readers, read-only
    advance/  wrangler/  steward/     roster, constraints, rule evaluation
    fixer/    runner/                 options/holds, human handoff
  rules/
    engine/           the interpreter
    packs/sample-local/   illustrative only — see NOTICE
  board/              the watch board UI (TMC desk + production seat)
fixtures/
  alcs-gm4/           synthetic twelve-inning night
integrations/
  google-cloud/       required, real
  <partner>/          required, real
  tmc/mock/           runs the demo without a live TMC
docs/
  architecture.md  agent-separation.md  provenance.md  runtime.md
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
