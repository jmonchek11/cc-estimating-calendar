/**
 * v2/import.js — Excel → v2 import (writes real FK-linked documents)
 *
 * Loads the existing Estimating Calendar workbook into the ISOLATED
 * estimating_v2_test database as proper v2 entities with persisted foreign
 * keys (Bid.project_id, ChangeOrder.job_id, BidSubmission.bid_id/company_id…).
 * NOT the production DB. Re-runnable: wipes the v2 collections and rebuilds.
 *
 *   node v2/import.js                      # import ALL rows
 *   node v2/import.js --2026               # only 2026-scoped rows
 *   node v2/import.js --dry                # analyze + print, write nothing
 *   node v2/import.js "../other.xlsx"
 *
 * Restore the fake-scenario test data anytime with:  node v2/seed.js
 */
require('dotenv').config();
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { getConnection, getModels } = require('./models');
const db = require('./db');

const FILE = process.argv.find(a => a.endsWith('.xlsx')) || '../Estimating Calendar.xlsx';
const SCOPE_2026 = process.argv.includes('--2026');
const DRY = process.argv.includes('--dry');

const STAGE_SHEETS = {
  'Opportunities': 'opportunity', 'Active - Bids': 'active_bid', 'Active - RFCs': 'active_co',
  'Follow Up': 'follow_up', 'Awarded': 'awarded', 'Closed': 'closed',
};
const V1_TO_V2 = { opportunity: 'opportunity', active_bid: 'active_bid', follow_up: 'submitted', awarded: 'awarded', closed: 'closed' };
const CONTACT_TABS = ['Jim', 'Ray', 'Dame', 'Brian', 'Fran', 'Jake', 'Jess', 'Dillon'];

const TEAM = [
  { _id: 1, name: 'Joe Monchek', initials: 'JM', role: 'sales', is_admin: true, email: 'monchek11@gmail.com' },
  { _id: 2, name: 'Connor Winters', initials: 'CW', role: 'estimator' },
  { _id: 3, name: 'Pat McCreesh', initials: 'PM', role: 'estimator' },
  { _id: 4, name: 'Doug Pierno', initials: 'DP', role: 'estimator' },
  { _id: 5, name: 'Scott Yaffee', initials: 'SY', role: 'estimator' },
  { _id: 6, name: 'Jonathon Chukinas', initials: 'JC', role: 'estimator' },
  { _id: 7, name: 'Brian Fischer', initials: 'BF', role: 'sales' },
  { _id: 8, name: "Jim O'Driscoll", initials: 'JO', role: 'sales' },
  { _id: 9, name: 'Damion Covelens', initials: 'DC', role: 'sales' },
  { _id: 10, name: 'Fran Thompson', initials: 'FT', role: 'sales' },
  { _id: 11, name: 'Jacob Kiefer', initials: 'JK', role: 'sales' },
  { _id: 12, name: 'Jess Baker', initials: 'JB', role: 'sales' },
  { _id: 13, name: 'Ray Reichenbach', initials: 'RR', role: 'sales' },
  { _id: 14, name: 'Dillon Dosenbach', initials: 'DD', role: 'sales' },
];

const ts = () => new Date().toISOString().replace('T', ' ').substring(0, 19);
const s = (v) => { if (v == null) return null; const t = String(v).trim(); return (!t || t === 'N/A' || t === 'TBD') ? null : t; };
const amt = (v) => { if (v == null) return null; const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,]/g, '')); return (isNaN(n) || n <= 0) ? null : n; };
function xdate(v) {
  if (!v) return null;
  if (typeof v === 'string') { const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; }
  if (typeof v === 'number' && v > 1000) { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}` : null; }
  return null;
}
function xyear(v) { const d = xdate(v); return d ? +d.slice(0, 4) : null; }
function normName(v) {
  return String(v || '').toLowerCase()
    .replace(/[.']/g, '')                       // A.T. → AT, O'Driscoll → ODriscoll
    .replace(/[,"&\/()-]/g, ' ')
    .replace(/\b(inc|llc|llp|lp|corp|co|company|group|construction|builders|contracting|contractors)\b/g, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/\b([a-z]) (?=[a-z]\b)/g, '$1');   // collapse spaced initials: "a t" → "at"
}
const customersOf = (row) => Object.keys(row).filter(k => /^customer/i.test(k)).map(k => s(row[k])).filter(Boolean);
// A row is a change order if RFC/COR appears in the bid#, job#, OR project name.
function isCO(row, stage) {
  if (stage === 'active_co') return true;
  const tag = [s(row['Bid #']), s(row['Job #']), s(row['Project Name'])].filter(Boolean).join(' ');
  return /\b(rfc|cor)\b|rfc-?\d|cor-?\d/i.test(tag);
}
// Base job # = the job-number cell with any trailing "RFC-91 …" tag stripped off.
function baseJob(v) { const t = s(v); if (!t) return null; const b = t.replace(/\b(RFC|COR|CO)[\s-]?\d+.*$/i, '').trim(); return b || null; }
// Base project name = the name with any trailing "RFC-06 …" portion stripped off.
function baseName(v) { const t = s(v); if (!t) return null; return t.replace(/\s*\b(RFC|COR|CO)[\s-]?\d+.*$/i, '').trim() || t; }
// CO description = full name minus the project prefix and the RFC token.
function coDesc(fullName, projName) {
  let t = s(fullName) || 'Change Order';
  if (projName && t.toLowerCase().startsWith(projName.toLowerCase())) t = t.slice(projName.length).trim();
  t = t.replace(/^\b(RFC|COR|CO)[\s-]?\d+\s*/i, '').trim();
  return t || (s(fullName) || 'Change Order');
}
function coNumber(row) {
  const hay = [s(row['Bid #']), s(row['Job #']), s(row['Project Name'])].filter(Boolean).join(' ');
  const m = hay.match(/\b(RFC|COR|CO)[\s-]?(\d+)/i);
  if (m) return `${m[1].toUpperCase()}-${m[2].padStart(2, '0')}`;
  return s(row['Bid #']) || s(row['Job #']) || 'CO-?';   // never null (schema requires it)
}
function inScope(row) {
  const bn = s(row['Bid #']) || s(row['Bid # or Job #']) || '';
  if (/^b26/i.test(bn)) return true;
  return ['Date Received','Estimate Due Date','Estimate Start Date','Date Estimate Sent','Award Date'].some(k => xyear(row[k]) === 2026);
}

// estimator/salesperson string → team id
function buildLookup() {
  const byI = {}, byN = {};
  TEAM.forEach(m => { byI[m.initials.toUpperCase()] = m._id; byN[m.name.toLowerCase()] = m._id; m.name.toLowerCase().split(/\s+/).forEach(w => { if (w.length > 3) byN[w] = byN[w] || m._id; }); });
  return (raw) => {
    const t = s(raw); if (!t || typeof raw === 'number') return null;
    if (byN[t.toLowerCase()]) return byN[t.toLowerCase()];
    const first = t.split(/[\/,\s]+/)[0];
    return byI[first.toUpperCase()] || byN[first.toLowerCase()] || null;
  };
}

async function main() {
  // ── load workbook ──
  const abs = path.resolve(FILE);
  if (!fs.existsSync(abs)) { console.error('File not found: ' + abs); process.exit(1); }
  const wb = XLSX.read(fs.readFileSync(abs));
  console.log(`\n📂 Importing: ${path.basename(abs)}${SCOPE_2026 ? '  (2026 scope)' : '  (ALL rows)'}${DRY ? '  [DRY — no writes]' : ''}\n`);
  const lkp = buildLookup();

  // Connect up front so we can read persisted cleanup overrides (company aliases
  // are applied during the build; the rest are replayed after writing).
  const conn = getConnection(); await conn.asPromise();
  const M = getModels();

  // company aliases: optional JSON file + persisted company_alias overrides (DB)
  let aliases = {};
  const aliasFile = path.join(__dirname, 'company-aliases.json');
  if (fs.existsSync(aliasFile)) aliases = JSON.parse(fs.readFileSync(aliasFile, 'utf8'));
  const aliasOverrides = await M.CleanupOverride.find({ type: 'company_alias' }).lean();
  aliasOverrides.forEach(o => { aliases[o.from] = o.to; });
  console.log(`(company aliases — file: ${Object.keys(aliases).length - aliasOverrides.length}, saved overrides: ${aliasOverrides.length})\n`);

  // ── collect rows ──
  const bidRows = [], coRows = [];
  let outOfScope = 0;
  for (const [sheet, stage] of Object.entries(STAGE_SHEETS)) {
    const ws = wb.Sheets[sheet]; if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { range: 1, defval: null }).filter(r => { const n = s(r['Project Name']); return n && n !== 'Project Name'; });
    for (const r of rows) {
      if (SCOPE_2026 && !inScope(r)) { outOfScope++; continue; }
      r.__stage = stage;
      (isCO(r, stage) ? coRows : bidRows).push(r);
    }
  }
  const cws = wb.Sheets['_Closed'];
  if (cws) for (const r of XLSX.utils.sheet_to_json(cws, { range: 0, defval: null }).filter(r => s(r['Project Name']))) {
    if (SCOPE_2026 && !inScope(r)) { outOfScope++; continue; }
    r.__stage = 'closed'; bidRows.push(r);
  }

  // ── companies (normalize + alias) ──
  const rawCompanies = new Set();
  for (const r of [...bidRows, ...coRows]) { customersOf(r).forEach(c => rawCompanies.add(c)); const aw = s(r['Awarded Contractor']); if (aw) rawCompanies.add(aw); }
  const tabContacts = [];
  for (const tab of CONTACT_TABS) {
    const ws = wb.Sheets[tab]; if (!ws) continue;
    for (const r of XLSX.utils.sheet_to_json(ws, { range: 0, defval: null })) {
      const co = s(r['Company']), nm = s(r['Name']);
      if (co) rawCompanies.add(co);
      if (co && nm) tabContacts.push({ company: co, name: nm, phone: s(r['Phone #']) });
    }
  }
  // canonical name per normalized key (alias wins, else longest raw spelling)
  const canonByKey = {};
  for (const raw of rawCompanies) {
    const canon = aliases[raw] || aliases[normName(raw)] || raw;
    const key = normName(canon);
    if (!key) continue;
    if (!canonByKey[key] || canon.length > canonByKey[key].length) canonByKey[key] = canon;
  }
  let cid = 0; const companyIdByKey = {}; const companyDocs = [];
  for (const [key, name] of Object.entries(canonByKey)) { const id = ++cid; companyIdByKey[key] = id; companyDocs.push({ _id: id, name, created_at: ts(), updated_at: ts() }); }
  const companyIdOf = (raw) => { const canon = aliases[raw] || aliases[normName(raw)] || raw; return companyIdByKey[normName(canon)] || null; };

  // ── contacts ──
  let ctid = 0; const contactDocs = [];
  for (const c of tabContacts) { const coId = companyIdOf(c.company); if (!coId) continue; const [first, ...rest] = c.name.split(/\s+/); contactDocs.push({ _id: ++ctid, company_id: coId, first_name: first || null, last_name: rest.join(' ') || null, phone: c.phone || null, active: 1, created_at: ts(), updated_at: ts() }); }

  // ════════════════════════════════════════════════════════════════════════════
  // PROJECTS & JOBS — the JOB # is the primary grouping key.
  // Every row sharing a base job # belongs to ONE Project + ONE Job; RFC rows are
  // change orders on it. Rows without a job # fall back to grouping by name (and
  // join a job's project if their name matches it).
  // ════════════════════════════════════════════════════════════════════════════
  let pid = 0, job_id = 0;
  const projectDocs = [], jobDocs = [];
  const projByJob = {};    // baseJob → projectId
  const jobByNum = {};     // baseJob → jobId
  const projByName = {};   // normalized base name → projectId (no-job# rows)
  const nameToJob = {};    // normalized base name → baseJob (so name-only rows join the job's project)

  const allRows = [...bidRows, ...coRows];

  // PASS A — one Project + one Job per distinct base job #. Project name prefers a
  // real bid row's base name over a CO row's.
  const jobInfo = {};
  for (const r of allRows) {
    const bj = baseJob(r['Job #']); if (!bj) continue;
    const fromBid = !isCO(r, r.__stage);
    if (!jobInfo[bj] || (fromBid && !jobInfo[bj].fromBid)) jobInfo[bj] = { name: baseName(r['Project Name']), fromBid };
  }
  for (const [bj, info] of Object.entries(jobInfo)) {
    const projectId = ++pid; projectDocs.push({ _id: projectId, name: info.name || `Job ${bj}`, source_key: `job:${bj}`, created_by: 1, created_at: ts(), updated_at: ts() });
    projByJob[bj] = projectId;
    const jid = ++job_id; jobDocs.push({ _id: jid, project_id: projectId, winning_bid_id: null, job_number: bj, awarded_company_id: null, pm_id: null, award_date: null, created_at: ts(), updated_at: ts() });
    jobByNum[bj] = jid;
    const nk = normName(info.name); if (nk && !nameToJob[nk]) nameToJob[nk] = bj;
  }

  function nameProjectId(rawName) {
    const nb = baseName(rawName); const nk = normName(nb); if (!nk) return null;
    if (nameToJob[nk]) return projByJob[nameToJob[nk]];          // join an existing job's project
    if (!projByName[nk]) { const id = ++pid; projByName[nk] = id; projectDocs.push({ _id: id, name: nb, source_key: `name:${nk}`, created_by: 1, created_at: ts(), updated_at: ts() }); }
    return projByName[nk];
  }
  function projectFor(r) { const bj = baseJob(r['Job #']); return (bj && projByJob[bj]) ? projByJob[bj] : nameProjectId(r['Project Name']); }

  // ── bids + submissions + bid_customers ──
  let bid_id = 0, sub_id = 0, bc_id = 0, fu_id = 0;
  const bidDocs = [], subDocs = [], bcDocs = [], coDocs = [];
  const ex = { subNoCompany: 0, coNoJob: 0, noProject: 0 };

  for (const r of bidRows) {
    const projName = s(r['Project Name']); if (!projName) { ex.noProject++; continue; }
    const v1 = r.__stage; const stage = V1_TO_V2[v1] || 'opportunity';
    const projectId = projectFor(r);
    const id = ++bid_id;
    const custs = customersOf(r);
    const winnerCompanyId = s(r['Awarded Contractor']) ? companyIdOf(s(r['Awarded Contractor'])) : null;
    const amount = amt(r['Estimate Amount']);
    const dateSent = xdate(r['Date Estimate Sent']);
    const approvedBy = s(r['Estimate Approved By']);

    let subOutcome = null;
    if (v1 === 'awarded') subOutcome = 'awarded';
    else if (v1 === 'follow_up') subOutcome = 'pending';
    else if (v1 === 'closed' && amount && dateSent) subOutcome = 'not_awarded';
    const awardedCompanyId = (stage === 'awarded') ? (winnerCompanyId || companyIdOf(custs[0]) || null) : null;

    bidDocs.push({
      _id: id, project_id: projectId,
      bid_number: s(r['Bid #']) || s(r['Bid # or Job #']) || null, stage,
      estimator_id: lkp(r['Estimator']), salesperson_id: lkp(r['Salesperson']), sub_estimators: [],
      date_received: xdate(r['Date Received']), due_date: xdate(r['Estimate Due Date']), start_date: xdate(r['Estimate Start Date']),
      drawing_stage: null, jurisdiction: null,
      estimate_amount: amount, date_submitted: dateSent, approved_by: approvedBy,
      award_date: stage === 'awarded' ? xdate(r['Award Date']) : null, awarded_company_id: awardedCompanyId,
      next_followup_date: null, superseded: 0, notes: s(r['Notes']), created_at: ts(), updated_at: ts(),
    });

    for (const c of custs) { const coId = companyIdOf(c); if (coId) bcDocs.push({ _id: ++bc_id, bid_id: id, company_id: coId, contact_ids: [] }); }

    if (subOutcome) {
      const subCompany = subOutcome === 'awarded' ? awardedCompanyId : companyIdOf(custs[0]);
      if (subCompany) subDocs.push({
        _id: ++sub_id, bid_id: id, company_id: subCompany, amount, date_submitted: dateSent, approved_by: approvedBy,
        submission_type: 'initial', notes: null, is_current: 1, outcome: subOutcome,
        award_date: subOutcome === 'awarded' ? xdate(r['Award Date']) : null,
        date_not_awarded: subOutcome === 'not_awarded' ? xdate(r['Award Date']) : null,
        not_awarded_notes: null, next_followup_date: null, created_at: ts(), updated_at: ts(),
      });
      else ex.subNoCompany++;
    }

    // Awarded bid → fill in its Job's winner (or create a Job if it has no job # yet)
    if (stage === 'awarded') {
      const bj = baseJob(r['Job #']);
      if (bj && jobByNum[bj]) {
        const jdoc = jobDocs.find(j => j._id === jobByNum[bj]);
        if (jdoc && !jdoc.winning_bid_id) { jdoc.winning_bid_id = id; jdoc.awarded_company_id = awardedCompanyId; jdoc.award_date = xdate(r['Award Date']); }
      } else {
        const jid = ++job_id; jobDocs.push({ _id: jid, project_id: projectId, winning_bid_id: id, job_number: bj || null, awarded_company_id: awardedCompanyId, pm_id: null, award_date: xdate(r['Award Date']), created_at: ts(), updated_at: ts() });
        if (bj) jobByNum[bj] = jid;
      }
    }
  }

  // ── change orders — attach to the Job for their base job # ──
  for (const r of coRows) {
    const bj = baseJob(r['Job #']);
    const jid = bj ? jobByNum[bj] : null;
    if (!jid) { ex.coNoJob++; continue; }            // no job # → can't link (rare)
    const projName = jobInfo[bj] ? jobInfo[bj].name : null;
    const amount = amt(r['Estimate Amount']); const dateSent = xdate(r['Date Estimate Sent']); const awardDate = xdate(r['Award Date']);
    let coStage = 'active_co', approval = null;
    if (awardDate) { coStage = 'approved'; approval = awardDate; }
    else if (dateSent) coStage = 'submitted_co';
    coDocs.push({
      _id: coDocs.length + 1, job_id: jid, co_number: coNumber(r), name: coDesc(r['Project Name'], projName),
      stage: coStage, was_submitted: (dateSent || awardDate) ? 1 : 0,
      estimator_id: lkp(r['Estimator']), due_date: xdate(r['Estimate Due Date']), start_date: xdate(r['Estimate Start Date']),
      estimate_amount: amount, date_submitted: dateSent, approved_by: s(r['Estimate Approved By']),
      approval_date: approval, notes: s(r['Notes']), next_followup_date: null, created_at: ts(), updated_at: ts(),
    });
  }

  // ── report ──
  const legacyJobs = jobDocs.filter(j => !j.winning_bid_id).length;
  console.log('═══ WOULD CREATE ═══');
  console.log(`  Companies:      ${companyDocs.length}`);
  console.log(`  Contacts:       ${contactDocs.length}`);
  console.log(`  Projects:       ${projectDocs.length}   (grouped by job # where present)`);
  console.log(`  Bids:           ${bidDocs.length}`);
  console.log(`  BidCustomers:   ${bcDocs.length}`);
  console.log(`  Submissions:    ${subDocs.length}  (awarded ${subDocs.filter(s=>s.outcome==='awarded').length}, pending ${subDocs.filter(s=>s.outcome==='pending').length}, not-awarded ${subDocs.filter(s=>s.outcome==='not_awarded').length})`);
  console.log(`  Jobs:           ${jobDocs.length}   (${legacyJobs} legacy — no bid in file)`);
  console.log(`  Change Orders:  ${coDocs.length}`);
  if (SCOPE_2026) console.log(`  (out of 2026 scope, skipped: ${outOfScope})`);
  console.log(`\n  Notes: ${ex.coNoJob} CO(s) dropped (no job #); ${ex.subNoCompany} submission(s) skipped (no customer).`);

  if (DRY) { console.log('\n[DRY] nothing written. Re-run without --dry to load into estimating_v2_test.\n'); await conn.close(); process.exit(0); }

  // ── write — wipe everything EXCEPT cleanup_overrides (persisted cleanup) ──
  console.log('\nWriting to estimating_v2_test (preserving saved cleanup)…');
  for (const [name, model] of Object.entries(M)) { if (name === 'CleanupOverride') continue; await model.deleteMany({}); }
  await M.TeamMember.insertMany(TEAM.map(t => ({ ...t, active: 1, created_at: ts() })));
  await M.Settings.create({ _id: 'company', fu_initial_days: 3, fu_recurring_days: 7 });
  if (companyDocs.length) await M.Company.insertMany(companyDocs);
  if (contactDocs.length) await M.Contact.insertMany(contactDocs);
  if (projectDocs.length) await M.Project.insertMany(projectDocs);
  if (bidDocs.length) await M.Bid.insertMany(bidDocs);
  if (bcDocs.length) await M.BidCustomer.insertMany(bcDocs);
  if (subDocs.length) await M.BidSubmission.insertMany(subDocs);
  if (jobDocs.length) await M.Job.insertMany(jobDocs);
  if (coDocs.length) await M.ChangeOrder.insertMany(coDocs);
  const maxOv = await M.CleanupOverride.findOne().sort({ _id: -1 }).lean();
  await M.Counter.insertMany([
    { _id: 'projects', seq: pid }, { _id: 'bids', seq: bid_id }, { _id: 'jobs', seq: job_id },
    { _id: 'change_orders', seq: coDocs.length }, { _id: 'companies', seq: cid }, { _id: 'contacts', seq: ctid },
    { _id: 'bid_customers', seq: bc_id }, { _id: 'bid_submissions', seq: sub_id }, { _id: 'followups', seq: fu_id },
    { _id: 'reminders', seq: 0 }, { _id: 'ignored_pairs', seq: 0 }, { _id: 'cleanup_overrides', seq: maxOv ? maxOv._id : 0 },
  ]);

  // verify FK integrity
  const orphanBids = await M.Bid.countDocuments({ project_id: { $nin: projectDocs.map(p => p._id) } });
  const orphanCos = await M.ChangeOrder.countDocuments({ job_id: { $nin: jobDocs.map(j => j._id) } });
  console.log(`✅ Imported. FK check — bids with bad project_id: ${orphanBids}, COs with bad job_id: ${orphanCos}`);

  // ── replay saved cleanup (merges, renames, deletes, not-a-dup) ──
  const applied = await db.applyCleanupOverrides();
  const savedAliases = await M.CleanupOverride.countDocuments({ type: 'company_alias' });
  console.log(`🔁 Replayed cleanup: ${applied.merges} project-merge, ${applied.renames} rename, ${applied.deletes} delete, ${applied.not_dup} not-a-dup, ${savedAliases} company-alias (applied during build).`);
  console.log('Open /v2 to walk the real data.  Restore fake scenarios anytime with: node v2/seed.js\n');
  await conn.close();
}

main().catch(e => { console.error(e); process.exit(1); });
