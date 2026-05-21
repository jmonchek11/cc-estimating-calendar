/**
 * sync-excel-lib.js
 * Core Excel→MongoDB sync logic.
 * Accepts a Buffer (works from both the CLI script and the web upload endpoint).
 */
const XLSX       = require('xlsx');
const Bid        = require('./models/Bid');
const TeamMember = require('./models/TeamMember');
const Counter    = require('./models/Counter');

const SHEET_STAGES = {
  'Opportunities': 'opportunity',
  'Active - Bids': 'active_bid',
  'Active - RFCs': 'active_co',
  'Follow Up':     'follow_up',
  'Awarded':       'awarded',
  'Closed':        'closed',
};

// ── Value helpers ─────────────────────────────────────────────────────────────
function excelDate(val) {
  if (!val) return null;
  if (typeof val === 'string') {
    const s = val.trim();
    if (!s || s === 'TBD' || s === 'On Hold' || s === 'N/A') return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
    return null;
  }
  if (typeof val === 'number' && val > 1000) {
    const d = XLSX.SSF.parse_date_code(val);
    if (!d) return null;
    return d.y + '-' + String(d.m).padStart(2, '0') + '-' + String(d.d).padStart(2, '0');
  }
  return null;
}

function str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return (!s || s === 'N/A' || s === 'TBD') ? null : s;
}

function amt(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,]/g, ''));
  if (isNaN(n) || n <= 0 || n > 50000000) return null;
  return n;
}

function pct(v) {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (isNaN(n)) return 0;
  return n > 1 ? n / 100 : n;
}

// ── Estimator/salesperson lookup ──────────────────────────────────────────────
function buildLookup(members) {
  const byI = {}, byN = {};
  members.forEach(m => {
    byI[m.initials.toUpperCase()] = m._id;
    byN[m.name.toLowerCase()] = m._id;
  });
  return function (raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    if (!s || s === 'TBD' || s === 'N/A') return null;
    if (byN[s.toLowerCase()]) return byN[s.toLowerCase()];
    const first = s.split(/[\/,\s]+/)[0].toUpperCase();
    return byI[first] || null;
  };
}

// ── Row mappers ───────────────────────────────────────────────────────────────
function mapRow(row, stage, lkp) {
  const rawEst = row['Estimator'];
  const estVal = (typeof rawEst === 'number') ? null : str(rawEst);
  const rawAmt = row['Estimate Amount'] != null ? row['Estimate Amount'] : row[' Estimate Amount '];
  return {
    bid_number:            str(row['Bid #']),
    job_number:            str(row['Job #']),
    stage,
    project_name:          str(row['Project Name']),
    customer:              str(row['Customer 1']),
    customer2:             str(row['Customer 2']),
    customer3:             str(row['Customer 3']),
    customer4:             str(row['Customer 4']),
    customer5:             str(row['Customer 5']),
    notes:                 str(row['Notes']),
    estimator_id:          lkp(estVal),
    salesperson_id:        lkp(row['Salesperson']),
    date_received:         excelDate(row['Date Received']),
    estimate_due_date:     excelDate(row['Estimate Due Date']),
    estimate_start_date:   excelDate(row['Estimate Start Date']),
    date_estimate_sent:    excelDate(row['Date Estimate Sent']),
    estimate_review_date:  excelDate(row['Estimate Review Date']),
    estimate_amount:       amt(rawAmt),
    estimate_pct_complete: pct(row['Estimate % Complete']),
    estimate_approved_by:  str(row['Estimate Approved By']),
    bid_result:            str(row['Bid Result']),
    award_date:            excelDate(row['Award Date']),
    awarded_contractor:    str(row['Awarded Contractor']),
    next_followup_date:    excelDate(row['Last Follow Up Date w/ Comments']),
  };
}

function mapClosedRow(row, lkp) {
  return {
    bid_number:            str(row['Bid # or Job #']),
    stage:                 'closed',
    project_name:          str(row['Project Name']),
    customer:              str(row['Customer 1']),
    customer2:             str(row['Customer 2']),
    customer3:             str(row['Customer 3']),
    customer4:             str(row['Customer 4']),
    estimator_id:          lkp(row['Estimator']),
    salesperson_id:        lkp(row['Salesperson']),
    estimate_due_date:     excelDate(row['Estimate Due Date']),
    date_estimate_sent:    excelDate(row['Date Estimate Sent']),
    estimate_start_date:   excelDate(row['Estimate Start Date']),
    estimate_pct_complete: pct(row['Estimate % Complete']),
    estimate_review_date:  excelDate(row['Estimate Review Date']),
    estimate_amount:       amt(row['Estimate Amount']),
    estimate_approved_by:  str(row['Estimate Approved By']),
    bid_result:            str(row['Bid Result']),
  };
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function nextId() {
  const doc = await Counter.findByIdAndUpdate('bids', { $inc: { seq: 1 } }, { new: true, upsert: true });
  return doc.seq;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function upsertBid(data) {
  if (!data.project_name) return { action: 'skip' };
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  let ex = null;
  if (data.bid_number) ex = await Bid.findOne({ bid_number: data.bid_number });
  if (!ex) {
    ex = await Bid.findOne({
      project_name: { $regex: new RegExp('^' + escapeRegex(data.project_name) + '$', 'i') }
    });
  }

  if (ex) {
    const upd = { updated_at: now };
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && v !== undefined) upd[k] = v;
    }
    await Bid.updateOne({ _id: ex._id }, { $set: upd });
    return { action: 'update', id: ex._id };
  }

  const id = await nextId();
  await Bid.create({ _id: id, ...data, status: 'Open', created_at: now, updated_at: now });
  return { action: 'insert', id };
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * Sync an Excel workbook supplied as a Buffer.
 * Returns { insert, update, skip, error, errors: [{ project, message }] }
 */
async function syncFromBuffer(buffer) {
  const members = await TeamMember.find({});
  const lkp = buildLookup(members);
  const wb  = XLSX.read(buffer, { type: 'buffer' });

  const stats = { insert: 0, update: 0, skip: 0, error: 0, errors: [] };

  for (const [sheet, stage] of Object.entries(SHEET_STAGES)) {
    const ws = wb.Sheets[sheet];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { range: 1, defval: null });
    const data = rows.filter(r => {
      const n = r['Project Name'];
      return n && String(n).trim() !== '' && String(n).trim() !== 'Project Name';
    });
    for (const row of data) {
      try {
        const res = await upsertBid(mapRow(row, stage, lkp));
        stats[res.action]++;
      } catch (e) {
        stats.error++;
        stats.errors.push({ project: row['Project Name'], message: e.message });
      }
    }
  }

  // _Closed sheet has header on row 0
  const cws = wb.Sheets['_Closed'];
  if (cws) {
    const crows = XLSX.utils.sheet_to_json(cws, { range: 0, defval: null });
    const cdata = crows.filter(r => r['Project Name'] && String(r['Project Name']).trim() !== '');
    for (const row of cdata) {
      try {
        const res = await upsertBid(mapClosedRow(row, lkp));
        stats[res.action]++;
      } catch (e) {
        stats.error++;
        stats.errors.push({ project: row['Project Name'], message: e.message });
      }
    }
  }

  return stats;
}

module.exports = { syncFromBuffer };
