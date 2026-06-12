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

module.exports = { getProjects, getProjectDetail, nextId };
