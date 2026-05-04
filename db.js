const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const Counter = require('./models/Counter');
const TeamMember = require('./models/TeamMember');
const Bid = require('./models/Bid');
const Followup = require('./models/Followup');

// ── Helpers ───────────────────────────────────────────────────────────────────

async function nextId(name) {
  const doc = await Counter.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return doc.seq;
}

function nowStr() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function formatMember(m) {
  if (!m) return null;
  const o = m.toObject ? m.toObject() : m;
  return {
    id: o._id,
    name: o.name,
    initials: o.initials,
    role: o.role,
    active: o.active,
    email: o.email || null,
    is_admin: o.is_admin || false,
    must_change_password: o.must_change_password !== false,
    created_at: o.created_at
  };
}

function formatBid(b) {
  if (!b) return null;
  const o = b.toObject ? b.toObject() : b;
  return {
    id: o._id,
    bid_number: o.bid_number ?? null,
    job_number: o.job_number ?? null,
    stage: o.stage,
    project_name: o.project_name,
    customer: o.customer ?? null,
    customer2: o.customer2 ?? null,
    customer3: o.customer3 ?? null,
    customer4: o.customer4 ?? null,
    customer5: o.customer5 ?? null,
    notes: o.notes ?? null,
    estimator_id: o.estimator_id ?? null,
    salesperson_id: o.salesperson_id ?? null,
    estimator_name: o.estimator ? o.estimator.name : null,
    estimator_initials: o.estimator ? o.estimator.initials : null,
    salesperson_name: o.salesperson ? o.salesperson.name : null,
    salesperson_initials: o.salesperson ? o.salesperson.initials : null,
    date_received: o.date_received ?? null,
    estimate_due_date: o.estimate_due_date ?? null,
    estimate_start_date: o.estimate_start_date ?? null,
    date_estimate_sent: o.date_estimate_sent ?? null,
    estimate_review_date: o.estimate_review_date ?? null,
    estimate_amount: o.estimate_amount ?? null,
    estimate_pct_complete: o.estimate_pct_complete ?? 0,
    estimate_approved_by: o.estimate_approved_by ?? null,
    bid_result: o.bid_result ?? null,
    award_date: o.award_date ?? null,
    awarded_contractor: o.awarded_contractor ?? null,
    contract_reviewed_by: o.contract_reviewed_by ?? null,
    date_contract_signed: o.date_contract_signed ?? null,
    status: o.status ?? 'Open',
    next_followup_date: o.next_followup_date ?? null,
    is_deleted: o.is_deleted ?? 0,
    created_at: o.created_at ?? null,
    updated_at: o.updated_at ?? null,
  };
}

function formatFollowup(f) {
  if (!f) return null;
  const o = f.toObject ? f.toObject() : f;
  return {
    id: o._id,
    bid_id: o.bid_id,
    followup_date: o.followup_date,
    contacted_by: o.contacted_by ?? null,
    contact_method: o.contact_method ?? null,
    customer_contact: o.customer_contact ?? null,
    notes: o.notes,
    response: o.response ?? null,
    next_followup_date: o.next_followup_date ?? null,
    created_at: o.created_at ?? null,
  };
}

// Aggregation pipeline to join estimator + salesperson onto bids
const BID_PIPELINE = [
  { $lookup: { from: 'teammembers', localField: 'estimator_id',   foreignField: '_id', as: 'estimator'   } },
  { $lookup: { from: 'teammembers', localField: 'salesperson_id', foreignField: '_id', as: 'salesperson' } },
  { $unwind: { path: '$estimator',   preserveNullAndEmptyArrays: true } },
  { $unwind: { path: '$salesperson', preserveNullAndEmptyArrays: true } },
];

// ── Team ──────────────────────────────────────────────────────────────────────

async function getTeam() {
  const members = await TeamMember.find({ active: 1 }).sort({ name: 1 });
  return members.map(formatMember);
}

async function getAllTeam() {
  const members = await TeamMember.find({}).sort({ name: 1 });
  return members.map(formatMember);
}

async function createTeamMember({ name, initials, role = 'estimator', email, temp_password }) {
  const id = await nextId('team_members');
  const doc = { _id: id, name, initials: initials.toUpperCase(), role, active: 1 };
  if (email) doc.email = email.toLowerCase().trim();
  if (temp_password) {
    doc.password_hash = await bcrypt.hash(temp_password, 12);
    doc.must_change_password = true;
  }
  const m = await TeamMember.create(doc);
  return formatMember(m);
}

async function updateTeamMember(id, { name, initials, role, active, pin, email, is_admin }) {
  const member = await TeamMember.findById(Number(id));
  if (!member) return null;
  const update = {
    name: name ?? member.name,
    initials: initials ? initials.toUpperCase() : member.initials,
    role: role ?? member.role,
    active: active !== undefined ? active : member.active,
    pin: pin !== undefined ? (pin || null) : member.pin,
  };
  if (email !== undefined) update.email = email ? email.toLowerCase().trim() : null;
  if (is_admin !== undefined) update.is_admin = !!is_admin;
  const updated = await TeamMember.findByIdAndUpdate(Number(id), update, { new: true });
  return formatMember(updated);
}

async function loginUser(email, password) {
  const member = await TeamMember.findOne({ email: email.toLowerCase().trim(), active: 1 });
  if (!member) return null;
  if (!member.password_hash) return null;
  const match = await bcrypt.compare(password, member.password_hash);
  if (!match) return null;
  return formatMember(member);
}

async function setPassword(userId, newPassword) {
  const hash = await bcrypt.hash(newPassword, 12);
  await TeamMember.findByIdAndUpdate(Number(userId), { password_hash: hash, must_change_password: false });
}

async function adminSetTempPassword(userId, tempPassword) {
  const hash = await bcrypt.hash(tempPassword, 12);
  await TeamMember.findByIdAndUpdate(Number(userId), { password_hash: hash, must_change_password: true });
}

async function getMember(userId) {
  const m = await TeamMember.findById(Number(userId));
  return formatMember(m);
}

// ── Stats ─────────────────────────────────────────────────────────────────────

async function getMyStats(userId) {
  const uid = Number(userId);
  const todayStr = new Date().toISOString().split('T')[0];
  const weekAhead = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
  const CLOSED = ['awarded', 'not_awarded', 'closed'];

  const [myCounts, myOverdueFollowups, myDueSoon, myRecentBids] = await Promise.all([
    Bid.aggregate([
      { $match: {
        is_deleted: 0,
        $or: [{ estimator_id: uid }, { salesperson_id: uid }],
        stage: { $nin: CLOSED }
      }},
      { $group: {
        _id: '$stage',
        count: { $sum: 1 },
        total_value: { $sum: { $ifNull: ['$estimate_amount', 0] } }
      }},
      { $project: { stage: '$_id', count: 1, total_value: 1, _id: 0 } }
    ]),

    Bid.aggregate([
      { $match: {
        is_deleted: 0,
        $or: [{ estimator_id: uid }, { salesperson_id: uid }],
        next_followup_date: { $type: 'string', $lt: todayStr },
        stage: { $nin: CLOSED }
      }},
      { $sort: { next_followup_date: 1 } },
      ...BID_PIPELINE,
    ]).then(r => r.map(formatBid)),

    Bid.aggregate([
      { $match: {
        is_deleted: 0,
        $or: [{ estimator_id: uid }, { salesperson_id: uid }],
        estimate_due_date: { $gte: todayStr, $lte: weekAhead },
        stage: { $in: ['opportunity', 'active_bid', 'active_co'] }
      }},
      { $sort: { estimate_due_date: 1 } },
      ...BID_PIPELINE,
    ]).then(r => r.map(formatBid)),

    Bid.aggregate([
      { $match: {
        is_deleted: 0,
        $or: [{ estimator_id: uid }, { salesperson_id: uid }],
        stage: { $nin: CLOSED }
      }},
      { $sort: { updated_at: -1 } },
      { $limit: 8 },
      ...BID_PIPELINE,
    ]).then(r => r.map(formatBid)),
  ]);

  return { myCounts, myOverdueFollowups, myDueSoon, myRecentBids };
}

async function getStats() {
  const todayStr = new Date().toISOString().split('T')[0];
  const weekAhead = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
  const CLOSED = ['awarded', 'not_awarded', 'closed'];

  const [counts, overdueDoc, dueThisWeekDoc, overdueBids, dueSoonBids, recentActivity] = await Promise.all([
    Bid.aggregate([
      { $match: { is_deleted: 0, stage: { $nin: CLOSED } } },
      { $group: {
        _id: '$stage',
        count: { $sum: 1 },
        total_value: { $sum: { $ifNull: ['$estimate_amount', 0] } }
      }},
      { $project: { stage: '$_id', count: 1, total_value: 1, _id: 0 } }
    ]),

    Bid.countDocuments({
      is_deleted: 0,
      next_followup_date: { $type: 'string', $lt: todayStr },
      stage: { $nin: CLOSED }
    }),

    Bid.countDocuments({
      is_deleted: 0,
      estimate_due_date: { $gte: todayStr, $lte: weekAhead },
      stage: { $in: ['opportunity', 'active_bid', 'active_co'] }
    }),

    Bid.aggregate([
      { $match: {
        is_deleted: 0,
        next_followup_date: { $type: 'string', $lt: todayStr },
        stage: { $nin: CLOSED }
      }},
      { $sort: { next_followup_date: 1 } },
      { $limit: 10 },
      ...BID_PIPELINE,
    ]).then(r => r.map(formatBid)),

    Bid.aggregate([
      { $match: {
        is_deleted: 0,
        estimate_due_date: { $gte: todayStr, $lte: weekAhead },
        stage: { $in: ['opportunity', 'active_bid', 'active_co'] }
      }},
      { $sort: { estimate_due_date: 1 } },
      { $limit: 10 },
      ...BID_PIPELINE,
    ]).then(r => r.map(formatBid)),

    Bid.aggregate([
      { $match: { is_deleted: 0 } },
      { $sort: { updated_at: -1 } },
      { $limit: 8 },
      ...BID_PIPELINE,
      { $project: {
        id: '$_id', project_name: 1, stage: 1, status: 1, updated_at: 1,
        estimator_initials: '$estimator.initials',
        salesperson_initials: '$salesperson.initials'
      }},
    ]),
  ]);

  return {
    counts,
    overdueCount: overdueDoc,
    dueThisWeek: dueThisWeekDoc,
    overdueBids,
    dueSoonBids,
    recentActivity,
  };
}

async function getDigest() {
  const todayStr = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const weekAhead = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
  const CLOSED = ['awarded', 'not_awarded', 'closed'];

  const [pipelineSummary, bidsForEstimators, estimators, bidsForSalespeople, salespeople,
         newThisWeek, submittedThisWeek, awardedThisWeek, notAwardedThisWeek, upcomingDueDates, overdueFollowups] = await Promise.all([
    Bid.aggregate([
      { $match: { is_deleted: 0, stage: { $nin: CLOSED } } },
      { $group: { _id: '$stage', count: { $sum: 1 }, total_value: { $sum: { $ifNull: ['$estimate_amount', 0] } } } },
      { $project: { stage: '$_id', count: 1, total_value: 1, _id: 0 } }
    ]),

    Bid.aggregate([
      { $match: { is_deleted: 0, stage: { $nin: CLOSED }, estimator_id: { $ne: null } } },
      { $group: { _id: '$estimator_id', bid_count: { $sum: 1 }, total_value: { $sum: { $ifNull: ['$estimate_amount', 0] } } } }
    ]),
    TeamMember.find({ active: 1, role: { $in: ['estimator', 'estimator/pm'] } }).sort({ name: 1 }),

    Bid.aggregate([
      { $match: { is_deleted: 0, salesperson_id: { $ne: null } } },
      { $group: {
        _id: '$salesperson_id',
        bid_count: { $sum: 1 },
        overdue_followups: {
          $sum: {
            $cond: [{
              $and: [
                { $lt: ['$next_followup_date', todayStr] },
                { $gt: ['$next_followup_date', ''] },
                { $not: [{ $in: ['$stage', CLOSED] }] }
              ]
            }, 1, 0]
          }
        }
      }}
    ]),
    TeamMember.find({ active: 1, role: { $in: ['salesperson', 'estimator/pm'] } }).sort({ name: 1 }),

    Bid.aggregate([
      { $match: { is_deleted: 0, created_at: { $gte: weekAgo } } },
      { $sort: { created_at: -1 } },
      ...BID_PIPELINE,
    ]).then(r => r.map(formatBid)),

    Bid.aggregate([
      { $match: { is_deleted: 0, date_estimate_sent: { $gte: weekAgo, $lte: todayStr } } },
      { $sort: { date_estimate_sent: 1 } },
      ...BID_PIPELINE,
    ]).then(r => r.map(formatBid)),

    Bid.aggregate([
      { $match: { is_deleted: 0, stage: 'awarded', award_date: { $gte: weekAgo, $lte: todayStr } } },
      { $sort: { award_date: 1 } },
      ...BID_PIPELINE,
    ]).then(r => r.map(formatBid)),

    Bid.aggregate([
      { $match: { is_deleted: 0, stage: 'not_awarded', updated_at: { $gte: weekAgo } } },
      { $sort: { updated_at: -1 } },
      ...BID_PIPELINE,
    ]).then(r => r.map(formatBid)),

    Bid.aggregate([
      { $match: {
        is_deleted: 0,
        estimate_due_date: { $gte: todayStr, $lte: weekAhead },
        stage: { $in: ['opportunity', 'active_bid', 'active_co'] }
      }},
      { $sort: { estimate_due_date: 1 } },
      ...BID_PIPELINE,
    ]).then(r => r.map(formatBid)),

    Bid.aggregate([
      { $match: {
        is_deleted: 0,
        next_followup_date: { $type: 'string', $lt: todayStr },
        stage: { $nin: CLOSED }
      }},
      { $sort: { next_followup_date: 1 } },
      ...BID_PIPELINE,
    ]).then(r => r.map(formatBid)),
  ]);

  // Merge estimator bid counts
  const estimatorMap = {};
  bidsForEstimators.forEach(e => { estimatorMap[e._id] = e; });
  const byEstimator = estimators.map(e => ({
    id: e._id, name: e.name, initials: e.initials,
    bid_count: estimatorMap[e._id]?.bid_count ?? 0,
    total_value: estimatorMap[e._id]?.total_value ?? 0,
  })).sort((a, b) => b.bid_count - a.bid_count);

  // Merge salesperson overdue counts
  const spMap = {};
  bidsForSalespeople.forEach(s => { spMap[s._id] = s; });
  const bySalesperson = salespeople.map(s => ({
    id: s._id, name: s.name, initials: s.initials,
    bid_count: spMap[s._id]?.bid_count ?? 0,
    overdue_followups: spMap[s._id]?.overdue_followups ?? 0,
  })).sort((a, b) => b.overdue_followups - a.overdue_followups || b.bid_count - a.bid_count);

  return {
    generatedAt: new Date().toISOString(),
    weekRange: { from: weekAgo, to: todayStr },
    pipelineSummary,
    byEstimator,
    bySalesperson,
    newThisWeek,
    submittedThisWeek,
    awardedThisWeek,
    notAwardedThisWeek,
    upcomingDueDates,
    overdueFollowups,
  };
}

// ── Bids ──────────────────────────────────────────────────────────────────────

async function getBids({ stage, estimator_id, salesperson_id, status, search, customer_exact, overdue_only, mine_only, userId } = {}) {
  const todayStr = new Date().toISOString().split('T')[0];
  const CLOSED = ['awarded', 'not_awarded', 'closed'];
  const conditions = [{ is_deleted: 0 }];

  if (stage) {
    conditions.push({ stage: { $in: stage.split(',') } });
  }
  if (estimator_id)   conditions.push({ estimator_id:   Number(estimator_id) });
  if (salesperson_id) conditions.push({ salesperson_id: Number(salesperson_id) });
  if (customer_exact) conditions.push({ customer: customer_exact });
  if (status)         conditions.push({ status });

  if (overdue_only === 'true') {
    conditions.push({ next_followup_date: { $type: 'string', $lt: todayStr } });
    conditions.push({ stage: { $nin: CLOSED } });
  }

  if (mine_only === 'true' && userId) {
    const uid = Number(userId);
    conditions.push({ $or: [{ estimator_id: uid }, { salesperson_id: uid }] });
  }

  if (search) {
    const re = { $regex: search, $options: 'i' };
    conditions.push({ $or: [{ project_name: re }, { bid_number: re }, { customer: re }, { job_number: re }] });
  }

  const match = conditions.length === 1 ? conditions[0] : { $and: conditions };

  const pipeline = [
    { $match: match },
    // Sort: null estimate_due_dates go last
    { $addFields: { _sort_due: { $ifNull: ['$estimate_due_date', '9999-99-99'] } } },
    { $sort: { _sort_due: 1, created_at: -1 } },
    ...BID_PIPELINE,
  ];

  const results = await Bid.aggregate(pipeline);
  return results.map(formatBid);
}

async function getBid(id) {
  const results = await Bid.aggregate([
    { $match: { _id: Number(id) } },
    ...BID_PIPELINE,
  ]);
  return results.length ? formatBid(results[0]) : null;
}

const BID_FIELDS = [
  'bid_number', 'job_number', 'stage', 'project_name', 'customer', 'customer2',
  'customer3', 'customer4', 'customer5', 'notes', 'estimator_id', 'salesperson_id',
  'date_received', 'estimate_due_date', 'estimate_start_date', 'date_estimate_sent',
  'estimate_review_date', 'estimate_amount', 'estimate_pct_complete',
  'estimate_approved_by', 'bid_result', 'award_date', 'awarded_contractor',
  'contract_reviewed_by', 'date_contract_signed', 'status', 'next_followup_date'
];

async function createBid(data) {
  if (!data.project_name) throw new Error('project_name is required');
  const id = await nextId('bids');
  const doc = { _id: id };
  for (const f of BID_FIELDS) {
    if (data[f] !== undefined && data[f] !== '') {
      doc[f] = (f === 'estimator_id' || f === 'salesperson_id') ? (data[f] ? Number(data[f]) : null) : data[f];
    }
  }
  await Bid.create(doc);
  return getBid(id);
}

async function updateBid(id, data) {
  const update = { updated_at: nowStr() };
  for (const f of BID_FIELDS) {
    if (f in data) {
      const val = data[f] === '' ? null : data[f] ?? null;
      update[f] = (f === 'estimator_id' || f === 'salesperson_id') ? (val ? Number(val) : null) : val;
    }
  }
  await Bid.findByIdAndUpdate(Number(id), update);
  return getBid(id);
}

async function deleteBid(id) {
  await Bid.findByIdAndUpdate(Number(id), { is_deleted: 1, updated_at: nowStr() });
}

// ── Follow-ups ────────────────────────────────────────────────────────────────

async function getFollowups(bidId) {
  const items = await Followup.find({ bid_id: Number(bidId) }).sort({ followup_date: -1, created_at: -1 });
  return items.map(formatFollowup);
}

async function logFollowup(bidId, { followup_date, contacted_by, contact_method, customer_contact, notes, response, next_followup_date }) {
  const id = await nextId('followups');
  const doc = await Followup.create({
    _id: id,
    bid_id: Number(bidId),
    followup_date,
    contacted_by: contacted_by || null,
    contact_method: contact_method || null,
    customer_contact: customer_contact || null,
    notes,
    response: response || null,
    next_followup_date: next_followup_date || null,
  });

  if (next_followup_date) {
    await Bid.findByIdAndUpdate(Number(bidId), { next_followup_date, updated_at: nowStr() });
  } else {
    await Bid.findByIdAndUpdate(Number(bidId), { updated_at: nowStr() });
  }

  return formatFollowup(doc);
}

// ── Analytics ─────────────────────────────────────────────────────────────────

async function getAnalytics(since) {
  const DECIDED = ['awarded', 'not_awarded'];
  const ACTIVE   = ['opportunity', 'active_bid', 'active_co', 'follow_up'];

  // Base match for decided bids (optionally filtered by date_received)
  const baseDecided = { is_deleted: 0, stage: { $in: DECIDED } };
  if (since) baseDecided.date_received = { $gte: since };

  // Fill last 24 months for volume chart
  const volumeMonths = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    volumeMonths.push(d.toISOString().substring(0, 7)); // YYYY-MM
  }
  const volumeStart = volumeMonths[0] + '-01';

  const [
    overallResult,
    byCustomerRaw,
    byEstimatorRaw,
    bySalespersonRaw,
    rawVolume,
    topActivePipeline,
  ] = await Promise.all([

    // Overall win/loss totals
    Bid.aggregate([
      { $match: baseDecided },
      { $group: {
        _id: null,
        awarded:       { $sum: { $cond: [{ $eq: ['$stage', 'awarded'] }, 1, 0] } },
        not_awarded:   { $sum: { $cond: [{ $eq: ['$stage', 'not_awarded'] }, 1, 0] } },
        awarded_value: { $sum: { $cond: [{ $eq: ['$stage', 'awarded'] }, { $ifNull: ['$estimate_amount', 0] }, 0] } },
        total_value:   { $sum: { $ifNull: ['$estimate_amount', 0] } },
      }}
    ]),

    // Win rate by customer (primary customer field)
    Bid.aggregate([
      { $match: Object.assign({}, baseDecided, { customer: { $nin: [null, ''] } }) },
      { $group: {
        _id: '$customer',
        awarded:       { $sum: { $cond: [{ $eq: ['$stage', 'awarded'] }, 1, 0] } },
        not_awarded:   { $sum: { $cond: [{ $eq: ['$stage', 'not_awarded'] }, 1, 0] } },
        awarded_value: { $sum: { $cond: [{ $eq: ['$stage', 'awarded'] }, { $ifNull: ['$estimate_amount', 0] }, 0] } },
        total_value:   { $sum: { $ifNull: ['$estimate_amount', 0] } },
      }},
      { $addFields: { total: { $add: ['$awarded', '$not_awarded'] } } },
      { $sort: { total: -1 } },
      { $limit: 50 },
    ]),

    // Win rate by estimator
    Bid.aggregate([
      { $match: Object.assign({}, baseDecided, { estimator_id: { $ne: null } }) },
      { $group: {
        _id: '$estimator_id',
        awarded:       { $sum: { $cond: [{ $eq: ['$stage', 'awarded'] }, 1, 0] } },
        not_awarded:   { $sum: { $cond: [{ $eq: ['$stage', 'not_awarded'] }, 1, 0] } },
        awarded_value: { $sum: { $cond: [{ $eq: ['$stage', 'awarded'] }, { $ifNull: ['$estimate_amount', 0] }, 0] } },
      }},
    ]),

    // Win rate by salesperson
    Bid.aggregate([
      { $match: Object.assign({}, baseDecided, { salesperson_id: { $ne: null } }) },
      { $group: {
        _id: '$salesperson_id',
        awarded:       { $sum: { $cond: [{ $eq: ['$stage', 'awarded'] }, 1, 0] } },
        not_awarded:   { $sum: { $cond: [{ $eq: ['$stage', 'not_awarded'] }, 1, 0] } },
        awarded_value: { $sum: { $cond: [{ $eq: ['$stage', 'awarded'] }, { $ifNull: ['$estimate_amount', 0] }, 0] } },
      }},
    ]),

    // Monthly bid volume (last 24 months by date_received)
    Bid.aggregate([
      { $match: { is_deleted: 0, date_received: { $type: 'string', $gte: volumeStart } } },
      { $group: {
        _id:           { $substr: ['$date_received', 0, 7] },
        count:         { $sum: 1 },
        awarded:       { $sum: { $cond: [{ $eq: ['$stage', 'awarded'] }, 1, 0] } },
        awarded_value: { $sum: { $cond: [{ $eq: ['$stage', 'awarded'] }, { $ifNull: ['$estimate_amount', 0] }, 0] } },
      }},
      { $sort: { _id: 1 } },
    ]),

    // Top active pipeline customers (no date filter — always current)
    Bid.aggregate([
      { $match: { is_deleted: 0, stage: { $in: ACTIVE }, customer: { $nin: [null, ''] } } },
      { $group: {
        _id: '$customer',
        count:          { $sum: 1 },
        pipeline_value: { $sum: { $ifNull: ['$estimate_amount', 0] } },
      }},
      { $sort: { pipeline_value: -1 } },
      { $limit: 10 },
    ]),
  ]);

  // Resolve team members for estimator/salesperson lookups
  const allTeam = await TeamMember.find({}).lean();
  const teamMap = {};
  allTeam.forEach(m => { teamMap[m._id] = m; });

  // roles: array of allowed role strings — filters out people with wrong role
  // (e.g. a salesperson who appears as estimator_id on some bids won't show in estimator list)
  function formatPersonRates(rows, roles) {
    return rows
      .map(r => {
        const m = teamMap[r._id] || {};
        const total = r.awarded + r.not_awarded;
        return {
          id: r._id, name: m.name || 'Unknown', initials: m.initials || '?',
          role: m.role || '',
          awarded: r.awarded, not_awarded: r.not_awarded, total,
          win_rate: total > 0 ? r.awarded / total : 0,
          awarded_value: r.awarded_value,
        };
      })
      .filter(r => r.total > 0 && (!roles || roles.includes(r.role)))
      .sort((a, b) => b.total - a.total);
  }

  // Fill month gaps with zeroes
  const volMap = {};
  rawVolume.forEach(m => { volMap[m._id] = m; });
  const monthlyVolume = volumeMonths.map(ym =>
    volMap[ym] || { _id: ym, count: 0, awarded: 0, awarded_value: 0 }
  );

  const overall = overallResult[0] || { awarded: 0, not_awarded: 0, awarded_value: 0, total_value: 0 };
  const overallTotal = overall.awarded + overall.not_awarded;

  return {
    overall: {
      awarded: overall.awarded,
      not_awarded: overall.not_awarded,
      total: overallTotal,
      win_rate: overallTotal > 0 ? overall.awarded / overallTotal : 0,
      awarded_value: overall.awarded_value,
      total_value: overall.total_value,
    },
    byCustomer: byCustomerRaw.map(r => ({
      customer: r._id,
      awarded: r.awarded, not_awarded: r.not_awarded, total: r.total,
      win_rate: r.total > 0 ? r.awarded / r.total : 0,
      awarded_value: r.awarded_value, total_value: r.total_value,
    })),
    byEstimator:   formatPersonRates(byEstimatorRaw,   ['estimator', 'estimator/pm']),
    bySalesperson: formatPersonRates(bySalespersonRaw, ['salesperson', 'estimator/pm']),
    monthlyVolume,
    topActivePipeline,
  };
}

// ── Seed ──────────────────────────────────────────────────────────────────────

const TEAM_NAMES = [
  ['Brian Fischer',     'salesperson', 'BF'],
  ["Jim O'Driscoll",    'salesperson', 'JO'],
  ['Damion Covelens',   'salesperson', 'DC'],
  ['Dillon Dosenbach',  'salesperson', 'DD'],
  ['Fran Thompson',     'salesperson', 'FT'],
  ['Jacob Kiefer',      'salesperson', 'JK'],
  ['Jess Baker',        'salesperson', 'JB'],
  ['Ray Reichenbach',   'salesperson', 'RR'],
  ['Connor Winters',    'estimator',   'CW'],
  ['Pat McCreesh',      'estimator',   'PM'],
  ['Doug Pierno',       'estimator',   'DP'],
  ['Scott Yaffee',      'estimator',   'SY'],
  ['Jonathon Chukinas', 'estimator',   'JC'],
  ['Joe Monchek',       'salesperson', 'JM'],
];

async function seedTeamData() {
  for (const [name, role, initials] of TEAM_NAMES) {
    const existing = await TeamMember.findOne({ initials });
    if (existing) {
      await TeamMember.findByIdAndUpdate(existing._id, { name, role });
    } else {
      const id = await nextId('team_members');
      await TeamMember.create({ _id: id, name, initials, role, active: 1 });
    }
  }

  // Seed Joe Monchek as admin
  const jm = await TeamMember.findOne({ initials: 'JM' });
  if (jm) {
    const adminUpdate = { is_admin: true };
    if (!jm.email) adminUpdate.email = 'jmonchek@libertyintegrated.com';
    if (!jm.password_hash) {
      adminUpdate.password_hash = await bcrypt.hash('Liberty@2026', 12);
      adminUpdate.must_change_password = true;
    }
    await TeamMember.findByIdAndUpdate(jm._id, adminUpdate);
  }
}

// ── Orphan estimator repair ────────────────────────────────────────────────────

async function findOrphanEstimators() {
  const [bids, team] = await Promise.all([
    Bid.find({ is_deleted: 0, estimator_id: null }).lean(),
    TeamMember.find({}).lean(),
  ]);

  // Build initials → member map (case-insensitive)
  const initialsMap = {};
  team.forEach(m => { initialsMap[m.initials.toUpperCase()] = m; });
  const allInitials = Object.keys(initialsMap);

  const results = [];
  for (const bid of bids) {
    if (!bid.notes && !bid.estimate_approved_by) continue;

    const candidates = new Set();
    // Check notes and estimate_approved_by for each known initials pattern
    for (const field of ['notes', 'estimate_approved_by']) {
      const val = (bid[field] || '').trim();
      if (!val) continue;
      for (const ini of allInitials) {
        // Match: exact, starts-with separator, or standalone word
        const re = new RegExp(`(?:^|\\b)${ini}(?:\\b|$)`, 'i');
        if (re.test(val)) candidates.add(ini);
      }
    }

    if (candidates.size === 0) continue;

    results.push({
      bid_id:    bid._id,
      bid_number: bid.bid_number || null,
      project_name: bid.project_name,
      stage:     bid.stage,
      notes:     bid.notes || null,
      estimate_approved_by: bid.estimate_approved_by || null,
      candidates: [...candidates].map(ini => ({
        initials: ini,
        id: initialsMap[ini]._id,
        name: initialsMap[ini].name,
        role: initialsMap[ini].role,
      })),
      // Auto-suggest when there's exactly one unambiguous match
      suggested: candidates.size === 1 ? initialsMap[[...candidates][0]]._id : null,
    });
  }

  return results;
}

async function fixOrphanEstimators(fixes) {
  // fixes: [{ bid_id, estimator_id }]
  let count = 0;
  for (const { bid_id, estimator_id } of fixes) {
    if (!bid_id || !estimator_id) continue;
    await Bid.findByIdAndUpdate(bid_id, {
      estimator_id: Number(estimator_id),
      updated_at: new Date().toISOString().replace('T', ' ').substring(0, 19),
    });
    count++;
  }
  return { fixed: count };
}

module.exports = {
  getTeam, getAllTeam, createTeamMember, updateTeamMember,
  loginUser, getMember, setPassword, adminSetTempPassword, getMyStats,
  getBids, getBid, createBid, updateBid, deleteBid,
  getFollowups, logFollowup,
  getStats, getDigest, getAnalytics,
  findOrphanEstimators, fixOrphanEstimators,
  seedTeamData,
};
