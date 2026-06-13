// ============================================================================
// scripts/flag_209_re_observations.js
// ----------------------------------------------------------------------------
// Ed 2026-06-13: in the CURRENT inspection cycle (Canyon Gate + Lakes), flag
// every property where:
//   - the photo this cycle is linked to a property, AND
//   - that property already received a certified §209 letter in any prior
//     cycle (interactions.type='letter_209' AND status='sent')
//
// Those properties are the candidates for "log as continuation, don't re-mail."
// The continuation linker (migration 219 + lib/enforcement/find_or_continue_violation)
// will do this automatically on Confirm going forward, but for THIS batch (already
// captured before the linker landed) we need a manual flag report so Ed can:
//   1. confirm these obs as continuations (no new letter)
//   2. let the rest go through normal courtesy_1 drafting
//
// Run: `node scripts/flag_209_re_observations.js`
// Output: per-community list of flagged properties.
// Read-only. No mutations.
// ============================================================================

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

async function auditCommunity(name) {
  console.log('\n========================================================================');
  console.log(`COMMUNITY: ${name}`);
  console.log('========================================================================');

  const { data: comms } = await supabase
    .from('communities')
    .select('id, name')
    .ilike('name', name);
  if (!comms?.length) { console.log('  ✗ community not found'); return; }
  const community = comms[0];

  // Find most recent paused/captured inspection
  const { data: inspections } = await supabase
    .from('inspections')
    .select('id, status, started_at, total_photos, total_observations')
    .eq('community_id', community.id)
    .order('started_at', { ascending: false })
    .limit(10);
  const target = (inspections || []).find((i) => STATUSES_TO_AUDIT.has(i.status));
  if (!target) { console.log('  ✗ no recent paused/captured inspection'); return; }
  console.log(`  Inspection: ${target.id} (${target.status}, ${target.started_at})`);
  console.log(`  total_photos: ${target.total_photos} · total_observations: ${target.total_observations}`);

  // Get all NOT-rejected observations for this inspection
  const { data: obs } = await supabase
    .from('property_observations')
    .select('id, inspection_photo_id, category_id, ai_description, ai_confidence, severity, reviewer_status, enforcement_categories(label)')
    .eq('inspection_id', target.id)
    .neq('reviewer_status', 'rejected');
  console.log(`  Active observations: ${(obs || []).length}`);

  // Get photo->property_id resolution via the inspection_photos columns
  const photoIds = [...new Set((obs || []).map((o) => o.inspection_photo_id).filter(Boolean))];
  let photoMap = new Map();
  if (photoIds.length) {
    const { data: photos } = await supabase
      .from('inspection_photos')
      .select('id, captured_at, storage_path, polygon_match_property_id, reviewer_confirmed_property_id')
      .in('id', photoIds);
    (photos || []).forEach((p) => {
      const propId = p.reviewer_confirmed_property_id || p.polygon_match_property_id || null;
      photoMap.set(p.id, { ...p, active_property_id: propId });
    });
  }

  // Unique property_ids in this batch
  const propertyIds = [...new Set([...photoMap.values()].map((p) => p.active_property_id).filter(Boolean))];
  console.log(`  Unique properties with photos: ${propertyIds.length}`);
  if (!propertyIds.length) return;

  // Owner + address lookup — use v_current_property_owners which is what
  // the violation-letter render path uses. Base properties table has
  // property_id as the PK, NOT id (earlier confusion). The view exposes
  // owner_name + owner_mailing_address joined from contacts.
  const { data: props } = await supabase
    .from('v_current_property_owners')
    .select('property_id, street_address, unit, owner_name, owner_mailing_address')
    .in('property_id', propertyIds);
  const propsById = new Map((props || []).map((p) => [p.property_id, p]));
  console.log(`  Property roster fetched: ${propsById.size} of ${propertyIds.length}`);

  // CORE QUERY — two-signal check:
  //   Signal A: interactions row of type='letter_209' status='sent'
  //             (truth-source for letters Bedrock sent through trustEd)
  //   Signal B: violations row with current_stage='certified_209' or that
  //             ever passed through certified_209 (truth-source for the
  //             Vantaca-imported historical violations — those have the
  //             stage set without an interactions log).
  // ANY match on either signal flags the property.
  // Note: signal B is broader — "violation reached the certified_209 stage"
  // is a stronger signal than "we mailed a letter" because vantaca import
  // records stage without logging the letter event.
  const { data: prior209Int } = await supabase
    .from('interactions')
    .select('id, property_id, violation_id, sent_at, created_at, certified_tracking_number')
    .in('property_id', propertyIds)
    .eq('type', 'letter_209')
    .eq('status', 'sent')
    .order('sent_at', { ascending: false, nullsFirst: false });

  const { data: prior209Vio } = await supabase
    .from('violations')
    .select('id, property_id, primary_category_id, current_stage, opened_at, current_stage_started_at, cure_period_ends_at, resolved_at, resolved_via, enforcement_categories(label)')
    .in('property_id', propertyIds)
    .in('current_stage', ['certified_209', 'fine_assessed', 'cured', 'closed'])
    // We include cured/closed because Ed wants to know if certified was ever
    // sent — even if the homeowner eventually cured, a new violation now is
    // important context for how to handle the homeowner.
    .order('opened_at', { ascending: false });

  // Build per-property signal map. Prefer interaction (specific date) over
  // violation (stage-only signal) for the "sent date" display.
  const flagByProperty = new Map();
  (prior209Vio || []).forEach((v) => {
    const cur = flagByProperty.get(v.property_id);
    if (!cur || new Date(v.opened_at) > new Date(cur.signal_date || 0)) {
      flagByProperty.set(v.property_id, {
        property_id: v.property_id,
        signal: 'historical_violation',
        signal_date: v.current_stage_started_at || v.opened_at,
        violation_id: v.id,
        prior_category: v.enforcement_categories?.label,
        prior_stage: v.current_stage,
        cure_period_ends_at: v.cure_period_ends_at,
        resolved_at: v.resolved_at,
        resolved_via: v.resolved_via,
      });
    }
  });
  // Interaction signal wins where present (more specific)
  (prior209Int || []).forEach((i) => {
    const cur = flagByProperty.get(i.property_id) || {};
    flagByProperty.set(i.property_id, {
      ...cur,
      property_id: i.property_id,
      signal: 'letter_logged',
      signal_date: i.sent_at || i.created_at,
      interaction_id: i.id,
      tracking_number: i.certified_tracking_number,
    });
  });

  console.log(`  Properties with PRIOR §209 (interaction log): ${(prior209Int || []).length}`);
  console.log(`  Properties with PRIOR violation that reached certified_209+ stage: ${flagByProperty.size}`);
  const mostRecent209ByProperty = flagByProperty;

  if (mostRecent209ByProperty.size === 0) {
    console.log('  ✓ No re-observations of §209-mailed properties in this batch.');
    return;
  }

  // Build the flag list. For each property with a prior §209, list every
  // observation tied to it in the current cycle.
  console.log('\n  ─ FLAGGED: prior §209 sent + new photo this cycle ─');
  let flagN = 0;
  for (const obsRow of (obs || [])) {
    const photo = photoMap.get(obsRow.inspection_photo_id);
    if (!photo || !photo.active_property_id) continue;
    const prior = mostRecent209ByProperty.get(photo.active_property_id);
    if (!prior) continue;
    flagN++;
    const prop = propsById.get(photo.active_property_id);
    const sentDate = prior.signal_date;
    const daysSince = sentDate
      ? Math.floor((Date.now() - new Date(sentDate).getTime()) / 86400000)
      : null;
    const signalLabel = prior.signal === 'letter_logged'
      ? 'Prior §209 letter (logged)'
      : 'Prior violation reached §209 stage';
    const sameCategory = prior.prior_category && obsRow.enforcement_categories?.label
      && prior.prior_category.toLowerCase() === obsRow.enforcement_categories.label.toLowerCase();
    console.log(`\n  ${flagN}. ${shortAddr(prop)}  ${sameCategory ? '⚠ SAME CATEGORY' : ''}`);
    console.log(`     Owner:           ${prop?.owner_name || '(missing)'}`);
    console.log(`     Signal:          ${signalLabel}`);
    console.log(`     Prior date:      ${sentDate || '(unknown)'} (${daysSince ?? '?'} days ago)`);
    if (prior.prior_category) {
      console.log(`     Prior category:  ${prior.prior_category} (stage ${prior.prior_stage}${prior.resolved_at ? ', resolved ' + prior.resolved_via : ', still open'})`);
    }
    if (prior.tracking_number) {
      console.log(`     Tracking #:      ${prior.tracking_number}`);
    }
    console.log(`     New observation: ${obsRow.enforcement_categories?.label || '(no category)'} · severity ${obsRow.severity || '?'} · conf ${obsRow.ai_confidence ?? '?'}`);
    console.log(`     AI says:         ${(obsRow.ai_description || '').slice(0, 160).replace(/\s+/g, ' ')}`);
    console.log(`     Observation id:  ${obsRow.id}`);
    if (prior.violation_id) {
      console.log(`     Prior violation: ${prior.violation_id}`);
    }
  }

  console.log(`\n  ─ ${flagN} observation(s) flagged in this community ─`);
  console.log('  Action: confirm each as a CONTINUATION (no new letter) rather than');
  console.log('  letting it draft a fresh courtesy_1. Once the linker is fully wired');
  console.log('  on the manual + bulk paths, this happens automatically on Confirm.');
}

(async () => {
  for (const c of COMMUNITIES) {
    try { await auditCommunity(c); } catch (e) { console.error('failed:', c, e.message); }
  }
  console.log('\n========================================================================');
  console.log('DONE.');
  console.log('========================================================================');
  process.exit(0);
})();
