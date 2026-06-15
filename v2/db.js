/**
 * v2/db.js — v2 data layer (reads the estimating_v2_test database)
 *
 * First slice: project list + full project hierarchy
 * (Project → Bids → Job → Change Orders, per DATA_MODEL_SPEC.md)
 *
 * Joins are done in JS over .lean() queries — fine for the test dataset;
 * swap to aggregations if/when production volume needs it.
 */
const { getModels } = require('./models');

const BID_ACTIVE_STAGES = ['opportunity', 'active_bid', 'submitted'];
const CO_ACTIVE_STAGES  = ['active_co', 'submitted_co'];

async function nextId(name) {
  const { Counter } = getModels();
  const doc = await Counter.findByIdAndUpdate(name, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return doc.seq;
}

function teamMap(members) {
  const m = {};
  members.forEach(t => { m[t._id] = { id: t._id, name: t.name, initials: t.initials, role: t.role }; });
  return m;
}

// ── Projects list with hierarchy rollups ──────────────────────────────────────
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
    const activeBids = pBids.filter(b => BID_ACTIVE_STAGES.includes(b.stage));
    const activeCos  = pCos.filter(c => CO_ACTIVE_STAGES.includes(c.stage));
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
  const [cos, bidCustomers] = await Promise.all([
    M.ChangeOrder.find({ job_id: { $in: jobIds } }).lean(),
    M.BidCustomer.find({ bid_id: { $in: bidIds } }).lean(),
  ]);
  const allFollowups = await M.Followup.find({
    $or: [
      { parent_type: 'bid', parent_id: { $in: bidIds } },
      { parent_type: 'change_order', parent_id: { $in: cos.map(c => c._id) } },
    ],
  }).lean();
  const followups   = allFollowups.filter(f => f.parent_type === 'bid');
  const coFollowups = allFollowups.filter(f => f.parent_type === 'change_order');

  const tm = teamMap(members);
  const companyById = {}; companies.forEach(c => { companyById[c._id] = { id: c._id, name: c.name }; });

  const fmtBid = (b) => ({
    id: b._id,
    bid_number: b.bid_number,
    stage: b.stage,
    drawing_stage: b.drawing_stage,
    estimator: tm[b.estimator_id] || null,
    salesperson: tm[b.salesperson_id] || null,
    sub_estimators: (b.sub_estimators || []).map(s => ({ ...(tm[s.estimator_id] || {}), scope: s.scope })),
    customers: bidCustomers.filter(bc => bc.bid_id === b._id).map(bc => companyById[bc.company_id]).filter(Boolean),
    date_received: b.date_received,
    due_date: b.due_date,
    estimate_amount: b.estimate_amount,
    jurisdiction: b.jurisdiction,
    date_submitted: b.date_submitted,
    approved_by: b.approved_by,
    revisions: b.revisions || [],
    award_date: b.award_date,
    awarded_company: b.awarded_company_id ? companyById[b.awarded_company_id] : null,
    date_not_awarded: b.date_not_awarded,
    not_awarded_notes: b.not_awarded_notes,
    closed_date: b.closed_date,
    closed_approved_by: b.closed_approved_by,
    close_reason: b.close_reason,
    next_followup_date: b.next_followup_date,
    notes: b.notes,
    followups: followups
      .filter(f => f.parent_type === 'bid' && f.parent_id === b._id)
      .sort((a, c) => (c.followup_date || '').localeCompare(a.followup_date || ''))
      .map(f => fmtFollowup(f, tm)),
  });

  const fmtCo = (co) => ({
    id: co._id,
    co_number: co.co_number,
    name: co.name,
    stage: co.stage,
    estimator: tm[co.estimator_id] || null,
    due_date: co.due_date,
    start_date: co.start_date,
    estimate_amount: co.estimate_amount,
    date_submitted: co.date_submitted,
    approved_by: co.approved_by,
    approval_date: co.approval_date,
    void_reason: co.void_reason,
    not_approved_notes: co.not_approved_notes,
    next_followup_date: co.next_followup_date,
    followups: coFollowups
      .filter(f => f.parent_id === co._id)
      .sort((a, c) => (c.followup_date || '').localeCompare(a.followup_date || ''))
      .map(f => fmtFollowup(f, tm)),
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

async function getSettings() {
  const { Settings } = getModels();
  return (await Settings.findById('company').lean()) || { fu_initial_days: 3, fu_recurring_days: 7 };
}

function require_(data, fields) {
  const missing = fields.filter(f => data[f] === undefined || data[f] === null || data[f] === '');
  if (missing.length) throw new Error(`Missing required: ${missing.join(', ')}`);
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
  };
}

// ── Opportunity creation ──────────────────────────────────────────────────────
// Creates a Project (or attaches to an existing one) + an opportunity Bid.
async function createOpportunity({ project_id, project_name, notes, created_by }) {
  const M = getModels();
  let pid = project_id ? Number(project_id) : null;
  if (!pid) {
    require_({ project_name }, ['project_name']);
    pid = await nextId('projects');
    await M.Project.create({ _id: pid, name: project_name.trim(), created_by: created_by || null });
  }
  const bidId = await nextId('bids');
  await M.Bid.create({ _id: bidId, project_id: pid, stage: 'opportunity', notes: notes || null });
  return { project_id: pid, bid_id: bidId };
}

// ── opportunity → active_bid ("Start Bid") ────────────────────────────────────
async function startBid(id, data) {
  const M = getModels();
  const bid = await loadBid(id);
  if (bid.stage !== 'opportunity') throw new Error(`Cannot start bid from stage '${bid.stage}'`);
  require_(data, ['company_ids', 'estimator_id', 'salesperson_id', 'date_received', 'due_date']);
  if (!Array.isArray(data.company_ids) || !data.company_ids.length) throw new Error('At least one customer company is required');

  const counter = await M.Counter.findByIdAndUpdate('bid_number_2026', { $inc: { seq: 1 } }, { new: true, upsert: true });
  const bid_number = `B26-${String(counter.seq).padStart(4, '0')}`;

  await M.Bid.updateOne({ _id: bid._id }, { $set: {
    stage: 'active_bid',
    bid_number,
    estimator_id: Number(data.estimator_id),
    salesperson_id: Number(data.salesperson_id),
    sub_estimators: data.sub_estimators || [],
    date_received: data.date_received,
    due_date: data.due_date,
    start_date: data.start_date || null,
    drawing_stage: data.drawing_stage || null,
    updated_at: ts(),
  }});
  for (const companyId of data.company_ids) {
    await M.BidCustomer.create({
      _id: await nextId('bid_customers'),
      bid_id: bid._id, company_id: Number(companyId),
      contact_ids: (data.contact_ids_by_company || {})[companyId] || [],
    });
  }
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
  const started = await startBid(bid_id, data);
  return { project_id, bid_id, bid_number: started.bid_number };
}

// ── active_bid → submitted ("Submit Bid") ─────────────────────────────────────
async function submitBid(id, data) {
  const M = getModels();
  const bid = await loadBid(id);
  if (bid.stage !== 'active_bid') throw new Error(`Cannot submit from stage '${bid.stage}'`);
  require_(data, ['estimate_amount', 'jurisdiction', 'date_submitted', 'approved_by']);
  const s = await getSettings();
  await M.Bid.updateOne({ _id: bid._id }, { $set: {
    stage: 'submitted',
    estimate_amount: Number(data.estimate_amount),
    jurisdiction: String(data.jurisdiction),
    date_submitted: data.date_submitted,
    approved_by: data.approved_by,
    next_followup_date: addDays(data.date_submitted, s.fu_initial_days),
    updated_at: ts(),
  }});
  return { bid_id: bid._id, next_followup_date: addDays(data.date_submitted, s.fu_initial_days) };
}

// ── submitted → awarded ("Awarded") — creates the Job ─────────────────────────
async function awardBid(id, data) {
  const M = getModels();
  const bid = await loadBid(id);
  if (bid.stage !== 'submitted') throw new Error(`Cannot award from stage '${bid.stage}'`);
  require_(data, ['award_date']);

  const customers = await M.BidCustomer.find({ bid_id: bid._id }).lean();
  let winner = data.awarded_company_id ? Number(data.awarded_company_id) : null;
  if (!winner) {
    if (customers.length === 1) winner = customers[0].company_id;
    else throw new Error('awarded_company_id required — bid went to multiple customers');
  }
  if (!customers.some(c => c.company_id === winner)) throw new Error('Winning company was not on this bid');

  await M.Bid.updateOne({ _id: bid._id }, { $set: {
    stage: 'awarded', award_date: data.award_date, awarded_company_id: winner,
    next_followup_date: null, updated_at: ts(),
  }});
  const jobId = await nextId('jobs');
  await M.Job.create({
    _id: jobId, project_id: bid.project_id, winning_bid_id: bid._id,
    job_number: null,                                  // accounting assigns later
    awarded_company_id: winner,
    pm_id: data.pm_id ? Number(data.pm_id) : null,
    award_date: data.award_date,
  });
  return { bid_id: bid._id, job_id: jobId };
}

// ── submitted → not_awarded ───────────────────────────────────────────────────
async function notAwardBid(id, data) {
  const M = getModels();
  const bid = await loadBid(id);
  if (bid.stage !== 'submitted') throw new Error(`Cannot mark not-awarded from stage '${bid.stage}'`);
  require_(data, ['date_not_awarded']);
  await M.Bid.updateOne({ _id: bid._id }, { $set: {
    stage: 'not_awarded', date_not_awarded: data.date_not_awarded,
    not_awarded_notes: data.not_awarded_notes || null,
    next_followup_date: null, updated_at: ts(),
  }});
  return { bid_id: bid._id };
}

// ── opportunity / active_bid → closed ─────────────────────────────────────────
async function closeBid(id, data) {
  const M = getModels();
  const bid = await loadBid(id);
  if (!['opportunity', 'active_bid'].includes(bid.stage)) throw new Error(`Cannot close from stage '${bid.stage}'`);
  require_(data, ['closed_date', 'closed_approved_by', 'close_reason']);
  await M.Bid.updateOne({ _id: bid._id }, { $set: {
    stage: 'closed', closed_date: data.closed_date,
    closed_approved_by: data.closed_approved_by, close_reason: data.close_reason,
    updated_at: ts(),
  }});
  return { bid_id: bid._id };
}

// ── Add Revision (submitted only) ─────────────────────────────────────────────
async function addRevision(id, data) {
  const M = getModels();
  const bid = await loadBid(id);
  if (bid.stage !== 'submitted') throw new Error(`Revisions only apply to submitted bids (stage is '${bid.stage}')`);
  require_(data, ['amount', 'date']);
  const rev = {
    rev_num: (bid.revisions || []).length + 1,
    amount: Number(data.amount), date: data.date, notes: data.notes || null,
  };
  await M.Bid.updateOne({ _id: bid._id }, {
    $push: { revisions: rev },
    $set: { estimate_amount: rev.amount, updated_at: ts() },
  });
  return { bid_id: bid._id, rev_num: rev.rev_num };
}

// ── Follow-up logging (bid or change_order; no_decision restarts the timer) ───
async function logFollowupV2(data) {
  const M = getModels();
  require_(data, ['parent_type', 'parent_id', 'contact_method', 'notes']);
  const s = await getSettings();
  const outcome = data.outcome || 'no_decision';
  const next = outcome === 'no_decision' ? addDays(today(), s.fu_recurring_days) : null;

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
    const Model = data.parent_type === 'bid' ? M.Bid : M.ChangeOrder;
    await Model.updateOne({ _id: Number(data.parent_id) }, { $set: { next_followup_date: next, updated_at: ts() } });
  }
  return { followup_id: fu._id, next_followup_date: next };
}

// ── Job: manual creation (legacy) + accounting/PM updates ─────────────────────
async function createLegacyJob(data) {
  const M = getModels();
  let pid = data.project_id ? Number(data.project_id) : null;
  if (!pid) {
    require_(data, ['project_name']);
    pid = await nextId('projects');
    await M.Project.create({ _id: pid, name: data.project_name.trim(), created_by: data.created_by || null });
  }
  const jobId = await nextId('jobs');
  await M.Job.create({
    _id: jobId, project_id: pid, winning_bid_id: null,   // legacy — no bid in system
    job_number: data.job_number || null,
    awarded_company_id: data.awarded_company_id ? Number(data.awarded_company_id) : null,
    pm_id: data.pm_id ? Number(data.pm_id) : null,
    award_date: data.award_date || null,
  });
  return { project_id: pid, job_id: jobId };
}

async function updateJob(id, data) {
  const M = getModels();
  const upd = { updated_at: ts() };
  if ('job_number' in data) upd.job_number = data.job_number || null;
  if ('pm_id' in data) upd.pm_id = data.pm_id ? Number(data.pm_id) : null;
  const r = await M.Job.updateOne({ _id: Number(id) }, { $set: upd });
  if (!r.matchedCount) throw new Error('Job not found');
  return { job_id: Number(id) };
}

// ── Change Orders ─────────────────────────────────────────────────────────────
async function createChangeOrder(jobId, data) {
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
  return { co_id: coId };
}

async function submitCO(id, data) {
  const M = getModels();
  const co = await loadCO(id);
  if (co.stage !== 'active_co') throw new Error(`Cannot submit CO from stage '${co.stage}'`);
  require_(data, ['estimate_amount', 'date_submitted', 'approved_by']);
  const s = await getSettings();
  const next = addDays(data.date_submitted, s.fu_initial_days);
  await M.ChangeOrder.updateOne({ _id: co._id }, { $set: {
    stage: 'submitted_co', was_submitted: 1,
    estimate_amount: Number(data.estimate_amount),
    date_submitted: data.date_submitted, approved_by: data.approved_by,
    next_followup_date: next, updated_at: ts(),
  }});
  return { co_id: co._id, next_followup_date: next };
}

async function approveCO(id, data) {
  const M = getModels();
  const co = await loadCO(id);
  if (co.stage !== 'submitted_co') throw new Error(`Cannot approve CO from stage '${co.stage}'`);
  require_(data, ['approval_date']);
  await M.ChangeOrder.updateOne({ _id: co._id }, { $set: {
    stage: 'approved', approval_date: data.approval_date,
    next_followup_date: null, updated_at: ts(),
  }});
  return { co_id: co._id };
}

async function notApproveCO(id, data) {
  const M = getModels();
  const co = await loadCO(id);
  if (co.stage !== 'submitted_co') throw new Error(`Cannot mark not-approved from stage '${co.stage}'`);
  require_(data, ['date_not_approved']);
  await M.ChangeOrder.updateOne({ _id: co._id }, { $set: {
    stage: 'not_approved', date_not_approved: data.date_not_approved,
    not_approved_notes: data.not_approved_notes || null,
    next_followup_date: null, updated_at: ts(),
  }});
  return { co_id: co._id };
}

async function voidCO(id, data) {
  const M = getModels();
  const co = await loadCO(id);
  if (!['active_co', 'submitted_co'].includes(co.stage)) throw new Error(`Cannot void CO from stage '${co.stage}'`);
  require_(data, ['void_reason']);
  await M.ChangeOrder.updateOne({ _id: co._id }, { $set: {
    stage: 'voided', void_reason: data.void_reason,
    next_followup_date: null, updated_at: ts(),
  }});
  return { co_id: co._id };
}

// Reopen: voided/not_approved → submitted_co if previously submitted, else active_co.
// Anyone can reopen (per spec Q2). Timer restarts when returning to submitted_co.
async function reopenCO(id) {
  const M = getModels();
  const co = await loadCO(id);
  if (!['voided', 'not_approved'].includes(co.stage)) throw new Error(`Cannot reopen CO from stage '${co.stage}'`);
  const target = co.was_submitted ? 'submitted_co' : 'active_co';
  const s = await getSettings();
  await M.ChangeOrder.updateOne({ _id: co._id }, { $set: {
    stage: target,
    void_reason: null, date_not_approved: null, not_approved_notes: null,
    next_followup_date: target === 'submitted_co' ? addDays(today(), s.fu_recurring_days) : null,
    updated_at: ts(),
  }});
  return { co_id: co._id, stage: target };
}

module.exports = {
  getProjects, getProjectDetail, getMeta, nextId,
  createOpportunity, createDirectBid, startBid, submitBid, awardBid, notAwardBid, closeBid,
  addRevision, logFollowupV2,
  createLegacyJob, updateJob,
  createChangeOrder, submitCO, approveCO, notApproveCO, voidCO, reopenCO,
};
