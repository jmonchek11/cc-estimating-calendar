/**
 * v2/seed.js — Fake dataset for v2 model testing
 *
 * Seeds the ISOLATED v2 test database (estimating_v2_test) with realistic
 * data covering every lifecycle path in docs/DATA_MODEL_SPEC.md §6.3.
 * NEVER touches the production database.
 *
 * Usage:
 *   node v2/seed.js           # wipe v2 test DB and reseed
 *   node v2/seed.js --check   # report counts only, no writes
 */
require('dotenv').config();
const { getConnection, getModels, V2_DB_NAME } = require('./models');

const CHECK_ONLY = process.argv.includes('--check');

// Date helpers relative to "today" so timers/overdue states are always live
const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().split('T')[0];
};

async function main() {
  const conn = getConnection();
  await conn.asPromise();
  console.log(`Connected to ${V2_DB_NAME}`);
  const M = getModels();

  if (CHECK_ONLY) {
    for (const [name, model] of Object.entries(M)) {
      console.log(`${name}: ${await model.countDocuments()}`);
    }
    await conn.close();
    return;
  }

  // ── Wipe (v2 test DB only) ─────────────────────────────────────────────────
  console.log('Wiping v2 test database…');
  for (const model of Object.values(M)) {
    await model.deleteMany({});
  }

  // ── Team (mirrors real team, no passwords set) ────────────────────────────
  const team = await M.TeamMember.insertMany([
    { _id: 1,  name: 'Joe Monchek',        initials: 'JM', role: 'sales',     is_admin: true, email: 'monchek11@gmail.com' },
    { _id: 2,  name: 'Connor Winters',     initials: 'CW', role: 'estimator' },
    { _id: 3,  name: 'Pat McCreesh',       initials: 'PM', role: 'estimator' },
    { _id: 4,  name: 'Doug Pierno',        initials: 'DP', role: 'estimator' },
    { _id: 5,  name: 'Scott Yaffe',        initials: 'SY', role: 'estimator' },
    { _id: 6,  name: 'Jonathon Chukinas',  initials: 'JC', role: 'estimator' },
    { _id: 7,  name: 'Brian Fischer',      initials: 'BF', role: 'sales' },
    { _id: 8,  name: 'Jim O\'Driscoll',    initials: 'JO', role: 'sales' },
    { _id: 9,  name: 'Damion Covelens',    initials: 'DC', role: 'sales' },
    { _id: 10, name: 'Fran Thompson',      initials: 'FT', role: 'sales' },
    { _id: 11, name: 'Mike Pavone',        initials: 'MP', role: 'pm' },     // fake PM for job assignments
    { _id: 12, name: 'Tony Russo',         initials: 'TR', role: 'pm' },     // fake PM
  ]);
  console.log(`Team: ${team.length}`);

  await M.Settings.create({ _id: 'company', fu_initial_days: 3, fu_recurring_days: 7 });

  // ── Companies + Contacts (Scenario 11: multiple contacts; shared contact) ──
  await M.Company.insertMany([
    { _id: 1, name: 'Torcon, Inc.',                       city: 'Red Bank',     state: 'NJ', domain: 'torcon.com' },
    { _id: 2, name: 'Phase One Construction Group, LLC',  city: 'Philadelphia', state: 'PA', domain: 'phaseonecg.com' },
    { _id: 3, name: 'INTECH Construction',                city: 'Philadelphia', state: 'PA', domain: 'intechconstruction.com' },
    { _id: 4, name: 'Clemens Construction',               city: 'Philadelphia', state: 'PA', domain: 'clemensconstruction.com' },
    { _id: 5, name: 'Delaware Valley Remediation',        city: 'Conshohocken', state: 'PA', domain: 'dvremediation.com' },
    { _id: 6, name: 'Hunter Roberts Construction Group',  city: 'Philadelphia', state: 'PA', domain: 'hrcg.com' },
  ]);
  await M.Contact.insertMany([
    { _id: 1, company_id: 1, first_name: 'Sarah',  last_name: 'Klein',    email: 'sklein@torcon.com',              phone: '732-555-0101' },
    { _id: 2, company_id: 1, first_name: 'Dave',   last_name: 'Morrison', email: 'dmorrison@torcon.com',           phone: '732-555-0102' },
    { _id: 3, company_id: 2, first_name: 'Marc',   last_name: 'Bellino',  email: 'mbellino@phaseonecg.com',        phone: '215-555-0201' },
    { _id: 4, company_id: 3, first_name: 'Lauren', last_name: 'Choi',     email: 'lchoi@intechconstruction.com',   phone: '215-555-0301' },
    { _id: 5, company_id: 4, first_name: 'Greg',   last_name: 'Walters',  email: 'gwalters@clemensconstruction.com', phone: '215-555-0401' },
    { _id: 6, company_id: 6, first_name: 'Nina',   last_name: 'Patel',    email: 'npatel@hrcg.com',                phone: '215-555-0601' },
  ]);
  console.log('Companies: 6, Contacts: 6');

  const projects = [];
  const bids = [];
  const jobs = [];
  const cos = [];
  const bidCustomers = [];
  const submissions = [];
  const followups = [];
  const reminders = [];
  let bidNum = 100;
  let subId = 0;
  // helper: one submission row. opts can carry { outcome, award_date,
  // date_not_awarded, not_awarded_notes, next_followup_date }. The bid's
  // denormalized estimate_amount already reflects the headline (latest/awarded).
  const sub = (bid_id, company_id, amount, date, by, type = 'initial', is_current = 1, notes = null, opts = {}) =>
    submissions.push({ _id: ++subId, bid_id, company_id, amount, date_submitted: date, approved_by: by, submission_type: type, is_current, notes,
      outcome: opts.outcome || 'pending', award_date: opts.award_date || null,
      date_not_awarded: opts.date_not_awarded || null, not_awarded_notes: opts.not_awarded_notes || null,
      next_followup_date: opts.next_followup_date || null });
  const nextBidNumber = () => `B26-${String(bidNum++).padStart(4, '0')}`;

  // ── Scenario 1: opportunity never advanced (internal discussion only) ───────
  projects.push({ _id: 1, name: 'Roosevelt Mall Food Court Renovation', created_by: 1 });
  bids.push({
    _id: 1, project_id: 1, stage: 'opportunity', bid_number: null,
    notes: 'Brought to us by BF — discussing internally whether worth pursuing. GC unknown.',
  });

  // ── Scenario 2: opportunity closed without bidding ──────────────────────────
  projects.push({ _id: 2, name: 'Lehigh Valley Hospital MOB Fit-Out', created_by: 7 });
  bids.push({
    _id: 2, project_id: 2, stage: 'closed', bid_number: null,
    closed_date: day(-20), closed_approved_by: 'Joe Monchek',
    close_reason: 'Out of our geographic range; decided not to pursue.',
  });

  // ── Scenario 3: active bid closed mid-estimate ──────────────────────────────
  projects.push({ _id: 3, name: 'Drexel Korman Center Lab Conversion', created_by: 1 });
  bids.push({
    _id: 3, project_id: 3, stage: 'closed', bid_number: nextBidNumber(),
    estimator_id: 3, salesperson_id: 8, date_received: day(-45), due_date: day(-15),
    closed_date: day(-25), closed_approved_by: 'Joe Monchek',
    close_reason: 'GC lost the project to another CM mid-bid; estimate stopped at ~60%.',
  });
  bidCustomers.push({ _id: 1, bid_id: 3, company_id: 3, contact_ids: [4] });

  // ── Scenario 4: submitted, multiple no-decision follow-ups (timer visible) ──
  projects.push({ _id: 4, name: 'Jefferson Methodist ED Expansion', created_by: 7 });
  bids.push({
    _id: 4, project_id: 4, stage: 'submitted', bid_number: nextBidNumber(),
    estimator_id: 2, salesperson_id: 7, date_received: day(-60), due_date: day(-30),
    drawing_stage: '100% CD',
    estimate_amount: 1840000, jurisdiction: '98', date_submitted: day(-28), approved_by: 'Joe Monchek',
    next_followup_date: day(2),
    sub_estimators: [{ estimator_id: 6, scope: 'fire alarm' }, { estimator_id: 5, scope: 'data' }],
  });
  bidCustomers.push({ _id: 2, bid_id: 4, company_id: 1, contact_ids: [1, 2] });
  followups.push(
    { _id: 1, parent_type: 'bid_submission', parent_id: 1, followup_date: day(-25), contacted_by: 7, contact_method: 'phone',
      customer_contact: 'Sarah Klein', notes: 'Bids still being leveled. Decision expected in 2 weeks.', outcome: 'no_decision', next_followup_date: day(-18) },
    { _id: 2, parent_type: 'bid_submission', parent_id: 1, followup_date: day(-18), contacted_by: 7, contact_method: 'email',
      customer_contact: 'Sarah Klein', notes: 'Owner pushed decision to next month. We remain in the running.', outcome: 'no_decision', next_followup_date: day(-11) },
    { _id: 3, parent_type: 'bid_submission', parent_id: 1, followup_date: day(-5), contacted_by: 7, contact_method: 'in_person',
      customer_contact: 'Dave Morrison', notes: 'Met at site walk. Down to us and one other EC. Pricing very close.', outcome: 'no_decision', next_followup_date: day(2) },
  );

  // ── Scenario 5: bid to 3 companies, awarded to one (winner picker) ──────────
  // ── Scenario 6: its Job has NO job # yet (accounting pending) ───────────────
  projects.push({ _id: 5, name: 'Comcast Technology Center 41st Floor', created_by: 1 });
  bids.push({
    _id: 5, project_id: 5, stage: 'awarded', bid_number: nextBidNumber(),
    estimator_id: 4, salesperson_id: 1, date_received: day(-90), due_date: day(-60),
    drawing_stage: '100% CD',
    estimate_amount: 925000, jurisdiction: '98', date_submitted: day(-58), approved_by: 'Joe Monchek',
    award_date: day(-6), awarded_company_id: 3,
  });
  bidCustomers.push(
    { _id: 3, bid_id: 5, company_id: 1, contact_ids: [1] },
    { _id: 4, bid_id: 5, company_id: 3, contact_ids: [4] },   // ← winner
    { _id: 5, bid_id: 5, company_id: 4, contact_ids: [5] },
  );
  followups.push(
    { _id: 4, parent_type: 'bid_submission', parent_id: 3, followup_date: day(-6), contacted_by: 1, contact_method: 'phone',
      customer_contact: 'Lauren Choi', notes: 'INTECH confirmed award! Contract to follow.', outcome: 'awarded' },
  );
  jobs.push({
    _id: 1, project_id: 5, winning_bid_id: 5, job_number: null,   // ← Scenario 6: job # pending
    awarded_company_id: 3, pm_id: 11, award_date: day(-6),
  });

  // ── Scenario 7: awarded bid → Job → 3 COs (approved / not approved / voided) ─
  projects.push({ _id: 6, name: 'Penn Medicine Radnor Phase 2', created_by: 7 });
  bids.push({
    _id: 6, project_id: 6, stage: 'awarded', bid_number: nextBidNumber(),
    estimator_id: 2, salesperson_id: 7, date_received: day(-200), due_date: day(-170),
    estimate_amount: 3150000, jurisdiction: '98', date_submitted: day(-168), approved_by: 'Joe Monchek',
    award_date: day(-150), awarded_company_id: 6,
  });
  bidCustomers.push({ _id: 6, bid_id: 6, company_id: 6, contact_ids: [6] });
  jobs.push({
    _id: 2, project_id: 6, winning_bid_id: 6, job_number: '26-1147',
    awarded_company_id: 6, pm_id: 12, award_date: day(-150),
  });
  cos.push(
    { _id: 1, job_id: 2, co_number: 'RFC-01', name: 'Add 12 duplex receptacles — pharmacy', stage: 'approved', was_submitted: 1,
      estimator_id: 2, due_date: day(-100), start_date: day(-110),
      estimate_amount: 18500, date_submitted: day(-98), approved_by: 'Tony Russo', approval_date: day(-90) },
    { _id: 2, job_id: 2, co_number: 'RFC-02', name: 'Relocate panel LP-3 per revised arch plan', stage: 'not_approved', was_submitted: 1,
      estimator_id: 2, due_date: day(-70), start_date: day(-80),
      estimate_amount: 42000, date_submitted: day(-68), approved_by: 'Tony Russo',
      date_not_approved: day(-55), not_approved_notes: 'Owner rejected scope; GC absorbing with own forces.' },
    { _id: 3, job_id: 2, co_number: 'RFC-03', name: 'Generator docking station addition', stage: 'voided', was_submitted: 0,
      estimator_id: 6, due_date: day(-30), start_date: day(-40),
      void_reason: 'Customer canceled the RFC before pricing was due.' },
  );
  followups.push(
    { _id: 5, parent_type: 'change_order', parent_id: 1, followup_date: day(-92), contacted_by: 12, contact_method: 'email',
      customer_contact: 'Nina Patel', notes: 'Approved verbally, paperwork coming.', outcome: 'approved' },
    { _id: 6, parent_type: 'change_order', parent_id: 2, followup_date: day(-60), contacted_by: 12, contact_method: 'phone',
      customer_contact: 'Nina Patel', notes: 'Still with owner for review.', outcome: 'no_decision', next_followup_date: day(-53) },
  );

  // ── Scenario 8: LEGACY job (no bid in system) with active + approved COs ────
  projects.push({ _id: 7, name: 'William H Gray 30th Street Station', created_by: 1 });
  jobs.push({
    _id: 3, project_id: 7, winning_bid_id: null,                 // ← legacy: bid predates this system
    job_number: '25-0892', awarded_company_id: 1, pm_id: 11, award_date: '2025-08-15',
  });
  cos.push(
    { _id: 4, job_id: 3, co_number: 'COR-12', name: 'Platform lighting revisions — Bulletin 9', stage: 'approved', was_submitted: 1,
      estimator_id: 3, due_date: day(-50), start_date: day(-60),
      estimate_amount: 67200, date_submitted: day(-48), approved_by: 'Mike Pavone', approval_date: day(-35) },
    { _id: 5, job_id: 3, co_number: 'COR-15', name: 'Concourse signage power — Bulletin 11', stage: 'active_co', was_submitted: 0,
      estimator_id: 3, due_date: day(10), start_date: day(-5) },
  );

  // ── Scenario 9: budget-only bid AND awarded re-bid under same project ───────
  projects.push({ _id: 8, name: 'Temple Health Fox Chase Proton Center', created_by: 7 });
  bids.push(
    { _id: 7, project_id: 8, stage: 'not_awarded', bid_number: nextBidNumber(),
      estimator_id: 5, salesperson_id: 7, date_received: day(-300), due_date: day(-270),
      drawing_stage: '50% budget',
      estimate_amount: 2400000, jurisdiction: '98', date_submitted: day(-268), approved_by: 'Joe Monchek',
      date_not_awarded: day(-240), not_awarded_notes: 'Budget round only — project re-priced at CDs.' },
    { _id: 8, project_id: 8, stage: 'awarded', bid_number: nextBidNumber(),
      estimator_id: 5, salesperson_id: 7, date_received: day(-120), due_date: day(-90),
      drawing_stage: '100% CD',
      estimate_amount: 2780000, jurisdiction: '98', date_submitted: day(-75), approved_by: 'Joe Monchek',
      award_date: day(-40), awarded_company_id: 4 },
  );
  bidCustomers.push(
    { _id: 7, bid_id: 7, company_id: 4, contact_ids: [5] },
    { _id: 8, bid_id: 8, company_id: 4, contact_ids: [5] },
  );
  jobs.push({
    _id: 4, project_id: 8, winning_bid_id: 8, job_number: '26-1201',
    awarded_company_id: 4, pm_id: 12, award_date: day(-40),
  });

  // ── Scenario 10: not awarded with customer feedback ─────────────────────────
  projects.push({ _id: 9, name: 'Brandywine 2500 Market Lobby Upgrade', created_by: 1 });
  bids.push({
    _id: 9, project_id: 9, stage: 'not_awarded', bid_number: nextBidNumber(),
    estimator_id: 6, salesperson_id: 1, date_received: day(-80), due_date: day(-50),
    estimate_amount: 410000, jurisdiction: '98', date_submitted: day(-49), approved_by: 'Joe Monchek',
    date_not_awarded: day(-14), not_awarded_notes: 'Price ~8% high. GC went with incumbent EC. Asked us to bid the next phase.',
  });
  bidCustomers.push({ _id: 9, bid_id: 9, company_id: 2, contact_ids: [3] });
  followups.push(
    { _id: 7, parent_type: 'bid_submission', parent_id: 9, followup_date: day(-14), contacted_by: 1, contact_method: 'phone',
      customer_contact: 'Marc Bellino', notes: 'Lost on price. Incumbent took it. Keep us on list for phase 2.', outcome: 'not_awarded' },
  );

  // ── Scenario 12: OVERDUE follow-ups on a bid and a CO ───────────────────────
  projects.push({ _id: 10, name: 'Cooper University ICU Tower Level 5', created_by: 7 });
  bids.push({
    _id: 10, project_id: 10, stage: 'submitted', bid_number: nextBidNumber(),
    estimator_id: 4, salesperson_id: 8, date_received: day(-40), due_date: day(-12),
    estimate_amount: 1210000, jurisdiction: '351', date_submitted: day(-10), approved_by: 'Joe Monchek',
    next_followup_date: day(-3),                                  // ← OVERDUE bid follow-up
  });
  bidCustomers.push({ _id: 10, bid_id: 10, company_id: 1, contact_ids: [2] });   // Scenario 11: Dave Morrison on 2 bids
  cos.push(
    { _id: 6, job_id: 2, co_number: 'RFC-04', name: 'Temporary power for owner vendor equipment', stage: 'submitted_co', was_submitted: 1,
      estimator_id: 2, due_date: day(-20), start_date: day(-25),
      estimate_amount: 9800, date_submitted: day(-15), approved_by: 'Tony Russo',
      next_followup_date: day(-4) },                              // ← OVERDUE CO follow-up
  );
  reminders.push(
    { _id: 1, parent_type: 'bid', parent_id: 10, note: 'Check with JO before next follow-up — pricing may need alternate breakout', remind_on: day(1), created_by: 1 },
  );

  // ── Bid submissions (one row per submission event; outcome per submission) ──
  sub(4, 1, 1840000, day(-28), 'Joe Monchek', 'initial', 1, null, { next_followup_date: day(2) });   // #1 pending — has follow-ups
  // Scenario 5/11: bid to 3 customers under one bid #; awarded via company 3, SIBLINGS LEFT PENDING
  sub(5, 1, 925000, day(-58), 'Joe Monchek');                                                          // #2 pending sibling
  sub(5, 3, 925000, day(-58), 'Joe Monchek', 'initial', 1, null, { outcome: 'awarded', award_date: day(-6) });  // #3 winner
  sub(5, 4, 925000, day(-58), 'Joe Monchek');                                                          // #4 pending sibling
  sub(6, 6, 3150000, day(-168), 'Joe Monchek', 'initial', 1, null, { outcome: 'awarded', award_date: day(-150) });  // #5
  sub(7, 4, 2400000, day(-268), 'Joe Monchek', 'initial', 1, null, { outcome: 'not_awarded', date_not_awarded: day(-240), not_awarded_notes: 'Budget round only — project re-priced at CDs.' });  // #6
  // Scenario 9: best-and-final to same customer (no new drawings) — initial superseded, BAFO awarded
  sub(8, 4, 2700000, day(-90), 'Joe Monchek', 'initial', 0);                                           // #7 superseded
  sub(8, 4, 2780000, day(-75), 'Joe Monchek', 'best_and_final', 1, 'Added alternate #2 (lighting controls) per customer', { outcome: 'awarded', award_date: day(-40) });  // #8 winner
  sub(9, 2, 410000, day(-49), 'Joe Monchek', 'initial', 1, null, { outcome: 'not_awarded', date_not_awarded: day(-14), not_awarded_notes: 'Price ~8% high; went with incumbent.' });  // #9
  sub(10, 1, 1210000, day(-10), 'Joe Monchek', 'initial', 1, null, { next_followup_date: day(-3) });  // #10 pending — OVERDUE

  // ── Insert everything ────────────────────────────────────────────────────────
  await M.Project.insertMany(projects);
  await M.Bid.insertMany(bids);
  await M.Job.insertMany(jobs);
  await M.ChangeOrder.insertMany(cos);
  await M.BidCustomer.insertMany(bidCustomers);
  await M.BidSubmission.insertMany(submissions);
  await M.Followup.insertMany(followups);
  await M.Reminder.insertMany(reminders);

  // Counters so future nextId() calls continue after seeded IDs
  await M.Counter.insertMany([
    { _id: 'projects', seq: 100 }, { _id: 'bids', seq: 100 }, { _id: 'jobs', seq: 100 },
    { _id: 'change_orders', seq: 100 }, { _id: 'companies', seq: 100 }, { _id: 'contacts', seq: 100 },
    { _id: 'bid_customers', seq: 100 }, { _id: 'followups', seq: 100 }, { _id: 'reminders', seq: 100 },
    { _id: 'bid_submissions', seq: 100 }, { _id: 'bid_number_2026', seq: bidNum },
  ]);

  console.log(`\nSeeded: ${projects.length} projects, ${bids.length} bids, ${jobs.length} jobs, ${cos.length} COs, ${bidCustomers.length} bid-customer links, ${submissions.length} submissions, ${followups.length} followups, ${reminders.length} reminders`);

  // ── Verify scenario coverage ─────────────────────────────────────────────────
  console.log('\nScenario verification:');
  const checks = [
    ['1. Opportunity never advanced',        await M.Bid.countDocuments({ stage: 'opportunity', bid_number: null }) >= 1],
    ['2. Opportunity closed without bidding', await M.Bid.countDocuments({ stage: 'closed', bid_number: null }) >= 1],
    ['3. Active bid closed mid-estimate',     await M.Bid.countDocuments({ stage: 'closed', bid_number: { $ne: null } }) >= 1],
    ['4. Submitted w/ multiple no-decision FUs', (await M.Followup.countDocuments({ parent_type: 'bid_submission', parent_id: 1, outcome: 'no_decision' })) >= 2],
    ['5. Multi-customer bid awarded to one',  (await M.BidCustomer.countDocuments({ bid_id: 5 })) === 3 && !!(await M.Bid.findById(5).lean()).awarded_company_id],
    ['6. Job with NO job # (pending)',        await M.Job.countDocuments({ job_number: null }) >= 1],
    ['7. Job w/ approved+not_approved+voided COs', (await M.ChangeOrder.distinct('stage', { job_id: 2 })).length >= 3],
    ['8. Legacy job (no bid) with COs',       await M.Job.countDocuments({ winning_bid_id: null }) >= 1],
    ['9. Budget bid + awarded re-bid same project', (await M.Bid.countDocuments({ project_id: 8 })) === 2],
    ['10. Not awarded w/ feedback',           await M.Bid.countDocuments({ stage: 'not_awarded', not_awarded_notes: { $ne: null } }) >= 1],
    ['11. Contact on two bids',               (await M.BidCustomer.countDocuments({ contact_ids: 2 })) >= 2],
    ['12. Overdue bid + CO follow-ups',       (await M.Bid.countDocuments({ next_followup_date: { $lt: day(0) } })) >= 1 && (await M.ChangeOrder.countDocuments({ next_followup_date: { $lt: day(0) } })) >= 1],
    ['13. Awarded bid w/ siblings left pending', (await M.BidSubmission.countDocuments({ bid_id: 5, outcome: 'awarded' })) === 1 && (await M.BidSubmission.countDocuments({ bid_id: 5, outcome: 'pending' })) === 2],
    ['14. Per-submission follow-ups',         (await M.Followup.countDocuments({ parent_type: 'bid_submission' })) >= 4],
  ];
  let pass = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (ok) pass++;
  }
  console.log(`\n${pass}/${checks.length} scenarios verified.`);

  await conn.close();
}

main().catch(e => { console.error(e); process.exit(1); });
