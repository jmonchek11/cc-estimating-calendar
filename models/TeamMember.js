const mongoose = require('mongoose');

const teamMemberSchema = new mongoose.Schema({
  _id: { type: Number },
  name: { type: String, required: true },
  // Not unique — estimators and salespeople can share initials (their role
  // color, not the letters, is what tells them apart in the UI).
  initials: { type: String, required: true, uppercase: true },
  role: { type: String, default: 'estimator' },
  active: { type: Number, default: 1 },
  pin: { type: String, default: null },
  email: { type: String, lowercase: true, trim: true, index: { unique: true, sparse: true } },
  ms_oid: { type: String, default: null, index: { unique: true, sparse: true } },
  password_hash: { type: String, default: null },
  must_change_password: { type: Boolean, default: true },
  is_admin: { type: Boolean, default: false },
  last_seen: { type: Date, default: null },
  // Timestamp of the last time this person opened the What's New panel —
  // compared against ReleaseNote.created_at to drive the sidebar's unread
  // red-dot (see getUnseenReleaseCount/markReleasesSeen in v2/db.js). Null
  // means "never checked" — treated as "everything is unseen" rather than
  // caught up, so the badge shows for existing users the first time this
  // feature ships too.
  last_seen_release_at: { type: String, default: null },
  created_at: { type: String, default: () => new Date().toISOString() },
  // Per-person opt-OUT of notification categories — missing key or `true`
  // both mean "send it" (see wantsNotification in mailer.js), so accounts
  // that predate this feature keep getting everything until they visit
  // Settings and turn something off themselves.
  notification_prefs: {
    assigned: { type: Boolean, default: true },
    followup: { type: Boolean, default: true },
    awarded: { type: Boolean, default: true },
    reminder: { type: Boolean, default: true },
    walkthrough: { type: Boolean, default: true },
    digest: { type: Boolean, default: true },
    ideas: { type: Boolean, default: true },
  },
}, { _id: false, versionKey: false });

module.exports = mongoose.model('TeamMember', teamMemberSchema, 'teammembers');
