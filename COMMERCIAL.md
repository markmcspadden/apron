# Commercial licensing

Apron is dual-licensed.

| | Open source | Commercial |
|---|---|---|
| **License** | [AGPL-3.0](LICENSE) | Negotiated |
| **Cost** | Free | Contact us |
| **Must publish your modifications** | **Yes** — including when you run it as a hosted or network service | No |
| **Can embed in a closed-source product** | No | Yes |
| **Can offer as a proprietary hosted service** | No | Yes |
| **Trademark rights** | None ([NOTICE](NOTICE)) | Negotiated |
| **Support / SLA** | None | Available |
| **Production rule packs** | Not included | Available under separate terms |

---

## Which one applies to you

**The AGPL is fine for you if** you're evaluating Apron, running it
internally without modification, contributing to it, or building something you're
happy to release under the AGPL yourself.

**You likely want a commercial license if** you are a travel management company,
a broadcaster, or a platform vendor that intends to:

- run a modified version of Apron as a service for your clients, without
  publishing your modifications;
- embed the orchestrator, credential broker, or rule engine in a proprietary
  product;
- ship it under your own brand;
- operate under a corporate policy that prohibits AGPL-licensed dependencies.

That last one is common and is not a problem. It's a conversation, not a
rejection.

---

## What a commercial license covers

- A non-AGPL grant to the Apron core: orchestrator, scoped credential broker,
  provenance layer, rule engine, agent implementations, and the watch board.
- Optionally, a license to production **rule packs** — the encoded turnaround,
  rest, and travel-time provisions for specific agreements and locals. These are
  not in this repository and are not covered by the AGPL grant.
- Optionally, TMC integration adapters built against a specific mid-office, GDS,
  or NDC environment.
- Trademark permission, if you want to keep the name.

---

## Contact

Open an issue titled `commercial license` on this repository, or reach the
maintainer directly.

Please include: your organization, roughly what you want to build, and whether
you need rule packs. That's enough to scope it.

---

## Why dual-license at all

The AGPL exists here to answer one specific scenario: a large incumbent takes
this codebase, hosts a modified version for their clients, and contributes
nothing back. The AGPL makes that a choice with a cost attached rather than a
free option.

It is not intended to make Apron hard to use. If the license is the only
thing standing between you and using this, that's what the commercial track is
for.
