/**
 * v2/import-dry.js — DRY RUN Excel → v2 import analyzer
 *
 * Reads the existing Estimating Calendar workbook and reports what a real
 * import WOULD create (Projects, Bids, Change Orders, Submissions, Jobs,
 * Companies, Contacts) plus an exceptions punch-list. Writes NOTHING — no DB
 * connection at all. Safe to run anytime.
 *
 * Usage:
 *   node v2/import-dry.js                       # defaults to ../Estimating Calendar.xlsx
 *   node v2/import-dry.js "../some other.xlsx"
 *   node v2/import-dry.js "../file.xlsx" --2026 # only count 2026-scoped rows
 */
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const FILE = process.argv.find(a => a.endsWith('.xlsx')) || '../Estimating Calendar.xlsx';
const SCOPE_2026 = process.argv.includes('--2026');

// Bid/CO sheets have a duplicate header on row 0, real header on row 1 (range:1).
const STAGE_SHEETS = {
  'Opportunities': 'opportunity',
  'Active - Bids': 'active_bid',
  'Active - RFCs': 'active_co',     // change orders
  'Follow Up':     'follow_up',
  'Awarded':       'awarded',
  'Closed':        'closed',
};
const CONTACT_TABS = ['Jim', 'Ray', 'Dame', 'Brian', 'Fran', 'Jake', 'Jess', 'Dillon'];

const KNOWN_PEOPLE = ['BF','JO','DC','DD','FT','JK','JB','RR','JM','CW','PM','DP','SY','JC',
  'fischer','o\'driscoll','odriscoll','covelens','dosenbach','thompson','kiefer','baker',
  'reichenbach','monchek','winters','mccreesh','pierno','yaffee','chukinas'];

const LEGACY_JOBS = ['amy james martin','william h gray','bridesburg recreation','chop fuel oil',
  'dillworth plaza','friend\'s center','temple infusion','upenn vlest shoji'];

// ── helpers ───────────────────────────────────────────────────────────────────
const s = (v) => { if (v == null) return null; const t = String(v).trim(); return (!t || t === 'N/A' || t === 'TBD') ? null : t; };
const amt = (v) => { if (v == null) return null; const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,]/g, '')); return (isNaN(n) || n <= 0) ? null : n; };
function excelYear(v) {
  if (typeof v === 'number' && v > 1000) { const d = XLSX.SSF.parse_date_code(v); return d ? d.y : null; }
  if (typeof v === 'string') { const m = v.match(/(20\d{2})/); return m ? +m[1] : null; }
  return null;
}
function normName(v) {
  return String(v || '').toLowerCase()
    .replace(/[.,'"&\/()-]/g, ' ')
    .replace(/\b(inc|llc|llp|lp|corp|co|company|group|construction|builders|contracting|contractors)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  const prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[n];
}
function customersOf(row) {
  return Object.keys(row).filter(k => /^customer/i.test(k)).map(k => s(row[k])).filter(Boolean);
}
function isCO(row, stage) {
  if (stage === 'active_co') return true;
  const tag = (s(row['Bid #']) || '') + ' ' + (s(row['Job #']) || '');
  return /\b(rfc|cor)\b|rfc-?\d|cor-?\d/i.test(tag);
}
function rowInScope(row) {
  const bn = s(row['Bid #']) || s(row['Bid # or Job #']) || '';
  if (/^b26/i.test(bn)) return true;
  for (const k of ['Date Received','Estimate Due Date','Estimate Start Date','Date Estimate Sent','Award Date']) {
    if (excelYear(row[k]) === 2026) return true;
  }
  return false;
}

// ── load ──────────────────────────────────────────────────────────────────────
const abs = path.resolve(FILE);
if (!fs.existsSync(abs)) { console.error('File not found: ' + abs); process.exit(1); }
const wb = XLSX.read(fs.readFileSync(abs));
console.log(`\n📂 Analyzing: ${path.basename(abs)}${SCOPE_2026 ? '   (2026 scope only)' : '   (ALL rows)'}\n`);

// ── collect rows ────────────────────────────────────────────────────────────────
const bidRows = [], coRows = [];
let skippedNoName = 0, outOfScope = 0;
for (const [sheet, stage] of Object.entries(STAGE_SHEETS)) {
  const ws = wb.Sheets[sheet]; if (!ws) continue;
  const rows = XLSX.utils.sheet_to_json(ws, { range: 1, defval: null })
    .filter(r => { const n = s(r['Project Name']); return n && n !== 'Project Name'; });
  for (const r of rows) {
    if (!s(r['Project Name'])) { skippedNoName++; continue; }
    if (SCOPE_2026 && !rowInScope(r)) { outOfScope++; continue; }
    r.__stage = stage; r.__sheet = sheet;
    (isCO(r, stage) ? coRows : bidRows).push(r);
  }
}
// _Closed (header on row 0)
const cws = wb.Sheets['_Closed'];
if (cws) {
  const rows = XLSX.utils.sheet_to_json(cws, { range: 0, defval: null }).filter(r => s(r['Project Name']));
  for (const r of rows) {
    if (SCOPE_2026 && !rowInScope(r)) { outOfScope++; continue; }
    r.__stage = 'closed'; r.__sheet = '_Closed';
    bidRows.push(r);
  }
}

// ── derive entities ─────────────────────────────────────────────────────────────
// Projects: group by normalized name
const projByKey = {};   // normKey -> { names:Set, rows:[] }
for (const r of [...bidRows, ...coRows]) {
  const raw = s(r['Project Name']); const key = normName(raw);
  (projByKey[key] = projByKey[key] || { names: new Set(), count: 0 }).names.add(raw);
  projByKey[key].count++;
}
// Jobs: awarded rows / rows with a job #
const jobNums = new Set();
for (const r of bidRows) {
  const jn = s(r['Job #']);
  if (jn && (r.__stage === 'awarded' || s(r['Award Date']) || s(r['Awarded Contractor']))) jobNums.add(jn.toLowerCase());
}
// Submissions: bids that were actually submitted (have $ or sent date or awarded)
const submittedBids = bidRows.filter(r => amt(r['Estimate Amount']) || s(r['Date Estimate Sent']) || r.__stage === 'awarded');
// Companies: all customer strings + awarded contractors + contact-tab companies
const companyRaw = new Set();
for (const r of [...bidRows, ...coRows]) { customersOf(r).forEach(c => companyRaw.add(c)); const aw = s(r['Awarded Contractor']); if (aw) companyRaw.add(aw); }
let contactCount = 0;
for (const tab of CONTACT_TABS) {
  const ws = wb.Sheets[tab]; if (!ws) continue;
  const rows = XLSX.utils.sheet_to_json(ws, { range: 0, defval: null });
  for (const r of rows) { const co = s(r['Company']); const nm = s(r['Name']); if (co) companyRaw.add(co); if (co && nm) contactCount++; }
}

// ── exceptions ──────────────────────────────────────────────────────────────────
const ex = { coNoJob: [], coOrphanJob: [], awardMismatch: [], noBidNum: [], dupProjects: [], dupCompanies: [], unknownPeople: new Set(), legacyMissing: [] };

for (const r of coRows) {
  const jn = s(r['Job #']);
  if (!jn) ex.coNoJob.push(`${s(r['Bid #']) || '(no bid#)'} — ${s(r['Project Name'])}`);
  else if (!jobNums.has(jn.toLowerCase())) ex.coOrphanJob.push(`${jn} — ${s(r['Project Name'])}`);
}
for (const r of bidRows) {
  if (r.__stage === 'awarded' || s(r['Award Date'])) {
    const aw = s(r['Awarded Contractor']); const custs = customersOf(r).map(normName);
    if (aw && custs.length && !custs.includes(normName(aw))) ex.awardMismatch.push(`${s(r['Project Name'])}: won by "${aw}" — not in customers [${customersOf(r).join(', ') || 'none'}]`);
  }
  if (!s(r['Bid #']) && !s(r['Bid # or Job #'])) ex.noBidNum.push(s(r['Project Name']));
  for (const who of [r['Estimator'], r['Salesperson']]) {
    const t = s(who); if (!t || typeof who === 'number') continue;
    const tok = t.split(/[\/,\s]+/)[0].toLowerCase();
    if (!KNOWN_PEOPLE.some(k => k.toLowerCase() === tok || t.toLowerCase().includes(k.toLowerCase()))) ex.unknownPeople.add(t);
  }
}
// near-duplicate projects: same normalized key with different raw spellings,
// OR a single-character typo apart (lev<=1) on names long enough to be meaningful.
const projKeys = Object.keys(projByKey).filter(Boolean);
for (const k of projKeys) { if (projByKey[k].names.size > 1) ex.dupProjects.push([...projByKey[k].names].join('  ≈  ')); }
for (let i = 0; i < projKeys.length; i++) for (let j = i + 1; j < projKeys.length; j++) {
  const a = projKeys[i], b = projKeys[j];
  if (a.length >= 10 && b.length >= 10 && Math.abs(a.length - b.length) <= 2 && lev(a, b) <= 1)
    ex.dupProjects.push(`${[...projByKey[a].names][0]}  ≈  ${[...projByKey[b].names][0]}`);
}
// near-duplicate companies: same normalized key, or a single-char typo apart
const compArr = [...companyRaw]; const compNorm = compArr.map(normName);
const seenPair = new Set();
for (let i = 0; i < compArr.length; i++) for (let j = i + 1; j < compArr.length; j++) {
  if (!compNorm[i] || !compNorm[j]) continue;
  const same = compNorm[i] === compNorm[j];
  const close = compNorm[i].length >= 8 && compNorm[j].length >= 8 && Math.abs(compNorm[i].length - compNorm[j].length) <= 2 && lev(compNorm[i], compNorm[j]) <= 1;
  if (same || close) {
    const pair = `${compArr[i]}  ≈  ${compArr[j]}`; if (!seenPair.has(pair)) { seenPair.add(pair); ex.dupCompanies.push(pair); }
  }
}
// legacy jobs present?
const allProjText = [...bidRows, ...coRows].map(r => normName(r['Project Name'])).join(' | ');
for (const lj of LEGACY_JOBS) if (!allProjText.includes(lj.replace(/[.']/g, ' ').replace(/\s+/g, ' ').trim().split(' ')[0])) { /* loose */ }
for (const lj of LEGACY_JOBS) { const first = lj.split(' ')[0]; if (!allProjText.includes(first)) ex.legacyMissing.push(lj); }

// ── report ──────────────────────────────────────────────────────────────────────
const uniqCompanies = new Set(compNorm.filter(Boolean)).size;
console.log('═══ WOULD CREATE ═══');
console.log(`  Projects (distinct names):  ${Object.keys(projByKey).filter(Boolean).length}`);
console.log(`  Bids:                       ${bidRows.length}`);
console.log(`  Change Orders:              ${coRows.length}`);
console.log(`  Submissions (1 per bid):    ${submittedBids.length}`);
console.log(`  Jobs (awarded w/ job #):    ${jobNums.size}`);
console.log(`  Companies (deduped ~):      ${uniqCompanies}  (from ${compArr.length} raw strings)`);
console.log(`  Contacts (from sales tabs): ${contactCount}`);
console.log(`  Skipped (no project name):  ${skippedNoName}${SCOPE_2026 ? `\n  Out of 2026 scope:          ${outOfScope}` : ''}`);

function section(title, arr, note) {
  console.log(`\n── ${title}: ${arr.length} ──${note ? '  ' + note : ''}`);
  arr.slice(0, 15).forEach(x => console.log('   • ' + x));
  if (arr.length > 15) console.log(`   …and ${arr.length - 15} more`);
}
console.log('\n═══ EXCEPTIONS (clean these in Excel before the real import) ═══');
section('Change orders MISSING a job #', ex.coNoJob, '→ can\'t link to a Job');
section('Change orders whose parent job # is NOT among awarded jobs', ex.coOrphanJob, '→ legacy job? create it first');
section('Awarded rows where Awarded Contractor ≠ any listed customer', ex.awardMismatch, '→ winning submission won\'t link');
section('Bids with NO bid # / job #', ex.noBidNum, '→ hard to dedupe/identify');
section('Likely DUPLICATE / typo project names', [...new Set(ex.dupProjects)], '→ will fragment into separate projects');
section('Likely DUPLICATE / typo company names', ex.dupCompanies, '→ will fragment into separate companies');
section('Unrecognized estimator/salesperson values', [...ex.unknownPeople], '→ won\'t map to a team member');
section('Legacy jobs NOT found in the sheet', ex.legacyMissing, '→ add them so their COs have a parent');

console.log('\nDone (dry run — nothing was written).\n');
