const XLSX = require('xlsx');

const EXCEL_PATH = "C:\\Users\\jmonchek\\OneDrive - libertyintegrated.com\\Desktop\\CC Estimating Calendar\\Estimating Calendar 05-01-26.xlsx";

let wb;
try {
  wb = XLSX.readFile(EXCEL_PATH);
} catch (e) {
  console.error('Could not read file:', e.message);
  process.exit(1);
}

console.log('Sheets found:', wb.SheetNames.join(', '));
console.log('');

const ws = wb.Sheets['Active - Bids'];
if (!ws) { console.log('ERROR: No "Active - Bids" sheet found!'); process.exit(); }

const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
console.log('Total rows in Active - Bids:', rows.length);
console.log('');
console.log('Header row 0:', JSON.stringify(rows[0]));
console.log('Header row 1:', JSON.stringify(rows[1]));
console.log('');
console.log('--- Last 15 data rows (col0=bid#, col4=project name) ---');
for (let i = Math.max(2, rows.length - 15); i < rows.length; i++) {
  const r = rows[i];
  if (!r) continue;
  console.log(`Row ${i}: bid#="${r[0]}" | name="${r[4]}" | customer="${r[5]}"`);
}
