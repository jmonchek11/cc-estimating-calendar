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
const maindb = require('../db');   // v1 db — for the logged-in user's admin flag

const router = express.Router();

// Admin gate — the logged-in user is a real v1 user; check their is_admin flag.
async function requireAdmin(req, res, next) {
  try {
    const actor = await maindb.getMember(req.session.userId);
    if (!actor?.is_admin) return res.status(403).json({ error: 'Admin only' });
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

router.get('/api/v2/projects', async (req, res) => {
  try { res.json(await v2db.getProjects()); }
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
  try { res.json(await v2db.getDashboard()); }
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

router.get('/api/v2/health', async (req, res) => {
  try { res.json(await v2db.getDataHealth()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/v2/meta', async (req, res) => {
  try {
    const meta = await v2db.getMeta();
    let current_user = null;
    try {
      const m = await maindb.getMember(req.session.userId);
      if (m) current_user = { id: m.id, name: m.name, is_admin: !!m.is_admin };
    } catch { /* ignore — current_user stays null */ }
    res.json({ ...meta, current_user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── State machine: bids ────────────────────────────────────────────────────────
// Transition endpoints return 400 with a clear message on illegal transitions
// or missing required fields (validation lives in v2/db.js).
const t = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) { res.status(400).json({ error: e.message }); }
};

router.post('/api/v2/opportunities',          t(req => v2db.createOpportunity({ ...req.body, created_by: req.session.userId })));
router.post('/api/v2/bids',                   t(req => v2db.createDirectBid({ ...req.body, created_by: req.session.userId })));
router.post('/api/v2/bids/:id/start',         t(req => v2db.startBid(req.params.id, req.body)));
router.post('/api/v2/bids/:id/submit',        t(req => v2db.submitBid(req.params.id, req.body)));

// Admin-only generic edit for any entity: project | bid | job | change_order | bid_submission
router.patch('/api/v2/admin/:entity/:id',     requireAdmin, t(req => v2db.adminUpdate(req.params.entity, req.params.id, req.body)));
router.post('/api/v2/admin/merge-projects',   requireAdmin, t(req => v2db.mergeProjects(req.body.survivor_id, req.body.merge_ids)));
router.post('/api/v2/admin/merge-companies',  requireAdmin, t(req => v2db.mergeCompanies(req.body.survivor_id, req.body.merge_ids)));
router.post('/api/v2/admin/merge-jobs',       requireAdmin, t(req => v2db.mergeJobs(req.body.survivor_id, req.body.merge_ids)));
router.post('/api/v2/admin/dismiss-duplicate', requireAdmin, t(req => v2db.dismissDuplicates(req.body.kind, req.body.ids)));
router.delete('/api/v2/admin/project/:id',     requireAdmin, t(req => v2db.deleteEmptyProject(req.params.id)));
router.delete('/api/v2/admin/override/:id',    requireAdmin, t(req => v2db.removeOverride(req.params.id)));
router.post('/api/v2/bids/:id/close',         t(req => v2db.closeBid(req.params.id, req.body)));
router.post('/api/v2/bids/:id/submissions',   t(req => v2db.addSubmission(req.params.id, req.body)));
router.post('/api/v2/bids/:id/customers',     t(req => v2db.addBidCustomers(req.params.id, req.body)));

// Per-submission win/loss
router.post('/api/v2/submissions/:id/award',        t(req => v2db.awardSubmission(req.params.id, req.body)));
router.post('/api/v2/submissions/:id/not-awarded',  t(req => v2db.notAwardSubmission(req.params.id, req.body)));

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

// Per-bid-customer contact linking (bid flyout's per-customer contact list)
router.post('/api/v2/bid-customers/:id/contacts',              t(req => v2db.addBidCustomerContact(req.params.id, req.body.contact_id)));
router.delete('/api/v2/bid-customers/:id/contacts/:contactId', t(req => v2db.removeBidCustomerContact(req.params.id, req.params.contactId)));

// ── Follow-ups (bid_submission or change_order parent) ────────────────────────
router.post('/api/v2/followups',              t(req => v2db.logFollowupV2({ ...req.body, contacted_by: req.body.contacted_by || req.session.userId })));

// ── Jobs ──────────────────────────────────────────────────────────────────────
router.post('/api/v2/jobs',                   t(req => v2db.createLegacyJob({ ...req.body, created_by: req.session.userId })));
router.patch('/api/v2/jobs/:id',              t(req => v2db.updateJob(req.params.id, req.body)));
router.post('/api/v2/jobs/:id/change-orders', t(req => v2db.createChangeOrder(req.params.id, req.body)));

// ── Change orders ─────────────────────────────────────────────────────────────
router.post('/api/v2/change-orders/:id/submit',       t(req => v2db.submitCO(req.params.id, req.body)));
router.post('/api/v2/change-orders/:id/approve',      t(req => v2db.approveCO(req.params.id, req.body)));
router.post('/api/v2/change-orders/:id/not-approved', t(req => v2db.notApproveCO(req.params.id, req.body)));
router.post('/api/v2/change-orders/:id/void',         t(req => v2db.voidCO(req.params.id, req.body)));
router.post('/api/v2/change-orders/:id/reopen',       t(req => v2db.reopenCO(req.params.id)));

module.exports = router;
