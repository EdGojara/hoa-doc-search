// ============================================================================
// scripts/seed_trash_cleanup_category.js
// ----------------------------------------------------------------------------
// Seeds the "Trash - 10-Day Certified Cleanup" enforcement category — the
// trash/debris parallel to "Lawn - 10-Day Certified Force Mow". Both are
// special self-help enforcement tracks: 10-day certified notice, then the
// Association abates and charges it back as an assessment (Declaration
// self-help authority + TX §209 notice). Same renderer
// (lib/lawn_force_mow_renderer.js) with remedy_mode='cleanup'.
//
// enforcement_categories is a GLOBAL catalog (no community_id) — one row
// makes the category pickable for every community. The letter endpoint
// still 409s at draft time if a given community's self-help Declaration
// config isn't set.
//
// Idempotent: upserts by slug. Safe to re-run.
//   node scripts/seed_trash_cleanup_category.js
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const CATEGORY = {
  slug: 'trash_cleanup_10day',
  label: 'Trash - 10-Day Certified Cleanup',
  description:
    'Accumulation of trash, debris, or unsightly materials requiring a 10-day '
    + 'certified notice before the Association performs self-help cleanup and '
    + 'charges the cost back as an assessment. Special enforcement track per '
    + 'CC&R self-help authority + TX Property Code §209 notice, not the standard '
    + '§209 cure-rights courtesy progression.',
  default_priority_weight: 'aggressive',
  display_order: 101,
};

(async () => {
  const { data: existing, error: selErr } = await supabase
    .from('enforcement_categories')
    .select('id, slug')
    .eq('slug', CATEGORY.slug)
    .maybeSingle();
  if (selErr) throw selErr;

  if (existing) {
    const { error } = await supabase
      .from('enforcement_categories')
      .update({
        label: CATEGORY.label,
        description: CATEGORY.description,
        default_priority_weight: CATEGORY.default_priority_weight,
        display_order: CATEGORY.display_order,
      })
      .eq('id', existing.id);
    if (error) throw error;
    console.log(`[seed] updated existing category ${existing.id} (${CATEGORY.slug})`);
  } else {
    const { data, error } = await supabase
      .from('enforcement_categories')
      .insert(CATEGORY)
      .select('id')
      .single();
    if (error) throw error;
    console.log(`[seed] inserted category ${data.id} (${CATEGORY.slug})`);
  }
})().catch((e) => { console.error('[seed] FAILED:', e.message); process.exit(1); });
