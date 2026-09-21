#!/usr/bin/env node
/**
 * seed_demo_dc_occupancy.js — surfaces the existing Drama Creek personas'
 * canonical occupancy so the Community Map Owner/Renter layer is meaningful.
 * Owner-occupied for the 12 resident personas; Tom Investorson's property is the
 * designed rental (a tenant lives there). Through the real property_residencies
 * table, keyed to the personas' current ownerships. Idempotent.
 *
 *   node scripts/seed_demo_dc_occupancy.js --execute
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const EXECUTE = process.argv.includes('--execute');
const DC = 'dc100000-0000-4000-a000-000000000000';
const TENANT_CONTACT = 'dc1a0001-0000-4000-a000-000000000000';

async function main() {
  // Current persona ownerships (13). Tom Investorson = the rental.
  const { data: owns, error } = await sb.from('property_ownerships')
    .select('property_id, contact_id, start_date, contacts(full_name)')
    .in('property_id', (await sb.from('properties').select('id, street_address').eq('community_id', DC).limit(2000))
      .data.filter((p) => /^DC-\d+-\d+$/.test(p.street_address)).map((p) => p.id));
  if (error) throw new Error('ownerships: ' + error.message);
  const personaOwns = (owns || []).filter((o) => o.contacts && o.contacts.full_name);
  console.log(`${EXECUTE ? 'EXECUTE' : 'DRY RUN'} — ${personaOwns.length} persona properties -> residency rows`);
  if (!EXECUTE) { console.log('(12 owner_occupied + Tom Investorson renter)'); return; }

  // A tenant for the Investorson rental (so it reads as a real renter, not the owner).
  await sb.from('contacts').upsert({ id: TENANT_CONTACT, full_name: 'Dana Rentwell', primary_email: 'dana.rentwell@dramacreekhoa.demo', notes: 'Demo tenant renting Tom Investorson’s property.' }, { onConflict: 'id' });

  let ownerOcc = 0, renter = 0;
  for (const o of personaOwns) {
    const isRental = o.contacts.full_name === 'Tom Investorson';
    // idempotent: one current residency per property
    await sb.from('property_residencies').delete().eq('property_id', o.property_id).is('end_date', null);
    const row = {
      property_id: o.property_id, start_date: o.start_date || '2020-01-01',
      residency_type: isRental ? 'renter' : 'owner_occupied',
      contact_id: isRental ? TENANT_CONTACT : o.contact_id,
      source: 'demo_seed',
    };
    const { error: rErr } = await sb.from('property_residencies').insert(row);
    if (rErr) throw new Error('residency ' + o.property_id + ': ' + rErr.message);
    if (isRental) renter++; else ownerOcc++;
  }
  console.log(`residencies: ${ownerOcc} owner_occupied, ${renter} renter (Tom Investorson).`);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
