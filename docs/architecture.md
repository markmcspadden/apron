# Architecture

> **Status: outline.** The structure below is decided; the implementation is not
> written yet. This file should be filled in as packages land.

## Shape

```
        ┌─ SPOTTER ─┐  ┌─ TRAFFIC ─┐  ┌─ CUSTOMS ─┐    read-only, untrusted input
        └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
              └──────────────┼──────────────┘
                             ▼
                     ┌───────────────┐
                     │  ORCHESTRATOR │   message bus + scheduler
                     └───────┬───────┘
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌─ ADVANCE ─┐  ┌─ STEWARD ─┐  ┌─ WRANGLER ─┐   state + rules + constraints
        └─────┬─────┘  └─────┬─────┘  └─────┬──────┘
              └──────────────┼──────────────┘
                             ▼
                       ┌─ FIXER ─┐    options + HOLDS ONLY (tokenized travelers)
                       └────┬────┘
                            ▼
                     ═══ HUMAN GATE ═══
                            ▼
                       ┌─ RUNNER ─┐   handoff packet to a named desk agent
                       └──────────┘
```

Every edge carries a provenance envelope ([`provenance.md`](provenance.md)).
Every agent holds a scoped credential issued by `packages/credentials`
([`agent-separation.md`](agent-separation.md)).

## Packages

| Package | Responsibility | Notes |
|---|---|---|
| `orchestrator` | Agent runtime, message bus, scheduler, run loop | Binds the Google Cloud client |
| `credentials` | Scoped credential broker | **Enforces the capability matrix.** Highest-scrutiny package |
| `provenance` | Envelope schema + validators | Confidence and disclosure fields |
| `agents/*` | One package per agent | Each declares its capability set |
| `rules/engine` | Turnaround / rest / travel-time interpreter | Packs are data, not code |
| `board` | The two-seat watch display | TMC desk + production seat |

## Open decisions

- [ ] Language and runtime (README assumes pnpm/Node — confirm)
- [ ] Message bus: in-process vs. durable queue
- [ ] Partner track integration point (IBM | Grafana | Parallel | Clickhouse | Replit)
- [ ] Persistence for the audit log — append-only requirement
- [ ] How the human gate is presented to the desk (UI vs. existing exception queue)
