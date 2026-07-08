// scripts/export_waterview.js
// ----------------------------------------------------------------------------
// Dumps Waterview Estates' current DB state to an xlsx for review.
//
// Sheets:
//   1. Properties — every Waterview property with current owner + residency + AR snapshot
//   2. Contacts — every contact who's a current owner OR resident at a Waterview property
//   3. Contact methods — all emails + phones for those contacts (with notification toggles)
//   4. Active leases — v_active_leases filtered to Waterview
//   5. Placeholder cleanup — Waterview properties whose DB owner is a placeholder
// ----------------------------------------------------------------------------

require('dotenv').config();
const XLSX = require('xlsx');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const PLACEHOLDER_NAMES = new Set([
  '', 'current resident', 'current owner', 'unknown', 'unknown owner',
  'occupant', 'owner', 'tenant', 'resident', 'n/a', 'na',
]);
const isPlaceholder = (n) => PLACEHOLDER_NAMES.has(String(n || '').trim().toLowerCase());

async function main() {
  console.log('Locating Waterview Estates…');
  const { data: communities, error: cErr } = await supabase
    .from('communities').select('id, name, slug')
    .or('name.ilike.%waterview%,slug.ilike.%waterview%')
    .limit(5);
  if (cErr) throw cErr;
  if (!communities || communities.length === 0) throw new Error('No Waterview community found');
  console.log('Matched communities:', communities.map((c) => `${c.name} [${c.slug}]`).join('; '));
  const community = communities[0];
  console.log(`Using: ${community.name} (id=${community.id})`);

  // Properties — paginate because Supabase default cap is 1000 rows/query
  console.log('Loading properties (paginated)…');
  const properties = [];
  const PAGE = 1000;
  let start = 0;
  while (true) {
    const { data, error: pErr } = await supabase
      .from('properties')
      .select('id, street_address, unit, city, state, zip, lot_number, vantaca_account_id')
      .eq('community_id', community.id)
      .order('street_address')
      .range(start, start + PAGE - 1);
    if (pErr) throw pErr;
    properties.push(...(data || []));
    if (!data || data.length < PAGE) break;
    start += PAGE;
  }
  console.log(`${properties.length} properties.`);

  // Current ownerships
  const propertyIds = properties.map((p) => p.id);
  const BATCH = 200;
  const ownerByProp = new Map();
  for (let i = 0; i < propertyIds.length; i += BATCH) {
    const { data } = await supabase
      .from('property_ownerships')
      .select('property_id, contact_id, is_primary, start_date, vesting')
      .in('property_id', propertyIds.slice(i, i + BATCH))
      .is('end_date', null);
    (data || []).forEach((o) => {
      const existing = ownerByProp.get(o.property_id);
      if (!existing || (o.is_primary && !existing.is_primary)) ownerByProp.set(o.property_id, o);
    });
  }
  console.log(`${ownerByProp.size} properties with current owner.`);

  // Current residencies
  const residencyByProp = new Map();
  for (let i = 0; i < propertyIds.length; i += BATCH) {
    const { data } = await supabase
      .from('property_residencies')
      .select('property_id, contact_id, residency_type, start_date, lease_start_date, lease_end_date, monthly_rent, security_deposit, notes_renter, lease_pdf_path')
      .in('property_id', propertyIds.slice(i, i + BATCH))
      .is('end_date', null);
    (data || []).forEach((r) => residencyByProp.set(r.property_id, r));
  }
  console.log(`${residencyByProp.size} properties with current residency.`);

  // Contacts (union of owners + residents)
  const contactIds = Array.from(new Set([
    ...Array.from(ownerByProp.values()).map((o) => o.contact_id).filter(Boolean),
    ...Array.from(residencyByProp.values()).map((r) => r.contact_id).filter(Boolean),
  ]));
  const contactsById = new Map();
  for (let i = 0; i < contactIds.length; i += BATCH) {
    const { data } = await supabase
      .from('contacts')
      .select('id, full_name, preferred_name, primary_email, secondary_email, primary_phone, secondary_phone, mailing_address, preferred_language, sms_opt_in, email_opt_out')
      .in('id', contactIds.slice(i, i + BATCH));
    (data || []).forEach((c) => contactsById.set(c.id, c));
  }
  console.log(`${contactsById.size} unique contacts (owners + residents).`);

  // Contact methods
  const methodsByContact = new Map();
  for (let i = 0; i < contactIds.length; i += BATCH) {
    const { data } = await supabase
      .from('contact_methods')
      .select('contact_id, method_type, subtype, value, label, is_primary, notify_general, notify_events, notify_billing, notify_violations, notify_arc_decisions, notify_emergency, notify_payment_confirm')
      .in('contact_id', contactIds.slice(i, i + BATCH));
    (data || []).forEach((m) => {
      if (!methodsByContact.has(m.contact_id)) methodsByContact.set(m.contact_id, []);
      methodsByContact.get(m.contact_id).push(m);
    });
  }
  console.log(`${Array.from(methodsByContact.values()).reduce((s, a) => s + a.length, 0)} contact_methods rows.`);

  // Active leases (Waterview only)
  const { data: activeLeases } = await supabase
    .from('v_active_leases')
    .select('*')
    .in('property_id', propertyIds);
  console.log(`${(activeLeases || []).length} active leases.`);

  // AR snapshots (latest per property)
  const arByProp = new Map();
  for (let i = 0; i < propertyIds.length; i += BATCH) {
    const { data } = await supabase
      .from('owner_ar_snapshots')
      .select('property_id, snapshot_date, balance_total, enforcement_stage, at_legal, in_collections, payment_plan_active')
      .in('property_id', propertyIds.slice(i, i + BATCH))
      .order('snapshot_date', { ascending: false });
    (data || []).forEach((r) => { if (!arByProp.has(r.property_id)) arByProp.set(r.property_id, r); });
  }

  // ----------------------------------------------------------------------
  // Build the sheets
  // ----------------------------------------------------------------------

  // Sheet 1: Properties (one row per property with combined owner/residency/AR)
  const propsSheet = properties.map((p) => {
    const own = ownerByProp.get(p.id);
    const res = residencyByProp.get(p.id);
    const ownerContact = own ? contactsById.get(own.contact_id) : null;
    const residentContact = res ? contactsById.get(res.contact_id) : null;
    const ar = arByProp.get(p.id);
    return {
      'Vantaca acct #': p.vantaca_account_id || '',
      'Address': `${p.street_address || ''}${p.unit ? ' #' + p.unit : ''}`,
      'City': p.city || '',
      'Zip': p.zip || '',
      'Lot': p.lot_number || '',
      'Current owner': ownerContact ? ownerContact.full_name : '',
      'Owner placeholder?': ownerContact && isPlaceholder(ownerContact.full_name) ? 'YES' : '',
      'Owner email': ownerContact?.primary_email || '',
      'Owner phone': ownerContact?.primary_phone || '',
      'Owner mailing': ownerContact?.mailing_address || '',
      'Vesting': own?.vesting || '',
      'Owned since': own?.start_date || '',
      'Residency type': res?.residency_type || '',
      'Resident': residentContact ? residentContact.full_name : '',
      'Lease start': res?.lease_start_date || '',
      'Lease end': res?.lease_end_date || '',
      'Monthly rent': res?.monthly_rent || '',
      'AR balance': ar?.balance_total != null ? ar.balance_total : '',
      'AR stage': ar?.enforcement_stage || '',
      'AR snapshot date': ar?.snapshot_date || '',
    };
  });

  // Sheet 2: Contacts
  const contactsSheet = Array.from(contactsById.values()).map((c) => {
    const ms = methodsByContact.get(c.id) || [];
    return {
      'Contact id': c.id,
      'Full name': c.full_name || '',
      'Preferred name': c.preferred_name || '',
      'Placeholder?': isPlaceholder(c.full_name) ? 'YES' : '',
      'Primary email (flat)': c.primary_email || '',
      'Secondary email (flat)': c.secondary_email || '',
      'Primary phone (flat)': c.primary_phone || '',
      'Secondary phone (flat)': c.secondary_phone || '',
      'Mailing address': c.mailing_address || '',
      'Preferred language': c.preferred_language || '',
      'SMS opt-in': c.sms_opt_in ? 'YES' : '',
      'Email opt-out': c.email_opt_out ? 'YES' : '',
      'Email count (methods)': ms.filter((m) => m.method_type === 'email').length,
      'Phone count (methods)': ms.filter((m) => m.method_type === 'phone').length,
    };
  }).sort((a, b) => (a['Full name'] || '').localeCompare(b['Full name'] || ''));

  // Sheet 3: Contact methods (long-form: one row per method)
  const methodsSheet = [];
  contactsById.forEach((c) => {
    (methodsByContact.get(c.id) || []).forEach((m) => {
      methodsSheet.push({
        'Contact': c.full_name || '',
        'Type': m.method_type,
        'Value': m.value,
        'Subtype': m.subtype || '',
        'Label': m.label || '',
        'Primary?': m.is_primary ? 'YES' : '',
        'Notify general': m.notify_general ? 'YES' : '',
        'Notify events': m.notify_events ? 'YES' : '',
        'Notify billing': m.notify_billing ? 'YES' : '',
        'Notify violations': m.notify_violations ? 'YES' : '',
        'Notify ARC': m.notify_arc_decisions ? 'YES' : '',
        'Notify emergency': m.notify_emergency ? 'YES' : '',
        'Notify pay-confirm': m.notify_payment_confirm ? 'YES' : '',
      });
    });
  });
  methodsSheet.sort((a, b) => (a.Contact || '').localeCompare(b.Contact || '') || a.Type.localeCompare(b.Type));

  // Sheet 4: Active leases
  const leasesSheet = (activeLeases || []).map((l) => ({
    'Property id': l.property_id,
    'Renter': l.renter_name || '',
    'Renter email': l.renter_email || '',
    'Renter phone': l.renter_phone || '',
    'Residency start': l.residency_start || '',
    'Lease start': l.lease_start_date || '',
    'Lease end': l.lease_end_date || '',
    'Status': l.lease_active ? 'ACTIVE' : 'EXPIRED-OR-NONE',
    'Days remaining': l.days_until_lease_expires != null ? l.days_until_lease_expires : '',
    'Expiring within 60d?': l.expiring_within_60_days ? 'YES' : '',
    'Monthly rent': l.monthly_rent || '',
    'Security deposit': l.security_deposit || '',
    'Renewals': l.lease_renewal_count || 0,
    'PDF path': l.lease_pdf_path || '',
    'Renter notes': l.notes_renter || '',
  }));

  // Sheet 5: Placeholder cleanup
  const placeholderSheet = properties.map((p) => {
    const own = ownerByProp.get(p.id);
    const ownerContact = own ? contactsById.get(own.contact_id) : null;
    if (!ownerContact || !isPlaceholder(ownerContact.full_name)) return null;
    return {
      'Vantaca acct #': p.vantaca_account_id || '',
      'Property address': `${p.street_address || ''}${p.unit ? ' #' + p.unit : ''}`,
      'DB owner name (placeholder)': ownerContact.full_name,
      'DB owner contact id': ownerContact.id,
      'Action': 'Fix property ownership in Vantaca (record real owner), re-import via Homes & Owners, then re-run apply_reconciliation.js',
    };
  }).filter(Boolean);

  // Summary
  const summary = [{
    'Community': community.name,
    'Total properties': properties.length,
    'Properties with current owner': ownerByProp.size,
    'Properties with current residency': residencyByProp.size,
    'Unique contacts (owners + residents)': contactsById.size,
    'Contact methods rows': Array.from(methodsByContact.values()).reduce((s, a) => s + a.length, 0),
    'Active leases': (activeLeases || []).length,
    'Leases expiring within 60d': (activeLeases || []).filter((l) => l.expiring_within_60_days).length,
    'Placeholder-owner properties': placeholderSheet.length,
  }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(propsSheet), 'Properties');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(contactsSheet), 'Contacts');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(methodsSheet), 'Contact Methods');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(leasesSheet), 'Active Leases');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(placeholderSheet), 'Placeholder Cleanup');

  const out = path.join('C:/Users/edget/Downloads', 'Waterview - trustEd DB Snapshot.xlsx');
  XLSX.writeFile(wb, out);
  console.log(`\nSummary:`, JSON.stringify(summary[0], null, 2));
  console.log(`\n→ wrote ${out}`);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
