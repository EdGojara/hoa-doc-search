// Pre-Finalize quality report for the FIRST production violation batch.
// Ed 2026-06-13. Canyon Gate at Cinco Ranch + Lakes of Pine Forest.
//
// Pulls every property_observation tied to the most recent paused/captured
// inspection in each community and renders a spot-check report so Ed can
// eyeball the data BEFORE Finalize creates drafts. Looking for:
//   - missing property links (orphaned photos)
//   - missing owner names / mailing addresses
//   - low AI confidence
//   - same address with multiple observations (multi-violation flag)
//   - addresses with photos but no observation (orphan unanalyzed)
//
// Run: `node scripts/preflight_first_violations.js`
// Output: console table + a sampling block. No mutations.

require('dotenv').config({ override: true });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const COMMUNITIES = [
  'Canyon Gate at Cinco Ranch',
  'Lakes of Pine Forest',
];

const STATUSES_TO_AUDIT = new Set(['captured', 'paused']);

function shortAddr(prop) {
  if (!prop) return '(no property linked)';
  const a = (prop.street_address || '').trim();
  const u = (prop.unit || '').trim();
  return u ? `${a} #${u}` : a || '(blank)';
}

function pickRecent(rows) {
  return rows.find((r) => STATUSES_TO_AUDIT.has(r.status));
}

async function auditCommunity(name) {
  console.log('\n========================================================================');
  console.log(`COMMUNITY: ${name}`);
  console.log('========================================================================');

  const { data: comms } = await supabase
    .from('communities')
    .select('id, name')
    .ilike('name', name);
  if (!comms || !comms.length) { console.log('  ✗ community not found'); return; }
  const community = comms[0];

  // Total property roster size (canonical truth source — Preview cross-check rule)
  const { count: rosterCount } = await supabase
    .from('properties')
    .select('property_id', { count: 'exact', head: true })
    .eq('community_id', community.id);
  console.log(`  Roster size (canonical): ${rosterCount} properties`);

  // Recent inspections — sorted newest first, pick most recent paused/captured
  const { data: inspections } = await supabase
    .from('inspections')
    .select('id, status, started_at, ended_at, total_photos, total_observations, mode, route_label')
    .eq('community_id', community.id)
    .order('started_at', { ascending: false })
    .limit(10);

  const target = pickRecent(inspections || []);
  if (!target) {
    console.log('  ✗ no recent paused/captured inspection found');
    return;
  }
  console.log(`  Inspection: ${target.id}`);
  console.log(`    started_at: ${target.started_at} · status: ${target.status} · mode: ${target.mode}`);
  console.log(`    total_photos: ${target.total_photos} · total_observations: ${target.total_observations}`);

  // Pull all observations for this inspection
  const { data: obs, error: obsErr } = await supabase
    .from('property_observations')
    .select(`
      id, inspection_photo_id, property_id, severity,
      ai_description, ai_confidence, ai_recommended_action,
      reviewer_status, reviewer_notes, category_id, created_at,
      enforcement_categories ( label )
    `)
    .eq('inspection_id', target.id)
    .order('created_at', { ascending: false });
  if (obsErr) { console.log('  ✗ observations query failed:', obsErr.message); return; }
  console.log(`  Observations fetched: ${(obs || []).length}`);

  // Pull all photos for the inspection (to detect orphans — photos with no observation)
  const { data: photos } = await supabase
    .from('inspection_photos')
    .select('id, property_id, captured_at, storage_path')
    .eq('inspection_id', target.id);
  const observedPhotoIds = new Set((obs || []).map((o) => o.inspection_photo_id).filter(Boolean));
  const orphanPhotos = (photos || []).filter((p) => !observedPhotoIds.has(p.id));
  console.log(`  Photos total: ${(photos || []).length} · orphan (no observation): ${orphanPhotos.length}`);

  // Pull property + owner data for all linked properties (single batch query)
  const propertyIds = [...new Set((obs || []).map((o) => o.property_id).filter(Boolean))];
  let propsById = new Map();
  if (propertyIds.length) {
    const { data: props } = await supabase
      .from('properties')
      .select('property_id, street_address, unit, city, state, zip, owner_name, owner_mailing_address')
      .in('property_id', propertyIds);
    propsById = new Map((props || []).map((p) => [p.property_id, p]));
  }

  // Quality flags
  let missingPropertyLink = 0;
  let missingOwnerName = 0;
  let missingMailingAddr = 0;
  let lowConfidence = 0;  // AI confidence < 0.6
  const addrCounts = new Map();

  (obs || []).forEach((o) => {
    const prop = o.property_id ? propsById.get(o.property_id) : null;
    if (!o.property_id) missingPropertyLink++;
    if (prop && !prop.owner_name) missingOwnerName++;
    if (prop && !prop.owner_mailing_address) missingMailingAddr++;
    if (typeof o.ai_confidence === 'number' && o.ai_confidence < 0.6) lowConfidence++;
    const addr = shortAddr(prop);
    addrCounts.set(addr, (addrCounts.get(addr) || 0) + 1);
  });

  const multiViolationAddrs = [...addrCounts.entries()].filter(([, n]) => n > 1);

  console.log('\n  ─ Quality flags ─');
  console.log(`    Missing property link (orphan observation): ${missingPropertyLink}`);
  console.log(`    Missing owner name on linked property:     ${missingOwnerName}`);
  console.log(`    Missing mailing address on linked property:${missingMailingAddr}`);
  console.log(`    Low AI confidence (<0.6):                  ${lowConfidence}`);
  console.log(`    Addresses with multiple violations:        ${multiViolationAddrs.length}`);
  console.log(`    Orphan photos (uploaded, no observation):  ${orphanPhotos.length}`);

  // Print 5 random observations for spot-check
  const sample = [...(obs || [])].sort(() => Math.random() - 0.5).slice(0, 5);
  console.log('\n  ─ Random sample for spot-check (5 observations) ─');
  sample.forEach((o, i) => {
    const prop = o.property_id ? propsById.get(o.property_id) : null;
    const photoUrl = (() => {
      const p = (photos || []).find((x) => x.id === o.inspection_photo_id);
      if (!p || !p.storage_path) return '(no photo)';
      const { data: signed } = supabase.storage.from('inspection-photos').getPublicUrl(p.storage_path);
      return signed?.publicUrl || '(no signed url)';
    })();
    console.log(`  ${i + 1}. obs ${o.id}`);
    console.log(`     Property:   ${shortAddr(prop)}`);
    console.log(`     Owner:      ${prop?.owner_name || '(missing)'}`);
    console.log(`     Mailing:    ${prop?.owner_mailing_address || '(missing)'}`);
    console.log(`     Category:   ${o.enforcement_categories?.label || '(none)'} · severity: ${o.severity || '?'}`);
    console.log(`     AI says:    ${(o.ai_description || '').slice(0, 140).replace(/\s+/g, ' ')}`);
    console.log(`     Confidence: ${o.ai_confidence ?? '(none)'}`);
    console.log(`     Photo:      ${photoUrl}`);
  });

  if (multiViolationAddrs.length) {
    console.log('\n  ─ Multi-violation addresses (review dedup before mail) ─');
    multiViolationAddrs.slice(0, 10).forEach(([addr, n]) => {
      console.log(`    ${n}× ${addr}`);
    });
  }
}

(async () => {
  for (const c of COMMUNITIES) {
    try { await auditCommunity(c); } catch (e) { console.error('failed:', c, e.message); }
  }
  console.log('\n========================================================================');
  console.log('DONE. Review flags above. Acceptable thresholds for first batch:');
  console.log('  - Missing property link:    0  (any orphan = Back-fill orphans before Finalize)');
  console.log('  - Missing owner name:       0  (no letter goes to "Dear Homeowner")');
  console.log('  - Missing mailing address:  0  (letter literally cannot be mailed)');
  console.log('  - Low AI confidence:        spot-check those individually');
  console.log('  - Multi-violation address:  fine if intentional, confirm UI groups them');
  console.log('  - Orphan photos:            run Back-fill orphans button before Finalize');
  console.log('========================================================================');
  process.exit(0);
})();
