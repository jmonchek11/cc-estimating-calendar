# Events Outbox — Calendar-Side Emission (Implementation Spec)

*Authored 2026-07-09 by the platform-planning session. This is the calendar's half of
PLATFORM_ROADMAP.md Phase 4 (project spine & integrations). Joe McCreesh has approved
the roadmap. Consumers (Manpower Board, PC tool) are SEPARATE later tasks — this task
only makes the calendar write events.*

## Context — what already exists (verified against v2 code 2026-07-09)

The v2 data model already implements the platform's award design end-to-end:
- `Project` / `Bid` / `Job` / `ChangeOrder` are separate entities (`v2/models.js`,
  per `docs/DATA_MODEL_SPEC.md`).
- `awardSubmission()` (`v2/db.js` ~917) awards the bid AND creates the `Job` with
  `job_number: null` — Accounting assigns it later via `updateJob()` (~1088). Legacy
  jobs enter via `createLegacyJob()` (~1070). This IS the two-step award flow.

What's missing is telling the rest of the platform when these things happen. That's
this task: an `events` collection in the shared `liberty-core` DB that the calendar
appends to on every significant transition. Consumers poll it later; the calendar
never reads it back (except the backfill script).

## 1. The events collection

New module `v2/events.js`. Connection: same pattern as `v2/models.js` —
`mongoose.createConnection(process.env.MONGODB_URI, { dbName: 'liberty-core' })`
(liberty-core already exists; the hub's `users` collection lives there).

Event document:

```js
{
  _id: ObjectId,
  at:        { type: Date, default: Date.now },
  type:      String,            // see catalog below
  source:    'estimating',
  actor_id:  Number|null,       // TeamMember id (from req.session.userId), null for scripts
  project_id, bid_id, job_id, co_id, submission_id: Number|null,  // whichever apply
  job_number: String|null,      // denormalized when known — consumers key on it
  payload:   Object,            // type-specific, denormalized enough to display (see catalog)
  processed: {}                 // consumers stamp processed.<app> = Date; calendar NEVER writes this
}
```

Indexes (create on startup): `{ at: 1 }`, `{ type: 1, at: 1 }`, `{ project_id: 1 }`, `{ job_id: 1 }`.

### Emission contract — CRITICAL

`emit(type, fields)` must NEVER break the user's action. Call it AFTER the primary DB
writes succeed, wrapped so any failure (liberty-core down, validation bug) is caught,
logged loudly (`console.error('[events] EMIT FAILED', type, JSON.stringify(fields), err)`)
— the log line must contain the full event so it can be replayed by hand — and then
swallowed. A helper like `safeEmit()` used everywhere. No retries, no queues in v1;
the backfill script (§4) is the recovery mechanism for anything missed.

## 2. Event catalog + hook points

| type | emit from (v2/db.js) | payload |
|---|---|---|
| `project.created` | `createOpportunity` (new-project path), `createDirectBid` (ditto), `createLegacyJob` (ditto) | `{ name }` |
| `bid.created` | `createOpportunity`, `createDirectBid` | `{ project_name, stage, estimator_id, salesperson_id, due_date }` |
| `bid.stage_changed` | `startBid` (→active_bid), `submitBid` (→submitted), `closeBid` (→closed), and the point in `notAwardSubmission` where ALL submissions are lost and the bid flips to not_awarded | `{ from, to, project_name }` |
| `bid.awarded` | `awardSubmission`, after the Job is created | `{ project_name, company_id, company_name, amount, award_date, pm_id, pm_name }` + `job_id` set |
| `job.created` | `awardSubmission` AND `createLegacyJob` (so legacy jobs flow to consumers too) | `{ project_name, company_name, award_date, pm_id, from_bid: true/false }` |
| `job.number_assigned` | `updateJob`, only when `job_number` goes null→value | `{ project_name, job_number }` (also top-level `job_number`) |
| `job.number_changed` | `updateJob`, when an existing number is edited | `{ previous, job_number, project_name }` |
| `job.pm_assigned` | `updateJob`, when `pm_id` changes | `{ pm_id, pm_name, project_name, job_number }` |
| `co.created` | `createChangeOrder` | `{ co_number, name, project_name, job_number }` |
| `co.stage_changed` | each CO transition function (locate them: grep `submitted_co`, `approved`, `not_approved`, `voided` in v2/db.js) | `{ co_number, from, to, amount, project_name, job_number }` |

Payload names/amounts are denormalized copies at event time — consumers display them
without joining back into the calendar's DB. Look up `pm_name`/`company_name` at emit
time (cheap — the functions mostly have them loaded already).

`actor_id`: thread it from the route layer (`req.session.userId`) into these db
functions the same way `created_by` already flows. Where a function doesn't receive
an actor today, add an optional last param — do not restructure signatures.

## 3. Job-number validation (small but important — see PLATFORM_ROADMAP.md §5.3)

In `updateJob` and `createLegacyJob`, when a non-null `job_number` is being set:
- Must match `^\d{5,6}$` (digits only, 5–6 chars — Foundation format; customer number
  + 3-digit sequence). Reject otherwise with:
  `"Job numbers are 5-6 digits, no dashes (e.g. 18002). This must match Foundation."`
- Must be unique across Jobs (query for another job with the same number, excluding
  this one). Reject duplicates with a message naming the conflicting project.
- Clearing to null stays allowed. Existing stored numbers are NOT retro-validated.
- Surface the error in the v2 UI wherever job numbers are entered (the existing error
  display pattern for transition modals should already handle a thrown message —
  verify it renders, don't build new UI).

## 4. Backfill script — `v2/backfill-events.js`

Purpose: (a) bootstrap consumers with history from before this deploy, (b) recovery
tool if emission ever fails.

- Scans current v2 data and ensures each derivable fact has its event:
  every Job → `job.created` (+ `bid.awarded` if `winning_bid_id`), every Job with a
  number → `job.number_assigned`, every CO → `co.created` (+ terminal
  `co.stage_changed` if approved/not_approved/voided). Bid-stage history isn't
  reconstructible — skip historical `bid.stage_changed` except the terminal state of
  non-open bids.
- **Idempotent by natural key**: before inserting, check for an existing event of the
  same `type` + entity id (`job_id`/`co_id`/`bid_id`). Never duplicate. Backfilled
  events get `payload.backfilled: true` and `actor_id: null`.
- `--dry` prints what would be inserted (count by type + sample); default requires
  `--write` to touch the DB.
- Run once (`--dry`, review, `--write`) right after this deploys.

## 5. Spec-sync + docs

Per repo convention: add a short "Events emitted to liberty-core" section to
`docs/DATA_MODEL_SPEC.md` listing the catalog table above (the spec is the single
source of truth and this is a data-model-adjacent change).

## Out of scope (later tasks — do not build)

- Consumers: Manpower Board auto-creating jobs, PC tool timeline (separate specs).
- Any UI showing events inside the calendar.
- Events for follow-ups, reminders, contacts (add types later if consumers want them).

## Testing checklist

- [ ] Create opportunity → `project.created` (if new project) + `bid.created` in
      `liberty-core.events` with correct ids/payload.
- [ ] Walk a bid through start → submit → award: `bid.stage_changed` ×2, then
      `bid.awarded` + `job.created` (same `job_id`), all with `actor_id` set.
- [ ] Assign the job number → `job.number_assigned`; edit it → `job.number_changed`
      with `previous`.
- [ ] Job number `18-002` / `1234` / `1234567` all rejected with the friendly message;
      `18002` accepted; duplicate of an existing number rejected.
- [ ] Create + approve a CO → `co.created`, `co.stage_changed`.
- [ ] Emission failure is non-fatal: temporarily point the events connection at a bad
      dbName/URI in dev → user actions still succeed, EMIT FAILED lines logged with
      full payload.
- [ ] `backfill-events.js --dry` counts match expectations; `--write` twice inserts
      zero duplicates.
- [ ] Legacy job creation emits `job.created` (with `from_bid: false`) and validates
      its job number.
