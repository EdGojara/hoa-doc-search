// scripts/show_mailing_conflicts.js
// Shows the mailing-address conflicts: file has one, DB has a different one.
// Prints to stdout; also writes an xlsx for review/decision.

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
const trimOrBlank = (v) => v === undefined || v === null ? '' : String(v).trim();
const lower = (v) => String(v || '').trim().toLowerCase();

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
    if (!byAcct.has(acct)) byAcct.set(acct, { homeowner_names: new Set(), mailings: [] });
    return byAcct.get(acct);
  };
  // Contact Info (3-tab)
  const ciWb = XLSX.readFile(path.join('C:/Users/edget/Downloads', 'Homeowner Contact Information (3).xlsx'));
  if (ciWb.SheetNames.includes('Address')) {
    XLSX.utils.sheet_to_json(ciWb.Sheets['Address'], { defval: '' }).forEach((r) => {
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
  // Export (single sheet)
  const expWb = XLSX.readFile(path.join('C:/Users/edget/Downloads', 'Homeowner Export.xlsx'));
  XLSX.utils.sheet_to_json(expWb.Sheets[expWb.SheetNames[0]], { defval: '' }).forEach((r) => {
    const acct = trimOrBlank(r['Account #']);
    if (!acct) return;
    const entry = get(acct);
    if (r['Homeowner']) entry.homeowner_names.add(trimOrBlank(r['Homeowner']));
    const composed = parseCompositeAddress(r['Address']);
    if (composed.mailing) entry.mailings.push({ value: composed.mailing, source: 'export' });
  });
  return byAcct;
}

(async () => {
  const byAcct = loadFiles();
  const accountIds = Array.from(byAcct.keys());

  // DB lookup chain
  const propsByAccount = new Map();
  for (let i = 0; i < accountIds.length; i += BATCH) {
    const { data } = await supabase
      .from('properties').select('id, vantaca_account_id, street_address, unit')
      .in('vantaca_account_id', accountIds.slice(i, i + BATCH));
    (data || []).forEach((p) => { if (p.vantaca_account_id) propsByAccount.set(p.vantaca_account_id, p); });
  }
  const propertyIds = Array.from(propsByAccount.values()).map((p) => p.id);
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
  const contactIds = Array.from(new Set(Array.from(ownerByProp.values()).map((o) => o.contact_id)));
  const contactsById = new Map();
  for (let i = 0; i < contactIds.length; i += BATCH) {
    const { data } = await supabase
      .from('contacts').select('id, full_name, mailing_address')
      .in('id', contactIds.slice(i, i + BATCH));
    (data || []).forEach((c) => contactsById.set(c.id, c));
  }

  // Find conflicts (also dedup by contact_id since corporate landlords own multiple properties)
  const conflicts = [];
  const seenContacts = new Set();
  for (const [acct, file] of byAcct) {
    const property = propsByAccount.get(acct);
    if (!property) continue;
    const ownership = ownerByProp.get(property.id);
    if (!ownership) continue;
    const contact = contactsById.get(ownership.contact_id);
    if (!contact || isPlaceholder(contact.full_name)) continue;
    if (file.mailings.length === 0) continue;
    const fileMailing = file.mailings[0].value.trim();
    const dbMailing = (contact.mailing_address || '').trim();
    if (!dbMailing || !fileMailing) continue;
    if (lower(dbMailing) === lower(fileMailing)) continue;
    // Conflict — but dedup by contact (so corporate landlords' shared contact shows once)
    const key = contact.id;
    if (seenContacts.has(key)) continue;
    seenContacts.add(key);
    conflicts.push({
      account: acct,
      property_address: `${property.street_address || ''}${property.unit ? ' #' + property.unit : ''}`,
      owner: contact.full_name,
      db_mailing: contact.mailing_address,
      file_mailing: fileMailing,
      file_source: file.mailings[0].source,
    });
  }

  console.log(`\n=== ${conflicts.length} unique mailing conflicts ===\n`);
  conflicts.forEach((c, i) => {
    console.log(`${i + 1}. Acct ${c.account} — ${c.property_address}`);
    console.log(`   Owner: ${c.owner}`);
    console.log(`   DB:   "${c.db_mailing}"`);
    console.log(`   File: "${c.file_mailing}"  [from ${c.file_source}]`);
    console.log('');
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(conflicts), 'Mailing Conflicts');
  const out = path.join('C:/Users/edget/Downloads', 'Mailing Conflicts.xlsx');
  XLSX.writeFile(wb, out);
  console.log(`→ wrote ${out}`);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
