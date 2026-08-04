# Provenance and disclosure

Every fact on the board records four things:

1. **Which agent produced it**
2. **Which source it came from**
3. **How confident it is** — confirmed, reported, or inferred
4. **Who is allowed to see it**

That fourth field is the unusual one, and it is the reason this system can serve
a production coordinator and a TMC desk from the same incident record without
leaking anything.

---

## Confidence: inferred is never executed on

Apron can infer a likely next call from return routing — if someone books CLE→MCI
on a Monday morning and Kansas City has a Monday night game, that is a signal.

**It is not a fact.** The board marks the inference in plain sight and refuses to
rebook against it until a human or the crew member confirms.

> Guesses don't get to spend money.

An inferred next call renders visibly differently from a crew-confirmed one. This
is not a UI nicety — the execution path checks the provenance field, and an
inferred constraint cannot authorize a hold.

---

## Disclosure: whoever owns the fact decides who sees it

Freelance crew work for a lot of people. The camera operator in your compound
tonight may be on a competitor's show Monday. That is their business and their
next employer's — not yours, and not ours.

So disclosure rights travel **with the fact**, not with the viewer's role:

| Fact | Owner | Production seat sees | TMC desk sees |
|---|---|---|---|
| Next call on your own show | You | Full detail | Full detail |
| Next call on another network's show | The crew member and that network | `External call · withheld` | Full detail (they booked it) |
| A constraint the crew member brokered | The crew member | The constraint only — *"must be at MCI by Mon 13:00 CT"* | The constraint only |
| A constraint they chose to attribute | The crew member | *"MNF · Kansas City"* — because they said so | Same |
| An inferred next call | Nobody — it is a guess | Marked inferred, not actionable | Marked inferred, not actionable |

`WRANGLER` exists to move facts up this table: it turns an unconfirmed inference
into a **confirmed constraint** without requiring the crew member to disclose who
they are working for. That is enough to route them correctly and enough to protect
their next gig.

**Redaction is enforced at the data layer, not the display layer.** A withheld
fact is withheld in the API response, in the alert, and in the audit export — not
hidden with CSS. That is what makes it survive every channel, including SMS.

---

## The envelope

Every fact carries:

```
{
  value:      <the fact>,
  agent:      "ADVANCE",              // who produced it
  source:     "network-crew-sheet",   // where it came from
  confidence: "confirmed",            // confirmed | reported | inferred
  owner:      "crew:4417",            // who the fact belongs to
  disclosure: ["tmc-desk"],           // who may see it
  observed:   "2026-10-18T22:38:00Z"
}
```

Schema and validators: [`packages/provenance/`](../packages/provenance).

---

## What Apron deliberately does not collect

- No crew location tracking
- No message or SMS interception
- No rate or day-rate data
- No performance or reliability scoring of individual crew
- No persistent profile following a freelancer between networks

Crew are **not users.** There is no app for them to install and no account for
them to make. A crew member exists in the system for the window of the show they
are working and the trip home, and then the monitoring data expires with the trip.

The tool protects call times. It is not a surveillance layer on freelancers.
