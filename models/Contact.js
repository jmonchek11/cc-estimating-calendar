const mongoose = require('mongoose');

const ContactSchema = new mongoose.Schema({
  _id:        Number,
  first_name: { type: String, default: null },
  last_name:  { type: String, default: null },
  suffix:     { type: String, default: null },
  company:    { type: String, default: null },
  city:       { type: String, default: null },
  state:      { type: String, default: null },
  phone:      { type: String, default: null },
  email:      { type: String, default: null },
  domain:     { type: String, default: null },
  notes:      { type: String, default: null },
  active:     { type: Number, default: 1 },
  is_deleted: { type: Number, default: 0 },
  created_at: String,
  updated_at: String,
}, { _id: false });

module.exports = mongoose.model('Contact', ContactSchema);
