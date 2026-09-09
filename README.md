# Casuals Attendance Portal

A subcontractor-facing reporting tool for tracking attendance of casual
workers at UCAA. BioStar 2 remains the source of truth for access control;
this system is a decoupled, read-only layer that syncs attendance events out
of BioStar and exposes them to the subcontractor through their own login —
no BioStar credentials or roles are ever shared with the subcontractor.

## Architecture

```
BioStar 2  --(hourly API sync)-->  MySQL (Prisma)  --(REST API)-->  React portal
```

- `sync/` — logs into BioStar's TA (Time & Attendance) API, provisions
  `CasualWorker` rows from BioStar's Casuals group membership, pulls daily
  punch logs, writes matching records into `AttendanceLog`, and computes
  shift-aware daily attendance summaries into `DailyAttendanceSummary`.
- `routes/` — Express API: login, raw attendance read, shift-aware summary
  read, punch history, manual sync trigger, CSV export.
- `middleware/` — JWT verification for portal accounts.
- `scripts/seedPortalUser.js` — CLI-only account provisioning (no
  self-service signup; there are only 1–2 subcontractor accounts).
- `scripts/seedShifts.js` — one-off seed for the two fixed `Shift` rows.
- `prisma/schema.prisma` — data model (`CasualWorker`, `AttendanceLog`,
  `PortalUser`, `Shift`, `ShiftAssignment`, `DailyAttendanceSummary`).
- `src/` — React frontend (login screen + attendance dashboard + punch
  history modal).

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   # fill in DATABASE_URL, JWT_SECRET, and the BIOSTAR_* values
   ```
   `BIOSTAR_API_USER` should be a dedicated read-only API account, not a
   personal admin login. `BIOSTAR_TA_BASE_URL` points at the TA (Time &
   Attendance) module, which runs on a separate port from the AC API
   (commonly 3002) and under a `/tna` path prefix — confirm this against
   your BioStar instance with `node test/liveBiostarCheck.js`.
   `BIOSTAR_CASUALS_GROUP_NAME` is the exact (case-insensitive) BioStar
   `user_group` name the sync scopes down to — this is what makes
   provisioning "Casuals only" rather than every BioStar user, since the
   punch-log endpoint itself has no group filter.

3. **Run database migrations**
   ```bash
   npx prisma migrate dev --name shift_aware_attendance
   ```

4. **Seed the two shifts**
   ```bash
   npm run seed:shifts
   ```
   Seeds `Shift` rows for Day (08:00–17:00) and Night (17:00–08:00). No
   roster/assignment table needs maintaining — see "Shift-aware attendance"
   below for why.

5. **Provision the subcontractor's portal login**
   ```bash
   node scripts/seedPortalUser.js create ops@subcontractor.com "temp-pass-123"
   ```
   Hand credentials to the subcontractor directly (phone/in-person for the
   first password, not email).

6. **Start the server**
   ```bash
   npm start
   ```
   This starts the Express API on `PORT` (default 4000) and schedules the
   BioStar sync + summary recompute to run hourly, plus once immediately on
   startup. Each run also re-provisions `CasualWorker` from the configured
   BioStar group, so newly added casuals appear automatically — no manual
   step needed to add a worker BioStar already knows about.

7. **Build the frontend**
   Drop the contents of `src/` into your React app, add an IBM Plex
   Sans/Mono font link to your `index.html`, and point your dev/production
   proxy so `/api/*` requests reach the Express server above.

## Verifying the setup

1. Run `node test/liveBiostarCheck.js` to confirm TA login and the punch-log
   fetch both work against your instance before wiring up the full sync.
2. Run `npm run sync` manually and check the `CasualWorker` and
   `AttendanceLog` tables fill in.
3. `curl -X POST http://localhost:4000/api/auth/login -H "Content-Type: application/json" -d '{"email":"...","password":"..."}'`
   should return a JWT.
4. `curl http://localhost:4000/api/attendance/summary -H "Authorization: Bearer <token>"`
   should return shift-aware daily rows.
5. Load the React app, sign in, confirm the dashboard renders, the date
   filter refetches correctly, and clicking a row opens its punch history.
6. Click "Export CSV" and confirm the file downloads with the expected rows.

## Shift-aware attendance

Casual workers rotate between two fixed shifts:

- **Day**: 08:00–17:00
- **Night**: 17:00–08:00 (overnight)

Together these tile a full 24 hours with a hard boundary and no gap.
`sync/computeDailySummaries.js` classifies each raw punch to whichever
shift's start (for check-ins) or end (for check-outs) it's closest to in
time-of-day — **no shift roster or assignment table needs to be
maintained.** A worker doesn't need to be told in advance "you're on Night
today"; the punch itself carries that information, since a 17:xx check-in
is unambiguously a Night start and an 08:xx check-out is unambiguously a
Night end. `ShiftAssignment` exists in the schema only as a future
manual-override point (e.g. to resolve a genuinely ambiguous punch by hand)
and is safe to leave empty.

This also resolves what would otherwise be a real edge case: because the
two shifts share a boundary with zero gap, a worker rotated straight from
Night into Day the next morning (ending one shift and starting the next at
~08:00, no rest between) could be ambiguous under a *range-based* matching
approach — a check-in and check-out both near 08:00 could be misattributed
to the wrong shift. Per-punch classification avoids this entirely: each
punch is classified independently by which single anchor time (a specific
shift-boundary instant) it's nearest to, so there's no shared range for two
different shift instances to compete over. This is covered explicitly by
`test/shiftSummaryTest.js`'s "EDGE CASE" checks.

Within a classified shift instance, the earliest check-in and latest
check-out (First-In-Last-Out) are used as the shift's boundaries, discarding
any punches in between — BioStar devices produce duplicate punches (a
re-badge after a missed beep) more often than workers genuinely leave and
return mid-shift. Any shift instance with more than one check-in or
check-out is flagged `hasMultiplePunches`, visible in the dashboard as a
"⚠ Multiple punches" tag, so FILO's inherent inability to distinguish noise
from a genuine gap is surfaced rather than silently trusted.

`computeSummaries()` runs automatically after every sync (see `server.js`)
and after every manual "Refresh" (see `routes/attendance.js`), writing to
`DailyAttendanceSummary` — this is what the dashboard reads for hours-worked
and lateness (`GET /api/attendance/summary`), not raw `AttendanceLog` rows
directly. Clicking a row opens the punch history modal
(`GET /api/attendance/punches`), showing every raw punch behind it tagged
`Used` or `Ignored (duplicate)`.

Deliberately out of scope for now (per discussion with UCAA): absence
tracking (a worker with zero punches produces no summary row, not a
flagged absence) and overtime calculation (`hoursWorked` is informational
only, no OT multiplier or threshold logic).

## Notes / resolved and outstanding

**Resolved (confirmed against the live server or fixed after an internal audit):**

- TA login and the punch-log endpoint are confirmed against the live server
  via `test/liveBiostarCheck.js`: TA login is a single step (`user_id` +
  `password` directly against `BIOSTAR_TA_BASE_URL/login`, no separate AC
  login), the session comes back as a `Set-Cookie` named `bs-ta-session-id`
  (never a plain response header — see `test/cookieExtractionTest.js`), and
  the punch-log endpoint is `POST <TA base>/punch_logs/modified`. Worker
  matching primarily uses the punch's top-level `user_id`, with
  `original_log.user.user_id` as a fallback; the punch's own id comes from
  `original_log.id` — confirmed against real sync output (see
  `test/mockSyncTest.js`'s fixture comment for why the TA Swagger docs'
  `modified_log`/`modified_by_user` shape doesn't match).
- **Multi-tenant data leak fixed:** `GET /api/attendance`,
  `/api/attendance/summary`, and `/api/attendance/export` all filter by the
  logged-in `PortalUser`'s `subcontractorName` via the worker relation.
  Previously any authenticated account could see every subcontractor's
  records — harmless with one subcontractor, but a real leak the moment a
  second is seeded.
- **Silent data-correction loss fixed:** the sync's upsert now updates
  `eventType`/`timestamp`/`rawPayload`/`syncedAt` on an existing row instead
  of a no-op `update: {}`, so a correction BioStar makes to an
  already-synced punch (the endpoint is literally named
  `punch_logs/modified`) is actually pulled in on the next run.
- **Timezone inconsistency fixed:** the API's `from`/`to` date-range filters
  build both boundaries in explicit UTC. The dashboard's day-grouping and
  "late"/hours computation are now handled entirely server-side in a fixed
  business timezone (East Africa Time, UTC+3, no DST) by
  `computeDailySummaries.js`, rather than the viewer's browser-local time —
  a subcontractor checking the portal from a different timezone no longer
  sees punches grouped into the wrong day or a wrong lateness call.
- **Backward sync gap fixed:** the sync no longer walks forward only from
  the latest known punch. Every run re-checks a rolling
  `SYNC_LOOKBACK_DAYS` window (default 14, configurable via env var)
  instead, so a punch stamped earlier than the last-seen record — plausible
  for overnight/night-shift punches arriving out of order — is no longer
  permanently missed, and first-run coverage isn't capped at a flat 7 days.
- **No validation/error handling on login fixed:** `routes/auth.js` now
  validates the request body, wraps the DB/bcrypt calls in try/catch, and
  applies a basic in-memory rate limit (5 attempts / 15 min per IP) — see the
  code comment for when to graduate this to `express-rate-limit` + Redis.
- **Unbounded query fixed:** `GET /api/attendance` and
  `/api/attendance/summary` now paginate (`limit`/`offset`, capped at 500
  per page) and return `{ ..., total, limit, offset }` rather than a bare
  array.
- **No timestamp sanity check fixed:** punches timestamped more than 5
  minutes in the future (relative to server time) are rejected and logged as
  a probable device clock-skew issue, rather than trusted as-is.
- **Decorative `status` field fixed:** the sync now skips punches for any
  `CasualWorker` marked `inactive` — previously the field was never read
  anywhere, so marking someone inactive had no effect.
- **Non-atomic sync fixed:** each day's batch of upserts now runs inside a
  Prisma transaction, so a crash partway through a day no longer leaves it
  half-synced (re-running was already safe either way, since every write is
  an idempotent upsert — this just removes the need to).
- **No shift/overtime/absentee logic** — resolved for the shift/hours-
  visibility part; see "Shift-aware attendance" above. Absence tracking and
  overtime calculation remain deliberately out of scope (see below).

**Still outstanding:**

- No absence tracking. A worker with zero punches in a shift produces no
  summary row at all, rather than a flagged absence.
- No overtime calculation. `hoursWorked` is informational only; there is no
  OT multiplier, threshold, or pay-code logic.
- The classification approach assumes realistic arrival/departure variance
  (minutes to a couple of hours from a shift boundary). A punch literally
  half a shift early or late would be a data-quality problem under any
  matching strategy, not specific to this design.
- The `.env` file contains live-looking credentials in plaintext. Not a
  code issue, but confirm `.gitignore` excludes it before this repo is ever
  pushed to a shared remote.
- Everything here is still scoped for a single subcontractor. The
  `subcontractorName` fields are the seam for a second one, but there's no
  UI/flow yet for onboarding a second subcontractor account.
