/**
 * v2/routes.js — v2 preview API, mounted by the main server.
 *
 * All paths begin with /api/v2/ so the global auth middleware in server.js
 * protects them automatically (any /api/* path requires a session).
 * Reads ONLY the isolated estimating_v2_test database.
 */
const express = require('express');
const v2db = require('./db');

const router = express.Router();

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

router.get('/api/v2/meta', async (req, res) => {
  try { res.json(await v2db.getMeta()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── State machine: bids ────────────────────────────────────────────────────────
// Transition endpoints return 400 with a clear message on illegal transitions
// or missing required fields (validation lives in v2/db.js).
const t = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) { res.status(400).json({ error: e.message }); }
};

router.post('/api/v2/opportunities',          t(req => v2db.createOpportunity({ ...req.body, created_by: req.session.userId })));
router.post('/api/v2/bids/:id/start',         t(req => v2db.startBid(req.params.id, req.body)));
router.post('/api/v2/bids/:id/submit',        t(req => v2db.submitBid(req.params.id, req.body)));
router.post('/api/v2/bids/:id/award',         t(req => v2db.awardBid(req.params.id, req.body)));
router.post('/api/v2/bids/:id/not-awarded',   t(req => v2db.notAwardBid(req.params.id, req.body)));
router.post('/api/v2/bids/:id/close',         t(req => v2db.closeBid(req.params.id, req.body)));
router.post('/api/v2/bids/:id/revisions',     t(req => v2db.addRevision(req.params.id, req.body)));

// ── Follow-ups (bid or change_order parent) ───────────────────────────────────
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
