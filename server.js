require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const path = require('path');
const db = require('./db');

const app = express();
app.use(express.json());

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

// ── Access Gate ───────────────────────────────────────────────────────────────
const ACCESS_CODE = process.env.ACCESS_CODE || '';

app.get('/gate', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CC Estimating Calendar</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f1117; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .gate-card { background: #1a1d2e; border: 1px solid #2d3148; border-radius: 12px; padding: 48px 40px; width: 100%; max-width: 400px; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.4); }
    .gate-logo { font-size: 2.5rem; margin-bottom: 12px; }
    h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 6px; color: #f1f5f9; }
    p { color: #94a3b8; font-size: 0.9rem; margin-bottom: 32px; }
    input { width: 100%; padding: 12px 16px; background: #0f1117; border: 1px solid #2d3148; border-radius: 8px; color: #f1f5f9; font-size: 1rem; margin-bottom: 12px; outline: none; transition: border-color 0.2s; }
    input:focus { border-color: #6366f1; }
    button { width: 100%; padding: 12px; background: #6366f1; color: #fff; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background 0.2s; }
    button:hover { background: #4f46e5; }
    .error { color: #f87171; font-size: 0.85rem; margin-bottom: 12px; display: none; }
  </style>
</head>
<body>
  <div class="gate-card">
    <div class="gate-logo">📋</div>
    <h1>CC Estimating Calendar</h1>
    <p>Enter the access code to continue</p>
    <div class="error" id="err">Incorrect access code. Try again.</div>
    <form method="POST" action="/api/auth/access">
      <input type="password" name="code" placeholder="Access code" autofocus autocomplete="off">
      <button type="submit">Continue</button>
    </form>
  </div>
  <script>
    const params = new URLSearchParams(window.location.search);
    if (params.get('err')) document.getElementById('err').style.display = 'block';
  </script>
</body>
</html>`);
});

app.post('/api/auth/access', express.urlencoded({ extended: false }), (req, res) => {
  if (req.body.code === ACCESS_CODE) {
    req.session.accessGranted = true;
    res.redirect('/');
  } else {
    res.redirect('/gate?err=1');
  }
});

// Gate middleware — intercepts the main app page
app.use((req, res, next) => {
  if (!ACCESS_CODE) return next(); // skip gate if no code set
  if (req.path === '/' || req.path === '/index.html') {
    if (!req.session.accessGranted) return res.redirect('/gate');
  }
  next();
});

// Serve static files before auth middleware
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware — protects /api/ routes except public ones
const PUBLIC_API = ['/api/auth/', '/api/team'];
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (PUBLIC_API.some(p => req.path.startsWith(p))) return next();
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
});

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) return res.json(null);
  try {
    const members = await db.getAllTeam();
    const member = members.find(m => m.id === req.session.userId);
    res.json(member || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { memberId, pin } = req.body;
    const member = await db.loginUser(memberId, pin);
    if (!member) return res.status(401).json({ error: 'Invalid PIN. Try again.' });
    req.session.userId = member.id;
    res.json(member);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.put('/api/auth/pin', async (req, res) => {
  try {
    await db.updatePin(req.session.userId, req.body.pin || null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TEAM ──────────────────────────────────────────────────────────────────────
app.get('/api/team', async (req, res) => {
  try { res.json(await db.getAllTeam()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/team', async (req, res) => {
  try { res.json(await db.createTeamMember(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/team/:id', async (req, res) => {
  try { res.json(await db.updateTeamMember(req.params.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
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
  try { res.json(await db.createBid(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
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

// ── FOLLOW-UPS ────────────────────────────────────────────────────────────────
app.get('/api/bids/:id/followups', async (req, res) => {
  try { res.json(await db.getFollowups(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bids/:id/followups', async (req, res) => {
  try { res.json(await db.logFollowup(req.params.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
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

// ── Start ─────────────────────────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('ERROR: MONGODB_URI environment variable is not set.');
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log('Connected to MongoDB');
    await db.seedTeamData();
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
      console.log('\n========================================');
      console.log('  CC Estimating Calendar');
      console.log(`  http://localhost:${PORT}`);
      console.log('========================================\n');
    });
  })
  .catch(err => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
