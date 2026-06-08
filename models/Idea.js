const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  _id:          Number,
  type:         { type: String, enum: ['idea', 'issue'], required: true },
  title:        { type: String, required: true },
  body:         { type: String, default: '' },
  page:         { type: String, default: null },
  submitted_by: { type: Number, default: null },
  status:       { type: String, default: 'new' }, // new | reviewed | done | wontfix
  created_at:   String,
  updated_at:   String,
}, { _id: false, versionKey: false });

module.exports = mongoose.model('Idea', schema);
