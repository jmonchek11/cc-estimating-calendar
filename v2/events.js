/**
 * v2/events.js — outbox for the shared `liberty-core` platform DB.
 *
 * The calendar appends an event here on every significant transition
 * (project/bid/job/CO created, stage changes, job # assigned, etc.).
 * Consumers (Manpower Board, PC tool — separate later tasks) poll this
 * collection; the calendar itself never reads it back except the backfill
 * script (v2/backfill-events.js).
 *
 * See docs/EVENTS_OUTBOX_PLAN.md for the full event catalog + hook points.
 */
const mongoose = require('mongoose');

let _conn = null;
function getConnection() {
  if (_conn) return _conn;
  _conn = mongoose.createConnection(process.env.MONGODB_URI, { dbName: 'liberty-core' });
  return _conn;
}

const EventSchema = new mongoose.Schema({
  at:            { type: Date, default: Date.now },
  type:          { type: String, required: true },
  source:        { type: String, default: 'estimating' },
  actor_id:      { type: Number, default: null },     // TeamMember id, null for scripts
  project_id:    { type: Number, default: null },
  bid_id:        { type: Number, default: null },
  job_id:        { type: Number, default: null },
  co_id:         { type: Number, default: null },
  submission_id: { type: Number, default: null },
  job_number:    { type: String, default: null },     // denormalized — consumers key on it
  payload:       { type: mongoose.Schema.Types.Mixed, default: {} },
  // Consumers stamp processed.<app> = Date when they've handled an event.
  // The calendar NEVER writes to this field.
  processed:     { type: mongoose.Schema.Types.Mixed, default: {} },
}, { versionKey: false });

let _model = null;
function getModel() {
  if (_model) return _model;
  _model = getConnection().model('Event', EventSchema, 'events');
  return _model;
}

let _indexesEnsured = false;
async function ensureIndexes() {
  if (_indexesEnsured) return;
  _indexesEnsured = true;
  try {
    const Event = getModel();
    await Promise.all([
      Event.collection.createIndex({ at: 1 }),
      Event.collection.createIndex({ type: 1, at: 1 }),
      Event.collection.createIndex({ project_id: 1 }),
      Event.collection.createIndex({ job_id: 1 }),
    ]);
  } catch (err) {
    console.error('[events] index creation failed (non-fatal)', err);
  }
}

// Raw insert — used by safeEmit() and directly by the backfill script (which
// wants a real error if the write fails, so it can report it, rather than a
// silently-swallowed one).
async function emit(type, fields) {
  await ensureIndexes();
  const Event = getModel();
  return Event.create({ type, source: 'estimating', ...fields });
}

// Fire-and-forget wrapper for use inside db.js request-handling functions —
// this must NEVER throw or delay the response. A failure here (liberty-core
// down, a validation bug) is logged loudly — with the FULL event payload, so
// it can be replayed by hand — and swallowed. No retries/queues in v1; the
// backfill script is the recovery mechanism for anything an outage misses.
async function safeEmit(type, fields) {
  try {
    await emit(type, fields);
  } catch (err) {
    console.error('[events] EMIT FAILED', type, JSON.stringify(fields), err);
  }
}

module.exports = { emit, safeEmit, getModel, ensureIndexes, getConnection };
