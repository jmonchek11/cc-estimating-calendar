/**
 * v2/notify.js — bridges v2's data model to v1's mailer.js templates.
 *
 * mailer.js's templates expect v1-shaped bid fields (project_name, a single
 * `customer` string, project_entity_name, estimate_due_date). v2's Bid has
 * none of those directly — project name is a join, customers come from the
 * BidCustomer table. bidEmailShape() does that join once so every notify*
 * function can just call the existing, already-styled mailer.js templates
 * unchanged.
 *
 * TeamMember is one shared collection (v2/merge-team-ids.js, July 2026 —
 * v1 and v2 used to have independently-assigned ids for the same people,
 * which silently broke "mine only" filtering and reminder-email recipients;
 * see DATA_MODEL_SPEC.md), so user-lookup functions are reused directly from
 * v1's db.js rather than reimplemented.
 */
const mailer = require('../mailer');
const maindb = require('../db');
const { getModels } = require('./models');

async function emailForV2Member(memberId) {
  const M = getModels();
  const m = await M.TeamMember.findById(Number(memberId)).lean();
  return m?.email ? { email: m.email, name: m.name } : null;
}

async function bidEmailShape(bidId) {
  const M = getModels();
  const bid = await M.Bid.findById(Number(bidId)).lean();
  if (!bid) return null;
  const [project, bidCustomers, companies] = await Promise.all([
    M.Project.findById(bid.project_id).lean(),
    M.BidCustomer.find({ bid_id: bid._id }).lean(),
    M.Company.find().lean(),
  ]);
  const coName = {}; companies.forEach(c => { coName[c._id] = c.name; });
  const customer = [...new Set(bidCustomers.map(bc => coName[bc.company_id]).filter(Boolean))].join(', ');
  return {
    project_name: project?.name || null,
    bid_number: bid.bid_number,
    project_entity_name: project?.name || null,
    customer,
    stage: bid.stage,
    estimate_due_date: bid.due_date,
    estimate_amount: bid.estimate_amount,
    // Lets mailer.js build a direct #project/:id/bid/:id link instead of
    // just the bare app URL — v1 bid objects passed through the same
    // templates simply won't have these, and fall back gracefully.
    bid_id: bid._id,
    project_id: bid.project_id,
  };
}

// Someone was just added/changed as estimator, salesperson, or sub-estimator
// on a bid — let them know, with a link back into the app. Never emails the
// person who made the change (assigning yourself isn't news).
async function notifyAssigned(bidId, recipientId, actorId, role) {
  try {
    if (!recipientId || Number(recipientId) === Number(actorId)) return;
    const recipient = await emailForV2Member(recipientId);
    if (!recipient?.email) return;
    const shape = await bidEmailShape(bidId);
    if (!shape) return;
    const actor = actorId ? await maindb.getMember(actorId) : null;
    const { subject, html } = mailer.emailAssigned(shape, recipient.name, actor?.name || 'A team member', role);
    await mailer.sendMail({ to: recipient.email, subject, html });
  } catch (e) { console.error('[v2 notify] assigned email failed:', e.message); }
}

async function notifyAwarded(bidId, actorName) {
  try {
    const shape = await bidEmailShape(bidId);
    if (!shape) return;
    const users = await maindb.getActiveUserEmails();
    const { subject, html } = mailer.emailAwarded(shape, actorName || 'Someone');
    await mailer.sendMail({ to: users.map(u => u.email), subject, html });
  } catch (e) { console.error('[v2 notify] awarded email failed:', e.message); }
}

// change_order doesn't have a project/customer join worth the trip for a
// reminder ping — reuses the same bidTable-shaped object, just thinner.
async function coEmailShape(coId) {
  const M = getModels();
  const co = await M.ChangeOrder.findById(Number(coId)).lean();
  if (!co) return null;
  const job = await M.Job.findById(co.job_id).lean();
  const project = job ? await M.Project.findById(job.project_id).lean() : null;
  return {
    project_name: `${co.co_number} — ${co.name}`,
    bid_number: project?.name || null,
    project_entity_name: project?.name || null,
    customer: null, stage: co.stage,
    estimate_due_date: co.due_date, estimate_amount: co.estimate_amount,
  };
}

async function emailShapeForReminder(reminder) {
  return reminder.parent_type === 'change_order' ? coEmailShape(reminder.parent_id) : bidEmailShape(reminder.parent_id);
}

module.exports = { bidEmailShape, coEmailShape, emailShapeForReminder, notifyAwarded, notifyAssigned, emailForV2Member };
