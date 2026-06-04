const mongoose = require('mongoose');

const bidSchema = new mongoose.Schema({
  _id: { type: Number },
  bid_number: { type: String, default: null },
  job_number: { type: String, default: null },
  stage: { type: String, required: true, default: 'opportunity' },
  project_name: { type: String, required: true },
  customer: { type: String, default: null },
  customer2: { type: String, default: null },
  customer3: { type: String, default: null },
  customer4: { type: String, default: null },
  customer5: { type: String, default: null },
  notes: { type: String, default: null },
  estimator_id: { type: Number, default: null },
  salesperson_id: { type: Number, default: null },
  date_received: { type: String, default: null },
  estimate_due_date: { type: String, default: null },
  estimate_start_date: { type: String, default: null },
  date_estimate_sent: { type: String, default: null },
  estimate_review_date: { type: String, default: null },
  estimate_amount: { type: Number, default: null },
  estimate_pct_complete: { type: Number, default: 0 },
  estimate_approved_by: { type: String, default: null },
  bid_result: { type: String, default: null },
  award_date: { type: String, default: null },
  awarded_contractor: { type: String, default: null },
  contract_reviewed_by: { type: String, default: null },
  date_contract_signed: { type: String, default: null },
  status: { type: String, default: 'Open' },
  close_reason:     { type: String, default: null },
  date_not_awarded: { type: String, default: null },
  not_awarded_notes:{ type: String, default: null },
  submitted_by:  { type: Number, default: null },   // team member id who submitted
  created_by:    { type: Number, default: null },   // team member id who created
  next_followup_date: { type: String, default: null },
  sub_estimators:    { type: [{ estimator_id: Number, scope: String }], default: [] },
  reminders:         { type: [{ rid: String, note: String, remind_on: String, dismissed: { type: Number, default: 0 } }], default: [] },
  jurisdiction:      { type: String, default: null },   // IBEW local union number
  parent_bid_id:     { type: Number, default: null },   // CO → awarded bid link
  phases: { type: [{
    phase_num:    Number,
    label:        { type: String, default: '' },
    estimator_id: { type: Number, default: null },
    sub_estimators: { type: [{ estimator_id: Number, scope: String }], default: [] },
    customers:    { type: [String], default: [] },
    amount:       { type: Number, default: null },
    date_received:  { type: String, default: null },
    date_submitted: { type: String, default: null },
    notes:        { type: String, default: null },
    checklist:    { type: [String], default: [] },
    created_at:   { type: String },
  }], default: [] },
  customer_contacts: { type: [{ customer_name: String, contact_id: Number }], default: [] },
  checklist: { type: [String], default: [] },
  is_deleted: { type: Number, default: 0 },
  created_at: { type: String, default: () => new Date().toISOString().replace('T', ' ').substring(0, 19) },
  updated_at: { type: String, default: () => new Date().toISOString().replace('T', ' ').substring(0, 19) }
}, { _id: false, versionKey: false });

module.exports = mongoose.model('Bid', bidSchema, 'bids');
