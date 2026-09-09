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

- `sync/` — logs into BioStar's AC API to get a session, then its TA
  (Time & Attendance) API to pull daily punch logs, and writes matching
  records into local tables.
- `routes/` — Express API: login, attendance read, CSV export.
- `middleware/` — JWT verification for portal accounts.
- `scripts/seedPortalUser.js` — CLI-only account provisioning (no
  self-service signup; there are only 1–2 subcontractor accounts).
- `prisma/schema.prisma` — data model (`CasualWorker`, `AttendanceLog`,
  `PortalUser`).
- `src/` — React frontend (login screen + attendance dashboard).

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
   (commonly 3002) — confirm this against your BioStar instance. There's no
   BioStar group ID to configure here: the sync pulls *all* punch logs for
   the day and only keeps ones matching a worker already in the
   `CasualWorker` table below, so scoping happens on our side, not BioStar's.

3. **Run database migrations**
   ```bash
   npx prisma migrate dev --name init
   ```

4. **Populate CasualWorker records**
   The sync job only creates attendance rows for workers it already knows
   about — it matches on `biostarUserId`. Add each casual worker's BioStar
   user ID, name, and start date to the `CasualWorker` table before the first
   sync (via `npx prisma studio`, a short one-off script, or manually).

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
   BioStar sync to run hourly, plus once immediately on startup.

7. **Build the frontend**
   Drop the contents of `src/` into your React app, add an IBM Plex
   Sans/Mono font link to your `index.html`, and point your dev/production
   proxy so `/api/*` requests reach the Express server above.

## Verifying the setup

1. Run `npm run sync` manually and check the `AttendanceLog` table fills in.
2. `curl -X POST http://localhost:4000/api/auth/login -H "Content-Type: application/json" -d '{"email":"...","password":"..."}'`
   should return a JWT.
3. `curl http://localhost:4000/api/attendance -H "Authorization: Bearer <token>"`
   should return the synced records.
4. Load the React app, sign in, confirm the dashboard renders and the date
   filter refetches correctly.
5. Click "Export CSV" and confirm the file downloads with the expected rows.

## Notes / things to confirm before go-live

- **TA login shape is unconfirmed for your BioStar version.** `loginToTA()`
  in `sync/biostarClient.js` posts `{ bs_session_id, user_id }` to `/login`
  on the TA port based on Suprema's general TA API docs, but the exact body
  field names and which header the TA session comes back in
  (`bs-session-id` vs `bs-ta-session-id`) can vary by BioStar version.
  Confirm this against your instance's TA Swagger page (usually reachable at
  `https://<biostar-host>:<TA port>/docs/#`) before relying on it — this is
  the one piece of the sync that should be smoke-tested by hand first.
- Confirm `BIOSTAR_TA_BASE_URL`'s port — 3002 is the common default but
  isn't guaranteed for every install.
- The "late" threshold in `AttendanceDashboard.jsx` is hardcoded to 9am —
  adjust to UCAA's actual shift start time.
- Confirm network/firewall access between wherever this service runs and the
  BioStar server (both the AC and TA ports), including the CA certificate
  path if BioStar uses a self-signed cert.
- The sync only creates rows for punches where `modified_by_user.user_id`
  (or the punch's own `modified_log.user.user_id`) matches a `CasualWorker`
  already in our table — everyone else's punches are silently skipped, which
  is by design but worth confirming in a first-run log.
- Everything here is scoped for a single subcontractor. The
  `subcontractorName` fields on `CasualWorker` and `PortalUser` are seams for
  adding a second subcontractor later without a schema migration.
