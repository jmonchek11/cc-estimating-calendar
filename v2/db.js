/**
 * v2/db.js — v2 data layer (reads the estimating_v2_test database)
 *
 * First slice: project list + full project hierarchy
 * (Project → Bids → Job → Change Orders, per DATA_MODEL_SPEC.md)
 *
 * Joins are done in JS over .lean() queries — fine for the test dataset;
 * swap to aggregations if/when production volume needs it.
 */
const bcrypt = require('bcrypt');
const { getModels } = require('./models');
const events = require('./events');

const BID_ACTIVE_STAGES = ['opportunity', 'active_bid', 'submitted'];
const CO_ACTIVE_STAGES  = ['active_co', 'submitted_co'];

async function nextId(name) {
  const { Counter } = getModels();
  const doc = await Counter.findByIdAndUpdate(name, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return doc.seq;
}

// ═══════════════════════════════════════════════════════════════════════════
// AUDIT TRAIL — who did what, when. Logging must never break the action it's
// logging, so every call site wraps it in try/catch and swallows failures.
// Only a small, explicitly-safe set of action types carry an `undo` payload
// (see UNDOABLE_ACTIONS below) — most actions here (stage transitions,
// merges, deletes) aren't safely reversible in general, so their log rows
// just record what happened rather than offering a one-click undo.
// ═══════════════════════════════════════════════════════════════════════════
// Human-readable label for a bid/CO — "B26-0218 FRB - Additional PM" instead
// of a raw id, so History reads the way an estimator actually thinks about
// a bid rather than an internal database key.
async function bidLabel(id) {
  const M = getModels();
  const b = await M.Bid.findById(Number(id)).lean();
  if (!b) return `bid #${id}`;
  return [b.bid_number, b.project_name].filter(Boolean).join(' ') || `bid #${id}`;
}
async function coLabel(id) {
  const M = getModels();
  const c = await M.ChangeOrder.findById(Number(id)).lean();
  if (!c) return `CO #${id}`;
  return [c.co_number, c.name].filter(Boolean).join(' — ') || `CO #${id}`;
}
async function logActivity({ actor_id, actor_name, action, summary, entity_type, entity_id, undo }) {
  try {
    const M = getModels();
    await M.ActivityLog.create({
      _id: await nextId('activity_log'), actor_id: actor_id || null, actor_name: actor_name || 'Unknown',
      action, summary, entity_type: entity_type || null, entity_id: entity_id || null, undo: undo || null,
    });
  } catch (e) { console.error('logActivity failed (non-fatal):', e.message); }
}

async function getActivityLog({ limit } = {}) {
  const M = getModels();
  const rows = await M.ActivityLog.find().sort({ _id: -1 }).limit(Math.min(Number(limit) || 200, 500)).lean();
  return rows.map(r => ({
    id: r._id, ts: r.ts, actor_name: r.actor_name, action: r.action, summary: r.summary,
    entity_type: r.entity_type, entity_id: r.entity_id, undone: !!r.undone,
    undoable: !r.undone && !!r.undo && !!UNDOABLE_ACTIONS[r.action],
  }));
}

// Whitelist of action tags that are safe to auto-reverse, and how to do it.
// Each handler receives the log row's `undo` payload and performs the
// inverse operation.
const UNDOABLE_ACTIONS = {
  'bid.due_date_change': async (u) => updateBidDueDate(u.bid_id, u.due_date_before),
  'co.due_date_change': async (u) => updateCoDueDate(u.co_id, u.due_date_before),
  'bid.sub_estimator_add': async (u) => removeSubEstimator(u.bid_id, u.estimator_id, u.scope),
  'bid.sub_estimator_remove': async (u) => addSubEstimator(u.bid_id, { estimator_id: u.estimator_id, scope: u.scope }),
  'reminder.dismiss': async (u) => { const M = getModels(); await M.Reminder.updateOne({ _id: u.reminder_id }, { $set: { dismissed: 0 } }); },
};

async function undoActivity(logId) {
  const M = getModels();
  const row = await M.ActivityLog.findById(Number(logId)).lean();
  if (!row) throw new Error('Log entry not found');
  if (row.undone) throw new Error('Already undone');
  const handler = row.undo ? UNDOABLE_ACTIONS[row.action] : null;
  if (!handler) throw new Error("This action can't be auto-undone — reverse it manually if needed.");
  await handler(row.undo);
  await M.ActivityLog.updateOne({ _id: row._id }, { $set: { undone: 1 } });
  return { ok: true };
}

function teamMap(members) {
  const m = {};
  members.forEach(t => { m[t._id] = { id: t._id, name: t.name, initials: t.initials, role: t.role }; });
  return m;
}

// ── Projects list with hierarchy rollups ──────────────────────────────────────
// Flat job list for the New Change Order picker — a CO always attaches to an
// existing job, and the coordinator entering it usually only has whatever
// name/job # the PM used in their request, not the exact Project name shown
// in the app. Returning every job (project + job # together) lets the
// frontend fuzzy-match on either field in one search box instead of forcing
// a "pick the exact project first" step.
async function getJobsPicker() {
  const M = getModels();
  const [jobs, projects] = await Promise.all([M.Job.find().lean(), M.Project.find().lean()]);
  const pName = {}; projects.forEach(p => pName[p._id] = p.name);
  return jobs.map(j => ({ id: j._id, project_id: j.project_id, project_name: pName[j.project_id] || '?', job_number: j.job_number || null }))
    .sort((a, b) => a.project_name.localeCompare(b.project_name));
}

async function getProjects() {
  const M = getModels();
  const [projects, bids, jobs, cos, bidCustomers, companies] = await Promise.all([
    M.Project.find().lean(),
    M.Bid.find().lean(),
    M.Job.find().lean(),
    M.ChangeOrder.find().lean(),
    M.BidCustomer.find().lean(),
    M.Company.find().lean(),
  ]);

  const companyById = {}; companies.forEach(c => { companyById[c._id] = c.name; });
  const customersByBid = {};
  bidCustomers.forEach(bc => {
    (customersByBid[bc.bid_id] = customersByBid[bc.bid_id] || []).push(companyById[bc.company_id]);
  });
  const cosByJob = {};
  cos.forEach(co => { (cosByJob[co.job_id] = cosByJob[co.job_id] || []).push(co); });

  return projects.map(p => {
    const pBids = bids.filter(b => b.project_id === p._id);
    const pJobs = jobs.filter(j => j.project_id === p._id);
    const pCos  = pJobs.flatMap(j => cosByJob[j._id] || []);
    const activeBids = pBids.filter(b => BID_ACTIVE_STAGES.includes(b.stage) && !b.superseded);
    const activeCos  = pCos.filter(c => CO_ACTIVE_STAGES.includes(c.stage) && !c.superseded);
    const awarded    = pBids.find(b => b.stage === 'awarded');

    return {
      id: p._id,
      name: p.name,
      bid_count: pBids.length,
      job_count: pJobs.length,
      co_count: pCos.length,
      active_count: activeBids.length + activeCos.length,
      has_awarded: !!awarded || pJobs.length > 0,
      is_legacy: pJobs.some(j => !j.winning_bid_id),
      job_numbers: pJobs.map(j => j.job_number).filter(Boolean),
      job_number_pending: pJobs.some(j => !j.job_number),
      pipeline_value: activeBids.reduce((s, b) => s + (b.estimate_amount || 0), 0)
                    + activeCos.reduce((s, c) => s + (c.estimate_amount || 0), 0),
      won_value: pBids.filter(b => b.stage === 'awarded').reduce((s, b) => s + (b.estimate_amount || 0), 0)
               + pCos.filter(c => c.stage === 'approved').reduce((s, c) => s + (c.estimate_amount || 0), 0),
      customers: [...new Set(pBids.flatMap(b => customersByBid[b._id] || []))],
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

// ── Full hierarchy for one project ────────────────────────────────────────────
async function getProjectDetail(projectId) {
  const M = getModels();
  const pid = Number(projectId);
  const project = await M.Project.findById(pid).lean();
  if (!project) return null;

  const [bids, jobs, members, companies] = await Promise.all([
    M.Bid.find({ project_id: pid }).lean(),
    M.Job.find({ project_id: pid }).lean(),
    M.TeamMember.find().lean(),
    M.Company.find().lean(),
  ]);
  const bidIds = bids.map(b => b._id);
  const jobIds = jobs.map(j => j._id);
  const [cos, bidCustomers, submissions] = await Promise.all([
    M.ChangeOrder.find({ job_id: { $in: jobIds } }).lean(),
    M.BidCustomer.find({ bid_id: { $in: bidIds } }).lean(),
    M.BidSubmission.find({ bid_id: { $in: bidIds } }).sort({ date_submitted: 1, _id: 1 }).lean(),
  ]);
  const allContactIds = [...new Set(bidCustomers.flatMap(bc => bc.contact_ids || []))];
  const contacts = allContactIds.length ? await M.Contact.find({ _id: { $in: allContactIds } }).lean() : [];
  const contactById = {}; contacts.forEach(c => { contactById[c._id] = fmtContactBrief(c); });
  const allReminders = await M.Reminder.find({
    $or: [{ parent_type: 'bid', parent_id: { $in: bidIds } }, { parent_type: 'change_order', parent_id: { $in: cos.map(c => c._id) } }],
  }).sort({ remind_on: 1 }).lean();
  const remindersFor = (type, id) => allReminders.filter(r => r.parent_type === type && r.parent_id === id);
  const allNotes = await M.Note.find({
    $or: [{ parent_type: 'bid', parent_id: { $in: bidIds } }, { parent_type: 'change_order', parent_id: { $in: cos.map(c => c._id) } }],
  }).sort({ created_at: -1 }).lean();
  const notesFor = (type, id) => allNotes.filter(n => n.parent_type === type && n.parent_id === id)
    .map(n => ({ id: n._id, text: n.text, created_at: n.created_at, author: tm[n.created_by] || null }));
  const allFollowups = await M.Followup.find({
    $or: [
      { parent_type: 'bid', parent_id: { $in: bidIds } },
      { parent_type: 'bid_submission', parent_id: { $in: submissions.map(s => s._id) } },
      { parent_type: 'change_order', parent_id: { $in: cos.map(c => c._id) } },
    ],
  }).lean();
  const bidFollowups = allFollowups.filter(f => f.parent_type === 'bid');
  const subFollowups = allFollowups.filter(f => f.parent_type === 'bid_submission');
  const coFollowups  = allFollowups.filter(f => f.parent_type === 'change_order');

  const tm = teamMap(members);
  const companyById = {}; companies.forEach(c => { companyById[c._id] = { id: c._id, name: c.name }; });

  const fmtBid = (b) => ({
    id: b._id,
    bid_number: b.bid_number,
    stage: b.stage,
    superseded: !!b.superseded,
    drawing_stage: b.drawing_stage,
    estimator: tm[b.estimator_id] || null,
    salesperson: tm[b.salesperson_id] || null,
    sub_estimators: (b.sub_estimators || []).map(s => ({ ...(tm[s.estimator_id] || {}), scope: s.scope })),
    customers: bidCustomers.filter(bc => bc.bid_id === b._id).map(bc => {
      const co = companyById[bc.company_id]; if (!co) return null;
      return { ...co, bid_customer_id: bc._id, contacts: (bc.contact_ids || []).map(id => contactById[id]).filter(Boolean) };
    }).filter(Boolean),
    start_date: b.start_date,
    date_received: b.date_received,
    due_date: b.due_date,
    estimate_amount: b.estimate_amount,
    jurisdiction: b.jurisdiction,
    date_submitted: b.date_submitted,
    approved_by: b.approved_by,
    submissions: submissions
      .filter(sub => sub.bid_id === b._id)
      .map(sub => ({
        id: sub._id,
        company: companyById[sub.company_id] || null,
        amount: sub.amount,
        date_submitted: sub.date_submitted,
        approved_by: sub.approved_by,
        submission_type: sub.submission_type,
        notes: sub.notes,
        is_current: !!sub.is_current,
        outcome: sub.outcome || 'pending',
        award_date: sub.award_date,
        date_not_awarded: sub.date_not_awarded,
        not_awarded_notes: sub.not_awarded_notes,
        next_followup_date: sub.next_followup_date,
        followups: subFollowups
          .filter(f => f.parent_id === sub._id)
          .sort((a, c) => (c.followup_date || '').localeCompare(a.followup_date || ''))
          .map(f => fmtFollowup(f, tm)),
      })),
    award_date: b.award_date,
    awarded_company: b.awarded_company_id ? companyById[b.awarded_company_id] : null,
    date_not_awarded: b.date_not_awarded,
    not_awarded_notes: b.not_awarded_notes,
    closed_date: b.closed_date,
    closed_approved_by: b.closed_approved_by,
    close_reason: b.close_reason,
    next_followup_date: b.next_followup_date,
    notes: b.notes,
    // Bid-level follow-ups (parent_type 'bid') — the only kind possible
    // pre-submission, e.g. an opportunity that hasn't been bid yet. Once a
    // bid is submitted, follow-ups move to the per-submission timeline
    // (submissions[].followups) instead.
    followups: bidFollowups.filter(f => f.parent_id === b._id)
      .sort((a, c) => (c.followup_date || '').localeCompare(a.followup_date || ''))
      .map(f => fmtFollowup(f, tm)),
    reminders: remindersFor('bid', b._id),
    notes_log: notesFor('bid', b._id),
  });

  const fmtCo = (co) => ({
    id: co._id,
    co_number: co.co_number,
    name: co.name,
    stage: co.stage,
    superseded: !!co.superseded,
    estimator: tm[co.estimator_id] || null,
    due_date: co.due_date,
    start_date: co.start_date,
    estimate_amount: co.estimate_amount,
    date_submitted: co.date_submitted,
    approved_by: co.approved_by,
    approval_date: co.approval_date,
    notes: co.notes,
    void_reason: co.void_reason,
    not_approved_notes: co.not_approved_notes,
    next_followup_date: co.next_followup_date,
    followups: coFollowups
      .filter(f => f.parent_id === co._id)
      .sort((a, c) => (c.followup_date || '').localeCompare(a.followup_date || ''))
      .map(f => fmtFollowup(f, tm)),
    reminders: remindersFor('change_order', co._id),
    notes_log: notesFor('change_order', co._id),
  });

  return {
    id: project._id,
    name: project.name,
    bids: bids
      .map(fmtBid)
      .sort((a, b) => stageRank(a.stage) - stageRank(b.stage)),
    jobs: jobs.map(j => ({
      id: j._id,
      job_number: j.job_number,                       // null = "pending"
      winning_bid_id: j.winning_bid_id,               // null = legacy job
      awarded_company: j.awarded_company_id ? companyById[j.awarded_company_id] : null,
      pm: tm[j.pm_id] || null,
      award_date: j.award_date,
      change_orders: cos
        .filter(c => c.job_id === j._id)
        .map(fmtCo)
        .sort((a, b) => (a.co_number || '').localeCompare(b.co_number || '', undefined, { numeric: true })),
    })),
  };
}

function fmtFollowup(f, tm) {
  return {
    id: f._id,
    followup_date: f.followup_date,
    contacted_by: tm[f.contacted_by] || null,
    contact_method: f.contact_method,
    customer_contact: f.customer_contact,
    notes: f.notes,
    outcome: f.outcome,
    next_followup_date: f.next_followup_date,
  };
}

function stageRank(stage) {
  return { awarded: 0, submitted: 1, active_bid: 2, opportunity: 3, not_awarded: 4, closed: 5 }[stage] ?? 9;
}

// ═══════════════════════════════════════════════════════════════════════════
// STATE MACHINE — all transitions per DATA_MODEL_SPEC.md §2
// Every transition validates the current stage and collects exactly the
// required fields for that transition. Illegal transitions throw.
// ═══════════════════════════════════════════════════════════════════════════

const ts = () => new Date().toISOString().replace('T', ' ').substring(0, 19);
const today = () => new Date().toISOString().split('T')[0];

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + Number(days));
  return d.toISOString().split('T')[0];
}

// ── Holidays + working-day math ────────────────────────────────────────────
// All computed in UTC (Date.UTC / getUTCDay / setUTCDate throughout) so the
// result never depends on the server's local timezone — a Date built from
// plain Y/M/D and formatted straight back to Y/M/D via toISOString() only
// round-trips safely if every step stays in UTC.
function _nthWeekdayOfMonth(year, month, weekday, n) { // month 0-indexed, weekday 0=Sun
  const d = new Date(Date.UTC(year, month, 1));
  let count = 0;
  while (true) {
    if (d.getUTCDay() === weekday) { count++; if (count === n) return d; }
    d.setUTCDate(d.getUTCDate() + 1);
  }
}
function _lastWeekdayOfMonth(year, month, weekday) {
  const d = new Date(Date.UTC(year, month + 1, 0));
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}
function _observedWeekend(d) { // federal rule: Sat -> observed Fri, Sun -> observed Mon
  const day = d.getUTCDay();
  if (day === 6) { const r = new Date(d); r.setUTCDate(r.getUTCDate() - 1); return r; }
  if (day === 0) { const r = new Date(d); r.setUTCDate(r.getUTCDate() + 1); return r; }
  return d;
}
const _isoUTC = d => d.toISOString().split('T')[0];

// US federal holidays (weekend-observed) plus the Friday after Thanksgiving
// and Christmas Eve, which most construction/trades shops also close for.
// Used both to grey out the calendar and to skip in addWorkingDays() below.
function getHolidays(year) {
  const dates = [];
  const fixed = (m, day) => dates.push(_isoUTC(_observedWeekend(new Date(Date.UTC(year, m, day)))));
  fixed(0, 1);                                            // New Year's Day
  dates.push(_isoUTC(_nthWeekdayOfMonth(year, 0, 1, 3)));  // MLK Day — 3rd Mon of Jan
  dates.push(_isoUTC(_nthWeekdayOfMonth(year, 1, 1, 3)));  // Presidents Day — 3rd Mon of Feb
  dates.push(_isoUTC(_lastWeekdayOfMonth(year, 4, 1)));    // Memorial Day — last Mon of May
  fixed(5, 19);                                            // Juneteenth
  fixed(6, 4);                                             // Independence Day
  dates.push(_isoUTC(_nthWeekdayOfMonth(year, 8, 1, 1)));  // Labor Day — 1st Mon of Sep
  const thanksgiving = _nthWeekdayOfMonth(year, 10, 4, 4); // 4th Thu of Nov
  dates.push(_isoUTC(thanksgiving));
  const dayAfter = new Date(thanksgiving); dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
  dates.push(_isoUTC(dayAfter));                           // Day after Thanksgiving — always a Friday
  // Christmas Eve is a bonus closure day, not a federal holiday with a legal
  // "observed" substitution rule — use the literal date. If it lands on a
  // weekend it's already covered by the separate weekend check, so it never
  // needs to steal a weekday from Christmas Day's own observed shift (that
  // collision is what caused Dec 24 to show as both "Eve" and "Day" for 2027).
  dates.push(_isoUTC(new Date(Date.UTC(year, 11, 24))));   // Christmas Eve
  fixed(11, 25);                                            // Christmas Day
  return [...new Set(dates)].sort();
}
// Small range is plenty — the calendar view only ever browses a few years out.
function getHolidaysAround(centerYear) {
  return [centerYear - 1, centerYear, centerYear + 1, centerYear + 2].flatMap(getHolidays);
}
// Same dates as getHolidays(), labeled — for the calendar's grey-out tooltip.
function getHolidayNames(year) {
  const map = {};
  const fixed = (m, day, name) => { map[_isoUTC(_observedWeekend(new Date(Date.UTC(year, m, day))))] = name; };
  fixed(0, 1, "New Year's Day");
  map[_isoUTC(_nthWeekdayOfMonth(year, 0, 1, 3))] = 'MLK Day';
  map[_isoUTC(_nthWeekdayOfMonth(year, 1, 1, 3))] = "Presidents Day";
  map[_isoUTC(_lastWeekdayOfMonth(year, 4, 1))] = 'Memorial Day';
  fixed(5, 19, 'Juneteenth');
  fixed(6, 4, 'Independence Day');
  map[_isoUTC(_nthWeekdayOfMonth(year, 8, 1, 1))] = 'Labor Day';
  const thanksgiving = _nthWeekdayOfMonth(year, 10, 4, 4);
  map[_isoUTC(thanksgiving)] = 'Thanksgiving';
  const dayAfter = new Date(thanksgiving); dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
  map[_isoUTC(dayAfter)] = 'Day after Thanksgiving';
  map[_isoUTC(new Date(Date.UTC(year, 11, 24)))] = 'Christmas Eve';
  fixed(11, 25, 'Christmas Day');
  return map;
}
function getHolidayNamesAround(centerYear) {
  return Object.assign({}, ...[centerYear - 1, centerYear, centerYear + 1, centerYear + 2].map(getHolidayNames));
}
function isWeekendOrHoliday(dateStr) {
  const day = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  if (day === 0 || day === 6) return true;
  return getHolidays(Number(dateStr.slice(0, 4))).includes(dateStr);
}
// Steps N *working* days (skipping weekends + holidays) forward from dateStr —
// used for follow-up next-date scheduling so a timer never lands on a day
// nobody's in the office.
function addWorkingDays(dateStr, days) {
  const step = Number(days) >= 0 ? 1 : -1;
  let remaining = Math.abs(Number(days));
  let d = new Date(dateStr + 'T00:00:00Z');
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + step);
    if (!isWeekendOrHoliday(_isoUTC(d))) remaining--;
  }
  return _isoUTC(d);
}

async function getSettings() {
  const { Settings } = getModels();
  return (await Settings.findById('company').lean()) || { fu_initial_days: 3, fu_recurring_days: 7 };
}

function require_(data, fields) {
  const missing = fields.filter(f => data[f] === undefined || data[f] === null || data[f] === '');
  if (missing.length) throw new Error(`Missing required: ${missing.join(', ')}`);
}

// Bid/CO amounts may be negative (a change-order credit) but never exactly
// zero — a $0 submission is almost always a data-entry mistake, not a real
// value.
function requireNonZeroAmount(amount) {
  if (Number(amount) === 0) throw new Error('Amount cannot be $0 — enter a positive or negative value');
}

async function loadBid(id) {
  const { Bid } = getModels();
  const bid = await Bid.findById(Number(id)).lean();
  if (!bid) throw new Error('Bid not found');
  return bid;
}

async function loadCO(id) {
  const { ChangeOrder } = getModels();
  const co = await ChangeOrder.findById(Number(id)).lean();
  if (!co) throw new Error('Change order not found');
  return co;
}

// Lists for form dropdowns
async function getMeta() {
  const M = getModels();
  const [companies, team] = await Promise.all([
    M.Company.find().sort({ name: 1 }).lean(),
    M.TeamMember.find({ active: 1 }).sort({ name: 1 }).lean(),
  ]);
  return {
    companies: companies.map(c => ({ id: c._id, name: c.name })),
    team: team.map(t => ({ id: t._id, name: t.name, initials: t.initials, role: t.role })),
    holidays: getHolidayNamesAround(new Date().getUTCFullYear()),
  };
}

// ── Team (v2's OWN roster — see the id-space note in v2/notify.js. Editing
// here affects v2's estimator/salesperson dropdowns, filters, and "mine
// only"; it does NOT create a login — that still goes through v1's system,
// keyed by name-match, until the two rosters are unified.) ───────────────────
async function getTeamV2() {
  const M = getModels();
  const team = await M.TeamMember.find().sort({ name: 1 }).lean();
  return team.map(t => ({ id: t._id, name: t.name, initials: t.initials, role: t.role, email: t.email, active: !!t.active, is_admin: !!t.is_admin, has_password: !!t.password_hash }));
}
async function createTeamMemberV2({ name, initials, role, email, temp_password }) {
  require_({ name, initials, role }, ['name', 'initials', 'role']);
  const M = getModels();
  // TeamMember ids were hand-assigned historically, not via the Counter
  // collection — an uninitialized nextId('team_members') would start at 1
  // and collide. Compute the next id from what's actually there.
  const existing = await M.TeamMember.find().select('_id').lean();
  const id = Math.max(0, ...existing.map(t => t._id)) + 1;
  const doc = { _id: id, name: name.trim(), initials: initials.toUpperCase(), role, email: email ? email.toLowerCase().trim() : null, active: 1 };
  if (temp_password) { doc.password_hash = await bcrypt.hash(temp_password, 12); doc.must_change_password = true; }
  await M.TeamMember.create(doc);
  return { id };
}
async function updateTeamMemberV2(id, data) {
  const M = getModels();
  const upd = {};
  if ('name' in data) upd.name = data.name;
  if ('initials' in data) upd.initials = String(data.initials).toUpperCase();
  if ('role' in data) upd.role = data.role;
  if ('email' in data) upd.email = data.email ? String(data.email).toLowerCase().trim() : null;
  if ('active' in data) upd.active = Number(data.active);
  if ('is_admin' in data) upd.is_admin = !!Number(data.is_admin);
  const r = await M.TeamMember.updateOne({ _id: Number(id) }, { $set: upd });
  if (!r.matchedCount) throw new Error('Team member not found');
  return { ok: true };
}
async function updateSettingsV2(data) {
  const M = getModels();
  const upd = {};
  if ('fu_initial_days' in data) upd.fu_initial_days = Number(data.fu_initial_days);
  if ('fu_recurring_days' in data) upd.fu_recurring_days = Number(data.fu_recurring_days);
  await M.Settings.findByIdAndUpdate('company', { $set: upd }, { upsert: true });
  return getSettings();
}

// ── Opportunity creation ──────────────────────────────────────────────────────
// Creates a Project (or attaches to an existing one) + an opportunity Bid.
async function createOpportunity({ project_id, project_name, notes, description, location, due_date, company_ids, new_companies, contact_ids, created_by }) {
  const M = getModels();
  let pid = project_id ? Number(project_id) : null;
  let isNewProject = false;
  if (!pid) {
    require_({ project_name }, ['project_name']);
    pid = await nextId('projects');
    // description/location only apply when creating a brand-new project —
    // attaching to an existing one leaves its own data alone.
    await M.Project.create({ _id: pid, name: project_name.trim(), description: description || null, location: location || null, created_by: created_by || null });
    isNewProject = true;
  }
  const bidId = await nextId('bids');
  await M.Bid.create({ _id: bidId, project_id: pid, stage: 'opportunity', notes: notes || null, due_date: due_date || null });

  const companyIds = await resolveCompanyIds(company_ids, new_companies);
  for (const companyId of companyIds) await ensureBidCustomer(bidId, companyId);
  // Contacts aren't scoped to a single customer this early — attach whichever
  // ones were picked to every customer on the roster; refine per-customer
  // later from the bid flyout (which already has that UI).
  if (companyIds.length && contact_ids && contact_ids.length) {
    const ids = contact_ids.map(Number);
    await M.BidCustomer.updateMany({ bid_id: bidId }, { $addToSet: { contact_ids: { $each: ids } } });
  }

  const actorId = created_by ? Number(created_by) : null;
  const proj = await M.Project.findById(pid).lean();
  if (isNewProject) {
    await events.safeEmit('project.created', { project_id: pid, actor_id: actorId, payload: { name: proj.name } });
  }
  await events.safeEmit('bid.created', {
    project_id: pid, bid_id: bidId, actor_id: actorId,
    payload: { project_name: proj.name, stage: 'opportunity', estimator_id: null, salesperson_id: null, due_date: due_date || null },
  });
  return { project_id: pid, bid_id: bidId };
}

// ── opportunity → active_bid ("Start Bid") ────────────────────────────────────
async function startBid(id, data, actorId) {
  const M = getModels();
  const bid = await loadBid(id);
  if (bid.stage !== 'opportunity') throw new Error(`Cannot start bid from stage '${bid.stage}'`);
  require_(data, ['bid_number', 'date_received', 'due_date']);
  const companyIds = await resolveCompanyIds(data.company_ids, data.new_companies);
  if (!companyIds.length) throw new Error('At least one customer company is required');

  // Bid # is entered manually for now (generated outside this system).
  // Future: auto-generate the B-year-sequence here.
  const bid_number = String(data.bid_number).trim();

  await M.Bid.updateOne({ _id: bid._id }, { $set: {
    stage: 'active_bid',
    bid_number,
    // Estimator/salesperson can be left TBD and assigned later.
    estimator_id: data.estimator_id ? Number(data.estimator_id) : null,
    salesperson_id: data.salesperson_id ? Number(data.salesperson_id) : null,
    sub_estimators: data.sub_estimators || [],
    date_received: data.date_received,
    due_date: data.due_date,
    start_date: data.start_date || null,
    drawing_stage: data.drawing_stage || null,
    updated_at: ts(),
  }});
  for (const companyId of companyIds) {
    await M.BidCustomer.create({
      _id: await nextId('bid_customers'),
      bid_id: bid._id, company_id: companyId,
      contact_ids: (data.contact_ids_by_company || {})[companyId] || [],
    });
  }
  const proj = await M.Project.findById(bid.project_id).lean();
  await events.safeEmit('bid.stage_changed', {
    project_id: bid.project_id, bid_id: bid._id, actor_id: actorId || null,
    payload: { from: 'opportunity', to: 'active_bid', project_name: proj?.name || null },
  });
  return { bid_id: bid._id, bid_number };
}

// ── Create a bid directly at active_bid (bypasses the opportunity stage) ──────
// Used by the "+ New Bid" button and "+ Add Bid to Project" (e.g. a new drawing
// stage — 50% budget, then 70%, etc., each its own B26 # under the same project).
// Attaches to an existing project (project_id) or creates a new one
// (project_name), then runs the same validated Start Bid logic.
async function createDirectBid(data) {
  const { project_id, bid_id } = await createOpportunity({
    project_id: data.project_id,
    project_name: data.project_name,
    created_by: data.created_by,
  });
  const started = await startBid(bid_id, data, data.created_by);
  // Adding a new bid supersedes the project's prior non-terminal bids (e.g. a
  // later drawing stage replaces the earlier one). Terminal bids
  // (awarded/not_awarded/closed) are historical and left untouched.
  const M = getModels();
  await M.Bid.updateMany(
    { project_id, _id: { $ne: bid_id }, superseded: { $ne: 1 }, stage: { $in: ['opportunity', 'active_bid', 'submitted'] } },
    { $set: { superseded: 1, updated_at: ts() } }
  );
  return { project_id, bid_id, bid_number: started.bid_number };
}

// Resync the bid's denormalized headline (estimate_amount / date_submitted /
// approved_by) from its submissions. Awarded bids show the winning company's
// submission; otherwise the most-recent current submission (by date sent).
async function recomputeBidHeadline(bidId) {
  const M = getModels();
  const bid = await M.Bid.findById(bidId).lean();
  if (!bid) return;
  let chosen = null;
  if (bid.stage === 'awarded' && bid.awarded_company_id) {
    chosen = (await M.BidSubmission.find({ bid_id: bidId, company_id: bid.awarded_company_id })
      .sort({ is_current: -1, date_submitted: -1, _id: -1 }).limit(1).lean())[0];
  }
  if (!chosen) {
    chosen = (await M.BidSubmission.find({ bid_id: bidId, is_current: 1 })
      .sort({ date_submitted: -1, _id: -1 }).limit(1).lean())[0];
  }
  await M.Bid.updateOne({ _id: bidId }, { $set: {
    estimate_amount: chosen ? chosen.amount : null,
    date_submitted:  chosen ? chosen.date_submitted : null,
    approved_by:     chosen ? chosen.approved_by : null,
    updated_at: ts(),
  }});
}

// Add a company to a bid's customer roster if it isn't already on it (idempotent).
async function ensureBidCustomer(bidId, companyId) {
  const M = getModels();
  const exists = await M.BidCustomer.findOne({ bid_id: bidId, company_id: companyId }).lean();
  if (exists) return;
  await M.BidCustomer.create({ _id: await nextId('bid_customers'), bid_id: bidId, company_id: companyId, contact_ids: [] });
}

// Find a company by case/punctuation-insensitive name, creating it if new. Lets
// the UI add a customer that doesn't exist in the system yet (typed in the picker).
async function resolveCompanyByName(name) {
  const M = getModels();
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Company name required');
  const norm = _norm(clean);
  const hit = (await M.Company.find().lean()).find(c => _norm(c.name) === norm);
  if (hit) return hit._id;
  const id = await nextId('companies');
  await M.Company.create({ _id: id, name: clean });
  return id;
}

// Normalize a company picker's payload (existing ids + typed-in new names) to ids.
async function resolveCompanyIds(company_ids, new_companies) {
  const ids = [];
  for (const cid of (company_ids || [])) { const n = Number(cid); if (n) ids.push(n); }
  for (const nm of (new_companies || [])) ids.push(await resolveCompanyByName(nm));
  return [...new Set(ids)];
}

// ── Contacts ───────────────────────────────────────────────────────────────
// Contact.company_id is a real FK (no free-text company, unlike v1). Soft
// delete via `active` — the field v2's schema already has for exactly this.
function fmtContactBrief(c) {
  return { id: c._id, first_name: c.first_name, last_name: c.last_name, full_name: [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)', phone: c.phone, email: c.email, title: c.title };
}
async function fmtContact(c, companyById) {
  return { ...fmtContactBrief(c), company_id: c.company_id, company: companyById[c.company_id] || null, notes: c.notes, active: !!c.active };
}
async function getContacts({ search, company_id, no_company } = {}) {
  const M = getModels();
  const [contacts, companies] = await Promise.all([M.Contact.find({ active: 1 }).lean(), M.Company.find().lean()]);
  const companyById = {}; companies.forEach(c => companyById[c._id] = { id: c._id, name: c.name });
  let out = await Promise.all(contacts.map(c => fmtContact(c, companyById)));
  if (company_id) out = out.filter(c => c.company_id === Number(company_id));
  if (no_company === 'true' || no_company === true) out = out.filter(c => !c.company_id);
  if (search) {
    const needle = search.toLowerCase();
    out = out.filter(c => [c.full_name, c.email, c.phone, c.company?.name].some(f => f && String(f).toLowerCase().includes(needle)));
  }
  return out.sort((a, b) => (a.last_name || '').localeCompare(b.last_name || '') || (a.first_name || '').localeCompare(b.first_name || ''));
}
async function getContactDetail(id) {
  const M = getModels();
  const [c, companies] = await Promise.all([M.Contact.findById(Number(id)).lean(), M.Company.find().lean()]);
  if (!c) return null;
  const companyById = {}; companies.forEach(co => companyById[co._id] = { id: co._id, name: co.name });
  return fmtContact(c, companyById);
}
async function createContact(data) {
  const M = getModels();
  const companyId = data.company_id ? Number(data.company_id) : (data.new_company ? await resolveCompanyByName(data.new_company) : null);
  if (!companyId) throw new Error('Company is required');
  const id = await nextId('contacts');
  await M.Contact.create({
    _id: id, company_id: companyId,
    first_name: data.first_name || null, last_name: data.last_name || null,
    phone: data.phone || null, email: data.email ? String(data.email).toLowerCase().trim() : null,
    title: data.title || null, notes: data.notes || null, active: 1,
  });
  return getContactDetail(id);
}
async function updateContact(id, data) {
  const M = getModels();
  const upd = { updated_at: ts() };
  if ('first_name' in data) upd.first_name = data.first_name || null;
  if ('last_name' in data) upd.last_name = data.last_name || null;
  if ('phone' in data) upd.phone = data.phone || null;
  if ('email' in data) upd.email = data.email ? String(data.email).toLowerCase().trim() : null;
  if ('title' in data) upd.title = data.title || null;
  if ('notes' in data) upd.notes = data.notes || null;
  if (data.company_id) upd.company_id = Number(data.company_id);
  else if (data.new_company) upd.company_id = await resolveCompanyByName(data.new_company);
  const r = await M.Contact.updateOne({ _id: Number(id) }, { $set: upd });
  if (!r.matchedCount) throw new Error('Contact not found');
  return getContactDetail(id);
}
async function deleteContact(id) {
  const M = getModels();
  await M.Contact.updateOne({ _id: Number(id) }, { $set: { active: 0, updated_at: ts() } });
  await M.BidCustomer.updateMany({ contact_ids: Number(id) }, { $pull: { contact_ids: Number(id) } });
}

// Same win/loss/pipeline stats v1 showed on contact & company profile modals.
function calcBidStats(bids) {
  const ACTIVE = ['opportunity', 'active_bid', 'submitted'];
  const won = bids.filter(b => b.stage === 'awarded');
  const lost = bids.filter(b => b.stage === 'not_awarded');
  const active = bids.filter(b => ACTIVE.includes(b.stage) && !b.superseded);
  const decided = won.length + lost.length;
  return {
    total: bids.length, active: active.length, wins: won.length, losses: lost.length,
    winRate: decided > 0 ? Math.round(won.length / decided * 100) : null,
    wonValue: won.reduce((s, b) => s + (b.estimate_amount || 0), 0),
    totalValue: bids.reduce((s, b) => s + (b.estimate_amount || 0), 0),
  };
}
async function bidSummaries(bidIds) {
  const M = getModels();
  const bids = await M.Bid.find({ _id: { $in: bidIds } }).sort({ created_at: -1 }).lean();
  const projects = await M.Project.find().lean();
  const pName = {}; projects.forEach(p => pName[p._id] = p.name);
  return bids.map(b => ({
    id: b._id, project_id: b.project_id, project: pName[b.project_id] || '—',
    bid_number: b.bid_number, stage: b.stage, superseded: !!b.superseded,
    estimate_amount: b.estimate_amount, due_date: b.due_date, award_date: b.award_date,
  }));
}
async function getContactBids(contactId) {
  const M = getModels();
  const bcRows = await M.BidCustomer.find({ contact_ids: Number(contactId) }).lean();
  const bids = await bidSummaries([...new Set(bcRows.map(bc => bc.bid_id))]);
  return { bids, stats: calcBidStats(bids) };
}
async function getCompanyBids(companyId) {
  const M = getModels();
  const bcRows = await M.BidCustomer.find({ company_id: Number(companyId) }).lean();
  const bids = await bidSummaries([...new Set(bcRows.map(bc => bc.bid_id))]);
  return { bids, stats: calcBidStats(bids) };
}

// Add/remove a contact from a specific bid-customer row (bid flyout's per-customer contact list).
async function addBidCustomerContact(bidCustomerId, contactId) {
  const M = getModels();
  const r = await M.BidCustomer.updateOne({ _id: Number(bidCustomerId) }, { $addToSet: { contact_ids: Number(contactId) } });
  if (!r.matchedCount) throw new Error('Bid customer row not found');
  return { ok: true };
}
async function removeBidCustomerContact(bidCustomerId, contactId) {
  const M = getModels();
  await M.BidCustomer.updateOne({ _id: Number(bidCustomerId) }, { $pull: { contact_ids: Number(contactId) } });
  return { ok: true };
}

// Add one or more customers to a bid's roster — independent of any submission.
// Accepts existing company_ids and/or new_companies (names to find-or-create).
async function addBidCustomers(id, data) {
  const bid = await loadBid(id);
  const ids = await resolveCompanyIds(data.company_ids, data.new_companies);
  if (!ids.length) throw new Error('Pick or name at least one customer');
  let added = 0;
  for (const companyId of ids) {
    const M = getModels();
    const exists = await M.BidCustomer.findOne({ bid_id: bid._id, company_id: companyId }).lean();
    if (exists) continue;
    await ensureBidCustomer(bid._id, companyId);
    added++;
  }
  return { bid_id: bid._id, added };
}

// Let any user (not just admins) set a due date / estimator / salesperson on
// an opportunity directly, without going through "Start Bid" — an
// opportunity is often being tracked/discussed with a customer well before
// anyone commits to estimating it, and those details (when's the decision
// due, who's talking to the customer) are useful to capture right away.
// Deliberately opportunity-only: once a bid has started, these fields are
// edited via the normal admin edit / Start Bid flow instead.
async function updateOpportunity(id, data) {
  const M = getModels();
  const bid = await loadBid(id);
  if (bid.stage !== 'opportunity') throw new Error("This is only for opportunities — once a bid has started, edit it from the bid's own Edit button.");
  const upd = { updated_at: ts() };
  if ('due_date' in data) upd.due_date = data.due_date || null;
  if ('estimator_id' in data) upd.estimator_id = data.estimator_id ? Number(data.estimator_id) : null;
  if ('salesperson_id' in data) upd.salesperson_id = data.salesperson_id ? Number(data.salesperson_id) : null;
  await M.Bid.updateOne({ _id: bid._id }, { $set: upd });
  return { bid_id: bid._id };
}

// Change just the due date — used by the calendar's drag-and-drop (drag a
// chip to a different day). Deliberately a single-field, non-admin action
// (like adding a customer or logging a follow-up) rather than the full
// admin edit form, since correcting a due date is routine day-to-day work.
// `actor` (from the logged-in session) is only used for the audit log —
// every call site passes it in but treats a missing one as "Unknown" rather
// than failing, since logging must never block the actual action.
async function updateBidDueDate(id, due_date, actor) {
  const M = getModels();
  const bid = await loadBid(id);
  const before = bid.due_date;
  await M.Bid.updateOne({ _id: bid._id }, { $set: { due_date: due_date || null, updated_at: ts() } });
  await logActivity({ actor_id: actor?.id, actor_name: actor?.name, action: 'bid.due_date_change',
    summary: `Changed due date on bid #${bid._id}${bid.bid_number ? ' (' + bid.bid_number + ')' : ''} from ${before || 'none'} to ${due_date || 'none'}`,
    entity_type: 'bid', entity_id: bid._id, undo: { bid_id: bid._id, due_date_before: before } });
  return { bid_id: bid._id, due_date: due_date || null };
}
async function updateCoDueDate(id, due_date, actor) {
  const M = getModels();
  const co = await loadCO(id);
  const before = co.due_date;
  await M.ChangeOrder.updateOne({ _id: co._id }, { $set: { due_date: due_date || null, updated_at: ts() } });
  await logActivity({ actor_id: actor?.id, actor_name: actor?.name, action: 'co.due_date_change',
    summary: `Changed due date on CO #${co._id} (${co.co_number}) from ${before || 'none'} to ${due_date || 'none'}`,
    entity_type: 'change_order', entity_id: co._id, undo: { co_id: co._id, due_date_before: before } });
  return { co_id: co._id, due_date: due_date || null };
}

// Sub-estimators — breaking a large bid into systems (Fire Alarm, Lighting
// Controls, Distribution, Data, Nurse Call, Security, etc.) taken off by a
// different estimator than the bid's primary one. Open to any user, not
// admin-gated, same trust level as adding a customer.
async function addSubEstimator(bidId, { estimator_id, scope }, actor) {
  const M = getModels();
  const bid = await loadBid(bidId);
  const eid = Number(estimator_id);
  const sys = String(scope || '').trim();
  if (!eid || !sys) throw new Error('Estimator and system/scope are both required');
  if ((bid.sub_estimators || []).some(s => s.estimator_id === eid && s.scope === sys)) throw new Error('That estimator is already assigned to this system');
  await M.Bid.updateOne({ _id: bid._id }, { $push: { sub_estimators: { estimator_id: eid, scope: sys } }, $set: { updated_at: ts() } });
  await logActivity({ actor_id: actor?.id, actor_name: actor?.name, action: 'bid.sub_estimator_add',
    summary: `Added sub-estimator (${sys}) to bid #${bid._id}${bid.bid_number ? ' (' + bid.bid_number + ')' : ''}`,
    entity_type: 'bid', entity_id: bid._id, undo: { bid_id: bid._id, estimator_id: eid, scope: sys } });
  return { ok: true };
}
async function removeSubEstimator(bidId, estimatorId, scope, actor) {
  const M = getModels();
  await M.Bid.updateOne({ _id: Number(bidId) }, { $pull: { sub_estimators: { estimator_id: Number(estimatorId), scope } }, $set: { updated_at: ts() } });
  await logActivity({ actor_id: actor?.id, actor_name: actor?.name, action: 'bid.sub_estimator_remove',
    summary: `Removed sub-estimator (${scope}) from bid #${bidId}`,
    entity_type: 'bid', entity_id: Number(bidId), undo: { bid_id: Number(bidId), estimator_id: Number(estimatorId), scope } });
  return { ok: true };
}

// Remove a customer mistakenly added to a bid. Blocked if a submission
// already exists for that company on this bid, or if they're the awarded
// company — those represent real activity, not a roster mistake, and
// deleting the row would silently orphan that history.
async function removeBidCustomer(bidCustomerId) {
  const M = getModels();
  const bc = await M.BidCustomer.findById(Number(bidCustomerId)).lean();
  if (!bc) throw new Error('Customer not found on this bid');
  const hasSubmission = await M.BidSubmission.exists({ bid_id: bc.bid_id, company_id: bc.company_id });
  if (hasSubmission) throw new Error('Can’t remove — this customer already has a submission on this bid.');
  const bid = await M.Bid.findById(bc.bid_id).lean();
  if (bid?.awarded_company_id === bc.company_id) throw new Error('Can’t remove the awarded company.');
  await M.BidCustomer.deleteOne({ _id: bc._id });
  return { ok: true, bid_id: bc.bid_id };
}

// Standalone company creation (Contacts page "+ New Company") — same fields
// the JIS importer captures, for when there's no bid/contact context yet.
async function createCompanyV2(data) {
  const M = getModels();
  require_(data, ['name']);
  const id = await nextId('companies');
  await M.Company.create({
    _id: id, name: data.name.trim(),
    street: data.street || null, city: data.city || null, state: data.state || null, zip: data.zip || null,
    phone: data.phone || null, domain: data.domain || null,
  });
  return { id };
}

// The bid's follow-up date is a rollup: the earliest next_followup_date among
// its still-pending submissions (for dashboard/digest "overdue" queries).
async function recomputeBidFollowup(bidId) {
  const M = getModels();
  const next = (await M.BidSubmission.find({ bid_id: bidId, is_current: 1, outcome: 'pending', next_followup_date: { $ne: null } })
    .sort({ next_followup_date: 1 }).limit(1).lean())[0];
  await M.Bid.updateOne({ _id: bidId }, { $set: { next_followup_date: next ? next.next_followup_date : null, updated_at: ts() } });
}

// ── active_bid → submitted ("Submit Bid") — batch: submit to one or more
// customers at once with the same amount/date/approver. GUARDRAIL: the bid
// only advances to 'submitted' once every customer currently on its roster
// has a current submission — if some customers were left unchecked (or get
// added to the roster later), the bid stays 'active_bid' so "Submit Bid"
// can be called again for whoever's left, without losing what's already
// been submitted. This mirrors what a real bid team needs: nothing counts
// as "out the door" until every applicable customer actually has a number.
async function submitBid(id, data, actorId) {
  const M = getModels();
  const bid = await loadBid(id);
  if (bid.stage !== 'active_bid') throw new Error(`Cannot submit from stage '${bid.stage}'`);
  require_(data, ['amount', 'jurisdiction', 'date_submitted', 'approved_by']);
  requireNonZeroAmount(data.amount);
  const companyIds = await resolveCompanyIds(data.company_ids, data.new_companies);
  if (!companyIds.length) throw new Error('Pick at least one customer to submit to');

  const s = await getSettings();
  for (const companyId of companyIds) {
    await ensureBidCustomer(bid._id, companyId);
    await M.BidSubmission.create({
      _id: await nextId('bid_submissions'),
      bid_id: bid._id, company_id: companyId,
      amount: Number(data.amount), date_submitted: data.date_submitted, approved_by: data.approved_by,
      submission_type: 'initial', notes: data.notes || null, is_current: 1,
      outcome: 'pending', next_followup_date: addWorkingDays(data.date_submitted, s.fu_initial_days),
    });
  }

  const upd = { jurisdiction: String(data.jurisdiction), updated_at: ts() };
  const [allCustomers, currentSubs] = await Promise.all([
    M.BidCustomer.find({ bid_id: bid._id }).lean(),
    M.BidSubmission.find({ bid_id: bid._id, is_current: 1 }).lean(),
  ]);
  const submittedCompanyIds = new Set(currentSubs.map(s => s.company_id));
  const allSubmitted = allCustomers.length > 0 && allCustomers.every(bc => submittedCompanyIds.has(bc.company_id));
  if (allSubmitted) upd.stage = 'submitted';
  await M.Bid.updateOne({ _id: bid._id }, { $set: upd });
  await recomputeBidHeadline(bid._id);
  await recomputeBidFollowup(bid._id);
  if (allSubmitted) {
    const proj = await M.Project.findById(bid.project_id).lean();
    await events.safeEmit('bid.stage_changed', {
      project_id: bid.project_id, bid_id: bid._id, actor_id: actorId || null,
      payload: { from: 'active_bid', to: 'submitted', project_name: proj?.name || null },
    });
  }
  return { bid_id: bid._id, stage: allSubmitted ? 'submitted' : bid.stage, remaining: allCustomers.length - submittedCompanyIds.size };
}

// ── Add another submission to a submitted bid ─────────────────────────────────
// Another customer, or a best-and-final / scope change to a customer we already
// submitted to (no new drawings). The new submission gets its own follow-up clock.
async function addSubmission(id, data) {
  const M = getModels();
  const bid = await loadBid(id);
  if (bid.stage !== 'submitted') throw new Error(`Can only add submissions to a submitted bid (stage is '${bid.stage}')`);
  require_(data, ['amount', 'date_submitted', 'approved_by', 'submission_type']);
  requireNonZeroAmount(data.amount);
  const companyId = data.company_id ? Number(data.company_id) : (data.new_company ? await resolveCompanyByName(data.new_company) : null);
  if (!companyId) throw new Error('Customer is required');
  await ensureBidCustomer(bid._id, companyId);

  // The prior current submission to this same customer is no longer current —
  // clear its follow-up timer so superseded versions don't keep nagging.
  await M.BidSubmission.updateMany(
    { bid_id: bid._id, company_id: companyId, is_current: 1 },
    { $set: { is_current: 0, next_followup_date: null, updated_at: ts() } }
  );
  const s = await getSettings();
  await M.BidSubmission.create({
    _id: await nextId('bid_submissions'),
    bid_id: bid._id, company_id: companyId,
    amount: Number(data.amount), date_submitted: data.date_submitted, approved_by: data.approved_by,
    submission_type: data.submission_type, notes: data.notes || null, is_current: 1,
    outcome: 'pending', next_followup_date: addWorkingDays(data.date_submitted, s.fu_initial_days),
  });
  await recomputeBidHeadline(bid._id);
  await recomputeBidFollowup(bid._id);
  return { bid_id: bid._id };
}

// ── (submitted | closed) → active_bid/opportunity ("Reactivate") ──────────────
// From 'submitted': a revision or best-and-final round needs its own due date
// and needs to show back up on the calendar/estimator dashboard, which only
// happens for active_bid-stage bids. Doesn't touch existing BidSubmission
// rows — those stay as history; add a fresh submission (addSubmission,
// above) once the revised numbers are ready.
// From 'closed': the customer came back after all. A closed bid can have
// been closed while still just an opportunity (no bid_number yet) or after
// it was already started — reactivate back to whichever of those it came
// from rather than forcing it through "Start Bid" again. Always clears the
// closed_date/closed_approved_by/close_reason bookkeeping.
async function reactivateBid(id, data, actorId) {
  const M = getModels();
  const bid = await loadBid(id);
  if (!['submitted', 'closed'].includes(bid.stage)) throw new Error(`Cannot reactivate a bid from stage '${bid.stage}'`);
  const fromStage = bid.stage;
  const target = fromStage === 'closed' && !bid.bid_number ? 'opportunity' : 'active_bid';
  const upd = { stage: target, next_followup_date: null, updated_at: ts() };
  if (fromStage === 'closed') Object.assign(upd, { closed_date: null, closed_approved_by: null, close_reason: null });
  if (target === 'active_bid') {
    require_(data, ['due_date']);
    upd.due_date = data.due_date;
  } else if (data.due_date) {
    upd.due_date = data.due_date;
  }
  await M.Bid.updateOne({ _id: bid._id }, { $set: upd });
  const proj = await M.Project.findById(bid.project_id).lean();
  await events.safeEmit('bid.stage_changed', {
    project_id: bid.project_id, bid_id: bid._id, actor_id: actorId || null,
    payload: { from: fromStage, to: target, project_name: proj?.name || null },
  });
  return { bid_id: bid._id, stage: target };
}

// ── Admin: edit any field on any entity (admin view only) ─────────────────────
// Per spec §3.x — admins can correct fields on Projects, Bids (opportunity /
// active / submitted), Jobs, and Change Orders (active / submitted). The route
// enforces admin; this whitelists editable fields per entity and never changes
// `stage` (transitions stay in the state machine).
// Bid submission fields (estimate $, date sent, approved by) are edited on the
// bid_submission entity, not the bid — the bid's headline is derived from them.
const ADMIN_EDITABLE = {
  project:        ['name'],
  company:        ['name', 'city', 'state'],
  bid:            ['bid_number', 'estimator_id', 'salesperson_id', 'date_received', 'due_date', 'start_date',
                   'drawing_stage', 'notes', 'jurisdiction', 'superseded'],
  job:            ['job_number', 'pm_id', 'awarded_company_id', 'award_date'],
  change_order:   ['co_number', 'name', 'due_date', 'start_date', 'estimator_id', 'notes',
                   'estimate_amount', 'date_submitted', 'approved_by'],
  bid_submission: ['company_id', 'amount', 'date_submitted', 'approved_by', 'submission_type', 'notes', 'is_current'],
};
const NUMERIC_FK = new Set(['estimator_id', 'salesperson_id', 'pm_id', 'awarded_company_id', 'company_id']);

async function adminUpdate(entity, id, data) {
  const M = getModels();
  const Model = { project: M.Project, company: M.Company, bid: M.Bid, job: M.Job, change_order: M.ChangeOrder, bid_submission: M.BidSubmission }[entity];
  if (!Model) throw new Error('Unknown entity: ' + entity);
  // capture the pre-edit doc for project/company so renames can be recorded for replay
  const before = (entity === 'project' || entity === 'company') ? await Model.findById(Number(id)).lean() : null;
  const allowed = ADMIN_EDITABLE[entity];
  const upd = { updated_at: ts() };
  for (const f of allowed) {
    if (!(f in data)) continue;
    let v = data[f] === '' ? null : data[f];
    if (NUMERIC_FK.has(f)) v = v ? Number(v) : null;
    else if (f === 'amount' || f === 'estimate_amount') {
      v = (v == null) ? null : Number(v);
      if (v != null) requireNonZeroAmount(v);
    }
    else if (f === 'superseded' || f === 'is_current') v = v ? 1 : 0;
    upd[f] = v;
  }
  const r = await Model.updateOne({ _id: Number(id) }, { $set: upd });
  if (!r.matchedCount) throw new Error(entity + ' not found');
  // Editing a submission can change the bid's derived headline.
  if (entity === 'bid_submission') {
    const sub = await M.BidSubmission.findById(Number(id)).lean();
    if (sub) await recomputeBidHeadline(sub.bid_id);
  }
  // Record renames as overrides so they survive a re-import.
  if (before && 'name' in upd && upd.name && upd.name !== before.name) {
    if (entity === 'project') await _recordOverride({ type: 'project_name', key: before.source_key || ('name:' + _norm(before.name)), name: upd.name });
    else if (entity === 'company') await _recordOverride({ type: 'company_alias', from: _norm(before.name), to: upd.name });
  }
  return { entity, id: Number(id) };
}

async function loadSubmission(id) {
  const { BidSubmission } = getModels();
  const sub = await BidSubmission.findById(Number(id)).lean();
  if (!sub) throw new Error('Submission not found');
  return sub;
}

// ── Submission awarded — that customer gave us the job; creates the Job ───────
// Per-submission win. The first awarded submission wins the bid; siblings are
// LEFT pending (resolved individually). One winner per bid.
async function awardSubmission(submissionId, data, actorId) {
  const M = getModels();
  const sub = await loadSubmission(submissionId);
  const bid = await loadBid(sub.bid_id);
  if (bid.stage !== 'submitted') throw new Error(`Bid must be 'submitted' to award (stage is '${bid.stage}')`);
  if (sub.outcome !== 'pending') throw new Error(`This submission is already '${sub.outcome}'`);
  require_(data, ['award_date']);

  await M.BidSubmission.updateOne({ _id: sub._id }, { $set: {
    outcome: 'awarded', award_date: data.award_date, next_followup_date: null, updated_at: ts(),
  }});
  await M.Bid.updateOne({ _id: bid._id }, { $set: {
    stage: 'awarded', award_date: data.award_date, awarded_company_id: sub.company_id, updated_at: ts(),
  }});
  await recomputeBidHeadline(bid._id);   // headline now reflects the winning submission
  await recomputeBidFollowup(bid._id);   // siblings stay pending; bid f/u rolls up from them
  const jobId = await nextId('jobs');
  const pmId = data.pm_id ? Number(data.pm_id) : null;
  await M.Job.create({
    _id: jobId, project_id: bid.project_id, winning_bid_id: bid._id,
    job_number: null,                                  // accounting assigns later
    awarded_company_id: sub.company_id,
    pm_id: pmId,
    award_date: data.award_date,
  });

  const [proj, company, pm] = await Promise.all([
    M.Project.findById(bid.project_id).lean(),
    M.Company.findById(sub.company_id).lean(),
    pmId ? M.TeamMember.findById(pmId).lean() : null,
  ]);
  await events.safeEmit('bid.awarded', {
    project_id: bid.project_id, bid_id: bid._id, job_id: jobId, submission_id: sub._id, actor_id: actorId || null,
    payload: {
      project_name: proj?.name || null, company_id: sub.company_id, company_name: company?.name || null,
      amount: sub.amount, award_date: data.award_date, pm_id: pmId, pm_name: pm?.name || null,
    },
  });
  await events.safeEmit('job.created', {
    project_id: bid.project_id, bid_id: bid._id, job_id: jobId, actor_id: actorId || null,
    payload: { project_name: proj?.name || null, company_name: company?.name || null, award_date: data.award_date, pm_id: pmId, from_bid: true },
  });
  return { submission_id: sub._id, bid_id: bid._id, job_id: jobId };
}

// ── Submission not awarded — this customer went elsewhere ─────────────────────
// When ALL of a bid's submissions are not_awarded (none awarded), the bid
// becomes not_awarded. Otherwise it stays submitted (others still pending).
async function notAwardSubmission(submissionId, data, actorId) {
  const M = getModels();
  const sub = await loadSubmission(submissionId);
  const bid = await loadBid(sub.bid_id);
  if (sub.outcome !== 'pending') throw new Error(`This submission is already '${sub.outcome}'`);
  require_(data, ['date_not_awarded']);

  await M.BidSubmission.updateOne({ _id: sub._id }, { $set: {
    outcome: 'not_awarded', date_not_awarded: data.date_not_awarded,
    not_awarded_notes: data.not_awarded_notes || null, next_followup_date: null, updated_at: ts(),
  }});
  await recomputeBidFollowup(bid._id);

  const all = await M.BidSubmission.find({ bid_id: bid._id }).lean();
  const anyAwarded = all.some(s => s.outcome === 'awarded');
  const anyPending = all.some(s => s.outcome === 'pending');
  if (!anyAwarded && !anyPending && bid.stage === 'submitted') {
    await M.Bid.updateOne({ _id: bid._id }, { $set: {
      stage: 'not_awarded', date_not_awarded: data.date_not_awarded,
      not_awarded_notes: 'All customers declined.', next_followup_date: null, updated_at: ts(),
    }});
    const proj = await M.Project.findById(bid.project_id).lean();
    await events.safeEmit('bid.stage_changed', {
      project_id: bid.project_id, bid_id: bid._id, actor_id: actorId || null,
      payload: { from: 'submitted', to: 'not_awarded', project_name: proj?.name || null },
    });
  }
  return { submission_id: sub._id, bid_id: bid._id };
}

// ── opportunity / active_bid → closed ─────────────────────────────────────────
async function closeBid(id, data, actorId) {
  const M = getModels();
  const bid = await loadBid(id);
  if (!['opportunity', 'active_bid'].includes(bid.stage)) throw new Error(`Cannot close from stage '${bid.stage}'`);
  require_(data, ['closed_date', 'closed_approved_by', 'close_reason']);
  const fromStage = bid.stage;
  await M.Bid.updateOne({ _id: bid._id }, { $set: {
    stage: 'closed', closed_date: data.closed_date,
    closed_approved_by: data.closed_approved_by, close_reason: data.close_reason,
    updated_at: ts(),
  }});
  const proj = await M.Project.findById(bid.project_id).lean();
  await events.safeEmit('bid.stage_changed', {
    project_id: bid.project_id, bid_id: bid._id, actor_id: actorId || null,
    payload: { from: fromStage, to: 'closed', project_name: proj?.name || null },
  });
  return { bid_id: bid._id };
}

// ── Follow-up logging (bid or change_order; no_decision restarts the timer) ───
async function logFollowupV2(data) {
  const M = getModels();
  require_(data, ['parent_type', 'parent_id', 'contact_method', 'notes']);
  const s = await getSettings();
  const outcome = data.outcome || 'no_decision';
  const next = outcome === 'no_decision' ? addWorkingDays(today(), s.fu_recurring_days) : null;

  const fu = await M.Followup.create({
    _id: await nextId('followups'),
    parent_type: data.parent_type, parent_id: Number(data.parent_id),
    followup_date: data.followup_date || today(),
    contacted_by: data.contacted_by ? Number(data.contacted_by) : null,
    contact_method: data.contact_method,
    customer_contact: data.customer_contact || null,
    notes: data.notes, outcome, next_followup_date: next,
  });

  if (outcome === 'no_decision') {
    if (data.parent_type === 'bid_submission') {
      await M.BidSubmission.updateOne({ _id: Number(data.parent_id) }, { $set: { next_followup_date: next, updated_at: ts() } });
      const sub = await M.BidSubmission.findById(Number(data.parent_id)).lean();
      if (sub) await recomputeBidFollowup(sub.bid_id);   // roll the bid's f/u date up from its submissions
    } else {
      const Model = data.parent_type === 'bid' ? M.Bid : M.ChangeOrder;
      await Model.updateOne({ _id: Number(data.parent_id) }, { $set: { next_followup_date: next, updated_at: ts() } });
    }
  }
  return { followup_id: fu._id, next_followup_date: next };
}

// ── Reminders (polymorphic — bid or change_order) ─────────────────────────────
async function addReminder(parentType, parentId, { note, remind_on }) {
  if (!remind_on) throw new Error('remind_on required');
  const M = getModels();
  const id = await nextId('reminders');
  await M.Reminder.create({ _id: id, parent_type: parentType, parent_id: Number(parentId), note: note || null, remind_on, dismissed: 0, emailed: 0 });
  return { id };
}
async function dismissReminder(id) {
  const M = getModels();
  const r = await M.Reminder.updateOne({ _id: Number(id) }, { $set: { dismissed: 1 } });
  if (!r.matchedCount) throw new Error('Reminder not found');
  return { ok: true };
}
async function deleteReminder(id) {
  const M = getModels();
  await M.Reminder.deleteOne({ _id: Number(id) });
  return { ok: true };
}
async function getRemindersFor(parentType, parentId) {
  const M = getModels();
  return M.Reminder.find({ parent_type: parentType, parent_id: Number(parentId) }).sort({ remind_on: 1 }).lean();
}
// For the daily reminder-email cron — due, not dismissed, not yet emailed.
// Returns each reminder alongside the estimator/salesperson (bid) or
// estimator (change_order) ids who should be notified.
async function getDueReminders() {
  const M = getModels();
  const todayStr = today();
  const due = await M.Reminder.find({ remind_on: { $lte: todayStr }, dismissed: { $ne: 1 }, emailed: { $ne: 1 } }).lean();
  const out = [];
  for (const r of due) {
    let recipientIds = [];
    if (r.parent_type === 'bid') {
      const bid = await M.Bid.findById(r.parent_id).lean();
      if (bid) recipientIds = [bid.estimator_id, bid.salesperson_id].filter(Boolean);
    } else if (r.parent_type === 'change_order') {
      const co = await M.ChangeOrder.findById(r.parent_id).lean();
      if (co) recipientIds = [co.estimator_id].filter(Boolean);
    }
    out.push({ reminder: r, recipientIds: [...new Set(recipientIds)] });
  }
  return out;
}
async function markReminderEmailed(id) {
  const M = getModels();
  await M.Reminder.updateOne({ _id: Number(id) }, { $set: { emailed: 1 } });
}

// Notes — dateless, freeform, append-only log on a bid/opportunity or change
// order. Distinct from Reminder (a dated tickler) and from the entity's own
// single `notes` description field.
async function addNote(parentType, parentId, { text }, actorId) {
  if (!text || !text.trim()) throw new Error('Note text is required');
  const M = getModels();
  const id = await nextId('notes');
  await M.Note.create({ _id: id, parent_type: parentType, parent_id: Number(parentId), text: text.trim(), created_by: actorId || null });
  return { id };
}
async function deleteNote(id) {
  const M = getModels();
  await M.Note.deleteOne({ _id: Number(id) });
  return { ok: true };
}
async function getNotesFor(parentType, parentId) {
  const M = getModels();
  return M.Note.find({ parent_type: parentType, parent_id: Number(parentId) }).sort({ created_at: -1 }).lean();
}

// Job # format is Foundation's: digits only, 5-6 chars (customer # + 3-digit
// sequence). Clearing to null is always allowed; existing stored numbers are
// NOT retro-validated (only enforced when a number is being SET).
async function validateJobNumber(M, jobNumber, excludeJobId) {
  if (jobNumber == null) return;
  if (!/^\d{5,6}$/.test(jobNumber)) {
    throw new Error('Job numbers are 5-6 digits, no dashes (e.g. 18002). This must match Foundation.');
  }
  const query = { job_number: jobNumber };
  if (excludeJobId != null) query._id = { $ne: excludeJobId };
  const conflict = await M.Job.findOne(query).lean();
  if (conflict) {
    const proj = await M.Project.findById(conflict.project_id).lean();
    throw new Error(`Job number ${jobNumber} is already in use on "${proj ? proj.name : 'another project'}".`);
  }
}

// ── Job: manual creation (legacy) + accounting/PM updates ─────────────────────
async function createLegacyJob(data) {
  const M = getModels();
  let pid = data.project_id ? Number(data.project_id) : null;
  let isNewProject = false;
  if (!pid) {
    require_(data, ['project_name']);
    pid = await nextId('projects');
    await M.Project.create({ _id: pid, name: data.project_name.trim(), created_by: data.created_by || null });
    isNewProject = true;
  }
  const jobNumber = data.job_number || null;
  await validateJobNumber(M, jobNumber, null);
  const jobId = await nextId('jobs');
  const awardedCompanyId = data.awarded_company_id ? Number(data.awarded_company_id)
    : (data.new_company ? await resolveCompanyByName(data.new_company) : null);
  const pmId = data.pm_id ? Number(data.pm_id) : null;
  await M.Job.create({
    _id: jobId, project_id: pid, winning_bid_id: null,   // legacy — no bid in system
    job_number: jobNumber,
    awarded_company_id: awardedCompanyId,
    pm_id: pmId,
    award_date: data.award_date || null,
  });

  const actorId = data.created_by ? Number(data.created_by) : null;
  const [proj, company] = await Promise.all([
    M.Project.findById(pid).lean(),
    awardedCompanyId ? M.Company.findById(awardedCompanyId).lean() : null,
  ]);
  if (isNewProject) {
    await events.safeEmit('project.created', { project_id: pid, actor_id: actorId, payload: { name: proj.name } });
  }
  await events.safeEmit('job.created', {
    project_id: pid, job_id: jobId, actor_id: actorId,
    payload: { project_name: proj?.name || null, company_name: company?.name || null, award_date: data.award_date || null, pm_id: pmId, from_bid: false },
  });
  if (jobNumber) {
    await events.safeEmit('job.number_assigned', {
      project_id: pid, job_id: jobId, job_number: jobNumber, actor_id: actorId,
      payload: { project_name: proj?.name || null, job_number: jobNumber },
    });
  }
  return { project_id: pid, job_id: jobId };
}

async function updateJob(id, data, actorId) {
  const M = getModels();
  const jobId = Number(id);
  const before = await M.Job.findById(jobId).lean();
  if (!before) throw new Error('Job not found');

  const upd = { updated_at: ts() };
  if ('job_number' in data) {
    const jobNumber = data.job_number || null;
    if (jobNumber !== before.job_number) await validateJobNumber(M, jobNumber, jobId);
    upd.job_number = jobNumber;
  }
  if ('pm_id' in data) upd.pm_id = data.pm_id ? Number(data.pm_id) : null;
  const r = await M.Job.updateOne({ _id: jobId }, { $set: upd });
  if (!r.matchedCount) throw new Error('Job not found');

  const proj = await M.Project.findById(before.project_id).lean();
  if ('job_number' in upd && upd.job_number !== before.job_number) {
    if (!before.job_number && upd.job_number) {
      await events.safeEmit('job.number_assigned', {
        project_id: before.project_id, job_id: jobId, job_number: upd.job_number, actor_id: actorId || null,
        payload: { project_name: proj?.name || null, job_number: upd.job_number },
      });
    } else if (before.job_number && upd.job_number) {
      await events.safeEmit('job.number_changed', {
        project_id: before.project_id, job_id: jobId, job_number: upd.job_number, actor_id: actorId || null,
        payload: { previous: before.job_number, job_number: upd.job_number, project_name: proj?.name || null },
      });
    }
  }
  if ('pm_id' in upd && upd.pm_id !== before.pm_id) {
    const pm = upd.pm_id ? await M.TeamMember.findById(upd.pm_id).lean() : null;
    await events.safeEmit('job.pm_assigned', {
      project_id: before.project_id, job_id: jobId, actor_id: actorId || null,
      payload: { pm_id: upd.pm_id, pm_name: pm?.name || null, project_name: proj?.name || null, job_number: upd.job_number ?? before.job_number },
    });
  }
  return { job_id: jobId };
}

// ── Change Orders ─────────────────────────────────────────────────────────────
// Shared lookup for CO event payloads — project name + job # via the CO's Job.
async function _coEventContext(M, co) {
  const job = await M.Job.findById(co.job_id).lean();
  if (!job) return { project_id: null, project_name: null, job_number: null };
  const proj = await M.Project.findById(job.project_id).lean();
  return { project_id: job.project_id, project_name: proj?.name || null, job_number: job.job_number || null };
}

async function createChangeOrder(jobId, data, actorId) {
  const M = getModels();
  const job = await M.Job.findById(Number(jobId)).lean();
  if (!job) throw new Error('A change order cannot exist without a Job');
  require_(data, ['co_number', 'name', 'due_date', 'start_date']);
  const coId = await nextId('change_orders');
  await M.ChangeOrder.create({
    _id: coId, job_id: job._id, stage: 'active_co',
    co_number: data.co_number, name: data.name,
    due_date: data.due_date, start_date: data.start_date,
    estimator_id: data.estimator_id ? Number(data.estimator_id) : null,
    notes: data.notes || null,
  });
  const proj = await M.Project.findById(job.project_id).lean();
  await events.safeEmit('co.created', {
    project_id: job.project_id, job_id: job._id, co_id: coId, actor_id: actorId || null,
    payload: { co_number: data.co_number, name: data.name, project_name: proj?.name || null, job_number: job.job_number || null },
  });
  return { co_id: coId };
}

async function submitCO(id, data, actorId) {
  const M = getModels();
  const co = await loadCO(id);
  if (co.stage !== 'active_co') throw new Error(`Cannot submit CO from stage '${co.stage}'`);
  require_(data, ['estimate_amount', 'date_submitted', 'approved_by']);
  requireNonZeroAmount(data.estimate_amount);
  const s = await getSettings();
  const next = addWorkingDays(data.date_submitted, s.fu_initial_days);
  await M.ChangeOrder.updateOne({ _id: co._id }, { $set: {
    stage: 'submitted_co', was_submitted: 1,
    estimate_amount: Number(data.estimate_amount),
    date_submitted: data.date_submitted, approved_by: data.approved_by,
    next_followup_date: next, updated_at: ts(),
  }});
  const ctx = await _coEventContext(M, co);
  await events.safeEmit('co.stage_changed', {
    project_id: ctx.project_id, job_id: co.job_id, co_id: co._id, actor_id: actorId || null,
    payload: { co_number: co.co_number, from: 'active_co', to: 'submitted_co', amount: Number(data.estimate_amount), project_name: ctx.project_name, job_number: ctx.job_number },
  });
  return { co_id: co._id, next_followup_date: next };
}

async function approveCO(id, data, actorId) {
  const M = getModels();
  const co = await loadCO(id);
  if (co.stage !== 'submitted_co') throw new Error(`Cannot approve CO from stage '${co.stage}'`);
  require_(data, ['approval_date']);
  await M.ChangeOrder.updateOne({ _id: co._id }, { $set: {
    stage: 'approved', approval_date: data.approval_date,
    next_followup_date: null, updated_at: ts(),
  }});
  const ctx = await _coEventContext(M, co);
  await events.safeEmit('co.stage_changed', {
    project_id: ctx.project_id, job_id: co.job_id, co_id: co._id, actor_id: actorId || null,
    payload: { co_number: co.co_number, from: 'submitted_co', to: 'approved', amount: co.estimate_amount, project_name: ctx.project_name, job_number: ctx.job_number },
  });
  return { co_id: co._id };
}

async function notApproveCO(id, data, actorId) {
  const M = getModels();
  const co = await loadCO(id);
  if (co.stage !== 'submitted_co') throw new Error(`Cannot mark not-approved from stage '${co.stage}'`);
  require_(data, ['date_not_approved']);
  await M.ChangeOrder.updateOne({ _id: co._id }, { $set: {
    stage: 'not_approved', date_not_approved: data.date_not_approved,
    not_approved_notes: data.not_approved_notes || null,
    next_followup_date: null, updated_at: ts(),
  }});
  const ctx = await _coEventContext(M, co);
  await events.safeEmit('co.stage_changed', {
    project_id: ctx.project_id, job_id: co.job_id, co_id: co._id, actor_id: actorId || null,
    payload: { co_number: co.co_number, from: 'submitted_co', to: 'not_approved', amount: co.estimate_amount, project_name: ctx.project_name, job_number: ctx.job_number },
  });
  return { co_id: co._id };
}

async function voidCO(id, data, actorId) {
  const M = getModels();
  const co = await loadCO(id);
  if (!['active_co', 'submitted_co'].includes(co.stage)) throw new Error(`Cannot void CO from stage '${co.stage}'`);
  require_(data, ['void_reason']);
  const fromStage = co.stage;
  await M.ChangeOrder.updateOne({ _id: co._id }, { $set: {
    stage: 'voided', void_reason: data.void_reason,
    next_followup_date: null, updated_at: ts(),
  }});
  const ctx = await _coEventContext(M, co);
  await events.safeEmit('co.stage_changed', {
    project_id: ctx.project_id, job_id: co.job_id, co_id: co._id, actor_id: actorId || null,
    payload: { co_number: co.co_number, from: fromStage, to: 'voided', amount: co.estimate_amount, project_name: ctx.project_name, job_number: ctx.job_number },
  });
  return { co_id: co._id };
}

// Reopen: voided/not_approved → submitted_co if previously submitted, else active_co.
// Anyone can reopen (per spec Q2). Timer restarts when returning to submitted_co.
async function reopenCO(id, actorId) {
  const M = getModels();
  const co = await loadCO(id);
  if (!['voided', 'not_approved'].includes(co.stage)) throw new Error(`Cannot reopen CO from stage '${co.stage}'`);
  const fromStage = co.stage;
  const target = co.was_submitted ? 'submitted_co' : 'active_co';
  const s = await getSettings();
  await M.ChangeOrder.updateOne({ _id: co._id }, { $set: {
    stage: target,
    void_reason: null, date_not_approved: null, not_approved_notes: null,
    next_followup_date: target === 'submitted_co' ? addWorkingDays(today(), s.fu_recurring_days) : null,
    updated_at: ts(),
  }});
  const ctx = await _coEventContext(M, co);
  await events.safeEmit('co.stage_changed', {
    project_id: ctx.project_id, job_id: co.job_id, co_id: co._id, actor_id: actorId || null,
    payload: { co_number: co.co_number, from: fromStage, to: target, amount: co.estimate_amount, project_name: ctx.project_name, job_number: ctx.job_number },
  });
  return { co_id: co._id, stage: target };
}

// Revise a change order — scope/pricing changes on a CO happen constantly
// (same idea as a bid revision/re-bid), so rather than editing history in
// place, create a new CO under the same job carrying forward whatever
// wasn't explicitly changed, and mark the old one superseded (hidden from
// active lists, same as a superseded bid, but still visible — dimmed — in
// the project hierarchy for history). Not allowed on an already-superseded
// or voided CO (revise a voided CO by reopening it first).
async function reviseCO(id, data) {
  const M = getModels();
  const co = await loadCO(id);
  if (co.superseded) throw new Error('This CO has already been revised — find the newer version instead.');
  if (co.stage === 'voided') throw new Error("Can't revise a voided CO — reopen it first if it's coming back.");
  const newId = await nextId('change_orders');
  await M.ChangeOrder.create({
    _id: newId, job_id: co.job_id, stage: 'active_co',
    co_number: data.co_number || co.co_number,
    name: data.name || co.name,
    due_date: data.due_date || co.due_date,
    start_date: data.start_date || co.start_date,
    estimator_id: data.estimator_id ? Number(data.estimator_id) : co.estimator_id,
    notes: data.notes || null,
  });
  await M.ChangeOrder.updateOne({ _id: co._id }, { $set: { superseded: 1, next_followup_date: null, updated_at: ts() } });
  return { co_id: newId, job_id: co.job_id };
}

// ═══════════════════════════════════════════════════════════════════════════
// DATA HEALTH — buckets the dataset's quality issues so cleanup is a punch-list
// ═══════════════════════════════════════════════════════════════════════════
function _norm(v) {
  return String(v || '').toLowerCase().replace(/[.']/g, '').replace(/[,"&\/()-]/g, ' ')
    .replace(/\b(inc|llc|llp|lp|corp|co|company|group|construction|builders|contracting|contractors)\b/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/\b([a-z]) (?=[a-z]\b)/g, '$1');
}
function _lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  const prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { let diag = prev[0]; prev[0] = i; for (let j = 1; j <= n; j++) { const t = prev[j]; prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1)); diag = t; } }
  return prev[n];
}
// Cluster items ({id,name,key,...}) that are the same/typo/prefix of each other.
// `ignore` is a Set of "minId:maxId" pairs that must never be clustered together.
// `opts.firstWordMatch` additionally clusters when one whole normalized name
// IS the first word of the other (e.g. "Gilbane, Inc" normalizes to the bare
// word "gilbane", which is the first word of "Gilbane Building Company"'s
// "gilbane building" — at 7 chars the plain prefix/typo checks below, which
// require 8-10 chars to avoid false positives, miss it). Deliberately
// requires the SHORTER side to be nothing but that one word — a name with
// its own extra words (e.g. "Philadelphia Museum of Art" vs "Philadelphia
// Parking Authority") won't match just because they share a common opening
// word. Opt-in only for company matching: turning this on for contacts
// would false-positive on any two people who share a first name.
function _clusterSimilar(items, ignore, opts = {}) {
  const parent = items.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { parent[find(a)] = find(b); };
  const words = (k) => (k || '').split(' ').filter(Boolean);
  const bareVsFirstWord = (shortWords, longWords) =>
    shortWords.length === 1 && shortWords[0].length >= 5 && longWords.length > 1 && longWords[0] === shortWords[0];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i].key, b = items[j].key; if (!a || !b) continue;
    const same = a === b;
    const prefix = a.length >= 10 && b.length >= 10 && (a.startsWith(b) || b.startsWith(a));
    const typo = a.length >= 8 && b.length >= 8 && Math.abs(a.length - b.length) <= 2 && _lev(a, b) <= 1;
    let wordMatch = false;
    if (opts.firstWordMatch) {
      const wa = words(a), wb = words(b);
      wordMatch = bareVsFirstWord(wa, wb) || bareVsFirstWord(wb, wa);
    }
    if (!(same || prefix || typo || wordMatch)) continue;
    if (ignore && ignore.has(Math.min(items[i].id, items[j].id) + ':' + Math.max(items[i].id, items[j].id))) continue;
    union(i, j);
  }
  const groups = {};
  items.forEach((it, i) => { const r = find(i); (groups[r] = groups[r] || []).push(it); });
  return Object.values(groups).filter(g => g.length > 1).sort((a, b) => b.length - a.length);
}

// ── Bid list for a stage (working views) ──────────────────────────────────────
// ── Global search — across Bids AND Change Orders, all stages ────────────────
// Unlike v1 (which only regex-matched Bid.project_name/bid_number/customer/
// job_number, since those were the only fields it had), v2 can match on the
// real entities: Company name (via BidCustomer), Job #, and CO # — no more
// free-text customer guessing. Contact search is added once the Contacts UI
// exists (v1 parity item, tracked separately).
async function getSearchResults(q) {
  const M = getModels();
  const needle = String(q || '').trim().toLowerCase();
  if (needle.length < 2) return { bids: [], change_orders: [] };

  const [bids, cos, jobs, projects, companies, members, bidCustomers] = await Promise.all([
    M.Bid.find({ superseded: { $ne: 1 } }).lean(),
    M.ChangeOrder.find().lean(),
    M.Job.find().lean(),
    M.Project.find().lean(),
    M.Company.find().lean(),
    M.TeamMember.find().lean(),
    M.BidCustomer.find().lean(),
  ]);
  const pName = {}; projects.forEach(p => pName[p._id] = p.name);
  const coName = {}; companies.forEach(c => coName[c._id] = c.name);
  const jobById = {}; jobs.forEach(j => jobById[j._id] = j);
  const tm = teamMap(members);
  const custByBid = {}; bidCustomers.forEach(bc => (custByBid[bc.bid_id] = custByBid[bc.bid_id] || []).push(coName[bc.company_id]));
  const hit = (...fields) => fields.some(f => f && String(f).toLowerCase().includes(needle));

  const matchedBids = bids
    .filter(b => hit(pName[b.project_id], b.bid_number, ...(custByBid[b._id] || [])))
    .map(b => ({
      id: b._id, project_id: b.project_id, project: pName[b.project_id] || '—',
      bid_number: b.bid_number, stage: b.stage,
      estimator: tm[b.estimator_id] || null, salesperson: tm[b.salesperson_id] || null,
      customers: [...new Set((custByBid[b._id] || []).filter(Boolean))],
      estimate_amount: b.estimate_amount, due_date: b.due_date, next_followup_date: b.next_followup_date,
    }));

  const matchedCos = cos
    .filter(c => !c.superseded)
    .filter(c => { const j = jobById[c.job_id]; return hit(c.co_number, c.name, j?.job_number, j ? pName[j.project_id] : null); })
    .map(c => {
      const job = jobById[c.job_id];
      return {
        id: c._id, co_number: c.co_number, name: c.name, stage: c.stage,
        project: job ? (pName[job.project_id] || '—') : '—', project_id: job ? job.project_id : null,
        job_number: job ? job.job_number : null,
        estimator: tm[c.estimator_id] || null, salesperson: job?.pm_id ? (tm[job.pm_id] || null) : null,
        due_date: c.due_date,
        estimate_amount: c.estimate_amount, next_followup_date: c.next_followup_date,
      };
    });

  return { bids: matchedBids, change_orders: matchedCos };
}

async function getBidList(stage) {
  const M = getModels();
  const bids = await M.Bid.find({ stage, superseded: { $ne: 1 } }).sort({ due_date: 1, _id: 1 }).lean();
  const ids = bids.map(b => b._id);
  const [projects, companies, members, bidCustomers] = await Promise.all([
    M.Project.find().lean(), M.Company.find().lean(), M.TeamMember.find().lean(), M.BidCustomer.find({ bid_id: { $in: ids } }).lean(),
  ]);
  const pName = {}; projects.forEach(p => pName[p._id] = p.name);
  const coName = {}; companies.forEach(c => coName[c._id] = c.name);
  const tm = teamMap(members);
  const custByBid = {}; bidCustomers.forEach(bc => (custByBid[bc.bid_id] = custByBid[bc.bid_id] || []).push(coName[bc.company_id]));
  return bids.map(b => ({
    id: b._id, project_id: b.project_id, project: pName[b.project_id] || '—',
    bid_number: b.bid_number, stage: b.stage, drawing_stage: b.drawing_stage,
    estimator: tm[b.estimator_id] || null, salesperson: tm[b.salesperson_id] || null,
    sub_estimators: (b.sub_estimators || []).map(s => ({ ...(tm[s.estimator_id] || {}), scope: s.scope })),
    customers: [...new Set((custByBid[b._id] || []).filter(Boolean))],
    date_received: b.date_received, due_date: b.due_date,
    estimate_amount: b.estimate_amount, date_submitted: b.date_submitted, next_followup_date: b.next_followup_date,
  }));
}

// ── Change order list for a stage ─────────────────────────────────────────────
async function getCoList(stage) {
  const M = getModels();
  const filter = stage ? { stage, superseded: { $ne: 1 } } : { stage: { $in: ['active_co', 'submitted_co'] }, superseded: { $ne: 1 } };
  const cos = await M.ChangeOrder.find(filter).sort({ due_date: 1, _id: 1 }).lean();
  const [jobs, projects, members] = await Promise.all([M.Job.find().lean(), M.Project.find().lean(), M.TeamMember.find().lean()]);
  const jobById = {}; jobs.forEach(j => jobById[j._id] = j);
  const pName = {}; projects.forEach(p => pName[p._id] = p.name);
  const tm = teamMap(members);
  return cos.map(c => {
    const job = jobById[c.job_id];
    return {
      id: c._id, co_number: c.co_number, name: c.name, stage: c.stage,
      project: job ? (pName[job.project_id] || '—') : '—', project_id: job ? job.project_id : null,
      job_number: job ? job.job_number : null,
      estimator: tm[c.estimator_id] || null,
      // The job's PM owns CO follow-up (same role a bid's salesperson plays
      // for bid follow-up) — surfaced under the same key so the frontend can
      // treat "who follows up" consistently across bids and COs.
      salesperson: job?.pm_id ? (tm[job.pm_id] || null) : null,
      due_date: c.due_date,
      estimate_amount: c.estimate_amount, date_submitted: c.date_submitted, next_followup_date: c.next_followup_date,
    };
  });
}

// ── Dashboard rollups (v2) ────────────────────────────────────────────────────
// ── Weekly Digest — replaces the Monday status meeting ────────────────────────
// Same shape v1's getDigest() produced (so mailer.js's emailDigest template
// works unchanged) plus two v2-only sections (coDueSoon/coOverdueFollowups)
// since v2 splits Change Orders into their own collection instead of folding
// them into Bid rows. Overdue follow-ups intentionally stay LAST in both the
// web and email versions (a prior, explicit ask — don't bury the good news
// under the bad news at the top).
async function getDigest() {
  const M = getModels();
  const todayStr = today();
  const weekAgo = addDays(todayStr, -7);
  const twoWeeksAgo = addDays(todayStr, -14);
  const thirtyAgo = addDays(todayStr, -30);
  const monthAhead = addDays(todayStr, 30);
  const twoWeeksAhead = addDays(todayStr, 14);
  const yearStart = todayStr.slice(0, 4) + '-01-01';
  const CLOSED = ['awarded', 'not_awarded', 'closed'];

  const [bids, cos, jobs, projects, companies, members, bidCustomers] = await Promise.all([
    M.Bid.find({ superseded: { $ne: 1 } }).lean(),
    M.ChangeOrder.find({ superseded: { $ne: 1 } }).lean(),
    M.Job.find().lean(),
    M.Project.find().lean(),
    M.Company.find().lean(),
    M.TeamMember.find({ active: 1 }).lean(),
    M.BidCustomer.find().lean(),
  ]);
  const pName = {}; projects.forEach(p => pName[p._id] = p.name);
  const coName = {}; companies.forEach(c => coName[c._id] = c.name);
  const jobProj = {}; jobs.forEach(j => jobProj[j._id] = j.project_id);
  const tm = teamMap(members);
  const custByBid = {}; bidCustomers.forEach(bc => (custByBid[bc.bid_id] = custByBid[bc.bid_id] || []).push(coName[bc.company_id]));

  const shapeBid = (b) => ({
    id: b._id, project_id: b.project_id, project_name: pName[b.project_id] || '—', bid_number: b.bid_number, stage: b.stage,
    customer: [...new Set((custByBid[b._id] || []).filter(Boolean))].join(', '),
    estimator_initials: tm[b.estimator_id]?.initials || null,
    salesperson_initials: tm[b.salesperson_id]?.initials || null,
    estimate_amount: b.estimate_amount, estimate_due_date: b.due_date, next_followup_date: b.next_followup_date,
  });
  const shapeCo = (c) => {
    const job = jobs.find(j => j._id === c.job_id);
    return {
      id: c._id, project_id: job ? job.project_id : null, project_name: `${c.co_number} — ${c.name}`, bid_number: job ? pName[job.project_id] : null,
      estimator_initials: tm[c.estimator_id]?.initials || null,
      // The job's PM owns CO follow-up, same role the salesperson plays for
      // bids — reuse the salesperson_initials key so the shared row renderer
      // shows "who follows up" consistently for both bids and COs.
      salesperson_initials: job?.pm_id ? (tm[job.pm_id]?.initials || null) : null,
      estimate_amount: c.estimate_amount, estimate_due_date: c.due_date, next_followup_date: c.next_followup_date,
    };
  };

  // Pipeline snapshot: opportunities/active bids/active COs are current
  // pipeline counts (no $ — nothing's been priced/committed yet). Submitted
  // bids & COs are the only rows worth a $ value, shown as both a 30-day
  // window and year-to-date since "currently submitted" isn't the same
  // question as "how much did we submit."
  // "Active Change Orders" means stage === 'active_co' only, matching the
  // Active Change Orders list page — submitted_co is its own separate
  // count/list. `liveCos` (both stages) is only for the due-soon calc below,
  // since a submitted CO can still have an upcoming due date worth flagging.
  const activeCos = cos.filter(c => c.stage === 'active_co');
  const liveCos = cos.filter(c => ['active_co', 'submitted_co'].includes(c.stage));
  const submittedBids30 = bids.filter(b => b.date_submitted && b.date_submitted >= thirtyAgo && b.date_submitted <= todayStr);
  const submittedBidsYTD = bids.filter(b => b.date_submitted && b.date_submitted >= yearStart && b.date_submitted <= todayStr);
  const submittedCos30 = cos.filter(c => c.date_submitted && c.date_submitted >= thirtyAgo && c.date_submitted <= todayStr);
  const submittedCosYTD = cos.filter(c => c.date_submitted && c.date_submitted >= yearStart && c.date_submitted <= todayStr);
  const pipelineSnapshot = {
    opportunities: bids.filter(b => b.stage === 'opportunity').length,
    activeBids: bids.filter(b => b.stage === 'active_bid').length,
    activeCos: activeCos.length,
    submittedBids: {
      last30: { count: submittedBids30.length, value: submittedBids30.reduce((s, b) => s + (b.estimate_amount || 0), 0) },
      ytd: { count: submittedBidsYTD.length, value: submittedBidsYTD.reduce((s, b) => s + (b.estimate_amount || 0), 0) },
    },
    submittedCos: {
      last30: { count: submittedCos30.length, value: submittedCos30.reduce((s, c) => s + (c.estimate_amount || 0), 0) },
      ytd: { count: submittedCosYTD.length, value: submittedCosYTD.reduce((s, c) => s + (c.estimate_amount || 0), 0) },
    },
  };

  const byEstimator = members.filter(m => m.role === 'estimator').map(m => {
    // Counts a bid whether this estimator is the primary or a sub-estimator
    // on a broken-out system (Fire Alarm, Lighting Controls, etc.) — either
    // way it's real work on their plate.
    const l = bids.filter(b => !CLOSED.includes(b.stage) && (b.estimator_id === m._id || (b.sub_estimators || []).some(s => s.estimator_id === m._id)));
    return { id: m._id, name: m.name, initials: m.initials, bid_count: l.length, total_value: l.reduce((s, b) => s + (b.estimate_amount || 0), 0) };
  }).sort((a, b) => b.bid_count - a.bid_count);

  const bySalesperson = members.filter(m => m.role === 'sales').map(m => {
    const l = bids.filter(b => b.salesperson_id === m._id);
    const overdue = l.filter(b => b.next_followup_date && b.next_followup_date < todayStr && !CLOSED.includes(b.stage)).length;
    return { id: m._id, name: m.name, initials: m.initials, bid_count: l.filter(b => !CLOSED.includes(b.stage)).length, overdue_followups: overdue };
  }).sort((a, b) => b.overdue_followups - a.overdue_followups || b.bid_count - a.bid_count);

  // New this week — split by type so the reader doesn't have to eyeball stage.
  const newBidsThisWeek = bids.filter(b => b.created_at >= weekAgo);
  const newOpportunities = newBidsThisWeek.filter(b => b.stage === 'opportunity').sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).map(shapeBid);
  const newActiveBids = newBidsThisWeek.filter(b => b.stage === 'active_bid').sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).map(shapeBid);
  const newActiveCos = cos.filter(c => c.created_at >= weekAgo).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).map(shapeCo);

  // Submitted last 2 weeks, grouped by estimator (flat chronological list was
  // hard to scan across a big team — grouping mirrors "By Estimator" above).
  const submittedLast2Weeks = bids.filter(b => b.date_submitted && b.date_submitted >= twoWeeksAgo && b.date_submitted <= todayStr);
  const submittedByEstimator = members.filter(m => m.role === 'estimator').map(m => ({
    id: m._id, name: m.name, initials: m.initials,
    bids: submittedLast2Weeks.filter(b => b.estimator_id === m._id).sort((a, b) => (b.date_submitted || '').localeCompare(a.date_submitted || '')).map(shapeBid),
  })).filter(g => g.bids.length).sort((a, b) => b.bids.length - a.bids.length);
  const submittedNoEstimator = submittedLast2Weeks.filter(b => !b.estimator_id).map(shapeBid);

  const awardedThisWeek = bids.filter(b => b.stage === 'awarded' && b.award_date >= weekAgo && b.award_date <= todayStr).sort((a, b) => (a.award_date || '').localeCompare(b.award_date || '')).map(shapeBid);
  const notAwardedThisWeek = bids.filter(b => b.stage === 'not_awarded' && b.updated_at >= weekAgo).map(shapeBid);
  const upcomingDueDates = bids.filter(b => ['opportunity', 'active_bid', 'submitted'].includes(b.stage) && b.due_date >= todayStr && b.due_date <= monthAhead).sort((a, b) => (a.due_date || '').localeCompare(b.due_date || '')).map(shapeBid);
  const overdueFollowups = bids.filter(b => b.stage === 'submitted' && b.next_followup_date && b.next_followup_date < todayStr).sort((a, b) => (a.next_followup_date || '').localeCompare(b.next_followup_date || '')).map(shapeBid);

  const coDueSoon = liveCos.filter(c => c.due_date >= todayStr && c.due_date <= monthAhead).sort((a, b) => (a.due_date || '').localeCompare(b.due_date || '')).map(shapeCo);
  const coOverdueFollowups = cos.filter(c => c.stage === 'submitted_co' && c.next_followup_date && c.next_followup_date < todayStr).sort((a, b) => (a.next_followup_date || '').localeCompare(b.next_followup_date || '')).map(shapeCo);

  const reminders = await M.Reminder.find({ dismissed: { $ne: 1 }, remind_on: { $gte: todayStr, $lte: twoWeeksAhead } }).sort({ remind_on: 1 }).lean();
  const upcomingReminders = reminders.map(r => {
    if (r.parent_type === 'bid') { const b = bids.find(x => x._id === r.parent_id); return b ? { kind: 'bid', bid_id: b._id, project_id: b.project_id, project_name: pName[b.project_id], bid_number: b.bid_number, rid: r._id, note: r.note, remind_on: r.remind_on } : null; }
    const c = cos.find(x => x._id === r.parent_id); if (!c) return null;
    return { kind: 'co', bid_id: c._id, project_id: jobProj[c.job_id] || null, project_name: `${c.co_number} — ${c.name}`, bid_number: null, rid: r._id, note: r.note, remind_on: r.remind_on };
  }).filter(Boolean);

  return {
    generatedAt: new Date().toISOString(), weekRange: { from: weekAgo, to: todayStr },
    pipelineSnapshot, byEstimator, bySalesperson,
    newOpportunities, newActiveBids, newActiveCos,
    submittedByEstimator, submittedNoEstimator,
    awardedThisWeek, notAwardedThisWeek,
    upcomingDueDates, coDueSoon, upcomingReminders,
    overdueFollowups, coOverdueFollowups,   // always last — rendered at the bottom
  };
}

// mineOnly/userId: "My View" (default in the UI) filters every bubble/list to
// bids/COs/jobs owned by that person — estimator_id or salesperson_id for
// bids, estimator_id for COs, pm_id (falling back to the winning bid's
// estimator/salesperson, since pm_id is often left blank at award time) for
// jobs still awaiting a job #.
async function getDashboard(userId, mineOnly) {
  const M = getModels();
  const [bids, cos, jobs, subs, companies, projects] = await Promise.all([
    M.Bid.find().lean(), M.ChangeOrder.find().lean(), M.Job.find().lean(),
    M.BidSubmission.find().lean(), M.Company.find().lean(), M.Project.find().lean(),
  ]);
  const uid = mineOnly && userId ? Number(userId) : null;
  const today = new Date().toISOString().split('T')[0];
  const yearStart = today.slice(0, 4) + '-01-01';
  const ago = (n) => new Date(Date.now() - n * 86400000).toISOString().split('T')[0];
  const ahead = (n) => new Date(Date.now() + n * 86400000).toISOString().split('T')[0];
  const pName = {}; projects.forEach(p => pName[p._id] = p.name);
  const coName = {}; companies.forEach(c => coName[c._id] = c.name);
  const bidById = {}; bids.forEach(b => bidById[b._id] = b);

  const isMyBid = (b) => !uid || b.estimator_id === uid || b.salesperson_id === uid || (b.sub_estimators || []).some(s => s.estimator_id === uid);
  const isMyCo = (c) => !uid || c.estimator_id === uid;
  const jobOwner = (j) => j.pm_id || bidById[j.winning_bid_id]?.estimator_id || bidById[j.winning_bid_id]?.salesperson_id || null;
  const isMyJob = (j) => !uid || jobOwner(j) === uid;

  const myBids = bids.filter(isMyBid), myCos = cos.filter(isMyCo);
  const stageCount = (st) => myBids.filter(b => b.stage === st && !b.superseded).length;
  const pipeline = {
    opportunity: stageCount('opportunity'),
    active_bid: stageCount('active_bid'),
  };
  // "Active Change Orders" bubble means stage === 'active_co' only, matching
  // the Active Change Orders list page it links to — submitted_co is a
  // separate stage with its own list/bubble, not part of this count.
  const activeCos = myCos.filter(c => c.stage === 'active_co' && !c.superseded);

  const submittedYTD = myBids.filter(b => b.date_submitted && b.date_submitted >= yearStart && b.date_submitted <= today);
  const awardedYTD = myBids.filter(b => b.stage === 'awarded' && b.award_date && b.award_date >= yearStart && b.award_date <= today);
  const awardedMissingDate = myBids.filter(b => b.stage === 'awarded' && !b.award_date).length;

  const overdueBids = subs.filter(s => s.is_current && s.outcome === 'pending' && s.next_followup_date && s.next_followup_date < today && (!uid || bidById[s.bid_id]?.salesperson_id === uid));
  const overdueCos = myCos.filter(c => c.stage === 'submitted_co' && !c.superseded && c.next_followup_date && c.next_followup_date < today);
  const dueSoon = myBids.filter(b => ['active_bid', 'submitted'].includes(b.stage) && !b.superseded && b.due_date && b.due_date >= today && b.due_date <= ahead(14)).sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));

  const myJobsPending = jobs.filter(j => !j.job_number).filter(isMyJob);

  return {
    mineOnly: !!uid,
    pipeline,
    activeCoCount: activeCos.length,
    submittedYTD: { count: submittedYTD.length },
    awardedYTD: { count: awardedYTD.length, value: awardedYTD.reduce((s, b) => s + (b.estimate_amount || 0), 0), missingAwardDate: awardedMissingDate,
      list: awardedYTD.slice(0, 8).sort((a,b)=>(b.award_date||'').localeCompare(a.award_date||'')).map(b => ({ id: b._id, project_id: b.project_id, bid_number: b.bid_number, project: pName[b.project_id], amount: b.estimate_amount, award_date: b.award_date, company: b.awarded_company_id ? coName[b.awarded_company_id] : null })) },
    overdueBidCount: overdueBids.length, overdueCoCount: overdueCos.length,
    dueSoon: dueSoon.slice(0, 15).map(b => ({ id: b._id, project_id: b.project_id, bid_number: b.bid_number, project: pName[b.project_id], due_date: b.due_date, stage: b.stage })),
    jobsPending: myJobsPending.length,
  };
}

async function getDataHealth() {
  const M = getModels();
  const [projects, bids, jobs, cos, companies, bidCustomers, contacts, submissions, reminders, members] = await Promise.all([
    M.Project.find().lean(), M.Bid.find().lean(), M.Job.find().lean(),
    M.ChangeOrder.find().lean(), M.Company.find().lean(), M.BidCustomer.find().lean(),
    M.Contact.find({ active: 1 }).lean(), M.BidSubmission.find().lean(), M.Reminder.find().lean(),
    M.TeamMember.find().lean(),
  ]);
  const tmName = {}; members.forEach(m => tmName[m._id] = m.name);
  const ignoredPairs = await M.IgnoredPair.find().lean();
  const ignoreSet = (kind) => new Set(ignoredPairs.filter(x => x.kind === kind).map(x => Math.min(x.a, x.b) + ':' + Math.max(x.a, x.b)));
  const overrides = (await M.CleanupOverride.find().sort({ _id: -1 }).lean()).map(o => ({ id: o._id, type: o.type, desc: _describeOverride(o) }));

  const bidsByProj = {}, jobsByProj = {}, cosByJob = {}, custByBid = {};
  bids.forEach(b => (bidsByProj[b.project_id] = bidsByProj[b.project_id] || []).push(b));
  jobs.forEach(j => (jobsByProj[j.project_id] = jobsByProj[j.project_id] || []).push(j));
  cos.forEach(c => (cosByJob[c.job_id] = cosByJob[c.job_id] || []).push(c));
  bidCustomers.forEach(bc => (custByBid[bc.bid_id] = custByBid[bc.bid_id] || []).push(bc));
  const projCo = (p) => (jobsByProj[p._id] || []).reduce((s, j) => s + (cosByJob[j._id] || []).length, 0);

  // near-duplicate projects / companies (merge candidates; honors "not a duplicate")
  const dupProjects = _clusterSimilar(projects.map(p => ({ id: p._id, name: p.name, key: _norm(p.name), bids: (bidsByProj[p._id] || []).length, cos: projCo(p) })), ignoreSet('project'));
  const dupCompanies = _clusterSimilar(companies.map(c => ({ id: c._id, name: c.name, key: _norm(c.name) })), ignoreSet('company'), { firstWordMatch: true });
  // Exact-duplicate bids — same bid # created twice under the same project
  // (e.g. a double-click or double-submit). Project-merge doesn't touch this
  // since it operates one level up; this is its own class of mistake.
  const pNameForDup = {}; projects.forEach(p => pNameForDup[p._id] = p.name);
  const bidsByProjNum = {};
  bids.forEach(b => { if (!b.bid_number || b.superseded) return; (bidsByProjNum[b.project_id + '|' + b.bid_number] = bidsByProjNum[b.project_id + '|' + b.bid_number] || []).push(b); });
  const dupBids = Object.values(bidsByProjNum).filter(g => g.length > 1).map(g => ({
    project_id: g[0].project_id, project: pNameForDup[g[0].project_id] || '?', bid_number: g[0].bid_number,
    bids: g.map(b => ({ id: b._id, stage: b.stage, estimate_amount: b.estimate_amount, created_at: b.created_at })),
  }));
  // projects with no bids — classify: legacy (has job/COs) vs empty (truly removable)
  const noBidProjects = projects.filter(p => !(bidsByProj[p._id])).map(p => {
    const jobN = (jobsByProj[p._id] || []).length, coN = projCo(p);
    return { id: p._id, name: p.name, jobs: jobN, cos: coN, empty: jobN === 0 && coN === 0 };
  }).sort((a, b) => (a.empty === b.empty ? b.cos - a.cos : a.empty ? -1 : 1));
  // jobs with no job # (awaiting accounting) — full list, not just a count,
  // so an admin can actually follow up on the specific ones (who's the PM,
  // how long it's been waiting) instead of just knowing a number.
  const jobsAwaitingNumber = jobs.filter(j => !j.job_number).map(j => ({
    id: j._id, project_id: j.project_id, project: pNameForDup[j.project_id] || '?',
    pm: j.pm_id ? (tmName[j.pm_id] || '?') : null, cos: (cosByJob[j._id] || []).length, created_at: j.created_at,
  })).sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  const jobsNoNumber = jobsAwaitingNumber.length;

  // Exact-duplicate change orders — same CO # created twice under one job
  // (same double-click/double-submit risk as duplicate bids). Voided COs are
  // excluded — a void is an intentional retirement, not a live duplicate.
  const cosByJobNum = {};
  cos.forEach(c => { if (!c.co_number || c.stage === 'voided' || c.superseded) return; (cosByJobNum[c.job_id + '|' + c.co_number] = cosByJobNum[c.job_id + '|' + c.co_number] || []).push(c); });
  const jobById2 = {}; jobs.forEach(j => jobById2[j._id] = j);
  const dupCOs = Object.values(cosByJobNum).filter(g => g.length > 1).map(g => {
    const job = jobById2[g[0].job_id];
    return {
      job_id: g[0].job_id, project: job ? (pNameForDup[job.project_id] || '?') : '?', job_number: job?.job_number || null,
      co_number: g[0].co_number,
      cos: g.map(c => ({ id: c._id, stage: c.stage, name: c.name, estimate_amount: c.estimate_amount, created_at: c.created_at })),
    };
  });

  // Duplicate jobs (same job # under one project) — the per-project hierarchy
  // view already surfaces + merges these one project at a time; this is the
  // same check run across ALL projects so it's visible without hunting.
  const jobsByProjNum = {};
  jobs.forEach(j => { if (!j.job_number) return; (jobsByProjNum[j.project_id + '|' + j.job_number] = jobsByProjNum[j.project_id + '|' + j.job_number] || []).push(j); });
  const dupJobs = Object.values(jobsByProjNum).filter(g => g.length > 1).map(g => ({
    project_id: g[0].project_id, project: pNameForDup[g[0].project_id] || '?', job_number: g[0].job_number,
    jobs: g.map(j => ({ id: j._id, winning_bid_id: j.winning_bid_id, cos: (cosByJob[j._id] || []).length })),
  }));

  // Duplicate contacts — same (normalized, fuzzy-matched) name at the SAME
  // company. Scoped per-company on purpose: two different real people
  // coincidentally named "John Smith" at two different companies are not a
  // duplicate. Confirmed happening in practice as a side effect of the
  // duplicate-bid bug (adding customers/contacts to both copies before the
  // duplicate bid was noticed).
  const companyName = {}; companies.forEach(c => companyName[c._id] = c.name);
  const contactsByCompany = {};
  contacts.forEach(c => { if (!c.company_id) return; (contactsByCompany[c.company_id] = contactsByCompany[c.company_id] || []).push(c); });
  let dupContacts = [];
  for (const [companyId, list] of Object.entries(contactsByCompany)) {
    const items = list.map(c => ({ id: c._id, name: [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)', key: _norm([c.first_name, c.last_name].filter(Boolean).join(' ')), phone: c.phone, email: c.email }));
    const groups = _clusterSimilar(items, ignoreSet('contact'));
    groups.forEach(g => dupContacts.push({ company_id: Number(companyId), company: companyName[companyId] || '?', contacts: g }));
  }

  // Companies with zero activity anywhere (no bids ever bid to them, no
  // contacts, never awarded) — safe to delete outright, same idea as
  // "Projects with no bids."
  const companyIdsWithActivity = new Set([
    ...bidCustomers.map(bc => bc.company_id),
    ...contacts.map(c => c.company_id).filter(Boolean),
    ...submissions.map(s => s.company_id),
    ...bids.filter(b => b.awarded_company_id).map(b => b.awarded_company_id),
    ...jobs.filter(j => j.awarded_company_id).map(j => j.awarded_company_id),
  ]);
  const emptyCompanies = companies.filter(c => !companyIdsWithActivity.has(c._id)).map(c => ({ id: c._id, name: c.name }));

  // FK integrity — counts of any reference pointing at a record that no
  // longer exists. Should always be zero; if not, it's a symptom of a bug
  // elsewhere, not something to silently paper over, so this just reports
  // counts rather than offering a one-click "fix."
  const projectIds = new Set(projects.map(p => p._id));
  const bidIds = new Set(bids.map(b => b._id));
  const companyIds = new Set(companies.map(c => c._id));
  const jobIds = new Set(jobs.map(j => j._id));
  const coIds = new Set(cos.map(c => c._id));
  const orphans = {
    bidCustomersBadBid: bidCustomers.filter(bc => !bidIds.has(bc.bid_id)).length,
    bidCustomersBadCompany: bidCustomers.filter(bc => !companyIds.has(bc.company_id)).length,
    contactsBadCompany: contacts.filter(c => c.company_id && !companyIds.has(c.company_id)).length,
    submissionsBadBid: submissions.filter(s => !bidIds.has(s.bid_id)).length,
    submissionsBadCompany: submissions.filter(s => !companyIds.has(s.company_id)).length,
    changeOrdersBadJob: cos.filter(c => !jobIds.has(c.job_id)).length,
    jobsBadProject: jobs.filter(j => !projectIds.has(j.project_id)).length,
    bidsBadProject: bids.filter(b => !projectIds.has(b.project_id)).length,
    remindersBadParent: reminders.filter(r => r.parent_type === 'bid' ? !bidIds.has(r.parent_id) : r.parent_type === 'change_order' ? !coIds.has(r.parent_id) : false).length,
  };

  // Bids missing data the stage REQUIRES. Opportunities require none of these
  // (bid #, customer, estimator are collected at Start Bid), so they're excluded.
  const needsData = bids.filter(b => ['active_bid', 'submitted'].includes(b.stage) && !b.superseded);
  const pById = {}; projects.forEach(p => pById[p._id] = p.name);
  const tag = (b) => ({ id: b._id, label: `${b.bid_number || '(no #)'} — ${pById[b.project_id] || '?'}` });
  const missing = {
    no_customer: needsData.filter(b => !(custByBid[b._id])).map(tag),
    no_estimator: needsData.filter(b => !b.estimator_id).map(tag),
    no_bid_number: needsData.filter(b => !b.bid_number).map(tag),
    submitted_no_amount: bids.filter(b => b.stage === 'submitted' && !b.superseded && !b.estimate_amount).map(tag),
  };

  return {
    counts: { projects: projects.length, bids: bids.length, jobs: jobs.length, change_orders: cos.length, companies: companies.length },
    dupProjects, dupCompanies, dupBids, dupCOs, dupJobs, dupContacts, emptyCompanies, orphans,
    noBidProjects, jobsNoNumber, jobsAwaitingNumber, missing, overrides,
  };
}

function _describeOverride(o) {
  const k = (s) => (s || '').replace(/^job:/, 'Job ').replace(/^name:/, '');
  switch (o.type) {
    case 'company_alias':  return `Company alias — "${o.from}" → "${o.to}"`;
    case 'project_name':   return `Project rename — ${k(o.key)} → "${o.name}"`;
    case 'project_merge':  return `Project merge → "${o.name}" (${(o.keys || []).map(k).join(', ')})`;
    case 'project_delete': return `Deleted empty project — ${k(o.key)}`;
    case 'not_dup':        return `Not a duplicate (${o.kind}) — ${(o.keys || []).map(k).join(' · ')}`;
    default:               return o.type;
  }
}

// Remove a saved cleanup override. For not_dup, also clears the live ignored_pairs
// so the group reappears immediately; other types fully revert on next re-import.
async function removeOverride(id) {
  const M = getModels();
  const o = await M.CleanupOverride.findById(Number(id)).lean();
  if (!o) throw new Error('Override not found');
  if (o.type === 'not_dup') {
    const ids = [];
    if (o.kind === 'company') { const cs = await M.Company.find().lean(); (o.keys || []).forEach(key => { const c = cs.find(x => _norm(x.name) === key); if (c) ids.push(c._id); }); }
    else { for (const key of (o.keys || [])) { const p = await M.Project.findOne({ source_key: key }).lean(); if (p) ids.push(p._id); } }
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      await M.IgnoredPair.deleteOne({ kind: o.kind, a: Math.min(ids[i], ids[j]), b: Math.max(ids[i], ids[j]) });
    }
  }
  await M.CleanupOverride.deleteOne({ _id: o._id });
  return { removed: o._id, live_reverted: o.type === 'not_dup' };
}

// Stable key for a project (survives re-import): its import source_key, else its name.
async function _projKey(M, id) { const p = await M.Project.findById(Number(id)).lean(); return p ? (p.source_key || ('name:' + _norm(p.name))) : null; }
async function _recordOverride(doc) { const M = getModels(); await M.CleanupOverride.create({ _id: await nextId('cleanup_overrides'), ...doc }); }

// ── core merges (no override recording — used by both UI actions and replay) ──
async function _mergeProjectsCore(M, sid, ids) {
  await M.Bid.updateMany({ project_id: { $in: ids } }, { $set: { project_id: sid, updated_at: ts() } });
  await M.Job.updateMany({ project_id: { $in: ids } }, { $set: { project_id: sid, updated_at: ts() } });
  await M.Project.deleteMany({ _id: { $in: ids } });
}
async function _mergeCompaniesCore(M, sid, ids) {
  await M.Bid.updateMany({ awarded_company_id: { $in: ids } }, { $set: { awarded_company_id: sid, updated_at: ts() } });
  await M.Job.updateMany({ awarded_company_id: { $in: ids } }, { $set: { awarded_company_id: sid, updated_at: ts() } });
  await M.BidSubmission.updateMany({ company_id: { $in: ids } }, { $set: { company_id: sid, updated_at: ts() } });
  await M.Contact.updateMany({ company_id: { $in: ids } }, { $set: { company_id: sid, updated_at: ts() } });
  await M.BidCustomer.updateMany({ company_id: { $in: ids } }, { $set: { company_id: sid } });
  const dups = await M.BidCustomer.aggregate([{ $match: { company_id: sid } }, { $group: { _id: '$bid_id', rows: { $push: '$$ROOT' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]);
  for (const d of dups) {
    const [keep, ...extra] = d.rows;
    const contacts = [...new Set(d.rows.flatMap(r => r.contact_ids || []))];
    await M.BidCustomer.updateOne({ _id: keep._id }, { $set: { contact_ids: contacts } });
    await M.BidCustomer.deleteMany({ _id: { $in: extra.map(r => r._id) } });
  }
  await M.Company.deleteMany({ _id: { $in: ids } });
}

// ── Merge duplicate projects (UI) — also records a project_merge override ──
async function mergeProjects(survivorId, mergeIds) {
  const M = getModels();
  const sid = Number(survivorId);
  const ids = (mergeIds || []).map(Number).filter(x => x && x !== sid);
  if (!ids.length) throw new Error('Nothing to merge');
  const survivor = await M.Project.findById(sid).lean();
  if (!survivor) throw new Error('Survivor project not found');
  const keys = [survivor.source_key || ('name:' + _norm(survivor.name))];
  for (const id of ids) { const k = await _projKey(M, id); if (k) keys.push(k); }
  await _mergeProjectsCore(M, sid, ids);
  await _recordOverride({ type: 'project_merge', keys: [...new Set(keys)], name: survivor.name });
  return { survivor: sid, merged: ids.length };
}

// ── Merge duplicate companies (UI) — records company_alias overrides ──
async function mergeCompanies(survivorId, mergeIds) {
  const M = getModels();
  const sid = Number(survivorId);
  const ids = (mergeIds || []).map(Number).filter(x => x && x !== sid);
  if (!ids.length) throw new Error('Nothing to merge');
  const survivor = await M.Company.findById(sid).lean();
  if (!survivor) throw new Error('Survivor company not found');
  const merged = await M.Company.find({ _id: { $in: ids } }).lean();
  await _mergeCompaniesCore(M, sid, ids);
  for (const c of merged) await _recordOverride({ type: 'company_alias', from: _norm(c.name), to: survivor.name });
  return { survivor: sid, merged: ids.length };
}

// ── Merge duplicate contacts — repoints any BidCustomer.contact_ids arrays
// that reference a merged id to the survivor (deduping in case a bid somehow
// ended up referencing both), then deletes the merged rows.
async function mergeContacts(survivorId, mergeIds) {
  const M = getModels();
  const sid = Number(survivorId);
  const ids = (mergeIds || []).map(Number).filter(x => x && x !== sid);
  if (!ids.length) throw new Error('Nothing to merge');
  const survivor = await M.Contact.findById(sid).lean();
  if (!survivor) throw new Error('Survivor contact not found');
  const bcRows = await M.BidCustomer.find({ contact_ids: { $in: ids } }).lean();
  for (const bc of bcRows) {
    const newIds = [...new Set(bc.contact_ids.map(cid => ids.includes(cid) ? sid : cid))];
    await M.BidCustomer.updateOne({ _id: bc._id }, { $set: { contact_ids: newIds } });
  }
  await M.Contact.deleteMany({ _id: { $in: ids } });
  return { survivor: sid, merged: ids.length };
}

// Delete a company with zero activity anywhere (Data Health "Empty
// companies"). Re-verifies at delete time (not just trusting the health
// snapshot) so a company that picked up activity in between can't be
// silently deleted out from under real data.
async function deleteCompany(id) {
  const M = getModels();
  const cid = Number(id);
  const company = await M.Company.findById(cid).lean();
  if (!company) throw new Error('Company not found');
  const [hasBidCustomer, hasContact, hasSubmission, hasAwardedBid, hasAwardedJob] = await Promise.all([
    M.BidCustomer.exists({ company_id: cid }), M.Contact.exists({ company_id: cid }),
    M.BidSubmission.exists({ company_id: cid }), M.Bid.exists({ awarded_company_id: cid }), M.Job.exists({ awarded_company_id: cid }),
  ]);
  if (hasBidCustomer || hasContact || hasSubmission || hasAwardedBid || hasAwardedJob) throw new Error('This company has activity — no longer empty, refresh Data Health.');
  await M.Company.deleteOne({ _id: cid });
  return { deleted: cid };
}

// Delete a duplicate change order (Data Health "Duplicate change orders" —
// same CO # created twice under one job, same double-click risk as
// duplicate bids). Only allowed at active_co — once it's been submitted,
// that's real progress, not a clean accident to undo.
async function deleteChangeOrder(id) {
  const M = getModels();
  const co = await M.ChangeOrder.findById(Number(id)).lean();
  if (!co) throw new Error('Change order not found');
  if (co.stage !== 'active_co') throw new Error(`Can't delete — this CO is already ${co.stage}, that's real progress.`);
  const label = [co.co_number, co.name].filter(Boolean).join(' — ') || `CO #${co._id}`;
  await M.Followup.deleteMany({ parent_type: 'change_order', parent_id: co._id });
  await M.Reminder.deleteMany({ parent_type: 'change_order', parent_id: co._id });
  await M.ChangeOrder.deleteOne({ _id: co._id });
  return { deleted: co._id, label };
}

// ── Merge duplicate jobs: move change orders to the survivor, carry over any
// fields it's missing (winning bid / company / PM / award date), delete the rest.
// Live-only fix for old-import artifacts (the job#-grouped importer prevents new
// duplicates, so no replay override is needed).
async function mergeJobs(survivorId, mergeIds) {
  const M = getModels();
  const sid = Number(survivorId);
  const ids = (mergeIds || []).map(Number).filter(x => x && x !== sid);
  if (!ids.length) throw new Error('Nothing to merge');
  const survivor = await M.Job.findById(sid).lean();
  if (!survivor) throw new Error('Survivor job not found');
  const merged = await M.Job.find({ _id: { $in: ids } }).lean();
  await M.ChangeOrder.updateMany({ job_id: { $in: ids } }, { $set: { job_id: sid, updated_at: ts() } });
  const fill = {};
  for (const j of merged) {
    if (!survivor.winning_bid_id && j.winning_bid_id) fill.winning_bid_id = j.winning_bid_id;
    if (!survivor.job_number && j.job_number) fill.job_number = j.job_number;
    if (!survivor.awarded_company_id && j.awarded_company_id) fill.awarded_company_id = j.awarded_company_id;
    if (!survivor.pm_id && j.pm_id) fill.pm_id = j.pm_id;
    if (!survivor.award_date && j.award_date) fill.award_date = j.award_date;
  }
  if (Object.keys(fill).length) await M.Job.updateOne({ _id: sid }, { $set: { ...fill, updated_at: ts() } });
  await M.Job.deleteMany({ _id: { $in: ids } });
  return { survivor: sid, merged: ids.length };
}

// ── "Not a duplicate": live ignored_pairs + a not_dup override (stable keys) ──
async function dismissDuplicates(kind, ids) {
  const M = getModels();
  const list = (ids || []).map(Number).filter(Boolean);
  if (list.length < 2) throw new Error('Need at least two ids');
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = Math.min(list[i], list[j]), b = Math.max(list[i], list[j]);
    if (!(await M.IgnoredPair.findOne({ kind, a, b }))) await M.IgnoredPair.create({ _id: await nextId('ignored_pairs'), kind, a, b });
  }
  // Stable keys for replay-on-reimport — only meaningful for projects/
  // companies, which the importer rebuilds. Contacts are never touched by
  // any import/rebuild, so the IgnoredPair rows above (keyed by their own
  // stable ids) are sufficient on their own; recording a CleanupOverride
  // for them would be storing a key that's never replayed against anything.
  if (kind === 'project' || kind === 'company') {
    let keys;
    if (kind === 'project') { keys = []; for (const id of list) { const k = await _projKey(M, id); if (k) keys.push(k); } }
    else { const cs = await M.Company.find({ _id: { $in: list } }).lean(); keys = cs.map(c => _norm(c.name)); }
    await _recordOverride({ type: 'not_dup', kind, keys: [...new Set(keys)] });
  }
  return { dismissed: list.length };
}

// ── Delete a truly-empty project (UI) — records a project_delete override ──
async function deleteEmptyProject(id) {
  const M = getModels();
  const pid = Number(id);
  if (await M.Bid.countDocuments({ project_id: pid })) throw new Error('Project still has bids');
  const jobs = await M.Job.find({ project_id: pid }).lean();
  for (const j of jobs) if (await M.ChangeOrder.countDocuments({ job_id: j._id })) throw new Error('Project still has change orders');
  const key = await _projKey(M, pid);
  await M.Job.deleteMany({ project_id: pid });
  await M.Project.deleteOne({ _id: pid });
  if (key) await _recordOverride({ type: 'project_delete', key });
  return { deleted: pid };
}

// Delete a truly-duplicate bid (Data Health "Duplicate bids" card — same
// bid # created twice under the same project by mistake, e.g. a double
// submit). Blocked on anything that represents real activity rather than a
// clean accident: a submission, or a decided (awarded/not_awarded) stage.
// NOTE: "closed" is NOT automatically blocked — closed is reachable straight
// from opportunity/active_bid with no submission ever happening (e.g. bids
// manually closed as "not pursuing" before the Excel import), so a closed
// duplicate with no submission is still a clean accident, not real history.
async function deleteBid(id) {
  const M = getModels();
  const bid = await M.Bid.findById(Number(id)).lean();
  if (!bid) throw new Error('Bid not found');
  const DECIDED = ['awarded', 'not_awarded'];
  if (DECIDED.includes(bid.stage)) throw new Error(`Can't delete — this bid is already ${bid.stage}, that's real history.`);
  if (await M.BidSubmission.exists({ bid_id: bid._id })) throw new Error("Can't delete — this bid already has a submission. Close it instead if it's no longer needed.");
  const label = [bid.bid_number, bid.project_name].filter(Boolean).join(' ') || `bid #${bid._id}`;
  await M.BidCustomer.deleteMany({ bid_id: bid._id });
  await M.Reminder.deleteMany({ parent_type: 'bid', parent_id: bid._id });
  await M.Bid.deleteOne({ _id: bid._id });
  return { deleted: bid._id, label };
}

// ── Replay cleanup overrides onto freshly-imported data (called by import.js) ──
// company_alias is applied during the import build; this handles the rest.
async function applyCleanupOverrides() {
  const M = getModels();
  const overrides = await M.CleanupOverride.find().lean();
  const applied = { renames: 0, merges: 0, deletes: 0, not_dup: 0 };
  const findByKey = async (key) => {
    if (key.startsWith('job:')) return M.Project.findOne({ source_key: key }).lean();
    return (await M.Project.findOne({ source_key: key }).lean()) || M.Project.findOne({ name: new RegExp('^' + key.replace(/^name:/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }).lean();
  };

  // 1. project merges (do before renames so the survivor exists)
  for (const o of overrides.filter(o => o.type === 'project_merge')) {
    const projs = [];
    for (const k of o.keys) { const p = await findByKey(k); if (p) projs.push(p); }
    if (projs.length < 2) continue;
    const survivor = projs.find(p => p.name === o.name) || projs[0];
    const others = projs.filter(p => p._id !== survivor._id).map(p => p._id);
    await _mergeProjectsCore(M, survivor._id, others);
    if (o.name) await M.Project.updateOne({ _id: survivor._id }, { $set: { name: o.name } });
    applied.merges++;
  }
  // 2. project renames
  for (const o of overrides.filter(o => o.type === 'project_name')) {
    const r = await M.Project.updateOne({ source_key: o.key }, { $set: { name: o.name } });
    if (r.matchedCount) applied.renames++;
  }
  // 3. empty project deletes
  for (const o of overrides.filter(o => o.type === 'project_delete')) {
    const p = await findByKey(o.key); if (!p) continue;
    if (await M.Bid.countDocuments({ project_id: p._id })) continue;
    const jobs = await M.Job.find({ project_id: p._id }).lean();
    let hasCo = false; for (const j of jobs) if (await M.ChangeOrder.countDocuments({ job_id: j._id })) hasCo = true;
    if (hasCo) continue;
    await M.Job.deleteMany({ project_id: p._id }); await M.Project.deleteOne({ _id: p._id }); applied.deletes++;
  }
  // 4. not-a-duplicate pairs → rebuild ignored_pairs from stable keys
  const allCompanies = await M.Company.find().lean();
  for (const o of overrides.filter(o => o.type === 'not_dup')) {
    const ids = [];
    for (const k of o.keys) {
      if (o.kind === 'project') { const p = await findByKey(k); if (p) ids.push(p._id); }
      else { const c = allCompanies.find(x => _norm(x.name) === k); if (c) ids.push(c._id); }
    }
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = Math.min(ids[i], ids[j]), b = Math.max(ids[i], ids[j]);
      if (!(await M.IgnoredPair.findOne({ kind: o.kind, a, b }))) await M.IgnoredPair.create({ _id: await nextId('ignored_pairs'), kind: o.kind, a, b });
    }
    applied.not_dup++;
  }
  return applied;
}

module.exports = {
  getProjects, getJobsPicker, getProjectDetail, getMeta, getDashboard, getBidList, getCoList, getSearchResults, getDataHealth, mergeProjects, mergeCompanies, mergeJobs,
  dismissDuplicates, deleteEmptyProject, applyCleanupOverrides, removeOverride,
  recomputeBidHeadline, recomputeBidFollowup, nextId, getHolidays, getHolidaysAround, getHolidayNames, getHolidayNamesAround, addWorkingDays, isWeekendOrHoliday,
  createOpportunity, createDirectBid, startBid, submitBid, addSubmission, reactivateBid, addBidCustomers, updateOpportunity, adminUpdate,
  getContacts, getContactDetail, createContact, updateContact, deleteContact, getContactBids, getCompanyBids,
  addBidCustomerContact, removeBidCustomerContact,
  awardSubmission, notAwardSubmission, closeBid, logFollowupV2,
  createLegacyJob, updateJob,
  createChangeOrder, submitCO, approveCO, notApproveCO, voidCO, reopenCO, reviseCO,
  _norm, resolveCompanyByName, ensureBidCustomer, teamMap,
  addReminder, dismissReminder, deleteReminder, getRemindersFor, getDueReminders, markReminderEmailed,
  addNote, deleteNote, getNotesFor,
  getDigest,
  getTeamV2, createTeamMemberV2, updateTeamMemberV2, updateSettingsV2, getSettings,
  removeBidCustomer, createCompanyV2, deleteBid, addSubEstimator, removeSubEstimator,
  updateBidDueDate, updateCoDueDate,
  logActivity, getActivityLog, undoActivity, bidLabel, coLabel, loadBid, loadCO,
  mergeContacts, deleteCompany, deleteChangeOrder,
};
