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
