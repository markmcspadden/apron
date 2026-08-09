# Deployments

Service URL: https://apron-203460075246.us-central1.run.app
Custom domains: `apron.show` ✅, `www.apron.show` (CNAME needs update to `ghs.googlehosted.com`)
GCP Project: `apron-dev-504523`
Region: `us-central1`
Service: `apron`

## Custom Domains

| Domain | Type | DNS Records | Status |
|--------|------|-------------|--------|
| `apron.show` | apex | A → `216.239.32.21`, `216.239.34.21`, `216.239.36.21`, `216.239.38.21` | pending cert |
| `apron.show` | apex | AAAA → `2001:4860:4802:32::15`, `2001:4860:4802:34::15`, `2001:4860:4802:36::15`, `2001:4860:4802:38::15` | pending cert |
| `www.apron.show` | subdomain | CNAME → `ghs.googlehosted.com` | pending cert |

Registrar: GoDaddy. SSL certs auto-provisioned by Google once DNS propagates.

Reserved: `apron.co` (not yet mapped)

## Revision History

### apron-00002-qdt — 2026-08-06

**Entry point:** `index.ts` (full server — Firestore + /demo fixture route)

**Env vars:**
- `GOOGLE_CLOUD_PROJECT=apron-dev-504523`
- `FIREBASE_PROJECT_ID=apron-dev-504523`
- `NODE_ENV=production`

**Changes:**
- Switched Dockerfile from `demo.ts` → `index.ts` (full server with Firestore)
- Fixed three Firestore persistence bugs (admin-store.ts):
  - `AdminStore` now gets Firestore db via `FirestoreStore.getDb()` (pnpm hoisting fix)
  - `serverTimestamp()` returns ISO strings instead of broken `firebase-admin` import
  - `createGame` writes all timing fields to Firestore
- Added `FirestoreStore.waitReady()` to fix `isEnabled()` race condition
- Added `/demo` route for fixture board auto-play (per-connection via `?demo=1` WebSocket param)
- Added admin console game edit form with full timing model
- Added `DELETE /api/admin/accounts/:id/games/:gameId` endpoint
- Updated Firestore security rules to match `accounts` collection schema
- Deployed Firestore rules via `firebase deploy --only firestore:rules`

**Routes:**
| Path | Description |
|------|-------------|
| `/` | Marketing site |
| `/board` | Live board (Firestore-backed) |
| `/admin` | Admin console (CRUD accounts, games, crew, assignments) |
| `/demo` | Fixture demo (auto-plays ALCS Gm 4, no Firestore) |
| `/api/status` | Health check |

---

### apron-00001-547 — 2026-08-04

**Entry point:** `demo.ts` (fixture-only, no Firestore)

**Changes:**
- Initial deployment
- Fixture demo auto-play only
- No Firestore connectivity
- No admin console
