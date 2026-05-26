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

// Placeholder owner names from Vantaca's "no real owner on file" pattern.
// These contacts are typically shared across MANY properties (the original
// Vantaca import deduped by name) so we MUST NOT attach contact_methods
// to them — would pollute one contact with hundreds of unrelated emails.
function isPlaceholderName(name) {
  if (!name) return true;
  const n = String(name).trim().toLowerCase();
  return n === ''
      || n === 'current resident'
      || n === 'current owner'
      || n === 'unknown'
      || n === 'unknown owner'
      || n === 'occupant'
      || n === 'owner'
      || n === 'tenant'
      || n === 'resident'
      || n === 'n/a'
      || n === 'na';
}

/**
 * Parse a contact-info xlsx from a Buffer. Auto-detects format:
 *   - 3-tab format: sheets named Address / Email / Phone, joined by Account
 *     (the original Bedrock contact info export)
 *   - Single-sheet format: one sheet with columns
 *     Account # / Homeowner / Address / Email [/ Balance]
 *     (the Vantaca Homeowner Export). Address column packs property +
 *     mailing as "P: <property> M: <mailing>".
 *
 * Both formats produce the same output shape so downstream diff/apply is
 * format-agnostic.
 */
function parseContactInfoXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const hasMultiTab = wb.SheetNames.includes(SHEET_EMAIL)
                   || wb.SheetNames.includes(SHEET_PHONE)
                   || wb.SheetNames.includes(SHEET_ADDRESS);
  if (hasMultiTab) {
    return _parseMultiTabFormat(wb);
  }
  return _parseSingleSheetFormat(wb);
}

/**
 * Parse "P: 5807 Baldwin Elm Street M: PO Box 6643" into { property, mailing }.
 * Either or both may be missing. If no P:/M: prefix, the whole string is
 * treated as the mailing address.
 */
function _parseCompositeAddress(str) {
  if (!str) return { property: null, mailing: null };
  const s = String(str).trim();
  // Try the labeled format first
  const labelMatch = s.match(/P:\s*(.+?)\s+M:\s+(.+)$/i);
  if (labelMatch) {
    return { property: labelMatch[1].trim(), mailing: labelMatch[2].trim() };
  }
  // Only P: prefix
  const onlyP = s.match(/^P:\s*(.+)$/i);
  if (onlyP) return { property: onlyP[1].trim(), mailing: null };
  // Only M: prefix
  const onlyM = s.match(/^M:\s*(.+)$/i);
  if (onlyM) return { property: null, mailing: onlyM[1].trim() };
  // No prefixes — treat whole string as mailing
  return { property: null, mailing: s };
}

function _parseSingleSheetFormat(wb) {
  const addresses = [];
  const emails = [];
  const phones = [];
  const warnings = [];
  const balances = []; // surfaced as info, not yet wired to AR snapshots

  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    warnings.push('No sheets found in workbook.');
    return { addresses, emails, phones, warnings, balances };
  }
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
  if (rows.length === 0) {
    warnings.push(`Sheet "${sheetName}" is empty.`);
    return { addresses, emails, phones, warnings, balances };
  }

  // Verify it looks like the expected single-sheet format
  const firstRow = rows[0];
  const hasAccount = 'Account #' in firstRow || 'Account' in firstRow;
  if (!hasAccount) {
    warnings.push(`Unrecognized format: sheet "${sheetName}" missing "Account #" or "Account" column.`);
    return { addresses, emails, phones, warnings, balances };
  }

  rows.forEach((r, i) => {
    const acct = trimOrNull(r['Account #']) || trimOrNull(r['Account']);
    if (!acct) return;
    const name = trimOrNull(r['Homeowner']) || trimOrNull(r['HomeownerName']) || trimOrNull(r['HomeOwnerName']);
    const sourceRow = i + 2;

    // Email — single per row, treat as primary by default
    const email = normalizeEmail(r['Email']);
    if (email) {
      emails.push({
        _source_row: sourceRow,
        account_id: acct,
        homeowner_name: name,
        value: email,
        is_primary: true,
        label: null,
        inferred_subtype: null,
      });
    }

    // Address — composite "P: ... M: ..." parse
    const parsedAddr = _parseCompositeAddress(r['Address']);
    if (parsedAddr.mailing) {
      addresses.push({
        _source_row: sourceRow,
        account_id: acct,
        homeowner_name: name,
        street_no: null,
        address1: parsedAddr.mailing, // composed single-line; downstream join handles
        address2: null,
        unit_no: null,
        city: null,
        state: null,
        zip: null,
        address_type: 'Mailing',
        label: null,
        primary_mailing: true,
      });
    }

    // Balance — surface as info; not yet imported into owner_ar_snapshots
    // (that's a separate canonical AR ingest pipeline)
    if (r['Balance'] !== '' && r['Balance'] !== undefined && r['Balance'] !== null) {
      const bal = Number(r['Balance']);
      if (!isNaN(bal)) {
        balances.push({ _source_row: sourceRow, account_id: acct, homeowner_name: name, balance: bal });
      }
    }
  });

  if (balances.length > 0) {
    warnings.push(`Sheet has ${balances.length} balance rows — not imported. Use the AR snapshot flow for current balance data.`);
  }

  return { addresses, emails, phones, warnings, balances };
}

function _parseMultiTabFormat(wb) {
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

  // Resolve Account ID → contact via the proper chain:
  //   properties.vantaca_account_id → property_ownerships (current) → contacts
  // (vantaca_account_id lives on properties, not contacts — Vantaca treats
  // accounts as per-property. Contacts get linked via ownership.)
  // For joint ownership, prefer the is_primary contact; fall back to first.
  const BATCH = 200;
  const contactsByAccount = new Map();

  // Step 1: properties by vantaca_account_id
  const propertyRows = [];
  for (let i = 0; i < allAccountIds.length; i += BATCH) {
    const chunk = allAccountIds.slice(i, i + BATCH);
    const { data } = await supabase
      .from('properties')
      .select('id, vantaca_account_id, community_id')
      .in('vantaca_account_id', chunk);
    propertyRows.push(...(data || []));
  }
  const accountToPropertyId = new Map();
  propertyRows.forEach((p) => { if (p.vantaca_account_id) accountToPropertyId.set(p.vantaca_account_id, p.id); });

  // Step 2: current property_ownerships for those properties
  const propertyIds = propertyRows.map((p) => p.id);
  const ownerByPropertyId = new Map(); // property_id → { contact_id, is_primary }
  for (let i = 0; i < propertyIds.length; i += BATCH) {
    const chunk = propertyIds.slice(i, i + BATCH);
    const { data } = await supabase
      .from('property_ownerships')
      .select('property_id, contact_id, is_primary, start_date')
      .in('property_id', chunk)
      .is('end_date', null);
    (data || []).forEach((o) => {
      if (!o.contact_id) return;
      const existing = ownerByPropertyId.get(o.property_id);
      // Prefer is_primary; else earliest start_date
      if (!existing
          || (o.is_primary && !existing.is_primary)
          || (o.is_primary === existing.is_primary && (o.start_date || '') < (existing.start_date || '9999-12-31'))) {
        ownerByPropertyId.set(o.property_id, o);
      }
    });
  }

  // Step 3: contacts for those contact_ids
  const ownerContactIds = Array.from(new Set(Array.from(ownerByPropertyId.values()).map((o) => o.contact_id).filter(Boolean)));
  const contactsById = new Map();
  for (let i = 0; i < ownerContactIds.length; i += BATCH) {
    const chunk = ownerContactIds.slice(i, i + BATCH);
    const { data } = await supabase
      .from('contacts')
      .select('id, full_name, vantaca_account_id, primary_email, secondary_email, primary_phone, secondary_phone, mailing_address')
      .in('id', chunk);
    (data || []).forEach((c) => contactsById.set(c.id, c));
  }

  // Build the final lookup: account_id → contact
  accountToPropertyId.forEach((propertyId, accountId) => {
    const ownership = ownerByPropertyId.get(propertyId);
    if (!ownership) return;
    const contact = contactsById.get(ownership.contact_id);
    if (contact) contactsByAccount.set(accountId, contact);
  });

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
        reason: 'no_contact_match',
      });
      return;
    }
    // SAFETY: don't add methods to placeholder contacts. "Current Resident"
    // and similar are Vantaca placeholders linked to MANY properties via a
    // single shared contact row — attaching the file's emails/phones here
    // would corrupt that one contact with hundreds of unrelated values.
    // Surface as orphan with a clear reason so staff can fix the underlying
    // property ownership (via Vantaca import or manual transition) and
    // then re-run this import.
    if (isPlaceholderName(contact.full_name)) {
      classify.orphan.push({
        row: row._source_row, account_id: row.account_id,
        homeowner_name: row.homeowner_name, method_type: methodType, value: row.value,
        reason: `placeholder_owner: DB has "${contact.full_name}" linked to this property — file shows real owner "${row.homeowner_name}". Fix the property's ownership first (Vantaca import or manual transition), then re-run this import.`,
      });
      return;
    }
    const existingMethods = (methodsByContact.get(contact.id) || []).filter((m) => m.method_type === methodType);
    const exactMatch = existingMethods.find((m) => {
      if (methodType === 'email') return String(m.value || '').toLowerCase() === valueForCompare;
      // phone — compare digits-only
      return normalizePhoneCompare(m.value) === row.normalized;
    });

    // ALSO check the legacy flat columns on contacts (primary_email /
    // secondary_email / primary_phone / secondary_phone). Contacts created
    // via Vantaca import AFTER migration 114 have flat fields populated but
    // no corresponding contact_methods rows — without this check they'd be
    // incorrectly classified NEW. When found here, we treat as MATCH and
    // the apply step will silently sync them into contact_methods so
    // notification subscriptions can target them per-method going forward.
    if (!exactMatch) {
      const flatValues = [];
      if (methodType === 'email') {
        if (contact.primary_email) flatValues.push({ value: contact.primary_email, is_primary: true });
        if (contact.secondary_email) flatValues.push({ value: contact.secondary_email, is_primary: false });
      } else {
        if (contact.primary_phone) flatValues.push({ value: contact.primary_phone, is_primary: true });
        if (contact.secondary_phone) flatValues.push({ value: contact.secondary_phone, is_primary: false });
      }
      const flatMatch = flatValues.find((f) => {
        if (methodType === 'email') return String(f.value).toLowerCase() === valueForCompare;
        return normalizePhoneCompare(f.value) === row.normalized;
      });
      if (flatMatch) {
        classify.match.push({
          row: row._source_row, contact_id: contact.id, contact_name: contact.full_name,
          method_type: methodType, value: row.value,
          _flat_field_only: true,
          _flat_is_primary: !!flatMatch.is_primary,
          _note: 'value is on the contact as a legacy flat field (primary/secondary email/phone) but not yet in contact_methods — apply will sync it silently',
        });
        return;
      }
    }

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
    // No conflict — this is a new method we'll add. Dedupe across rows
    // (same contact + same value): when one homeowner owns N properties,
    // the SAME email appears N times in the file — we only want ONE NEW.
    const dedupKey = `${contact.id}:${methodType}:${valueForCompare}`;
    if (seenNewKeys.has(dedupKey)) {
      classify.match.push({
        row: row._source_row, contact_id: contact.id, contact_name: contact.full_name,
        method_type: methodType, value: row.value,
        _dedup_note: 'same value appears on another account for this contact (multi-property)',
      });
      return;
    }
    seenNewKeys.add(dedupKey);
    classify.new.push({
      row: row._source_row, contact_id: contact.id, contact_name: contact.full_name,
      method_type: methodType, value: row.value, is_primary: !!row.is_primary,
      label: row.label, inferred_subtype: row.inferred_subtype,
    });
  }

  // Track NEW classifications to dedupe multi-property duplicates
  const seenNewKeys = new Set();

  parsed.emails.forEach((r) => classifyRow(r, 'email', String(r.value).toLowerCase()));
  parsed.phones.forEach((r) => classifyRow(r, 'phone', r.normalized));

  // Mailing-address diff: simpler since contacts.mailing_address is a single
  // free-text field. For each Account with a "Mailing" + Primary=Yes row,
  // compare to contact.mailing_address. If different, flag for review.
  //
  // Dedup-by-contact: corporate landlords (Progress Residential Borrower,
  // American Homes 4 Rent, etc.) own N properties under ONE contact row.
  // Without dedup, N rows in the file all target the same contact and
  // last-write-wins on apply — silent data loss. First row for a contact
  // wins; subsequent same-value rows silently dedupe; subsequent different-
  // value rows get flagged as within-file conflicts.
  const mailingDiff = { new: [], match: [], inconsistent: [], orphan: [] };
  const mailingContactSeen = new Map(); // contactId → first composed value (lowercased)
  parsed.addresses
    .filter((r) => r.address_type === 'Mailing' && r.primary_mailing)
    .forEach((r) => {
      const contact = contactsByAccount.get(r.account_id);
      if (!contact) {
        mailingDiff.orphan.push({ row: r._source_row, account_id: r.account_id, homeowner_name: r.homeowner_name, reason: 'no_contact_match' });
        return;
      }
      // Same placeholder-owner safety as for methods — don't overwrite the
      // shared placeholder contact's mailing_address with N different addresses.
      if (isPlaceholderName(contact.full_name)) {
        mailingDiff.orphan.push({
          row: r._source_row, account_id: r.account_id, homeowner_name: r.homeowner_name,
          reason: `placeholder_owner: DB has "${contact.full_name}" linked — file shows "${r.homeowner_name}". Fix property ownership first.`,
        });
        return;
      }
      const composed = [r.street_no, r.address1, r.address2, r.unit_no].filter(Boolean).join(' ')
                     + (r.city ? `, ${r.city}` : '')
                     + (r.state ? `, ${r.state}` : '')
                     + (r.zip ? ` ${r.zip}` : '');
      const composedNorm = composed.trim().toLowerCase();

      // Dedup-within-file by contact_id
      const priorComposed = mailingContactSeen.get(contact.id);
      if (priorComposed !== undefined) {
        if (priorComposed === composedNorm) {
          // Identical to a prior row for this contact — silent dedup
          mailingDiff.match.push({
            row: r._source_row, contact_id: contact.id, contact_name: contact.full_name, value: composed,
            _dedup_note: 'same as a prior row for this contact (multi-property)',
          });
        } else {
          // Different mailing in a later row for the same contact — within-file conflict
          mailingDiff.inconsistent.push({
            row: r._source_row, contact_id: contact.id, contact_name: contact.full_name,
            file_value: composed,
            db_value: '(prior row in this file: ' + priorComposed + ')',
            _within_file_conflict: true,
          });
        }
        return;
      }
      mailingContactSeen.set(contact.id, composedNorm);

      const existing = (contact.mailing_address || '').trim().toLowerCase();
      if (!existing) {
        mailingDiff.new.push({ row: r._source_row, contact_id: contact.id, contact_name: contact.full_name, value: composed });
      } else if (existing === composedNorm) {
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
