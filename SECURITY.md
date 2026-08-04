# Security policy

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting
(Security → Report a vulnerability) on this repository, or email the maintainer
directly.

Please include what you did, what happened, and what you expected. A proof of
concept against the fixture demo is ideal — you should never need real
credentials or real data to demonstrate a finding here.

We'll acknowledge within 3 business days and give you an assessment and a
timeline. We'll credit you in the advisory unless you'd rather we didn't.

---

## What we consider a vulnerability

Apron's security model is **agent separation**: the capability matrix in the
README is enforced by the scoped credential broker, not by prompt instruction.
Anything that erodes that is in scope, including:

### High interest

- **Feed-to-action influence.** Getting content from an external feed —
  scoreboard, weather, carrier status — to change an agent's behavior rather than
  merely inform it. `SPOTTER`, `TRAFFIC`, and `CUSTOMS` read untrusted data and
  must remain inert. Prompt injection through those surfaces is the single
  highest-value finding in this codebase.
- **Capability escalation.** Any path where an agent obtains data or authority
  outside its declared row in the capability matrix.
- **Re-identification of a tokenized traveler by `FIXER`.** `FIXER` holds booking
  authority and must never receive names, contact details, or payment
  instruments. Deriving identity from the token, the constraint set, or timing
  correlation is a finding.
- **Bypassing the human gate.** Any path where an agent completes an irreversible
  action — ticketing, cancelling, or reaching a crew member — without human
  approval.
- **Disclosure leakage.** Any path where the production seat can recover a
  withheld external call: through the options list, the chain timings, error
  messages, the audit export, or inference from what *isn't* shown.
- **Acting on inferred provenance.** Any path where a fact marked inferred is
  executed on without confirmation.
- **Cross-tenant leakage** between clients on a shared deployment.

### Also in scope

Credential handling, audit log tampering or omission, dependency
vulnerabilities with a demonstrated path, and denial of service against the
orchestrator.

### Out of scope

- The **sample rule pack** producing an incorrect labor determination. It is
  illustrative and explicitly not authoritative — see [NOTICE](NOTICE).
- Findings that require credentials or infrastructure access you were given
  legitimately.
- Vulnerabilities in third-party services (Google Cloud, carriers, TMC systems)
  — report those to the vendor.
- Social engineering, physical access, and volumetric DoS against hosted demos.

---

## Safe harbor

We will not pursue or support legal action against research conducted in good
faith under this policy: testing against your own deployment or the fixture demo,
avoiding privacy violations and service degradation, and giving us reasonable
time to remediate before public disclosure.

Do not test against a production deployment carrying real crew data. There is no
finding here worth exposing a real person's itinerary to get.

---

## Supported versions

Pre-1.0. Only `main` is supported. Fixes land there.
