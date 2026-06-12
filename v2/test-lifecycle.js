/**
 * v2/test-lifecycle.js — drives a full bid + CO lifecycle through the v2
 * state machine against the test database. Run after seed.js; reseed after.
 *
 *   node v2/seed.js && node v2/test-lifecycle.js && node v2/seed.js
 */
require('dotenv').config();
const db = require('./db');
const { getConnection } = require('./models');

const today = new Date().toISOString().split('T')[0];
let pass = 0, fail = 0;
const ok   = (label) => { console.log(`  ✅ ${label}`); pass++; };
const bad  = (label, e) => { console.log(`  ❌ ${label}: ${e.message}`); fail++; };
async function expectThrow(label, fn) {
  try { await fn(); bad(label, new Error('did NOT throw')); }
  catch { ok(label + ' (correctly rejected)'); }
}

async function main() {
  console.log('── Full bid lifecycle ──');

  // 1. Opportunity (new project)
  const { project_id, bid_id } = await db.createOpportunity({
    project_name: 'TEST — Childrens Hospital Tower 9', notes: 'lifecycle test', created_by: 1,
  });
  ok(`Opportunity created (project ${project_id}, bid ${bid_id})`);

  // Illegal: submit straight from opportunity
  await expectThrow('Submit from opportunity', () => db.submitBid(bid_id, { estimate_amount: 1, jurisdiction: '98', date_submitted: today, approved_by: 'X' }));
  // Illegal: award straight from opportunity
  await expectThrow('Award from opportunity', () => db.awardBid(bid_id, { award_date: today }));

  // 2. Start Bid — missing fields rejected
  await expectThrow('Start Bid without customers', () => db.startBid(bid_id, { estimator_id: 2, salesperson_id: 1, date_received: today, due_date: today }));

  const started = await db.startBid(bid_id, {
    company_ids: [1, 3],                                    // Torcon + INTECH (multi-customer)
    estimator_id: 2, salesperson_id: 1,
    date_received: today, due_date: today,
    drawing_stage: '80% budget',
    sub_estimators: [{ estimator_id: 6, scope: 'fire alarm' }],
  });
  if (!/^B26-\d{4}$/.test(started.bid_number)) throw new Error('bad bid number: ' + started.bid_number);
  ok(`Start Bid → active_bid, bid # assigned: ${started.bid_number}`);

  // 3. Submit
  const sub = await db.submitBid(bid_id, { estimate_amount: 575000, jurisdiction: '98', date_submitted: today, approved_by: 'Joe Monchek' });
  ok(`Submit → submitted, follow-up timer set: ${sub.next_followup_date}`);

  // 4. Follow-up (no decision) restarts timer
  const fu = await db.logFollowupV2({ parent_type: 'bid', parent_id: bid_id, contact_method: 'phone', customer_contact: 'Sarah Klein', notes: 'No decision yet.', contacted_by: 1 });
  ok(`Follow-up logged, timer restarted: ${fu.next_followup_date}`);

  // 5. Revision
  await db.addRevision(bid_id, { amount: 591000, date: today, notes: 'Added alternate per customer' });
  ok('Revision added, estimate updated');

  // 6. Award — multi-customer requires winner
  await expectThrow('Award without winner (multi-customer)', () => db.awardBid(bid_id, { award_date: today }));
  await expectThrow('Award to company not on bid', () => db.awardBid(bid_id, { award_date: today, awarded_company_id: 5 }));
  const awarded = await db.awardBid(bid_id, { award_date: today, awarded_company_id: 3, pm_id: 11 });
  ok(`Awarded → Job ${awarded.job_id} created (job # pending)`);

  // 7. Accounting assigns job # later
  await db.updateJob(awarded.job_id, { job_number: '26-9999' });
  ok('Job # assigned by accounting');

  console.log('── Change order lifecycle ──');

  // 8. CO requires a job
  await expectThrow('CO on nonexistent job', () => db.createChangeOrder(99999, { co_number: 'RFC-99', name: 'x', due_date: today, start_date: today }));
  const co = await db.createChangeOrder(awarded.job_id, { co_number: 'RFC-01', name: 'TEST add receptacles', due_date: today, start_date: today, estimator_id: 2 });
  ok(`CO created → active_co (${co.co_id})`);

  // 9. Submit CO
  const coSub = await db.submitCO(co.co_id, { estimate_amount: 12000, date_submitted: today, approved_by: 'Mike Pavone' });
  ok(`CO submitted, timer: ${coSub.next_followup_date}`);

  // 10. CO follow-up restarts timer
  await db.logFollowupV2({ parent_type: 'change_order', parent_id: co.co_id, contact_method: 'email', customer_contact: 'Lauren Choi', notes: 'Pending owner review.', contacted_by: 11 });
  ok('CO follow-up logged');

  // 11. Not approved, then REOPEN (back to submitted_co since was_submitted)
  await db.notApproveCO(co.co_id, { date_not_approved: today, not_approved_notes: 'Owner balked' });
  ok('CO → not_approved');
  const reopened = await db.reopenCO(co.co_id);
  if (reopened.stage !== 'submitted_co') throw new Error('reopen went to ' + reopened.stage);
  ok('Reopen → submitted_co (was previously submitted)');

  // 12. Void, then reopen → still submitted_co
  await db.voidCO(co.co_id, { void_reason: 'test void' });
  const reopened2 = await db.reopenCO(co.co_id);
  if (reopened2.stage !== 'submitted_co') throw new Error('reopen2 went to ' + reopened2.stage);
  ok('Void + reopen → submitted_co');

  // 13. Approve (final)
  await db.approveCO(co.co_id, { approval_date: today });
  ok('CO → approved');
  await expectThrow('Void an approved CO', () => db.voidCO(co.co_id, { void_reason: 'nope' }));

  // 14. Never-submitted CO reopens to active_co
  const co2 = await db.createChangeOrder(awarded.job_id, { co_number: 'RFC-02', name: 'TEST never submitted', due_date: today, start_date: today });
  await db.voidCO(co2.co_id, { void_reason: 'canceled' });
  const reopened3 = await db.reopenCO(co2.co_id);
  if (reopened3.stage !== 'active_co') throw new Error('reopen3 went to ' + reopened3.stage);
  ok('Never-submitted CO reopens → active_co');

  console.log('── Close path ──');
  const opp2 = await db.createOpportunity({ project_name: 'TEST — close me', created_by: 1 });
  await expectThrow('Close without reason', () => db.closeBid(opp2.bid_id, { closed_date: today, closed_approved_by: 'JM' }));
  await db.closeBid(opp2.bid_id, { closed_date: today, closed_approved_by: 'Joe Monchek', close_reason: 'Decided not to bid' });
  ok('Opportunity closed with date/approver/reason');

  console.log(`\n${pass} passed, ${fail} failed`);
  await getConnection().close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
