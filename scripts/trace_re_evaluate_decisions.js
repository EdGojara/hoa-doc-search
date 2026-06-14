// ============================================================================
// scripts/trace_re_evaluate_decisions.js
// ----------------------------------------------------------------------------
// Ed 2026-06-13: "Dead patches should be 209 certified already and so just
// escalating not working still."
//
// Mirror of the /api/enforcement/drafts/re-evaluate logic, run locally,
// with VERBOSE per-draft trace output: every prior found, every weight,
// every decision branch. Shows EXACTLY why a draft was classified KEEP /
// UPGRADE / BOARD — so we can tell whether the issue is:
//   (a) Vantaca certified_209 prior IS in the database but my filter doesn't
//       catch it (logic bug — I fix the filter)
//   (b) Vantaca certified_209 prior is NOT in the database for this
//       property+category (data bug — Vantaca import didn't persist OR
//       wrote it against a different property_id / category_id)
//   (c) Prior IS there and IS caught — and the re-evaluate flow actually
//       did the right thing (in which case Ed's confusion is about UI,
//       not engine logic).
//
// Run: node scripts/trace_re_evaluate_decisions.js
// Filter by community + optional category_slug if you want to narrow.
// Read-only — no mutations.
// ============================================================================

require('dotenv').config({ override: true });
const { createClient } = require('@supabase/supabase-js');
const { decideEscalation } = require('../lib/enforcement/escalation');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const COMMUNITIES = ['Canyon Gate at Cinco Ranch', 'Lakes of Pine Forest'];
// Set to null to show all categories. Set to e.g. 'lawn_dead_patches' to
// trace just dead patches drafts.
const CATEGORY_FILTER_SLUG = null;

const STAGE_RANK = { courtesy_1: 0, courtesy_2: 1, certified_209: 2, fine_assessed: 3 };

function weightFor(v) {
  if (v.quality_status === 'superseded') return 0;
  if (typeof v.confidence_weight === 'number') return Math.max(0, Math.min(1, v.confidence_weight));
  return 1.0;
}

async function traceCommunity(name) {
  console.log('\n========================================================================');
  console.log(`COMMUNITY: ${name}`);
  console.log('========================================================================');

  const { data: comms } = await supabase.from('communities').select('id, name').ilike('name', name);
  if (!comms?.length) { console.log('  ✗ community not found'); return; }
  const community = comms[0];

  // Pull all draft-status letter interactions for this community
  const { data: drafts } = await supabase
    .from('interactions')
    .select('id, violation_id, observation_id, type, status')
    .eq('community_id', community.id)
    .eq('status', 'draft')
    .in('type', ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209']);
  if (!drafts?.length) {
    console.log('  No draft letters at this community.');
    return;
  }
  console.log(`  ${drafts.length} draft(s) to trace.`);

  const yearAgoIso = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

  for (const draft of drafts) {
    if (!draft.violation_id) {
      console.log(`\n  draft ${draft.id} — no violation_id linked. Skipped.`);
      continue;
    }
    // Load violation + property + category
    const { data: violation } = await supabase
      .from('violations')
      .select('id, property_id, community_id, primary_category_id, current_stage, opened_at, board_priority_at_open, enforcement_categories(slug, label)')
      .eq('id', draft.violation_id)
      .maybeSingle();
    if (!violation) continue;

    if (CATEGORY_FILTER_SLUG && violation.enforcement_categories?.slug !== CATEGORY_FILTER_SLUG) continue;

    const { data: prop } = await supabase
      .from('v_current_property_owners')
      .select('street_address, owner_name')
      .eq('property_id', violation.property_id)
      .maybeSingle();

    console.log('\n  ─────────────────────────────────────────────');
    console.log(`  ${prop?.street_address || '(no address)'}  ·  ${prop?.owner_name || ''}`);
    console.log(`    Draft interaction: ${draft.id}`);
    console.log(`    Violation:         ${violation.id} · ${violation.enforcement_categories?.label} (${violation.enforcement_categories?.slug})`);
    console.log(`    Current stage:     ${violation.current_stage}`);
    console.log(`    Opened:            ${(violation.opened_at || '').slice(0, 10)}`);
    console.log(`    property_id:       ${violation.property_id}`);
    console.log(`    primary_category_id: ${violation.primary_category_id}`);

    // Priors — same property + same category (the exact query re-evaluate uses)
    const { data: priors } = await supabase
      .from('violations')
      .select('id, primary_category_id, opened_at, current_stage, quality_status, confidence_weight, source, resolved_at, enforcement_categories(slug, label)')
      .eq('property_id', violation.property_id)
      .eq('primary_category_id', violation.primary_category_id)
      .gte('opened_at', yearAgoIso)
      .neq('id', violation.id);

    console.log(`    Priors found (same property + same category + last 365d): ${(priors || []).length}`);
    for (const p of (priors || [])) {
      const w = weightFor(p);
      console.log(`      · ${p.id} · ${p.enforcement_categories?.label} · stage=${p.current_stage} · weight=${w} · source=${p.source || 'null'} · opened ${(p.opened_at || '').slice(0,10)} · resolved=${p.resolved_at ? p.resolved_at.slice(0,10) : 'no'}`);
    }

    // ALSO — same property but DIFFERENT category. Surfaces the case where
    // the Vantaca import gave a violation a different primary_category_id
    // than trustEd's confirm path did (silent category mismatch).
    const { data: otherCatPriors } = await supabase
      .from('violations')
      .select('id, primary_category_id, current_stage, opened_at, source, enforcement_categories(slug, label)')
      .eq('property_id', violation.property_id)
      .neq('primary_category_id', violation.primary_category_id)
      .gte('opened_at', yearAgoIso)
      .neq('id', violation.id)
      .in('current_stage', ['certified_209', 'fine_assessed']);
    if (otherCatPriors && otherCatPriors.length > 0) {
      console.log(`    ⚠ Other-category certified_209+ priors at the SAME property:`);
      for (const p of otherCatPriors) {
        console.log(`      · ${p.enforcement_categories?.label} (${p.enforcement_categories?.slug}) · ${p.current_stage} · ${(p.opened_at || '').slice(0,10)} · source=${p.source}`);
      }
      console.log(`    (These won't trigger board_review under the current per-category logic. Policy question for Ed.)`);
    }

    // Apply the same decision logic re-evaluate uses
    const certifiedPriors = (priors || []).filter((p) =>
      ['certified_209', 'fine_assessed'].includes(p.current_stage) && weightFor(p) > 0
    );
    const decision = decideEscalation({
      prior_violations: priors || [],
      priority_weight: violation.board_priority_at_open || 'standard',
    });

    let action, newStage = null;
    if (certifiedPriors.length > 0) {
      action = 'BOARD_REVIEW';
    } else if ((STAGE_RANK[decision.stage] || 0) > (STAGE_RANK[violation.current_stage] || 0)) {
      action = 'UPGRADE';
      newStage = decision.stage;
    } else {
      action = 'KEEP';
    }

    console.log(`    Engine decision:   ${decision.stage}  (${decision.rationale})`);
    console.log(`    Re-evaluate would: ${action}${newStage ? ` → ${newStage}` : ''}`);
    if (certifiedPriors.length > 0) {
      console.log(`    Certified prior(s) that triggered board_review:`);
      for (const cp of certifiedPriors) {
        console.log(`      · ${cp.id} · ${cp.enforcement_categories?.label} · ${cp.current_stage} · opened ${(cp.opened_at || '').slice(0,10)}`);
      }
    }
  }
}

(async () => {
  for (const c of COMMUNITIES) {
    try { await traceCommunity(c); } catch (e) { console.error('failed:', c, e.message); }
  }
  console.log('\n========================================================================');
  console.log('DONE.');
  console.log('========================================================================');
  process.exit(0);
})();
