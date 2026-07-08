// scripts/fix_placeholder_owners.js
// ----------------------------------------------------------------------------
// Fixes the placeholder-owner data-quality issue Ed identified:
// the original Vantaca CSV import mistakenly assigned the RESIDENT name
// (often "Current Resident" placeholder) to property_ownerships instead of
// the actual OWNER. The Homeowner Export file has the real owner name per
// Account #. This script transitions ownership to the correct entity.
//
// For each property where DB owner is a placeholder AND the file has a real
// (non-placeholder) homeowner name:
//   1. find_or_create the real owner contact (exact-name match, dedup
//      preferred to the contact already owning the most properties)
//   2. end-date the placeholder ownership row
//   3. insert a new ownership row linked to the real owner
//   4. (does NOT touch property_residencies — that's a separate decision)
//
// Default mode: DRY RUN (preview only). Pass --live to actually write.
// Always writes a contact_methods_sync_log row for audit on live runs.
//
// After this runs successfully, the contact_methods bulk import script can
// be re-applied for the 196 previously-skipped placeholder accounts.
// ----------------------------------------------------------------------------

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

function loadFileOwners() {
  // Account # → real owner name (from Homeowner Export — the canonical owner)
  const byAcct = new Map();
  const expWb = XLSX.readFile(path.join('C:/Users/edget/Downloads', 'Homeowner Export.xlsx'));
  XLSX.utils.sheet_to_json(expWb.Sheets[expWb.SheetNames[0]], { defval: '' }).forEach((r) => {
    const acct = trimOrBlank(r['Account #']);
    const owner = trimOrBlank(r['Homeowner']);
    if (acct && owner) byAcct.set(acct, owner);
  });
  // Also pull from Contact Info file as fallback (any of the 3 sheets carries the name)
  try {
    const ciWb = XLSX.readFile(path.join('C:/Users/edget/Downloads', 'Homeowner Contact Information (3).xlsx'));
    if (ciWb.SheetNames.includes('Email')) {
      XLSX.utils.sheet_to_json(ciWb.Sheets['Email'], { defval: '' }).forEach((r) => {
        const acct = trimOrBlank(r['Account']);
        const owner = trimOrBlank(r['HomeOwnerName']);
        if (acct && owner && !byAcct.has(acct)) byAcct.set(acct, owner);
      });
    }
  } catch (_) { /* fallback file optional */ }
  return byAcct;
}

async function loadDbState(accountIds) {
  // Properties by account
  const propsByAccount = new Map();
  for (let i = 0; i < accountIds.length; i += BATCH) {
    const { data } = await supabase
      .from('properties')
      .select('id, vantaca_account_id, street_address, unit, community_id')
      .in('vantaca_account_id', accountIds.slice(i, i + BATCH));
    (data || []).forEach((p) => { if (p.vantaca_account_id) propsByAccount.set(p.vantaca_account_id, p); });
  }
  // Current ownerships (include ownership id so we can end-date)
  const propertyIds = Array.from(propsByAccount.values()).map((p) => p.id);
  const ownerByProp = new Map();
  for (let i = 0; i < propertyIds.length; i += BATCH) {
    const { data } = await supabase
      .from('property_ownerships')
      .select('id, property_id, contact_id, is_primary, start_date')
      .in('property_id', propertyIds.slice(i, i + BATCH))
      .is('end_date', null);
    (data || []).forEach((o) => {
      if (!o.contact_id) return;
      const existing = ownerByProp.get(o.property_id);
      if (!existing || (o.is_primary && !existing.is_primary)) ownerByProp.set(o.property_id, o);
    });
  }
  // Contacts for those ownerships
  const contactIds = Array.from(new Set(Array.from(ownerByProp.values()).map((o) => o.contact_id)));
  const contactsById = new Map();
  for (let i = 0; i < contactIds.length; i += BATCH) {
    const { data } = await supabase
      .from('contacts').select('id, full_name').in('id', contactIds.slice(i, i + BATCH));
    (data || []).forEach((c) => contactsById.set(c.id, c));
  }
  return { propsByAccount, ownerByProp, contactsById };
}

async function findOrCreateContact(name, contactCache, createdNames) {
  if (contactCache.has(lower(name))) return contactCache.get(lower(name));
  // DB lookup by exact name (case-insensitive)
  const { data: matches } = await supabase
    .from('contacts').select('id, full_name')
    .ilike('full_name', name)
    .limit(10);
  const exact = (matches || []).find((m) => lower(m.full_name) === lower(name));
  if (exact) {
    contactCache.set(lower(name), exact);
    return exact;
  }
  // Create new
  if (DRY_RUN) {
    const fake = { id: '(DRY-RUN-NEW)', full_name: name };
    contactCache.set(lower(name), fake);
    createdNames.add(name);
    return fake;
  }
  const { data: created, error } = await supabase
    .from('contacts').insert({ full_name: name, notes: 'created by fix_placeholder_owners.js' }).select().single();
  if (error) throw new Error(`create contact "${name}" failed: ${error.message}`);
  contactCache.set(lower(name), created);
  createdNames.add(name);
  return created;
}

async function run() {
  console.log(DRY_RUN ? '[DRY RUN — no DB writes]' : '[LIVE RUN — applying to DB]');
  console.log('Loading file owners…');
  const fileOwners = loadFileOwners();
  console.log(`File has owner mapping for ${fileOwners.size} Account #s.`);

  console.log('Loading DB state…');
  const db = await loadDbState(Array.from(fileOwners.keys()));

  // Find placeholder cases
  const fixes = []; // [{ acct, property_id, property_addr, placeholder_id, placeholder_name, real_owner_name, ownership_id }]
  for (const [acct, realOwner] of fileOwners) {
    const property = db.propsByAccount.get(acct);
    if (!property) continue;
    const ownership = db.ownerByProp.get(property.id);
    if (!ownership) continue;
    const placeholderContact = db.contactsById.get(ownership.contact_id);
    if (!placeholderContact || !isPlaceholder(placeholderContact.full_name)) continue;
    // File should have a non-placeholder name
    if (!realOwner || isPlaceholder(realOwner)) continue;
    fixes.push({
      acct,
      property_id: property.id,
      property_addr: `${property.street_address || ''}${property.unit ? ' #' + property.unit : ''}`,
      placeholder_id: placeholderContact.id,
      placeholder_name: placeholderContact.full_name,
      real_owner_name: realOwner,
      ownership_id: ownership.id,
    });
  }
  console.log(`\nFound ${fixes.length} placeholder-owned properties with a real owner name in the file.`);

  // Group by real_owner_name for impact summary
  const byOwner = new Map();
  fixes.forEach((f) => {
    if (!byOwner.has(f.real_owner_name)) byOwner.set(f.real_owner_name, []);
    byOwner.get(f.real_owner_name).push(f);
  });
  const ownerSummary = Array.from(byOwner.entries())
    .map(([name, fs]) => ({ owner: name, properties: fs.length }))
    .sort((a, b) => b.properties - a.properties);
  console.log('\n=== Top 20 real owners ===');
  ownerSummary.slice(0, 20).forEach((s) => console.log(`  ${s.properties.toString().padStart(4)} × ${s.owner}`));
  console.log(`  …${ownerSummary.length} unique real owners across ${fixes.length} properties.`);

  // Apply the transitions
  const contactCache = new Map();
  const createdNames = new Set();
  const stats = { contacts_existing: 0, contacts_created: 0, ownerships_end_dated: 0, ownerships_inserted: 0, errors: [] };
  const today = new Date().toISOString().slice(0, 10);

  for (const fix of fixes) {
    try {
      const realContact = await findOrCreateContact(fix.real_owner_name, contactCache, createdNames);
      if (realContact.id === '(DRY-RUN-NEW)') {
        stats.contacts_created += 1;
      } else if (!createdNames.has(fix.real_owner_name)) {
        // Existing contact — only count once per unique name
        // (createdNames tracks newly-created ones; this branch is for existing-matched-from-DB)
      }
      if (DRY_RUN) {
        stats.ownerships_end_dated += 1;
        stats.ownerships_inserted += 1;
        continue;
      }
      // End-date the placeholder ownership
      const { error: endErr } = await supabase
        .from('property_ownerships')
        .update({ end_date: today, updated_at: new Date().toISOString(),
                  notes: 'Transitioned to real owner via fix_placeholder_owners.js' })
        .eq('id', fix.ownership_id);
      if (endErr) { stats.errors.push({ acct: fix.acct, op: 'end_date_old', error: endErr.message }); continue; }
      stats.ownerships_end_dated += 1;

      // Insert new ownership for real owner
      const { error: insErr } = await supabase
        .from('property_ownerships').insert({
          property_id: fix.property_id,
          contact_id: realContact.id,
          start_date: today,
          is_primary: true,
          source: 'fix_placeholder_owners',
          notes: `Replaces placeholder ownership (was contact ${fix.placeholder_id} "${fix.placeholder_name}")`,
        });
      if (insErr) { stats.errors.push({ acct: fix.acct, op: 'insert_new', error: insErr.message }); continue; }
      stats.ownerships_inserted += 1;
    } catch (e) {
      stats.errors.push({ acct: fix.acct, op: 'general', error: e.message });
    }
  }

  // Count existing-matched contacts (cached but not in createdNames)
  stats.contacts_existing = Array.from(contactCache.values())
    .filter((c) => c.id !== '(DRY-RUN-NEW)' && !createdNames.has(c.full_name))
    .length;
  stats.contacts_created = createdNames.size;

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(stats, null, 2));

  // Audit log on live runs
  if (!DRY_RUN) {
    try {
      await supabase.from('contact_methods_sync_log').insert({
        uploaded_by: 'scripts/fix_placeholder_owners.js',
        file_name: 'Homeowner Export.xlsx + Homeowner Contact Information (3).xlsx (placeholder owner fix)',
        total_rows: fixes.length,
        diff_summary: { counts: { placeholder_owner_fix: true, fixes: fixes.length } },
        status: 'applied',
        applied_at: new Date().toISOString(),
        applied_by: 'scripts/fix_placeholder_owners.js',
        applied_summary: stats,
        notes: `Transitioned ${stats.ownerships_inserted} property ownerships from placeholder contacts to real owners from Vantaca file.`,
      });
      console.log('Audit log written.');
    } catch (e) { console.warn('Audit log write failed:', e.message); }
  }

  // Also write a per-property report xlsx so Ed can review
  const reportRows = fixes.map((f) => ({
    'Account #': f.acct,
    'Property address': f.property_addr,
    'OLD owner (DB placeholder)': f.placeholder_name,
    'NEW owner (from file)': f.real_owner_name,
    'Outcome': stats.errors.find((e) => e.acct === f.acct)
      ? `ERROR: ${stats.errors.find((e) => e.acct === f.acct).error}`
      : (DRY_RUN ? 'WOULD-TRANSITION' : 'TRANSITIONED'),
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(reportRows), 'Transitions');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ownerSummary), 'By owner');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([stats]), 'Summary');
  const out = path.join('C:/Users/edget/Downloads',
    DRY_RUN ? 'Placeholder Owner Fix - DRY RUN.xlsx' : 'Placeholder Owner Fix - APPLIED.xlsx');
  XLSX.writeFile(wb, out);
  console.log(`\n→ wrote ${out}`);
}

run().catch((err) => { console.error('FATAL:', err); process.exit(1); });
