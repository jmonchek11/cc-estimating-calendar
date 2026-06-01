const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const Counter = require('./models/Counter');
const TeamMember = require('./models/TeamMember');
const Bid = require('./models/Bid');
const Followup = require('./models/Followup');
const Contact = require('./models/Contact');

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
    sub_estimators: (o.sub_estimators || []).map(se => ({
      estimator_id: se.estimator_id,
      scope:        se.scope || null,
    })),
    checklist: o.checklist ?? [],
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
        $or: [{ estimator_id: uid }, { salesperson_id: uid }, { 'sub_estimators.estimator_id': uid }],
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
        $or: [{ estimator_id: uid }, { salesperson_id: uid }, { 'sub_estimators.estimator_id': uid }],
        next_followup_date: { $type: 'string', $lt: todayStr },
        stage: { $nin: CLOSED }
      }},
      { $sort: { next_followup_date: 1 } },
      ...BID_PIPELINE,
    ]).then(r => r.map(formatBid)),

    Bid.aggregate([
      { $match: {
        is_deleted: 0,
        $or: [{ estimator_id: uid }, { salesperson_id: uid }, { 'sub_estimators.estimator_id': uid }],
        estimate_due_date: { $gte: todayStr, $lte: weekAhead },
        stage: { $in: ['opportunity', 'active_bid', 'active_co'] }
      }},
      { $sort: { estimate_due_date: 1 } },
      ...BID_PIPELINE,
    ]).then(r => r.map(formatBid)),

    Bid.aggregate([
      { $match: {
        is_deleted: 0,
        $or: [{ estimator_id: uid }, { salesperson_id: uid }, { 'sub_estimators.estimator_id': uid }],
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
  const todayStr    = new Date().toISOString().split('T')[0];
  const weekAgo     = new Date(Date.now() -  7 * 86400000).toISOString().split('T')[0];
  const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];
  const weekAhead   = new Date(Date.now() +  7 * 86400000).toISOString().split('T')[0];
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
      { $match: { is_deleted: 0, date_estimate_sent: { $gte: twoWeeksAgo, $lte: todayStr } } },
      { $sort: { date_estimate_sent: -1 } },
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
    conditions.push({ $or: [
      { estimator_id: uid },
      { salesperson_id: uid },
      { 'sub_estimators.estimator_id': uid },
    ]});
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
  'contract_reviewed_by', 'date_contract_signed', 'status', 'next_followup_date',
  'sub_estimators', 'checklist',
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

async function getAnalytics(since, until) {
  const DECIDED = ['awarded', 'not_awarded'];
  const ACTIVE   = ['opportunity', 'active_bid', 'active_co', 'follow_up'];

  // Base match for decided bids (optionally filtered by date_received)
  const baseDecided = { is_deleted: 0, stage: { $in: DECIDED } };
  if (since || until) {
    baseDecided.date_received = {};
    if (since) baseDecided.date_received.$gte = since;
    if (until) baseDecided.date_received.$lte = until;
  }

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
    quarterlyTrendRaw,
    awardedBids,
    notAwardedBids,
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

    // Quarterly trend — last 8 quarters by date_received
    Bid.aggregate([
      { $match: { is_deleted: 0, stage: { $in: DECIDED },
                  date_received: { $type: 'string', $gte: (() => {
                    const d = new Date(); d.setMonth(d.getMonth() - 24); d.setDate(1);
                    return d.toISOString().split('T')[0];
                  })() } } },
      { $addFields: {
        _year:    { $toInt: { $substr: ['$date_received', 0, 4] } },
        _month:   { $toInt: { $substr: ['$date_received', 5, 2] } },
      }},
      { $addFields: { _quarter: { $ceil: { $divide: ['$_month', 3] } } } },
      { $group: {
        _id:           { year: '$_year', quarter: '$_quarter' },
        count:         { $sum: 1 },
        awarded:       { $sum: { $cond: [{ $eq: ['$stage','awarded'] }, 1, 0] } },
        not_awarded:   { $sum: { $cond: [{ $eq: ['$stage','not_awarded'] }, 1, 0] } },
        awarded_value: { $sum: { $cond: [{ $eq: ['$stage','awarded'] }, { $ifNull: ['$estimate_amount',0] }, 0] } },
        total_value:   { $sum: { $ifNull: ['$estimate_amount', 0] } },
      }},
      { $sort: { '_id.year': 1, '_id.quarter': 1 } },
    ]),

    // Awarded bids in period
    Bid.aggregate([
      { $match: Object.assign({}, baseDecided, { stage: 'awarded' }) },
      ...BID_PIPELINE,
      { $sort: { award_date: -1 } },
    ]).then(r => r.map(formatBid)),

    // Not-awarded bids in period
    Bid.aggregate([
      { $match: Object.assign({}, baseDecided, { stage: 'not_awarded' }) },
      ...BID_PIPELINE,
      { $sort: { updated_at: -1 } },
    ]).then(r => r.map(formatBid)),
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
    quarterlyTrend: quarterlyTrendRaw.map(q => ({
      label:        `Q${q._id.quarter} ${q._id.year}`,
      year:          q._id.year,
      quarter:       q._id.quarter,
      count:         q.count,
      awarded:       q.awarded,
      not_awarded:   q.not_awarded,
      win_rate:      (q.awarded + q.not_awarded) > 0 ? q.awarded / (q.awarded + q.not_awarded) : null,
      awarded_value: q.awarded_value,
      total_value:   q.total_value,
    })),
    awardedBids,
    notAwardedBids,
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

  // Fix: salesperson-only members should never appear as estimator_id on bids.
  // Move them to salesperson_id (if slot is empty) and clear estimator_id.
  const salesOnly = await TeamMember.find({ role: 'salesperson' });
  for (const sp of salesOnly) {
    // Bid has them as estimator and has no salesperson → promote to salesperson
    await Bid.updateMany(
      { estimator_id: sp._id, salesperson_id: null, is_deleted: 0 },
      { $set: { salesperson_id: sp._id, estimator_id: null } }
    );
    // Bid already has a salesperson → just clear the estimator slot
    await Bid.updateMany(
      { estimator_id: sp._id, salesperson_id: { $ne: null }, is_deleted: 0 },
      { $set: { estimator_id: null } }
    );
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

// ── Contact & Company profiles ───────────────────────────────────────────────

function calcBidStats(bids) {
  const ACTIVE = ['opportunity', 'active_bid', 'active_co', 'follow_up'];
  const won    = bids.filter(b => b.stage === 'awarded');
  const lost   = bids.filter(b => b.stage === 'not_awarded');
  const active = bids.filter(b => ACTIVE.includes(b.stage));
  const decided = won.length + lost.length;
  return {
    total:      bids.length,
    active:     active.length,
    wins:       won.length,
    losses:     lost.length,
    winRate:    decided > 0 ? Math.round(won.length / decided * 100) : null,
    wonValue:   won.reduce((s, b) => s + (b.estimate_amount || 0), 0),
    totalValue: bids.reduce((s, b) => s + (b.estimate_amount || 0), 0),
  };
}

async function getContactBids(contactId) {
  const bids = await Bid.aggregate([
    { $match: { is_deleted: 0, 'customer_contacts.contact_id': Number(contactId) } },
    ...BID_PIPELINE,
    { $sort: { created_at: -1 } },
  ]).then(r => r.map(formatBid));
  return { bids, stats: calcBidStats(bids) };
}

async function getCompanyBids(companyName) {
  const bids = await Bid.aggregate([
    { $match: {
      is_deleted: 0,
      $or: [
        { customer:  companyName }, { customer2: companyName },
        { customer3: companyName }, { customer4: companyName },
        { customer5: companyName },
      ],
    }},
    ...BID_PIPELINE,
    { $sort: { created_at: -1 } },
  ]).then(r => r.map(formatBid));
  return { bids, stats: calcBidStats(bids) };
}

// ── Bid ↔ Contact links ───────────────────────────────────────────────────────

async function getBidContacts(bidId) {
  const bid = await Bid.findById(Number(bidId)).lean();
  if (!bid || !bid.customer_contacts?.length) return [];
  const ids = bid.customer_contacts.map(cc => cc.contact_id);
  const contacts = await Contact.find({ _id: { $in: ids }, is_deleted: 0 }).lean();
  const contactMap = {};
  contacts.forEach(c => { contactMap[c._id] = fmtContact(c); });
  // Return array of { customer_name, contact } preserving order
  return bid.customer_contacts
    .filter(cc => contactMap[cc.contact_id])
    .map(cc => ({ customer_name: cc.customer_name, contact: contactMap[cc.contact_id] }));
}

async function addBidContact(bidId, customerName, contactId) {
  // Allow multiple contacts per customer; prevent exact duplicate
  await Bid.updateOne(
    { _id: Number(bidId) },
    {
      $addToSet: { customer_contacts: { customer_name: customerName, contact_id: Number(contactId) } },
      $set: { updated_at: nowStr() }
    }
  );
  return getBidContacts(bidId);
}

async function removeBidContact(bidId, customerName, contactId) {
  await Bid.updateOne(
    { _id: Number(bidId) },
    {
      $pull: { customer_contacts: { customer_name: customerName, contact_id: Number(contactId) } },
      $set: { updated_at: nowStr() }
    }
  );
  return getBidContacts(bidId);
}

// ── Contacts ──────────────────────────────────────────────────────────────────

function fmtContact(c) {
  const parts = [c.first_name, c.last_name].filter(Boolean);
  return {
    id:         c._id,
    first_name: c.first_name || null,
    last_name:  c.last_name  || null,
    suffix:     c.suffix     || null,
    full_name:  parts.join(' ') + (c.suffix ? ', ' + c.suffix : ''),
    company:    c.company    || null,
    city:       c.city       || null,
    state:      c.state      || null,
    phone:      c.phone      || null,
    email:      c.email      || null,
    domain:     c.domain     || null,
    notes:      c.notes      || null,
  };
}

async function getContacts({ search, company, no_company } = {}) {
  const conds = [{ is_deleted: 0 }];
  if (search) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    conds.push({ $or: [{ first_name: re }, { last_name: re }, { email: re }, { phone: re }, { company: re }] });
  }
  if (company)    conds.push({ company });
  if (no_company === 'true') conds.push({ $or: [{ company: null }, { company: '' }, { company: { $exists: false } }] });
  const docs = await Contact.find({ $and: conds }).sort({ last_name: 1, first_name: 1 }).lean();
  return docs.map(fmtContact);
}

async function getContact(id) {
  const c = await Contact.findOne({ _id: Number(id), is_deleted: 0 }).lean();
  return c ? fmtContact(c) : null;
}

async function createContact(data) {
  const id = await nextId('contacts');
  const now = nowStr();
  const clean = {
    first_name: data.first_name || null,
    last_name:  data.last_name  || null,
    suffix:     data.suffix     || null,
    company:    data.company    || null,
    city:       data.city       || null,
    state:      data.state      || null,
    phone:      data.phone      || null,
    email:      data.email ? String(data.email).toLowerCase().trim() : null,
    domain:     data.domain     || null,
    notes:      data.notes      || null,
  };
  const doc = await Contact.create({ _id: id, ...clean, active: 1, is_deleted: 0, created_at: now, updated_at: now });
  return fmtContact(doc);
}

async function updateContact(id, data) {
  const now = nowStr();
  const allowed = ['first_name','last_name','suffix','company','city','state','phone','email','domain','notes','active'];
  const upd = { updated_at: now };
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(data, k)) {
      upd[k] = (k === 'email' && data[k]) ? String(data[k]).toLowerCase().trim() : (data[k] ?? null);
    }
  }
  await Contact.updateOne({ _id: Number(id) }, { $set: upd });
  return getContact(id);
}

async function deleteContact(id) {
  await Contact.updateOne({ _id: Number(id) }, { $set: { is_deleted: 1, updated_at: nowStr() } });
}

// ── CSV parser (handles quoted commas) ───────────────────────────────────────
function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) { result.push(cur); cur = ''; }
    else if (ch !== '\r') { cur += ch; }
  }
  result.push(cur);
  return result;
}

function parseContactCSV(content) {
  const lines = content.split('\n').filter(l => l.trim());
  const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
    return obj;
  }).filter(r => headers.some(h => r[h]));
}

async function importContacts(buffer) {
  const content = buffer.toString('utf-8');
  const rows = parseContactCSV(content);
  const stats = { insert: 0, update: 0, skip: 0, error: 0, errors: [] };
  const now = nowStr();

  // Build lookup maps from existing contacts
  const existing = await Contact.find({ is_deleted: 0 }).lean();
  const byEmail = {}, byName = {};
  existing.forEach(c => {
    if (c.email) byEmail[c.email.toLowerCase()] = c._id;
    const nk = `${(c.first_name||'').toLowerCase()}|${(c.last_name||'').toLowerCase()}`;
    if (nk !== '|') byName[nk] = c._id;
  });

  for (const row of rows) {
    try {
      const s = v => { const t = (v||'').trim(); return (t && t !== 'N/A') ? t : null; };
      const data = {
        first_name: s(row.first_name),
        last_name:  s(row.last_name),
        suffix:     s(row.suffix),
        company:    s(row.company),
        city:       s(row.city),
        state:      s(row.state),
        phone:      s(row.phone) ? String(row.phone).replace(/\D/g, '') || null : null,
        email:      s(row.email) ? s(row.email).toLowerCase() : null,
        domain:     s(row.domain),
      };

      if (!data.first_name && !data.last_name && !data.email) { stats.skip++; continue; }

      let existId = null;
      if (data.email) existId = byEmail[data.email] ?? null;
      if (!existId) {
        const nk = `${(data.first_name||'').toLowerCase()}|${(data.last_name||'').toLowerCase()}`;
        if (nk !== '|') existId = byName[nk] ?? null;
      }

      if (existId) {
        const upd = { updated_at: now };
        for (const [k, v] of Object.entries(data)) { if (v !== null) upd[k] = v; }
        await Contact.updateOne({ _id: existId }, { $set: upd });
        stats.update++;
      } else {
        const id = await nextId('contacts');
        await Contact.create({ _id: id, ...data, active: 1, is_deleted: 0, created_at: now, updated_at: now });
        stats.insert++;
        if (data.email) byEmail[data.email] = id;
        const nk = `${(data.first_name||'').toLowerCase()}|${(data.last_name||'').toLowerCase()}`;
        if (nk !== '|') byName[nk] = id;
      }
    } catch (e) {
      stats.error++;
      stats.errors.push({ name: `${row.first_name || ''} ${row.last_name || ''}`.trim(), message: e.message });
    }
  }
  return stats;
}

module.exports = {
  getTeam, getAllTeam, createTeamMember, updateTeamMember,
  loginUser, getMember, setPassword, adminSetTempPassword, getMyStats,
  getBids, getBid, createBid, updateBid, deleteBid,
  getFollowups, logFollowup,
  getStats, getDigest, getAnalytics,
  findOrphanEstimators, fixOrphanEstimators,
  getContactBids, getCompanyBids,
  getBidContacts, addBidContact, removeBidContact,
  getContacts, getContact, createContact, updateContact, deleteContact, importContacts,
  seedTeamData,
};
