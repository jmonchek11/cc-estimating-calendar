/**
 * v2/routes.js — v2 preview API, mounted by the main server.
 *
 * All paths begin with /api/v2/ so the global auth middleware in server.js
 * protects them automatically (any /api/* path requires a session).
 * Reads ONLY the isolated estimating_v2_test database.
 */
const express = require('express');
const v2db = require('./db');
const jis = require('./jis');
const notify = require('./notify');
const maindb = require('../db');   // v1 db — for the logged-in user's admin flag
const directory = require('./directory');

const router = express.Router();

// Admin gate — the logged-in user is a real v1 user; check their is_admin flag.
async function requireAdmin(req, res, next) {
  try {
    const actor = await maindb.getMember(req.session.userId);
    if (!actor?.is_admin) return res.status(403).json({ error: 'Admin only' });
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// Same generic editor as requireAdmin gates, but a bid/CO's own assigned
// estimator or salesperson (bid) / estimator (CO) can also edit it, even
// without admin rights — everything else routed through this editor
// (project/company/job/bid_submission, or a bid/CO they AREN'T assigned to)
// still requires real admin. Scoped to just the :entity/:id PATCH route,
// not the merge/delete/other admin-only actions.
async function requireAdminOrAssigned(req, res, next) {
  try {
    const actor = await maindb.getMember(req.session.userId);
    if (actor?.is_admin) return next();
    const { entity, id } = req.params;
    if (actor && entity === 'bid') {
      const bid = await v2db.loadBid(id).catch(() => null);
      if (bid && (bid.estimator_id === actor.id || bid.salesperson_id === actor.id)) return next();
    } else if (actor && entity === 'change_order') {
      const co = await v2db.loadCO(id).catch(() => null);
      if (co && co.estimator_id === actor.id) return next();
    }
    return res.status(403).json({ error: 'Admin only' });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

router.get('/api/v2/projects', async (req, res) => {
  try { res.json(await v2db.getProjects()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/v2/jobs-picker', async (req, res) => {
  try { res.json(await v2db.getJobsPicker()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/v2/projects/:id', async (req, res) => {
  try {
    const detail = await v2db.getProjectDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'Not found' });
    res.json(detail);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/v2/dashboard', async (req, res) => {
  try { res.json(await v2db.getDashboard(req.session.userId, req.query.mine_only === 'true')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/v2/bid-list', async (req, res) => {
  try { res.json(await v2db.getBidList(req.query.stage)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/v2/co-list', async (req, res) => {
  try { res.json(await v2db.getCoList(req.query.stage)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/v2/search', async (req, res) => {
  try { res.json(await v2db.getSearchResults(req.query.q)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/v2/digest', async (req, res) => {
  try { res.json(await v2db.getDigest()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Team (v2's own roster — see v2/notify.js for the id-space note) ───────────
router.get('/api/v2/team',            async (req, res) => { try { res.json(await v2db.getTeamV2()); } catch (e) { res.status(500).json({ error: e.message }); } });

// ── Settings (v2's own follow-up timer config) ────────────────────────────────
router.get('/api/v2/settings',        async (req, res) => { try { res.json(await v2db.getSettings()); } catch (e) { res.status(500).json({ error: e.message }); } });

router.post('/api/v2/admin/send-digest', requireAdmin, async (req, res) => {
  try {
    const mailer = require('../mailer');
    const [digest, users] = await Promise.all([v2db.getDigest(), maindb.getActiveUserEmails()]);
    const { subject, html } = mailer.emailDigest(digest);
    await mailer.sendMail({ to: users.map(u => u.email), subject, html });
    res.json({ ok: true, sent_to: users.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/v2/health', async (req, res) => {
  try { res.json(await v2db.getDataHealth()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/v2/meta', async (req, res) => {
  try {
    const meta = await v2db.getMeta();
    let current_user = null;
    try {
      // TeamMember is one shared collection (v2/merge-team-ids.js, July 2026)
      // so m.id is directly comparable to v2's bid.estimator_id/salesperson_id
      // ("mine only" etc) — no cross-database name bridging needed anymore.
      const m = await maindb.getMember(req.session.userId);
      if (m) {
        const liberty_apps = await directory.getMyApps({ ms_oid: m.ms_oid, email: m.email });
        current_user = { id: m.id, name: m.name, is_admin: !!m.is_admin, role: m.role, liberty_apps };
      }
    } catch { /* ignore — current_user stays null */ }
    res.json({ ...meta, current_user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── State machine: bids ────────────────────────────────────────────────────────
// Transition endpoints return 400 with a clear message on illegal transitions
// or missing required fields (validation lives in v2/db.js).
// `meta(req, result)` — when given, logs an audit-trail row AFTER a
// successful mutation. Fire-and-forget: a logging failure must never affect
// the response the user already got. `meta` may be async (e.g. to look up
// a bid/CO's human-readable label via v2db.bidLabel/coLabel) — it's awaited
// before logging. Most actions here aren't safely auto-reversible, so `meta`
// normally returns no `undo` payload — see UNDOABLE_ACTIONS in v2/db.js for
// the handful that are.
const t = (fn, meta) => async (req, res) => {
  try {
    const result = await fn(req);
    res.json(result);
    if (meta) {
      (async () => {
        try {
          const actor = await actorOf(req);
          const m = await meta(req, result);
          if (m) await v2db.logActivity({ actor_id: actor?.id, actor_name: actor?.name, ...m });
        } catch { /* logging must never surface to the user */ }
      })();
    }
  } catch (e) { res.status(400).json({ error: e.message }); }
};
async function actorOf(req) {
  try { return await maindb.getMember(req.session.userId); } catch { return null; }
}

// Fire assignment emails for whichever of estimator_id/salesperson_id actually
// changed to a new, non-null person (never for the person making the change).
// Fire-and-forget — called after the response is already sent, same pattern
// as the award-email flow below.
function notifyAssignmentDiff(bidId, oldBid, newData, actorId) {
  const newEstId = newData.estimator_id != null ? Number(newData.estimator_id) : undefined;
  if (newEstId && newEstId !== oldBid?.estimator_id) notify.notifyAssigned(bidId, newEstId, actorId, 'estimator');
  const newSpId = newData.salesperson_id != null ? Number(newData.salesperson_id) : undefined;
  if (newSpId && newSpId !== oldBid?.salesperson_id) notify.notifyAssigned(bidId, newSpId, actorId, 'salesperson');
}

// Audit trail — admin-only, same gate as Data Health merges (visibility
// into everyone's activity across the team).
router.get('/api/v2/activity', requireAdmin, async (req, res) => {
  try { res.json(await v2db.getActivityLog({ limit: req.query.limit })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/v2/activity/:id/undo', requireAdmin, t(req => v2db.undoActivity(req.params.id)));

// ── Team (v2's own roster — see v2/notify.js for the id-space note) ───────────
router.post('/api/v2/team',           requireAdmin, t(req => v2db.createTeamMemberV2(req.body),
  (req, r) => ({ action: 'team.create', summary: `Added team member "${req.body.name}"`, entity_type: 'team_member', entity_id: r.id })));
router.patch('/api/v2/team/:id',      requireAdmin, t(req => v2db.updateTeamMemberV2(req.params.id, req.body),
  (req) => ({ action: 'team.update', summary: `Edited team member #${req.params.id} (${Object.keys(req.body).join(', ')})`, entity_type: 'team_member', entity_id: Number(req.params.id) })));

// ── Settings (v2's own follow-up timer config) ────────────────────────────────
router.put('/api/v2/settings',        requireAdmin, t(req => v2db.updateSettingsV2(req.body)));

router.post('/api/v2/opportunities',          t(req => v2db.createOpportunity({ ...req.body, created_by: req.session.userId }),
  async (req, r) => ({ action: 'bid.create_opportunity', summary: `Created opportunity ${await v2db.bidLabel(r.bid_id)}`, entity_type: 'bid', entity_id: r.bid_id })));
router.post('/api/v2/bids',                   t(req => v2db.createDirectBid({ ...req.body, created_by: req.session.userId }),
  async (req, r) => ({ action: 'bid.create', summary: `Created bid ${await v2db.bidLabel(r.bid_id)}`, entity_type: 'bid', entity_id: r.bid_id })));
router.post('/api/v2/bids/:id/start',         t(async req => {
    const oldBid = await v2db.loadBid(req.params.id).catch(() => null);
    const r = await v2db.startBid(req.params.id, req.body, req.session.userId);
    notifyAssignmentDiff(Number(req.params.id), oldBid, req.body, req.session.userId);
    return r;
  },
  async (req) => ({ action: 'bid.start', summary: `Started bid ${await v2db.bidLabel(req.params.id)}`, entity_type: 'bid', entity_id: Number(req.params.id) })));
router.post('/api/v2/bids/:id/submit',        t(req => v2db.submitBid(req.params.id, req.body, req.session.userId),
  async (req) => ({ action: 'bid.submit', summary: `Submitted bid ${await v2db.bidLabel(req.params.id)}`, entity_type: 'bid', entity_id: Number(req.params.id) })));

// Generic edit for any entity: project | bid | job | change_order | bid_submission.
// Admin-only, EXCEPT a bid/CO's own assigned estimator/salesperson can also
// edit that specific one — see requireAdminOrAssigned above.
router.patch('/api/v2/admin/:entity/:id',     requireAdminOrAssigned, t(async req => {
    const oldBid = req.params.entity === 'bid' ? await v2db.loadBid(req.params.id).catch(() => null) : null;
    const r = await v2db.adminUpdate(req.params.entity, req.params.id, req.body);
    if (req.params.entity === 'bid') notifyAssignmentDiff(Number(req.params.id), oldBid, req.body, req.session.userId);
    return r;
  },
  async (req) => {
    const label = req.params.entity === 'bid' ? await v2db.bidLabel(req.params.id)
      : req.params.entity === 'change_order' ? await v2db.coLabel(req.params.id)
      : `${req.params.entity} #${req.params.id}`;
    return { action: 'admin.edit', summary: `Edited ${label} (${Object.keys(req.body).join(', ')})`, entity_type: req.params.entity, entity_id: Number(req.params.id) };
  }));
router.post('/api/v2/admin/merge-projects',   requireAdmin, t(req => v2db.mergeProjects(req.body.survivor_id, req.body.merge_ids),
  (req) => ({ action: 'admin.merge_projects', summary: `Merged ${(req.body.merge_ids||[]).length} project(s) into #${req.body.survivor_id}`, entity_type: 'project', entity_id: Number(req.body.survivor_id) })));
router.post('/api/v2/admin/merge-companies',  requireAdmin, t(req => v2db.mergeCompanies(req.body.survivor_id, req.body.merge_ids),
  (req) => ({ action: 'admin.merge_companies', summary: `Merged ${(req.body.merge_ids||[]).length} compan(y/ies) into #${req.body.survivor_id}`, entity_type: 'company', entity_id: Number(req.body.survivor_id) })));
router.post('/api/v2/admin/merge-jobs',       requireAdmin, t(req => v2db.mergeJobs(req.body.survivor_id, req.body.merge_ids),
  (req) => ({ action: 'admin.merge_jobs', summary: `Merged ${(req.body.merge_ids||[]).length} job(s) into #${req.body.survivor_id}`, entity_type: 'job', entity_id: Number(req.body.survivor_id) })));
router.post('/api/v2/admin/dismiss-duplicate', requireAdmin, t(req => v2db.dismissDuplicates(req.body.kind, req.body.ids)));
router.delete('/api/v2/admin/project/:id',     requireAdmin, t(req => v2db.deleteEmptyProject(req.params.id),
  (req) => ({ action: 'admin.delete_project', summary: `Deleted empty project #${req.params.id}`, entity_type: 'project', entity_id: Number(req.params.id) })));
router.delete('/api/v2/admin/bid/:id',         requireAdmin, t(req => v2db.deleteBid(req.params.id),
  (req, r) => ({ action: 'admin.delete_bid', summary: `Deleted bid ${r.label}`, entity_type: 'bid', entity_id: Number(req.params.id) })));
router.post('/api/v2/admin/merge-contacts',    requireAdmin, t(req => v2db.mergeContacts(req.body.survivor_id, req.body.merge_ids),
  (req) => ({ action: 'admin.merge_contacts', summary: `Merged ${(req.body.merge_ids||[]).length} contact(s) into #${req.body.survivor_id}`, entity_type: 'contact', entity_id: Number(req.body.survivor_id) })));
router.delete('/api/v2/admin/company/:id',     requireAdmin, t(req => v2db.deleteCompany(req.params.id),
  (req) => ({ action: 'admin.delete_company', summary: `Deleted empty company #${req.params.id}`, entity_type: 'company', entity_id: Number(req.params.id) })));
router.delete('/api/v2/admin/change-order/:id', requireAdmin, t(req => v2db.deleteChangeOrder(req.params.id),
  (req, r) => ({ action: 'admin.delete_co', summary: `Deleted change order ${r.label}`, entity_type: 'change_order', entity_id: Number(req.params.id) })));
router.delete('/api/v2/admin/override/:id',    requireAdmin, t(req => v2db.removeOverride(req.params.id)));
router.post('/api/v2/bids/:id/close',         t(req => v2db.closeBid(req.params.id, req.body, req.session.userId),
  async (req) => ({ action: 'bid.close', summary: `Closed bid ${await v2db.bidLabel(req.params.id)} — ${req.body.close_reason || 'no reason given'}`, entity_type: 'bid', entity_id: Number(req.params.id) })));
router.post('/api/v2/bids/:id/submissions',   t(req => v2db.addSubmission(req.params.id, req.body),
  async (req) => ({ action: 'bid.add_submission', summary: `Added a submission to bid ${await v2db.bidLabel(req.params.id)}`, entity_type: 'bid', entity_id: Number(req.params.id) })));
router.post('/api/v2/bids/:id/reactivate',    t(req => v2db.reactivateBid(req.params.id, req.body, req.session.userId),
  async (req) => ({ action: 'bid.reactivate', summary: `Reactivated bid ${await v2db.bidLabel(req.params.id)} for a new round`, entity_type: 'bid', entity_id: Number(req.params.id) })));
router.post('/api/v2/bids/:id/customers',     t(req => v2db.addBidCustomers(req.params.id, req.body),
  async (req) => ({ action: 'bid.add_customers', summary: `Added customer(s) to bid ${await v2db.bidLabel(req.params.id)}`, entity_type: 'bid', entity_id: Number(req.params.id) })));
router.patch('/api/v2/bids/:id/opportunity',  t(async req => {
    const oldBid = await v2db.loadBid(req.params.id).catch(() => null);
    const r = await v2db.updateOpportunity(req.params.id, req.body);
    notifyAssignmentDiff(Number(req.params.id), oldBid, req.body, req.session.userId);
    return r;
  },
  async (req) => ({ action: 'bid.opportunity_edit', summary: `Edited opportunity ${await v2db.bidLabel(req.params.id)} (${Object.keys(req.body).join(', ')})`, entity_type: 'bid', entity_id: Number(req.params.id) })));
router.post('/api/v2/bids/:id/sub-estimators',   t(async req => {
    const r = await v2db.addSubEstimator(req.params.id, req.body, await actorOf(req));
    if (req.body.estimator_id) notify.notifyAssigned(Number(req.params.id), Number(req.body.estimator_id), req.session.userId, 'sub_estimator');
    return r;
  }));
router.delete('/api/v2/bids/:id/sub-estimators', t(async req => v2db.removeSubEstimator(req.params.id, req.body.estimator_id, req.body.scope, await actorOf(req))));
router.delete('/api/v2/bid-customers/:id',    t(req => v2db.removeBidCustomer(req.params.id),
  async (req, r) => ({ action: 'bid.remove_customer', summary: `Removed a customer from bid ${await v2db.bidLabel(r.bid_id)}`, entity_type: 'bid', entity_id: r.bid_id })));

// Per-submission win/loss
router.post('/api/v2/submissions/:id/award', async (req, res) => {
  try {
    const result = await v2db.awardSubmission(req.params.id, req.body, req.session.userId);
    res.json(result);
    // fire-and-forget — never let a mail failure (or a logging failure) affect the award itself
    maindb.getMember(req.session.userId).then(async actor => {
      notify.notifyAwarded(result.bid_id, actor?.name);
      v2db.logActivity({ actor_id: actor?.id, actor_name: actor?.name, action: 'bid.award',
        summary: `Awarded bid ${await v2db.bidLabel(result.bid_id)}`, entity_type: 'bid', entity_id: result.bid_id }).catch(() => {});
    }).catch(() => {});
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/api/v2/submissions/:id/not-awarded',  t(req => v2db.notAwardSubmission(req.params.id, req.body, req.session.userId),
  async (req, r) => ({ action: 'bid.not_awarded', summary: `Marked a submission not awarded on bid ${await v2db.bidLabel(r.bid_id)}`, entity_type: 'bid', entity_id: r.bid_id })));

// ── Import Bid from JIS (Job Information Sheet) ───────────────────────────────
// file_base64: the .xlsx file, base64-encoded (existing express.json limit is
// 25mb, plenty for a JIS). Preview writes nothing; apply performs the actual
// create-or-enrich after the user has reviewed/corrected any matches.
router.post('/api/v2/jis/preview', async (req, res) => {
  try {
    if (!req.body.file_base64) return res.status(400).json({ error: 'No file provided' });
    const buffer = Buffer.from(req.body.file_base64, 'base64');
    res.json(await jis.previewJISImport(buffer));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/api/v2/jis/apply', t(req => jis.applyJISImport(req.body)));

// ── Contacts ──────────────────────────────────────────────────────────────────
router.get('/api/v2/contacts',           async (req, res) => { try { res.json(await v2db.getContacts(req.query)); } catch (e) { res.status(500).json({ error: e.message }); } });
router.get('/api/v2/contacts/:id',       async (req, res) => { try { const c = await v2db.getContactDetail(req.params.id); if (!c) return res.status(404).json({ error: 'Not found' }); res.json(c); } catch (e) { res.status(500).json({ error: e.message }); } });
router.get('/api/v2/contacts/:id/bids',  async (req, res) => { try { res.json(await v2db.getContactBids(req.params.id)); } catch (e) { res.status(500).json({ error: e.message }); } });
router.post('/api/v2/contacts',          t(req => v2db.createContact(req.body)));
router.patch('/api/v2/contacts/:id',     t(req => v2db.updateContact(req.params.id, req.body)));
router.delete('/api/v2/contacts/:id',    t(req => v2db.deleteContact(req.params.id)));

router.get('/api/v2/companies/:id/bids', async (req, res) => { try { res.json(await v2db.getCompanyBids(req.params.id)); } catch (e) { res.status(500).json({ error: e.message }); } });
router.post('/api/v2/companies',         t(req => v2db.createCompanyV2(req.body)));

// Per-bid-customer contact linking (bid flyout's per-customer contact list)
router.post('/api/v2/bid-customers/:id/contacts',              t(req => v2db.addBidCustomerContact(req.params.id, req.body.contact_id)));
router.delete('/api/v2/bid-customers/:id/contacts/:contactId', t(req => v2db.removeBidCustomerContact(req.params.id, req.params.contactId)));

// ── Follow-ups (bid_submission or change_order parent) ────────────────────────
router.post('/api/v2/followups',              t(req => v2db.logFollowupV2({ ...req.body, contacted_by: req.body.contacted_by || req.session.userId })));

// ── Reminders (polymorphic — bid or change_order) ─────────────────────────────
router.get('/api/v2/reminders',                async (req, res) => { try { res.json(await v2db.getRemindersFor(req.query.parent_type, req.query.parent_id)); } catch (e) { res.status(500).json({ error: e.message }); } });
router.post('/api/v2/reminders',               t(req => v2db.addReminder(req.body.parent_type, req.body.parent_id, req.body)));
router.put('/api/v2/reminders/:id/dismiss',    t(req => v2db.dismissReminder(req.params.id),
  (req) => ({ action: 'reminder.dismiss', summary: `Dismissed reminder #${req.params.id}`, entity_type: 'reminder', entity_id: Number(req.params.id), undo: { reminder_id: Number(req.params.id) } })));
router.delete('/api/v2/reminders/:id',         t(req => v2db.deleteReminder(req.params.id)));

// ── Notes (polymorphic — bid or change_order; dateless, separate from Reminders) ──
router.get('/api/v2/notes',                    async (req, res) => { try { res.json(await v2db.getNotesFor(req.query.parent_type, req.query.parent_id)); } catch (e) { res.status(500).json({ error: e.message }); } });
router.post('/api/v2/notes',                   t(req => v2db.addNote(req.body.parent_type, req.body.parent_id, req.body, req.session.userId)));
router.delete('/api/v2/notes/:id',             t(req => v2db.deleteNote(req.params.id)));

// ── Jobs ──────────────────────────────────────────────────────────────────────
router.post('/api/v2/jobs',                   t(req => v2db.createLegacyJob({ ...req.body, created_by: req.session.userId }),
  (req, r) => ({ action: 'job.create_legacy', summary: `Created legacy job #${r.job_id || r.id}`, entity_type: 'job', entity_id: r.job_id || r.id })));
router.patch('/api/v2/jobs/:id',              t(req => v2db.updateJob(req.params.id, req.body, req.session.userId),
  (req) => ({ action: 'job.update', summary: `Edited job #${req.params.id} (${Object.keys(req.body).join(', ')})`, entity_type: 'job', entity_id: Number(req.params.id) })));
router.post('/api/v2/jobs/:id/change-orders', t(req => v2db.createChangeOrder(req.params.id, req.body, req.session.userId),
  async (req, r) => ({ action: 'co.create', summary: `Created CO ${await v2db.coLabel(r.co_id)} on job #${req.params.id}`, entity_type: 'change_order', entity_id: r.co_id })));

// ── Change orders ─────────────────────────────────────────────────────────────
router.post('/api/v2/change-orders/:id/submit',       t(req => v2db.submitCO(req.params.id, req.body, req.session.userId),
  async (req) => ({ action: 'co.submit', summary: `Submitted CO ${await v2db.coLabel(req.params.id)}`, entity_type: 'change_order', entity_id: Number(req.params.id) })));
router.post('/api/v2/change-orders/:id/approve',      t(req => v2db.approveCO(req.params.id, req.body, req.session.userId),
  async (req) => ({ action: 'co.approve', summary: `Approved CO ${await v2db.coLabel(req.params.id)}`, entity_type: 'change_order', entity_id: Number(req.params.id) })));
router.post('/api/v2/change-orders/:id/not-approved', t(req => v2db.notApproveCO(req.params.id, req.body, req.session.userId),
  async (req) => ({ action: 'co.not_approved', summary: `Marked CO ${await v2db.coLabel(req.params.id)} not approved`, entity_type: 'change_order', entity_id: Number(req.params.id) })));
router.post('/api/v2/change-orders/:id/void',         t(req => v2db.voidCO(req.params.id, req.body, req.session.userId),
  async (req) => ({ action: 'co.void', summary: `Voided CO ${await v2db.coLabel(req.params.id)} — ${req.body.void_reason || 'no reason given'}`, entity_type: 'change_order', entity_id: Number(req.params.id) })));
router.post('/api/v2/change-orders/:id/reopen',       t(req => v2db.reopenCO(req.params.id, req.session.userId),
  async (req) => ({ action: 'co.reopen', summary: `Reopened CO ${await v2db.coLabel(req.params.id)}`, entity_type: 'change_order', entity_id: Number(req.params.id) })));
router.post('/api/v2/change-orders/:id/revise',       t(req => v2db.reviseCO(req.params.id, req.body),
  async (req, r) => ({ action: 'co.revise', summary: `Revised CO ${await v2db.coLabel(req.params.id)} → new CO ${await v2db.coLabel(r.co_id)}`, entity_type: 'change_order', entity_id: r.co_id })));
router.patch('/api/v2/bids/:id/due-date',             t(async req => v2db.updateBidDueDate(req.params.id, req.body.due_date, await actorOf(req))));
router.patch('/api/v2/change-orders/:id/due-date',    t(async req => v2db.updateCoDueDate(req.params.id, req.body.due_date, await actorOf(req))));

module.exports = router;
