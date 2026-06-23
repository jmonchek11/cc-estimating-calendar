/**
 * v2/sync.js — INCREMENTAL add-only sync: pull NEW bids + change orders from a
 * current Excel file into the live v2 database WITHOUT wiping anything.
 *
 * Existing records (and all cleanup + in-app revisions) are left untouched.
 * New bids link to existing projects/companies/jobs where they already exist,
 * else create them. Change orders attach to existing jobs by job #.
 * Status changes on EXISTING bids are NOT handled here (separate reviewed step).
 *
 *   node v2/sync.js "../<file>.xlsx"            # DRY RUN (default) — prints plan
 *   node v2/sync.js "../<file>.xlsx" --apply    # actually write the new records
 */
require('dotenv').config();
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { getConnection, getModels } = require('./models');

const FILE = process.argv.find(a => a.endsWith('.xlsx')) || '../Estimating Calendar -CURRENT.xlsx';
const APPLY = process.argv.includes('--apply');

const STAGE_SHEETS = { 'Opportunities': 'opportunity', 'Active - Bids': 'active_bid', 'Active - RFCs': 'active_co', 'Follow Up': 'follow_up', 'Awarded': 'awarded', 'Closed': 'closed' };
const V1_TO_V2 = { opportunity: 'opportunity', active_bid: 'active_bid', follow_up: 'submitted', awarded: 'awarded', closed: 'closed' };

const ts = () => new Date().toISOString().replace('T', ' ').substring(0, 19);
const s = (v) => { if (v == null) return null; const t = String(v).trim(); return (!t || t === 'N/A' || t === 'TBD') ? null : t; };
const amt = (v) => { if (v == null) return null; const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,]/g, '')); return (isNaN(n) || n <= 0) ? null : n; };
function xdate(v) { if (!v) return null; if (typeof v === 'string') { const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; } if (typeof v === 'number' && v > 1000) { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}` : null; } return null; }
function normName(v) { return String(v || '').toLowerCase().replace(/[.']/g, '').replace(/[,"&\/()-]/g, ' ').replace(/\b(inc|llc|llp|lp|corp|co|company|group|construction|builders|contracting|contractors)\b/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b([a-z]) (?=[a-z]\b)/g, '$1'); }
const customersOf = (row) => Object.keys(row).filter(k => /^customer/i.test(k)).map(k => s(row[k])).filter(Boolean);
function isCO(row, stage) { if (stage === 'active_co') return true; const tag = [s(row['Bid #']), s(row['Job #']), s(row['Project Name'])].filter(Boolean).join(' '); return /\b(rfc|cor)\b|rfc-?\d|cor-?\d/i.test(tag); }
function baseJob(v) { const t = s(v); if (!t) return null; const b = t.replace(/\b(RFC|COR|CO)[\s-]?\d+.*$/i, '').trim(); return b || null; }
function baseName(v) { const t = s(v); if (!t) return null; return t.replace(/\s*\b(RFC|COR|CO)[\s-]?\d+.*$/i, '').trim() || t; }
function coNumber(row) { const hay = [s(row['Bid #']), s(row['Job #']), s(row['Project Name'])].filter(Boolean).join(' '); const m = hay.match(/\b(RFC|COR|CO)[\s-]?(\d+)/i); if (m) return `${m[1].toUpperCase()}-${m[2].padStart(2, '0')}`; return s(row['Bid #']) || s(row['Job #']) || 'CO-?'; }
function coDesc(fullName, projName) { let t = s(fullName) || 'Change Order'; if (projName && t.toLowerCase().startsWith(projName.toLowerCase())) t = t.slice(projName.length).trim(); t = t.replace(/^\b(RFC|COR|CO)[\s-]?\d+\s*/i, '').trim(); return t || (s(fullName) || 'Change Order'); }

async function main() {
  const abs = path.resolve(FILE);
  if (!fs.existsSync(abs)) { console.error('File not found: ' + abs); process.exit(1); }
  const wb = XLSX.read(fs.readFileSync(abs));
  console.log(`\n🔄 Incremental sync from ${path.basename(abs)}  ${APPLY ? '[APPLY — writing]' : '[DRY RUN]'}\n`);

  const conn = getConnection(); await conn.asPromise();
  const M = getModels();

  // team lookup (existing members)
  const members = await M.TeamMember.find().lean();
  const byI = {}, byN = {};
  members.forEach(m => { byI[m.initials.toUpperCase()] = m._id; byN[m.name.toLowerCase()] = m._id; m.name.toLowerCase().split(/\s+/).forEach(w => { if (w.length > 3) byN[w] = byN[w] || m._id; }); });
  const lkp = (raw) => { const t = s(raw); if (!t || typeof raw === 'number') return null; if (byN[t.toLowerCase()]) return byN[t.toLowerCase()]; const f = t.split(/[\/,\s]+/)[0]; return byI[f.toUpperCase()] || byN[f.toLowerCase()] || null; };

  // existing data + resolvers
  const aliases = {}; (await M.CleanupOverride.find({ type: 'company_alias' }).lean()).forEach(o => aliases[o.from] = o.to);
  const companies = await M.Company.find().lean();
  const companyIdByKey = {}; companies.forEach(c => companyIdByKey[normName(c.name)] = c._id);
  const projects = await M.Project.find().lean();
  const projBySrc = {}, projByName = {}; projects.forEach(p => { if (p.source_key) projBySrc[p.source_key] = p._id; projByName[normName(p.name)] = p._id; });
  const jobs = await M.Job.find().lean();
  const jobByNum = {}; jobs.forEach(j => { if (j.job_number) jobByNum[j.job_number.toLowerCase()] = j._id; });
  const cos = await M.ChangeOrder.find().lean();
  const v2coKeys = new Set(); cos.forEach(c => { const j = jobs.find(x => x._id === c.job_id); if (j && j.job_number) v2coKeys.add(j.job_number + '|' + c.co_number); });
  const existingBidNums = new Set(); (await M.Bid.find({ bid_number: { $ne: null } }).select('bid_number').lean()).forEach(b => existingBidNums.add(b.bid_number.toUpperCase()));

  // collect rows
  const bidRows = [], coRows = [];
  const addRows = (rows, v1) => { for (const r of rows) { const pn = s(r['Project Name']); if (!pn || pn === 'Project Name') continue; r.__stage = v1; (isCO(r, v1) ? coRows : bidRows).push(r); } };
  for (const [sheet, v1] of Object.entries(STAGE_SHEETS)) { const ws = wb.Sheets[sheet]; if (ws) addRows(XLSX.utils.sheet_to_json(ws, { range: 1, defval: null }), v1); }
  if (wb.Sheets['_Closed']) addRows(XLSX.utils.sheet_to_json(wb.Sheets['_Closed'], { range: 0, defval: null }), 'closed');

  // ── stage counters in memory (seeded from DB), assigned only if applying ──
  const counters = {};
  for (const name of ['projects', 'bids', 'jobs', 'change_orders', 'companies', 'bid_customers', 'bid_submissions']) {
    const c = await M.Counter.findById(name).lean(); counters[name] = c ? c.seq : 0;
  }
  const nextId = (name) => ++counters[name];

  const plan = { newBids: 0, newProjects: 0, linkedProjects: 0, newCompanies: 0, newJobs: 0, newSubs: 0, newCos: 0, skippedNoBidNum: 0, skippedCoNoJob: 0 };
  const docs = { projects: [], companies: [], bids: [], bidCustomers: [], subs: [], jobs: [], cos: [] };

  const companyIdOf = (raw) => {
    const canon = aliases[raw] || aliases[normName(raw)] || raw; const key = normName(canon); if (!key) return null;
    if (companyIdByKey[key]) return companyIdByKey[key];
    const id = nextId('companies'); companyIdByKey[key] = id; docs.companies.push({ _id: id, name: canon, created_at: ts(), updated_at: ts() }); plan.newCompanies++;
    return id;
  };
  const projectIdOf = (rawName, bj) => {
    if (bj && projBySrc['job:' + bj]) { plan.linkedProjects++; return projBySrc['job:' + bj]; }
    const nb = baseName(rawName), nk = normName(nb);
    if (nk && projByName[nk]) { plan.linkedProjects++; return projByName[nk]; }
    const id = nextId('projects'); const srcKey = bj ? 'job:' + bj : 'name:' + nk;
    projBySrc[srcKey] = id; if (nk) projByName[nk] = id;
    docs.projects.push({ _id: id, name: nb || `Job ${bj}`, source_key: srcKey, created_by: 1, created_at: ts(), updated_at: ts() }); plan.newProjects++;
    return id;
  };
  const jobIdOf = (bj, projectId) => {
    if (jobByNum[bj.toLowerCase()]) return jobByNum[bj.toLowerCase()];
    const id = nextId('jobs'); jobByNum[bj.toLowerCase()] = id;
    docs.jobs.push({ _id: id, project_id: projectId, winning_bid_id: null, job_number: bj, awarded_company_id: null, pm_id: null, award_date: null, created_at: ts(), updated_at: ts() }); plan.newJobs++;
    return id;
  };

  // ── NEW bids ──
  for (const r of bidRows) {
    const bn = s(r['Bid #']) || s(r['Bid # or Job #']);
    if (!bn) { plan.skippedNoBidNum++; continue; }
    if (existingBidNums.has(bn.toUpperCase())) continue;   // already in v2 — leave it
    existingBidNums.add(bn.toUpperCase());                  // guard against dup rows in file
    const v1 = r.__stage, stage = V1_TO_V2[v1] || 'opportunity';
    const bj = baseJob(r['Job #']);
    const projectId = projectIdOf(r['Project Name'], bj);
    const custs = customersOf(r);
    const winner = s(r['Awarded Contractor']) ? companyIdOf(s(r['Awarded Contractor'])) : null;
    const amount = amt(r['Estimate Amount']), dateSent = xdate(r['Date Estimate Sent']), approvedBy = s(r['Estimate Approved By']);
    const awardedCompanyId = stage === 'awarded' ? (winner || companyIdOf(custs[0]) || null) : null;
    const bidId = nextId('bids');
    docs.bids.push({ _id: bidId, project_id: projectId, bid_number: bn, stage,
      estimator_id: lkp(r['Estimator']), salesperson_id: lkp(r['Salesperson']), sub_estimators: [],
      date_received: xdate(r['Date Received']), due_date: xdate(r['Estimate Due Date']), start_date: xdate(r['Estimate Start Date']),
      drawing_stage: null, jurisdiction: null, estimate_amount: amount, date_submitted: dateSent, approved_by: approvedBy,
      award_date: stage === 'awarded' ? xdate(r['Award Date']) : null, awarded_company_id: awardedCompanyId,
      next_followup_date: null, superseded: 0, notes: s(r['Notes']), created_at: ts(), updated_at: ts() });
    plan.newBids++;
    for (const c of custs) { const cid = companyIdOf(c); if (cid) docs.bidCustomers.push({ _id: nextId('bid_customers'), bid_id: bidId, company_id: cid, contact_ids: [] }); }
    let subOutcome = v1 === 'awarded' ? 'awarded' : v1 === 'follow_up' ? 'pending' : (v1 === 'closed' && amount && dateSent) ? 'not_awarded' : null;
    if (subOutcome) {
      const subCompany = subOutcome === 'awarded' ? awardedCompanyId : companyIdOf(custs[0]);
      if (subCompany) { docs.subs.push({ _id: nextId('bid_submissions'), bid_id: bidId, company_id: subCompany, amount, date_submitted: dateSent, approved_by: approvedBy, submission_type: 'initial', notes: null, is_current: 1, outcome: subOutcome, award_date: subOutcome === 'awarded' ? xdate(r['Award Date']) : null, date_not_awarded: subOutcome === 'not_awarded' ? xdate(r['Award Date']) : null, not_awarded_notes: null, next_followup_date: null, created_at: ts(), updated_at: ts() }); plan.newSubs++; }
    }
    if (stage === 'awarded' && bj) { const jid = jobIdOf(bj, projectId); const jd = docs.jobs.find(j => j._id === jid); if (jd && !jd.winning_bid_id) { jd.winning_bid_id = bidId; jd.awarded_company_id = awardedCompanyId; jd.award_date = xdate(r['Award Date']); } }
  }

  // ── NEW change orders ──
  for (const r of coRows) {
    const bj = baseJob(r['Job #']); if (!bj) { plan.skippedCoNoJob++; continue; }
    const coNum = coNumber(r);
    if (v2coKeys.has(bj + '|' + coNum)) continue;          // already in v2
    v2coKeys.add(bj + '|' + coNum);
    const projectId = projectIdOf(r['Project Name'], bj);
    const jid = jobIdOf(bj, projectId);
    const dateSent = xdate(r['Date Estimate Sent']), awardDate = xdate(r['Award Date']);
    docs.cos.push({ _id: nextId('change_orders'), job_id: jid, co_number: coNum, name: coDesc(r['Project Name'], baseName(r['Project Name'])),
      stage: awardDate ? 'approved' : dateSent ? 'submitted_co' : 'active_co', was_submitted: (dateSent || awardDate) ? 1 : 0,
      estimator_id: lkp(r['Estimator']), due_date: xdate(r['Estimate Due Date']), start_date: xdate(r['Estimate Start Date']),
      estimate_amount: amt(r['Estimate Amount']), date_submitted: dateSent, approved_by: s(r['Estimate Approved By']),
      approval_date: awardDate || null, notes: s(r['Notes']), next_followup_date: null, created_at: ts(), updated_at: ts() });
    plan.newCos++;
  }

  console.log('═══ PLAN (add-only — existing records untouched) ═══');
  console.log(`  New bids:            ${plan.newBids}`);
  console.log(`  New change orders:   ${plan.newCos}`);
  console.log(`  New submissions:     ${plan.newSubs}`);
  console.log(`  Projects: ${plan.newProjects} created, ${plan.linkedProjects} linked to existing`);
  console.log(`  New companies:       ${plan.newCompanies}`);
  console.log(`  New jobs:            ${plan.newJobs}`);
  console.log(`  Skipped: ${plan.skippedNoBidNum} bid rows w/o a bid #, ${plan.skippedCoNoJob} CO rows w/o a job #`);

  if (!APPLY) { console.log('\n[DRY RUN] nothing written. Re-run with --apply to add these.\n'); await conn.close(); process.exit(0); }

  if (docs.companies.length) await M.Company.insertMany(docs.companies);
  if (docs.projects.length) await M.Project.insertMany(docs.projects);
  if (docs.jobs.length) await M.Job.insertMany(docs.jobs);
  if (docs.bids.length) await M.Bid.insertMany(docs.bids);
  if (docs.bidCustomers.length) await M.BidCustomer.insertMany(docs.bidCustomers);
  if (docs.subs.length) await M.BidSubmission.insertMany(docs.subs);
  if (docs.cos.length) await M.ChangeOrder.insertMany(docs.cos);
  for (const name of Object.keys(counters)) await M.Counter.updateOne({ _id: name }, { $set: { seq: counters[name] } }, { upsert: true });

  console.log(`\n✅ Added ${plan.newBids} bids, ${plan.newCos} COs, ${plan.newSubs} submissions, ${plan.newProjects} projects, ${plan.newCompanies} companies, ${plan.newJobs} jobs. Existing data untouched.\n`);
  await conn.close();
}
main().catch(e => { console.error(e); process.exit(1); });
