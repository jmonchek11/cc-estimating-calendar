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
const directory = require('./directory');
const { getModels } = require('./models');

async function emailForV2Member(memberId) {
  const M = getModels();
  const m = await M.TeamMember.findById(Number(memberId)).lean();
  return m?.email ? { id: m._id, email: m.email, name: m.name, notification_prefs: m.notification_prefs } : null;
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
    // Each bid has its OWN OneDrive folder (renamed to job#/job name at
    // award, but the same folder/link) — not a project-level link.
    folder_url: bid.folder_url || null,
  };
}

// Someone was just added/changed as estimator, salesperson, or sub-estimator
// on a bid — let them know, with a link back into the app. Sends even when
// the actor assigned themselves — used deliberately for testing, and the
// team decided a confirmation email is still useful either way.
async function notifyAssigned(bidId, recipientId, actorId, role, scope) {
  try {
    if (!recipientId) return;
    const recipient = await emailForV2Member(recipientId);
    if (!recipient?.email || !mailer.wantsNotification(recipient, 'assigned')) return;
    const shape = await bidEmailShape(bidId);
    if (!shape) return;
    const actor = actorId ? await maindb.getMember(actorId) : null;
    const { subject, html } = mailer.emailAssigned(shape, recipient.name, actor?.name || 'A team member', role, scope);
    await mailer.sendMail({ to: recipient.email, subject, html });
  } catch (e) { console.error('[v2 notify] assigned email failed:', e.message); }
}

// Everyone assigned to a bid — estimator, salesperson, and any sub-estimators
// — as {id, email, name} triples, filtered to people who haven't opted out
// of the given notification category. Shared by the walk-through "set"
// notification, the 24h-before cron reminder in server.js, and follow-up
// notifications — same "who's actually on this bid" roster every time,
// just gated by whichever category the caller cares about.
async function bidRecipients(bid, category) {
  const ids = [...new Set([bid.estimator_id, bid.salesperson_id, ...(bid.sub_estimators || []).map(s => s.estimator_id)].filter(Boolean))];
  const members = (await Promise.all(ids.map(emailForV2Member))).filter(Boolean);
  return members.filter(m => mailer.wantsNotification(m, category));
}

// Site contact is a real Company + Contact now (see addWalkthrough in
// v2/db.js) — this resolves them for display, tagging the contact's name
// with their company so "John Smith" reads as "John Smith (ABC Electric)"
// rather than a bare name with no context. Takes one walk-through entry
// (a bid now has several), not the whole bid.
async function walkthroughContactInfo(walkthrough) {
  if (!walkthrough?.contact_id) return null;
  const M = getModels();
  const contact = await M.Contact.findById(Number(walkthrough.contact_id)).lean();
  if (!contact) return null;
  const company = walkthrough.company_id ? await M.Company.findById(Number(walkthrough.company_id)).lean() : null;
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || null;
  return { name: name && company ? `${name} (${company.name})` : name, phone: contact.phone || null };
}

// Fires once, right when one walk-through entry's date/time is set or
// rescheduled — notifyAssignmentDiff-style diff check lives in
// v2/routes.js; this just sends once it's confirmed there's something new
// to announce. Takes the specific walk-through entry (identified by id),
// since a bid can have several and only one changed.
async function notifyWalkthroughSet(bidId, walkthroughId, actorId) {
  try {
    const M = getModels();
    const bid = await M.Bid.findById(Number(bidId)).lean();
    const walkthrough = bid?.walkthroughs?.find(w => w._id === Number(walkthroughId));
    if (!walkthrough?.date) return;
    const shape = await bidEmailShape(bidId);
    if (!shape) return;
    const actor = actorId ? await maindb.getMember(actorId) : null;
    const recipients = await bidRecipients(bid, 'walkthrough');
    const contact = await walkthroughContactInfo(walkthrough);
    for (const r of recipients) {
      const { subject, html } = mailer.emailWalkthroughSet(shape, walkthrough.date, walkthrough.time, r.name, actor?.name || 'A team member', contact);
      await mailer.sendMail({ to: r.email, subject, html });
    }
  } catch (e) { console.error('[v2 notify] walkthrough-set email failed:', e.message); }
}

// One email per newly-assigned attendee (not the whole bid team — that's
// notifyWalkthroughSet's job). `newAssigneeMemberIds` comes from
// buildAssigneesList()'s diff in v2/db.js, so re-saving people who were
// already assigned never re-sends them a duplicate "you're assigned" email.
async function notifyWalkthroughAssignees(bidId, walkthroughId, newAssigneeMemberIds, actorId) {
  if (!newAssigneeMemberIds?.length) return;
  try {
    const M = getModels();
    const bid = await M.Bid.findById(Number(bidId)).lean();
    const walkthrough = bid?.walkthroughs?.find(w => w._id === Number(walkthroughId));
    if (!walkthrough?.date) return;
    const shape = await bidEmailShape(bidId);
    if (!shape) return;
    const actor = actorId ? await maindb.getMember(actorId) : null;
    const contact = await walkthroughContactInfo(walkthrough);
    for (const memberId of newAssigneeMemberIds) {
      const assignee = walkthrough.assignees.find(a => a.member_id === memberId);
      if (!assignee) continue;
      const recipient = await emailForV2Member(memberId);
      if (!recipient?.email || !mailer.wantsNotification(recipient, 'walkthrough')) continue;
      const { subject, html } = mailer.emailWalkthroughAssigned(shape, walkthrough.date, walkthrough.time, recipient.name, actor?.name || 'A team member', contact, assignee.rsvp_token);
      await mailer.sendMail({ to: recipient.email, subject, html });
    }
  } catch (e) { console.error('[v2 notify] walkthrough-assigned email failed:', e.message); }
}

async function notifyAwarded(bidId, actorName) {
  try {
    const shape = await bidEmailShape(bidId);
    if (!shape) return;
    const users = (await maindb.getActiveUserEmails()).filter(u => mailer.wantsNotification(u, 'awarded'));
    const { subject, html } = mailer.emailAwarded(shape, actorName || 'Someone');
    await mailer.sendMail({ to: users.map(u => u.email), subject, html });
  } catch (e) { console.error('[v2 notify] awarded email failed:', e.message); }
}

// First real consumer of the Hub's role directory (see v2/directory.js):
// a bid flagged certified_payroll/tax_exempt notifies whoever the Hub says
// holds the 'accounting'/'purchasing' role the moment it's awarded — not a
// TeamMember roster, since Accounting/Purchasing may not have Estimating
// Calendar logins at all. Deliberately not gated by wantsNotification()
// (that's a TeamMember/notification_prefs concept these recipients don't
// have) — this is a compliance-relevant heads-up, always sent when the flag
// is set, not an opt-out-able convenience ping.
async function notifyRoleAward(bidId, actorName) {
  try {
    const M = getModels();
    const bid = await M.Bid.findById(Number(bidId)).lean();
    if (!bid) return;
    const flags = [
      bid.certified_payroll ? { role: 'accounting', label: 'Certified Payroll' } : null,
      bid.tax_exempt ? { role: 'purchasing', label: 'Tax Exempt' } : null,
    ].filter(Boolean);
    if (!flags.length) return;
    const shape = await bidEmailShape(bidId);
    if (!shape) return;
    for (const { role, label } of flags) {
      const recipients = await directory.getUsersByRole(role);
      for (const r of recipients) {
        const { subject, html } = mailer.emailRoleAwardNotice(shape, actorName || 'Someone', label, r.name);
        await mailer.sendMail({ to: r.email, subject, html });
      }
    }
  } catch (e) { console.error('[v2 notify] role award email failed:', e.message); }
}

// Recipient is whoever Settings has configured (e.g. Carrie, who begins bid
// setup once something's approved) — no-op if nothing's configured, rather
// than guessing at an email/role.
// Only fires for an actual Opportunity being declined (not a Lead dismissal
// or an active_bid closure mid-flight) — the owner who added it should
// know it was reviewed and passed on, by whom, and why.
async function notifyOpportunityClosed(bidId, actorName) {
  try {
    const M = getModels();
    const bid = await M.Bid.findById(Number(bidId)).lean();
    if (!bid?.owner_id) return;
    const recipient = await emailForV2Member(bid.owner_id);
    if (!recipient?.email || !mailer.wantsNotification(recipient, 'assigned')) return;
    const shape = await bidEmailShape(bidId);
    if (!shape) return;
    const { subject, html } = mailer.emailOpportunityClosed(shape, actorName || 'A team member', bid.close_reason);
    await mailer.sendMail({ to: recipient.email, subject, html });
  } catch (e) { console.error('[v2 notify] opportunity-closed email failed:', e.message); }
}
async function notifyNewOpportunity(bidId, actorName) {
  try {
    const M = getModels();
    const settings = await M.Settings.findById('company').lean();
    const to = settings?.new_opportunity_notify_email;
    if (!to) return;
    const shape = await bidEmailShape(bidId);
    if (!shape) return;
    const { subject, html } = mailer.emailNewOpportunity(shape, actorName || 'Someone');
    await mailer.sendMail({ to, subject, html });
  } catch (e) { console.error('[v2 notify] new-opportunity email failed:', e.message); }
}
async function notifyApprovedToBid(bidId, actorName) {
  try {
    const M = getModels();
    const settings = await M.Settings.findById('company').lean();
    const to = settings?.queue_notify_email;
    if (!to) return;
    const shape = await bidEmailShape(bidId);
    if (!shape) return;
    const { subject, html } = mailer.emailApprovedToBid(shape, actorName || 'Someone');
    await mailer.sendMail({ to, subject, html });
  } catch (e) { console.error('[v2 notify] approved-to-bid email failed:', e.message); }
}

// Separate from notifyApprovedToBid above (that one pings the fixed setup
// contact from Settings, if configured) — this pings the opportunity's own
// owner, a real TeamMember, to go forward the bid invite/RFQ email to
// PC/estimating so setup can actually begin. No-ops if the opportunity has
// no owner set, or the owner opted out of 'assigned'-category mail (the
// closest existing category — there's no dedicated "queue" pref).
async function notifyOwnerToForwardInvite(bidId, actorName) {
  try {
    const M = getModels();
    const bid = await M.Bid.findById(Number(bidId)).lean();
    if (!bid?.owner_id) return;
    const recipient = await emailForV2Member(bid.owner_id);
    if (!recipient?.email || !mailer.wantsNotification(recipient, 'assigned')) return;
    const shape = await bidEmailShape(bidId);
    if (!shape) return;
    const { subject, html } = mailer.emailForwardBidInvite(shape, recipient.name, actorName || 'Someone');
    await mailer.sendMail({ to: recipient.email, subject, html });
  } catch (e) { console.error('[v2 notify] owner-forward-invite email failed:', e.message); }
}

// change_order doesn't have a project/customer join worth the trip for a
// reminder ping — reuses the same bidTable-shaped object, just thinner.
async function coEmailShape(coId) {
  const M = getModels();
  const co = await M.ChangeOrder.findById(Number(coId)).lean();
  if (!co) return null;
  const job = await M.Job.findById(co.job_id).lean();
  const project = job ? await M.Project.findById(job.project_id).lean() : null;
  // The Job's folder IS its winning bid's folder (renamed at award, same
  // OneDrive folder) — look it up via that relationship, same as getProjectDetail does.
  const winningBid = job?.winning_bid_id ? await M.Bid.findById(job.winning_bid_id).lean() : null;
  return {
    project_name: `${co.co_number} — ${co.name}`,
    bid_number: project?.name || null,
    project_entity_name: project?.name || null,
    customer: null, stage: co.stage,
    estimate_due_date: co.due_date, estimate_amount: co.estimate_amount,
    folder_url: winningBid?.folder_url || null,
  };
}

// Minimal — reuses the generic bidTable/emailReminder template (its "Bid
// Name" row just reads as the project name here) rather than a dedicated
// project template, since On-Hold's 60-day check-in is the only thing that
// needs it right now. Bid/Project ids come from independent counters, so
// this must be its own explicit branch — falling through to bidEmailShape
// with a project's id could coincidentally match an unrelated bid and email
// the wrong project's info entirely.
async function projectEmailShape(projectId) {
  const M = getModels();
  const proj = await M.Project.findById(Number(projectId)).lean();
  if (!proj) return null;
  return { project_name: proj.name, project_id: proj._id };
}
async function emailShapeForReminder(reminder) {
  if (reminder.parent_type === 'project') return projectEmailShape(reminder.parent_id);
  return reminder.parent_type === 'change_order' ? coEmailShape(reminder.parent_id) : bidEmailShape(reminder.parent_id);
}

// A follow-up was logged — notify only the people actually on this bid/CO
// (estimator, salesperson, sub-estimators; a CO's estimator + its Job's PM),
// not the whole department, and skip whoever just logged it themselves.
// parent_type is whatever logFollowupV2 was called with — 'bid_submission'
// resolves up to its parent bid first, same as the reminder/digest paths do.
async function notifyFollowup(parentType, parentId, followupData, actorId) {
  try {
    const M = getModels();
    let bid = null, co = null;
    if (parentType === 'bid_submission') {
      const sub = await M.BidSubmission.findById(Number(parentId)).lean();
      if (sub) bid = await M.Bid.findById(sub.bid_id).lean();
    } else if (parentType === 'bid') {
      bid = await M.Bid.findById(Number(parentId)).lean();
    } else if (parentType === 'change_order') {
      co = await M.ChangeOrder.findById(Number(parentId)).lean();
    }

    let shape = null, recipients = [];
    if (bid) {
      shape = await bidEmailShape(bid._id);
      recipients = await bidRecipients(bid, 'followup');
    } else if (co) {
      shape = await coEmailShape(co._id);
      const job = await M.Job.findById(co.job_id).lean();
      const ids = [...new Set([co.estimator_id, job?.pm_id].filter(Boolean))];
      const members = (await Promise.all(ids.map(emailForV2Member))).filter(Boolean);
      recipients = members.filter(m => mailer.wantsNotification(m, 'followup'));
    }
    if (!shape || !recipients.length) return;

    const actorIdNum = actorId ? Number(actorId) : null;
    const actor = actorIdNum ? await maindb.getMember(actorIdNum) : null;
    const actorName = actor?.name || 'A team member';
    for (const r of recipients) {
      if (actorIdNum && r.id === actorIdNum) continue; // don't notify whoever just logged it
      const { subject, html } = mailer.emailFollowup(shape, followupData.notes || '', followupData.next_followup_date || null, actorName);
      await mailer.sendMail({ to: r.email, subject, html });
    }
  } catch (e) { console.error('[v2 notify] followup email failed:', e.message); }
}

// A bid/CO's due date changed (calendar drag, or edited directly) — notify
// whoever's actually on it. Only fires for Active Bids/Active Change Orders
// (per the team's ask — an opportunity's due date is still being nailed
// down and changes routinely, not worth an email every time), and only
// when the date actually changed. Gated on the 'reminder' category (the
// closest existing pref — there's no dedicated "due date" one) and skips
// whoever made the change themselves.
async function notifyDueDateChanged(kind, id, oldDate, newDate, actorId) {
  if (oldDate === newDate) return;
  try {
    const M = getModels();
    let shape = null, recipients = [];
    const actorIdNum = actorId ? Number(actorId) : null;
    if (kind === 'bid') {
      const bid = await M.Bid.findById(Number(id)).lean();
      if (!bid || !['active_bid', 'submitted'].includes(bid.stage)) return;
      shape = await bidEmailShape(bid._id);
      recipients = await bidRecipients(bid, 'reminder');
    } else {
      const co = await M.ChangeOrder.findById(Number(id)).lean();
      if (!co || !['active_co', 'submitted_co'].includes(co.stage)) return;
      shape = await coEmailShape(co._id);
      const job = await M.Job.findById(co.job_id).lean();
      const ids = [...new Set([co.estimator_id, job?.pm_id].filter(Boolean))];
      const members = (await Promise.all(ids.map(emailForV2Member))).filter(Boolean);
      recipients = members.filter(m => mailer.wantsNotification(m, 'reminder'));
    }
    if (!shape || !recipients.length) return;
    const actor = actorIdNum ? await maindb.getMember(actorIdNum) : null;
    const actorName = actor?.name || 'Someone';
    for (const r of recipients) {
      if (actorIdNum && r.id === actorIdNum) continue;
      const { subject, html } = mailer.emailDueDateChanged(shape, oldDate, newDate, r.name, actorName, kind);
      await mailer.sendMail({ to: r.email, subject, html });
    }
  } catch (e) { console.error('[v2 notify] due-date-changed email failed:', e.message); }
}

module.exports = { bidEmailShape, coEmailShape, emailShapeForReminder, notifyAwarded, notifyRoleAward, notifyApprovedToBid, notifyOwnerToForwardInvite, notifyAssigned, notifyWalkthroughSet, notifyWalkthroughAssignees, notifyFollowup, notifyDueDateChanged, notifyOpportunityClosed, notifyNewOpportunity, bidRecipients, walkthroughContactInfo, emailForV2Member };
