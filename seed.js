const XLSX = require('xlsx');
const path = require('path');
const db = require('./db');

const EXCEL_PATH = path.join(__dirname, '..', 'Estimating Calendar.xlsx');

function excelDateToISO(val) {
  if (!val) return null;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (s === 'tbd' || s === 'on hold' || s === '') return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (!isNaN(d)) return d.toISOString().split('T')[0];
    return null;
  }
  if (typeof val === 'number' && val > 1000) {
    const d = new Date((val - 25569) * 86400 * 1000);
    return d.toISOString().split('T')[0];
  }
  return null;
}

function cleanText(val) {
  if (!val) return null;
  const s = String(val).trim();
  return s === '' || s.toLowerCase() === 'n/a' ? null : s;
}

const SEED_TEAM = [
  { name: 'Jim O.', initials: 'JO', role: 'salesperson' },
  { name: 'Ray R.', initials: 'RR', role: 'salesperson' },
  { name: 'Damion C.', initials: 'DC', role: 'salesperson' },
  { name: 'Brian F.', initials: 'BF', role: 'salesperson' },
  { name: 'Fran T.', initials: 'FT', role: 'salesperson' },
  { name: 'Jake K.', initials: 'JK', role: 'salesperson' },
  { name: 'Jess B.', initials: 'JB', role: 'salesperson' },
  { name: 'Dillon D.', initials: 'DD', role: 'salesperson' },
  { name: 'PM', initials: 'PM', role: 'estimator' },
  { name: 'CW', initials: 'CW', role: 'estimator' },
  { name: 'JC', initials: 'JC', role: 'estimator' },
  { name: 'DP', initials: 'DP', role: 'estimator' },
  { name: 'SY', initials: 'SY', role: 'estimator' },
  { name: 'WB', initials: 'WB', role: 'estimator' },
  { name: 'JH', initials: 'JH', role: 'estimator' },
  { name: 'EE', initials: 'EE', role: 'estimator' },
  { name: 'DW', initials: 'DW', role: 'estimator' },
  { name: 'SP', initials: 'SP', role: 'estimator' },
];

const SHEET_STAGES = {
  'Opportunities': 'opportunity',
  'Active - Bids': 'active_bid',
  'Active - RFCs': 'active_co',
  'Follow Up': 'follow_up',
  'Awarded': 'awarded',
  '_Closed': 'closed',
  'Closed': 'closed',
};

function seed() {
  const existing = db.getBids();
  if (existing.length > 0) {
    console.log(`Database already has ${existing.length} bids. Delete data/estimating.db to re-seed.`);
    return;
  }

  const memberMap = {};
  for (const m of SEED_TEAM) {
    try {
      const created = db.createTeamMember(m);
      memberMap[m.initials] = created.id;
    } catch (e) {
      const existing = db.getTeam().find(t => t.initials === m.initials.toUpperCase());
      if (existing) memberMap[m.initials] = existing.id;
    }
  }
  console.log(`Created ${Object.keys(memberMap).length} team members`);

  let wb;
  try {
    wb = XLSX.readFile(EXCEL_PATH);
    console.log('Excel file loaded:', EXCEL_PATH);
  } catch (e) {
    console.error('Could not read Excel file:', e.message);
    console.log('Expected at:', EXCEL_PATH);
    console.log('\nYou can still use the app and add data manually.');
    return;
  }

  let total = 0;

  for (const [sheetName, stage] of Object.entries(SHEET_STAGES)) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;

    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    if (rows.length < 3) continue;

    // Always skip first 2 rows (both are header rows in all bid sheets)
    const dataStart = 2;

    let count = 0;
    for (let r = dataStart; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      const name = cleanText(row[4]); // Column E: Project Name
      if (!name) continue;
      if (['project name', 'bid # or job #', 'project'].includes(name.toLowerCase())) continue;

      const estInit = cleanText(row[11])?.toUpperCase();
      const salInit = cleanText(row[12])?.toUpperCase();

      const statusRaw = cleanText(row[28]) || cleanText(row[29]);
      const validStatuses = ['Open', 'Pending Award', 'Awarded', 'Not Awarded', 'Budget'];
      const status = validStatuses.find(s => statusRaw?.toLowerCase().includes(s.toLowerCase())) || 'Open';

      const bidData = {
        bid_number: cleanText(row[0]),
        job_number: cleanText(row[1]),
        stage,
        project_name: name,
        customer: cleanText(row[5]),
        customer2: cleanText(row[6]),
        customer3: cleanText(row[7]),
        customer4: cleanText(row[8]),
        customer5: cleanText(row[9]),
        notes: cleanText(row[10]),
        estimator_id: estInit && memberMap[estInit] ? memberMap[estInit] : null,
        salesperson_id: salInit && memberMap[salInit] ? memberMap[salInit] : null,
        date_received: excelDateToISO(row[2]),
        estimate_due_date: excelDateToISO(row[3]),
        estimate_start_date: excelDateToISO(row[15]),
        date_estimate_sent: excelDateToISO(row[16]) || excelDateToISO(row[17]),
        estimate_amount: row[18] ? parseFloat(row[18]) : null,
        estimate_pct_complete: row[14] ? Math.min(1, parseFloat(row[14])) : 0,
        estimate_approved_by: cleanText(row[19]),
        bid_result: cleanText(row[20]),
        status,
      };

      try {
        db.createBid(bidData);
        count++;
      } catch (e) {
        // skip invalid rows
      }
    }
    console.log(`  ${sheetName}: ${count} bids`);
    total += count;
  }

  console.log(`\nSeed complete! ${total} total bids imported.`);
  console.log('Start the app with: npm start');
}

seed();
