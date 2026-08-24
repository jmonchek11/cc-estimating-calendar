# LIS Estimating Calendar — Claude Persistent Memory

> This app is part of the Liberty platform — read docs/PLATFORM_CONTEXT.md before changing auth, events, or anything touching the liberty-core database.

## Project Purpose
Internal web app for the Liberty Integrated Solutions estimating/sales team — tracks Projects, Bids, Jobs, Change Orders, and follow-ups, replacing the weekly Monday morning status meeting.

Live site: **lis-estimating-calendar.onrender.com**

**v2 is the primary, actively-developed app, served at `/`.** v1 ("legacy") still runs alongside it at `/legacy` — read-only in practice at this point; new work goes in `v2/` and `public/v2.html`. See "Legacy (v1)" below for what still depends on it.

---

## Tech Stack
- **Node.js + Express** (`server.js`) — mounts both the v1 routes (inline in `server.js`) and v2's router (`v2/routes.js`, all under `/api/v2/*`)
- **MongoDB via Mongoose** — TWO separate logical databases on one Atlas cluster:
  - v1's default connection (`db.js` + `models/*.js`) — database `cc-estimating`
  - v2's own `mongoose.createConnection()` (`v2/models.js`) — database named by `V2_DB_NAME` env var, defaults to `estimating_v2_test`
  - Both also read/write **`liberty-core`**, a third shared database used for the cross-app user directory and the events outbox — see `docs/PLATFORM_CONTEXT.md`
- **TeamMember is ONE shared collection** — v2 does not have its own user model; `v2/models.js` imports v1's `models/TeamMember.js` directly (`V1TeamMember`). v1 and v2 used to have independently-assigned TeamMember ids in different databases; merged July 2026 (`v2/merge-team-ids.js`) after it silently broke "mine only" filtering and reminder-email recipients.
- **Auth**: `express-session` + `connect-mongo` (session store), `bcrypt` for local passwords, plus **Microsoft Entra ID SSO** (`@azure/msal-node`, server-side auth-code flow in `msauth.js` + routes in `server.js`) — matches to an existing TeamMember by `ms_oid` first, falling back to email; never auto-creates accounts. `is_admin` flag on TeamMember gates admin actions.
- **Frontend**: vanilla JS SPAs, no build step. v2 is a single file, `public/v2.html` (~3,250 lines — HTML shell + all JS inline in a `<script>` tag), with real hash-based routing (`#project/1253`, `#active-bids`, etc. — see "Routing" below). v1's frontend is `public/index.html` + `public/app.js` (~7,300 lines).
- `nextId(name)` (both v1 and v2, via each app's own `Counter` collection) for sequential integer `_id`s — NOT Mongo ObjectIds.
- `xlsx` npm package for Excel import/sync — **v1/legacy only**, see below.
- `node-cron` for scheduled jobs (reminder emails, weekly digest) — see `server.js` bottom.
- `nodemailer` (`mailer.js`) for all outbound email — Gmail SMTP, no-ops silently if `EMAIL_USER`/`EMAIL_PASS` aren't set (safe for local dev).

---

## Deployment / Git (CRITICAL)
- **Git repo lives INSIDE the `app/` folder** — `.git` is hidden in Windows Explorer. Always operate from `app/` for git commands.
- Remote: `https://github.com/jmonchek11/cc-estimating-calendar` (private)
- Render auto-deploys on push to `main`.
- **Workflow:** edit files → `git add <files>` (never blanket `git add -A`/`.`) → `git commit -m "..."` → `git push origin main`.
- User considers work "done" only when pushed and deployed. They reload the page after deploy.
- CRLF warnings on commit are normal/harmless (Windows checkout).
- Verify non-trivial changes against real data with a throwaway Node script before committing (this repo's Mongo is the actual production data — there's no separate staging dataset for v2 beyond the isolated `V2_DB_NAME` database). Always clean up any test rows/events the script creates.

---

## Project Structure (key files)

```
app/
├── server.js              # Express app: session, auth middleware, mounts v2/routes.js,
│                          #   v1 API routes inline, TV kiosk, SSO routes, cron jobs
├── db.js                  # v1 business logic (legacy)
├── mailer.js              # ALL outbound email templates + sendMail() — shared by v1 and v2
├── msauth.js              # Microsoft Entra ID SSO (MSAL Node)
├── models/                # v1 Mongoose models (Bid, Project, TeamMember, Followup, Contact,
│                          #   Settings, Counter, IgnoredPair, Idea) — TeamMember is shared with v2
├── sync-excel-lib.js, sync-excel.js, debug-excel.js, migrate.js, seed.js
│                          # v1/legacy only — Excel import/sync, one-off migrations
│
├── v2/                    # ── primary app ──
│   ├── models.js          # v2's own Mongoose connection + schemas (Project, Bid, Job,
│   │                      #   ChangeOrder, Company, Contact, BidCustomer, BidSubmission,
│   │                      #   Reminder, Note, Followup, Settings, Counter, IgnoredPair,
│   │                      #   CleanupOverride, ActivityLog) + imports v1's TeamMember
│   ├── db.js               # ALL v2 business logic — ~2,300 lines, one file
│   ├── routes.js           # Express router, everything under /api/v2/*
│   ├── notify.js           # Bridges v2 data shapes to mailer.js's v1-shaped templates
│   ├── events.js           # liberty-core events-outbox emitter (emit/safeEmit)
│   ├── backfill-events.js  # One-off/recovery script — see docs/EVENTS_OUTBOX_PLAN.md
│   ├── jis.js              # Job Information Sheet (.xlsx) import — preview/apply flow
│   └── merge-team-ids.js, import*.js, heal-*.js, seed.js, test-lifecycle.js
│                          # one-off scripts, not part of the running app
│
├── docs/
│   ├── PLATFORM_CONTEXT.md     # cross-app contracts (liberty-core, other Liberty apps) — READ FIRST
│   ├── DATA_MODEL_SPEC.md      # v2 data model source of truth — entities, stage machines, field rules
│   ├── EVENTS_OUTBOX_PLAN.md   # event catalog, emission contract, backfill spec
│   └── SSO_IMPLEMENTATION_PLAN.md
│
├── public/
│   ├── v2.html              # ── primary frontend, served at "/" ──
│   ├── index.html, app.js   # v1/legacy frontend, served at "/legacy"
│   ├── style.css            # shared by both v1 and v2
│   └── tv.html, tv.js       # TV kiosk — reads v1 data ONLY (not yet migrated to v2)
└── .env                     # MONGODB_URI, SESSION_SECRET, AZURE_*, EMAIL_USER/PASS, TV_TOKEN (not in git)
```

---

## Data Model (v2)

**`docs/DATA_MODEL_SPEC.md` is the source of truth** — read it before any schema change. Summary:

- **One datapoint, one home**: `job_number` lives only on `Job`; `bid_number` only on `Bid`; `co_number` only on `ChangeOrder`; a Project's name only on `Project`. No copies/joins-as-fields.
- **Project** (1) —< **Bid** (0..∞) —o **Job** (0..1, created at award) —< **ChangeOrder** (0..∞). Legacy pre-system jobs are Jobs with no parent bid (`winning_bid_id: null`).
- **Company** is first-class; Bid↔Company is many-to-many via `BidCustomer`; `Contact`s FK to Company.
- **BidSubmission** — one row per (bid, customer, round); `is_current` flags the live one per customer; Bid's own `estimate_amount`/`date_submitted`/`approved_by` are a denormalized snapshot kept in sync via `recomputeBidHeadline()`/`recomputeBidFollowup()` — never hand-edit those Bid fields directly.
- **Reminder** vs **Note** vs Followup: `Reminder` is a dated "ping me on X" tickler (polymorphic `parent_type`/`parent_id`); `Note` is dateless, freeform, append-only (added 2026-07); `Followup` is a per-contact-attempt log tied to a bid/CO/bid_submission. All three are separate concepts — don't conflate them.
- **ActivityLog** — audit trail (History page, admin-only), written via `logActivity()`; a handful of actions are undoable (see `UNDOABLE_ACTIONS` in `v2/db.js`).

### Bid stage machine
`opportunity → active_bid → submitted → (awarded | not_awarded)`, with `closed` reachable from `opportunity` or `active_bid`. **Reactivate** (added 2026-07) bridges back: from `submitted` → `active_bid` (new due date required); from `closed` → `active_bid` if it already had a bid #, else back to `opportunity` (no due date required) — see `reactivateBid()` in `v2/db.js`.

### Change Order stage machine
`active_co → submitted_co → (approved | not_approved | voided)`. Anyone can void; voided/not-approved COs can be **reopened** (`reopenCO()`) back to `submitted_co` (if it had been submitted before) or `active_co`.

### Job-number validation
Enforced in `updateJob`/`createLegacyJob` only: must match `^\d{5,6}$` (Foundation's format), must be unique across Jobs, clearing to `null` is always allowed, existing stored numbers are never retro-validated. **Known gap**: the admin generic entity-editor (`adminUpdate` → `PATCH /api/v2/admin/job/:id`) bypasses this validation entirely.

---

## Auth / SSO

- Session-based (`express-session` + `connect-mongo`), 8-hour cookie.
- **Microsoft Entra ID SSO**: `msauth.js` (MSAL Node, `ConfidentialClientApplication`), routes in `server.js` (`/auth/login`, `/auth/callback`). Everything in `msauth.js` no-ops gracefully (`isConfigured()` check) when `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET` aren't set — the app must still deploy and run local-password auth without them.
- SSO links to an existing TeamMember via `ms_oid` (checked first) or email match — **never auto-creates** a TeamMember.
- `ACCESS_CODE` env var is a legacy, currently-unreferenced leftover — not read anywhere in the current codebase.

---

## Events Outbox (liberty-core)

v2 emits an append-only event on every significant transition (project/bid/job/CO created, stage changes, job # assigned, PM assigned) into the shared `liberty-core.events` collection, consumed by other Liberty apps (Manpower Board, PC tool). Full catalog + payload shapes: **`docs/EVENTS_OUTBOX_PLAN.md`**.

- `v2/events.js` exports `emit()` (throws on failure — used by the backfill script) and `safeEmit()` (catches everything, logs `EMIT FAILED` + the full payload, swallows — used everywhere inside `v2/db.js`). **Emission must NEVER block or break the user's action** — always call `safeEmit()` after the primary DB write has already succeeded.
- `actor_id` is threaded into `v2/db.js` functions as an **optional trailing parameter** (mirroring how `created_by` already flows into creation functions) rather than restructuring existing signatures.
- `v2/backfill-events.js` is idempotent by natural key (type + job_id/co_id/bid_id) — safe to re-run. `--dry` (default, prints only) vs `--write` (actually inserts). **Never run `--write` without the user's explicit go-ahead** — it writes to a database other apps consume.

---

## Key Architecture Rules (things that have burned us before)

1. **Express route order matters** — any static sub-route (e.g. `/api/v2/jobs-picker`) must be declared before a parameterized sibling (`/api/v2/jobs/:id`) or Express matches the param route first. Applies in both `server.js` and `v2/routes.js`.

2. **`v2/db.js`'s bid-level headline fields are derived, not authoritative** — `estimate_amount`/`date_submitted`/`approved_by`/`next_followup_date` on `Bid` are a snapshot of the current `BidSubmission`(s), refreshed by `recomputeBidHeadline()`/`recomputeBidFollowup()`. Any code that creates/edits/supersedes a submission must call both, or the Bid card will show stale numbers.

3. **Routing (v2 frontend) is real hash-based routing, not decorative** — `setHash()` (uses `history.pushState`, never `location.hash =`) is the single choke point `navigate()` and `renderProjectPage()` call to keep the URL in sync; `pushState` never fires `popstate`, so there's no self-triggered routing loop. `routeFromHash()` (called on bootstrap, and on the `popstate` listener for back/forward) is what makes refresh/back-forward/bookmarking land on the actual page instead of always the dashboard. Don't reintroduce a bare `navigate('dashboard')` at bootstrap.

4. **Follow-up timers are working-day-and-holiday-aware** — `addWorkingDays()` (not `addDays()`) is used for every `next_followup_date` computation, skipping weekends and the computed US-holiday calendar (`getHolidays()`/`getHolidayNames()`, both pure functions of a year, weekend-observed rules included). If you add a new follow-up-scheduling call site, use `addWorkingDays`, not `addDays`.

5. **Currency and approver fields in `showForm()`** (`public/v2.html`) — dollar amounts use `type: 'currency'` (live-formats as the user types, stores a plain number), and "Approved By" fields use `nameOpts()` (a dropdown of estimators/salespeople that stores the person's **name string**, not an ID — the schema field is free text, not an FK). Don't revert these to bare `type: 'number'` / `type: 'text'`.

---

## Legacy (v1) — read-only in practice, still running at `/legacy`

- Still fully functional and still has some jobs only it does (see below), but new feature work does not go here.
- **Excel sync** (`sync-excel-lib.js`) only `$set`s fields present in the spreadsheet — never touches `project_id`, so manual project links survive imports. `project_name` (the Bid Name field) WILL update from Excel if the spreadsheet has a value.
- **`getProjects()` has an explicit `$project` aggregation stage** — a new Project schema field must be added to that whitelist or it's silently dropped before `fmtProject()` sees it.
- **`project_name` on the v1 Bid schema is `required: true`** — a PUT that leaves it empty gets rejected by Mongoose.
- **TV kiosk (`/tv`, `public/tv.html`/`tv.js`) reads v1's `Bid`/`TeamMember` models directly** — it does NOT reflect v2 activity. If the estimators ask why the TV board looks stale/wrong compared to the app, this is why; migrating it to v2 data is unstarted work.
- The Monday weekly-digest cron (`server.js`) sources its data from v2's `getDigest()`, not v1's own — v1's digest generation is retired so the team never gets two competing Monday emails.

---

## Environment Variables

```
MONGODB_URI=mongodb+srv://...          # shared cluster — v1 db, v2 db (V2_DB_NAME), and liberty-core all live here
SESSION_SECRET=some-long-random-string
V2_DB_NAME=estimating_v2_test          # optional — defaults to estimating_v2_test if unset
TV_TOKEN=some-token-for-kiosk
EMAIL_USER=...                         # Gmail SMTP — mailer.js no-ops if unset (safe for local dev)
EMAIL_PASS=...
AZURE_TENANT_ID=...                    # Microsoft Entra SSO — msauth.js no-ops if any of these three are unset
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
MS_REDIRECT_URI=...                    # NOT SET in normal use — SSO redirect URI is computed per-request from the
                                        #   incoming host (msauth.js getRedirectUri), so both onrender.com and any
                                        #   custom domain work simultaneously. Only set this to force a single fixed
                                        #   value; doing so breaks SSO on every other domain the app is reachable at.
```
