# Apron

Crew integrity for live sports and entertainment production. Irregular operations desk that watches shows, itineraries, and constraints in real time and keeps every next call intact.

## Quick start

```bash
pnpm install
pnpm demo        # starts server on :3000, auto-plays ALCS Gm 4 scenario
```

- Board: http://localhost:3000/board
- Marketing site: http://localhost:3000/
- API: http://localhost:3000/api/status

## Project structure

pnpm monorepo, TypeScript with ESM (`"type": "module"`, NodeNext resolution). All source is in `src/` subdirs; no build step needed for dev (tsx runs TypeScript directly).

```
packages/types/          - Shared types: domain, models, events, fixtures, credentials, provenance
packages/orchestrator/   - Message bus, agent runtime, orchestrator (scenario playback)
packages/credentials/    - Capability matrix and credential broker
packages/provenance/     - Provenance envelopes and visibility rules
packages/rules/engine/   - Turnaround/rest rule checking (NABET-CWA Art. 8.3)
packages/agents/*/       - 8 agents: SPOTTER, TRAFFIC, ADVANCE, WRANGLER, STEWARD, FIXER, RUNNER, CUSTOMS
packages/server/         - Express-free HTTP + WebSocket server, audit log
packages/board/          - Board UI (single HTML file, vanilla JS, WebSocket client)
integrations/grafana/    - Prometheus-format metrics push
integrations/clickhouse/ - Append-only audit log (optional, needs CLICKHOUSE_URL)
integrations/google-cloud/ - Gemini client (stubs in fixture mode)
fixtures/alcs-gm4/       - ALCS Game 4 twelve-inning night scenario
site/                    - Marketing site (static HTML)
```

## Key commands

```bash
pnpm demo          # run fixture demo (auto-play)
pnpm dev           # run server with file watching
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
- **Fixture mode**: synthetic data, no external dependencies needed

## Hackathon

Agentic Cinema: The Blockbuster Hackathon (deadline Sep 7, 2026). Partner tracks: Grafana + Clickhouse. GCP/Gemini stubbed for fixture mode.
