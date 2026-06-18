// ============================================================================
// scripts/cleanup_vantaca_phantom_open.js
// ----------------------------------------------------------------------------
// Ed 2026-06-18: an earlier Vantaca import (before the _normalizeStage fix)
// turned "Closed" / "Owner Response" rows into OPEN courtesy_1 violations —
// phantom first notices that inflate the open list and would generate wrong
// letters. This re-derives each OPEN vantaca_import violation's stage from its
// original Vantaca label (stored in resolved_notes) using the FIXED mapping,
// and corrects the phantoms:
//   - label says Closed/Resolved  → current_stage='cured'  (resolved)
//   - label says Void             → current_stage='voided'
//   - label says Owner Response / unknown → flagged for review (left open but
//     marked so it isn't treated as a fresh first notice)
//
// DRY RUN by default. Pass --apply to write. Pass --community=<slug> to scope
// (default: all communities).
//
//   node scripts/cleanup_vantaca_phantom_open.js                 # dry run, all
//   node scripts/cleanup_vantaca_phantom_open.js --community=waterview
//   node scripts/cleanup_vantaca_phantom_open.js --apply --community=waterview
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { _normalizeStage } = require('../lib/enforcement/vantaca_violation_import');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const commArg = (process.argv.find((a) => a.startsWith('--community=')) || '').split('=')[1] || null;
const OPEN_EXCLUDED = ['cured', 'closed', 'voided'];

(async () => {
  let communityIds = null;
  if (commArg) {
    const { data: c } = await supabase.from('communities').select('id, name, slug').eq('slug', commArg);
    if (!c || !c.length) { console.error('community not found:', commArg); process.exit(1); }
    communityIds = c.map((x) => x.id);
    console.log('Scope:', c[0].name);
  } else {
    console.log('Scope: ALL communities');
  }

  // Page through open vantaca_import violations.
  let rows = [], from = 0;
  while (true) {
    let q = supabase.from('violations')
      .select('id, community_id, current_stage, current_stage_started_at, opened_at, resolved_notes, resolved_at, resolved_via, quality_status, review_notes')
      .eq('source', 'vantaca_import')
      .range(from, from + 999);
    if (communityIds) q = q.in('community_id', communityIds);
    const { data, error } = await q;
    if (error) { console.error(error.message); break; }
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  const open = rows.filter((v) => !OPEN_EXCLUDED.includes(v.current_stage));
  console.log(`Open vantaca_import violations: ${open.length}`);

  const toCured = [], toVoided = [], toReview = [], correctStageMismatch = [];
  for (const v of open) {
    const label = v.resolved_notes || '';
    const correct = _normalizeStage(label);   // fixed mapping
    if (correct === 'cured') toCured.push(v);
    else if (correct === 'voided') toVoided.push(v);
    else if (correct === null) toReview.push(v);   // Owner Response / unrecognized
    else if (correct && correct !== v.current_stage) correctStageMismatch.push({ v, correct });
  }

  console.log(`\nPhantom "Closed/Resolved" open as a notice → set to cured: ${toCured.length}`);
  console.log(`Phantom "Void" open as a notice          → set to voided: ${toVoided.length}`);
  console.log(`"Owner Response"/unknown open            → flag for review: ${toReview.length}`);
  console.log(`Open rows whose stage disagrees with their label → re-stage: ${correctStageMismatch.length}`);
  if (correctStageMismatch.length) {
    for (const { v, correct } of correctStageMismatch.slice(0, 10)) {
      console.log(`   ${v.id.slice(0, 8)} label="${v.resolved_notes}" is ${v.current_stage} → ${correct}`);
    }
  }

  if (!APPLY) {
    console.log('\nDRY RUN — no changes written. Re-run with --apply to commit.');
    return;
  }

  let updated = 0;
  const stamp = new Date().toISOString();
  const note = (old) => `${old ? old + ' · ' : ''}[2026-06-18 cleanup] corrected phantom open stage from Vantaca label "${''}"`;
  for (const v of toCured) {
    const { error } = await supabase.from('violations').update({
      current_stage: 'cured',
      resolved_at: v.resolved_at || v.current_stage_started_at || v.opened_at,
      resolved_via: 'cured',
      review_notes: `${v.review_notes ? v.review_notes + ' · ' : ''}[cleanup] Vantaca label "${v.resolved_notes}" — was wrongly open; set to cured.`,
      updated_at: stamp,
    }).eq('id', v.id);
    if (!error) updated++; else console.warn('update failed', v.id, error.message);
  }
  for (const v of toVoided) {
    const { error } = await supabase.from('violations').update({
      current_stage: 'voided',
      resolved_at: v.resolved_at || v.current_stage_started_at || v.opened_at,
      resolved_via: 'voided',
      review_notes: `${v.review_notes ? v.review_notes + ' · ' : ''}[cleanup] Vantaca label "${v.resolved_notes}" — was wrongly open; set to voided.`,
      updated_at: stamp,
    }).eq('id', v.id);
    if (!error) updated++; else console.warn('update failed', v.id, error.message);
  }
  for (const v of toReview) {
    const { error } = await supabase.from('violations').update({
      quality_status: 'flagged_internal',
      review_notes: `${v.review_notes ? v.review_notes + ' · ' : ''}[cleanup] Vantaca label "${v.resolved_notes}" has no trustEd stage — do NOT treat as a fresh first notice; review.`,
      updated_at: stamp,
    }).eq('id', v.id);
    if (!error) updated++; else console.warn('update failed', v.id, error.message);
  }
  console.log(`\nAPPLIED — ${updated} rows corrected.`);
})();
