# Known Bugs

## Open

_(none)_

---

## Resolved

### BUG-001: Auto-scheduler starts watches ~1 hour late

**Severity:** Medium — games are already mid-game when SPOTTER starts  
**Observed:** 2026-08-10, PHI @ STL (ESPN 401816472)  
**Expected:** Watch starts at ~19:30 ET (15m before 19:45 first pitch)  
**Actual:** Watch started at 20:05 ET — game was in the 5th inning  

**Root causes (two issues):**

1. **Timezone-dependent time comparison.** The scheduler used `setHours()` and a `todayStr` date check, both of which depend on the server's `TZ` env var. On Cloud Run (default UTC), the `todayStr` check (`game.date !== todayStr`) fails after midnight UTC (8 PM ET) — evening games disappear from the scan. The `setHours()` call also produces wrong times if TZ isn't set correctly.

2. **Cloud Run scale-to-zero.** With `--min-instances` defaulting to 0, idle instances get killed. The in-memory scheduler stops running. Games only get picked up on the next cold start (triggered by incoming traffic), which can be arbitrarily late.

**Fix:**
- Replaced `todayStr` + `setHours()` with `gameTimeToUtcMs()` — uses `Intl.DateTimeFormat` with explicit `timeZone: 'America/New_York'` to convert game times to UTC. Works regardless of server TZ, handles EDT/EST automatically.
- Removed the `game.date === todayStr` gate; instead compares full UTC timestamps with a 6-hour past cutoff.
- Also fixed `scheduledStart` in `startWatch()` to use `gameTimeToUtcMs()` instead of `new Date(\`date T time\`)` (which parsed as local time).
- Set `--min-instances 1` in `deploy.sh` to keep one instance warm.

**Files:** `packages/server/src/server.ts`, `deploy.sh`  
**Fixed:** 2026-08-10
