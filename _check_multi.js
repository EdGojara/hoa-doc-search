const xlsx = require('xlsx');
const vantacaPath = 'C:\\Users\\edget\\Downloads\\Homeowner Contact Information (5).xlsx';

const norm = (s) => String(s == null ? '' : s).trim();
const upper = (s) => norm(s).toUpperCase();

const wb = xlsx.readFile(vantacaPath);
const rows = xlsx.utils.sheet_to_json(wb.Sheets['Address'], { defval: '', raw: false });

// Build map of account → primary mailing
const vMap = new Map();
for (const r of rows) {
  if (norm(r['Primary Mailing']).toLowerCase() !== 'yes') continue;
  const acct = norm(r['Account']);
  const street = [norm(r['Street No']), norm(r['Address1']), norm(r['Address2'])].filter(Boolean).join(' ').trim();
  const unit = norm(r['Unit No']);
  const fullStreet = unit ? `${street} ${unit}` : street;
  vMap.set(acct, {
    name: norm(r['HomeownerName']),
    street: fullStreet,
    city: norm(r['City']),
    state: upper(r['State/Province']),
    zip: norm(r['Zip']),
  });
}

// The 18 multi-property accounts + 4 corporate
const multiAccounts = [
  // Pattern B humans (the 9 we just analyzed)
  ['Dale & Roberta Smith',        '10110798', '19807 Moss Bark Trail',     '19807 Moss Bark Trail', 'Richmond', 'TX', '77407'],
  ['Dale & Roberta Smith',        '10110333', '20115 Buckeye Pass',        '19807 Moss Bark Trail', 'Richmond', 'TX', '77407'],
  ['Drona Gautam',                '10111180', '19311 Stable Meadow Drive', '19311 Stable Meadow Drive', 'Richmond', 'TX', '77407'],
  ['Drona Gautam',                '10110688', '5626 Jay Thrush Drive',     '19311 Stable Meadow Drive', 'Richmond', 'TX', '77407'],
  ['Elmer & Marjorie Garcia',     '10110758', '19714 Lily Pad Lane',       '19714 Lily Pad Lane', 'Richmond', 'TX', '77407'],
  ['Elmer & Marjorie Garcia',     '10110452', '5319 Elderberry Arbor',     '19714 Lily Pad Lane', 'Richmond', 'TX', '77407'],
  ['Erika Helms',                 '10110933', '5422 Persimmon Pass',       '5622 Jay Thrush Drive', 'Richmond', 'TX', '77407'],
  ['Erika Helms',                 '10110674', '5622 Jay Thrush Drive',     '5622 Jay Thrush Drive', 'Richmond', 'TX', '77407'],
  ['Luis Aguilar',                '10111116', '19819 Treemont Fair Drive', '5903 Water Violet Lane', 'Richmond', 'TX', '77407'],
  ['Luis Aguilar',                '10111269', '5903 Water Violet Lane',    '5903 Water Violet Lane', 'Richmond', 'TX', '77407'],
  ['Ngum-Aza & Awah Teh',         '10110986', '5507 Persimmon Pass',       '5519 Persimmon Pass', 'Richmond', 'TX', '77407'],
  ['Ngum-Aza & Awah Teh',         '10111020', '5519 Persimmon Pass',       '5519 Persimmon Pass', 'Richmond', 'TX', '77407'],
  ['Syed Rizvi',                  '10110791', '19806 Moss Bark Trail',     '5327 Elderberry Arbor', 'Richmond', 'TX', '77407'],
  ['Syed Rizvi',                  '10110395', '5327 Elderberry Arbor',     '5327 Elderberry Arbor', 'Richmond', 'TX', '77407'],
  ['William Leason',              '10111085', '19814 Treemont Fair Court', '5522 Baldwin Elm Street', 'Richmond', 'TX', '77407'],
  ['William Leason',              '10110155', '5522 Baldwin Elm Street',   '5522 Baldwin Elm Street', 'Richmond', 'TX', '77407'],
  ['Wuthy Chin',                  '10110443', '5315 Elderberry Arbor',     '5315 Elderberry Arbor', 'Richmond', 'TX', '77407'],
  ['Wuthy Chin',                  '10110458', '5322 Elderberry Arbor',     '5315 Elderberry Arbor', 'Richmond', 'TX', '77407'],
];

console.log('| Owner | Property (account) | trustEd mails to | Vantaca Primary | Match? |');
console.log('|---|---|---|---|---|');

let mismatchCount = 0;
for (const [owner, acct, prop, tStreet, tCity, tState, tZip] of multiAccounts) {
  const v = vMap.get(acct);
  if (!v) {
    console.log(`| ${owner} | ${prop} (${acct}) | ${tStreet} | NOT FOUND in Vantaca | ⚠️ |`);
    continue;
  }
  const tBlob = `${tStreet}|${tCity}|${tState}|${tZip}`.toLowerCase().replace(/\s+/g, ' ');
  const vBlob = `${v.street}|${v.city}|${v.state}|${v.zip}`.toLowerCase().replace(/\s+/g, ' ');
  const matches = tBlob === vBlob;
  if (!matches) mismatchCount++;
  console.log(`| ${owner} | ${prop} (${acct}) | ${tStreet}, ${tCity} ${tZip} | ${v.street}, ${v.city} ${v.state} ${v.zip} | ${matches ? '✓' : '✗ DIFFER'} |`);
}
console.log(`\nMismatches: ${mismatchCount}`);
