/**
 * v2/bulkAddressImport.js — one-time retroactive backfill for job addresses
 * that predate the JIS import's address capture (see v2/jis.js). Admin
 * compiles a spreadsheet (Project Name and/or Bid #, plus Street/City/
 * State/Zip) and this matches each row to an existing Project the same way
 * jis.js matches a JIS's job name — exact/fuzzy name match, or an exact
 * Bid # match when given (preferred, since it's unambiguous). Same
 * preview-then-apply shape as the JIS importer: nothing is written until
 * the admin reviews and confirms matches (and can correct a wrong/missing
 * one) in previewBulkAddressImport's result.
 */
const XLSX = require('xlsx');
const { getModels } = require('./models');
const { _norm } = require('./db');
const { projMatchScore } = require('./jis');

const normHeader = (h) => String(h || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const HEADER_ALIASES = {
  project_name: ['projectname', 'project', 'projecttitle', 'name', 'jobname'],
  bid_number: ['bid', 'bidnumber', 'bidno', 'bid#'],
  street: ['street', 'address', 'streetaddress', 'jobaddress'],
  city: ['city'],
  state: ['state'],
  zip: ['zip', 'zipcode', 'postalcode'],
};
function mapHeaders(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    const n = normHeader(h);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(n)) { map[i] = field; break; }
    }
  });
  return map;
}

async function previewBulkAddressImport(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  if (!rows.length) throw new Error('That spreadsheet looks empty');
  const headerMap = mapHeaders(rows[0]);
  const fields = Object.values(headerMap);
  if (!fields.includes('project_name') && !fields.includes('bid_number')) {
    throw new Error('Could not find a "Project Name" or "Bid #" column in the header row — check spelling/column names');
  }
  const get = (row, field) => {
    const idx = Object.keys(headerMap).find(i => headerMap[i] === field);
    return idx != null ? String(row[idx] ?? '').trim() : '';
  };

  const M = getModels();
  const [bids, projects] = await Promise.all([M.Bid.find().lean(), M.Project.find().lean()]);
  const bidByNumber = {};
  bids.forEach(b => { if (b.bid_number) bidByNumber[_norm(b.bid_number)] = b; });

  const results = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const project_name = get(row, 'project_name');
    const bid_number = get(row, 'bid_number');
    const street = get(row, 'street'), city = get(row, 'city'), state = get(row, 'state'), zip = get(row, 'zip');
    if (!project_name && !bid_number) continue; // blank row
    if (!street && !city && !state && !zip) continue; // nothing to backfill for this row

    let matched = null, matchType = null;
    if (bid_number) {
      const bid = bidByNumber[_norm(bid_number)];
      if (bid) { matched = projects.find(p => p._id === bid.project_id) || null; matchType = matched ? 'bid_number' : null; }
    }
    if (!matched && project_name) {
      const qn = _norm(project_name);
      const scored = projects
        .map(p => ({ p, score: projMatchScore(qn, _norm(p.name)) }))
        .filter(x => x.score !== null).sort((a, b) => a.score - b.score);
      if (scored.length) { matched = scored[0].p; matchType = scored[0].score === 0 ? 'name_exact' : 'name_fuzzy'; }
    }

    results.push({
      row: r + 1, input_project_name: project_name || null, input_bid_number: bid_number || null,
      street: street || null, city: city || null, state: state || null, zip: zip || null,
      matched_project_id: matched ? matched._id : null, matched_project_name: matched ? matched.name : null, match_type: matchType,
      current_address: matched ? { street: matched.street || null, city: matched.city || null, state: matched.state || null, zip: matched.zip || null } : null,
    });
  }
  return results;
}

// rows: [{ project_id, street, city, state, zip }] — only rows the admin
// confirmed (has a project_id) after reviewing the preview get written.
// Fills whichever fields are given; leaves the rest of the Project alone.
async function applyBulkAddressImport(rows) {
  const M = getModels();
  let applied = 0;
  for (const r of (rows || [])) {
    if (!r.project_id) continue;
    const upd = {};
    if (r.street) upd.street = r.street;
    if (r.city) upd.city = r.city;
    if (r.state) upd.state = r.state;
    if (r.zip) upd.zip = r.zip;
    if (!Object.keys(upd).length) continue;
    await M.Project.updateOne({ _id: Number(r.project_id) }, { $set: upd });
    applied++;
  }
  return { applied };
}

module.exports = { previewBulkAddressImport, applyBulkAddressImport };
