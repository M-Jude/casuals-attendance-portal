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

## Deployment (CI/CD to Windows Server)

`.github/workflows/ci-cd.yml` runs on GitHub Actions:

- **Pull request into `master`** → installs, runs `npm test` and builds the
  frontend on a GitHub-hosted runner. Nothing is deployed, so the PR shows
  whether it is safe to merge.
- **Merge into `master`** (or a manual "Run workflow") → the same checks,
  then the `deploy` job runs on a **self-hosted runner on the Windows Server
  VM** and executes `deploy/windows/deploy.ps1`: build, stop the service,
  mirror the files into `C:\apps\casuals-attendance-portal` (keeping `.env`
  and `logs\`), `prisma migrate deploy`, start the service, health-check
  `/api/health`. The live portal is updated within a few minutes of merging.

In production Express serves the built React app from `dist/`, so the
portal and API share one URL (`http://<server>:<PORT>/`).

### One-time VM setup

1. Install **Node.js LTS**. The VM needs network access to MySQL, BioStar
   and GitHub.
2. Get a runner token: repo → **Settings → Actions → Runners → New
   self-hosted runner** — copy the value after `--token` (valid one hour).
3. From an elevated PowerShell in a copy of this repo, run
   ```powershell
   .\deploy\windows\setup-server.ps1 -RunnerToken <token>
   ```
   (optional `-AppDir`, `-ServiceName`, `-Port`). It trusts the Let's
   Encrypt root if the server lacks it (GitHub's download hosts need it),
   installs NSSM, creates the app folder, registers the `CasualsPortal`
   service, opens the firewall port and installs the GitHub Actions runner
   as a service (label `casuals-portal`, running as LocalSystem so it can
   restart the portal). Safe to re-run.
4. Fill in `C:\apps\casuals-attendance-portal\.env` with the real values
   (see Setup above). It is never overwritten by deploys.
5. Merge a PR into `master` (or run the workflow manually from the
   **Actions** tab) to do the first deploy, then run the seed scripts from
   the app folder if this is a fresh database.

Recommended: protect `master` (Settings → Branches) to require pull requests
and the **Test & build** check, so only passing code is deployed.

### Public access (Tailscale Funnel)

To reach the portal from any network without opening an inbound port or
owning a domain, `deploy/windows/setup-funnel.ps1` installs Tailscale as a
Windows service and turns on Funnel, which serves the portal over HTTPS at
`https://<machine-name>.<tailnet>.ts.net`.

1. Create a free account at https://tailscale.com, then **Settings → Keys →
   Generate auth key**.
2. From an elevated PowerShell:
   `.\deploy\windows\setup-funnel.ps1 -AuthKey <tskey-auth-...>`. If
   Tailscale prints a link to enable Funnel for the tailnet, open it and
   approve. The script prints the public URL when done.
3. Set `APP_BASE_URL` in the app's `.env` to that URL (used in email links)
   and restart the `CasualsPortal` service.

Before exposing it, make sure `JWT_SECRET` is a fresh random value. Once
everyone uses the public URL, `HOST=127.0.0.1` in `.env` stops the portal
listening on the LAN at all (the tunnel connects locally).

### Database users (protecting the audit log)

The portal should not connect to MySQL as `root`. With two dedicated users,
the running portal can read and add audit-log entries but **cannot edit or
delete them** — even someone who gets hold of the portal's database password
can't quietly rewrite the trail.

| MySQL user | Used by | Can |
|---|---|---|
| `casuals_app` | the running portal (`DATABASE_URL`) | read/write ordinary tables; **read + add only** on `AuditLog`; no table changes |
| `casuals_migrate` | the deploy only (`MIGRATE_DATABASE_URL`) | apply migrations; keep `casuals_app`'s permissions current |
| `root` | database administrators only | everything — no longer in the portal's `.env` |

`casuals_app` gets its rights table by table (`scripts/dbGrants.js`); every
deploy re-applies them after migrating, so new tables are covered, and then
checks — as `casuals_app` — that editing or deleting audit entries is refused.

One-time switch-over, on the server:

1. Make two passwords (letters and digits, so no URL escaping is needed):
   `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"` (run it twice).
2. Put them into `deploy\mysql\setup-users.sql` and run it as root
   (MySQL Workbench, or `mysql -u root -p -P 4436 < deploy\mysql\setup-users.sql`).
3. In `C:\apps\casuals-attendance-portal\.env` (keep a copy of the old
   `DATABASE_URL` line until step 5 works):
   - change `DATABASE_URL` to
     `"mysql://casuals_app:<app password>@localhost:4436/casuals_portal"`
   - add
     `MIGRATE_DATABASE_URL="mysql://casuals_migrate:<migrate password>@localhost:4436/casuals_portal"`

   (The running portal keeps its old connection until it restarts.)
4. From `C:\apps\casuals-attendance-portal`, run `node scripts/dbGrants.js`
   to see the plan, then `node scripts/dbGrants.js --apply`. It grants the
   permissions, then signs in as `casuals_app` and confirms that reading
   works and editing/deleting audit entries is refused.
5. `Restart-Service CasualsPortal` (as administrator) and check that
   **System status** shows the database as OK. Then delete the old root line.

If step 4 or 5 fails, put the old `DATABASE_URL` back and restart — nothing
else has changed.

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
- **Double shifts** are any two shifts worked back to back: a Day and that
  evening's Night, or a Night and the next morning's Day (a no-show breaks
  the run; Day + Night + next Day is one double). Each counts as a shift and
  the double once, on the date it started (`reports/doubleShift.js`,
  mirrored in `src/doubleShift.js`).
  - **Day + Night on the same date is shown as one line**, "Day + Night",
    from the Day's clock-in to the Night's clock-out, with the hours between
    them (gaps at the changeover included). It stays on the Day's date even
    though the Night ends the next morning, so a Night of 30 Sep belongs to
    September. Underneath, the two shifts stay separate stored records, each
    approved by its own crew's supervisor (the approval screen shows the
    other half); the hours are shared between them at the changeover.
  - **Night + the next morning's Day** stays two lines, each on its own date.

  Reports look a day past each end of the period (and across a shift filter)
  to find doubles. They're tagged on the dashboard and My attendance (with a
  "Double shifts only" filter), counted in every report (register `DN` /
  `N+` `+D`, hours & payroll with double-shift hours, an Exceptions section,
  …) and marked in the CSV/PDF downloads.
- A worker with no confirmed schedule is judged against the pattern the
  nightly profiling found for them (rows marked `suggested`) until HR
  confirms it in Pattern review.
- Punches no expected shift claims (off-day work, a new worker's test punch,
  workers with too few punches to profile) are still shown, classified by clock time and flagged
  `unscheduled`, so a supervisor can record the exception.
- A scheduled shift with no punches, once it has ended, is **Absent**
  (stored as status `no-show`; the portal, reports, PDFs and emails all
  show it as "Absent").

Rules: late = check-in more than `graceMinutes` (30) after the start, i.e.
from 08:30:01 / 17:30:01; early check-out = before the scheduled end; no meal
or break deduction. `regularHours` is the part of `hoursWorked` inside the
scheduled shift. Statuses: `on-time`, `early`, `late`, `no-checkout`,
`no-checkin`, `in-progress`, `no-show`, plus `lateIn`, `earlyCheckOut`,
`hasMultiplePunches` flags.

A punch no schedule claims is still recorded ("unscheduled"). With two or
more badges the punches settle the shift; a **single** badge is a guess,
flagged "Shift guessed": it goes to the shift the worker's own complete
shifts of the previous 28 days mostly were (at least 2, two-thirds one
type), or by clock time when there's no clear pattern. A worker's first-ever
schedule defaults to the day before their first punch, so it covers their
whole history (`scripts/backdateFirstSchedules.js` fixes older ones). The
"Crew" column in reports is the worker's own crew from their schedule — not
the crew whose supervisor approves a cover shift. Confirming a profiled
("suggested") schedule only relabels approved rows; it doesn't reopen them.

A worker is only expected on shifts whose punch window closes after their
first ever punch, so someone who joins mid-month isn't marked a no-show
for the days before they started (a supervisor's exception still applies).
After a change to how shifts are worked out, rebuild history with
`npm run recompute` (or `-- --from YYYY-MM-DD --to YYYY-MM-DD`); the hourly
job only covers the recent lookback window.

## Roles and approvals

| Role | Sees | Does |
|---|---|---|
| System Admin (UCAA ICT) | everything, incl. the audit log and System status | any account (incl. other System Admins, HR, Auditors), crews and cycles, schedules, shift rules. **Does not approve attendance** (separation of duties). Signs in with password + authenticator code |
| HR | everything | creates Supervisor/Finance/Admin Assistant accounts, crews and cycles, shift rules, schedules, pattern review, approves permanent staff's shifts and escalated shifts |

System Admin safeguards:
- **Two-step sign-in**: a System Admin's password alone never gives a
  session; they also enter a 6-digit code. At their first sign-in they
  choose how they get it: an **authenticator app** (scan a QR code) or
  **email** (a code is emailed at each sign-in). App users can also choose
  "Email me a code instead" on the sign-in screen. Emailed codes work once,
  for 10 minutes, and are void after 5 wrong tries; at most one email a
  minute; only a hash is stored, and codes are masked in the audit log.
  Email codes depend on email working — if it's down, use the app, or have
  another System Admin reset the method. Sessions without the code are
  refused, and resetting someone's two-step sign-in ends theirs. A lost
  phone or a change of method: another System Admin uses Users → Manage →
  "Reset two-step sign-in"; if none can, run
  `node scripts/seedPortalUser.js reset-two-step <email>` on the server.
- **Generated temporary passwords**: new accounts and resets get a
  10-character password made up by the portal and emailed to the account
  holder, so no admin chooses or sees it (it's shown once only if the
  email fails). It must be replaced at first sign-in.
- **The last active System Admin** can't be disabled or demoted; keep at
  least two (the Users page warns otherwise).
- **Deleting an account** (System Admin only; Users → Manage → "Delete
  account…", confirmed) removes only the sign-in account and its
  notifications. The linked worker record, all attendance, approvals,
  schedules, reports and the audit log stay; the account's name is kept in
  `DeletedAccount` (read + add only for the portal's database user) so
  "approved by" still shows e.g. "Sam Okello (account deleted)". You can't
  delete your own account; deleting a System Admin is told to all of them.
  To block someone temporarily, disable the account instead.
- **All System Admins are emailed** when anyone is made or stops being a
  System Admin, or a System Admin is disabled, re-enabled, has their
  password reset or their two-step sign-in reset.

**System status** (System Admin, Auditor) shows the portal version and last
deploy, database, BioStar sync, email, shifts/workers, accounts (incl.
two-step coverage) and approvals at a glance. Deploys write `version.json`
for it.
| Admin Assistant | everything | schedules and exceptions, approves escalated shifts |
| Finance | approved records only in Attendance, exports and reports (what gets paid); the Live page | read-only (enforced centrally, like the Auditor): views and downloads |
| Shift Supervisor | their crew's records | approves their crew's shifts, records exceptions for their crew |
| Director (Ark Group) | the **Overview** (month at a glance vs the previous month), all attendance live (approved or not), the Live page, every approval batch and its history, reports | read-only. Gets a **weekly attendance digest** every Monday 07:00 EAT (in the portal and by email; preview with `npm run digest`, send now with `npm run digest -- --send`). Created by the System Admin only; never linked to a worker record |
| Auditor (internal UCAA audit) | everything: all records, raw punches, every approval batch, schedules and their history, accounts, the full audit log (System Admin included) | read-only: views, reports and exports. Created by the System Admin only; never linked to a worker record; gets no notifications |

The Auditor's read-only status is enforced in `middleware/authenticate.js`
for every request, not just by leaving the role off each route: apart from
signing out, changing their own password and logging a print, any request
from an auditor that isn't a read is refused (403 `READ_ONLY`).
`test/auditorRoleTest.js` also checks that no route that changes data
names the auditor.

- Each crew's Day or Night shift on a date is one approval batch
  (`ApprovalUnit` kind `crew-shift`). It becomes approvable when the shift
  ends; the crew's supervisor gets an in-app reminder. Rows from other crews
  covering that shift go to the supervisor of the crew on duty.
- Unapproved 24 hours after that, everyone who can approve it gets an
  **overdue email** (and in-app), repeated every 24 hours until it's
  approved — one email per person listing each of their overdue batches
  with its records, late / absent / missing-punch counts, changes after
  approval, how long it has waited and when it escalates.
- Unapproved 48 hours after that, it escalates to HR and the Admin
  Assistant (in-app + email, with the same details), who can then approve
  it; the crew's supervisor is emailed that it was escalated and can still
  approve it. (`sync/approvalJobs.js`, every 15 minutes.)
- Permanent Day/Night staff (and anyone not on a crew) are batched the same
  way, per shift per date (`hr-shift`): HR gets an in-app reminder when the
  shift ends and approves it; unapproved 48 hours later it escalates and
  the Admin Assistant can approve it too. Dates before 1 Oct 2026
  (`HR_DAILY_FROM` in `sync/approvalLogic.js`) stay in the monthly batches
  (`hr-month`) they were approved in.
- A backlog can be cleared with `node scripts/approveBacklog.js --month
  YYYY-MM --as <account email>`, or `--from YYYY-MM-DD --to YYYY-MM-DD`
  for a custom range (inclusive; `--to` defaults to `--from`). It's a dry
  run; add `--yes` to approve. It approves every waiting batch in the
  period — crew and permanent staff — as that account, with a comment and
  an audit entry for each. Shifts that haven't ended yet are skipped, and
  an older monthly batch only counts when the range covers its whole month.
- Approved rows are locked. A later recomputation that would change one (a
  late-synced punch, a schedule fix) parks the new values in
  `pendingValues`, flags `changedAfterApproval`, reopens the batch and
  restarts its 48h clock. Finance keeps seeing the approved values until
  it's re-approved.
- **Re-approving automatically with a schedule change.** Changing a
  worker's schedule (Schedules → Workers, or accepting in Pattern review)
  asks for confirmation with a **"Re-approve changed records
  automatically"** checkbox, ticked by default (shown only when the change
  reaches existing records). Ticked, the approved shifts that change are
  re-approved straight away as the person making the change (pending
  values applied, a record no longer supported by the punches removed),
  and a batch left with nothing to approve is approved again — keeping its
  original approver, or stamped with this change if it's a batch the rows
  moved into. Shifts the change *adds* to a batch that was already
  approved are approved too: a Night that becomes a Day is the old Night
  record removed plus a new Day record, so both sides go through. New
  shifts in batches not yet approved (e.g. today's) and anything held for
  another reason are left for their approver. Unticked, they're
  held for re-approval as before. The audit entry says which was chosen
  and how many were re-approved (`services/approveUnit.js` reapproveRows).

## Live view

The **Live** page shows a crew's current shift as it happens: who's on site
(and for how long), who hasn't come in past the grace period, who has left,
Late in / Early out, anyone else working the shift under that crew's
supervisor, and the latest badges. Supervisors see their own crew; HR, the
Admin Assistant and the System Admin pick a crew. It shows a shift from 3 h
before it starts to 2 h after it ends; on an off day it shows the next one.

The page refreshes every 30 s (while visible). The server pulls today's and
yesterday's badges from BioStar every `LIVE_SYNC_MINUTES` (default 2; `0`
turns it off) and recomputes only the workers with new badges
(`services/liveSync.js`). Syncs share one lock, so the hourly full sync, a
manual sync and the live sync never overlap. Logic: `sync/liveView.js`;
API: `GET /api/live?crewId=`.

## Accounts linked to workers

A portal account can be linked to the account holder's worker record
(`PortalUser.casualWorkerId`, one account per worker). Logic lives in
`services/accountLink.js`.

- **Supervisors must be workers.** HR picks the worker record when creating
  the account; the supervisor leads the crew that worker rotates with (taken
  from their schedule). Other roles may link a worker record optionally
  (never the future Director role — `NO_WORKER_LINK`).
- **Moving a supervisor.** Any change that takes a supervisor's worker record
  off their crew (Schedules → Workers, Pattern review, or Users → Move to
  another crew) needs HR's decision: stay supervisor of the new crew, or
  become just a worker — which disables the portal account (there is no
  worker-only login). The API answers 409 with a `decision` payload until
  `supervisorAction: 'keep' | 'demote'` is given.
- **Leaving BioStar.** Each sync marks workers who are no longer in the
  BioStar casuals group inactive; a linked account is disabled and HR and the
  System Admin are notified (in-app and email). It never reactivates anyone,
  and does nothing if the group comes back missing more than half the
  workforce (a bad BioStar response). An account whose worker is inactive
  can't be re-enabled.
- **My attendance.** Linked accounts get a page with their own shifts
  (`GET /api/me/attendance`), whatever their role would otherwise see.

## Reports

The **Reports** page lists the reports the signed-in role can run. Pick one
and a period (day, week Mon–Sun, month, date range or all time), preview it
on screen or print the preview, and download it as PDF, Excel or CSV. Every
report uses the same visibility rules as the dashboard (Finance: approved
records only; supervisors: their crew only).

| Report | Periods | What it shows |
|---|---|---|
| Daily attendance | day | everyone on one date, per shift |
| Clock-in / clock-out timesheet | any (optionally one worker) | per worker, per day: actual clock-in and clock-out, every badge, minutes late / left early, hours |
| Attendance summary | week, month, range, all | one line per worker: shifts, hours, late, absent, attendance % |
| Individual worker | week, month, range, all | one worker shift by shift, plus week-by-week totals |
| Attendance register | week, month, range (≤ 31 days) | timesheet grid, D / N / DN / A per date |
| Hours & payroll | week, month, range, all | shifts and hours, approved vs awaiting approval |
| Exceptions | any | late (minutes late), absences, missing punches, early outs, multiple punches, unscheduled, worst offenders |
| Daily headcount | week, month, range, all | one line per date |
| Crew performance | any | each crew shift by shift, with approval state |
| Approval status | week, month, range, all | approval batches, who approved when, escalations (not Finance) |
| Detailed records | any | every shift record with all fields |

**Columns** lets the user untick columns they don't want; the choice applies
to the preview and all three downloads (`&hide=key,key`) and is remembered
per report in that browser. The keys each report offers are declared in
`REPORT_COLUMNS` (reportCatalog.js); `test/reportsTest.js` fails if a
builder adds a column that isn't listed there.

The report preview, the attendance dashboard, approvals (list and batch),
schedules (workers, pattern review, exceptions) and users are paged on
screen (25/50/100/200 per page, remembered per list). The dashboard now
loads the whole selected range (in chunks of 5,000, up to 50,000) instead of
stopping at 500 records, so the overview always covers the full period.

API: `GET /api/reports` (catalog for the user's role, with each report's columns),
`GET /api/reports/workers`, and
`GET /api/reports/:type?period=day|week|month|range|all&date=|month=|from=&to=&workerId=&shift=Day|Night&format=json|csv|xlsx|pdf`.
The builders in `reports/reportCatalog.js` produce one format-neutral model
that `renderCsv.js`, `renderXlsx.js` and `renderPdf.js` draw. The CSV has a
title block, key figures and each section as its own table with a TOTAL
line (UTF-8 with BOM so Excel opens it cleanly); the Excel file adds real
formatting (styled headers, frozen panes, filters, coloured statuses). A PDF
is capped at 6,000 table lines — use Excel/CSV beyond that.

## On phones (installable app)

Below 900px wide the portal switches to an app layout: a dark app bar with the
page name and notifications, and a bottom tab bar with the first four pages.
The remaining pages, the account, "Install app" and Sign out are in the More
sheet. Below 760px, list tables become cards: each card's captions come from
the column headings, copied onto the cells by `src/useCardTables.js`, so new
tables need nothing extra. Report tables keep their grid and scroll sideways.

The portal is a Progressive Web App (`public/manifest.webmanifest`,
`public/sw.js`). On Android/Chrome, More → Install app adds it to the home
screen. On iPhone, use Safari's Share → Add to Home Screen. It then opens full
screen with its own icon. The service worker caches only the app shell, so it
opens offline. `/api` calls always go to the network. Installing needs the
portal served over HTTPS (or `localhost`). The worker is registered in
production builds only. Icons are drawn by `node scripts/generateAppIcons.js`.

## Audit logs

Setup → Audit logs (System Admin only) lists what people have done in the
portal. Each entry records who did it (name, email and role, copied into the
entry), when, the IP address, the device (browser, OS, phone model, and
whether it came from the installed app) and whether it succeeded.
`middleware/auditTrail.js` writes an entry once the response has been sent,
for:

- sign-ins (including failed attempts and rate-limited ones) and sign-outs
- every request that changes something: accounts, approvals, crews and
  rotations, worker schedules, pattern review, exceptions, shift rules,
  manual syncs, notifications read. A request that no rule describes is
  still logged, under "Other".
- every download (attendance CSV/PDF, report CSV/Excel/PDF, the audit export),
  report previews, printed report previews and views of raw punches.

Rejected requests (403, validation errors) are logged as failed, with the
error message. Request data is stored with passwords and tokens masked.
Changes to accounts and shift rules keep before and after values. Summaries
name the worker, crew or batch involved. Routine page loads and polling are
not logged. Entries are insert-only: nothing in the portal edits or deletes
them.

Every downloaded file says who downloaded it and when, with a reference such
as `DL-20260930-0C167F`. The same reference appears on that download's audit
entry. Where the stamp goes:

- **PDF:** the footer of every page, plus the document properties.
- **Excel:** the Overview sheet, every sheet's print footer, and the file
  properties.
- **Report CSV:** the header block.
- **Attendance export CSV:** after the data, so the column header stays the
  first line.
- **Printed report previews:** carry a "Printed by … on …" line.

IP addresses: behind a reverse proxy, set `TRUST_PROXY` so the real client
address is taken from `X-Forwarded-For`. The default is `loopback`, a proxy on
the same machine, which covers the Vite dev proxy. Use a hop count (`1`), an
address or subnet, or `false`. The table grows with use. There is no automatic
clean-up; keep entries as long as your retention policy requires.

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

## Deploying on Windows Server

In production IIS is the only thing users talk to: it serves the built app
from `dist/` over HTTPS and reverse-proxies `/api` to the Node API, which
listens on localhost only. `public/web.config` (copied into `dist/` by the
build) holds the rewrite rules.

```
Browser --HTTPS 443--> IIS (dist/ + /api proxy) --HTTP--> Node API 127.0.0.1:4000 --> MySQL, BioStar
```

1. **Install** Node.js LTS, MySQL (or point `DATABASE_URL` at an existing
   server), IIS with the **URL Rewrite** and **Application Request Routing**
   modules.
2. **Configure ARR** (once per server, elevated prompt):
   ```bat
   %windir%\system32\inetsrv\appcmd set config -section:system.webServer/proxy /enabled:true /preserveHostHeader:true /includePortInXFF:false /timeout:00:05:00 /commit:apphost
   ```
   `includePortInXFF:false` keeps client IPs in the audit log clean; the
   5-minute timeout covers a manual sync (`POST /api/attendance/sync`), which
   waits for the whole BioStar pull and recompute.
3. **Install and build** in the deployment folder (e.g. `C:\apps\casuals-portal`):
   ```bat
   npm ci
   npx prisma migrate deploy
   npx prisma generate
   npm run build
   ```
4. **`.env` for production** — as in Setup, plus:
   - `HOST=127.0.0.1` so the API can't be reached except through IIS.
   - `PORT=4000` — must match the proxy target in `public/web.config`.
   - `APP_BASE_URL=https://<public host name>` for email links.
   - A long random `JWT_SECRET` (not the dev one).
   - Remove `BIOSTAR_SKIP_TLS_VERIFY`; set `BIOSTAR_CA_CERT` instead.
5. **Run the API as a Windows service** so it starts with the server and
   restarts if it crashes — e.g. with [NSSM](https://nssm.cc):
   ```bat
   nssm install CasualsPortalApi "C:\Program Files\nodejs\node.exe" server.js
   nssm set CasualsPortalApi AppDirectory C:\apps\casuals-portal
   nssm set CasualsPortalApi AppStdout C:\apps\casuals-portal\logs\api.log
   nssm set CasualsPortalApi AppStderr C:\apps\casuals-portal\logs\api-error.log
   nssm set CasualsPortalApi AppRotateFiles 1
   nssm start CasualsPortalApi
   ```
   `AppDirectory` matters: `.env` is read from the working directory. Run
   only one instance — the cron jobs and login rate limiter live in-process.
6. **IIS site**: physical path `C:\apps\casuals-portal\dist`, HTTPS binding
   on 443 with the site's host name and certificate (e.g. Let's Encrypt via
   [win-acme](https://www.win-acme.com), which also renews it), plus an HTTP
   binding on 80 that `web.config` redirects to HTTPS.
7. **Firewall**: allow inbound 443 (and 80 for the redirect / certificate
   validation). Never expose 4000 (API) or 3306 (MySQL).

HTTPS is required, not optional: the installable phone app and its service
worker only work over HTTPS, and passwords and tokens cross the internet.

**Updating**: pull the new code, `npm ci`, `npx prisma migrate deploy`,
stop the service, `npx prisma generate`, `npm run build`, start the service.

### Access from outside the office

The portal only needs to be reachable on 443 at a host name; pick one with
the network/IT team:

- **Publish through the firewall** (recommended for phone users): a public
  DNS name (e.g. `casuals.<domain>`) pointing at the firewall, with 443 NATed
  to this server — ideally in a DMZ that can reach only MySQL and BioStar.
  Users just open the URL; no client software.
- **Cloudflare Tunnel**: `cloudflared` on this server makes an outbound
  connection, so no inbound ports or public IP are needed; Cloudflare Access
  can add an extra sign-in (e.g. email one-time code) in front of the portal.
  Point the tunnel at `https://localhost` (or drop the HTTPS redirect rule).
- **Existing VPN**: nothing is exposed publicly, but every user (including
  supervisors on phones) needs the VPN client connected.

Once it's on the internet, the portal's own password is the only barrier
(failed logins are rate-limited, but there's no MFA): enforce strong
passwords, disable leavers promptly, and check the audit log for sign-in
failures.

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
