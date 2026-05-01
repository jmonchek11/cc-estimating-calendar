/**
 * sync-excel.js — Sync the Estimating Calendar Excel file → MongoDB
 *
 * Usage:
 *   node sync-excel.js
 *
 * - Matches existing bids by bid_number (if present), then by project_name
 * - Updates changed records, creates new ones
 * - Never deletes — reports DB records not found in Excel so you can review
 * - Safe to run as many times as you want
 */

require('dotenv').config();
const XLSX = require('xlsx');
const path = require('path');
const mongoose = require('mongoose');

const Counter    = require('./models/Counter');
const TeamMember = require('./models/TeamMember');
const Bid        = require('./models/Bid');

const EXCEL_PATH = "C:\\Users\\jmonchek\\OneDrive - libertyintegrated.com\\Desktop\\CC Estimating Calendar\\Estimating Calendar 05-01-26.xlsx";

// ── Helpers ───────────────────────────────────────────────────────────────────

function excelDateToISO(val) {
  if (!val) return null;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (s === 'tbd' || s === 'on hold' || s === '') return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (!isNaN(d)) return d.toISOString().split('T')[0];
    return null;
  }
  if (typeof val === 'number' && val > 1000) {
    const d = new Date((val - 25569) * 86400 * 1000);
    return d.toISOString().split('T')[0];
  }
  return null;
}

function cleanText(val) {
  if (!val) return null;
  const s = String(val).trim();
  return s === '' || s.toLowerCase() === 'n/a' ? null : s;
}

function nowStr() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

async function nextId(name) {
  const doc = await Counter.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return doc.seq;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const SHEET_STAGES = {
  'Opportunities':  'opportunity',
  'Active - Bids':  'active_bid',
  'Active - RFCs':  'active_co',
  'Follow Up':      'follow_up',
  'Awarded':        'awarded',
  '_Closed':        'closed',
  'Closed':         'closed',
};

async function sync() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI not set in .env');
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.\n');

  // Load team members into a map: INITIALS → id
  const members = await TeamMember.find({});
  const memberMap = {};
  for (const m of members) memberMap[m.initials.toUpperCase()] = m._id;

  // Load Excel
  let wb;
  try {
    wb = XLSX.readFile(EXCEL_PATH);
    console.log('Excel file loaded.\n');
  } catch (e) {
    console.error('Could not read Excel file:', e.message);
    console.error('Path:', EXCEL_PATH);
    process.exit(1);
  }

  // Load all existing non-deleted bids into lookup maps
  const existingBids = await Bid.find({ is_deleted: 0 });
  const byBidNumber  = {};
  const byName       = {};
  for (const b of existingBids) {
    if (b.bid_number) byBidNumber[b.bid_number.trim().toLowerCase()] = b;
    byName[b.project_name.trim().toLowerCase()] = b;
  }

  const excelBidNumbers = new Set();
  const excelNames      = new Set();

  let created = 0, updated = 0, skipped = 0;

  for (const [sheetName, stage] of Object.entries(SHEET_STAGES)) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;

    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    if (rows.length < 3) continue;

    let sheetCreated = 0, sheetUpdated = 0;

    for (let r = 2; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;

      const name = cleanText(row[4]);
      if (!name) continue;
      if (['project name', 'bid # or job #', 'project'].includes(name.toLowerCase())) continue;

      const bidNum   = cleanText(row[0]);
      // col 10 = Customer 6 (added to Excel, shifts all subsequent cols by +1)
      const estInit  = cleanText(row[12])?.toUpperCase();
      const salInit  = cleanText(row[13])?.toUpperCase();

      const statusRaw = cleanText(row[28]) || cleanText(row[29]);
      const validStatuses = ['Open', 'Pending Award', 'Awarded', 'Not Awarded', 'Budget'];
      const status = validStatuses.find(s => statusRaw?.toLowerCase().includes(s.toLowerCase())) || 'Open';

      const bidData = {
        bid_number:            bidNum,
        job_number:            cleanText(row[1]),
        stage,
        project_name:          name,
        customer:              cleanText(row[5]),
        customer2:             cleanText(row[6]),
        customer3:             cleanText(row[7]),
        customer4:             cleanText(row[8]),
        customer5:             cleanText(row[9]),
        notes:                 cleanText(row[11]),
        estimator_id:          estInit && memberMap[estInit] ? memberMap[estInit] : null,
        salesperson_id:        salInit && memberMap[salInit] ? memberMap[salInit] : null,
        date_received:         excelDateToISO(row[2]),
        estimate_due_date:     excelDateToISO(row[3]),
        estimate_pct_complete: (row[15] != null && !isNaN(parseFloat(row[15]))) ? Math.min(1, parseFloat(row[15])) : 0,
        estimate_start_date:   excelDateToISO(row[16]),
        date_estimate_sent:    excelDateToISO(row[17]) || excelDateToISO(row[18]),
        estimate_amount:       (row[19] != null && !isNaN(parseFloat(row[19]))) ? parseFloat(row[19]) : null,
        estimate_approved_by:  cleanText(row[20]),
        award_date:            excelDateToISO(row[21]),
        awarded_contractor:    cleanText(row[22]),
        contract_reviewed_by:  cleanText(row[23]),
        date_contract_signed:  excelDateToISO(row[24]),
        status,
        updated_at:            nowStr(),
      };

      // Track what we've seen in Excel
      if (bidNum) excelBidNumbers.add(bidNum.trim().toLowerCase());
      excelNames.add(name.trim().toLowerCase());

      // Find existing record
      const key = bidNum ? bidNum.trim().toLowerCase() : null;
      const existing = key ? byBidNumber[key] : byName[name.trim().toLowerCase()];

      try {
        if (existing) {
          await Bid.findByIdAndUpdate(existing._id, bidData);
          sheetUpdated++;
          updated++;
        } else {
          const id = await nextId('bids');
          await Bid.create({ _id: id, ...bidData });
          sheetCreated++;
          created++;
          console.log(`    ➕ Created: [${id}] ${name}`);
        }
      } catch (e) {
        skipped++;
        console.warn(`    ⚠️  Skipped row ${r} "${name}": ${e.message}`);
      }
    }

    if (sheetCreated || sheetUpdated) {
      console.log(`  ${sheetName}: ${sheetUpdated} updated, ${sheetCreated} created`);
    }
  }

  // Report DB records not found in Excel (not deleted, not touched by sync)
  const notInExcel = existingBids.filter(b => {
    const numKey  = b.bid_number ? b.bid_number.trim().toLowerCase() : null;
    const nameKey = b.project_name.trim().toLowerCase();
    if (numKey && excelBidNumbers.has(numKey)) return false;
    if (excelNames.has(nameKey)) return false;
    return true;
  });

  console.log(`\n✅ Sync complete: ${updated} updated, ${created} created`);

  if (notInExcel.length > 0) {
    console.log(`\n⚠️  ${notInExcel.length} bids in the database were NOT found in the Excel file:`);
    console.log('   (These were NOT deleted — review manually if needed)');
    for (const b of notInExcel) {
      console.log(`   - [${b._id}] ${b.project_name} (${b.stage}) bid#: ${b.bid_number || 'none'}`);
    }
  }

  await mongoose.disconnect();
}

sync().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
