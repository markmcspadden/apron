# Apron

Crew integrity for live sports and entertainment production. Irregular operations desk that watches shows, itineraries, and constraints in real time and keeps every next call intact.

## Quick start

```bash
pnpm install
pnpm dev           # full server on :3000 — Firestore-backed, + /demo fixture route
pnpm demo          # standalone fixture demo (no Firebase needed)
pnpm tape          # demo tape — 22-crew ALCS scenario for the 3-minute video
```

### Dev mode (`pnpm dev`)

One server with everything:

- **Board:** http://localhost:3000/board — live board backed by Firestore
- **Admin:** http://localhost:3000/admin — admin console (CRUD accounts, games, crew, assignments)
- **Demo:** http://localhost:3000/demo — fixture board, auto-plays ALCS Gm 4 scenario (no Firestore)
- **Marketing:** http://localhost:3000/
- **API:** http://localhost:3000/api/status

Requires `.env` with `GOOGLE_CLOUD_PROJECT` and `FIREBASE_PROJECT_ID` (both `apron-dev-504523`).
Local auth: `gcloud auth application-default login` (ADC).

### Demo mode (`pnpm demo`)

Standalone fixture playback. No Firebase, no admin console, no real data.
The board auto-plays the ALCS Gm 4 twelve-inning night scenario when a client connects.

### Tape mode (`pnpm tape`)

Demo video fixture — same ALCS Gm 4 game, but starts at Bot 10th with all 22 traveling crew in the roster. Designed for the 3-minute demo tape: cold open → Act 1 WATCH → Act 2 DECIDE → seat switch → CLEAR. All 4 external calls remain NOT BROKERABLE so the production seat shows 4 "External call · withheld" rows.

The `SCENARIO` env var selects which fixture directory to load (default: `alcs-gm4`).

### Seed data

`POST /api/admin/seed` bootstraps a demo account (CTM Entertainment) with entities, members, crew, and the ALCS Gm 4 game. Idempotent — skips if any accounts already exist.

## Project structure

pnpm monorepo, TypeScript with ESM (`"type": "module"`, NodeNext resolution). All source is in `src/` subdirs; no build step needed for dev (tsx runs TypeScript directly).

```
packages/types/            - Shared types: domain, models, events, fixtures, credentials, provenance
packages/orchestrator/     - Message bus, agent runtime, orchestrator (scenario playback)
packages/credentials/      - Capability matrix and credential broker
packages/provenance/       - Provenance envelopes and visibility rules
packages/rules/engine/     - Turnaround/rest rule checking (NABET-CWA Art. 8.3)
packages/agents/*/         - 8 agents: SPOTTER, TRAFFIC, ADVANCE, WRANGLER, STEWARD, FIXER, RUNNER, CUSTOMS
packages/server/           - Express-free HTTP + WebSocket server, admin API, audit log
  src/admin-store.ts       - Firestore-backed data store (falls back to in-memory)
  src/admin-api.ts         - REST API for accounts, games, crew, assignments
  src/server.ts            - HTTP + WebSocket server with /demo route
  src/index.ts             - Dev entry point (full server)
  src/demo.ts              - Demo entry point (fixture-only, demoMode: true)
packages/board/            - Board UI + admin console + agent dashboards (vanilla JS, WebSocket client)
  index.html               - Board view (TMC desk + production seat)
  admin.html               - Admin console (manage accounts/games/crew/assignments)
  traffic.html             - TRAFFIC dashboard (flight status monitor)
  wrangler.html            - WRANGLER dashboard (constraint gathering)
integrations/firebase/     - FirestoreStore wrapper (firebase-admin lives here for pnpm hoisting)
integrations/grafana/      - Grafana Cloud: Prometheus metrics, Loki logs, Agent O11y, Closeout
integrations/clickhouse/   - Append-only audit log (optional, needs CLICKHOUSE_URL)
integrations/google-cloud/ - Gemini client (stubs in fixture mode)
integrations/aviationstack/- AviationStack flight status API client (TRAFFIC agent)
integrations/twilio/       - Twilio SMS client for WRANGLER outreach
fixtures/alcs-gm4/         - ALCS Game 4 twelve-inning night scenario (14 crew)
fixtures/tape/             - Demo tape variant: 22 crew, starts Bot 10th, all external calls redacted
site/                      - Marketing site (static HTML)
```

### pnpm strict hoisting

`firebase-admin` is only resolvable from `integrations/firebase/`. The server package accesses Firestore through `FirestoreStore.getDb()` — never imports `firebase-admin` directly. This avoids silent failures from dynamic imports that resolve in dev but fail under pnpm strict mode.

## Key commands

```bash
pnpm dev           # full server with file watching (Firestore + demo)
pnpm demo          # standalone fixture demo (no Firebase)
pnpm typecheck     # tsc --noEmit
pnpm build         # tsc -b (not required for dev)
```

## Architecture

- **8 agents** with separation of concerns: readers can't write, FIXER works on tokenized travelers, nothing irreversible without human approval
- **Credential broker** enforces capability matrix at runtime
- **Provenance envelopes** track source, confidence, and brokerability of every fact
- **Two-seat disclosure model**: TMC desk sees everything; production seat redacts external calls that aren't brokerable
- **In-process EventEmitter bus** for agent communication
- **WebSocket** streams scenario steps to the board UI in real time
- **Firestore** persistence for accounts, entities, members, crew, games, and assignments
- **Fixture mode**: `/demo` route serves the board with auto-playing fixture data, no external dependencies
- **Game timing model**: gameType → defaults (duration, strike), with per-game overrides for the wrap-to-gate chain
- **TRAFFIC flight monitoring**: Crew routing uses curated real flight schedule (28 airports, direct + connecting). AviationStack API integration polls live status when `FLIGHT_STATUS_API_KEY` is set. TRAFFIC is read-only per agent-separation — never receives crew identity, next calls, or fare data. Dashboard at `/traffic`.
- **WRANGLER constraint gathering**: Reaches out to crew with inferred/unknown next calls to gather confirmed constraints — "must be at MCI by Mon 13:00 CT" — without requiring them to disclose who they work for. Gemini integration parses natural-language crew responses into structured constraints. Supports two outreach channels: simulated (Gemini-generated responses for demo/dev) and SMS (Twilio for real crew). Channel auto-detected based on Twilio credentials. Dashboard at `/wrangler`.

## Deployment

- **GCP Project:** `apron-dev-504523`
- **Firestore:** Native mode, `us-central1`
- **Cloud Run:** https://apron-203460075246.us-central1.run.app
- **Local auth:** Application Default Credentials via `gcloud auth application-default login`

## Grafana Cloud Integration

- **Stack:** `modestsalmon3417` on Grafana Cloud
- **Prometheus metrics:** Agent events, crew-at-risk, call-times-exposed, show-state-changes pushed via remote write
- **Loki structured logs:** Every agent event logged with labels (agent, game_id, event_type). Forms the epistemic history trail — tracks how operational facts evolve over time
- **Agent Observability:** `@grafana/agento11y` SDK traces every Gemini generation with normalized input/output, token usage, latency, and per-agent tagging. Telemetry flows to Grafana Cloud Agent Observability endpoint.
- **Closeout report:** `GET /api/closeout/:gameId` — queries Loki for a game's full agent decision trail, builds a chronological operational report with timeline, decisions, compliance summary, flight summary, and an operational grade
- **Env vars:** `GRAFANA_PROM_URL`, `GRAFANA_PROM_USER`, `GRAFANA_PROM_API_KEY`, `GRAFANA_LOKI_URL`, `GRAFANA_LOKI_USER`, `GRAFANA_URL`, `GRAFANA_CLOUD_API_KEY`, `AGENTO11Y_ENDPOINT`, `AGENTO11Y_PROTOCOL`, `AGENTO11Y_AUTH_MODE`, `AGENTO11Y_AUTH_TENANT_ID`, `AGENTO11Y_AUTH_TOKEN` (see `.env.example`)

## Hackathon

Agentic Cinema: The Blockbuster Hackathon (deadline Sep 7, 2026). Partner tracks: Grafana + Clickhouse. GCP/Gemini stubbed for fixture mode.
