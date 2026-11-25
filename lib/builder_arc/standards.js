// ============================================================================
// lib/builder_arc/standards.js  (Ed 2026-11-25)
// ----------------------------------------------------------------------------
// The community-specific rules Annie applies to a builder lot submission.
// Source of truth: communities.builder_arc_standards.review (JSONB, the same
// column the Community Profile "Builder ARC standards" editor writes; this
// module only reads the `review` key and never touches the editor's keys).
//
// Every rule carries the citation it comes from, so a finding can say WHERE
// the requirement lives. A community with no `review` block gets no compliance
// verdict: Annie says the standards are not configured and recommends manual
// review. She never invents a rule.
//
// Shape:
// {
//   "source": { "library_document_id": "...", "title": "...", "version": "..." },
//   "max_lot_coverage_pct": 80,                        "lot_coverage_ref": "...",
//   "repetition": {
//     "same_plan_same_elevation_min_lots_between": 3,  // homes between repeats
//     "same_plan_same_elevation_requires_different_brick_and_trim": true,
//     "same_plan_different_elevation_min_lots_between": 2,
//     "brick_repeat_min_lots_between": 4,              // "no more frequently than every fifth home"
//     "adjacent_identical_brick_prohibited": true,
//     "adjacent_trim_or_field_color_must_vary": true,
//     "ref": "..."
//   },
//   "required_submittal": [ { "key": "plot_plan" | "lot_coverage" | "fence" | "lot_block_section" | "materials", "label": "...", "ref": "..." } ],
//   "required_materials": ["brick", "paint_or_siding", "trim", "shingles"],
//   "legal_review_days": 30, "legal_review_ref": "...",
//   "approval_effective_months": 12
// }
// ============================================================================

function readStandards(community) {
  const all = community && community.builder_arc_standards;
  const r = all && typeof all === 'object' ? all.review : null;
  if (!r || typeof r !== 'object') return null;
  return r;
}

async function loadStandards(supabase, communityId) {
  const { data, error } = await supabase.from('communities')
    .select('id, name, builder_arc_standards, builder_arc_sla_business_days, builder_arc_fast_track_business_days')
    .eq('id', communityId).maybeSingle();
  if (error) throw error;
  return { community: data, standards: readStandards(data) };
}

module.exports = { readStandards, loadStandards };
