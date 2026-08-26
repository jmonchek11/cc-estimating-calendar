/**
 * v2/models.js — Mongoose models for the v2 data model
 *
 * Source of truth: docs/DATA_MODEL_SPEC.md
 * Every datapoint lives in exactly ONE place:
 *   job_number  → Job only
 *   bid_number  → Bid only
 *   co_number   → ChangeOrder only
 *   project name→ Project only
 *   customer    → Company only (referenced by ID everywhere)
 *
 * All models are registered on a dedicated connection so v2 can coexist
 * with the v1 app in the same process if ever needed.
 */
const mongoose = require('mongoose');

const V2_DB_NAME = process.env.V2_DB_NAME || 'estimating_v2_test';

let conn = null;
function getConnection() {
  if (!conn) {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set');
    conn = mongoose.createConnection(process.env.MONGODB_URI, { dbName: V2_DB_NAME });
  }
  return conn;
}

const opts = { _id: false, versionKey: false };
const ts = () => new Date().toISOString().replace('T', ' ').substring(0, 19);

// ── Schemas ───────────────────────────────────────────────────────────────────

const ProjectSchema = new mongoose.Schema({
  _id:        Number,                       // internal only — never shown in UI
  name:       { type: String, required: true },
  description:{ type: String, default: null },   // brief scope-of-work description, captured at opportunity intake
  location:   { type: String, default: null },   // freeform "City, State" or site description — separate from the JIS-sourced street/city/state/zip below
  // Rough sqft bucket captured at opportunity intake — lets LE/Sales gauge
  // bid/no-bid against schedule at a glance without an exact number, which
  // usually isn't known yet this early. One of SIZE_BUCKETS' values, or null.
  size_bucket: { type: String, default: null },
  // One of TYPE_OF_WORK_OPTIONS (see v2/db.js) — captured at opportunity
  // intake alongside size_bucket, same "gauge it at a glance" purpose.
  type_of_work: { type: String, default: null },
  source_key: { type: String, default: null },   // stable import key: "job:<#>" or "name:<norm>" — survives re-import
  street:     { type: String, default: null },   // job site address — from the JIS title sheet
  city:       { type: String, default: null },
  state:      { type: String, default: null },
  zip:        { type: String, default: null },
  // On-Hold (2026-08) — deliberately project-level, not per-bid/per-job:
  // holding a project pauses everything under it (every bid stage, every
  // job) as one unit, distinct from a Lead that's just an early-stage
  // opportunity nobody's touched yet. Turning it on schedules a recurring
  // 60-day check-in Reminder (parent_type 'project') — see
  // setProjectOnHold/dismissReminder in v2/db.js.
  on_hold:    { type: Number, default: 0 },
  created_by: { type: Number, default: null },
  created_at: { type: String, default: ts },
  updated_at: { type: String, default: ts },
}, opts);

const BID_STAGES = ['lead', 'opportunity', 'active_bid', 'submitted', 'awarded', 'not_awarded', 'closed'];

const BidSchema = new mongoose.Schema({
  _id:            Number,
  project_id:     { type: Number, required: true },              // FK → Project
  bid_number:     { type: String, default: null },               // B26-XXXX — assigned at active_bid only
  stage:          { type: String, enum: BID_STAGES, required: true, default: 'opportunity' },

  estimator_id:   { type: Number, default: null },               // FK → TeamMember
  salesperson_id: { type: Number, default: null },               // FK → TeamMember
  // Early PM assignment — captured at "Approve to Bid" so it's known before
  // award/job creation rather than only then, closing the gap where jobs
  // routinely land with no PM assigned. Job.pm_id (set at award) defaults
  // to this if the award form doesn't override it — see awardSubmission.
  pm_id:          { type: Number, default: null },               // FK → TeamMember
  // Assistant PM — an additional assignment alongside salesperson_id, not a
  // replacement. Counted in "mine" dashboard filtering same as salesperson_id
  // so an APM sees their assigned bids' follow-ups too. See apmOpts() in v2.html.
  apm_id:         { type: Number, default: null },               // FK → TeamMember
  sub_estimators: { type: [{ estimator_id: Number, scope: String }], default: [] },

  date_received:  { type: String, default: null },
  due_date:       { type: String, default: null },
  due_time:       { type: String, default: null },               // "HH:MM", 24-hour — optional, independent of due_date
  start_date:     { type: String, default: null },
  owner_id:       { type: Number, default: null },               // FK → TeamMember — who added this opportunity, for tracking/follow-up
  source:         { type: String, default: null },                // where it came from (iSqFt, BuildingConnected, referral, email invite location, etc.)
  rfi_due_date:   { type: String, default: null },               // official RFI (Request for Information) cutoff, when a project has one — independent of due_date/stage
  rfi_due_time:   { type: String, default: null },               // "HH:MM", 24-hour — optional
  folder_url:     { type: String, default: null },               // link to THIS bid's own OneDrive folder — a new folder is created per bid (not per project); at award, the team renames it from "bid# - bid name" to "job# - job name" but the link itself stays valid
  // Nullable — null means "not yet known" (TBD), distinct from a real "No".
  // Whoever starts the bid often can't answer this yet, so it defaults to
  // TBD there; submitBid() requires a real answer before the bid can be
  // submitted, same as jurisdiction. On award, notifies everyone the Hub
  // directory has tagged with the 'accounting'/'purchasing' role respectively.
  certified_payroll: { type: Boolean, default: null },
  tax_exempt:        { type: Boolean, default: null },
  // Same TBD/forced-answer pattern as certified_payroll/tax_exempt above —
  // no automatic award notification for this one though, since (unlike
  // accounting/purchasing for those) there's no obvious department owner.
  prevailing_wage:   { type: Boolean, default: null },
  // Sales/LE decision that this opportunity should move forward — still
  // stage 'opportunity' (bid #/dates aren't known yet), but pulled out of
  // the Opportunities list into the Queue list so whoever does bid setup
  // knows what's ready. Distinct from startBid() itself, which is the
  // actual setup step and moves stage to 'active_bid'.
  approved_to_bid:    { type: Boolean, default: false },
  approved_to_bid_at: { type: String, default: null },
  drawing_stage:  { type: String, default: null },               // "50% budget", "80% budget", "100% CD"…
  drawings:       { type: String, default: null },               // drawing SET description, e.g. "Rev 2 dated 5/1/26 prepared by XYZ Architects" — from the JIS title sheet, distinct from drawing_stage
  notes:          { type: String, default: null },

  // Jobsite walk-throughs — a bid can have several (different companies at
  // different times), each independent of due_date/stage. `_id` is a real
  // sequential id (via nextId('walkthroughs')) so one entry can be edited or
  // removed without disturbing its siblings. date/time reset reminder_sent
  // to false when either changes (see updateWalkthrough), so a rescheduled
  // walk-through gets its own fresh 24h-before reminder instead of silently
  // keeping the old one's "already sent" flag.
  walkthroughs: {
    type: [{
      _id:            Number,
      date:           { type: String, default: null },
      time:           { type: String, default: null },    // "HH:MM", 24-hour — reminder only fires when both date AND time are set
      company_id:     { type: Number, default: null },    // FK -> Company — site contact's company, found-or-created same as any other company field
      contact_id:     { type: Number, default: null },    // FK -> Contact
      reminder_sent:  { type: Boolean, default: false },
      // Internal team members assigned to attend, each with their own
      // one-click RSVP (a rsvp_token per person, not per walkthrough, so
      // the "Will Attend" link in one person's email can only ever answer
      // for them — see notifyWalkthroughAssignees()/setWalkthroughRsvp()).
      assignees: {
        type: [{
          _id: false,
          member_id:   { type: Number, required: true },   // FK -> TeamMember
          rsvp:        { type: String, enum: ['pending', 'attending', 'not_attending'], default: 'pending' },
          rsvp_token:  { type: String, required: true },
          responded_at: { type: String, default: null },
        }],
        default: [],
      },
    }],
    default: [],
  },

  // Denormalized "headline" snapshot of the bid's current submission — kept in
  // sync from BidSubmission (most-recent current submission, or the awarded
  // company's submission once awarded). Source of truth is the BidSubmission
  // collection; these exist so list/rollup queries stay simple.
  estimate_amount:{ type: Number, default: null },
  date_submitted: { type: String, default: null },
  approved_by:    { type: String, default: null },

  jurisdiction:   { type: String, default: null },               // IBEW local — project-level, set at first submit

  // Set at AWARD only
  award_date:         { type: String, default: null },
  awarded_company_id: { type: Number, default: null },           // FK → Company (single winner)

  // Set at NOT-AWARDED only
  date_not_awarded:  { type: String, default: null },
  not_awarded_notes: { type: String, default: null },

  // Set at CLOSE only
  closed_date:        { type: String, default: null },
  closed_approved_by: { type: String, default: null },
  close_reason:       { type: String, default: null },

  // System-managed while submitted
  next_followup_date: { type: String, default: null },

  // Set when a newer bid is added to the same project (e.g. a later drawing
  // stage). Superseded bids are inactive/historical — excluded from active
  // counts, no workflow actions, but kept for the record.
  superseded: { type: Number, default: 0 },

  created_at: { type: String, default: ts },
  updated_at: { type: String, default: ts },
}, opts);

const JobSchema = new mongoose.Schema({
  _id:                Number,
  project_id:         { type: Number, required: true },          // FK → Project
  winning_bid_id:     { type: Number, default: null },           // NULLABLE — legacy jobs have no bid
  job_number:         { type: String, default: null },           // NULLABLE until accounting assigns
  awarded_company_id: { type: Number, default: null },           // FK → Company
  pm_id:              { type: Number, default: null },           // FK → TeamMember — gets CO follow-up notifications
  apm_id:             { type: Number, default: null },           // FK → TeamMember — additional assignment, see Bid.apm_id
  award_date:         { type: String, default: null },
  // Snapshotted from the winning bid's folder_url at award time (same real
  // folder, just renamed) but stored independently so it can be corrected
  // later without touching the bid, and so a legacy job (no bid at all) can
  // have one too — same field, same editing UI as Bid.folder_url.
  folder_url:         { type: String, default: null },
  created_at: { type: String, default: ts },
  updated_at: { type: String, default: ts },
}, opts);

// 'co_request' is a real, separate stage (unlike Bid's 'opportunity' +
// approved_to_bid flag) since it's the very first stage a CO can be in —
// there's no equivalent to Bid's 'lead' stage before it to reuse the same
// pattern from. approved_to_co plays the same role approved_to_bid does:
// the request sits in the same stage while it moves from "just requested"
// to "approved, queued for setup," only leaving 'co_request' entirely once
// Start fills in the rest and promotes it to 'active_co'.
const CO_STAGES = ['co_request', 'active_co', 'submitted_co', 'approved', 'not_approved', 'voided'];

const ChangeOrderSchema = new mongoose.Schema({
  _id:            Number,
  job_id:         { type: Number, required: true },              // FK → Job — a CO cannot exist without a Job
  co_number:      { type: String, required: true },              // RFC-001 / COR-12 / CO-7
  name:           { type: String, required: true },              // description of the work
  stage:          { type: String, enum: CO_STAGES, required: true, default: 'active_co' },
  approved_to_co:    { type: Number, default: 0 },                // set at co_request stage — moves it into the Queue view
  approved_to_co_at: { type: String, default: null },
  was_submitted:  { type: Number, default: 0 },                  // drives Reopen target (submitted_co vs active_co)
  superseded:     { type: Number, default: 0 },                  // 1 = replaced by a revision (same idea as Bid.superseded)

  estimator_id:   { type: Number, default: null },
  due_date:       { type: String, default: null },
  start_date:     { type: String, default: null },
  notes:          { type: String, default: null },

  // Set at SUBMIT only
  estimate_amount:{ type: Number, default: null },
  date_submitted: { type: String, default: null },
  approved_by:    { type: String, default: null },               // PM, estimator, or salesperson

  // Set at APPROVE only
  approval_date:  { type: String, default: null },

  // Void / not-approved bookkeeping
  void_reason:        { type: String, default: null },
  date_not_approved:  { type: String, default: null },
  not_approved_notes: { type: String, default: null },

  next_followup_date: { type: String, default: null },

  created_at: { type: String, default: ts },
  updated_at: { type: String, default: ts },
}, opts);

const CompanySchema = new mongoose.Schema({
  _id:        Number,
  name:       { type: String, required: true },                  // single source for customer names
  // Who this company IS on a job (Owner, GC, Mechanical Contractor, etc.) —
  // see COMPANY_TYPE_OPTIONS in v2/db.js for the fixed list. Optional/null
  // for companies never classified (most vendors, older records).
  type:       { type: String, default: null },
  street:     { type: String, default: null },
  city:       { type: String, default: null },
  state:      { type: String, default: null },
  zip:        { type: String, default: null },
  phone:      { type: String, default: null },
  domain:     { type: String, default: null },                   // company URL
  created_at: { type: String, default: ts },
  updated_at: { type: String, default: ts },
}, opts);

const BidCustomerSchema = new mongoose.Schema({
  _id:         Number,
  bid_id:      { type: Number, required: true },                 // FK → Bid
  company_id:  { type: Number, required: true },                 // FK → Company
  contact_ids: { type: [Number], default: [] },                  // FK → Contact (at this company, for this bid)
}, opts);

// One row per submission EVENT: a number we sent to a specific customer.
// A bid has many — one per customer, plus best-and-final / scope-change
// re-submissions to the same customer (no new drawings). Replaces the old
// per-bid submission fields + revisions[] array.
const BID_SUBMISSION_TYPES = ['initial', 'best_and_final', 'scope_add', 'scope_remove', 'revised'];
const BidSubmissionSchema = new mongoose.Schema({
  _id:             Number,
  bid_id:          { type: Number, required: true },             // FK → Bid
  company_id:      { type: Number, required: true },             // FK → Company (who we submitted to)
  amount:          { type: Number, default: null },
  date_submitted:  { type: String, default: null },
  approved_by:     { type: String, default: null },
  submission_type: { type: String, enum: BID_SUBMISSION_TYPES, default: 'initial' },
  notes:           { type: String, default: null },
  is_current:      { type: Number, default: 1 },                 // latest submission to this customer

  // Per-submission win/loss + follow-up (each customer is tracked independently)
  outcome:            { type: String, enum: ['pending', 'awarded', 'not_awarded'], default: 'pending' },
  award_date:         { type: String, default: null },
  date_not_awarded:   { type: String, default: null },
  not_awarded_notes:  { type: String, default: null },
  // Independent of our own outcome — did the GC/customer itself actually
  // win the job from the owner at all? A 'not_awarded' outcome alone
  // conflates two very different situations: the GC won and picked someone
  // else (worth knowing — are we losing to them repeatedly?) vs. the GC
  // never won the job in the first place (not a reflection on us). null =
  // not yet known (the normal case right after marking not_awarded).
  gc_awarded:         { type: Boolean, default: null },
  next_followup_date: { type: String, default: null },

  created_at:      { type: String, default: ts },
  updated_at:      { type: String, default: ts },
}, opts);

const ContactSchema = new mongoose.Schema({
  _id:        Number,
  company_id: { type: Number, default: null },                   // FK → Company (no free-text company) — nullable: some real contacts have no known employer
  first_name: { type: String, default: null },
  last_name:  { type: String, default: null },
  phone:      { type: String, default: null },
  email:      { type: String, default: null },
  title:      { type: String, default: null },   // e.g. "Project Manager", "Purchasing" — which part of the project they're connected to
  notes:      { type: String, default: null },
  // Vendor directory (2026-07) — a contact can ALSO be a vendor rep, e.g. a
  // Graybar contact reps Gear for one project and Lighting for another.
  // Lives on the contact (not the company) because reps at the same company
  // often cover different categories. `brands` is free-text tags (mainly
  // used for Fire Alarm, e.g. "Silent Knight, Notifier") — not an enum,
  // since manufacturer lines vary too much to whitelist.
  vendor_categories: { type: [String], default: [] },
  brands:            { type: [String], default: [] },
  active:     { type: Number, default: 1 },
  created_at: { type: String, default: ts },
  updated_at: { type: String, default: ts },
}, opts);

const FollowupSchema = new mongoose.Schema({
  _id:              Number,
  // 'company' (added 2026-08) is a standalone check-in with no bid/CO behind
  // it at all — parent_id is a Company _id directly. Everything else is
  // unchanged: no next_followup_date rollup target exists for it (there's no
  // bid/CO to carry a timer), so logFollowupV2 skips that step for this type.
  parent_type:      { type: String, enum: ['bid', 'bid_submission', 'change_order', 'company'], required: true },
  parent_id:        { type: Number, required: true },
  followup_date:    { type: String, required: true },
  contacted_by:     { type: Number, default: null },             // FK → TeamMember
  contact_method:   { type: String, enum: ['phone', 'email', 'in_person', 'other'], default: 'phone' },
  // contact_id (added 2026-08) is the real link used by the company/contact
  // communications timeline — customer_contact is kept as a free-text
  // fallback for entries logged before contact_id existed (those show up on
  // a company's timeline but not a specific contact's, since there's no FK
  // to resolve). New entries should always set contact_id.
  contact_id:       { type: Number, default: null },             // FK → Contact
  customer_contact: { type: String, default: null },             // legacy free text — who they spoke to
  notes:            { type: String, default: null },
  outcome:          { type: String, enum: ['no_decision', 'awarded', 'not_awarded', 'approved', 'not_approved', 'other'], default: 'no_decision' },
  next_followup_date: { type: String, default: null },
  created_at: { type: String, default: ts },
  updated_at: { type: String, default: null },   // set only when edited after logging (updateFollowup) — stays null on entries never corrected
}, opts);

const ReminderSchema = new mongoose.Schema({
  _id:         Number,
  parent_type: { type: String, enum: ['bid', 'job', 'change_order', 'project'], required: true },
  parent_id:   { type: Number, required: true },
  note:        { type: String, default: null },
  remind_on:   { type: String, required: true },
  dismissed:   { type: Number, default: 0 },
  emailed:     { type: Number, default: 0 },
  created_by:  { type: Number, default: null },
  created_at:  { type: String, default: ts },
}, opts);

// A dateless, freeform note — distinct from Reminder (which is a "ping me on
// this date" tickler) and from Bid/ChangeOrder's own single `notes` field
// (a static description). This is an append-only log anyone can add to.
const NoteSchema = new mongoose.Schema({
  _id:         Number,
  parent_type: { type: String, enum: ['bid', 'change_order'], required: true },
  parent_id:   { type: Number, required: true },
  text:        { type: String, required: true },
  created_by:  { type: Number, default: null },
  created_at:  { type: String, default: ts },
  edited_at:   { type: String, default: null },
}, opts);

// TeamMember is v1's ACTUAL model (not a v2-isolated copy). v1 and v2 used to
// have independently-assigned TeamMember ids in two separate databases —
// merged in July 2026 (v2/merge-team-ids.js) after that silently broke
// "mine only" filtering and reminder-email recipients. v1's login/roster
// page is now the single source of truth; v2's Settings/Team page reads
// and writes it directly (see v2/routes.js).
const V1TeamMember = require('../models/TeamMember');
// Same pattern as V1TeamMember above — ideas/bugs are v1's collection (the
// Ideas & Issues tray), and a ReleaseNote can optionally credit whoever
// submitted the idea it shipped, so it needs a direct read of that model.
const V1Idea = require('../models/Idea');

const SettingsSchema = new mongoose.Schema({
  _id: String,                                                   // 'company'
  fu_initial_days:   { type: Number, default: 3 },
  fu_recurring_days: { type: Number, default: 7 },
  // Who gets emailed when an opportunity is approved to bid (e.g. Carrie, to
  // kick off setup) — configurable rather than hardcoded since that's a
  // person/role, not something derivable from the data. Null/unset = no email.
  queue_notify_email: { type: String, default: null },
}, opts);

const CounterSchema = new mongoose.Schema({
  _id: String,
  seq: { type: Number, default: 0 },
}, opts);

// One personal webcal subscription URL per team member — the token itself
// IS the lookup key (doubles as the unguessable auth for the public feed
// route, since a calendar app just polls the URL with no session/cookie).
const CalendarTokenSchema = new mongoose.Schema({
  _id: String,
  team_member_id: { type: Number, required: true, index: true },
  created_at: { type: String, default: ts },
}, opts);

// "Not a duplicate" decisions — a pair (a<b) of project or company ids that
// Data Health should never re-cluster as a near-duplicate.
const IgnoredPairSchema = new mongoose.Schema({
  _id:  Number,
  kind: { type: String, enum: ['project', 'company', 'contact'], required: true },
  a:    { type: Number, required: true },
  b:    { type: Number, required: true },
}, opts);

// Cleanup decisions keyed by STABLE identifiers (not record ids) so they
// survive a full re-import. The importer preserves this collection and
// replays it after rebuilding from Excel. Types:
//   company_alias  { from:<normalized name>, to:<canonical name> }
//   project_name   { key:<source_key>, name:<canonical name> }   (rename)
//   project_merge  { keys:[<source_key>...], name:<canonical> }  (one project)
//   project_delete { key:<source_key> }
//   not_dup        { kind:'project'|'company', keys:[<key>,<key>] }
const CleanupOverrideSchema = new mongoose.Schema({
  _id:  Number,
  type: { type: String, required: true },
  from: { type: String, default: null }, to: { type: String, default: null },
  key:  { type: String, default: null }, name: { type: String, default: null },
  keys: { type: [String], default: [] }, kind: { type: String, default: null },
  created_at: { type: String, default: ts },
}, opts);

// Audit trail — who did what, when. `undo` carries whatever this specific
// action type needs to safely reverse itself (only a handful of action
// types set it; most don't, since most actions here aren't safely
// reversible — see UNDOABLE_ACTIONS in db.js).
const ActivityLogSchema = new mongoose.Schema({
  _id:        Number,
  ts:         { type: String, default: ts },
  actor_id:   { type: Number, default: null },
  actor_name: { type: String, default: null },
  action:     { type: String, required: true },              // short machine tag, e.g. 'bid.submit'
  summary:    { type: String, required: true },               // human-readable, e.g. "Submitted bid B26-0123"
  entity_type:{ type: String, default: null },
  entity_id:  { type: Number, default: null },
  undo:       { type: mongoose.Schema.Types.Mixed, default: null },
  undone:     { type: Number, default: 0 },
}, opts);

// "What's New" — a hand-posted running log of shipped features/fixes, shown
// in-app so the team doesn't have to rely on someone remembering to mention
// a change out loud. `idea_id`/`credited_name` are optional: when a note is
// linked to an Ideas & Issues submission, credited_name is a SNAPSHOT of the
// submitter's name taken at post time (not a live join) — it stays correct
// even if the idea is later edited, merged, or the submitter's account
// changes, and doesn't require a cross-database join every time the list
// renders. Not every note has a submitter to credit (most are things Joe
// asked for directly in chat, not through the tray).
const RELEASE_NOTE_CATEGORIES = ['feature', 'improvement', 'fix'];
const ReleaseNoteSchema = new mongoose.Schema({
  _id:            Number,
  title:          { type: String, required: true },
  description:    { type: String, default: null },
  category:       { type: String, enum: RELEASE_NOTE_CATEGORIES, default: 'feature' },
  idea_id:        { type: Number, default: null },   // FK → v1 Idea (optional)
  credited_name:  { type: String, default: null },   // snapshot, not a live join — see above
  created_by:     { type: Number, default: null },   // FK → TeamMember, who posted it
  date:           { type: String, default: null },   // display date (YYYY-MM-DD), defaults to post day
  created_at:     { type: String, default: ts },
}, opts);

// ── Gate 1-4 pilot (docs/GATES_1_4_IMPLEMENTATION_PLAN.md) ───────────────────
// Two append-only records, not mutable checkboxes (plan §4.1): a task
// instance never changes its criterion/role/gate after creation, and a
// task's current status/evidence/notes are derived from its event history,
// never overwritten in place. New Bids only for this pilot — see
// createGateTaskPack in v2/db.js. No liberty-core emission yet (plan §6/§8
// item — deliberately deferred).
const BidGateTaskSchema = new mongoose.Schema({
  _id:               Number,
  bid_id:            { type: Number, required: true, index: true },
  project_id:        { type: Number, required: true },              // denormalized join aid only — Bid remains the ownership boundary
  task_key:          { type: String, required: true },               // stable template key, e.g. 'g3.submission_logged'
  criterion_text:    { type: String, required: true },               // exact SOP checklist text, copied at instantiation — never edited in place
  plain_text:        { type: String, default: null },                // plain-English version for the PC-facing UI
  sop_document_number: { type: String, required: true },             // 'LIS-OPS-001'
  sop_version:       { type: String, required: true },               // explicit draft identifier — never blank
  template_version:  { type: String, required: true },               // v2/gateTaskTemplate.js TEMPLATE_VERSION at creation time
  gate:              { type: Number, required: true },               // 1-4
  phase:             { type: String, required: true },               // gate name, e.g. 'Bid Preparation and Setup'
  evidence_class:    { type: String, enum: ['automatic_evidence', 'manual_attestation', 'gate_verification'], required: true },
  responsible_role:  { type: String, required: true },                // free text (plan wording) — TeamMember.role doesn't model these roles yet
  pilot_exception:   { type: String, default: null },                 // set only on the one task carrying a documented pilot exception (Gate 4)
  assignee_id:       { type: Number, default: null },
  assignee_snapshot: { type: String, default: null },
  created_at:        { type: String, default: ts },
  created_by:        { type: Number, default: null },
  origin:            { type: String, enum: ['new_bid', 'existing_record_adoption'], default: 'new_bid' },
}, opts);

const BidGateTaskEventSchema = new mongoose.Schema({
  _id:             Number,
  task_id:         { type: Number, required: true, index: true },
  bid_id:          { type: Number, required: true, index: true },
  at:              { type: String, default: ts },
  actor_id:        { type: Number, default: null },
  actor_snapshot:  { type: String, default: null },                  // display name at event time — survives a later name change
  event_type:      { type: String, required: true },                 // 'task_created' | 'automatic_evidence_recorded' | 'manual_update' | 'verified' | 'returned'
  status:          { type: String, required: true, enum: [
                       'not_started', 'evidence_recorded', 'attested', 'verification_requested',
                       'verified', 'returned', 'on_hold', 'needs_information',
                       'exception_requested', 'exception_approved', 'exception_rejected', 'superseded_by_template',
                     ] },
  note:            { type: String, default: null },                  // short free-text note (this pilot's "add a short note" action)
  evidence:        { type: [{
                       type: { type: String, enum: ['calendar_field', 'calendar_action', 'outbox_event', 'project_hq', 'onedrive', 'accubid', 'cm_platform', 'email', 'document', 'other'] },
                       label: String, ref: String, captured_at: String,
                     }], default: [] },
  attestation_text: { type: String, default: null },
  verifier_id:      { type: Number, default: null },
  verified_at:      { type: String, default: null },
  verification_decision: { type: String, default: null },
  verification_notes:    { type: String, default: null },
  exception:       { type: mongoose.Schema.Types.Mixed, default: null },
  related_calendar_event_id: { type: mongoose.Schema.Types.Mixed, default: null },
}, opts);

// ── Export models bound to the v2 connection ──────────────────────────────────

function getModels() {
  const c = getConnection();
  return {
    Project:     c.model('Project', ProjectSchema, 'projects'),
    Bid:         c.model('Bid', BidSchema, 'bids'),
    Job:         c.model('Job', JobSchema, 'jobs'),
    ChangeOrder: c.model('ChangeOrder', ChangeOrderSchema, 'change_orders'),
    Company:       c.model('Company', CompanySchema, 'companies'),
    BidCustomer:   c.model('BidCustomer', BidCustomerSchema, 'bid_customers'),
    BidSubmission: c.model('BidSubmission', BidSubmissionSchema, 'bid_submissions'),
    Contact:     c.model('Contact', ContactSchema, 'contacts'),
    Followup:    c.model('Followup', FollowupSchema, 'followups'),
    Reminder:    c.model('Reminder', ReminderSchema, 'reminders'),
    Note:        c.model('Note', NoteSchema, 'notes'),
    TeamMember:  V1TeamMember,
    Idea:        V1Idea,
    ReleaseNote: c.model('ReleaseNote', ReleaseNoteSchema, 'release_notes'),
    BidGateTask: c.model('BidGateTask', BidGateTaskSchema, 'bid_gate_tasks'),
    BidGateTaskEvent: c.model('BidGateTaskEvent', BidGateTaskEventSchema, 'bid_gate_task_events'),
    Settings:    c.model('Settings', SettingsSchema, 'settings'),
    Counter:     c.model('Counter', CounterSchema, 'counters'),
    IgnoredPair: c.model('IgnoredPair', IgnoredPairSchema, 'ignored_pairs'),
    CleanupOverride: c.model('CleanupOverride', CleanupOverrideSchema, 'cleanup_overrides'),
    ActivityLog: c.model('ActivityLog', ActivityLogSchema, 'activity_log'),
    CalendarToken: c.model('CalendarToken', CalendarTokenSchema, 'calendar_tokens'),
  };
}

module.exports = { getConnection, getModels, V2_DB_NAME, BID_STAGES, CO_STAGES, BID_SUBMISSION_TYPES, RELEASE_NOTE_CATEGORIES };
