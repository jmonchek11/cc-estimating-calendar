/**
 * v2/directory.js — read-only lookup into the shared `liberty-core.users`
 * directory (see docs/PLATFORM_CONTEXT.md). Originally just knew which of
 * the OTHER Liberty apps (Manpower Board, PC Lifecycle Tool) a person has
 * been granted in the Hub — drives which tiles show in the sidebar's app
 * switcher. Extended (2026-08) to also read `roles` — the Hub's role
 * vocabulary (admin/pc/pm/apm/estimator/lead_estimator/sales_rep/
 * superintendent/foreman/accounting/purchasing/warehouse/safety/
 * ops_manager/prefab/engineering/president) is richer than this app's own
 * TeamMember.role/is_admin, and is the first real cross-app consumer of it:
 * role-gated award notifications (certified payroll → accounting, tax
 * exempt → purchasing) need to reach whoever the Hub says holds that role,
 * not whoever happens to be a TeamMember here. This app's own login/access
 * still runs on the legacy TeamMember store; it never writes to this collection.
 */
const mongoose = require('mongoose');
const events = require('./events');

const DirectoryUserSchema = new mongoose.Schema({
  ms_oid: String,
  email: String,
  display_name: String,
  apps: [String],
  roles: [String],
  active: Boolean,
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

// Everyone in the Hub's directory holding a given role (e.g. 'accounting',
// 'purchasing'), regardless of which apps they're granted — a role-based
// notification should reach the person even if they don't have an
// Estimating Calendar login. Excludes explicitly-deactivated accounts
// (`active === false`); a missing `active` key is treated as active, same
// "missing means normal" convention used elsewhere in this app. Returns []
// (never throws) on any lookup failure, so a directory hiccup can't block
// the action that triggered the notification.
async function getUsersByRole(role) {
  try {
    const User = getModel();
    const users = await User.find({ roles: role, active: { $ne: false } }).lean();
    return users
      .filter(u => u.email)
      .map(u => ({ email: u.email, name: u.display_name || u.email }));
  } catch (err) {
    console.error('[directory] role lookup failed (non-fatal)', err.message);
    return [];
  }
}

module.exports = { getMyApps, getUsersByRole };
