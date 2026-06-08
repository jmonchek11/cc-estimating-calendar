require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const path = require('path');
const db = require('./db');

const app = express();
app.use(express.json({ limit: '25mb' }));

// ── Session ───────────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'cc-estimating-2026-local',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    ttl: 8 * 60 * 60, // 8 hours
    autoRemove: 'native'
  }),
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

// Serve static files before auth middleware
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware — protects /api/ routes except public ones
const PUBLIC_API = ['/api/auth/', '/api/team', '/api/tv/'];
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (PUBLIC_API.some(p => req.path.startsWith(p))) return next();
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
});

// ── TV Kiosk ──────────────────────────────────────────────────────────────────
// Support both /tv?token=xxx  AND  /tv/xxx  (path style — friendlier for Fully Kiosk)
app.get('/tv',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));
app.get('/tv/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));

app.get('/api/tv/data', async (req, res) => {
  const token = req.query.token;
  const expected = process.env.TV_TOKEN;
  if (!expected || token !== expected) return res.status(401).json({ error: 'Invalid TV token' });

  try {
    const mongoose = require('mongoose');
    const Bid        = require('./models/Bid');
    const TeamMember = require('./models/TeamMember');

    const pipeline = [
      { $lookup: { from: 'teammembers', localField: 'estimator_id',   foreignField: '_id', as: 'estimator'   } },
      { $lookup: { from: 'teammembers', localField: 'salesperson_id', foreignField: '_id', as: 'salesperson' } },
      { $unwind: { path: '$estimator',   preserveNullAndEmptyArrays: true } },
      { $unwind: { path: '$salesperson', preserveNullAndEmptyArrays: true } },
    ];

    // Active bids + change orders
    const bids = await Bid.aggregate([
      { $match: { stage: { $in: ['active_bid', 'active_co'] }, is_deleted: { $ne: 1 } } },
      ...pipeline,
      { $sort: { estimate_due_date: 1 } },
    ]);

    // Recent wins (last 60 days)
    const since = new Date(); since.setDate(since.getDate() - 60);
    const sinceStr = since.toISOString().split('T')[0];
    const wins = await Bid.aggregate([
      { $match: { stage: 'awarded', award_date: { $gte: sinceStr }, is_deleted: { $ne: 1 } } },
      ...pipeline,
      { $sort: { award_date: -1 } },
      { $limit: 15 },
    ]);

    // Stats
    const today   = new Date().toISOString().split('T')[0];
    const in7     = new Date(); in7.setDate(in7.getDate() + 7);
    const weekEnd = in7.toISOString().split('T')[0];

    const fmt = b => ({
      id:                    b._id,
      bid_number:            b.bid_number   || null,
      stage:                 b.stage,
      project_name:          b.project_name,
      customer:              b.customer     || null,
      estimate_due_date:     b.estimate_due_date    || null,
      estimate_amount:       b.estimate_amount      || null,
      estimate_pct_complete: b.estimate_pct_complete || 0,
      award_date:            b.award_date   || null,
      estimator_id:          b.estimator_id || null,
      estimator_initials:    b.estimator?.initials  || null,
      estimator_name:        b.estimator?.name      || null,
      salesperson_initials:  b.salesperson?.initials || null,
    });

    res.json({
      bids:  bids.map(fmt),
      wins:  wins.map(fmt),
      stats: {
        activeBids:    bids.filter(b => b.stage === 'active_bid').length,
        activeCOs:     bids.filter(b => b.stage === 'active_co').length,
        pipelineValue: bids.reduce((s, b) => s + (b.estimate_amount || 0), 0),
        dueThisWeek:   bids.filter(b => b.estimate_due_date >= today && b.estimate_due_date <= weekEnd).length,
        overdueCount:  bids.filter(b => b.estimate_due_date && b.estimate_due_date < today).length,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Password strength helper ───────────────────────────────────────────────────
function isStrongPassword(pwd) {
  return typeof pwd === 'string' && pwd.length >= 8 &&
    /[A-Z]/.test(pwd) && /[a-z]/.test(pwd) &&
    /[0-9]/.test(pwd) && /[^A-Za-z0-9]/.test(pwd);
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) return res.json(null);
  try {
    const member = await db.getMember(req.session.userId);
    res.json(member || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    const member = await db.loginUser(email, password);
    if (!member) return res.status(401).json({ error: 'Invalid email or password.' });
    req.session.userId = member.id;
    res.json(member);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.post('/api/auth/set-password', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const { password } = req.body;
    if (!isStrongPassword(password)) {
      return res.status(400).json({ error: 'Password does not meet strength requirements.' });
    }
    await db.setPassword(req.session.userId, password);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TEAM ──────────────────────────────────────────────────────────────────────
app.get('/api/team', async (req, res) => {
  try { res.json(await db.getAllTeam()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/team', async (req, res) => {
  try {
    const admin = await db.getMember(req.session.userId);
    if (!admin || !admin.is_admin) return res.status(403).json({ error: 'Admin only.' });
    res.json(await db.createTeamMember(req.body));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/team/:id', async (req, res) => {
  try {
    const admin = await db.getMember(req.session.userId);
    if (!admin || !admin.is_admin) return res.status(403).json({ error: 'Admin only.' });
    res.json(await db.updateTeamMember(req.params.id, req.body));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/team/:id/reset-password', async (req, res) => {
  try {
    const admin = await db.getMember(req.session.userId);
    if (!admin || !admin.is_admin) return res.status(403).json({ error: 'Admin only.' });
    const { temp_password } = req.body;
    if (!temp_password) return res.status(400).json({ error: 'temp_password is required.' });
    await db.adminSetTempPassword(req.params.id, temp_password);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BIDS ──────────────────────────────────────────────────────────────────────
app.get('/api/bids', async (req, res) => {
  try {
    const query = { ...req.query };
    if (query.mine_only === 'true') query.userId = req.session.userId;
    res.json(await db.getBids(query));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bids', async (req, res) => {
  try {
    const data = { ...req.body };
    if (req.session.userId) data.created_by = req.session.userId;
    res.json(await db.createBid(data));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Static sub-routes must come BEFORE /api/bids/:id or Express matches them as an id
app.get('/api/bids/rfc-cleanup', async (req, res) => {
  try { res.json(await db.getRfcJobNumberBids()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bids/:id', async (req, res) => {
  try {
    const bid = await db.getBid(req.params.id);
    bid ? res.json(bid) : res.status(404).json({ error: 'Not found' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/bids/:id', async (req, res) => {
  try { res.json(await db.updateBid(req.params.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/bids/:id', async (req, res) => {
  try { await db.deleteBid(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SETTINGS ──────────────────────────────────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  try { res.json(await db.getSettings()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', async (req, res) => {
  try {
    const admin = await db.getMember(req.session.userId);
    if (!admin || !admin.is_admin) return res.status(403).json({ error: 'Admin only.' });
    res.json(await db.updateSettings(req.body));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── BID REMINDERS ─────────────────────────────────────────────────────────────
app.post('/api/bids/:id/reminders', async (req, res) => {
  try { res.json(await db.addReminder(req.params.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/bids/:id/reminders/:rid/dismiss', async (req, res) => {
  try { res.json(await db.dismissReminder(req.params.id, req.params.rid)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/bids/:id/reminders/:rid', async (req, res) => {
  try { res.json(await db.deleteReminder(req.params.id, req.params.rid)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CONTACT & COMPANY PROFILES ───────────────────────────────────────────────
app.get('/api/contacts/:id/bids', async (req, res) => {
  try { res.json(await db.getContactBids(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/companies/bids', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'name required' });
    res.json(await db.getCompanyBids(name));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BID LIFECYCLE (phases & CO links) ─────────────────────────────────────────
app.get('/api/bids/check-duplicate', async (req, res) => {
  try { res.json(await db.checkDuplicateBidNumber(req.query.bid_number || '')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bids/:id/phases', async (req, res) => {
  try { res.json(await db.savePhase(req.params.id, req.body.label || '')); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/bids/:id/linked-cos', async (req, res) => {
  try { res.json(await db.getLinkedCOs(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/bids/:id/link-parent', async (req, res) => {
  try {
    const { parent_bid_id } = req.body;
    if (!parent_bid_id) return res.status(400).json({ error: 'parent_bid_id required' });
    res.json(await db.linkCOToParent(req.params.id, parent_bid_id));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── BID CONTACTS ──────────────────────────────────────────────────────────────
app.get('/api/bids/:id/contacts', async (req, res) => {
  try { res.json(await db.getBidContacts(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bids/:id/contacts', async (req, res) => {
  try {
    const { customer_name, contact_id } = req.body;
    if (!contact_id || !customer_name) return res.status(400).json({ error: 'customer_name and contact_id required' });
    res.json(await db.addBidContact(req.params.id, customer_name, contact_id));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/bids/:id/contacts/unlink', async (req, res) => {
  try {
    const { customer_name, contact_id } = req.body;
    if (!contact_id || !customer_name) return res.status(400).json({ error: 'customer_name and contact_id required' });
    res.json(await db.removeBidContact(req.params.id, customer_name, contact_id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FOLLOW-UPS ────────────────────────────────────────────────────────────────
app.get('/api/bids/:id/followups', async (req, res) => {
  try { res.json(await db.getFollowups(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bids/:id/followups', async (req, res) => {
  try { res.json(await db.logFollowup(req.params.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── ESTIMATOR PROFILE ─────────────────────────────────────────────────────────
app.get('/api/estimators/:id/bids', async (req, res) => {
  try { res.json(await db.getEstimatorBids(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── STATS & DIGEST ────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try { res.json(await db.getStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/digest', async (req, res) => {
  try { res.json(await db.getDigest()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/my-stats', async (req, res) => {
  try { res.json(await db.getMyStats(req.session.userId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ANALYTICS ─────────────────────────────────────────────────────────────────
app.get('/api/analytics', async (req, res) => {
  try { res.json(await db.getAnalytics(req.query.since || null, req.query.until || null)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PROJECTS ──────────────────────────────────────────────────────────────────
app.get('/api/projects', async (req, res) => {
  try { res.json(await db.getProjects(req.query)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects', async (req, res) => {
  try { res.json(await db.createProject(req.body.name, req.session.userId || null)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/projects/:id', async (req, res) => {
  try {
    const p = await db.getProject(req.params.id);
    p ? res.json(p) : res.status(404).json({ error: 'Not found' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/projects/:id', async (req, res) => {
  try { res.json(await db.updateProject(req.params.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/projects/:id/bids', async (req, res) => {
  try { res.json(await db.getProjectBids(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Online presence ───────────────────────────────────────────────────────────
app.post('/api/heartbeat', async (req, res) => {
  if (!req.session.userId) return res.json({ ok: false });
  try { await db.heartbeat(req.session.userId); res.json({ ok: true }); }
  catch (e) { res.json({ ok: false }); }
});

app.get('/api/online', async (req, res) => {
  try { res.json(await db.getOnlineUsers()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Ideas / feedback ──────────────────────────────────────────────────────────
app.post('/api/ideas', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  try { res.json(await db.submitIdea({ ...req.body, submitted_by: req.session.userId })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/ideas', async (req, res) => {
  try {
    const user = await db.getMember(req.session.userId);
    if (!user || !user.is_admin) return res.status(403).json({ error: 'Admin only' });
    res.json(await db.getIdeas());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/ideas/:id', async (req, res) => {
  try {
    const user = await db.getMember(req.session.userId);
    if (!user || !user.is_admin) return res.status(403).json({ error: 'Admin only' });
    await db.updateIdeaStatus(req.params.id, req.body.status);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/projects/:id/scan-job', async (req, res) => {
  try { res.json(await db.scanProjectByJobNumber(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects/:id/bulk-link', async (req, res) => {
  try {
    await db.bulkLinkBidsToProject(req.params.id, req.body.bid_ids || []);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/projects/:id', async (req, res) => {
  try { await db.deleteProject(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/migrate-projects', async (req, res) => {
  try {
    const admin = await db.getMember(req.session.userId);
    if (!admin || !admin.is_admin) return res.status(403).json({ error: 'Admin only.' });
    res.json(await db.runProjectMigration());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/merge-projects', async (req, res) => {
  try {
    const admin = await db.getMember(req.session.userId);
    if (!admin || !admin.is_admin) return res.status(403).json({ error: 'Admin only.' });
    const { keep_id, absorb_ids } = req.body;
    res.json(await db.mergeProjects(keep_id, absorb_ids || []));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/ignored-pairs', async (req, res) => {
  try {
    const admin = await db.getMember(req.session.userId);
    if (!admin || !admin.is_admin) return res.status(403).json({ error: 'Admin only.' });
    const { id1, id2 } = req.body;
    await db.addIgnoredPair(Number(id1), Number(id2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CONTACTS ──────────────────────────────────────────────────────────────────
app.get('/api/contacts', async (req, res) => {
  try { res.json(await db.getContacts(req.query)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/contacts', async (req, res) => {
  try { res.json(await db.createContact(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/contacts/:id', async (req, res) => {
  try {
    const c = await db.getContact(req.params.id);
    c ? res.json(c) : res.status(404).json({ error: 'Not found' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/contacts/:id', async (req, res) => {
  try { res.json(await db.updateContact(req.params.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/contacts/:id', async (req, res) => {
  try {
    const admin = await db.getMember(req.session.userId);
    if (!admin || !admin.is_admin) return res.status(403).json({ error: 'Admin only.' });
    await db.deleteContact(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: Excel import / sync ────────────────────────────────────────────────
app.post('/api/admin/sync-excel', async (req, res) => {
  try {
    const admin = await db.getMember(req.session.userId);
    if (!admin || !admin.is_admin) return res.status(403).json({ error: 'Admin only.' });

    const { fileData } = req.body;
    if (!fileData) return res.status(400).json({ error: 'No fileData provided.' });

    const buffer = Buffer.from(fileData, 'base64');
    const { syncFromBuffer } = require('./sync-excel-lib');
    const stats = await syncFromBuffer(buffer);
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: Contacts CSV import ────────────────────────────────────────────────
app.post('/api/admin/import-contacts', async (req, res) => {
  try {
    const admin = await db.getMember(req.session.userId);
    if (!admin || !admin.is_admin) return res.status(403).json({ error: 'Admin only.' });
    const { fileData } = req.body;
    if (!fileData) return res.status(400).json({ error: 'No fileData provided.' });
    const buffer = Buffer.from(fileData, 'base64');
    const stats = await db.importContacts(buffer);
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: orphan estimator repair ────────────────────────────────────────────
app.get('/api/admin/orphan-estimators', async (req, res) => {
  try {
    const admin = await db.getMember(req.session.userId);
    if (!admin || !admin.is_admin) return res.status(403).json({ error: 'Admin only.' });
    res.json(await db.findOrphanEstimators());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/fix-orphan-estimators', async (req, res) => {
  try {
    const admin = await db.getMember(req.session.userId);
    if (!admin || !admin.is_admin) return res.status(403).json({ error: 'Admin only.' });
    res.json(await db.fixOrphanEstimators(req.body.fixes || []));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('ERROR: MONGODB_URI environment variable is not set.');
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    const PORT = process.env.PORT || 3000;
    // Open the port immediately so Render's health check passes,
    // then run seed/migrations in the background.
    app.listen(PORT, '0.0.0.0', () => {
      console.log('\n========================================');
      console.log('  Liberty Estimating Calendar');
      console.log(`  http://localhost:${PORT}`);
      console.log('========================================\n');
      db.seedTeamData().catch(err => console.error('seedTeamData error:', err.message));
    });
  })
  .catch(err => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
