const mongoose = require('mongoose');

const IDEA_STATUSES = ['new', 'reviewed', 'done', 'wontfix'];
// "Active" statuses surface at the top of the list, sorted by vote score;
// "terminal" statuses are crossed off and pushed to the bottom, sorted by
// whenever they were last touched. See db.js's getIdeas()/updateIdeaStatus().
const IDEA_TERMINAL_STATUSES = ['done', 'wontfix'];

const CommentSchema = new mongoose.Schema({
  user_id:    { type: Number, default: null },
  text:       { type: String, required: true },
  created_at: String,
}, { versionKey: false });

const schema = new mongoose.Schema({
  _id:          Number,
  type:         { type: String, enum: ['idea', 'issue'], required: true },
  title:        { type: String, required: true },
  body:         { type: String, default: '' },
  page:         { type: String, default: null },
  submitted_by: { type: Number, default: null },
  status:       { type: String, enum: IDEA_STATUSES, default: 'new' },
  // Map of userId (string) -> 1 (upvote) | -1 (downvote). A user's own key is
  // removed entirely when they un-vote, rather than stored as 0.
  votes:        { type: Map, of: Number, default: {} },
  comments:     { type: [CommentSchema], default: [] },
  // Screenshots attached at submission — data URIs (already resized/compressed
  // client-side). Stored inline rather than in separate object storage: at
  // this app's volume (a handful of reports a week, each ~100-300KB after
  // compression) that's negligible against Atlas's storage, and it avoids
  // standing up a second piece of infrastructure for it.
  images:       { type: [String], default: [] },
  created_at:   String,
  updated_at:   String,
}, { _id: false, versionKey: false });

module.exports = mongoose.model('Idea', schema);
module.exports.IDEA_STATUSES = IDEA_STATUSES;
module.exports.IDEA_TERMINAL_STATUSES = IDEA_TERMINAL_STATUSES;
