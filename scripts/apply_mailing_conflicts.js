// scripts/apply_mailing_conflicts.js
// Applies the 13 mailing conflicts: use file's value, enrich missing city/zip
// from a matching property record when possible (so bare-street mailings get
// the community's city/state/zip back).

require('dotenv').config();
const XLSX = require('xlsx');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BATCH = 200;
const DRY_RUN = !process.argv.includes('--live');

const PLACEHOLDER_NAMES = new Set([
  '', 'current resident', 'current owner', 'unknown', 'unknown owner',
  'occupant', 'owner', 'tenant', 'resident', 'n/a', 'na',
]);
const isPlaceholder = (n) => PLACEHOLDER_NAMES.has(String(n || '').trim().toLowerCase());
const trimOrBlank = (v) => v === undefined || v === null ? '' : String(v).trim();
const lower = (v) => String(v || '').trim().toLowerCase();

// Complete if it has "City, ST 12345" pattern at end (5-digit zip or zip+4)
function isCompleteMailing(s) {
  return /,\s*[A-Z]{2}\s+\d{5}(-\d{4})?\s*$/i.test(String(s || '').trim());
}

// Normalize a street for matching: lowercase, collapse spaces, expand common abbreviations
function normalizeStreet(s) {
  return String(s || '')
    .toLowerCase()
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
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract just the street portion (before first comma)
function streetOnly(s) {
  return String(s || '').split(',')[0].trim();
}

function parseCompositeAddress(s) {
  if (!s) return { mailing: null };
  const str = String(s).trim();
  const labelMatch = str.match(/P:\s*(.+?)\s+M:\s+(.+)$/i);
  if (labelMatch) return { mailing: labelMatch[2].trim() };
  const onlyM = str.match(/^M:\s*(.+)$/i);
  if (onlyM) return { mailing: onlyM[1].trim() };
  if (str.match(/^P:/i)) return { mailing: null };
  return { mailing: str };
}

function loadFiles() {
  const byAcct = new Map();
  const get = (acct) => {
    if (!byAcct.has(acct)) byAcct.set(acct, { mailings: [] });
    return byAcct.get(acct);
  };
  const ciWb = XLSX.readFile(path.join('C:/Users/edget/Downloads', 'Homeowner Contact Information (3).xlsx'));
  if (ciWb.SheetNames.includes('Address')) {
    XLSX.utils.sheet_to_json(ciWb.Sheets['Address'], { defval: '' }).forEach((r) => {
      const acct = trimOrBlank(r['Account']);
      if (!acct) return;
      if (trimOrBlank(r['Address Type']) !== 'Mailing') return;
      if (lower(r['Primary Mailing']) !== 'yes') return;
      const composed = [r['Street No'], r['Address1'], r['Address2'], r['Unit No']].filter((x) => trimOrBlank(x)).join(' ')
                     + (r['City'] ? `, ${r['City']}` : '')
                     + (r['State/Province'] ? `, ${r['State/Province']}` : '')
                     + (r['Zip'] ? ` ${r['Zip']}` : '');
      if (composed.trim()) get(acct).mailings.push(composed.trim());
    });
  }
  const expWb = XLSX.readFile(path.join('C:/Users/edget/Downloads', 'Homeowner Export.xlsx'));
  XLSX.utils.sheet_to_json(expWb.Sheets[expWb.SheetNames[0]], { defval: '' }).forEach((r) => {
    const acct = trimOrBlank(r['Account #']);
    if (!acct) return;
    const composed = parseCompositeAddress(r['Address']);
    if (composed.mailing) get(acct).mailings.push(composed.mailing);
  });
  return byAcct;
}

(async () => {
  console.log(DRY_RUN ? '[DRY RUN]' : '[LIVE RUN]');
  const byAcct = loadFiles();
  const accountIds = Array.from(byAcct.keys());

  // DB lookup
  const propsByAccount = new Map();
  for (let i = 0; i < accountIds.length; i += BATCH) {
    const { data } = await supabase
      .from('properties').select('id, vantaca_account_id, street_address, unit, city, state, zip, community_id')
      .in('vantaca_account_id', accountIds.slice(i, i + BATCH));
    (data || []).forEach((p) => { if (p.vantaca_account_id) propsByAccount.set(p.vantaca_account_id, p); });
  }
  const propertyIds = Array.from(propsByAccount.values()).map((p) => p.id);

  // All properties (for enrichment lookup by street) — paginated; community-scoped
  // Use the set of community_ids touched by these accounts
  const communityIds = Array.from(new Set(Array.from(propsByAccount.values()).map((p) => p.community_id)));
  const propsByStreetByCommunity = new Map(); // community_id → Map<normalizedStreet, property>
  for (const commId of communityIds) {
    const map = new Map();
    let start = 0;
    while (true) {
      const { data } = await supabase
        .from('properties').select('street_address, unit, city, state, zip')
        .eq('community_id', commId)
        .range(start, start + 999);
      if (!data || data.length === 0) break;
      data.forEach((p) => map.set(normalizeStreet(p.street_address || ''), p));
      if (data.length < 1000) break;
      start += 1000;
    }
    propsByStreetByCommunity.set(commId, map);
  }

  // Ownerships
  const ownerByProp = new Map();
  for (let i = 0; i < propertyIds.length; i += BATCH) {
    const { data } = await supabase
      .from('property_ownerships').select('property_id, contact_id, is_primary')
      .in('property_id', propertyIds.slice(i, i + BATCH))
      .is('end_date', null);
    (data || []).forEach((o) => {
      if (!o.contact_id) return;
      const existing = ownerByProp.get(o.property_id);
      if (!existing || (o.is_primary && !existing.is_primary)) ownerByProp.set(o.property_id, o);
    });
  }

  // Contacts
  const contactIds = Array.from(new Set(Array.from(ownerByProp.values()).map((o) => o.contact_id)));
  const contactsById = new Map();
  for (let i = 0; i < contactIds.length; i += BATCH) {
    const { data } = await supabase
      .from('contacts').select('id, full_name, mailing_address')
      .in('id', contactIds.slice(i, i + BATCH));
    (data || []).forEach((c) => contactsById.set(c.id, c));
  }

  // Find conflicts + propose enriched file value
  const seenContacts = new Set();
  const updates = []; // { contact_id, contact_name, account, property_addr, db_mailing, file_mailing, enriched_mailing, enrichment_source }
  for (const [acct, file] of byAcct) {
    const property = propsByAccount.get(acct);
    if (!property) continue;
    const ownership = ownerByProp.get(property.id);
    if (!ownership) continue;
    const contact = contactsById.get(ownership.contact_id);
    if (!contact || isPlaceholder(contact.full_name)) continue;
    if (file.mailings.length === 0) continue;
    const fileMailing = file.mailings[0].trim();
    const dbMailing = (contact.mailing_address || '').trim();
    if (!dbMailing || !fileMailing) continue;
    if (lower(dbMailing) === lower(fileMailing)) continue;
    if (seenContacts.has(contact.id)) continue;
    seenContacts.add(contact.id);

    // Enrich if incomplete
    let enriched = fileMailing;
    let source = 'file_as_is';
    if (!isCompleteMailing(fileMailing)) {
      // Try to find a matching property in the community by street
      const streetMap = propsByStreetByCommunity.get(property.community_id);
      const street = streetOnly(fileMailing);
      const norm = normalizeStreet(street);
      const matchedProp = streetMap ? streetMap.get(norm) : null;
      if (matchedProp && matchedProp.city) {
        const cityZip = `${matchedProp.city || ''}${matchedProp.state ? ', ' + matchedProp.state : ''}${matchedProp.zip ? ' ' + matchedProp.zip : ''}`.trim();
        enriched = `${street}, ${cityZip}`;
        source = `enriched_from_property_match(${matchedProp.street_address})`;
      } else {
        // Fallback: use the OWNED property's city/zip (this happens when the
        // mailing-is-property case where the owner's own property city/zip applies)
        if (property.city) {
          const cityZip = `${property.city || ''}${property.state ? ', ' + property.state : ''}${property.zip ? ' ' + property.zip : ''}`.trim();
          // Only fallback-enrich if it looks like the mailing might be the owned property's street
          // (or no other signal — better to add SOMETHING than leave bare)
          enriched = `${fileMailing}, ${cityZip}`;
          source = 'enriched_from_owned_property';
        }
      }
    }

    updates.push({
      contact_id: contact.id,
      contact_name: contact.full_name,
      account: acct,
      property_addr: `${property.street_address || ''}${property.unit ? ' #' + property.unit : ''}`,
      db_mailing: dbMailing,
      file_mailing: fileMailing,
      enriched_mailing: enriched,
      enrichment_source: source,
    });
  }

  console.log(`\n=== Will update ${updates.length} mailings ===\n`);
  updates.forEach((u, i) => {
    console.log(`${i + 1}. ${u.contact_name} (acct ${u.account})`);
    console.log(`   OLD: "${u.db_mailing}"`);
    console.log(`   NEW: "${u.enriched_mailing}"  [${u.enrichment_source}]`);
    if (u.enriched_mailing !== u.file_mailing) {
      console.log(`        (raw file value was: "${u.file_mailing}")`);
    }
    console.log('');
  });

  // Apply
  const stats = { updated: 0, errors: [] };
  if (!DRY_RUN) {
    for (const u of updates) {
      const { error } = await supabase
        .from('contacts')
        .update({ mailing_address: u.enriched_mailing, updated_at: new Date().toISOString() })
        .eq('id', u.contact_id);
      if (error) { stats.errors.push({ account: u.account, error: error.message }); }
      else stats.updated += 1;
    }
    console.log(`\n=== APPLIED ===`);
    console.log(JSON.stringify(stats, null, 2));
  }

  // Audit + xlsx
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(updates), 'Mailings');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ count: updates.length, ...stats }]), 'Summary');
  const out = path.join('C:/Users/edget/Downloads',
    DRY_RUN ? 'Mailing Conflict Apply - DRY RUN.xlsx' : 'Mailing Conflict Apply - APPLIED.xlsx');
  XLSX.writeFile(wb, out);
  console.log(`→ wrote ${out}`);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
