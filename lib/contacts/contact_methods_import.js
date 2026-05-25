// ============================================================================
// lib/contacts/contact_methods_import.js
// ----------------------------------------------------------------------------
// Parser + diff for the bulk contact-methods xlsx import. The spreadsheet
// shape Bedrock uses (from a Vantaca-export script or manual prep):
//
//   Tab "Address"  — Account / HomeownerName / Street No / Address1 / Address2 /
//                    Unit No / City / State/Province / Zip / International /
//                    Address Type / Label / Primary Mailing
//   Tab "Email"    — Account / HomeOwnerName / Email / Primary / label
//   Tab "Phone"    — Account / HomeOwnerName / phone / Primary / label
//
// Join key: Account → contacts.vantaca_account_id (populated by the Vantaca
// CSV/Excel import). Rows whose Account doesn't match a known contact get
// classified as ORPHAN and reported in the preview but NOT applied.
//
// Diff classifications per row:
//   NEW          — contact exists, this value isn't on file yet → INSERT contact_methods row
//   MATCH        — contact exists, this exact value IS on file → no-op (idempotent re-import safe)
//   PRIMARY_FLIP — contact exists, value is on file but the file says primary and current says not (or vice versa)
//   INCONSISTENT — contact exists, file has a DIFFERENT primary value than the one on file for that method_type
//                  (e.g., file primary=A, db primary=B). Staff must choose.
//   ORPHAN       — Account doesn't match any contact in trustEd. Skipped on apply.
//
// Caller responsibility: apply selectively. Apply endpoint takes a list of
// row indices per category that staff approved; everything else is left alone.
// ============================================================================

const XLSX = require('xlsx');

const SHEET_ADDRESS = 'Address';
const SHEET_EMAIL = 'Email';
const SHEET_PHONE = 'Phone';

function normalizeYesNo(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'yes' || s === 'y' || s === 'true' || s === '1';
}
function trimOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function normalizeEmail(v) {
  const t = trimOrNull(v);
  return t ? t.toLowerCase() : null;
}
// Normalize phone for comparison only — store the human-formatted value
function normalizePhoneCompare(v) {
  return String(v || '').replace(/\D+/g, '');
}
// Infer a contact_methods.subtype from the spreadsheet label field
function inferEmailSubtype(label) {
  const l = String(label || '').trim().toLowerCase();
  if (!l) return null;
  if (l.includes('work')) return 'work';
  if (l.includes('personal')) return 'personal';
  if (l.includes('spouse') || l.includes('wife') || l.includes('husband')) return 'spouse';
  if (l.includes('manager') || l.includes('pm ')) return 'property_manager';
  // If the label looks like a person's name (has a space, no special chars),
  // treat it as a spouse/secondary identifier
  if (/^[A-Za-z][A-Za-z\s.-]+$/.test(label.trim())) return 'spouse';
  return null;
}
function inferPhoneSubtype(label) {
  const l = String(label || '').trim().toLowerCase();
  if (!l) return null;
  if (l.includes('cell') || l.includes('mobile') || l.includes('mob')) return 'cell';
  if (l.includes('home')) return 'home';
  if (l.includes('work') || l.includes('office')) return 'work';
  if (l.includes('fax')) return 'fax';
  if (/^[A-Za-z][A-Za-z\s.-]+$/.test(label.trim())) return 'spouse';
  return null;
}

/**
 * Parse a contact-info xlsx (Bedrock 3-tab format) from a Buffer.
 * Returns { addresses, emails, phones } — each an array of normalized row
 * objects with _source_row (1-indexed within their sheet).
 */
function parseContactInfoXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });

  const addresses = [];
  const emails = [];
  const phones = [];
  const warnings = [];

  if (wb.SheetNames.includes(SHEET_ADDRESS)) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_ADDRESS], { defval: '' });
    rows.forEach((r, i) => {
      const acct = trimOrNull(r['Account']);
      if (!acct) return;
      addresses.push({
        _source_row: i + 2, // header is row 1; first data is row 2
        account_id: acct,
        homeowner_name: trimOrNull(r['HomeownerName']) || trimOrNull(r['HomeOwnerName']),
        street_no: trimOrNull(r['Street No']),
        address1: trimOrNull(r['Address1']),
        address2: trimOrNull(r['Address2']),
        unit_no: trimOrNull(r['Unit No']),
        city: trimOrNull(r['City']),
        state: trimOrNull(r['State/Province']),
        zip: trimOrNull(r['Zip']),
        address_type: trimOrNull(r['Address Type']),  // 'Property' or 'Mailing'
        label: trimOrNull(r['Label']),
        primary_mailing: normalizeYesNo(r['Primary Mailing']),
      });
    });
  } else {
    warnings.push(`Sheet "${SHEET_ADDRESS}" not found.`);
  }

  if (wb.SheetNames.includes(SHEET_EMAIL)) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_EMAIL], { defval: '' });
    rows.forEach((r, i) => {
      const acct = trimOrNull(r['Account']);
      const value = normalizeEmail(r['Email']);
      if (!acct || !value) return;
      emails.push({
        _source_row: i + 2,
        account_id: acct,
        homeowner_name: trimOrNull(r['HomeOwnerName']) || trimOrNull(r['HomeownerName']),
        value,
        is_primary: normalizeYesNo(r['Primary']),
        label: trimOrNull(r['label']) || trimOrNull(r['Label']),
        inferred_subtype: inferEmailSubtype(r['label'] || r['Label']),
      });
    });
  } else {
    warnings.push(`Sheet "${SHEET_EMAIL}" not found.`);
  }

  if (wb.SheetNames.includes(SHEET_PHONE)) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_PHONE], { defval: '' });
    rows.forEach((r, i) => {
      const acct = trimOrNull(r['Account']);
      const value = trimOrNull(r['phone']) || trimOrNull(r['Phone']);
      if (!acct || !value) return;
      phones.push({
        _source_row: i + 2,
        account_id: acct,
        homeowner_name: trimOrNull(r['HomeOwnerName']) || trimOrNull(r['HomeownerName']),
        value,
        normalized: normalizePhoneCompare(value),
        is_primary: normalizeYesNo(r['Primary']),
        label: trimOrNull(r['label']) || trimOrNull(r['Label']),
        inferred_subtype: inferPhoneSubtype(r['label'] || r['Label']),
      });
    });
  } else {
    warnings.push(`Sheet "${SHEET_PHONE}" not found.`);
  }

  return { addresses, emails, phones, warnings };
}

/**
 * Compute the diff between parsed file rows and the current trustEd state.
 * Returns structured per-category arrays (new / match / primary_flip /
 * inconsistent / orphan) that staff reviews + selectively applies.
 */
async function computeContactMethodsDiff(supabase, parsed) {
  const allAccountIds = [
    ...new Set([
      ...parsed.emails.map((r) => r.account_id),
      ...parsed.phones.map((r) => r.account_id),
      ...parsed.addresses.map((r) => r.account_id),
    ]),
  ];

  // Lookup all contacts by vantaca_account_id in batches (PostgREST URL limit)
  const BATCH = 200;
  const contactsByAccount = new Map();
  for (let i = 0; i < allAccountIds.length; i += BATCH) {
    const chunk = allAccountIds.slice(i, i + BATCH);
    const { data } = await supabase
      .from('contacts')
      .select('id, full_name, vantaca_account_id, primary_email, secondary_email, primary_phone, secondary_phone, mailing_address')
      .in('vantaca_account_id', chunk);
    (data || []).forEach((c) => contactsByAccount.set(c.vantaca_account_id, c));
  }

  // Pre-load contact_methods for all matched contacts (also batched)
  const contactIds = Array.from(contactsByAccount.values()).map((c) => c.id);
  const methodsByContact = new Map(); // contactId → [methods]
  for (let i = 0; i < contactIds.length; i += BATCH) {
    const chunk = contactIds.slice(i, i + BATCH);
    const { data } = await supabase
      .from('contact_methods')
      .select('id, contact_id, method_type, value, is_primary, label, subtype')
      .in('contact_id', chunk);
    (data || []).forEach((m) => {
      if (!methodsByContact.has(m.contact_id)) methodsByContact.set(m.contact_id, []);
      methodsByContact.get(m.contact_id).push(m);
    });
  }

  const classify = {
    new: [],            // [{ row, contact_id, contact_name, method_type, value, is_primary, label, inferred_subtype }]
    match: [],          // [{ row, contact_id, contact_name, method_type, value }]
    primary_flip: [],   // [{ row, contact_id, contact_name, method_type, value, current_primary, file_primary, existing_method_id }]
    inconsistent: [],   // [{ row, contact_id, contact_name, method_type, file_value, db_primary_value, db_method_ids: [...] }]
    orphan: [],         // [{ row, account_id, homeowner_name, method_type, value }]
  };

  function classifyRow(row, methodType, valueForCompare) {
    const contact = contactsByAccount.get(row.account_id);
    if (!contact) {
      classify.orphan.push({
        row: row._source_row, account_id: row.account_id,
        homeowner_name: row.homeowner_name, method_type: methodType, value: row.value,
      });
      return;
    }
    const existingMethods = (methodsByContact.get(contact.id) || []).filter((m) => m.method_type === methodType);
    const exactMatch = existingMethods.find((m) => {
      if (methodType === 'email') return String(m.value || '').toLowerCase() === valueForCompare;
      // phone — compare digits-only
      return normalizePhoneCompare(m.value) === row.normalized;
    });
    if (exactMatch) {
      if (!!exactMatch.is_primary === !!row.is_primary) {
        classify.match.push({
          row: row._source_row, contact_id: contact.id, contact_name: contact.full_name,
          method_type: methodType, value: row.value,
        });
      } else {
        classify.primary_flip.push({
          row: row._source_row, contact_id: contact.id, contact_name: contact.full_name,
          method_type: methodType, value: row.value,
          current_primary: !!exactMatch.is_primary, file_primary: !!row.is_primary,
          existing_method_id: exactMatch.id,
        });
      }
      return;
    }
    // No exact match — check if file is asking us to make this the primary and
    // there's already a different primary on file. If so, flag inconsistent.
    if (row.is_primary) {
      const currentPrimary = existingMethods.find((m) => m.is_primary);
      if (currentPrimary) {
        classify.inconsistent.push({
          row: row._source_row, contact_id: contact.id, contact_name: contact.full_name,
          method_type: methodType, file_value: row.value,
          db_primary_value: currentPrimary.value,
          db_method_ids: existingMethods.map((m) => m.id),
        });
        return;
      }
    }
    // No conflict — this is a new method we'll add
    classify.new.push({
      row: row._source_row, contact_id: contact.id, contact_name: contact.full_name,
      method_type: methodType, value: row.value, is_primary: !!row.is_primary,
      label: row.label, inferred_subtype: row.inferred_subtype,
    });
  }

  parsed.emails.forEach((r) => classifyRow(r, 'email', String(r.value).toLowerCase()));
  parsed.phones.forEach((r) => classifyRow(r, 'phone', r.normalized));

  // Mailing-address diff: simpler since contacts.mailing_address is a single
  // free-text field. For each Account with a "Mailing" + Primary=Yes row,
  // compare to contact.mailing_address. If different, flag for review.
  const mailingDiff = { new: [], match: [], inconsistent: [], orphan: [] };
  parsed.addresses
    .filter((r) => r.address_type === 'Mailing' && r.primary_mailing)
    .forEach((r) => {
      const contact = contactsByAccount.get(r.account_id);
      if (!contact) {
        mailingDiff.orphan.push({ row: r._source_row, account_id: r.account_id, homeowner_name: r.homeowner_name });
        return;
      }
      const composed = [r.street_no, r.address1, r.address2, r.unit_no].filter(Boolean).join(' ')
                     + (r.city ? `, ${r.city}` : '')
                     + (r.state ? `, ${r.state}` : '')
                     + (r.zip ? ` ${r.zip}` : '');
      const existing = (contact.mailing_address || '').trim().toLowerCase();
      if (!existing) {
        mailingDiff.new.push({ row: r._source_row, contact_id: contact.id, contact_name: contact.full_name, value: composed });
      } else if (existing === composed.trim().toLowerCase()) {
        mailingDiff.match.push({ row: r._source_row, contact_id: contact.id, contact_name: contact.full_name, value: composed });
      } else {
        mailingDiff.inconsistent.push({
          row: r._source_row, contact_id: contact.id, contact_name: contact.full_name,
          file_value: composed, db_value: contact.mailing_address,
        });
      }
    });

  return {
    methods: classify,
    mailing: mailingDiff,
    counts: {
      emails_new: classify.new.filter((r) => r.method_type === 'email').length,
      emails_match: classify.match.filter((r) => r.method_type === 'email').length,
      emails_primary_flip: classify.primary_flip.filter((r) => r.method_type === 'email').length,
      emails_inconsistent: classify.inconsistent.filter((r) => r.method_type === 'email').length,
      phones_new: classify.new.filter((r) => r.method_type === 'phone').length,
      phones_match: classify.match.filter((r) => r.method_type === 'phone').length,
      phones_primary_flip: classify.primary_flip.filter((r) => r.method_type === 'phone').length,
      phones_inconsistent: classify.inconsistent.filter((r) => r.method_type === 'phone').length,
      orphans: classify.orphan.length,
      mailing_new: mailingDiff.new.length,
      mailing_match: mailingDiff.match.length,
      mailing_inconsistent: mailingDiff.inconsistent.length,
      mailing_orphan: mailingDiff.orphan.length,
    },
  };
}

module.exports = {
  parseContactInfoXlsx,
  computeContactMethodsDiff,
};
