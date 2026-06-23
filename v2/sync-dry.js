/**
 * v2/sync-dry.js — DRY-RUN differential between a current Excel file and the
 * live v2 database. Read-only: connects to estimating_v2_test, writes NOTHING.
 *
 * Shows what an incremental sync WOULD do — NEW bids/COs to add, and EXISTING
 * bids whose Excel status/amount differs from what's in the app — so you can
 * pull in new work without clobbering the cleanup + revisions already in v2.
 *
 *   node v2/sync-dry.js "../Estimating Calendar 05-01-26.xlsx"
 */
require('dotenv').config();
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { getConnection, getModels } = require('./models');

const FILE = process.argv.find(a => a.endsWith('.xlsx')) || '../Estimating Calendar 05-01-26.xlsx';

const STAGE_SHEETS = { 'Opportunities': 'opportunity', 'Active - Bids': 'active_bid', 'Active - RFCs': 'active_co', 'Follow Up': 'follow_up', 'Awarded': 'awarded', 'Closed': 'closed' };
const V1_TO_V2 = { opportunity: 'opportunity', active_bid: 'active_bid', follow_up: 'submitted', awarded: 'awarded', closed: 'closed' };

const s = (v) => { if (v == null) return null; const t = String(v).trim(); return (!t || t === 'N/A' || t === 'TBD') ? null : t; };
const amt = (v) => { if (v == null) return null; const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,]/g, '')); return (isNaN(n) || n <= 0) ? null : n; };
function isCO(row, stage) { if (stage === 'active_co') return true; const tag = [s(row['Bid #']), s(row['Job #']), s(row['Project Name'])].filter(Boolean).join(' '); return /\b(rfc|cor)\b|rfc-?\d|cor-?\d/i.test(tag); }
function baseJob(v) { const t = s(v); if (!t) return null; const b = t.replace(/\b(RFC|COR|CO)[\s-]?\d+.*$/i, '').trim(); return b || null; }
function coNumber(row) { const hay = [s(row['Bid #']), s(row['Job #']), s(row['Project Name'])].filter(Boolean).join(' '); const m = hay.match(/\b(RFC|COR|CO)[\s-]?(\d+)/i); return m ? `${m[1].toUpperCase()}-${m[2].padStart(2, '0')}` : (s(row['Bid #']) || s(row['Job #']) || 'CO-?'); }

async function main() {
  const abs = path.resolve(FILE);
  if (!fs.existsSync(abs)) { console.error('File not found: ' + abs); process.exit(1); }
  const wb = XLSX.read(fs.readFileSync(abs));
  console.log(`\n🔎 Comparing  ${path.basename(abs)}  vs  the v2 database (read-only)\n`);

  // ── parse current Excel ──
  const xlBids = new Map();   // bid_number → { project, stage, amount }
  const xlCos = new Map();    // jobBase|coNum → { project, jobBase, coNum }
  let noBidNum = 0;
  const addRows = (rows, v1) => {
    for (const r of rows) {
      const pn = s(r['Project Name']); if (!pn || pn === 'Project Name') continue;
      if (isCO(r, v1)) { const bj = baseJob(r['Job #']); if (!bj) continue; xlCos.set(bj + '|' + coNumber(r), { project: pn, jobBase: bj, coNum: coNumber(r) }); continue; }
      const bn = s(r['Bid #']) || s(r['Bid # or Job #']);
      if (!bn) { noBidNum++; continue; }
      xlBids.set(bn.toUpperCase(), { project: pn, stage: V1_TO_V2[v1] || 'opportunity', amount: amt(r['Estimate Amount']) });
    }
  };
  for (const [sheet, v1] of Object.entries(STAGE_SHEETS)) { const ws = wb.Sheets[sheet]; if (ws) addRows(XLSX.utils.sheet_to_json(ws, { range: 1, defval: null }), v1); }
  if (wb.Sheets['_Closed']) addRows(XLSX.utils.sheet_to_json(wb.Sheets['_Closed'], { range: 0, defval: null }), 'closed');

  // ── load v2 ──
  const conn = getConnection(); await conn.asPromise();
  const M = getModels();
  const v2bids = await M.Bid.find().lean();
  const v2byNum = new Map(); v2bids.forEach(b => { if (b.bid_number) v2byNum.set(b.bid_number.toUpperCase(), b); });
  const [jobs, cos, projects] = await Promise.all([M.Job.find().lean(), M.ChangeOrder.find().lean(), M.Project.find().lean()]);
  const jobById = {}; jobs.forEach(j => jobById[j._id] = j);
  const pName = {}; projects.forEach(p => pName[p._id] = p.name);
  const v2coKeys = new Set();
  cos.forEach(c => { const j = jobById[c.job_id]; if (j && j.job_number) v2coKeys.add(j.job_number + '|' + c.co_number); });

  // ── diff ──
  const newBids = [], changedBids = [];
  for (const [num, x] of xlBids) {
    const v2 = v2byNum.get(num);
    if (!v2) { newBids.push({ num, ...x }); continue; }
    const diffs = [];
    if (v2.stage !== x.stage) diffs.push(`stage ${v2.stage} → ${x.stage}`);
    if (x.amount && v2.estimate_amount && Math.abs(x.amount - v2.estimate_amount) > 1) diffs.push(`amount ${v2.estimate_amount} → ${x.amount}`);
    if (x.amount && !v2.estimate_amount) diffs.push(`amount (none) → ${x.amount}`);
    if (diffs.length) changedBids.push({ num, project: pName[v2.project_id] || x.project, diffs });
  }
  const newCos = [];
  for (const [key, x] of xlCos) if (!v2coKeys.has(key)) newCos.push(x);
  const v2numsNotInXl = [...v2byNum.keys()].filter(n => !xlBids.has(n));

  // ── report ──
  console.log('═══ WHAT AN INCREMENTAL SYNC WOULD DO ═══\n');
  console.log(`  Excel bids w/ a bid #:   ${xlBids.size}   (${noBidNum} rows had no bid # — can't match)`);
  console.log(`  Excel change orders:     ${xlCos.size}\n`);
  console.log(`  🟢 NEW bids to ADD:       ${newBids.length}`);
  newBids.slice(0, 12).forEach(b => console.log(`        ${b.num} — ${b.project} [${b.stage}]`));
  if (newBids.length > 12) console.log(`        …and ${newBids.length - 12} more`);
  console.log(`\n  🟢 NEW change orders:     ${newCos.length}`);
  newCos.slice(0, 8).forEach(c => console.log(`        Job ${c.jobBase} ${c.coNum} — ${c.project}`));
  if (newCos.length > 8) console.log(`        …and ${newCos.length - 8} more`);
  console.log(`\n  🟡 CHANGED in Excel:      ${changedBids.length}   (review — the app may be the newer truth)`);
  changedBids.slice(0, 15).forEach(b => console.log(`        ${b.num} — ${b.project}: ${b.diffs.join('; ')}`));
  if (changedBids.length > 15) console.log(`        …and ${changedBids.length - 15} more`);
  console.log(`\n  ℹ️  In v2 but NOT in this Excel: ${v2numsNotInXl.length} bids (app-created, or removed/renamed in Excel — left untouched)`);
  console.log('\nDry run — nothing was written.\n');
  await conn.close();
}
main().catch(e => { console.error(e); process.exit(1); });
