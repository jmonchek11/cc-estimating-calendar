/**
 * v2/backfill-events.js — bootstrap/recovery tool for the liberty-core events outbox.
 *
 * Scans existing v2 data and ensures each derivable fact has a matching event in
 * liberty-core.events, without duplicating anything already emitted live. Run once
 * after the events-outbox deploy, and again any time emission is suspected to have
 * missed something (e.g. after a liberty-core outage).
 *
 * Usage:
 *   node v2/backfill-events.js --dry     (default-safe: prints counts + samples, writes nothing)
 *   node v2/backfill-events.js --write   (actually inserts missing events)
 *
 * Idempotent by natural key: before inserting, checks for an existing event of the
 * same `type` + entity id (job_id/co_id/bid_id). Never duplicates. Backfilled events
 * get payload.backfilled: true and actor_id: null (no real actor to attribute).
 *
 * See docs/EVENTS_OUTBOX_PLAN.md §4.
 */
require('dotenv').config();
const { getModels } = require('./models');
const events = require('./events');

const WRITE = process.argv.includes('--write');
const DRY = !WRITE;

const counts = {};
const samples = {};
function record(type, doc) {
  counts[type] = (counts[type] || 0) + 1;
  if (!samples[type]) samples[type] = doc;
}

async function alreadyEmitted(Event, type, key, value) {
  return !!(await Event.findOne({ type, [key]: value }).lean());
}

async function insertOrCount(Event, type, fields) {
  record(type, fields);
  if (WRITE) {
    await events.emit(type, { ...fields, actor_id: null, payload: { ...fields.payload, backfilled: true } });
  }
}

async function main() {
  const M = getModels();
  const Event = events.getModel();

  const [jobs, cos, projects, companies] = await Promise.all([
    M.Job.find().lean(),
    M.ChangeOrder.find().lean(),
    M.Project.find().lean(),
    M.Company.find().lean(),
  ]);
  const projectById = new Map(projects.map(p => [p._id, p]));
  const companyById = new Map(companies.map(c => [c._id, c]));
  const jobById = new Map(jobs.map(j => [j._id, j]));

  // ── Jobs → job.created (+ bid.awarded if from a winning bid) ────────────────
  for (const job of jobs) {
    const proj = projectById.get(job.project_id);
    if (!(await alreadyEmitted(Event, 'job.created', 'job_id', job._id))) {
      await insertOrCount(Event, 'job.created', {
        project_id: job.project_id, job_id: job._id, job_number: job.job_number || null,
        payload: {
          project_name: proj?.name || null,
          company_name: companyById.get(job.awarded_company_id)?.name || null,
          award_date: job.award_date || null,
          pm_id: job.pm_id || null,
          from_bid: !!job.winning_bid_id,
        },
      });
    }
    if (job.winning_bid_id && !(await alreadyEmitted(Event, 'bid.awarded', 'job_id', job._id))) {
      await insertOrCount(Event, 'bid.awarded', {
        project_id: job.project_id, bid_id: job.winning_bid_id, job_id: job._id,
        payload: {
          project_name: proj?.name || null,
          company_id: job.awarded_company_id || null,
          company_name: companyById.get(job.awarded_company_id)?.name || null,
          amount: null, award_date: job.award_date || null,
          pm_id: job.pm_id || null,
        },
      });
    }
    if (job.job_number && !(await alreadyEmitted(Event, 'job.number_assigned', 'job_id', job._id))) {
      await insertOrCount(Event, 'job.number_assigned', {
        project_id: job.project_id, job_id: job._id, job_number: job.job_number,
        payload: { project_name: proj?.name || null, job_number: job.job_number },
      });
    }
  }

  // ── Change Orders → co.created (+ terminal co.stage_changed) ────────────────
  const TERMINAL_STAGES = ['approved', 'not_approved', 'voided'];
  for (const co of cos) {
    const job = jobById.get(co.job_id);
    const proj = job ? projectById.get(job.project_id) : null;
    if (!(await alreadyEmitted(Event, 'co.created', 'co_id', co._id))) {
      await insertOrCount(Event, 'co.created', {
        project_id: job?.project_id || null, job_id: co.job_id, co_id: co._id,
        payload: { co_number: co.co_number, name: co.name, project_name: proj?.name || null, job_number: job?.job_number || null },
      });
    }
    if (TERMINAL_STAGES.includes(co.stage)) {
      const existing = await Event.findOne({ type: 'co.stage_changed', co_id: co._id, 'payload.to': co.stage }).lean();
      if (!existing) {
        await insertOrCount(Event, 'co.stage_changed', {
          project_id: job?.project_id || null, job_id: co.job_id, co_id: co._id,
          payload: {
            co_number: co.co_number, from: co.was_submitted ? 'submitted_co' : 'active_co', to: co.stage,
            amount: co.estimate_amount ?? null, project_name: proj?.name || null, job_number: job?.job_number || null,
          },
        });
      }
    }
  }

  console.log(`\n[backfill-events] ${DRY ? 'DRY RUN — nothing written' : 'WRITE MODE — events inserted'}`);
  console.log('Counts by type:');
  for (const [type, n] of Object.entries(counts)) console.log(`  ${type}: ${n}`);
  if (Object.keys(counts).length === 0) console.log('  (nothing to backfill — all derivable events already exist)');
  console.log('\nSample event per type:');
  for (const [type, doc] of Object.entries(samples)) console.log(`  ${type}:`, JSON.stringify(doc));
  process.exit(0);
}

main().catch(err => { console.error('[backfill-events] FAILED', err); process.exit(1); });
