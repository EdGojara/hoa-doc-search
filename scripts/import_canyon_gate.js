// scripts/import_canyon_gate.js
// ----------------------------------------------------------------------------
// Canyon Gate at Cinco Ranch initial import. Greenfield — 0 properties in
// trustEd today. Builds properties + contacts + ownerships + residencies +
// contact_preferences from two Vantaca exports.
//
// File 1: Homeowner Export (1).xlsx — 721 rows (Account # / Homeowner /
//   Address P:.../M:... / Email / Balance)
// File 2: All Addresses Export (8).xlsx — 905 rows (Homeowner ID join key
//   for cross-account dedup, structured mailing fields, communication prefs)
//
// Output: dry-run summary by default (no DB writes). Pass --live to apply.
// ----------------------------------------------------------------------------

require('dotenv').config();
const XLSX = require('xlsx');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const DRY_RUN = !process.argv.includes('--live');

const CANYON_GATE_ID = 'a0000000-0000-4000-8000-000000000003';
const DEFAULT_CITY = 'Katy';
const DEFAULT_STATE = 'TX';
const DEFAULT_ZIP = '77450';
const TODAY = new Date().toISOString().slice(0, 10);

const trim = (v) => String(v || '').trim();
const lower = (v) => trim(v).toLowerCase();
const normPhone = (v) => String(v || '').replace(/\D+/g, '');

function normalizeStreet(s) {
  return String(s || '').toLowerCase()
    .replace(/\b(street|st)\.?\b/g, 'st')
    .replace(/\b(drive|dr)\.?\b/g, 'dr')
    .replace(/\b(lane|ln)\.?\b/g, 'ln')
    .replace(/\b(road|rd)\.?\b/g, 'rd')
    .replace(/\b(court|ct)\.?\b/g, 'ct')
    .replace(/\b(boulevard|blvd)\.?\b/g, 'blvd')
    .replace(/\b(avenue|ave)\.?\b/g, 'ave')
    .replace(/\b(circle|cir)\.?\b/g, 'cir')
    .replace(/\b(trail|trl)\.?\b/g, 'trl')
    .replace(/\b(parkway|pkwy)\.?\b/g, 'pkwy')
    .replace(/\b(way)\b/g, 'way')
    .replace(/\s+/g, ' ').trim();
}

function parseFile1() {
  const wb = XLSX.readFile('C:/Users/edget/Downloads/Homeowner Export (1).xlsx');
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Sheet1'], { defval: '' });
  const byAccount = new Map();
  rows.forEach((r) => {
    const acct = trim(r['Account #']);
    if (!acct) return;
    const addr = trim(r['Address']);
    const propMatch = addr.match(/P:\s*(.+?)\s+M:\s+(.+)$/i);
    const onlyP = !propMatch && addr.match(/^P:\s*(.+)$/i);
    byAccount.set(acct, {
      account_id: acct,
      homeowner_name: trim(r['Homeowner']),
      property_street: propMatch ? propMatch[1].trim() : (onlyP ? onlyP[1].trim() : null),
      mailing_composite: propMatch ? propMatch[2].trim() : null,
      primary_email: lower(r['Email']) || null,
      balance: Number(r['Balance']) || 0,
    });
  });
  return byAccount;
}

function parseFile2() {
  const wb = XLSX.readFile('C:/Users/edget/Downloads/All Addresses Export (8).xlsx');
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Sheet1'], { defval: '' });
  const byAccount = new Map();
  rows.forEach((r) => {
    const acct = String(r['Account'] || '').trim();
    if (!acct) return;
    if (!byAccount.has(acct)) byAccount.set(acct, []);
    byAccount.get(acct).push({
      homeowner_id: trim(r['Homeowner ID']),
      homeowner_name: trim(r['HomeownerName']),
      first_name: trim(r['FirstName']),
      last_name: trim(r['LastName']),
      spouse_first: trim(r['SpouseFirstName']),
      spouse_last: trim(r['SpouseLastName']),
      business_name: trim(r['BusinessName']),
      deed_name: trim(r['DeedName']),
      mailing_override: trim(r['MailingNameOverride']),
      street_no: trim(r['MailStreetNo']),
      address1: trim(r['MailAddress1']),
      address2: trim(r['MailAddress2']),
      unit_no: trim(r['Unit No']),
      city: trim(r['MailCity']),
      state: trim(r['MailState']),
      zip: String(r['MailZip'] || '').trim(),
      general_pref: lower(r['GeneralPreference']),
      billing_pref: lower(r['BillingPreference']),
      rel_type: trim(r['MailRelType']),
    });
  });
  return byAccount;
}

function composeStreet(row) {
  return [
    row.street_no,
    row.address1,
    row.address2,
    row.unit_no ? '#' + row.unit_no : null,
  ].filter(Boolean).join(' ').trim();
}

function composeFullMailing(row) {
  const street = composeStreet(row);
  const cityStateZip = [
    row.city,
    [row.state, row.zip].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ');
  return [street, cityStateZip].filter(Boolean).join(', ');
}

function pickContactRow(f2rows, f1) {
  // Pick the File 2 row that represents the OWNER's identity (not necessarily
  // the property address row). Heuristic: first row that has the BusinessName
  // populated for corporate, else first row regardless.
  if (!f2rows || f2rows.length === 0) return null;
  return f2rows.find((r) => r.business_name) || f2rows[0];
}

function pickMailingRow(f2rows, f1) {
  // Mailing row preference:
  //  1. f1's mailing_composite when distinct from property (clean string source)
  //  2. f2 row whose street doesn't match the property (alt mailing — corporate PO Box, etc.)
  //  3. f2 first row (fallback)
  if (!f2rows || f2rows.length === 0) return null;
  const propStreetNorm = normalizeStreet(f1.property_street || '');
  const alt = f2rows.find((r) => {
    const candStreet = composeStreet(r);
    return candStreet && normalizeStreet(candStreet) !== propStreetNorm;
  });
  return alt || f2rows[0];
}

async function run() {
  console.log(DRY_RUN ? '[DRY RUN — no DB writes]' : '[LIVE RUN]');
  console.log('Parsing files…');
  const f1 = parseFile1();
  const f2 = parseFile2();
  console.log(`File 1 accounts: ${f1.size}.  File 2 accounts: ${f2.size}.`);

  // Build the per-account combined record + dedup contacts by homeowner_id
  // (cross-account contact reuse for corporate landlords + investors)
  const accountsToImport = [];
  const contactsByHomeownerId = new Map(); // homeowner_id → contact data
  const contactsByDedupKey = new Map();    // when no homeowner_id, dedup by name/business

  for (const [acct, a] of f1) {
    const f2rows = f2.get(acct) || [];
    const idRow = pickContactRow(f2rows, a);
    const mailRow = pickMailingRow(f2rows, a);

    // Determine display name
    const businessName = idRow ? idRow.business_name : null;
    let displayName = a.homeowner_name; // canonical name from File 1
    if (idRow && (idRow.first_name || idRow.last_name)) {
      // Prefer "FirstName LastName" if both populated (cleaner for individuals)
      const reconstructed = [idRow.first_name, idRow.last_name].filter(Boolean).join(' ');
      if (reconstructed && reconstructed.length < displayName.length * 0.5) {
        // Use the clean reconstructed name only when significantly shorter (avoids
        // collapsing intentional joint-ownership concatenations)
        displayName = reconstructed;
      }
    }

    // Compose mailing
    let mailingAddress = null;
    if (mailRow && (mailRow.city || mailRow.state || mailRow.zip)) {
      mailingAddress = composeFullMailing(mailRow);
    } else if (a.mailing_composite) {
      // Fall back to File 1's M: portion + community default city/state/zip if no comma
      mailingAddress = a.mailing_composite;
      if (!/,\s*[A-Z]{2}\s+\d{5}/i.test(mailingAddress)) {
        mailingAddress += `, ${DEFAULT_CITY}, ${DEFAULT_STATE} ${DEFAULT_ZIP}`;
      }
    }

    // Determine residency type from M vs P
    const propStreet = a.property_street || '';
    const mailingMatchesProperty = !a.mailing_composite
      || normalizeStreet(a.mailing_composite) === normalizeStreet(propStreet);
    const residencyType = mailingMatchesProperty ? 'owner_occupied' : 'renter';

    // Find property city/state/zip — prefer a File 2 row that matches the property
    let propertyCity = DEFAULT_CITY, propertyState = DEFAULT_STATE, propertyZip = DEFAULT_ZIP;
    const propRow = f2rows.find((r) => normalizeStreet(composeStreet(r)) === normalizeStreet(propStreet));
    if (propRow) {
      propertyCity = propRow.city || DEFAULT_CITY;
      propertyState = propRow.state || DEFAULT_STATE;
      propertyZip = propRow.zip || DEFAULT_ZIP;
    }

    // Dedup key for the contact
    const homeownerId = idRow ? idRow.homeowner_id : null;
    let dedupKey = homeownerId ? `hid:${homeownerId}` : null;
    if (!dedupKey && businessName) dedupKey = `biz:${lower(businessName)}`;
    if (!dedupKey) dedupKey = `name:${lower(displayName)}`;

    let contact = contactsByHomeownerId.get(dedupKey);
    if (!contact) {
      contact = {
        dedup_key: dedupKey,
        full_name: displayName,
        business_name: businessName || null,
        preferred_name: null,
        primary_email: a.primary_email || null,
        mailing_address: mailingAddress,
        general_pref: idRow?.general_pref || null,
        billing_pref: idRow?.billing_pref || null,
        accounts_owned: 0,
      };
      contactsByHomeownerId.set(dedupKey, contact);
    } else {
      // Fill in missing fields if available from this row
      if (!contact.primary_email && a.primary_email) contact.primary_email = a.primary_email;
      if (!contact.mailing_address && mailingAddress) contact.mailing_address = mailingAddress;
    }
    contact.accounts_owned += 1;

    accountsToImport.push({
      account_id: acct,
      property_street: propStreet,
      property_city: propertyCity,
      property_state: propertyState,
      property_zip: propertyZip,
      contact_dedup_key: dedupKey,
      residency_type: residencyType,
      balance: a.balance,
    });
  }

  console.log(`\nWill import ${accountsToImport.length} properties, ${contactsByHomeownerId.size} unique contacts.`);
  // Top corporate / multi-property contacts
  const sortedContacts = Array.from(contactsByHomeownerId.values())
    .sort((a, b) => b.accounts_owned - a.accounts_owned);
  console.log('\nTop 10 contacts by property count:');
  sortedContacts.slice(0, 10).forEach((c) => {
    console.log(`  ${c.accounts_owned.toString().padStart(3)} × ${c.full_name}${c.business_name ? ` [biz: ${c.business_name}]` : ''}`);
  });

  // Residency type distribution
  const resDist = { owner_occupied: 0, renter: 0 };
  accountsToImport.forEach((a) => { resDist[a.residency_type] = (resDist[a.residency_type] || 0) + 1; });
  console.log(`\nResidency type inferred from M vs P:`);
  console.log(`  owner_occupied: ${resDist.owner_occupied}`);
  console.log(`  renter: ${resDist.renter}`);

  // ----------------------------------------------------------------------
  // APPLY (live mode)
  // ----------------------------------------------------------------------
  const stats = {
    properties_created: 0,
    properties_skipped: 0,
    contacts_created: 0,
    contacts_matched_existing: 0,
    ownerships_created: 0,
    residencies_created: 0,
    preferences_set: 0,
    errors: [],
  };

  if (DRY_RUN) {
    console.log('\n(DRY RUN — no DB writes)');
    stats.properties_created = accountsToImport.length;
    stats.contacts_created = contactsByHomeownerId.size;
    stats.ownerships_created = accountsToImport.length;
    stats.residencies_created = accountsToImport.length;
    stats.preferences_set = Array.from(contactsByHomeownerId.values()).filter((c) => c.general_pref || c.billing_pref).length;
  } else {
    // Phase 1: contacts — create or find existing
    const dedupToContactId = new Map();
    console.log('\nPhase 1: contacts…');
    let n = 0;
    for (const [key, c] of contactsByHomeownerId) {
      n += 1;
      try {
        // Try to find existing contact by exact full_name match (case-insensitive)
        const { data: existing } = await supabase
          .from('contacts').select('id, full_name')
          .ilike('full_name', c.full_name)
          .limit(5);
        const match = (existing || []).find((m) => lower(m.full_name) === lower(c.full_name));
        if (match) {
          dedupToContactId.set(key, match.id);
          stats.contacts_matched_existing += 1;
          // Update mailing if missing on existing
          if (c.mailing_address) {
            await supabase.from('contacts')
              .update({ mailing_address: c.mailing_address, updated_at: new Date().toISOString() })
              .eq('id', match.id)
              .is('mailing_address', null);
          }
          continue;
        }
        const { data: created, error } = await supabase
          .from('contacts').insert({
            full_name: c.full_name,
            primary_email: c.primary_email,
            mailing_address: c.mailing_address,
            notes: 'imported by import_canyon_gate.js',
          }).select('id').single();
        if (error) { stats.errors.push({ phase: 'contact_create', name: c.full_name, error: error.message }); continue; }
        dedupToContactId.set(key, created.id);
        stats.contacts_created += 1;
        // Set communication preferences if available
        if (c.general_pref || c.billing_pref) {
          const general = c.general_pref === 'email' ? 'email' : (c.general_pref === 'paper' ? 'paper' : 'email');
          const billing = c.billing_pref === 'email' ? 'email' : (c.billing_pref === 'paper' ? 'paper' : 'email');
          const { error: prefErr } = await supabase
            .from('contact_preferences').insert({
              contact_id: created.id,
              general_comm_channel: general,
              billing_comm_channel: billing,
              notes: 'set by import_canyon_gate.js from Vantaca preferences',
            });
          if (!prefErr) stats.preferences_set += 1;
        }
        // Also seed contact_methods from primary_email so notifications can target
        if (c.primary_email) {
          await supabase.from('contact_methods').insert({
            contact_id: created.id,
            method_type: 'email',
            value: c.primary_email,
            is_primary: true,
            label: 'imported (canyon_gate)',
          });
        }
      } catch (e) {
        stats.errors.push({ phase: 'contact_create', name: c.full_name, error: e.message });
      }
      if (n % 100 === 0) console.log(`  …${n}/${contactsByHomeownerId.size} contacts processed`);
    }

    // Phase 2: properties + ownerships + residencies
    console.log('\nPhase 2: properties + ownerships + residencies…');
    let m = 0;
    for (const a of accountsToImport) {
      m += 1;
      try {
        const contactId = dedupToContactId.get(a.contact_dedup_key);
        if (!contactId) { stats.errors.push({ phase: 'no_contact', account: a.account_id }); continue; }

        // Insert property (skip if Vantaca account already exists)
        const { data: existingProp } = await supabase
          .from('properties').select('id').eq('vantaca_account_id', a.account_id).maybeSingle();
        let propertyId;
        if (existingProp) {
          propertyId = existingProp.id;
          stats.properties_skipped += 1;
        } else {
          const { data: created, error } = await supabase
            .from('properties').insert({
              community_id: CANYON_GATE_ID,
              street_address: a.property_street,
              city: a.property_city,
              state: a.property_state,
              zip: a.property_zip,
              vantaca_account_id: a.account_id,
            }).select('id').single();
          if (error) { stats.errors.push({ phase: 'property_create', account: a.account_id, error: error.message }); continue; }
          propertyId = created.id;
          stats.properties_created += 1;
        }

        // Ownership
        const { error: ownErr } = await supabase
          .from('property_ownerships').insert({
            property_id: propertyId,
            contact_id: contactId,
            start_date: TODAY,
            is_primary: true,
            source: 'import_canyon_gate',
          });
        if (!ownErr) stats.ownerships_created += 1;
        else if (!String(ownErr.message).includes('duplicate')) stats.errors.push({ phase: 'ownership', account: a.account_id, error: ownErr.message });

        // Residency
        const { error: resErr } = await supabase
          .from('property_residencies').insert({
            property_id: propertyId,
            contact_id: contactId,
            start_date: TODAY,
            residency_type: a.residency_type,
            source: 'import_canyon_gate',
          });
        if (!resErr) stats.residencies_created += 1;
      } catch (e) {
        stats.errors.push({ phase: 'general', account: a.account_id, error: e.message });
      }
      if (m % 100 === 0) console.log(`  …${m}/${accountsToImport.length} properties processed`);
    }

    // Audit log
    await supabase.from('contact_methods_sync_log').insert({
      uploaded_by: 'scripts/import_canyon_gate.js',
      file_name: 'Homeowner Export (1).xlsx + All Addresses Export (8).xlsx (Canyon Gate initial)',
      total_rows: accountsToImport.length,
      diff_summary: { counts: { canyon_gate_initial: true } },
      status: 'applied',
      applied_at: new Date().toISOString(),
      applied_by: 'scripts/import_canyon_gate.js',
      applied_summary: stats,
      notes: 'Canyon Gate at Cinco Ranch initial import (properties + contacts + ownerships + residencies + preferences).',
    });
  }

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(stats, null, 2));

  // Write a per-account audit xlsx
  const reportRows = accountsToImport.map((a) => {
    const contact = contactsByHomeownerId.get(a.contact_dedup_key);
    return {
      'Account #': a.account_id,
      'Property address': `${a.property_street}, ${a.property_city}, ${a.property_state} ${a.property_zip}`,
      'Owner': contact.full_name,
      'Business name': contact.business_name || '',
      'Primary email': contact.primary_email || '',
      'Mailing address': contact.mailing_address || '',
      'General pref': contact.general_pref || '',
      'Billing pref': contact.billing_pref || '',
      'Inferred residency': a.residency_type,
      'Owner property count': contact.accounts_owned,
      'Balance': a.balance,
    };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(reportRows), 'Imported');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ ...stats, ...resDist }]), 'Summary');
  const out = path.join('C:/Users/edget/Downloads',
    DRY_RUN ? 'Canyon Gate Import - DRY RUN.xlsx' : 'Canyon Gate Import - APPLIED.xlsx');
  XLSX.writeFile(wb, out);
  console.log(`\n→ wrote ${out}`);
}

run().catch((e) => { console.error('FATAL:', e); process.exit(1); });
