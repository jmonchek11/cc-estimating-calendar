const mongoose = require('mongoose');

const teamMemberSchema = new mongoose.Schema({
  _id: { type: Number },
  name: { type: String, required: true },
  initials: { type: String, required: true, unique: true, uppercase: true },
  role: { type: String, default: 'estimator' },
  active: { type: Number, default: 1 },
  pin: { type: String, default: null },
  created_at: { type: String, default: () => new Date().toISOString() }
}, { _id: false, versionKey: false });

module.exports = mongoose.model('TeamMember', teamMemberSchema, 'teammembers');
