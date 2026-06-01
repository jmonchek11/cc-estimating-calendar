const mongoose = require('mongoose');

// Single company-wide settings document, keyed by _id: 'company'
const SettingsSchema = new mongoose.Schema({
  _id: String,
  // Follow-up timeline intervals (in days)
  fu_initial_days:   { type: Number, default: 3 },   // after bid submission
  fu_recurring_days: { type: Number, default: 7 },   // after each subsequent follow-up
}, { _id: false, versionKey: false });

module.exports = mongoose.model('Settings', SettingsSchema);
