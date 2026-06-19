// Backfill the 4 Serene Meadow ARC submittals that came to Ed by email instead
// of through the portal (Ed 2026-06-19). 8118 already exists as SCR-BLD-2026-0013
// with plan UNKNOWN -> UPDATE it. 8003/8007/8011 -> INSERT new records.
// Values read from the PDFs (majority vote across passes). status='received',
// source='manual_entry'. --apply to write; otherwise dry-run.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');

const COMMUNITY_ID = 'a0000000-0000-4000-8000-000000000006';   // Still Creek Ranch
const BUILDER_ID   = '0eda1b79-0526-4e5d-8a4b-5488a0938ed1';   // Lennar
const PLAN_NAME = { '4502': 'Glenbrook II', '4504': 'Melrose II', '4505': 'Somerset', '4506': 'Wakefield II' };

const ROWS = [
  { addr: '8003 Serene Meadow Lane', lot: '12', block: '1', section: '5', plan: '4505', elev: 'B', orient: 'right', sqft: 2666 },
  { addr: '8007 Serene Meadow Lane', lot: '13', block: '1', section: '5', plan: '4506', elev: 'C', orient: 'right', sqft: 2795 },
  { addr: '8011 Serene Meadow Lane', lot: '14', block: '1', section: '5', plan: '4502', elev: 'B', orient: 'right', sqft: 2517 },
  { addr: '8118 Serene Meadow Lane', lot: '1',  block: '1', section: '5', plan: '4504', elev: 'B', orient: 'right', sqft: 2731, existingRef: 'SCR-BLD-2026-0013' },
];
const SUBMITTER = { name: 'Richelle Hearitige', email: 'richelle.hearitige@lennar.com', phone: '281-874-8577' };

(async () => {
  // Approved master-plan match (builder, plan, elevation) -> master_plan_id + fast_track
  const { data: mps } = await s.from('master_plans')
    .select('id, plan_number, elevation, status')
    .eq('builder_company_id', BUILDER_ID).eq('status', 'approved');
  const matchPlan = (plan, elev) =>
    (mps || []).find((m) => m.plan_number === plan && String(m.elevation || '').toUpperCase() === elev.toUpperCase()) || null;

  for (const r of ROWS) {
    const match = matchPlan(r.plan, r.elev);
    const fields = {
      community_id: COMMUNITY_ID,
      builder_company_id: BUILDER_ID,
      submitter_email: SUBMITTER.email,
      submitter_name: SUBMITTER.name,
      submitter_phone: SUBMITTER.phone,
      source: 'manual_entry',
      lot_number: r.lot, block_number: r.block, section_number: r.section,
      street_address: r.addr,
      plan_number: r.plan, plan_name: PLAN_NAME[r.plan] || null,
      elevation: r.elev, elevation_orientation: r.orient,
      square_footage: r.sqft,
      status: 'received',
      master_plan_id: match ? match.id : null,
      fast_track: !!match,
      fast_track_reason: match ? 'Matched approved master plan for this community' : null,
      application_data: { backfilled_from_emailed_pdf: true, ai_extracted: true, backfilled_at_note: '2026-06-19' },
      builder_acknowledgments: {},
    };
    const tag = `${r.addr} -> ${r.plan} ${r.elev}/${r.orient} (${PLAN_NAME[r.plan]})  match=${match ? 'APPROVED ✓' : 'no — needs ' + r.elev + ' master plan'}`;
    if (r.existingRef) {
      console.log(`UPDATE ${r.existingRef}: ${tag}`);
      if (APPLY) {
        const { error } = await s.from('builder_applications').update(fields).eq('reference_number', r.existingRef);
        if (error) console.error('  update failed:', error.message); else console.log('  updated.');
      }
    } else {
      // Guard against re-run duplicates
      const { data: dupe } = await s.from('builder_applications').select('reference_number')
        .eq('community_id', COMMUNITY_ID).eq('street_address', r.addr).maybeSingle();
      if (dupe) { console.log(`SKIP ${r.addr} — already exists as ${dupe.reference_number}`); continue; }
      const { data: counter, error: cErr } = await s.rpc('next_application_counter',
        { p_community_id: COMMUNITY_ID, p_service_type: 'builder_arc', p_year: 2026, p_prefix: 'SCR', p_infix: '-BLD-' });
      if (cErr) { console.error('counter failed:', cErr.message); continue; }
      const ref = `SCR-BLD-2026-${String(counter).padStart(4, '0')}`;
      console.log(`INSERT ${ref}: ${tag}`);
      if (APPLY) {
        const { error } = await s.from('builder_applications').insert({ ...fields, reference_number: ref });
        if (error) console.error('  insert failed:', error.message); else console.log('  inserted.');
      }
    }
  }
  console.log(APPLY ? '\nDONE.' : '\nDRY RUN — pass --apply to write.');
})();
