# Contributing to Apron

Thanks for wanting to help. A few things to know before you open a PR.

---

## The CLA is not optional

Apron is dual-licensed: [AGPL-3.0](LICENSE) for everyone, and a commercial
license for organizations that can't work under the AGPL
([COMMERCIAL.md](COMMERCIAL.md)).

**Offering a commercial license requires that the project owns or controls the
copyright in all of the code.** If we merge a contribution we don't have rights
to relicense, we can no longer offer commercial terms for any file it touches —
and that's effectively irreversible without tracking down every contributor.

So: **every contributor signs the CLA in [`CLA.md`](CLA.md) before their first
merge.** It's short. It does not take your copyright away — you keep ownership
and can do whatever you like with your own work. It grants the project the right
to relicense your contribution.

Comment `I have read the CLA and I sign it` on your first pull request.

---

## Before you write code

**Open an issue first for anything non-trivial.** Especially for changes to:

- `packages/credentials/` — the scoped credential broker
- `packages/provenance/` — the disclosure envelope
- any agent's declared capability set

Those three enforce the security invariants in the README. Changes there get
scrutiny that a UI tweak doesn't.

---

## The invariants

A PR that breaks any of these will be closed, however good the rest of it is.
They are the product.

1. **`SPOTTER`, `TRAFFIC`, and `CUSTOMS` never gain write authority or access to
   personal data.** They read untrusted external feeds. Keeping them inert is
   what makes hostile content in those feeds a non-event.
2. **`FIXER` never receives a name, a contact detail, or a payment instrument.**
   It works against tokenized travelers. Re-identification is desk-side only.
3. **No agent completes an irreversible action.** Agents hold. Humans ticket,
   cancel, and message. If your change lets an agent do any of those without a
   human gate, it's the wrong change.
4. **No agent messages crew directly.** `RUNNER` hands off to a human desk. There
   is no outbound crew channel in this codebase and there should not be one.
5. **Inferred facts are never executed on.** If provenance says inferred, the
   system asks. It does not act.
6. **Untrusted feed content is data, never instruction.** Anything arriving from
   an external source is an observation to be evaluated. If your change makes a
   feed able to steer agent behavior, that's a vulnerability, not a feature.

There are tests for these. Run `pnpm test:invariants` before pushing.

---

## What we especially want

- **Rule engine coverage** — the engine, not the packs. More expressive
  turnaround/rest/travel-time primitives.
- **Carrier and ground-ops adapters** for `TRAFFIC`.
- **Accessibility on the board.** It's an operational display used at 2 AM by
  tired people. That matters more than it usually does.
- **Adversarial tests** against invariants 1 and 6. If you can get a scoreboard
  feed to influence a booking decision, that's a very welcome issue.

## What we won't take

- **Production rule packs encoding real agreements.** Those are copyrighted works
  of their parties. Don't put them in a PR. See [NOTICE](NOTICE).
- **Real crew, itinerary, or PNR data** in fixtures. Synthetic only. Ever.
- **Crew tracking, rate data, or reliability scoring of individuals.** Out of
  scope by design — see the README.
- **A direct-to-crew messaging channel.** See invariant 4.

---

## Mechanics

- Branch from `main`, one logical change per PR.
- `pnpm test` and `pnpm lint` pass.
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`).
- New source files carry the AGPL header — `pnpm license:headers` adds it.
- If you change behavior described in the README or `docs/`, update it in the
  same PR.

---

## Security

Do not open a public issue for a vulnerability — especially anything touching
the capability matrix or the credential broker. See
[SECURITY.md](SECURITY.md) for private disclosure.
