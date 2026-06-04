const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  ids: [Number],  // always [min, max] so order doesn't matter
}, { versionKey: false });

module.exports = mongoose.model('IgnoredPair', schema);
