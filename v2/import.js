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
function isCO(row, stage) {
  if (stage === 'active_co') return true;
  const tag = (s(row['Bid #']) || '') + ' ' + (s(row['Job #']) || '');
  return /\b(rfc|cor)\b|rfc-?\d|cor-?\d/i.test(tag);
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

  // optional alias map: { "raw or normalized name": "Canonical Company Name" }
  let aliases = {};
  const aliasFile = path.join(__dirname, 'company-aliases.json');
  if (fs.existsSync(aliasFile)) { aliases = JSON.parse(fs.readFileSync(aliasFile, 'utf8')); console.log(`(loaded ${Object.keys(aliases).length} company aliases)\n`); }

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

  // ── projects (group bids by normalized name) ──
  let pid = 0; const projectIdByKey = {}; const projectDocs = [];
  const projectIdFor = (rawName) => {
    const key = normName(rawName); if (!key) return null;
    if (!projectIdByKey[key]) { const id = ++pid; projectIdByKey[key] = id; projectDocs.push({ _id: id, name: s(rawName), created_by: 1, created_at: ts(), updated_at: ts() }); }
    return projectIdByKey[key];
  };

  // ── bids + submissions + bid_customers + jobs ──
  let bid_id = 0, sub_id = 0, bc_id = 0, job_id = 0, fu_id = 0;
  const bidDocs = [], subDocs = [], bcDocs = [], jobDocs = [], coDocs = [], fuDocs = [];
  const jobIdByNum = {};   // job_number(lower) → job_id
  const ex = { subNoCompany: 0, coOrphan: [], coNoJob: 0, noProject: 0 };

  for (const r of bidRows) {
    const projName = s(r['Project Name']); if (!projName) { ex.noProject++; continue; }
    const v1 = r.__stage; const stage = V1_TO_V2[v1] || 'opportunity';
    const projectId = projectIdFor(projName);
    const id = ++bid_id;
    const custs = customersOf(r);
    const award = s(r['Awarded Contractor']);
    const winnerCompanyId = award ? companyIdOf(award) : null;
    const amount = amt(r['Estimate Amount']);
    const dateSent = xdate(r['Date Estimate Sent']);
    const approvedBy = s(r['Estimate Approved By']);

    // submission outcome
    let subOutcome = null;
    if (v1 === 'awarded') subOutcome = 'awarded';
    else if (v1 === 'follow_up') subOutcome = 'pending';
    else if (v1 === 'closed' && amount && dateSent) subOutcome = 'not_awarded';

    const awardedCompanyId = (stage === 'awarded') ? (winnerCompanyId || companyIdOf(custs[0]) || null) : null;

    bidDocs.push({
      _id: id, project_id: projectId,
      bid_number: s(r['Bid #']) || s(r['Bid # or Job #']) || null,
      stage,
      estimator_id: lkp(r['Estimator']), salesperson_id: lkp(r['Salesperson']),
      sub_estimators: [],
      date_received: xdate(r['Date Received']), due_date: xdate(r['Estimate Due Date']), start_date: xdate(r['Estimate Start Date']),
      drawing_stage: null, jurisdiction: null,
      estimate_amount: amount, date_submitted: dateSent, approved_by: approvedBy,
      award_date: stage === 'awarded' ? xdate(r['Award Date']) : null,
      awarded_company_id: awardedCompanyId,
      next_followup_date: null, superseded: 0, notes: s(r['Notes']),
      created_at: ts(), updated_at: ts(),
    });

    // bid_customers
    for (const c of custs) { const coId = companyIdOf(c); if (coId) bcDocs.push({ _id: ++bc_id, bid_id: id, company_id: coId, contact_ids: [] }); }

    // submission (one per submitted+ bid)
    if (subOutcome) {
      const subCompany = subOutcome === 'awarded' ? awardedCompanyId : companyIdOf(custs[0]);
      if (subCompany) {
        subDocs.push({
          _id: ++sub_id, bid_id: id, company_id: subCompany,
          amount, date_submitted: dateSent, approved_by: approvedBy,
          submission_type: 'initial', notes: null, is_current: 1,
          outcome: subOutcome, award_date: subOutcome === 'awarded' ? xdate(r['Award Date']) : null,
          date_not_awarded: subOutcome === 'not_awarded' ? xdate(r['Award Date']) : null,
          not_awarded_notes: null, next_followup_date: null,
          created_at: ts(), updated_at: ts(),
        });
      } else ex.subNoCompany++;
    }

    // job (awarded bids)
    if (stage === 'awarded') {
      const jn = s(r['Job #']);
      const jid = ++job_id;
      jobDocs.push({ _id: jid, project_id: projectId, winning_bid_id: id, job_number: jn || null, awarded_company_id: awardedCompanyId, pm_id: null, award_date: xdate(r['Award Date']), created_at: ts(), updated_at: ts() });
      if (jn) jobIdByNum[jn.toLowerCase()] = jid;
    }
  }

  // ── change orders (attach to jobs by job #; create legacy jobs as needed) ──
  const legacyProjectByJob = {};
  for (const r of coRows) {
    const jn = s(r['Job #']);
    let jid = jn ? jobIdByNum[jn.toLowerCase()] : null;
    if (!jid) {
      if (!jn) { ex.coNoJob++; continue; }                 // can't link without a job #
      // legacy job: create a placeholder project + job once per job #
      if (!legacyProjectByJob[jn.toLowerCase()]) {
        const lp = ++pid; projectDocs.push({ _id: lp, name: `Legacy Job ${jn}`, created_by: 1, created_at: ts(), updated_at: ts() });
        jid = ++job_id; jobDocs.push({ _id: jid, project_id: lp, winning_bid_id: null, job_number: jn, awarded_company_id: null, pm_id: null, award_date: null, created_at: ts(), updated_at: ts() });
        jobIdByNum[jn.toLowerCase()] = jid; legacyProjectByJob[jn.toLowerCase()] = jid;
        ex.coOrphan.push(jn);
      } else jid = legacyProjectByJob[jn.toLowerCase()];
    }
    const amount = amt(r['Estimate Amount']); const dateSent = xdate(r['Date Estimate Sent']);
    coDocs.push({
      _id: coDocs.length + 1, job_id: jid, co_number: coNumber(r), name: s(r['Project Name']) || 'Change Order',
      stage: dateSent ? 'submitted_co' : 'active_co', was_submitted: dateSent ? 1 : 0,
      estimator_id: lkp(r['Estimator']), due_date: xdate(r['Estimate Due Date']), start_date: xdate(r['Estimate Start Date']),
      estimate_amount: amount, date_submitted: dateSent, approved_by: s(r['Estimate Approved By']),
      notes: s(r['Notes']), next_followup_date: null, created_at: ts(), updated_at: ts(),
    });
  }

  // ── report ──
  console.log('═══ WOULD CREATE ═══');
  console.log(`  Companies:      ${companyDocs.length}`);
  console.log(`  Contacts:       ${contactDocs.length}`);
  console.log(`  Projects:       ${projectDocs.length}   (incl. ${Object.keys(legacyProjectByJob).length} legacy)`);
  console.log(`  Bids:           ${bidDocs.length}`);
  console.log(`  BidCustomers:   ${bcDocs.length}`);
  console.log(`  Submissions:    ${subDocs.length}  (awarded ${subDocs.filter(s=>s.outcome==='awarded').length}, pending ${subDocs.filter(s=>s.outcome==='pending').length}, not-awarded ${subDocs.filter(s=>s.outcome==='not_awarded').length})`);
  console.log(`  Jobs:           ${jobDocs.length}`);
  console.log(`  Change Orders:  ${coDocs.length}`);
  if (SCOPE_2026) console.log(`  (out of 2026 scope, skipped: ${outOfScope})`);
  console.log(`\n  Notes: ${ex.coOrphan.length} legacy job(s) auto-created for orphan COs; ${ex.coNoJob} CO(s) dropped (no job #); ${ex.subNoCompany} submission(s) skipped (no customer).`);

  if (DRY) { console.log('\n[DRY] nothing written. Re-run without --dry to load into estimating_v2_test.\n'); process.exit(0); }

  // ── write ──
  const conn = getConnection(); await conn.asPromise();
  const M = getModels();
  console.log('\nWiping estimating_v2_test and writing…');
  for (const model of Object.values(M)) await model.deleteMany({});
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
  await M.Counter.insertMany([
    { _id: 'projects', seq: pid }, { _id: 'bids', seq: bid_id }, { _id: 'jobs', seq: job_id },
    { _id: 'change_orders', seq: coDocs.length }, { _id: 'companies', seq: cid }, { _id: 'contacts', seq: ctid },
    { _id: 'bid_customers', seq: bc_id }, { _id: 'bid_submissions', seq: sub_id }, { _id: 'followups', seq: fu_id }, { _id: 'reminders', seq: 0 },
  ]);

  // verify FK integrity
  const orphanBids = await M.Bid.countDocuments({ project_id: { $nin: projectDocs.map(p => p._id) } });
  const orphanCos = await M.ChangeOrder.countDocuments({ job_id: { $nin: jobDocs.map(j => j._id) } });
  console.log(`\n✅ Imported. FK check — bids with bad project_id: ${orphanBids}, COs with bad job_id: ${orphanCos}`);
  console.log('Open /v2 to walk the real data.  Restore fake scenarios anytime with: node v2/seed.js\n');
  await conn.close();
}

main().catch(e => { console.error(e); process.exit(1); });
