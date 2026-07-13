# Liberty Platform — Cross-App Context (READ BEFORE CHANGING SHARED CONTRACTS)

*This file is committed into every Liberty app repo (`docs/PLATFORM_CONTEXT.md`). It
describes the contracts BETWEEN the apps. If a change you're making touches anything
in here, it can break the OTHER apps — coordinate via Joe Monchek and update this file
in ALL repos in the same round. Canonical copy + full roadmap live in Joe's
"CC Estimating Calendar" folder (`PLATFORM_ROADMAP.md`).*

*Last synced: 2026-07-13.*

## The apps

| App | Repo | Runs | Role |
|---|---|---|---|
| Estimating Calendar | `jmonchek11/cc-estimating-calendar` (code in `app/`) | Render | **System of record** for Projects/Bids/Jobs/Change Orders (its v2 DB). Emits all `estimating` events. |
| Manpower Board | `jmonchek11/manpower-board` | Render | Crew scheduling. Consumes job events (auto-creates board jobs); will emit `manpower` events (crew/hours). |
| PC Lifecycle Tool | `jmccreeshjr/Liberty-PC-Tool` | Render | 11-phase Master Lifecycle tracker. Consumes ALL events into projects/timeline. Own data in db `pc_tool`. |
| Liberty Hub | `jmonchek11/liberty-hub` | Render | Portal + admin UI for the shared user directory. |

All four share one MongoDB Atlas cluster and one Entra ID app registration
(**"Liberty Internal Apps"**, single-tenant).

## Shared database: `liberty-core`

Contains EXACTLY two collections. Do not add collections here without a platform
decision.

### `users` — the shared directory (managed via the Hub's Team page)

```
{ _id, ms_oid (unique sparse), email (unique), display_name, initials,
  roles: [admin|pc|pm|apm|estimator|lead_estimator|sales_rep|superintendent|foreman|
          accounting|purchasing|warehouse|safety|ops_manager|prefab|engineering|president],
  apps:  [estimating|manpower|pc_tool], active, notes, timestamps }
```

- Hub and PC tool authenticate ONLY against this directory. Calendar and Board still
  have their own legacy user stores (TeamMember / users) — planned to converge later;
  do not delete those stores yet.
- All apps use the same OIDC flow (`@azure/msal-node`, env vars `AZURE_TENANT_ID/
  CLIENT_ID/CLIENT_SECRET`) and stamp `ms_oid` on first match. Never store passwords
  for SSO users; never commit the Azure secret.

### `events` — the outbox connecting the apps

```
{ _id, at: Date, type, source: 'estimating'|'manpower'|'pc_tool',
  actor_id, project_id, bid_id, job_id, co_id, submission_id,   // calendar ids (Numbers)
  job_number: String|null,
  payload: { ...denormalized display data },
  processed: { <consumer>: Date, <consumer>_error?: String } }
```

**Rules (the ones that break other apps if violated):**

1. **Event types and payload fields are append-only.** Never rename/remove a type or
   payload field — consumers depend on them. Adding new types/fields is always safe.
2. **Emitters never write `processed.*`.** Consumers stamp only their own key
   (`processed.manpower`, `processed.pc_tool`).
3. **Emission must never break the user action** — emit after primary writes, in
   try/catch, log `EMIT FAILED` with full payload, swallow.
4. **Consumers must be idempotent** (safe to reprocess), handle poison events by
   stamping an error and continuing, and never write back to another app's data.
5. `job_id`/`project_id` etc. are ALWAYS the calendar's integer ids, regardless of
   source app — they're the cross-app join keys.

**Current event catalog** (emitted by the calendar — see its
`docs/EVENTS_OUTBOX_PLAN.md` for payloads): `project.created`, `bid.created`,
`bid.stage_changed`, `bid.awarded`, `job.created`, `job.number_assigned`,
`job.number_changed`, `job.pm_assigned`, `co.created`, `co.stage_changed`.
Board-emitted types (in progress): `crew.assigned`, `manpower.hours_week`,
`manpower.job_completed`.

**Current consumers:** Manpower Board (job.* types; first-run cursor in
`userData._eventsConsumer.since` — ignores events before it; links board jobs via
`sourceJobId` = calendar job id). PC tool (ALL types, full history, links via
`estimating_project_id`/`estimating_job_id`; auto-advances phases 1–4 only, forward
only; phases 6–11 are human-gated — never auto-advance them).

## Other cross-app invariants

- **Job numbers**: assigned by Accounting ONLY, entered in the Estimating Calendar,
  format `^\d{5,6}$` (digits only — validated in the calendar). The calendar is the
  only app where job_number is editable; everyone else displays it. A Job's number is
  null until Accounting assigns it — handle null everywhere.
- **Bid numbers**: `B{YY}-{NNN}`, live only in the calendar.
- **Lifecycle**: calendar bid stages (`opportunity → active_bid → submitted →
  awarded/not_awarded/closed`) map to PC tool phases 1–5; the PC tool's 11 phases come
  from the "Master Project Lifecycle V1" SOP doc. `lifecycle_status`
  (pipeline/job/lost/archived) is PC-tool-only.
- **Change orders** never get their own job number; they hang off Jobs in the calendar.
- **Design tokens**: dark theme values originate in the calendar/hub CSS custom
  properties; PC tool maps them via Tailwind `@theme`. Keep new UI on tokens, not
  hardcoded hex.
- **Deploys**: every push to `main` auto-deploys on Render. All apps now use
  Mongo-backed sessions, so deploys don't log users out — but deploy risky changes
  after hours anyway.

## When you (an AI session or human) change something

- New event type or payload field → update the catalog here AND in the calendar's
  `EVENTS_OUTBOX_PLAN.md`; copy this file's update to all four repos.
- Touching auth, the directory schema, job-number rules, or consumer semantics →
  stop and confirm with Joe Monchek first; these are platform-wide contracts.
- App-internal changes (UI, app-local data, features that don't read/write
  `liberty-core` or event payloads) → build freely, this file doesn't constrain you.
