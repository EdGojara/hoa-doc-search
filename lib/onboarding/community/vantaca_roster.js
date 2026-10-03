// ============================================================================
// lib/onboarding/community/vantaca_roster.js  (Issue #15) — Vantaca community-data reader
// ----------------------------------------------------------------------------
// Reads the Vantaca owner / address / contact exports EXACTLY as exported (xlsx)
// into source records with provenance (file sha256, sheet, row). Pure: bytes in,
// records out; no database, no identity decisions (resolve.js does those).
//
// What each export is, by the name Vantaca gives it:
//   "All Addresses Export" / "All Addresses (Current Resident) Export"
//      one row per MAILING ENTRY of a homeowner record (Account + Homeowner ID);
//      the "(Current Resident)" variant adds placeholder rows addressed to the
//      property ("Current Resident") that are NOT people.
//   "Homeowner Contact Information"  (sheets Address / Email / Phone, keyed by Account)
//      Address: Address Type Property | Mailing, Label, Primary Mailing.
//      Email / Phone: per ACCOUNT (not per person); the row's name is provenance only.
//   "Ownership Transfer Report"  previous owner / new owner / settlement dates (PDF;
//      read by vantaca_transfers.js; bounded by the period it states).
//   "Homeowner Rent Export"  RECURRING CHARGES billed to owners (charge, start /
//      end, amount, rent frequency, auto-renewal). It names no tenant: it is never
//      tenant evidence, and an empty one proves only "no recurring charges".
// ============================================================================
const crypto = require('crypto');

const PROVIDER = 'vantaca';
const PLACEHOLDER = /^\s*(current\s+resident|resident|occupant|current\s+occupant|homeowner)\s*$/i;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const s = (v) => String(v == null ? '' : v).trim();

// The community-data package, by Vantaca report name (one list; the inventory reads it).
const COMMUNITY_PACKAGE = Object.freeze([
  { kind: 'roster', report: 'All Addresses Export', alt: ['All Addresses (Current Resident) Export'], proves: ['current owner records (Homeowner ID per account)', 'owner names, spouse / co-owner names, business names', 'owner mailing addresses'], required: true },
  { kind: 'contacts', report: 'Homeowner Contact Information', proves: ['property address per account', 'mailing addresses with the primary one marked', 'emails and phones per account'], required: true },
  { kind: 'transfers', report: 'Ownership Transfer Report', proves: ['ownership start dates for owners who bought in the report period', 'prior owners'], required: false, why_missing: 'without it an ownership has no proven start date (kept as "owner as of the export date") and no prior owner is recorded' },
  { kind: 'tenants', report: 'tenant / renter / lease records (Vantaca report name to be confirmed; the "Homeowner Rent Export" is recurring charges, not tenants)', proves: ['tenants and occupants', 'leases'], required: false, why_missing: 'without it no tenant or occupant is recorded; occupancy stays "not established" (never owner-occupied by default)' },
]);

function detectSheet(name, rows) {
  const h = new Set(Object.keys(rows[0] || {}));
  if (h.has('Homeowner ID') && h.has('HomeownerName') && h.has('MailAddress1')) return 'roster';
  if (h.has('Address Type') && h.has('Primary Mailing')) return 'contact_address';
  if (h.has('Email') && h.has('Account')) return 'contact_email';
  if ((h.has('phone') || h.has('Phone')) && h.has('Account')) return 'contact_phone';
  if (h.has('Charge Description') && h.has('Rent Frequency')) return 'recurring_charges';
  return null;
}

// Read one exported workbook. `XLSX` is the sheetjs module (injected so this file stays pure).
function readWorkbook(XLSX, buffer, filename) {
  const file = { filename, sha256: sha(buffer) };
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const out = { file, roster: [], contact_address: [], contact_email: [], contact_phone: [], recurring_charges: [], recurring_charge_sheets: [], unrecognized_sheets: [] };
  for (const sheet of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: '' });
    // a header-only export has no data rows: recognize it by its header row
    const header = (XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1 })[0] || []).map((x) => String(x).trim());
    const kind = detectSheet(sheet, rows.length ? rows : [Object.fromEntries(header.map((x) => [x, '']))]);
    if (kind === 'recurring_charges') { out.recurring_charge_sheets.push({ sheet, rows: rows.length }); rows.forEach((r, i) => out.recurring_charges.push({ account: s(r.Account), charge: s(r['Charge Description']), start: s(r['Start Date']) || null, end: s(r['End Date']) || null, provenance: { provider: PROVIDER, file: filename, file_sha256: file.sha256, sheet, row: i + 2 } })); continue; }
    if (!kind) { out.unrecognized_sheets.push(sheet); continue; }
    rows.forEach((r, i) => {
      const prov = { provider: PROVIDER, file: filename, file_sha256: file.sha256, sheet, row: i + 2 };
      if (kind === 'roster') out.roster.push({ account: s(r.Account), homeowner_id: s(r['Homeowner ID']), name: s(r.HomeownerName), first: s(r.FirstName), last: s(r.LastName),
        spouse_first: s(r.SpouseFirstName), spouse_last: s(r.SpouseLastName), business: s(r.BusinessName), deed_name: s(r.DeedName), mailing_name_override: s(r.MailingNameOverride),
        mailing: { street_no: s(r.MailStreetNo), line1: s(r.MailAddress1), line2: s(r.MailAddress2), unit: s(r['Unit No']), city: s(r.MailCity), state: s(r.MailState), zip: s(r.MailZip) },
        placeholder: PLACEHOLDER.test(s(r.HomeownerName)), mail_rel_type: s(r.MailRelType) || null, provenance: prov });
      else if (kind === 'contact_address') out.contact_address.push({ account: s(r.Account), name: s(r.HomeownerName), type: s(r['Address Type']), label: s(r.Label), primary_mailing: /^(yes|true|y|1)$/i.test(s(r['Primary Mailing'])),
        address: { street_no: s(r['Street No']), line1: s(r.Address1), line2: s(r.Address2), unit: s(r['Unit No']), city: s(r.City), state: s(r['State/Province']), zip: s(r.Zip) }, provenance: prov });
      else if (kind === 'contact_email') out.contact_email.push({ account: s(r.Account), row_name: s(r.HomeOwnerName || r.HomeownerName), value: s(r.Email).toLowerCase(), primary: /^(yes|true|y|1)$/i.test(s(r.Primary)), label: s(r.label || r.Label), provenance: prov });
      else out.contact_phone.push({ account: s(r.Account), row_name: s(r.HomeOwnerName || r.HomeownerName), value: s(r.phone || r.Phone).replace(/\D/g, ''), primary: /^(yes|true|y|1)$/i.test(s(r.Primary)), label: s(r.label || r.Label), provenance: prov });
    });
  }
  return out;
}

// Merge several read workbooks into one source set (records keep their own provenance).
function combine(reads) {
  const all = { files: [], roster: [], contact_address: [], contact_email: [], contact_phone: [], recurring_charges: [], recurring_charge_sheets: [], unrecognized_sheets: [] };
  for (const r of reads) { all.files.push(r.file); for (const k of ['roster', 'contact_address', 'contact_email', 'contact_phone', 'recurring_charges', 'recurring_charge_sheets']) all[k].push(...(r[k] || [])); all.unrecognized_sheets.push(...r.unrecognized_sheets.map((sh) => `${r.file.filename}:${sh}`)); }
  return all;
}

module.exports = { PROVIDER, COMMUNITY_PACKAGE, PLACEHOLDER, readWorkbook, combine, detectSheet };
