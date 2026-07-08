// scripts/reconcile_accounts.js
// ----------------------------------------------------------------------------
// Per-account reconciliation report combining BOTH source files:
//   1. Homeowner Contact Information (3).xlsx (3-tab: Address/Email/Phone)
//   2. Homeowner Export.xlsx                    (single sheet)
//
// For each unique Account # across both files:
//   - Look up trustEd property via properties.vantaca_account_id
//   - Look up current owner (property_ownerships where end_date IS NULL,
//     preferring is_primary). For corporate landlords (Progress Residential
//     etc.) the same contact links many properties.
//   - Pull the contact's flat fields (primary_email/secondary_email/
//     primary_phone/secondary_phone/mailing_address) AND contact_methods rows
//   - Compare to file data; flag matches + diffs per field
//
// Output: Homeowner Reconciliation Report.xlsx with columns side-by-side
// for human review in Excel. Ed sorts/filters and decides per-row how to act.
// ----------------------------------------------------------------------------

require('dotenv').config();
const XLSX = require('xlsx');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BATCH = 200;

const PLACEHOLDER_NAMES = new Set([
  '', 'current resident', 'current owner', 'unknown', 'unknown owner',
  'occupant', 'owner', 'tenant', 'resident', 'n/a', 'na',
]);
const isPlaceholder = (n) => PLACEHOLDER_NAMES.has(String(n || '').trim().toLowerCase());
const lower = (v) => String(v || '').trim().toLowerCase();
const phoneDigits = (v) => String(v || '').replace(/\D+/g, '');
const trimOrBlank = (v) => v === undefined || v === null ? '' : String(v).trim();

function parseCompositeAddress(s) {
  if (!s) return { property: null, mailing: null };
  const str = String(s).trim();
  const labelMatch = str.match(/P:\s*(.+?)\s+M:\s+(.+)$/i);
  if (labelMatch) return { property: labelMatch[1].trim(), mailing: labelMatch[2].trim() };
  const onlyP = str.match(/^P:\s*(.+)$/i);
  if (onlyP) return { property: onlyP[1].trim(), mailing: null };
  const onlyM = str.match(/^M:\s*(.+)$/i);
  if (onlyM) return { property: null, mailing: onlyM[1].trim() };
  return { property: null, mailing: str };
}

// ----------------------------------------------------------------------------
// Step 1: read + organize both files by Account #
// ----------------------------------------------------------------------------
function loadFiles() {
  const byAcct = new Map(); // accountId → { homeowner_name, emails:[], phones:[], mailings:[] }

  const get = (acct) => {
    if (!byAcct.has(acct)) byAcct.set(acct, { homeowner_names: new Set(), emails: [], phones: [], mailings: [], balance: null });
    return byAcct.get(acct);
  };

  // Contact Info (3-tab)
  const contactWb = XLSX.readFile(path.join('C:/Users/edget/Downloads', 'Homeowner Contact Information (3).xlsx'));
  if (contactWb.SheetNames.includes('Email')) {
    XLSX.utils.sheet_to_json(contactWb.Sheets['Email'], { defval: '' }).forEach((r) => {
      const acct = trimOrBlank(r['Account']);
      if (!acct) return;
      const entry = get(acct);
      if (r['HomeOwnerName']) entry.homeowner_names.add(trimOrBlank(r['HomeOwnerName']));
      const val = trimOrBlank(r['Email']);
      if (val) entry.emails.push({ value: val, is_primary: lower(r['Primary']) === 'yes', label: trimOrBlank(r['label']), source: 'contact_info' });
    });
  }
  if (contactWb.SheetNames.includes('Phone')) {
    XLSX.utils.sheet_to_json(contactWb.Sheets['Phone'], { defval: '' }).forEach((r) => {
      const acct = trimOrBlank(r['Account']);
      if (!acct) return;
      const entry = get(acct);
      if (r['HomeOwnerName']) entry.homeowner_names.add(trimOrBlank(r['HomeOwnerName']));
      const val = trimOrBlank(r['phone']);
      if (val) entry.phones.push({ value: val, is_primary: lower(r['Primary']) === 'yes', label: trimOrBlank(r['label']), source: 'contact_info' });
    });
  }
  if (contactWb.SheetNames.includes('Address')) {
    XLSX.utils.sheet_to_json(contactWb.Sheets['Address'], { defval: '' }).forEach((r) => {
      const acct = trimOrBlank(r['Account']);
      if (!acct) return;
      if (trimOrBlank(r['Address Type']) !== 'Mailing') return;
      if (lower(r['Primary Mailing']) !== 'yes') return;
      const entry = get(acct);
      if (r['HomeownerName']) entry.homeowner_names.add(trimOrBlank(r['HomeownerName']));
      const composed = [r['Street No'], r['Address1'], r['Address2'], r['Unit No']].filter((x) => trimOrBlank(x)).join(' ')
                     + (r['City'] ? `, ${r['City']}` : '')
                     + (r['State/Province'] ? `, ${r['State/Province']}` : '')
                     + (r['Zip'] ? ` ${r['Zip']}` : '');
      if (composed.trim()) entry.mailings.push({ value: composed.trim(), source: 'contact_info' });
    });
  }

  // Export (single sheet) — adds 1 email + 1 mailing + balance per account
  const expWb = XLSX.readFile(path.join('C:/Users/edget/Downloads', 'Homeowner Export.xlsx'));
  const expSheet = expWb.Sheets[expWb.SheetNames[0]];
  XLSX.utils.sheet_to_json(expSheet, { defval: '' }).forEach((r) => {
    const acct = trimOrBlank(r['Account #']);
    if (!acct) return;
    const entry = get(acct);
    if (r['Homeowner']) entry.homeowner_names.add(trimOrBlank(r['Homeowner']));
    const email = trimOrBlank(r['Email']);
    if (email) entry.emails.push({ value: email, is_primary: true, label: '', source: 'export' });
    const composed = parseCompositeAddress(r['Address']);
    if (composed.mailing) entry.mailings.push({ value: composed.mailing, source: 'export' });
    if (r['Balance'] !== '' && r['Balance'] !== undefined && r['Balance'] !== null) {
      const bal = Number(r['Balance']);
      if (!isNaN(bal)) entry.balance = bal;
    }
  });

  return byAcct;
}

// ----------------------------------------------------------------------------
// Step 2: pull DB state for each Account # via properties → ownerships → contacts
// ----------------------------------------------------------------------------
async function loadDbState(accountIds) {
  // Properties by vantaca_account_id
  const propsByAccount = new Map();
  for (let i = 0; i < accountIds.length; i += BATCH) {
    const chunk = accountIds.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from('properties')
      .select('id, vantaca_account_id, street_address, unit, community_id, communities(id, name)')
      .in('vantaca_account_id', chunk);
    if (error) { console.warn('properties batch error:', error.message); continue; }
    (data || []).forEach((p) => { if (p.vantaca_account_id) propsByAccount.set(p.vantaca_account_id, p); });
  }

  // Current ownerships
  const propertyIds = Array.from(propsByAccount.values()).map((p) => p.id);
  const ownerByProperty = new Map();
  for (let i = 0; i < propertyIds.length; i += BATCH) {
    const chunk = propertyIds.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from('property_ownerships')
      .select('property_id, contact_id, is_primary, start_date')
      .in('property_id', chunk)
      .is('end_date', null);
    if (error) { console.warn('ownerships batch error:', error.message); continue; }
    (data || []).forEach((o) => {
      if (!o.contact_id) return;
      const existing = ownerByProperty.get(o.property_id);
      if (!existing || (o.is_primary && !existing.is_primary)) ownerByProperty.set(o.property_id, o);
    });
  }

  // Contacts (deduped)
  const contactIds = Array.from(new Set(Array.from(ownerByProperty.values()).map((o) => o.contact_id)));
  const contactsById = new Map();
  for (let i = 0; i < contactIds.length; i += BATCH) {
    const chunk = contactIds.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from('contacts')
      .select('id, full_name, primary_email, secondary_email, primary_phone, secondary_phone, mailing_address')
      .in('id', chunk);
    if (error) { console.warn('contacts batch error:', error.message); continue; }
    (data || []).forEach((c) => contactsById.set(c.id, c));
  }

  // Contact methods (deduped by contact_id)
  const methodsByContact = new Map();
  for (let i = 0; i < contactIds.length; i += BATCH) {
    const chunk = contactIds.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from('contact_methods')
      .select('contact_id, method_type, value, is_primary, label')
      .in('contact_id', chunk);
    if (error) { console.warn('contact_methods batch error:', error.message); continue; }
    (data || []).forEach((m) => {
      if (!methodsByContact.has(m.contact_id)) methodsByContact.set(m.contact_id, []);
      methodsByContact.get(m.contact_id).push(m);
    });
  }

  return { propsByAccount, ownerByProperty, contactsById, methodsByContact };
}

// ----------------------------------------------------------------------------
// Step 3: build reconciliation rows
// ----------------------------------------------------------------------------
function buildReport(byAcct, db) {
  const rows = [];
  // Sort accounts so report is deterministic
  const sortedAccounts = Array.from(byAcct.keys()).sort();

  for (const acct of sortedAccounts) {
    const file = byAcct.get(acct);
    const property = db.propsByAccount.get(acct);
    const ownership = property ? db.ownerByProperty.get(property.id) : null;
    const contact = ownership ? db.contactsById.get(ownership.contact_id) : null;
    const methods = contact ? (db.methodsByContact.get(contact.id) || []) : [];

    // Combine file emails — primary first, dedupe
    const fileEmailsAll = file.emails.slice();
    const fileEmailPrimary = fileEmailsAll.find((e) => e.is_primary)?.value || (fileEmailsAll[0]?.value || '');
    const fileEmailSecondary = fileEmailsAll.filter((e) => e.value !== fileEmailPrimary)[0]?.value || '';
    const fileEmailsAllStr = Array.from(new Set(fileEmailsAll.map((e) => e.value))).join('; ');

    const filePhonesAll = file.phones.slice();
    const filePhonePrimary = filePhonesAll.find((p) => p.is_primary)?.value || (filePhonesAll[0]?.value || '');
    const filePhoneSecondary = filePhonesAll.filter((p) => p.value !== filePhonePrimary)[0]?.value || '';
    const filePhonesAllStr = Array.from(new Set(filePhonesAll.map((p) => p.value))).join('; ');

    const fileMailing = file.mailings.length > 0 ? file.mailings[0].value : '';

    // DB sides
    const dbEmails = methods.filter((m) => m.method_type === 'email').map((m) => m.value);
    const dbPhones = methods.filter((m) => m.method_type === 'phone').map((m) => m.value);
    const dbPrimaryEmail = (contact?.primary_email) || methods.find((m) => m.method_type === 'email' && m.is_primary)?.value || '';
    const dbSecondaryEmail = (contact?.secondary_email) || methods.find((m) => m.method_type === 'email' && !m.is_primary)?.value || '';
    const dbPrimaryPhone = (contact?.primary_phone) || methods.find((m) => m.method_type === 'phone' && m.is_primary)?.value || '';
    const dbSecondaryPhone = (contact?.secondary_phone) || methods.find((m) => m.method_type === 'phone' && !m.is_primary)?.value || '';
    const dbMailing = contact?.mailing_address || '';

    // Match helpers
    const emailsKnown = new Set([
      ...dbEmails.map(lower),
      lower(contact?.primary_email),
      lower(contact?.secondary_email),
    ].filter(Boolean));
    const phonesKnown = new Set([
      ...dbPhones.map(phoneDigits),
      phoneDigits(contact?.primary_phone),
      phoneDigits(contact?.secondary_phone),
    ].filter(Boolean));

    const fileEmailsNew = fileEmailsAll.filter((e) => !emailsKnown.has(lower(e.value))).map((e) => e.value);
    const filePhonesNew = filePhonesAll.filter((p) => !phonesKnown.has(phoneDigits(p.value))).map((p) => p.value);

    let propertyMatch = property ? 'YES' : 'NO';
    let mailingMatch = '';
    if (fileMailing && dbMailing) {
      mailingMatch = lower(fileMailing) === lower(dbMailing) ? 'SAME' : 'DIFFERENT';
    } else if (fileMailing && !dbMailing) {
      mailingMatch = 'DB_EMPTY';
    } else if (!fileMailing && dbMailing) {
      mailingMatch = 'FILE_EMPTY';
    } else {
      mailingMatch = 'BOTH_EMPTY';
    }

    const ownerNames = Array.from(file.homeowner_names);
    const isPlaceholderOwner = contact && isPlaceholder(contact.full_name);

    let suggestedAction = '';
    if (!property) {
      suggestedAction = 'NO ACTION — Account # not in trustEd properties';
    } else if (!contact) {
      suggestedAction = 'NO ACTION — Property has no current owner record';
    } else if (isPlaceholderOwner) {
      suggestedAction = 'FIX OWNERSHIP FIRST — DB shows placeholder; transition to real owner in Vantaca/trustEd before importing contact info';
    } else if (fileEmailsNew.length === 0 && filePhonesNew.length === 0 && (mailingMatch === 'SAME' || mailingMatch === 'BOTH_EMPTY' || mailingMatch === 'FILE_EMPTY')) {
      suggestedAction = 'SKIP — all values already match';
    } else {
      const parts = [];
      if (fileEmailsNew.length > 0) parts.push(`ADD ${fileEmailsNew.length} email(s)`);
      if (filePhonesNew.length > 0) parts.push(`ADD ${filePhonesNew.length} phone(s)`);
      if (mailingMatch === 'DB_EMPTY' && fileMailing) parts.push('SET mailing');
      if (mailingMatch === 'DIFFERENT') parts.push('REVIEW mailing diff');
      suggestedAction = parts.join('; ');
    }

    rows.push({
      'Account #': acct,
      'File homeowner name(s)': ownerNames.join(' / '),
      'DB property match': propertyMatch,
      'DB property address': property ? `${property.street_address || ''}${property.unit ? ' #' + property.unit : ''}` : '',
      'Community': property?.communities?.name || '',
      'DB owner contact': contact?.full_name || '',
      'DB owner is placeholder': isPlaceholderOwner ? 'YES' : '',
      'File primary email': fileEmailPrimary,
      'File secondary email': fileEmailSecondary,
      'File all emails': fileEmailsAllStr,
      'DB primary email': dbPrimaryEmail,
      'DB secondary email': dbSecondaryEmail,
      'DB all emails (methods)': dbEmails.join('; '),
      'New emails (in file, not in DB)': fileEmailsNew.join('; '),
      'File primary phone': filePhonePrimary,
      'File secondary phone': filePhoneSecondary,
      'File all phones': filePhonesAllStr,
      'DB primary phone': dbPrimaryPhone,
      'DB secondary phone': dbSecondaryPhone,
      'DB all phones (methods)': dbPhones.join('; '),
      'New phones (in file, not in DB)': filePhonesNew.join('; '),
      'File mailing address': fileMailing,
      'DB mailing address': dbMailing,
      'Mailing match': mailingMatch,
      'File balance': file.balance !== null ? file.balance : '',
      'Suggested action': suggestedAction,
    });
  }

  return rows;
}

// ----------------------------------------------------------------------------
// Run
// ----------------------------------------------------------------------------
(async () => {
  console.log('Loading both xlsx files…');
  const byAcct = loadFiles();
  console.log(`Found ${byAcct.size} unique Account #s across both files.`);

  console.log('Querying trustEd DB…');
  const db = await loadDbState(Array.from(byAcct.keys()));
  console.log(`DB found: ${db.propsByAccount.size} properties, ${db.contactsById.size} contacts.`);

  console.log('Building reconciliation rows…');
  const rows = buildReport(byAcct, db);

  // Summary stats
  const summary = {
    total_accounts: rows.length,
    property_matched: rows.filter((r) => r['DB property match'] === 'YES').length,
    property_not_found: rows.filter((r) => r['DB property match'] === 'NO').length,
    placeholder_owner: rows.filter((r) => r['DB owner is placeholder'] === 'YES').length,
    all_values_match: rows.filter((r) => r['Suggested action'] === 'SKIP — all values already match').length,
    has_new_emails: rows.filter((r) => r['New emails (in file, not in DB)']).length,
    has_new_phones: rows.filter((r) => r['New phones (in file, not in DB)']).length,
    mailing_different: rows.filter((r) => r['Mailing match'] === 'DIFFERENT').length,
    mailing_db_empty: rows.filter((r) => r['Mailing match'] === 'DB_EMPTY').length,
  };
  console.log('\nSummary:', JSON.stringify(summary, null, 2));

  // Write xlsx
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Reconciliation');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([summary]), 'Summary');
  const out = path.join('C:/Users/edget/Downloads', 'Homeowner Reconciliation Report.xlsx');
  XLSX.writeFile(wb, out);
  console.log(`\n→ wrote ${out}`);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
