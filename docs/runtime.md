# Runtime

> **Status: template.** Fill in once the stack is chosen.

## Fixture mode — the supported demo path

Runs fully offline. No credentials, no network, no TMC.

```bash
pnpm install
cp .env.example .env
pnpm demo          # replays fixtures/alcs-gm4
```

Board at <http://localhost:3000>. Seat switch in the header toggles TMC desk /
production seat.

## Live mode

```bash
cp .env.example .env.local
pnpm dev --live
```

## Environment variables

See [`.env.example`](../.env.example) for the annotated list. Fixture mode needs
none of them.

## Google Cloud — minimum IAM

> TODO: pin exact roles once Agent Builder wiring lands.

- `roles/aiplatform.user`
- `roles/serviceusage.serviceUsageConsumer`

## Partner service

> TODO: fill in once the track is chosen. The hackathon requires the partner
> service be **imported and called in code**, not just named in the README.

## What is NOT in this repo

Production rule packs, real TMC adapters, and any credentials — see
[`NOTICE`](../NOTICE) and the README's *What's here, and what isn't*.
