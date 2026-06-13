// Diagnose: are photos in any inspection linked to properties from a
// DIFFERENT community? If yes, the polygon-match step is matching
// across community boundaries and that's the cross-community mix Ed sees
// in View photos.

require('dotenv').config({ override: true });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const COMMUNITIES = ['Waterview Estates', 'Lakes of Pine Forest', 'Canyon Gate at Cinco Ranch'];
const ACTIVE_STATUSES = new Set(['captured', 'paused', 'in_progress']);

(async () => {
  for (const name of COMMUNITIES) {
    const { data: comms } = await supabase.from('communities').select('id, name').ilike('name', name);
    if (!comms?.length) { console.log(`✗ ${name} not found`); continue; }
    const cid = comms[0].id;

    const { data: inspections } = await supabase
      .from('inspections')
      .select('id, status, started_at, total_photos')
      .eq('community_id', cid)
      .order('started_at', { ascending: false })
      .limit(5);
    const target = (inspections || []).find((i) => ACTIVE_STATUSES.has(i.status));
    if (!target) { console.log(`\n${name}: no active inspection`); continue; }

    const { data: photos } = await supabase
      .from('inspection_photos')
      .select('id, polygon_match_property_id, reviewer_confirmed_property_id')
      .eq('inspection_id', target.id);

    const propertyIds = [...new Set((photos || [])
      .map((p) => p.reviewer_confirmed_property_id || p.polygon_match_property_id)
      .filter(Boolean))];

    if (!propertyIds.length) {
      console.log(`\n${name}: ${(photos || []).length} photos, 0 with property link`);
      continue;
    }

    const { data: props } = await supabase
      .from('properties')
      .select('id, community_id, street_address, communities(name)')
      .in('id', propertyIds);

    const tallies = new Map();
    (props || []).forEach((p) => {
      const cname = p.communities?.name || '(unknown)';
      tallies.set(cname, (tallies.get(cname) || 0) + 1);
    });

    console.log(`\n${name} — inspection ${target.id} (${target.status})`);
    console.log(`  ${(photos || []).length} photos, ${propertyIds.length} unique linked properties`);
    console.log(`  Linked properties by community:`);
    for (const [c, n] of [...tallies.entries()].sort((a, b) => b[1] - a[1])) {
      const marker = c === name ? '✓' : '⚠ CROSS-COMMUNITY';
      console.log(`    ${marker} ${c}: ${n}`);
    }

    // List the cross-community ones in detail
    const wrongs = (props || []).filter((p) => p.communities?.name !== name);
    if (wrongs.length) {
      console.log(`  Cross-community properties (these should NOT be in this inspection):`);
      wrongs.slice(0, 10).forEach((p) => {
        console.log(`    ${p.street_address}  (community: ${p.communities?.name})  property_id: ${p.id}`);
      });
      if (wrongs.length > 10) console.log(`    ... +${wrongs.length - 10} more`);
    }
  }
  process.exit(0);
})();
