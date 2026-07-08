// scripts/apply_reconciliation.js
// ----------------------------------------------------------------------------
// Applies the reconciliation findings directly to the trustEd DB. Safe scope:
//   • INSERT new emails into contact_methods (when file value not in DB)
//   • INSERT new phones into contact_methods
//   • UPDATE contacts.mailing_address WHEN DB mailing is empty AND file has one
//
// Always skipped (need explicit UI per-row decisions):
//   • Placeholder-owner properties (DB has "Current Resident"/Unknown linked)
//   • Mailing conflicts (file ≠ DB, both populated) — UI bulk import handles
//   • Primary-flag conflicts (file says new email is primary but DB has different
//     existing primary) — we insert as non-primary so we don't silently demote
//
// Within-run safety: dedup-by-(contact_id, method_type, value) so corporate
// landlords (Progress Residential, AH4R, Paruben Ray Trust) spanning many
// properties only get one insert per unique email/phone.
//
// Writes a contact_methods_sync_log row with status='applied' for audit so
// it appears in the recent-uploads list in the UI.
// ----------------------------------------------------------------------------

require('dotenv').config();
const XLSX = require('xlsx');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BATCH = 200;
const DRY_RUN = process.argv.includes('--dry-run');

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

function loadFiles() {
  const byAcct = new Map();
  const get = (acct) => {
    if (!byAcct.has(acct)) byAcct.set(acct, { homeowner_names: new Set(), emails: [], phones: [], mailings: [] });
    return byAcct.get(acct);
  };
  const contactWb = XLSX.readFile(path.join('C:/Users/edget/Downloads', 'Homeowner Contact Information (3).xlsx'));
  if (contactWb.SheetNames.includes('Email')) {
    XLSX.utils.sheet_to_json(contactWb.Sheets['Email'], { defval: '' }).forEach((r) => {
      const acct = trimOrBlank(r['Account']);
      if (!acct) return;
      const entry = get(acct);
      if (r['HomeOwnerName']) entry.homeowner_names.add(trimOrBlank(r['HomeOwnerName']));
      const val = trimOrBlank(r['Email']);
      if (val) entry.emails.push({ value: val, is_primary: lower(r['Primary']) === 'yes', label: trimOrBlank(r['label']) });
    });
  }
  if (contactWb.SheetNames.includes('Phone')) {
    XLSX.utils.sheet_to_json(contactWb.Sheets['Phone'], { defval: '' }).forEach((r) => {
      const acct = trimOrBlank(r['Account']);
      if (!acct) return;
      const entry = get(acct);
      if (r['HomeOwnerName']) entry.homeowner_names.add(trimOrBlank(r['HomeOwnerName']));
      const val = trimOrBlank(r['phone']);
      if (val) entry.phones.push({ value: val, is_primary: lower(r['Primary']) === 'yes', label: trimOrBlank(r['label']) });
    });
  }
  if (contactWb.SheetNames.includes('Address')) {
    XLSX.utils.sheet_to_json(contactWb.Sheets['Address'], { defval: '' }).forEach((r) => {
      const acct = trimOrBlank(r['Account']);
      if (!acct) return;
      if (trimOrBlank(r['Address Type']) !== 'Mailing') return;
      if (lower(r['Primary Mailing']) !== 'yes') return;
      const entry = get(acct);
      const composed = [r['Street No'], r['Address1'], r['Address2'], r['Unit No']].filter((x) => trimOrBlank(x)).join(' ')
                     + (r['City'] ? `, ${r['City']}` : '')
                     + (r['State/Province'] ? `, ${r['State/Province']}` : '')
                     + (r['Zip'] ? ` ${r['Zip']}` : '');
      if (composed.trim()) entry.mailings.push({ value: composed.trim() });
    });
  }
  const expWb = XLSX.readFile(path.join('C:/Users/edget/Downloads', 'Homeowner Export.xlsx'));
  XLSX.utils.sheet_to_json(expWb.Sheets[expWb.SheetNames[0]], { defval: '' }).forEach((r) => {
    const acct = trimOrBlank(r['Account #']);
    if (!acct) return;
    const entry = get(acct);
    if (r['Homeowner']) entry.homeowner_names.add(trimOrBlank(r['Homeowner']));
    const email = trimOrBlank(r['Email']);
    if (email) entry.emails.push({ value: email, is_primary: true });
    const composed = parseCompositeAddress(r['Address']);
    if (composed.mailing) entry.mailings.push({ value: composed.mailing });
  });
  return byAcct;
}

async function loadDbState(accountIds) {
  const propsByAccount = new Map();
  for (let i = 0; i < accountIds.length; i += BATCH) {
    const chunk = accountIds.slice(i, i + BATCH);
    const { data } = await supabase
      .from('properties')
      .select('id, vantaca_account_id, street_address, community_id')
      .in('vantaca_account_id', chunk);
    (data || []).forEach((p) => { if (p.vantaca_account_id) propsByAccount.set(p.vantaca_account_id, p); });
  }
  const propertyIds = Array.from(propsByAccount.values()).map((p) => p.id);
  const ownerByProperty = new Map();
  for (let i = 0; i < propertyIds.length; i += BATCH) {
    const chunk = propertyIds.slice(i, i + BATCH);
    const { data } = await supabase
      .from('property_ownerships')
      .select('property_id, contact_id, is_primary, start_date')
      .in('property_id', chunk)
      .is('end_date', null);
    (data || []).forEach((o) => {
      if (!o.contact_id) return;
      const existing = ownerByProperty.get(o.property_id);
      if (!existing || (o.is_primary && !existing.is_primary)) ownerByProperty.set(o.property_id, o);
    });
  }
  const contactIds = Array.from(new Set(Array.from(ownerByProperty.values()).map((o) => o.contact_id)));
  const contactsById = new Map();
  for (let i = 0; i < contactIds.length; i += BATCH) {
    const chunk = contactIds.slice(i, i + BATCH);
    const { data } = await supabase
      .from('contacts')
      .select('id, full_name, primary_email, secondary_email, primary_phone, secondary_phone, mailing_address')
      .in('id', chunk);
    (data || []).forEach((c) => contactsById.set(c.id, c));
  }
  const methodsByContact = new Map();
  for (let i = 0; i < contactIds.length; i += BATCH) {
    const chunk = contactIds.slice(i, i + BATCH);
    const { data } = await supabase
      .from('contact_methods')
      .select('contact_id, method_type, value, is_primary')
      .in('contact_id', chunk);
    (data || []).forEach((m) => {
      if (!methodsByContact.has(m.contact_id)) methodsByContact.set(m.contact_id, []);
      methodsByContact.get(m.contact_id).push(m);
    });
  }
  return { propsByAccount, ownerByProperty, contactsById, methodsByContact };
}

async function run() {
  console.log(DRY_RUN ? '[DRY RUN — no DB writes]' : '[LIVE RUN — applying to DB]');
  console.log('Loading files…');
  const byAcct = loadFiles();
  console.log(`${byAcct.size} unique Account #s.`);

  console.log('Querying DB state…');
  const db = await loadDbState(Array.from(byAcct.keys()));
  console.log(`DB: ${db.propsByAccount.size} matched properties, ${db.contactsById.size} contacts.`);

  const applied = {
    accounts_processed: 0,
    accounts_skipped_no_property: 0,
    accounts_skipped_no_owner: 0,
    accounts_skipped_placeholder: 0,
    emails_inserted: 0,
    emails_skipped_duplicate: 0,
    phones_inserted: 0,
    phones_skipped_duplicate: 0,
    mailings_set: 0,
    mailings_skipped_diff: 0,
    mailings_skipped_match: 0,
    errors: [],
  };

  // Within-run dedup: avoid double-inserting for corporate landlords across
  // multiple properties pointing at the same contact
  const insertedKeys = new Set(); // `${contact_id}:${method_type}:${lower(value)}`
  const mailingTouched = new Set(); // contact_id whose mailing we already SET

  for (const [acct, file] of byAcct) {
    applied.accounts_processed += 1;
    const property = db.propsByAccount.get(acct);
    if (!property) { applied.accounts_skipped_no_property += 1; continue; }
    const ownership = db.ownerByProperty.get(property.id);
    if (!ownership) { applied.accounts_skipped_no_owner += 1; continue; }
    const contact = db.contactsById.get(ownership.contact_id);
    if (!contact) { applied.accounts_skipped_no_owner += 1; continue; }
    if (isPlaceholder(contact.full_name)) { applied.accounts_skipped_placeholder += 1; continue; }

    const methods = db.methodsByContact.get(contact.id) || [];
    const knownEmails = new Set([
      ...methods.filter((m) => m.method_type === 'email').map((m) => lower(m.value)),
      lower(contact.primary_email),
      lower(contact.secondary_email),
    ].filter(Boolean));
    const knownPhones = new Set([
      ...methods.filter((m) => m.method_type === 'phone').map((m) => phoneDigits(m.value)),
      phoneDigits(contact.primary_phone),
      phoneDigits(contact.secondary_phone),
    ].filter(Boolean));
    const contactHasAnyEmail = knownEmails.size > 0;
    const contactHasAnyPhone = knownPhones.size > 0;

    // ---- emails ----
    const uniqueFileEmails = [];
    const seenInRow = new Set();
    file.emails.forEach((e) => {
      const lv = lower(e.value);
      if (!lv) return;
      if (seenInRow.has(lv)) return;
      seenInRow.add(lv);
      uniqueFileEmails.push({ value: e.value, lower: lv, is_primary: e.is_primary });
    });
    for (const e of uniqueFileEmails) {
      if (knownEmails.has(e.lower)) { applied.emails_skipped_duplicate += 1; continue; }
      const dedupKey = `${contact.id}:email:${e.lower}`;
      if (insertedKeys.has(dedupKey)) { applied.emails_skipped_duplicate += 1; continue; }
      // Don't auto-demote existing primary. Set is_primary only if contact has no email at all.
      const insertAsPrimary = !contactHasAnyEmail;
      if (!DRY_RUN) {
        const { error } = await supabase.from('contact_methods').insert({
          contact_id: contact.id,
          method_type: 'email',
          value: e.value.trim(),
          is_primary: insertAsPrimary,
          label: 'bulk-imported (script_apply)',
        });
        if (error) { applied.errors.push({ acct, op: 'insert_email', error: error.message }); continue; }
        // Sync to contacts.primary_email if this is the first email
        if (insertAsPrimary) {
          await supabase.from('contacts').update({ primary_email: e.value.trim(), updated_at: new Date().toISOString() }).eq('id', contact.id);
        }
      }
      insertedKeys.add(dedupKey);
      knownEmails.add(e.lower);
      applied.emails_inserted += 1;
    }

    // ---- phones ----
    const uniqueFilePhones = [];
    const seenPhoneInRow = new Set();
    file.phones.forEach((p) => {
      const pd = phoneDigits(p.value);
      if (!pd) return;
      if (seenPhoneInRow.has(pd)) return;
      seenPhoneInRow.add(pd);
      uniqueFilePhones.push({ value: p.value, digits: pd, is_primary: p.is_primary });
    });
    for (const p of uniqueFilePhones) {
      if (knownPhones.has(p.digits)) { applied.phones_skipped_duplicate += 1; continue; }
      const dedupKey = `${contact.id}:phone:${p.digits}`;
      if (insertedKeys.has(dedupKey)) { applied.phones_skipped_duplicate += 1; continue; }
      const insertAsPrimary = !contactHasAnyPhone;
      if (!DRY_RUN) {
        const { error } = await supabase.from('contact_methods').insert({
          contact_id: contact.id,
          method_type: 'phone',
          value: p.value.trim(),
          is_primary: insertAsPrimary,
          label: 'bulk-imported (script_apply)',
        });
        if (error) { applied.errors.push({ acct, op: 'insert_phone', error: error.message }); continue; }
        if (insertAsPrimary) {
          await supabase.from('contacts').update({ primary_phone: p.value.trim(), updated_at: new Date().toISOString() }).eq('id', contact.id);
        }
      }
      insertedKeys.add(dedupKey);
      knownPhones.add(p.digits);
      applied.phones_inserted += 1;
    }

    // ---- mailing ----
    if (file.mailings.length > 0 && !mailingTouched.has(contact.id)) {
      const fileMailing = file.mailings[0].value.trim();
      const dbMailing = (contact.mailing_address || '').trim();
      if (!dbMailing) {
        // DB empty → SET
        if (!DRY_RUN) {
          const { error } = await supabase.from('contacts').update({ mailing_address: fileMailing, updated_at: new Date().toISOString() }).eq('id', contact.id);
          if (error) { applied.errors.push({ acct, op: 'set_mailing', error: error.message }); }
          else { applied.mailings_set += 1; mailingTouched.add(contact.id); contact.mailing_address = fileMailing; }
        } else {
          applied.mailings_set += 1; mailingTouched.add(contact.id);
        }
      } else if (lower(dbMailing) === lower(fileMailing)) {
        applied.mailings_skipped_match += 1;
        mailingTouched.add(contact.id);
      } else {
        applied.mailings_skipped_diff += 1;
        mailingTouched.add(contact.id);
      }
    }

    if (applied.accounts_processed % 100 === 0) {
      console.log(`  …${applied.accounts_processed}/${byAcct.size} processed (emails added: ${applied.emails_inserted}, phones added: ${applied.phones_inserted}, mailings set: ${applied.mailings_set})`);
    }
  }

  console.log('\n=== APPLIED ===');
  console.log(JSON.stringify(applied, null, 2));

  // Write audit log (only on live run)
  if (!DRY_RUN) {
    try {
      await supabase.from('contact_methods_sync_log').insert({
        uploaded_by: 'scripts/apply_reconciliation.js',
        file_name: 'Homeowner Contact Information (3).xlsx + Homeowner Export.xlsx (merged via script)',
        total_rows: applied.accounts_processed,
        parsed_data: null,
        diff_summary: { counts: { reconciliation_script: true } },
        status: 'applied',
        applied_at: new Date().toISOString(),
        applied_by: 'scripts/apply_reconciliation.js',
        applied_summary: applied,
        notes: 'Direct DB apply via reconciliation script. Skips placeholder owners + mailing conflicts. New methods inserted as non-primary if contact already has primary.',
      });
      console.log('\nAudit log written to contact_methods_sync_log (status=applied).');
    } catch (e) {
      console.warn('Audit log write failed (non-fatal):', e.message);
    }
  }
}

run().catch((err) => { console.error('FATAL:', err); process.exit(1); });
