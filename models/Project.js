const mongoose = require('mongoose');

const ProjectSchema = new mongoose.Schema({
  _id:        Number,
  name:       { type: String, required: true },
  created_by: { type: Number, default: null },
  created_at: String,
  updated_at: String,
}, { _id: false, versionKey: false });

module.exports = mongoose.model('Project', ProjectSchema);
