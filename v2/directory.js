/**
 * v2/directory.js — read-only lookup into the shared `liberty-core.users`
 * directory (see docs/PLATFORM_CONTEXT.md), used only to know which of the
 * OTHER Liberty apps (Manpower Board, PC Lifecycle Tool) a person has been
 * granted in the Hub — drives which tiles show in the sidebar's app
 * switcher. This app's own login/access still runs on the legacy
 * TeamMember store; it never writes to this collection.
 */
const mongoose = require('mongoose');
const events = require('./events');

const DirectoryUserSchema = new mongoose.Schema({
  ms_oid: String,
  email: String,
  apps: [String],
}, { versionKey: false, strict: false });

let _model = null;
function getModel() {
  if (_model) return _model;
  _model = events.getConnection().model('DirectoryUser', DirectoryUserSchema, 'users');
  return _model;
}

// Returns the app keys (e.g. ['estimating','manpower']) the Hub has granted
// this person, or null if they have no liberty-core directory entry yet
// (an account that only ever existed in the legacy TeamMember store) —
// callers should treat null as "don't show the other apps", not "show all".
async function getMyApps({ ms_oid, email }) {
  try {
    const User = getModel();
    const query = ms_oid ? { ms_oid } : (email ? { email: email.toLowerCase() } : null);
    if (!query) return null;
    const user = await User.findOne(query).lean();
    return user ? (user.apps || []) : null;
  } catch (err) {
    console.error('[directory] lookup failed (non-fatal)', err.message);
    return null;
  }
}

module.exports = { getMyApps };
