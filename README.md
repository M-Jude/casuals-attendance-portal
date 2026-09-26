# Casuals Attendance Portal

An attendance reporting and approval tool for UCAA's casual workers
(supplied by Ark Group). BioStar 2 remains the source of truth for access
control; this system is a decoupled, read-only layer that syncs punches out
of BioStar, works out who worked which shift, and runs the supervisor → HR →
Finance approval workflow on top — no BioStar credentials or roles are ever
shared with portal users.

## Architecture

```
BioStar 2  --(hourly API sync)-->  MySQL (Prisma)  --(REST API)-->  React portal
```

- `sync/` — the BioStar sync and everything computed from punches:
  - `attendanceSync.js` / `biostarClient.js` — TA login, provisions
    `CasualWorker` from BioStar's Casuals group, pulls daily punch logs into
    `AttendanceLog`.
  - `shiftEngine.js` — pure: turns one worker's punches plus the shifts they
    were expected on into shift records (see "How attendance is worked out").
  - `scheduleResolver.js` — pure: what a worker was expected to work on a
    date (crew rotation, permanent Day/Night, or an exception).
  - `computeDailySummaries.js` — runs the engine for a date range and writes
    `DailyAttendanceSummary`, keeping approved rows locked.
  - `approvalLogic.js` — pure: locking/re-approval, due times, 48h
    escalation, who may approve what.
  - `approvalJobs.js` — ready-for-approval reminders and escalations.
  - `patternProfiler.js` / `profilingJob.js` — daily punch-pattern profiling
    for HR's pattern review and crew cycle-change detection.
- `routes/` — Express API: auth, users, attendance summary/punches/export/PDF,
  manual sync, shift rules, crews/schedules/exceptions/pattern review,
  approvals, notifications.
- `middleware/` — JWT verification (reloads the account on every request so
  a disabled account or role change applies immediately) and role gates
  (`requireRole.js` documents what each role can do).
- `services/` — notifications (in-app + SMTP email) and recompute helpers.
- `scripts/` — `seedShifts.js`, `seedPortalUser.js` (first accounts),
  `bootstrapSchedules.js` (detect crews from punches).
- `src/` — React frontend: login, app shell, Attendance, Approvals,
  Schedules, Shift rules, Users.

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure `.env`**
   - `DATABASE_URL`, `JWT_SECRET`, `PORT`
   - `BIOSTAR_TA_BASE_URL`, `BIOSTAR_API_USER`, `BIOSTAR_API_PASS`,
     `BIOSTAR_CA_CERT`, `BIOSTAR_CASUALS_GROUP_NAME` — `BIOSTAR_API_USER`
     should be a dedicated read-only API account. `BIOSTAR_TA_BASE_URL`
     points at the TA module (commonly port 3002, `/tna` prefix) — confirm
     with `node test/liveBiostarCheck.js`. `BIOSTAR_CASUALS_GROUP_NAME` is the
     BioStar `user_group` the sync scopes down to.
   - `SYNC_LOOKBACK_DAYS` (default 14) — how far back every hourly run
     re-syncs and recomputes.
   - Email for escalations and alerts: `SMTP_HOST`, `SMTP_PORT` (587),
     `SMTP_SECURE` (`true` for 465), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`.
     Without `SMTP_HOST` everything still works in-app; emails are skipped
     with a warning.
   - `APP_BASE_URL` — the portal's public URL, used for links in emails.
   - `APPROVAL_TRACKING_FROM` (YYYY-MM-DD) — reminders/escalations only
     cover shifts from this date; set it to the go-live date so turning the
     workflow on doesn't escalate every historical shift at once.

3. **Run database migrations**
   ```bash
   npx prisma migrate deploy
   npx prisma generate
   ```
   Stop the API server first on Windows — `prisma generate` can't replace
   the query engine while a running server has it loaded.

4. **Seed the two shifts**
   ```bash
   npm run seed:shifts
   ```

5. **Create the first System Admin and HR accounts**
   ```bash
   node scripts/seedPortalUser.js create admin@example.com "<password>" sysadmin "System Admin"
   node scripts/seedPortalUser.js create hr@example.com "<password>" hr "HR name"
   ```
   Everyone else is created in the portal (Users): HR creates supervisors,
   Finance and the Admin Assistant; the System Admin can create any role.

6. **Detect the crews**
   ```bash
   node scripts/bootstrapSchedules.js           # dry run: prints detected crews
   node scripts/bootstrapSchedules.js --apply   # creates them and assigns workers
   ```
   Learns each worker's cycle from the last 28 days of punches, creates
   `Crew A`, `Crew B`, … (rename them in Schedules → Crews), puts each
   confidently-matched rotating worker on their crew, and recomputes
   attendance. Workers who look like permanent Day staff are *not*
   assigned — HR confirms them in Schedules → Pattern review. Then create
   the three supervisors' accounts, one per crew.

7. **Start the server** (`npm start`) and the frontend (`npm run dev`,
   which proxies `/api` to the server).

## Verifying the setup

1. `node test/liveBiostarCheck.js` — TA login and punch-log fetch against
   your instance.
2. Offline tests (no database needed):
   ```bash
   node test/shiftEngineTest.js
   node test/patternProfilerTest.js
   node test/approvalLogicTest.js
   node test/scheduleResolverTest.js
   node test/mockSyncTest.js
   node test/cookieExtractionTest.js
   ```
3. Sign in as each role and check the navigation matches the role table below.

## How attendance is worked out

The devices here never label a punch as check-in or check-out, and Day
(08:00–17:00) and Night (17:00–08:00) share both boundaries — a badge at
08:00 could end a Night or start a Day. So punch times alone can't say which
shift a punch belongs to. (The previous version guessed by alternating
in/out through each worker's punches; one missed or doubled badge then
flipped every later shift, recording Day work as Night.)

Instead, `sync/shiftEngine.js` works from what each worker was **expected**
to work:

- **Schedule** (`WorkerSchedule`, effective-dated): a crew, permanent Day,
  permanent Night, or unassigned.
- **Crew rotation** (`CrewRotation`, effective-dated): e.g. `DDNNOO` — Day,
  Day, Night, Night, off, off — from an anchor date. Three crews offset by
  two days cover every shift every day.
- **Exceptions** (`ShiftException`): a supervisor's override for one date —
  Day only, Night only, a double shift, or off.

Each expected shift owns a capture window (Day: check-ins from 05:00,
check-outs until 05:00 next day; Night: 14:00 to 12:00 next day — see
Shift rules). The first punch in the window is the check-in, the last the
check-out (first-in/last-out, as BioStar's T&A module does). Badges within 5
minutes are one event. Consequences:

- A missed or extra punch affects only the shift whose window it lands in.
- The result doesn't depend on where a computation starts — the hourly run,
  a full resync from any start date, and a manual refresh give identical
  rows (tested).
- A double shift is two rows. One badge at the changeover ends the first
  shift and starts the second; with no changeover badge the split is made at
  the scheduled time and flagged "implied".
- Punches no expected shift claims (off-day work, a new worker's test punch,
  unassigned workers) are still shown, classified by clock time and flagged
  `unscheduled`, so a supervisor can record the exception.
- A scheduled shift with no punches, once it has ended, is a `no-show`.

Rules: late = check-in more than `graceMinutes` (30) after the start, i.e.
from 08:30:01 / 17:30:01; early check-out = before the scheduled end; no meal
or break deduction. `regularHours` is the part of `hoursWorked` inside the
scheduled shift. Statuses: `on-time`, `early`, `late`, `no-checkout`,
`no-checkin`, `in-progress`, `no-show`, plus `lateIn`, `earlyCheckOut`,
`hasMultiplePunches` flags.

## Roles and approvals

| Role | Sees | Does |
|---|---|---|
| System Admin | everything | any account, crews and cycles, shift rules, approves anything |
| HR | everything | creates Supervisor/Finance/Admin Assistant accounts, shift rules, schedules, pattern review, approves permanent staff monthly and escalated shifts |
| Admin Assistant | everything | schedules and exceptions, approves escalated shifts |
| Finance | approved records only | read-only, exports/PDF |
| Shift Supervisor | their crew's records | approves their crew's shifts, records exceptions for their crew |

- Each crew's Day or Night shift on a date is one approval batch
  (`ApprovalUnit` kind `crew-shift`). It becomes approvable when the shift
  ends; the crew's supervisor gets an in-app reminder. Rows from other crews
  covering that shift go to the supervisor of the crew on duty.
- Unapproved 48 hours after that, it escalates to HR and the Admin
  Assistant (in-app + email), who can then approve it.
- Permanent Day/Night staff (and anyone not on a crew) are batched per
  month (`hr-month`) for HR to approve after month end.
- Approved rows are locked. A later recomputation that would change one (a
  late-synced punch, a schedule fix) parks the new values in
  `pendingValues`, flags `changedAfterApproval`, reopens the batch and
  restarts its 48h clock. Finance keeps seeing the approved values until
  it's re-approved.

## Pattern profiling and cycle changes

Every night (`sync/profilingJob.js`, 03:30 EAT) each worker's last 28 days of
punches are scored against every candidate schedule — permanent Day,
permanent Night, and each phase of the crew rotations — by running the shift
engine with it and counting complete shifts versus unexplained punches.

- **Pattern review (HR):** a worker whose punches confidently fit a
  different schedule than they're on — e.g. now looks like permanent Day, or
  moved crew — appears in Schedules → Pattern review, and HR is notified
  (in-app + email) once per new suggestion. HR accepts (changes their
  schedule from a chosen date) or dismisses.
- **Crew cycle changes (System Admin):** if most of a crew has moved to a
  different cycle over the last 14 days, a proposal with the detected cycle
  and change date is created and the System Admin is notified. Applying it
  adds a new effective-dated rotation; earlier dates keep the old one.
  One worker swapping doesn't trigger it.

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
  `sync/shiftEngine.js`, rather than the viewer's browser-local time —
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
- **Day shifts recorded as Night (2026-09):** the alternation-based
  check-in/check-out guess flipped every later shift after one missed or
  doubled badge, and the flipped rows were never cleaned up. Replaced by the
  schedule-driven engine and replace-on-recompute (see "How attendance is
  worked out"); verified against BioStar's weekly T&A report for 21–25 Sep —
  the raw punches matched BioStar exactly, the old classification had 181
  BioStar-confirmed Day shifts stored as Night.
- **Roster upload retired:** replaced by crews, permanent schedules and
  per-date exceptions managed in the portal, with no-shows detected for
  every scheduled shift.
- **Roles and approvals added:** see "Roles and approvals".
- **CSV export** now exports shift records (same visibility rules as the
  dashboard) with times in EAT; it previously exported raw punches with UTC
  times.

**Still outstanding:**

- BioStar's own T&A report has every casual on "ARK Casual Day" and no ARK
  night shift, so it mis-reports night work (evening "Late In, Missing Punch
  Out"). Automatic reconciliation against that report is deliberately not
  built until a proper night shift/schedule exists in BioStar.
- Unassigned workers' punches are classified by clock time only. That's
  inherently ambiguous (a 17:00 badge could end a Day or start a Night), so
  those rows are flagged `unscheduled` for a supervisor rather than trusted.
- Cycle-change detection recognises the patterns in
  `patternProfiler.CANDIDATE_PATTERNS` plus whatever the crews use; a
  completely new pattern has to be set by the System Admin.
- No overtime calculation. `hoursWorked` is informational only; there is no
  OT multiplier, threshold, or pay-code logic.
- The `.env` file contains live-looking credentials in plaintext. Not a
  code issue, but confirm `.gitignore` excludes it before this repo is ever
  pushed to a shared remote.
- Everything here is still scoped for a single subcontractor. The
  `subcontractorName` fields are the seam for a second one, but there's no
  UI/flow yet for onboarding a second subcontractor account.
