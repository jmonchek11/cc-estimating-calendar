# CC / LIS Estimating Calendar — Claude Persistent Memory

## Project Purpose
A full-stack internal web app for the Liberty Integrated Solutions estimating/sales team to track bids, change orders, projects, and follow-ups — replacing the weekly Monday morning status meeting.

Live site: **lis-estimating-calendar.onrender.com**

---

## Tech Stack
- **Node.js + Express** (`server.js`) — REST API
- **MongoDB via Mongoose** (`db.js` + `models/*.js`) — NOT SQLite (old memory said SQLite — ignore that)
- **Mongoose models:** Bid, Project, TeamMember, Followup, Contact, Settings, Counter, IgnoredPair, Idea
- `nextId(name)` uses the Counter collection for sequential integer `_id`s
- **Vanilla JS SPA frontend** (`public/app.js` ~5900 lines, `public/style.css`, `public/index.html`) — hash-based routing (`#dashboard`, `#bids`, `#projects`, etc.)
- `express-session` + `bcrypt` auth (`is_admin` flag on TeamMember)
- `xlsx` npm package for Excel import/sync (`sync-excel-lib.js`)
- `connect-mongo` for session store

---

## Deployment / Git (CRITICAL)
- **Git repo lives INSIDE the `app/` folder** — `.git` is hidden in Windows Explorer. Always `cd app` before git commands.
- Remote: `https://github.com/jmonchek11/cc-estimating-calendar`
- Render auto-deploys on push to `main`
- **Workflow:** edit files → `git add <files>` → `git commit -m "..."` → `git push origin main`
- User considers work "done" only when pushed and deployed. They must reload the page after deploy.
- CRLF warnings on commit are normal/harmless.

---

## Project Structure (key files)

```
app/
├── server.js           # Express app, all API routes
├── db.js               # All DB functions (getters, creators, updaters) — ALL business logic here
├── sync-excel-lib.js   # Excel import/sync logic
├── models/
│   ├── Bid.js          # Main bid/change-order schema
│   ├── Project.js      # Project entity (name + job_number)
│   ├── TeamMember.js   # Users/estimators (last_seen for online presence)
│   ├── Followup.js     # Follow-up log entries
│   ├── Contact.js      # Customer contacts
│   ├── Settings.js     # App-wide settings
│   ├── Counter.js      # Auto-increment ID sequences
│   ├── IgnoredPair.js  # "Not a duplicate" project pairs
│   └── Idea.js         # User-submitted ideas/issues
├── public/
│   ├── index.html      # SPA shell, all form HTML
│   ├── app.js          # ~5900 lines — all frontend logic
│   ├── style.css       # All styles
│   └── tv.html         # TV kiosk view
└── .env                # MONGODB_URI, SESSION_SECRET, TV_TOKEN (not in git)
```

---

## Key Architecture Rules (things that have burned us before)

1. **Express route order matters**: any static sub-route like `/api/bids/rfc-cleanup` MUST be declared BEFORE `/api/bids/:id` or Express catches it as `id='rfc-cleanup'` → 404 "Not found".

2. **getProjects() has an explicit `$project` stage** — any new Project schema field MUST be added to the whitelist in that aggregation or it gets silently dropped before `fmtProject()` sees it. This bit us with `job_number`.

3. **Excel sync safety**: `sync-excel-lib.js` only `$set`s fields present in the spreadsheet — it NEVER touches `project_id`, so manual project links survive imports. BUT `project_name` (the Bid Name field) WILL update from Excel if the spreadsheet has a value for it.

4. **`_projectPickerCache`** (frontend global): set to `null` to bust after any project create/update so the autocomplete refreshes.

5. **`project_name` on Bid is `required: true`** — any PUT to update a bid where `project_name` ends up empty/null will be rejected by Mongoose with a validation error.

---

## Data Model — Bid vs Project

```
Project { _id, name, job_number, created_by, created_at, updated_at }
                          ↑
                          linked via Bid.project_id (FK)

Bid {
  _id, bid_number, job_number,  co_number,   ← separate RFC/CO # field
  project_name,                              ← THIS IS "BID NAME" (confusingly named)
  project_id,                                ← FK to Project._id
  stage, customer, estimator_id, ...
}
```

- `project_name` on Bid = the **Bid Name** (displayed as "Bid Name" in the UI)
- `project_entity_name` = the Project's `.name` (joined at query time, returned as `project_entity_name`)
- A Project can have many bids/COs sharing the same job_number

---

## Stage Flow
`opportunity` → `active_bid` / `active_co` → `follow_up` → `awarded` / `not_awarded` / `closed`

---

## Features — Fully Built and Working

### Bids
- Full CRUD with all fields; Excel sync
- `bid_number`, `job_number`, `co_number` (RFC/CO #), `project_name` (Bid Name)
- Bid flyout redesign: Project name (bold) → Job # → RFC/CO # (orange) → Bid name/# → Details → Dates → Contacts → Reminders → Notes → Progress → Award → Follow-up History → Bid Lifecycle (last)
- Bid Lifecycle: CO rows sorted numerically (RFC/COR prefix), color-coded by stage
- "Bid Name" field (renamed from "Project Name" in form) — does NOT auto-fill from project selection

### Projects
- Full CRUD; "+ New Project" button (name + optional job #)
- Projects list: bid count, bid #s, estimator pills, customers, active badge, pipeline value
- **Admin-only** inline project name editing (✏️ pencil only visible to admins)
- Inline project job # editing (all users)
- Job-number scan: set job # on project → "🔍 Scan Matching Bids" → finds unlinked bids with matching job_number → checkbox review → bulk-link
- Prompt to delete project if it's left empty after relinking its last bid

### Project Linking
- From bid flyout: "Change/Link Project" inline search autocomplete
- From project panel: "Add Existing Bid" search
- Manual link / relink with auto-cleanup of orphaned empty projects

### Project Auto-Grouping (Settings page → Data Management)
- Groups bids by matching name into Projects
- Duplicate review: shows bid #s, merge or "Not a Duplicate" (stored in IgnoredPair)
- Ignored pairs never re-appear in duplicate list

### RFC/COR Cleanup Tool (Data Cleanup page — amber button)
- Finds all bids with RFC or COR anywhere in `job_number`
- Extracts base job # + normalized `RFC-XX` or `COR-XX` number
- Prepends RFC# to Bid Name (e.g. "RFC-20 Bulletin 16 — Fire Alarm")
- Matches to existing Project by job #
- Shows checkbox diff review with before/after; bulk apply selected

### Dashboard
- Calendar below overdue follow-ups & estimates due this week
- My View / All Bids toggle (respects `mine_only`)
- `rerenderCalContext()` helper for refreshing calendar

### Online Presence
- Sidebar footer pulsing dot + count
- 60s heartbeat → `last_seen` on TeamMember; 5-min online window
- Click for who's-online panel

### Ideas / Issues
- 💡 button in sidebar footer
- Any user submits idea/issue with title, body, "Related to" page dropdown (auto-detects current page from hash)
- Admins see inbox in same modal with status dropdown (new/reviewed/done/wontfix)
- Idea model with `page` context field

### Other
- TV kiosk view (`/tv?token=xxx` or `/tv/xxx`)
- Global search — results show linked project entity name (🏗️ badge)
- Estimator / contact / company profile modals with bid history + stats
- Submit bid modal (IBEW jurisdiction picker with pinned common locals)
- Reminders system

---

## Team
**Sales:** Brian Fischer (BF), Jim O'Driscoll (JO), Damion Covelens (DC), Dillon Dosenbach (DD), Fran Thompson (FT), Jacob Kiefer (JK), Jess Baker (JB), Ray Reichenbach (RR), Joe Monchek (JM, admin)
**Estimators:** Connor Winters (CW), Pat McCreesh (PM), Doug Pierno (DP), Scott Yaffee (SY), Jonathon Chukinas (JC)

---

## Known Bugs / Open Issues

### RFC Cleanup "Apply Selected" — possible failure (unconfirmed)
User reported apply failing but never provided the error. Best hypothesis:
- `project_name` (Bid Name) is `required: true` in Bid schema
- If `extractRfcFromJobNumber()` produces an empty `newBidName`, the PUT will be rejected by Mongoose
- **Diagnostic**: open browser console (F12), look for `Failed bid <id>:` log lines during apply
- **Fix**: in `applyRfcCleanup()` in app.js, guard against empty newBidName before sending PUT

---

## Environment Variables Needed
```
MONGODB_URI=mongodb+srv://...
SESSION_SECRET=some-long-random-string
TV_TOKEN=some-token-for-kiosk
```
