// ============================================================================
// scripts/flag_drafts_understaged_under_new_weight.js
// ----------------------------------------------------------------------------
// Ed 2026-06-13: after the Vantaca-weight fix (0.5 → 1.0), drafts already in
// the queue were created under the OLD weight calculation. This script
// re-runs the escalation engine for every CURRENT draft, using the new
// (post-migration-221) weights, and flags any draft whose stage would have
// been higher under the new math.
//
// Output: per draft → current stage vs. recomputed stage. Operator action
// for each flagged draft = reject + re-confirm OR use the ✏️ Fix flow to
// reclassify at the correct stage before approving.
//
// Read-only. No mutations.
// ============================================================================

require('dotenv').config({ override: true });
const { createClient } = require('@supabase/supabase-js');
const { decideEscalation } = require('../lib/enforcement/escalation');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const COMMUNITIES = ['Canyon Gate at Cinco Ranch', 'Lakes of Pine Forest'];

const STAGE_ORDER = ['courtesy_1', 'courtesy_2', 'certified_209', 'fine_assessed'];
function stageRank(s) {
  const i = STAGE_ORDER.indexOf(s);
  return i === -1 ? -1 : i;
}

async function auditCommunity(name) {
  console.log('\n========================================================================');
  console.log(`COMMUNITY: ${name}`);
  console.log('========================================================================');

  const { data: comms } = await supabase.from('communities').select('id, name').ilike('name', name);
  if (!comms?.length) { console.log('  ✗ community not found'); return; }
  const community = comms[0];

  // Pull all current draft-status letter interactions for this community.
  const { data: drafts } = await supabase
    .from('interactions')
    .select('id, type, violation_id, property_id, created_at')
    .eq('community_id', community.id)
    .eq('status', 'draft')
    .in('type', ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209']);
  if (!drafts?.length) {
    console.log(`  No draft letters at this community.`);
    return;
  }
  console.log(`  ${drafts.length} draft letter(s) in queue.`);

  let understaged = 0;
  for (const draft of drafts) {
    if (!draft.violation_id) continue;

    // Get this violation + category + property
    const { data: violation } = await supabase
      .from('violations')
      .select('id, property_id, primary_category_id, current_stage, opened_at, board_priority_at_open, enforcement_categories(label)')
      .eq('id', draft.violation_id)
      .maybeSingle();
    if (!violation) continue;

    // Get THIS violation's priors (same property + same category, within 365 days,
    // EXCLUDING the violation itself). Now uses the post-migration-221 weights.
    const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const { data: priors } = await supabase
      .from('violations')
      .select('id, primary_category_id, opened_at, current_stage, quality_status, confidence_weight, source')
      .eq('property_id', violation.property_id)
      .eq('primary_category_id', violation.primary_category_id)
      .gte('opened_at', yearAgo)
      .neq('id', violation.id);

    // Re-run the escalation engine
    const decision = decideEscalation({
      prior_violations: priors || [],
      priority_weight: violation.board_priority_at_open || 'standard',
    });

    const currentRank = stageRank(violation.current_stage);
    const newRank = stageRank(decision.stage);
    if (newRank > currentRank) {
      understaged++;
      // Get property address
      const { data: prop } = await supabase
        .from('v_current_property_owners')
        .select('street_address, owner_name')
        .eq('property_id', violation.property_id)
        .maybeSingle();
      console.log(`\n  ⚠ ${prop?.street_address || '(unknown address)'}  ·  ${prop?.owner_name || ''}`);
      console.log(`     Category:           ${violation.enforcement_categories?.label || '(unknown)'}`);
      console.log(`     Drafted at stage:   ${violation.current_stage}`);
      console.log(`     Should be at stage: ${decision.stage}  (per new weight)`);
      console.log(`     Why:                ${decision.rationale}`);
      console.log(`     Prior violations:   ${(priors || []).length}`);
      console.log(`     Draft interaction:  ${draft.id}`);
      console.log(`     Violation id:       ${violation.id}`);
    }
  }

  if (understaged === 0) {
    console.log(`  ✓ All ${drafts.length} drafts are at the correct stage under the new weight.`);
  } else {
    console.log(`\n  ${understaged} draft(s) flagged as understaged.`);
    console.log(`  For each: use ✏️ Fix flow to reclassify, OR reject + re-confirm`);
    console.log(`  the underlying observation so the engine re-runs with new weight.`);
  }
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
