const mongoose = require('mongoose');

const followupSchema = new mongoose.Schema({
  _id: { type: Number },
  bid_id: { type: Number, required: true },
  followup_date: { type: String, required: true },
  contacted_by: { type: String, default: null },
  contact_method: { type: String, default: null },
  customer_contact: { type: String, default: null },
  notes: { type: String, required: true },
  response: { type: String, default: null },
  next_followup_date: { type: String, default: null },
  created_at: { type: String, default: () => new Date().toISOString().replace('T', ' ').substring(0, 19) }
}, { _id: false, versionKey: false });

module.exports = mongoose.model('Followup', followupSchema, 'followups');
