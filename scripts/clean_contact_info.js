// scripts/clean_contact_info.js
// ----------------------------------------------------------------------------
// Cleans the two Bedrock homeowner xlsx exports before bulk import:
//   1. Homeowner Contact Information (3).xlsx  (3-tab: Address/Email/Phone)
//   2. Homeowner Export.xlsx                    (single sheet)
//
// Cleanup applied (offline, no DB access needed):
//   - Drop rows where HomeownerName is a placeholder (Current Resident /
//     Unknown / Occupant / etc.) — these never produce useful contact_methods
//   - Normalize address formatting: collapse internal whitespace, normalize
//     PO Box / P.O. Box / P O Box → "PO Box", normalize "BOX" → "Box"
//   - Drop rows with empty value fields (no email / no phone / no address)
//   - Drop rows with blank account IDs
//   - Flag corporate landlords (names containing LLC, Trust, Borrower, etc.
//     OR appearing in >5 rows) by writing a column "_landlord_flag" — Ed
//     reviews these manually before applying the diff
//   - Preserve original 3-tab / 1-sheet structure so the importer can ingest
//     the cleaned file with no code changes
//
// Outputs are written to the same Downloads folder with " - cleaned" suffix.
// ----------------------------------------------------------------------------

const XLSX = require('xlsx');
const path = require('path');

const PLACEHOLDER_NAMES = new Set([
  '', 'current resident', 'current owner', 'unknown', 'unknown owner',
  'occupant', 'owner', 'tenant', 'resident', 'n/a', 'na',
]);

const CORPORATE_KEYWORDS = [
  ' llc', ' l.l.c', ' lp', ' inc', ' corp', ' corporation', ' trust',
  ' borrower', ' properties', ' group', ' capital', ' holdings',
  ' investments', ' real estate', ' homes ', ' homes,', ' homes for rent',
  ' management', ' partners', ' equity', ' ventures', ' realty',
];

function isPlaceholderName(name) {
  const n = String(name || '').trim().toLowerCase();
  return PLACEHOLDER_NAMES.has(n);
}

function isCorporateName(name) {
  const n = ` ${String(name || '').toLowerCase()} `;
  return CORPORATE_KEYWORDS.some((kw) => n.includes(kw));
}

function normalizeAddress(addr) {
  if (!addr) return addr;
  return String(addr)
    .replace(/\s+/g, ' ')                     // collapse internal whitespace
    .replace(/\bP\.?\s*O\.?\s*BOX\b/gi, 'PO Box') // normalize PO Box variants
    .replace(/\bBOX\b/g, 'Box')                // normalize SCREAMING-CASE Box
    .trim();
}

function trimOrBlank(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

// ----------------------------------------------------------------------------
// Clean the 3-tab "Homeowner Contact Information" format
// ----------------------------------------------------------------------------
function cleanContactInfoFile(inputPath, outputPath) {
  const wb = XLSX.readFile(inputPath);
  const stats = {
    addresses: { in: 0, out: 0, dropped_placeholder: 0, dropped_blank: 0, normalized: 0 },
    emails: { in: 0, out: 0, dropped_placeholder: 0, dropped_blank: 0 },
    phones: { in: 0, out: 0, dropped_placeholder: 0, dropped_blank: 0 },
    landlord_flag_rows: 0,
  };

  // Build a name → count map across the Email sheet (most reliable per-contact
  // signal — every contact should have at least one email row)
  const nameCounts = new Map();
  const emailSheet = wb.Sheets['Email'];
  if (emailSheet) {
    const rows = XLSX.utils.sheet_to_json(emailSheet, { defval: '' });
    rows.forEach((r) => {
      const n = trimOrBlank(r['HomeOwnerName'] || r['HomeownerName']);
      if (!n) return;
      nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
    });
  }

  function isLikelyCorporate(name) {
    if (isCorporateName(name)) return true;
    return (nameCounts.get(name) || 0) > 5;
  }

  function cleanRow(r, valueField, accountField, nameField, kind) {
    const acct = trimOrBlank(r[accountField]);
    const name = trimOrBlank(r[nameField] || r['HomeownerName'] || r['HomeOwnerName']);
    const value = trimOrBlank(r[valueField]);
    if (!acct) { stats[kind].dropped_blank += 1; return null; }
    if (!value) { stats[kind].dropped_blank += 1; return null; }
    if (isPlaceholderName(name)) { stats[kind].dropped_placeholder += 1; return null; }
    const out = { ...r };
    out._landlord_flag = isLikelyCorporate(name) ? 'CORPORATE' : '';
    if (out._landlord_flag) stats.landlord_flag_rows += 1;
    return out;
  }

  // Address sheet
  if (wb.Sheets['Address']) {
    const inRows = XLSX.utils.sheet_to_json(wb.Sheets['Address'], { defval: '' });
    stats.addresses.in = inRows.length;
    const outRows = [];
    inRows.forEach((r) => {
      const acct = trimOrBlank(r['Account']);
      const name = trimOrBlank(r['HomeownerName'] || r['HomeOwnerName']);
      if (!acct) { stats.addresses.dropped_blank += 1; return; }
      if (isPlaceholderName(name)) { stats.addresses.dropped_placeholder += 1; return; }
      const cleaned = { ...r };
      const beforeAddr = `${r['Address1'] || ''} ${r['Address2'] || ''}`;
      cleaned['Address1'] = normalizeAddress(r['Address1']);
      cleaned['Address2'] = normalizeAddress(r['Address2']);
      const afterAddr = `${cleaned['Address1'] || ''} ${cleaned['Address2'] || ''}`;
      if (beforeAddr !== afterAddr) stats.addresses.normalized += 1;
      cleaned._landlord_flag = isLikelyCorporate(name) ? 'CORPORATE' : '';
      outRows.push(cleaned);
    });
    stats.addresses.out = outRows.length;
    const newWs = XLSX.utils.json_to_sheet(outRows);
    wb.Sheets['Address'] = newWs;
  }

  // Email sheet
  if (wb.Sheets['Email']) {
    const inRows = XLSX.utils.sheet_to_json(wb.Sheets['Email'], { defval: '' });
    stats.emails.in = inRows.length;
    const outRows = [];
    inRows.forEach((r) => {
      const cleaned = cleanRow(r, 'Email', 'Account', 'HomeOwnerName', 'emails');
      if (cleaned) outRows.push(cleaned);
    });
    stats.emails.out = outRows.length;
    wb.Sheets['Email'] = XLSX.utils.json_to_sheet(outRows);
  }

  // Phone sheet
  if (wb.Sheets['Phone']) {
    const inRows = XLSX.utils.sheet_to_json(wb.Sheets['Phone'], { defval: '' });
    stats.phones.in = inRows.length;
    const outRows = [];
    inRows.forEach((r) => {
      const cleaned = cleanRow(r, 'phone', 'Account', 'HomeOwnerName', 'phones');
      if (cleaned) outRows.push(cleaned);
    });
    stats.phones.out = outRows.length;
    wb.Sheets['Phone'] = XLSX.utils.json_to_sheet(outRows);
  }

  XLSX.writeFile(wb, outputPath);
  return stats;
}

// ----------------------------------------------------------------------------
// Clean the single-sheet "Homeowner Export" format
// ----------------------------------------------------------------------------
function cleanExportFile(inputPath, outputPath) {
  const wb = XLSX.readFile(inputPath);
  const sheetName = wb.SheetNames[0];
  const inRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
  const stats = {
    rows_in: inRows.length, rows_out: 0,
    dropped_placeholder: 0, dropped_blank: 0,
    normalized_addresses: 0, landlord_flag_rows: 0,
  };

  const nameCounts = new Map();
  inRows.forEach((r) => {
    const n = trimOrBlank(r['Homeowner']);
    if (n) nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
  });
  function isLikelyCorporate(name) {
    if (isCorporateName(name)) return true;
    return (nameCounts.get(name) || 0) > 5;
  }

  const outRows = [];
  inRows.forEach((r) => {
    const acct = trimOrBlank(r['Account #']);
    const name = trimOrBlank(r['Homeowner']);
    if (!acct) { stats.dropped_blank += 1; return; }
    if (isPlaceholderName(name)) { stats.dropped_placeholder += 1; return; }
    const cleaned = { ...r };
    const beforeAddr = trimOrBlank(r['Address']);
    cleaned['Address'] = normalizeAddress(r['Address']);
    if (beforeAddr !== trimOrBlank(cleaned['Address'])) stats.normalized_addresses += 1;
    cleaned._landlord_flag = isLikelyCorporate(name) ? 'CORPORATE' : '';
    if (cleaned._landlord_flag) stats.landlord_flag_rows += 1;
    outRows.push(cleaned);
  });
  stats.rows_out = outRows.length;
  wb.Sheets[sheetName] = XLSX.utils.json_to_sheet(outRows);
  XLSX.writeFile(wb, outputPath);
  return stats;
}

// ----------------------------------------------------------------------------
// Run
// ----------------------------------------------------------------------------
function fmt(stats) { return JSON.stringify(stats, null, 2); }

const downloads = 'C:/Users/edget/Downloads';

const contactInfoIn = path.join(downloads, 'Homeowner Contact Information (3).xlsx');
const contactInfoOut = path.join(downloads, 'Homeowner Contact Information (3) - cleaned.xlsx');
const exportIn = path.join(downloads, 'Homeowner Export.xlsx');
const exportOut = path.join(downloads, 'Homeowner Export - cleaned.xlsx');

console.log('=== Contact Information (3) ===');
console.log(fmt(cleanContactInfoFile(contactInfoIn, contactInfoOut)));
console.log('→ wrote', contactInfoOut);
console.log('');
console.log('=== Homeowner Export ===');
console.log(fmt(cleanExportFile(exportIn, exportOut)));
console.log('→ wrote', exportOut);
