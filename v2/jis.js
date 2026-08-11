/**
 * v2/jis.js — Import Bid from JIS (Job Information Sheet).
 *
 * Every new bid gets a JIS filled out by the estimating coordinator. Its
 * "Title Sheet" tab has a fixed cell layout (bid #, due date, drawing set,
 * job name/address, estimator/salesperson, and up to 6 GC/customer blocks
 * with company info + point of contact). This reads that tab, matches
 * against existing Projects/TeamMembers/Companies/Contacts, and returns a
 * PREVIEW for the user to confirm/correct before anything is written
 * (previewJISImport). applyJISImport then does the actual create-or-enrich.
 *
 * If the bid # already exists in v2 (common — bids are usually already in
 * the system from the Excel sync before the JIS is fully filled out), the
 * bid itself is left alone (stage/estimator/salesperson/due_date are NOT
 * touched — those are owned by the normal workflow) and only enriched:
 * project address, bid.drawings description, and any missing GC companies/
 * contacts get attached. If the bid # doesn't exist yet, a new bid is
 * created via the existing createDirectBid/startBid path.
 */
const XLSX = require('xlsx');
const { getModels } = require('./models');
const db = require('./db');
const { _norm, resolveCompanyByName, ensureBidCustomer, addBidCustomerContact, createDirectBid, nextId } = db;

const ts = () => new Date().toISOString().replace('T', ' ').substring(0, 19);
const s = (v) => { if (v == null) return null; const t = String(v).trim(); return t || null; };
const xdate = (v) => {
  if (v == null) return null;
  if (typeof v === 'string') { const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; }
  if (typeof v === 'number' && v > 1000) { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : null; }
  return null;
};
const looksLikePlaceholder = (v) => !v || /!!!.*!!!/.test(v);
function splitCityStateZip(v) {
  if (!v) return { city: null, state: null, zip: null };
  const m = String(v).match(/^(.*?),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/);
  if (m) return { city: m[1].trim(), state: m[2].toUpperCase(), zip: m[3] };
  return { city: v.trim(), state: null, zip: null };
}
function projMatchScore(qn, on) {
  if (!qn || !on) return null;
  if (on === qn) return 0;
  if (on.includes(qn) || qn.includes(on)) return 1;
  const words = qn.split(' ').filter(w => w.length >= 4);
  if (words.some(w => on.includes(w))) return 2;
  return null;
}

const GC_COLS = ['C', 'D', 'E', 'F', 'G', 'H'];

function parseTitleSheet(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets['Title Sheet'];
  if (!ws) throw new Error('No "Title Sheet" tab found in this file — is it a JIS?');
  const cell = (addr) => { const c = ws[addr]; return c ? c.v : null; };

  const bid_number = s(cell('C3'));
  const due_date = xdate(cell('C4'));
  const rawDrawings = s(cell('C5'));
  const drawings = looksLikePlaceholder(rawDrawings) ? null : rawDrawings;
  const job_name = s(cell('C7'));
  const street = s(cell('C8'));
  const { city, state, zip } = splitCityStateZip(s(cell('C9')));

  const estimator = { jis_name: s(cell('C14')), phone: s(cell('D14')), email: s(cell('E14')) };
  const salesperson = { jis_name: s(cell('C15')), phone: s(cell('D15')), email: s(cell('E15')) };

  const gcs = [];
  for (const col of GC_COLS) {
    const companyName = s(cell(col + '21'));
    if (!companyName) continue;
    const gcStreet = s(cell(col + '22'));
    const { city: gcCity, state: gcState, zip: gcZip } = splitCityStateZip(s(cell(col + '23')));
    const phone = s(cell(col + '24'));
    const domain = s(cell(col + '25'));
    const pocName = s(cell(col + '26'));
    const pocPhone = s(cell(col + '27'));
    const pocEmail = s(cell(col + '28'));
    gcs.push({
      jis_name: companyName, street: gcStreet, city: gcCity, state: gcState, zip: gcZip, phone, domain,
      poc: pocName ? { jis_name: pocName, phone: pocPhone, email: pocEmail } : null,
    });
  }

  return { bid_number, due_date, drawings, job_name, address: { street, city, state, zip }, estimator, salesperson, gcs };
}

async function previewJISImport(buffer) {
  const parsed = parseTitleSheet(buffer);
  const M = getModels();
  const [team, companies, projects, existingBid] = await Promise.all([
    M.TeamMember.find({ active: 1 }).lean(),
    M.Company.find().lean(),
    M.Project.find().lean(),
    parsed.bid_number ? M.Bid.findOne({ bid_number: parsed.bid_number }).lean() : null,
  ]);

  const matchTeam = (name) => { if (!name) return null; const n = _norm(name); const hit = team.find(t => _norm(t.name) === n); return hit ? { id: hit._id, name: hit.name } : null; };
  const matchCompany = (name) => { const n = _norm(name); const hit = companies.find(c => _norm(c.name) === n); return hit ? { id: hit._id, name: hit.name } : null; };

  const gcs = [];
  for (const gc of parsed.gcs) {
    const matched_company = matchCompany(gc.jis_name);
    let poc = null;
    if (gc.poc) {
      let matched_contact = null;
      if (matched_company) {
        const contactsAtCo = await M.Contact.find({ company_id: matched_company.id }).lean();
        const pn = _norm(gc.poc.jis_name);
        const hit = contactsAtCo.find(c => _norm([c.first_name, c.last_name].filter(Boolean).join(' ')) === pn);
        if (hit) matched_contact = { id: hit._id, name: [hit.first_name, hit.last_name].filter(Boolean).join(' ') };
      }
      poc = { ...gc.poc, matched_contact };
    }
    gcs.push({ jis_name: gc.jis_name, street: gc.street, city: gc.city, state: gc.state, zip: gc.zip, phone: gc.phone, domain: gc.domain, matched_company, poc });
  }

  let project_candidates = [];
  if (!existingBid && parsed.job_name) {
    const jn = _norm(parsed.job_name);
    project_candidates = projects
      .map(p => ({ id: p._id, name: p.name, score: projMatchScore(jn, _norm(p.name)) }))
      .filter(x => x.score !== null).sort((a, b) => a.score - b.score).slice(0, 5)
      .map(({ id, name }) => ({ id, name }));
  }

  return {
    bid_number: parsed.bid_number, due_date: parsed.due_date, drawings: parsed.drawings, job_name: parsed.job_name,
    address: parsed.address,
    existing_bid: existingBid ? { id: existingBid._id, project_id: existingBid.project_id, stage: existingBid.stage, bid_number: existingBid.bid_number } : null,
    project_candidates,
    estimator: { ...parsed.estimator, matched: matchTeam(parsed.estimator.jis_name) },
    salesperson: { ...parsed.salesperson, matched: matchTeam(parsed.salesperson.jis_name) },
    gcs,
  };
}

// gc: { company_id (existing, if user confirmed a match) OR jis_name/street/city/state/zip/phone/domain (to create new) }
async function resolveGCCompany(gc) {
  const M = getModels();
  if (gc.company_id) return Number(gc.company_id);
  const clean = String(gc.jis_name || '').trim();
  if (!clean) throw new Error('Every GC needs a company name');
  const id = await nextId('companies');
  await M.Company.create({
    _id: id, name: clean,
    street: gc.street || null, city: gc.city || null, state: gc.state || null, zip: gc.zip || null,
    phone: gc.phone || null, domain: gc.domain || null,
  });
  return id;
}
// poc: { contact_id (existing) OR jis_name/phone/email (to create new) }
async function resolveGCContact(poc, companyId) {
  const M = getModels();
  if (poc.contact_id) return Number(poc.contact_id);
  const [first, ...rest] = String(poc.jis_name || '').trim().split(/\s+/);
  const id = await nextId('contacts');
  await M.Contact.create({
    _id: id, company_id: companyId,
    first_name: first || null, last_name: rest.join(' ') || null,
    phone: poc.phone || null, email: poc.email || null, active: 1,
  });
  return id;
}

async function applyJISImport(payload) {
  const M = getModels();
  const { bid_number, due_date, drawings, address, existing_bid_id, target_bid_id, project_id, project_name, estimator_id, salesperson_id, gcs = [], actor_id } = payload;

  const resolvedGCs = [];
  for (const gc of gcs) resolvedGCs.push({ ...gc, companyId: await resolveGCCompany(gc) });

  let bidId, projectId;
  if (target_bid_id) {
    // "Start Bid" on an existing opportunity, pulling the fields from a JIS
    // instead of typing them by hand — goes through the normal startBid()
    // opportunity->active_bid transition, not createDirectBid (which would
    // create a brand-new bid and supersede this one).
    const bid = await M.Bid.findById(Number(target_bid_id)).lean();
    if (!bid) throw new Error('Bid not found');
    if (!bid_number) throw new Error('Bid # is required to start this bid');
    const started = await db.startBid(target_bid_id, {
      bid_number, due_date,
      estimator_id: estimator_id || null, salesperson_id: salesperson_id || null,
      date_received: ts().slice(0, 10),
      company_ids: resolvedGCs.map(g => g.companyId),
    }, actor_id || null);
    bidId = started.bid_id; projectId = bid.project_id;
    if (drawings) await M.Bid.updateOne({ _id: bidId }, { $set: { drawings, updated_at: ts() } });
  } else if (existing_bid_id) {
    const bid = await M.Bid.findById(Number(existing_bid_id)).lean();
    if (!bid) throw new Error('Bid not found');
    bidId = bid._id; projectId = bid.project_id;
    const enrichUpd = {};
    if (drawings) enrichUpd.drawings = drawings;
    // Fill-if-empty, not overwrite — a due date already set through the
    // normal workflow (Start Bid, Edit Bid, calendar drag) reflects real
    // human input and takes priority over the JIS's, but a bid that's never
    // had one set yet should pick it up here instead of staying blank.
    if (due_date && !bid.due_date) enrichUpd.due_date = due_date;
    if (Object.keys(enrichUpd).length) await M.Bid.updateOne({ _id: bidId }, { $set: { ...enrichUpd, updated_at: ts() } });
  } else {
    if (!bid_number) throw new Error('Bid # is required to create a new bid');
    if (!estimator_id || !salesperson_id) throw new Error('Estimator and salesperson are required to create a new bid');
    const created = await createDirectBid({
      project_id, project_name, bid_number,
      company_ids: resolvedGCs.map(g => g.companyId),
      estimator_id, salesperson_id,
      date_received: ts().slice(0, 10), due_date,
    });
    bidId = created.bid_id; projectId = created.project_id;
    if (drawings) await M.Bid.updateOne({ _id: bidId }, { $set: { drawings, updated_at: ts() } });
  }

  if (address && (address.street || address.city || address.state || address.zip)) {
    const upd = { updated_at: ts() };
    ['street', 'city', 'state', 'zip'].forEach(k => { if (address[k]) upd[k] = address[k]; });
    await M.Project.updateOne({ _id: projectId }, { $set: upd });
  }

  for (const gc of resolvedGCs) {
    await ensureBidCustomer(bidId, gc.companyId);
    if (gc.poc) {
      const contactId = await resolveGCContact(gc.poc, gc.companyId);
      const bc = await M.BidCustomer.findOne({ bid_id: bidId, company_id: gc.companyId }).lean();
      await addBidCustomerContact(bc._id, contactId);
    }
  }

  return { bid_id: bidId, project_id: projectId };
}

module.exports = { parseTitleSheet, previewJISImport, applyJISImport };
