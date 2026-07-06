/**
 * v2/import-contacts-from-v1.js — one-time fix: v2's Contact collection was
 * originally seeded from Excel's per-salesperson tabs (Jim/Ray/Dame/...), a
 * sparse, informal list (146 contacts, ~18 with a phone). The REAL contact
 * directory lives in v1's production Contact collection (665 contacts, 610
 * with phone, 646 with email) — actively maintained by the team, entirely
 * separate from v2's isolated test database. This script replaces v2's
 * Contact collection with a proper import from v1, mapping each contact's
 * free-text `company` string to a real v2 Company entity (find-or-create by
 * normalized name, same rule as the company picker).
 *
 * Safe to run: as of this writing zero BidCustomer rows in v2 have any
 * linked contact_ids, so nothing references the old contact ids.
 *
 *   node v2/import-contacts-from-v1.js          # report only (dry)
 *   node v2/import-contacts-from-v1.js --apply  # write the fix
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { getConnection, getModels } = require('./models');
const APPLY = process.argv.includes('--apply');
const ts = () => new Date().toISOString().replace('T', ' ').substring(0, 19);
const _norm = (v) => (v || '').toString().toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const V1Contact = require('../models/Contact');
  const v1Contacts = await V1Contact.find({ is_deleted: 0 }).lean();

  const conn = getConnection(); await conn.asPromise();
  const M = getModels();
  const linkedCount = await M.BidCustomer.countDocuments({ contact_ids: { $exists: true, $not: { $size: 0 } } });
  if (linkedCount > 0) {
    console.error(`ABORT: ${linkedCount} BidCustomer row(s) already have linked contacts — replacing Contact ids would break those links. Resolve manually first.`);
    process.exit(1);
  }

  const existingCompanies = await M.Company.find().lean();
  const companyByKey = {}; existingCompanies.forEach(c => companyByKey[_norm(c.name)] = c._id);
  let nextCompanyId = Math.max(0, ...existingCompanies.map(c => c._id)) + 1;
  const newCompanies = [];

  const withPhone = v1Contacts.filter(c => c.phone && c.phone !== '0').length;
  const withEmail = v1Contacts.filter(c => c.email).length;
  const withCompany = v1Contacts.filter(c => c.company).length;

  let nextContactId = 1;
  const contactDocs = v1Contacts.map(c => {
    let companyId = null;
    if (c.company) {
      const key = _norm(c.company);
      if (key) {
        if (!companyByKey[key]) { companyByKey[key] = nextCompanyId; newCompanies.push({ _id: nextCompanyId, name: c.company.trim(), created_at: ts(), updated_at: ts() }); nextCompanyId++; }
        companyId = companyByKey[key];
      }
    }
    return {
      _id: nextContactId++, company_id: companyId,
      first_name: c.first_name || null, last_name: c.last_name || null,
      phone: (c.phone && c.phone !== '0') ? c.phone : null,
      email: c.email || null, notes: c.notes || null,
      active: 1, created_at: ts(), updated_at: ts(),
    };
  });
  const noCompanyCount = contactDocs.filter(c => !c.company_id).length;

  console.log(`${APPLY ? 'Importing' : 'Would import'} ${contactDocs.length} contacts from v1 (of ${v1Contacts.length} total: ${withPhone} w/ phone, ${withEmail} w/ email, ${withCompany} w/ a company string).`);
  console.log(`  New Company records to create: ${newCompanies.length}`);
  console.log(`  Contacts with no resolvable company: ${noCompanyCount}`);

  if (APPLY) {
    if (newCompanies.length) await M.Company.insertMany(newCompanies);
    await M.Contact.deleteMany({});
    await M.Contact.insertMany(contactDocs);
    await M.Counter.findByIdAndUpdate('contacts', { $set: { seq: contactDocs.length } }, { upsert: true });
    await M.Counter.findByIdAndUpdate('companies', { $set: { seq: nextCompanyId - 1 } }, { upsert: true });
    console.log(`✅ Replaced v2 Contact collection: ${contactDocs.length} contacts, ${existingCompanies.length + newCompanies.length} total companies.`);
  } else {
    console.log('(dry run — re-run with --apply to write)');
  }
  await conn.close(); await mongoose.disconnect(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
