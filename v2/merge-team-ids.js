/**
 * v2/merge-team-ids.js — ONE-TIME migration: remap every TeamMember-id
 * reference in v2's collections from v2's own (independently-assigned) ids
 * to v1's real ids, as the first step of making v1's TeamMember collection
 * the single source of truth (login + roles) for both systems.
 *
 * Matches by normalized name (with one known spelling variant: v2 has
 * "Jonathon Chukinas", v1 has "Jonathan Chukinas" — same person).
 *
 * SAFE BY CONSTRUCTION: each document's current value is snapshotted via
 * `.find()` BEFORE any writes, then updated by its own _id with the
 * precomputed target value. This avoids the collision risk of updateMany-
 * by-old-value (several mappings have a value that is ALSO another key —
 * e.g. v2 id 8 -> v1 id 1, and v2 id 1 -> v1 id 19 — so a naive
 * value-matching pass run in the wrong order would corrupt data).
 *
 *   node v2/merge-team-ids.js          # report only (dry)
 *   node v2/merge-team-ids.js --apply  # write the fix
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { getConnection, getModels } = require('./models');
const APPLY = process.argv.includes('--apply');
const _norm = (v) => (v || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
const MANUAL_MATCH = { 'Jonathon Chukinas': 'Jonathan Chukinas' };

// [Model getter, field, isArrayField]
const TARGETS = [
  ['Project', 'created_by', false],
  ['Bid', 'estimator_id', false],
  ['Bid', 'salesperson_id', false],
  ['Bid', 'sub_estimators.estimator_id', true],
  ['Job', 'pm_id', false],
  ['ChangeOrder', 'estimator_id', false],
  ['Followup', 'contacted_by', false],
  ['Reminder', 'created_by', false],
];

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const V1Team = require('../models/TeamMember');
  const v1team = await V1Team.find().lean();

  const conn = getConnection(); await conn.asPromise();
  const M = getModels();
  const v2team = await M.TeamMember.find().lean();

  const idMap = {};
  for (const v2m of v2team) {
    const targetName = MANUAL_MATCH[v2m.name] || v2m.name;
    const v1m = v1team.find(t => _norm(t.name) === _norm(targetName));
    if (!v1m) { console.error(`ABORT: no v1 match for v2 team member "${v2m.name}" (id ${v2m._id})`); process.exit(1); }
    idMap[v2m._id] = v1m._id;
  }
  console.log('id map (v2 -> v1):', JSON.stringify(idMap));

  let totalDocs = 0;
  for (const [modelName, field, isArray] of TARGETS) {
    const Model = M[modelName];
    if (!isArray) {
      const docs = await Model.find({ [field]: { $in: Object.keys(idMap).map(Number) } }).select(`_id ${field}`).lean();
      console.log(`${modelName}.${field}: ${docs.length} doc(s)`);
      totalDocs += docs.length;
      if (APPLY && docs.length) {
        const ops = docs.map(d => ({ updateOne: { filter: { _id: d._id }, update: { $set: { [field]: idMap[d[field]] } } } }));
        await Model.bulkWrite(ops);
      }
    } else {
      // sub_estimators.estimator_id — array of subdocs
      const [arrField, subField] = field.split('.');
      const docs = await Model.find({ [`${arrField}.${subField}`]: { $in: Object.keys(idMap).map(Number) } }).select(`_id ${arrField}`).lean();
      console.log(`${modelName}.${field}: ${docs.length} doc(s) w/ matching array entries`);
      totalDocs += docs.length;
      if (APPLY && docs.length) {
        const ops = docs.map(d => ({
          updateOne: {
            filter: { _id: d._id },
            update: { $set: { [arrField]: (d[arrField] || []).map(se => ({ ...se, [subField]: idMap[se[subField]] ?? se[subField] })) } },
          },
        }));
        await Model.bulkWrite(ops);
      }
    }
  }
  console.log(`${APPLY ? 'Remapped' : 'Would remap'} ${totalDocs} document(s) across ${TARGETS.length} field(s).`);
  if (!APPLY) console.log('(dry run — re-run with --apply to write)');

  await conn.close(); await mongoose.disconnect(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
