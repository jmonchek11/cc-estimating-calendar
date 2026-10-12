/**
 * v2/import-permit-log.js — one-time backfill of Pat McCreesh's "Electrical
 * Permit Status Log" (Sheet1) into Permit records.
 *
 *   node v2/import-permit-log.js "<path to .xlsx>"            # dry run (default)
 *   node v2/import-permit-log.js "<path to .xlsx>" --write    # actually insert
 *
 * Idempotent: a row is skipped if a Permit with the same job # + permit # +
 * filed date (source 'import') already exists, so a re-run only adds new rows.
 * Matches each row to a Job by job number (log "181-001-I0" -> app "181001"),
 * and for matched jobs fills the job-level permit qualifier (needs_permit,
 * rough-in, expedited, F/A drawings) ONLY where it is still blank.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const { getModels } = require('./models');
const { permitJobNumber } = require('./db');

const file = process.argv[2];
const WRITE = process.argv.includes('--write');
if (!file) { console.error('Usage: node v2/import-permit-log.js <xlsx> [--write]'); process.exit(1); }

const clean = v => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; };
const bool = v => { const s = clean(v); if (!s) return null; if (/^y/i.test(s)) return true; if (/^n/i.test(s)) return false; return null; };
function isoDate(v) {
  const s = clean(v); if (!s) return null;
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!m) return null;
  let [, mo, d, y] = m; y = y.length === 2 ? '20' + y : y;
  const dt = new Date(`${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T12:00:00`);
  if (isNaN(dt) || +y < 2000 || +y > 2100) return null;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}
const todayStr = new Date().toISOString().slice(0, 10);
const ago = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

function toPermit(r) {
  const jobRaw = clean(r[0]), name = clean(r[1]), permitNo = clean(r[2]);
  const filed = isoDate(r[3]), picked = isoDate(r[9]);
  const posted = bool(r[10]);
  const notesParts = [clean(r[14])];
  // A date cell that held something else (the log has a few shifted/typed-
  // over rows) is kept as text in notes rather than silently dropped.
  if (clean(r[3]) && !filed) notesParts.push(`[Filed (as written): ${clean(r[3])}]`);
  if (clean(r[9]) && !picked) notesParts.push(`[Picked up (as written): ${clean(r[9])}]`);
  const notes = notesParts.filter(Boolean).join(' ') || null;
  const approved = bool(r[8]);
  const uwFinal = clean(r[13]), uwRough = clean(r[12]);
  let status;
  if (picked) status = (posted === true || uwFinal || (filed && filed < ago(180))) ? 'closed' : 'picked_up';
  else if (/withdraw/i.test(`${notes || ''} ${clean(r[11]) || ''}`)) status = 'withdrawn';
  else if (approved === true) status = 'approved';
  else if (/correction/i.test(notes || '')) status = 'corrections';
  else if (filed || permitNo) status = 'filed';
  else status = 'not_filed';
  // Filed over a year ago with no pickup ever recorded: almost certainly just
  // never updated in the log, so it is brought in closed (flagged in notes)
  // rather than cluttering the active list with years-old "filed" permits.
  let finalNotes = notes;
  if (['filed', 'corrections', 'approved'].includes(status) && filed && filed < ago(365)) {
    status = 'closed';
    finalNotes = [notes, '[Imported as closed — filed over a year ago with no pickup recorded in the log]'].filter(Boolean).join(' ');
  }
  return {
    job_number_raw: jobRaw, job_name: name, permit_number: permitNo, status, date_filed: filed,
    rough_in_required: bool(r[4]), expedited: bool(r[5]), fa_required: bool(r[6]), fa_submitted: bool(r[7]),
    approved_for_pickup: approved, date_picked_up: picked, posted_filed: posted,
    underwriter_po: clean(r[11]), uw_rough_in: uwRough, uw_final: uwFinal, notes: finalNotes,
  };
}

(async () => {
  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(file).Sheets['Sheet1'], { header: 1, defval: '', raw: false })
    .slice(2).filter(r => clean(r[0]) || clean(r[1]));
  await mongoose.connect(process.env.MONGODB_URI);
  const M = getModels();
  const [jobs, existing] = await Promise.all([M.Job.find().lean(), M.Permit.find({ source: 'import' }).lean()]);
  const jobByNum = {}; jobs.forEach(j => { if (j.job_number) jobByNum[String(j.job_number).trim()] = j; });
  const keyOf = p => [p.job_number_raw, p.permit_number, p.date_filed, p.job_name].map(x => x || '').join('|');
  const seen = new Set(existing.map(keyOf));

  const counts = { rows: rows.length, inserted: 0, skippedExisting: 0, matchedJob: 0, jobsQualified: 0 };
  const byStatus = {};
  const lastForJob = {};
  const { Counter } = M;
  let nextSeq = null;
  const toInsert = [];
  for (const r of rows) {
    const p = toPermit(r);
    if (seen.has(keyOf(p))) { counts.skippedExisting++; continue; }
    seen.add(keyOf(p));
    const job = jobByNum[permitJobNumber(p.job_number_raw)];
    if (job) { p.job_id = job._id; counts.matchedJob++; if (!lastForJob[job._id] || (p.date_filed || '') >= (lastForJob[job._id].date_filed || '')) lastForJob[job._id] = p; }
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    toInsert.push(p);
  }
  if (WRITE && toInsert.length) {
    // One counter bump for the whole batch (same idea as nextIdBlock in db.js).
    const doc = await Counter.findByIdAndUpdate('permits', { $inc: { seq: toInsert.length } }, { new: true, upsert: true });
    nextSeq = doc.seq - toInsert.length + 1;
    await M.Permit.insertMany(toInsert.map((p, i) => ({ _id: nextSeq + i, ...p, source: 'import', created_at: new Date().toISOString().replace('T', ' ').slice(0, 19), updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19) })));
    counts.inserted = toInsert.length;
    for (const [jid, p] of Object.entries(lastForJob)) {
      const j = jobs.find(x => String(x._id) === jid);
      const set = {};
      if (j.needs_permit == null) set.needs_permit = true;
      if (j.needs_rough_in_permit == null && p.rough_in_required != null) set.needs_rough_in_permit = p.rough_in_required;
      if (j.needs_accelerated_permit == null && p.expedited != null) set.needs_accelerated_permit = p.expedited;
      if (j.needs_fire_alarm_drawings == null && p.fa_required != null) set.needs_fire_alarm_drawings = p.fa_required;
      if (Object.keys(set).length) { await M.Job.updateOne({ _id: j._id }, { $set: set }); counts.jobsQualified++; }
    }
  }
  console.log(WRITE ? 'WROTE' : 'DRY RUN', JSON.stringify(counts), 'wouldInsert', toInsert.length);
  console.log('status breakdown', JSON.stringify(byStatus));
  console.log('matched jobs', Object.keys(lastForJob).length);
  await mongoose.disconnect();
  process.exit(0);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
