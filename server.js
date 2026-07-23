require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');
const db = require('./db');
const mailer = require('./mailer');
const msauth = require('./msauth');
const v2db = require('./v2/db');
const v2notify = require('./v2/notify');

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

// ── Cutover: v2 is now the primary app at "/". v1 stays reachable at
// "/legacy" as a fallback. Must be registered BEFORE express.static, which
// would otherwise auto-serve public/index.html (v1) for "/" on its own.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'v2.html')));
app.get('/legacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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

// ── V2 PREVIEW (isolated test database — see docs/DATA_MODEL_SPEC.md) ─────────
app.use(require('./v2/routes'));
app.get('/v2', (req, res) => res.sendFile(path.join(__dirname, 'public', 'v2.html')));

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

app.get('/api/auth/sso-status', (req, res) => {
  res.json({ enabled: msauth.isConfigured() });
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

// Verify the current user's password (used for destructive-action confirmation)
app.post('/api/auth/verify-password', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const { password } = req.body;
    if (!password) return res.json({ valid: false });
    const valid = await db.verifyUserPassword(req.session.userId, password);
    res.json({ valid: !!valid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Microsoft Entra ID (SSO) — top-level routes, not under /api/, so the
// /api/* auth middleware doesn't apply (no PUBLIC_API change needed). Both
// no-op safely (redirect with a clear query param) when AZURE_* env vars
// aren't set yet, so a deploy before Joe adds them in Render can't crash.
app.get('/auth/login', async (req, res) => {
  if (!msauth.isConfigured()) return res.redirect('/legacy?sso=unavailable');
  try {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.msAuthState = state;
    const url = await msauth.getAuthCodeUrl(state);
    res.redirect(url);
  } catch (e) {
    console.error('MS auth login error:', e);
    res.redirect('/legacy?sso=error');
  }
});

app.get('/auth/callback', async (req, res) => {
  if (!msauth.isConfigured()) return res.redirect('/legacy?sso=unavailable');
  try {
    const expectedState = req.session.msAuthState;
    delete req.session.msAuthState;
    if (!req.query.state || req.query.state !== expectedState) return res.status(403).send('Invalid state');

    const response = await msauth.acquireTokenByCode(req.query.code);
    const claims = response.idTokenClaims || {};
    const oid = claims.oid;
    const email = claims.preferred_username || claims.email;
    const name = response.account?.name || claims.name;

    const member = await db.loginWithMicrosoft({ oid, email, name });
    if (!member) return res.redirect('/legacy?sso=nomatch');

    req.session.userId = member.id;
    res.redirect('/');
  } catch (e) {
    console.error('MS auth callback error:', e);
    res.redirect('/legacy?sso=error');
  }
});

// Admin-only: send test email + trigger digest on demand
app.post('/api/admin/test-email', async (req, res) => {
  try {
    const actor = await db.getMember(req.session.userId);
    if (!actor?.is_admin) return res.status(403).json({ error: 'Admin only' });
    await mailer.sendMail({
      to: actor.email,
      subject: '✅ LIS Estimating Calendar — Email Connected',
      html: `<div style="font-family:sans-serif;padding:24px;max-width:500px">
        <h2 style="color:#166534">✅ Email is working!</h2>
        <p>The LIS Estimating Calendar email system is connected and ready.<br>
        Notifications will be sent from <strong>${process.env.EMAIL_USER || 'libertyintsolutions@gmail.com'}</strong>.</p>
        <p style="color:#64748b;font-size:13px">Sent to: ${actor.email}</p>
      </div>`,
    });
    res.json({ ok: true, sent_to: actor.email });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/send-digest', async (req, res) => {
  try {
    const actor = await db.getMember(req.session.userId);
    if (!actor?.is_admin) return res.status(403).json({ error: 'Admin only' });
    const [digest, users] = await Promise.all([db.getDigest(), db.getActiveUserEmails()]);
    const { subject, html } = mailer.emailDigest(digest);
    await mailer.sendMail({ to: users.map(u => u.email), subject, html });
    res.json({ ok: true, sent_to: users.length });
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

app.get('/api/bids/propagate-customers', async (req, res) => {
  try { res.json(await db.getPropagatableCustomers()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bids/propagate-customers', async (req, res) => {
  try { res.json({ updated: await db.applyPropagateCustomers() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bids/propagate-customers-jobnum', async (req, res) => {
  try { res.json(await db.getPropagatableCustomersByJobNum()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bids/propagate-customers-jobnum', async (req, res) => {
  try { res.json({ updated: await db.applyPropagateCustomersByJobNum() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bids/:id', async (req, res) => {
  try {
    const bid = await db.getBid(req.params.id);
    bid ? res.json(bid) : res.status(404).json({ error: 'Not found' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/bids/:id', async (req, res) => {
  try {
    const oldBid = await db.getBidRaw(req.params.id);
    const updated = await db.updateBid(req.params.id, req.body);
    res.json(updated);

    // Fire email notifications asynchronously — never block the response
    (async () => {
      try {
        const actor = req.session.userId ? await db.getMember(req.session.userId) : null;
        const actorName = actor?.name || 'A team member';

        // Assignment — estimator changed to a new person (emails even when
        // the actor assigned themselves — see mailer.js emailAssigned callers)
        const newEstId = req.body.estimator_id != null ? Number(req.body.estimator_id) : undefined;
        if (newEstId && newEstId !== oldBid?.estimator_id) {
          const recipient = await db.getMember(newEstId);
          if (recipient?.email) {
            const { subject, html } = mailer.emailAssigned(updated, recipient.name, actorName, 'estimator');
            await mailer.sendMail({ to: recipient.email, subject, html });
          }
        }

        // Assignment — salesperson changed to a new person
        const newSpId = req.body.salesperson_id != null ? Number(req.body.salesperson_id) : undefined;
        if (newSpId && newSpId !== oldBid?.salesperson_id) {
          const recipient = await db.getMember(newSpId);
          if (recipient?.email) {
            const { subject, html } = mailer.emailAssigned(updated, recipient.name, actorName, 'salesperson');
            await mailer.sendMail({ to: recipient.email, subject, html });
          }
        }

        // Bid awarded — paused during data cleanup (re-enable when cleanup is done)
        // if (req.body.stage === 'awarded' && oldBid?.stage !== 'awarded') {
        //   const users = await db.getActiveUserEmails();
        //   const { subject, html } = mailer.emailAwarded(updated, actorName);
        //   await mailer.sendMail({ to: users.map(u => u.email), subject, html });
        // }
      } catch (e) {
        console.error('[email trigger PUT /bids]', e.message);
      }
    })();
  } catch (e) { res.status(400).json({ error: e.message }); }
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
  try {
    const result = await db.logFollowup(req.params.id, req.body);
    res.json(result);

    (async () => {
      try {
        const bid = await db.getBidRaw(req.params.id);
        if (!bid) return;
        const actor = req.session.userId ? await db.getMember(req.session.userId) : null;
        const actorName = actor?.name || 'A team member';

        // Collect estimator + salesperson emails (skip the person who logged it)
        const recipientIds = [bid.estimator_id, bid.salesperson_id]
          .filter(id => id && id !== actor?.id);
        const emails = [];
        for (const id of [...new Set(recipientIds)]) {
          const m = await db.getMember(id);
          if (m?.email) emails.push(m.email);
        }
        if (!emails.length) return;

        const fullBid = await db.getBid(req.params.id);
        const { subject, html } = mailer.emailFollowup(
          fullBid,
          req.body.notes || req.body.note || '',
          req.body.next_followup_date || null,
          actorName
        );
        await mailer.sendMail({ to: emails, subject, html });
      } catch (e) {
        console.error('[email trigger POST /followups]', e.message);
      }
    })();
  } catch (e) { res.status(400).json({ error: e.message }); }
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
  try { res.json(await db.createProject(req.body.name, req.session.userId || null, req.body.job_number || null)); }
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
const IDEA_ADMIN_NOTIFY_EMAIL = 'jmonchek@libertyintegrated.com';

app.post('/api/ideas', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  try {
    const result = await db.submitIdea({ ...req.body, submitted_by: req.session.userId });
    res.json(result);
    // Fire-and-forget — never let a mail hiccup affect the actual submission.
    // Logged loudly on failure since this runs outside the request/response
    // cycle and a silent .catch(() => {}) here was undiagnosable last time.
    console.log(`[ideas] #${result.id} submitted by user ${req.session.userId} — notifying ${IDEA_ADMIN_NOTIFY_EMAIL}`);
    db.getMember(req.session.userId).then(submitter => {
      const { subject, html } = mailer.emailIdeaSubmitted(req.body, submitter?.name);
      return mailer.sendMail({ to: IDEA_ADMIN_NOTIFY_EMAIL, subject, html });
    }).catch(e => console.error(`[ideas] submission-notify email failed for #${result.id}:`, e.message));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Visible to any logged-in user (not just admins) — voting only makes sense
// if people can see what's already been suggested.
app.get('/api/ideas', async (req, res) => {
  try { res.json(await db.getIdeas(req.session.userId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/ideas/:id', async (req, res) => {
  try {
    const user = await db.getMember(req.session.userId);
    if (!user || !user.is_admin) return res.status(403).json({ error: 'Admin only' });
    const result = await db.updateIdeaStatus(req.params.id, req.body.status);
    res.json({ ok: true });
    // Fire-and-forget — only email the submitter if the status actually
    // changed and someone's actually attached to notify.
    if (result.from !== result.to && result.submitted_by && result.submitted_by !== req.session.userId) {
      db.getMember(result.submitted_by).then(recipient => {
        if (!recipient?.email) return;
        const { subject, html } = mailer.emailIdeaStatusChanged(result, result.to);
        return mailer.sendMail({ to: recipient.email, subject, html });
      }).catch(() => {});
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ideas/:id/vote', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  try { res.json(await db.voteIdea(req.params.id, req.session.userId, req.body.value)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/ideas/:id/comments', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  try { res.json(await db.addIdeaComment(req.params.id, req.session.userId, req.body.text)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// MUST be before /api/projects/:id
app.get('/api/audit/job-numbers', async (req, res) => {
  try { res.json(await db.getJobNumberAudit()); }
  catch (e) { res.status(500).json({ error: e.message }); }
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
  try {
    const actor = await db.getMember(req.session.userId);
    if (!actor || !actor.is_admin) return res.status(403).json({ error: 'Admin only.' });
    await db.deleteProject(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// ── Cron jobs (Eastern time) ──────────────────────────────────────────────────

// Daily 7 AM ET — send reminder emails for due reminders
cron.schedule('0 7 * * *', async () => {
  console.log('[cron] running daily reminder check');
  try {
    const due = await db.getDueReminders();
    if (!due.length) return console.log('[cron] no reminders due today');
    const team = await db.getAllTeam();
    const memberMap = Object.fromEntries(team.map(m => [m.id, m]));

    for (const { bid, reminder } of due) {
      const recipientIds = [bid.estimator_id, bid.salesperson_id].filter(Boolean);
      const emails = [...new Set(recipientIds)]
        .map(id => memberMap[id])
        .filter(m => m?.email)
        .map(m => ({ email: m.email, name: m.name }));

      for (const r of emails) {
        const { subject, html } = mailer.emailReminder(bid, reminder, r.name);
        await mailer.sendMail({ to: r.email, subject, html });
      }
      await db.markReminderEmailed(bid._id, reminder.rid);
    }
    console.log(`[cron] sent reminder emails for ${due.length} reminder(s)`);
  } catch (e) {
    console.error('[cron] reminder error:', e.message);
  }
}, { timezone: 'America/New_York' });

// Daily 7:05 AM ET — v2's reminders (polymorphic: bid or change_order)
cron.schedule('5 7 * * *', async () => {
  console.log('[cron] running v2 daily reminder check');
  try {
    const due = await v2db.getDueReminders();
    if (!due.length) return console.log('[cron] v2: no reminders due today');

    for (const { reminder, recipientIds } of due) {
      const shape = await v2notify.emailShapeForReminder(reminder);
      if (!shape) { await v2db.markReminderEmailed(reminder._id); continue; }
      const emails = (await Promise.all(recipientIds.map(id => v2notify.emailForV2Member(id)))).filter(Boolean);
      for (const r of emails) {
        const { subject, html } = mailer.emailReminder(shape, reminder, r.name);
        await mailer.sendMail({ to: r.email, subject, html });
      }
      await v2db.markReminderEmailed(reminder._id);
    }
    console.log(`[cron] v2: sent reminder emails for ${due.length} reminder(s)`);
  } catch (e) {
    console.error('[cron] v2 reminder error:', e.message);
  }
}, { timezone: 'America/New_York' });

// Monday 6 AM ET — weekly digest to all users with email on file
// Reads v2's data (v1's own getDigest is retired here to avoid sending two
// separate digest emails as v2 becomes the system of record).
cron.schedule('0 6 * * 1', async () => {
  console.log('[cron] running weekly digest');
  try {
    const [digest, users] = await Promise.all([v2db.getDigest(), db.getActiveUserEmails()]);
    if (!users.length) return console.log('[cron] no users with email — skipping digest');
    const { subject, html } = mailer.emailDigest(digest);
    await mailer.sendMail({ to: users.map(u => u.email), subject, html });
    console.log(`[cron] weekly digest sent to ${users.length} user(s)`);
  } catch (e) {
    console.error('[cron] digest error:', e.message);
  }
}, { timezone: 'America/New_York' });
