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
    const activeBids = pBids.filter(b => BID_ACTIVE_STAGES.includes(b.stage) && !b.superseded);
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
  const [cos, bidCustomers, submissions] = await Promise.all([
    M.ChangeOrder.find({ job_id: { $in: jobIds } }).lean(),
    M.BidCustomer.find({ bid_id: { $in: bidIds } }).lean(),
    M.BidSubmission.find({ bid_id: { $in: bidIds } }).sort({ date_submitted: 1, _id: 1 }).lean(),
  ]);
  const allContactIds = [...new Set(bidCustomers.flatMap(bc => bc.contact_ids || []))];
  const contacts = allContactIds.length ? await M.Contact.find({ _id: { $in: allContactIds } }).lean() : [];
  const contactById = {}; contacts.forEach(c => { contactById[c._id] = fmtContactBrief(c); });
  const allFollowups = await M.Followup.find({
    $or: [
      { parent_type: 'bid_submission', parent_id: { $in: submissions.map(s => s._id) } },
      { parent_type: 'change_order', parent_id: { $in: cos.map(c => c._id) } },
    ],
  }).lean();
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
    notes: co.notes,
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
  require_(data, ['bid_number', 'estimator_id', 'salesperson_id', 'date_received', 'due_date']);
  const companyIds = await resolveCompanyIds(data.company_ids, data.new_companies);
  if (!companyIds.length) throw new Error('At least one customer company is required');

  // Bid # is entered manually for now (generated outside this system).
  // Future: auto-generate the B-year-sequence here.
  const bid_number = String(data.bid_number).trim();

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
  for (const companyId of companyIds) {
    await M.BidCustomer.create({
      _id: await nextId('bid_customers'),
      bid_id: bid._id, company_id: companyId,
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
  return { id: c._id, first_name: c.first_name, last_name: c.last_name, full_name: [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)', phone: c.phone, email: c.email };
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
    notes: data.notes || null, active: 1,
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

// The bid's follow-up date is a rollup: the earliest next_followup_date among
// its still-pending submissions (for dashboard/digest "overdue" queries).
async function recomputeBidFollowup(bidId) {
  const M = getModels();
  const next = (await M.BidSubmission.find({ bid_id: bidId, is_current: 1, outcome: 'pending', next_followup_date: { $ne: null } })
    .sort({ next_followup_date: 1 }).limit(1).lean())[0];
  await M.Bid.updateOne({ _id: bidId }, { $set: { next_followup_date: next ? next.next_followup_date : null, updated_at: ts() } });
}

// ── active_bid → submitted ("Submit Bid") — creates the FIRST BidSubmission ───
async function submitBid(id, data) {
  const M = getModels();
  const bid = await loadBid(id);
  if (bid.stage !== 'active_bid') throw new Error(`Cannot submit from stage '${bid.stage}'`);
  require_(data, ['amount', 'jurisdiction', 'date_submitted', 'approved_by']);
  const companyId = data.company_id ? Number(data.company_id) : (data.new_company ? await resolveCompanyByName(data.new_company) : null);
  if (!companyId) throw new Error('Customer is required');
  await ensureBidCustomer(bid._id, companyId);

  const s = await getSettings();
  await M.BidSubmission.create({
    _id: await nextId('bid_submissions'),
    bid_id: bid._id, company_id: companyId,
    amount: Number(data.amount), date_submitted: data.date_submitted, approved_by: data.approved_by,
    submission_type: 'initial', notes: data.notes || null, is_current: 1,
    outcome: 'pending', next_followup_date: addDays(data.date_submitted, s.fu_initial_days),
  });
  await M.Bid.updateOne({ _id: bid._id }, { $set: {
    stage: 'submitted', jurisdiction: String(data.jurisdiction), updated_at: ts(),
  }});
  await recomputeBidHeadline(bid._id);
  await recomputeBidFollowup(bid._id);
  return { bid_id: bid._id };
}

// ── Add another submission to a submitted bid ─────────────────────────────────
// Another customer, or a best-and-final / scope change to a customer we already
// submitted to (no new drawings). The new submission gets its own follow-up clock.
async function addSubmission(id, data) {
  const M = getModels();
  const bid = await loadBid(id);
  if (bid.stage !== 'submitted') throw new Error(`Can only add submissions to a submitted bid (stage is '${bid.stage}')`);
  require_(data, ['amount', 'date_submitted', 'approved_by', 'submission_type']);
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
    outcome: 'pending', next_followup_date: addDays(data.date_submitted, s.fu_initial_days),
  });
  await recomputeBidHeadline(bid._id);
  await recomputeBidFollowup(bid._id);
  return { bid_id: bid._id };
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
    else if (f === 'amount') v = (v == null) ? null : Number(v);
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
async function awardSubmission(submissionId, data) {
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
  await M.Job.create({
    _id: jobId, project_id: bid.project_id, winning_bid_id: bid._id,
    job_number: null,                                  // accounting assigns later
    awarded_company_id: sub.company_id,
    pm_id: data.pm_id ? Number(data.pm_id) : null,
    award_date: data.award_date,
  });
  return { submission_id: sub._id, bid_id: bid._id, job_id: jobId };
}

// ── Submission not awarded — this customer went elsewhere ─────────────────────
// When ALL of a bid's submissions are not_awarded (none awarded), the bid
// becomes not_awarded. Otherwise it stays submitted (others still pending).
async function notAwardSubmission(submissionId, data) {
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
  }
  return { submission_id: sub._id, bid_id: bid._id };
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
    awarded_company_id: data.awarded_company_id ? Number(data.awarded_company_id)
      : (data.new_company ? await resolveCompanyByName(data.new_company) : null),
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
function _clusterSimilar(items, ignore) {
  const parent = items.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { parent[find(a)] = find(b); };
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i].key, b = items[j].key; if (!a || !b) continue;
    const same = a === b;
    const prefix = a.length >= 10 && b.length >= 10 && (a.startsWith(b) || b.startsWith(a));
    const typo = a.length >= 8 && b.length >= 8 && Math.abs(a.length - b.length) <= 2 && _lev(a, b) <= 1;
    if (!(same || prefix || typo)) continue;
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
    .filter(c => { const j = jobById[c.job_id]; return hit(c.co_number, c.name, j?.job_number, j ? pName[j.project_id] : null); })
    .map(c => {
      const job = jobById[c.job_id];
      return {
        id: c._id, co_number: c.co_number, name: c.name, stage: c.stage,
        project: job ? (pName[job.project_id] || '—') : '—', project_id: job ? job.project_id : null,
        job_number: job ? job.job_number : null,
        estimator: tm[c.estimator_id] || null, due_date: c.due_date,
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
    customers: [...new Set((custByBid[b._id] || []).filter(Boolean))],
    date_received: b.date_received, due_date: b.due_date,
    estimate_amount: b.estimate_amount, date_submitted: b.date_submitted, next_followup_date: b.next_followup_date,
  }));
}

// ── Change order list for a stage ─────────────────────────────────────────────
async function getCoList(stage) {
  const M = getModels();
  const filter = stage ? { stage } : { stage: { $in: ['active_co', 'submitted_co'] } };
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
      estimator: tm[c.estimator_id] || null, due_date: c.due_date,
      estimate_amount: c.estimate_amount, date_submitted: c.date_submitted, next_followup_date: c.next_followup_date,
    };
  });
}

// ── Dashboard rollups (v2) ────────────────────────────────────────────────────
async function getDashboard() {
  const M = getModels();
  const [bids, cos, jobs, subs, companies, projects] = await Promise.all([
    M.Bid.find().lean(), M.ChangeOrder.find().lean(), M.Job.find().lean(),
    M.BidSubmission.find().lean(), M.Company.find().lean(), M.Project.find().lean(),
  ]);
  const today = new Date().toISOString().split('T')[0];
  const ago = (n) => new Date(Date.now() - n * 86400000).toISOString().split('T')[0];
  const ahead = (n) => new Date(Date.now() + n * 86400000).toISOString().split('T')[0];
  const pName = {}; projects.forEach(p => pName[p._id] = p.name);
  const coName = {}; companies.forEach(c => coName[c._id] = c.name);

  const stageOf = (st) => { const l = bids.filter(b => b.stage === st && !b.superseded); return { stage: st, count: l.length, value: l.reduce((s, b) => s + (b.estimate_amount || 0), 0) }; };
  const pipeline = ['opportunity', 'active_bid', 'submitted'].map(stageOf);
  const activeCos = cos.filter(c => ['active_co', 'submitted_co'].includes(c.stage));

  const awarded = bids.filter(b => b.stage === 'awarded' && b.award_date && b.award_date >= ago(30)).sort((a, b) => (b.award_date || '').localeCompare(a.award_date || ''));
  const overdueSubs = subs.filter(s => s.is_current && s.outcome === 'pending' && s.next_followup_date && s.next_followup_date < today);
  const overdueCos = cos.filter(c => c.stage === 'submitted_co' && c.next_followup_date && c.next_followup_date < today);
  const dueSoon = bids.filter(b => ['active_bid', 'submitted'].includes(b.stage) && !b.superseded && b.due_date && b.due_date >= today && b.due_date <= ahead(14)).sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));

  return {
    pipeline,
    activeCo: { count: activeCos.length, value: activeCos.reduce((s, c) => s + (c.estimate_amount || 0), 0) },
    awarded30: { count: awarded.length, value: awarded.reduce((s, b) => s + (b.estimate_amount || 0), 0), list: awarded.slice(0, 8).map(b => ({ id: b._id, bid_number: b.bid_number, project: pName[b.project_id], amount: b.estimate_amount, award_date: b.award_date, company: b.awarded_company_id ? coName[b.awarded_company_id] : null })) },
    overdueCount: overdueSubs.length + overdueCos.length,
    dueSoon: dueSoon.slice(0, 15).map(b => ({ id: b._id, bid_number: b.bid_number, project: pName[b.project_id], due_date: b.due_date, stage: b.stage })),
    jobsPending: jobs.filter(j => !j.job_number).length,
  };
}

async function getDataHealth() {
  const M = getModels();
  const [projects, bids, jobs, cos, companies, bidCustomers] = await Promise.all([
    M.Project.find().lean(), M.Bid.find().lean(), M.Job.find().lean(),
    M.ChangeOrder.find().lean(), M.Company.find().lean(), M.BidCustomer.find().lean(),
  ]);
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
  const dupCompanies = _clusterSimilar(companies.map(c => ({ id: c._id, name: c.name, key: _norm(c.name) })), ignoreSet('company'));
  // projects with no bids — classify: legacy (has job/COs) vs empty (truly removable)
  const noBidProjects = projects.filter(p => !(bidsByProj[p._id])).map(p => {
    const jobN = (jobsByProj[p._id] || []).length, coN = projCo(p);
    return { id: p._id, name: p.name, jobs: jobN, cos: coN, empty: jobN === 0 && coN === 0 };
  }).sort((a, b) => (a.empty === b.empty ? b.cos - a.cos : a.empty ? -1 : 1));
  // jobs with no job # (awaiting accounting)
  const jobsNoNumber = jobs.filter(j => !j.job_number).length;

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
    dupProjects, dupCompanies, noBidProjects, jobsNoNumber, missing, overrides,
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
  // stable keys for replay
  let keys;
  if (kind === 'project') { keys = []; for (const id of list) { const k = await _projKey(M, id); if (k) keys.push(k); } }
  else { const cs = await M.Company.find({ _id: { $in: list } }).lean(); keys = cs.map(c => _norm(c.name)); }
  await _recordOverride({ type: 'not_dup', kind, keys: [...new Set(keys)] });
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
  getProjects, getProjectDetail, getMeta, getDashboard, getBidList, getCoList, getSearchResults, getDataHealth, mergeProjects, mergeCompanies, mergeJobs,
  dismissDuplicates, deleteEmptyProject, applyCleanupOverrides, removeOverride,
  recomputeBidHeadline, recomputeBidFollowup, nextId,
  createOpportunity, createDirectBid, startBid, submitBid, addSubmission, addBidCustomers, adminUpdate,
  getContacts, getContactDetail, createContact, updateContact, deleteContact, getContactBids, getCompanyBids,
  addBidCustomerContact, removeBidCustomerContact,
  awardSubmission, notAwardSubmission, closeBid, logFollowupV2,
  createLegacyJob, updateJob,
  createChangeOrder, submitCO, approveCO, notApproveCO, voidCO, reopenCO,
  _norm, resolveCompanyByName, ensureBidCustomer, teamMap,
};
