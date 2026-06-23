/**
 * v2/heal-current.js — one-time data heal: enforce exactly ONE current
 * submission per (bid, customer). Older versions become superseded
 * (is_current=0) with their follow-up timer cleared. Idempotent & safe to
 * re-run. Use after spotting bids with multiple "current" submissions.
 *
 *   node v2/heal-current.js          # report only (dry)
 *   node v2/heal-current.js --apply  # write the fix
 */
require('dotenv').config();
const db = require('./db');
const { getConnection, getModels } = require('./models');
const APPLY = process.argv.includes('--apply');

(async () => {
  await getConnection().asPromise();
  const M = getModels();
  const bids = await M.Bid.find().select('_id').lean();
  let subsFixed = 0, bidsFixed = 0;
  for (const b of bids) {
    const subs = await M.BidSubmission.find({ bid_id: b._id }).lean();
    if (subs.length < 2) continue;
    const byCo = {};
    subs.forEach(s => (byCo[s.company_id] = byCo[s.company_id] || []).push(s));
    let changed = false;
    for (const co of Object.keys(byCo)) {
      const grp = byCo[co].sort((a, c) => c._id - a._id);   // newest (highest id) first = the current offer
      for (let i = 0; i < grp.length; i++) {
        const want = i === 0 ? 1 : 0;
        if ((grp[i].is_current ? 1 : 0) !== want) {
          changed = true; subsFixed++;
          if (APPLY) await M.BidSubmission.updateOne({ _id: grp[i]._id }, { $set: want ? { is_current: 1 } : { is_current: 0, next_followup_date: null } });
        }
      }
    }
    if (changed) { bidsFixed++; if (APPLY) { await db.recomputeBidHeadline(b._id); await db.recomputeBidFollowup(b._id); } }
  }
  console.log(`${APPLY ? 'Healed' : 'Would heal'} ${subsFixed} submission(s) across ${bidsFixed} bid(s).`);
  if (!APPLY) console.log('(dry run — re-run with --apply to write)');
  await getConnection().close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
