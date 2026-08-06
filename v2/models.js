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
  source_key: { type: String, default: null },   // stable import key: "job:<#>" or "name:<norm>" — survives re-import
  street:     { type: String, default: null },   // job site address — from the JIS title sheet
  city:       { type: String, default: null },
  state:      { type: String, default: null },
  zip:        { type: String, default: null },
  created_by: { type: Number, default: null },
  created_at: { type: String, default: ts },
  updated_at: { type: String, default: ts },
}, opts);

const BID_STAGES = ['opportunity', 'active_bid', 'submitted', 'awarded', 'not_awarded', 'closed'];

const BidSchema = new mongoose.Schema({
  _id:            Number,
  project_id:     { type: Number, required: true },              // FK → Project
  bid_number:     { type: String, default: null },               // B26-XXXX — assigned at active_bid only
  stage:          { type: String, enum: BID_STAGES, required: true, default: 'opportunity' },

  estimator_id:   { type: Number, default: null },               // FK → TeamMember
  salesperson_id: { type: Number, default: null },               // FK → TeamMember
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
  certified_payroll: { type: Boolean, default: false },           // on award, notifies everyone the Hub directory has tagged with the 'accounting' role
  tax_exempt:        { type: Boolean, default: false },           // on award, notifies everyone the Hub directory has tagged with the 'purchasing' role
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
  award_date:         { type: String, default: null },
  created_at: { type: String, default: ts },
  updated_at: { type: String, default: ts },
}, opts);

const CO_STAGES = ['active_co', 'submitted_co', 'approved', 'not_approved', 'voided'];

const ChangeOrderSchema = new mongoose.Schema({
  _id:            Number,
  job_id:         { type: Number, required: true },              // FK → Job — a CO cannot exist without a Job
  co_number:      { type: String, required: true },              // RFC-001 / COR-12 / CO-7
  name:           { type: String, required: true },              // description of the work
  stage:          { type: String, enum: CO_STAGES, required: true, default: 'active_co' },
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
  parent_type:      { type: String, enum: ['bid', 'bid_submission', 'change_order'], required: true },
  parent_id:        { type: Number, required: true },
  followup_date:    { type: String, required: true },
  contacted_by:     { type: Number, default: null },             // FK → TeamMember
  contact_method:   { type: String, enum: ['phone', 'email', 'in_person', 'other'], default: 'phone' },
  customer_contact: { type: String, default: null },             // who they spoke to
  notes:            { type: String, default: null },
  outcome:          { type: String, enum: ['no_decision', 'awarded', 'not_awarded', 'approved', 'not_approved', 'other'], default: 'no_decision' },
  next_followup_date: { type: String, default: null },
  created_at: { type: String, default: ts },
  updated_at: { type: String, default: null },   // set only when edited after logging (updateFollowup) — stays null on entries never corrected
}, opts);

const ReminderSchema = new mongoose.Schema({
  _id:         Number,
  parent_type: { type: String, enum: ['bid', 'job', 'change_order'], required: true },
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
}, opts);

// TeamMember is v1's ACTUAL model (not a v2-isolated copy). v1 and v2 used to
// have independently-assigned TeamMember ids in two separate databases —
// merged in July 2026 (v2/merge-team-ids.js) after that silently broke
// "mine only" filtering and reminder-email recipients. v1's login/roster
// page is now the single source of truth; v2's Settings/Team page reads
// and writes it directly (see v2/routes.js).
const V1TeamMember = require('../models/TeamMember');

const SettingsSchema = new mongoose.Schema({
  _id: String,                                                   // 'company'
  fu_initial_days:   { type: Number, default: 3 },
  fu_recurring_days: { type: Number, default: 7 },
}, opts);

const CounterSchema = new mongoose.Schema({
  _id: String,
  seq: { type: Number, default: 0 },
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
    Settings:    c.model('Settings', SettingsSchema, 'settings'),
    Counter:     c.model('Counter', CounterSchema, 'counters'),
    IgnoredPair: c.model('IgnoredPair', IgnoredPairSchema, 'ignored_pairs'),
    CleanupOverride: c.model('CleanupOverride', CleanupOverrideSchema, 'cleanup_overrides'),
    ActivityLog: c.model('ActivityLog', ActivityLogSchema, 'activity_log'),
  };
}

module.exports = { getConnection, getModels, V2_DB_NAME, BID_STAGES, CO_STAGES, BID_SUBMISSION_TYPES };
