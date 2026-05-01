/**
 * migrate.js — Copy data from local SQLite → MongoDB Atlas
 *
 * Usage:
 *   node migrate.js
 *
 * Requires MONGODB_URI in .env (or environment).
 * Safe to re-run: clears MongoDB collections first, then re-inserts all data.
 */

require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

const Counter    = require('./models/Counter');
const TeamMember = require('./models/TeamMember');
const Bid        = require('./models/Bid');
const Followup   = require('./models/Followup');

const SQLITE_PATH = path.join(__dirname, 'data', 'estimating.db');

async function migrate() {
  if (!fs.existsSync(SQLITE_PATH)) {
    console.error('SQLite database not found at:', SQLITE_PATH);
    process.exit(1);
  }

  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI environment variable is not set.');
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');

  const sqlite = new DatabaseSync(SQLITE_PATH);

  // ── Clear MongoDB ────────────────────────────────────────────────────────────
  console.log('Clearing existing MongoDB data...');
  await Promise.all([
    Counter.deleteMany({}),
    TeamMember.deleteMany({}),
    Bid.deleteMany({}),
    Followup.deleteMany({}),
  ]);

  // ── Team Members ─────────────────────────────────────────────────────────────
  const members = sqlite.prepare('SELECT * FROM team_members').all();
  console.log(`Migrating ${members.length} team members...`);
  for (const m of members) {
    await TeamMember.create({
      _id: m.id,
      name: m.name,
      initials: m.initials,
      role: m.role,
      active: m.active,
      pin: m.pin || null,
      created_at: m.created_at,
    });
  }
  const maxMemberId = Math.max(...members.map(m => m.id), 0);
  await Counter.create({ _id: 'team_members', seq: maxMemberId });
  console.log(`  Done. Counter set to ${maxMemberId}.`);

  // ── Bids ─────────────────────────────────────────────────────────────────────
  const bids = sqlite.prepare('SELECT * FROM bids').all();
  console.log(`Migrating ${bids.length} bids...`);

  const BATCH = 100;
  for (let i = 0; i < bids.length; i += BATCH) {
    const chunk = bids.slice(i, i + BATCH).map(b => ({
      _id: b.id,
      bid_number: b.bid_number || null,
      job_number: b.job_number || null,
      stage: b.stage,
      project_name: b.project_name,
      customer: b.customer || null,
      customer2: b.customer2 || null,
      customer3: b.customer3 || null,
      customer4: b.customer4 || null,
      customer5: b.customer5 || null,
      notes: b.notes || null,
      estimator_id: b.estimator_id || null,
      salesperson_id: b.salesperson_id || null,
      date_received: b.date_received || null,
      estimate_due_date: b.estimate_due_date || null,
      estimate_start_date: b.estimate_start_date || null,
      date_estimate_sent: b.date_estimate_sent || null,
      estimate_review_date: b.estimate_review_date || null,
      estimate_amount: b.estimate_amount != null ? b.estimate_amount : null,
      estimate_pct_complete: b.estimate_pct_complete != null ? b.estimate_pct_complete : 0,
      estimate_approved_by: b.estimate_approved_by || null,
      bid_result: b.bid_result || null,
      award_date: b.award_date || null,
      awarded_contractor: b.awarded_contractor || null,
      contract_reviewed_by: b.contract_reviewed_by || null,
      date_contract_signed: b.date_contract_signed || null,
      status: b.status || 'Open',
      next_followup_date: b.next_followup_date || null,
      is_deleted: b.is_deleted || 0,
      created_at: b.created_at,
      updated_at: b.updated_at,
    }));
    await Bid.insertMany(chunk, { ordered: false });
    process.stdout.write(`  ${Math.min(i + BATCH, bids.length)}/${bids.length}\r`);
  }
  const maxBidId = Math.max(...bids.map(b => b.id), 0);
  await Counter.create({ _id: 'bids', seq: maxBidId });
  console.log(`\n  Done. Counter set to ${maxBidId}.`);

  // ── Follow-ups ────────────────────────────────────────────────────────────────
  const followups = sqlite.prepare('SELECT * FROM followup_log').all();
  console.log(`Migrating ${followups.length} follow-up log entries...`);

  for (let i = 0; i < followups.length; i += BATCH) {
    const chunk = followups.slice(i, i + BATCH).map(f => ({
      _id: f.id,
      bid_id: f.bid_id,
      followup_date: f.followup_date,
      contacted_by: f.contacted_by || null,
      contact_method: f.contact_method || null,
      customer_contact: f.customer_contact || null,
      notes: f.notes,
      response: f.response || null,
      next_followup_date: f.next_followup_date || null,
      created_at: f.created_at,
    }));
    await Followup.insertMany(chunk, { ordered: false });
    process.stdout.write(`  ${Math.min(i + BATCH, followups.length)}/${followups.length}\r`);
  }
  const maxFollowupId = Math.max(...followups.map(f => f.id), 0);
  await Counter.create({ _id: 'followups', seq: maxFollowupId });
  console.log(`\n  Done. Counter set to ${maxFollowupId}.`);

  sqlite.close();
  await mongoose.disconnect();
  console.log('\nMigration complete!');
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
