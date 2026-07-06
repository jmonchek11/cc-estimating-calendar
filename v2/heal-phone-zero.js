/**
 * v2/heal-phone-zero.js — one-time data heal: Contact.phone stored as the
 * literal string "0" (Excel's blank Phone # cells import as the number 0,
 * not an empty cell — see v2/import.js phoneVal()) really means "no phone".
 * Clears it to null. Idempotent & safe to re-run.
 *
 *   node v2/heal-phone-zero.js          # report only (dry)
 *   node v2/heal-phone-zero.js --apply  # write the fix
 */
require('dotenv').config();
const { getConnection, getModels } = require('./models');
const APPLY = process.argv.includes('--apply');

(async () => {
  await getConnection().asPromise();
  const M = getModels();
  const bad = await M.Contact.find({ phone: '0' }).lean();
  console.log(`${APPLY ? 'Clearing' : 'Would clear'} phone="0" -> null on ${bad.length} contact(s).`);
  if (APPLY && bad.length) {
    await M.Contact.updateMany({ phone: '0' }, { $set: { phone: null } });
  }
  if (!APPLY) console.log('(dry run — re-run with --apply to write)');
  await getConnection().close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
