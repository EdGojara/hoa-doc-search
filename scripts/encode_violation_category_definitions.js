// ============================================================================
// scripts/encode_violation_category_definitions.js  (Ed 2026-07-30)
// ----------------------------------------------------------------------------
// Encode-Ed pass: give every AI-facing violation category a real, disambiguating
// definition. The photo AI (lib/enforcement/ai_vision.js) is handed each
// category's `description` from enforcement_categories; 38 base categories had
// only the "Auto-added from Vantaca import" placeholder, so the AI guessed from
// the label and mislabeled things (trash as Storage, a car as Commercial, one
// lawn issue as three). Definitions are observation-based and draw the boundary
// with the categories they get confused with. Idempotent: update by slug.
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// slug -> definition. Keep each to what an inspector can SEE; call out the
// neighboring category to avoid double-flagging one condition.
const DEFS = {
  // ---- Vehicles (the cluster that double-flags one vehicle) ----------------
  stored_vehicle: 'A vehicle that is clearly being stored rather than driven: parked in the same spot long-term, under a car cover, or up on blocks/jack stands. NOT a normally-parked daily driver. If it has flat tires or is visibly wrecked use Inoperable vehicle; if it is a work truck/van use Commercial vehicle; if it is an RV/boat/trailer use that category.',
  recreational_vehicle: 'A motorhome, RV, camper, or travel trailer parked in public view. Closely related to "RV / boat / trailer" — use whichever single category the community has enabled; never tag the same unit under both. A passenger car/SUV/pickup is NOT a recreational vehicle.',
  atv_off_road_vehicle_motorcycles: 'An ATV, off-road vehicle, dirt bike, go-kart, or motorcycle parked or stored in public view where the community does not permit it. Street-legal cars, trucks, and SUVs do not belong here.',
  // ---- Lawn / landscaping (overlapping cluster) ----------------------------
  mow_and_edge: 'The lawn needs mowing and/or edging: grass is tall or shaggy, or grass has grown over the sidewalk, curb, driveway, or bed edges. Use for routine cut/edge upkeep. If the turf is brown/dead use Lawn dead patches; if it is bare dirt use Sod Yard.',
  lawn_maintenance: 'General lawn upkeep is needed and no more specific lawn category fits. Prefer the specific one when you can (Mow and Edge for height, Lawn dead patches for brown/dead turf, Weeds for weeds, Sod Yard for bare dirt). Use this only as a catch-all.',
  sod_yard: 'The lawn is largely bare dirt, patchy to the soil, or missing grass across a significant area, so sod or new grass needs to be established. Different from Lawn dead patches (grass present but brown) and Mow and Edge (grass present but tall).',
  landscaping_borders: 'Bed edging or border material (bricks, stone, steel, plastic edging) is missing, broken, displaced, or unmaintained along landscape beds. Not the plants themselves (see Landscaping-Flowerbeds) and not the lawn.',
  'landscaping-borders': 'Duplicate of Landscaping Borders — bed edging/border material missing, broken, or unmaintained. Prefer the community-standard border category; do not tag one bed under both.',
  'landscaping-flowerbeds': 'Flowerbeds or planting beds are overgrown, weedy, bare, or unmaintained (mulch gone, plants dead or missing). About the bed and its plantings, not the border edging and not the lawn.',
  dead_shrubs_plants_trees_or_plant_material: 'Dead or dying shrubs, bushes, trees, or other plant material that needs to be removed or replaced. Brown/dead TURF is Lawn dead patches, not this; fallen branches are Tree Debris.',
  prune_trees: 'Trees or large shrubs need pruning or trimming: low branches over the walk/street, limbs on the roof, or overgrowth blocking sightlines. Dead trees go under Dead shrubs/plants/trees; fallen limbs are Tree Debris.',
  tree_debris: 'Fallen branches, limbs, cut brush, or other tree/yard debris left on the property or at the curb. If the material is household garbage/bags use Trash Debris; if a tree needs cutting back use Prune Trees.',
  stump: 'A tree stump remaining in the yard that should be ground down or removed.',
  grass_in_the_expansion_joints: 'Grass or weeds growing up through the expansion joints, seams, or cracks of the driveway, sidewalk, or curb.',
  // ---- Trash vs storage (the pair you flagged) -----------------------------
  trash_cans_recycling_containers: 'Trash or recycling CONTAINERS (the bins/cans themselves) left out in public view outside the pickup window. For loose garbage, bags, or debris on the ground use Trash Debris; for stored belongings use Storage of Unapproved Items.',
  heavy_trash: 'Large discarded items set out as refuse (old furniture, mattresses, appliances, large debris piles) awaiting heavy-trash pickup. These are being thrown away, not stored — do not tag as Storage of Unapproved Items.',
  // ---- Fences --------------------------------------------------------------
  fences: 'A fence is damaged, leaning, missing boards or sections, rotted, or otherwise in disrepair. Staining/color issues go under Fence Staining.',
  fence_staining: 'A fence is weathered, faded, discolored, or peeling and needs staining, sealing, or painting. The fence is structurally intact — if boards are broken/missing use Fences.',
  fence_debris: 'Debris, trash, or overgrowth accumulated against or along a fence line.',
  // ---- Exterior / structure ------------------------------------------------
  'gutters_downspout-repair': 'Gutters or downspouts are damaged, detached, sagging, or missing and need repair or reattachment. Clogged-with-leaves is Gutters-Debris; mildew staining is Mildew on Gutters.',
  'gutters-debris': 'Gutters are clogged or overflowing with leaves and debris. Physical damage is Gutters/Downspout-Repair.',
  mildew_on_gutters: 'Visible mildew, black streaking, or staining on gutters, fascia, or trim that needs cleaning.',
  window_door_coverings: 'Unapproved coverings on windows or doors visible from the street: bed sheets, towels, foil, cardboard, flags, or boarded panels used as coverings.',
  window_ac_unit: 'A window-mounted or through-wall air-conditioning unit installed where it is visible from the street and not permitted.',
  siding_needs_repaired_replaced: 'Exterior siding is damaged, cracked, warped, missing pieces, or deteriorated and needs repair or replacement.',
  address_numbers: 'House address numbers are missing, damaged, faded, or not visible/legible from the street.',
  driveway_repair: 'The driveway is cracked, spalling, sunken, or broken and needs repair or replacement. Stains/dirt only is Powerwash driveway/sidewalk.',
  garage_door: 'The garage door is damaged, dented, faded, peeling, or in need of repair or repainting.',
  shutters: 'Exterior shutters are damaged, missing, faded, or hanging and need repair, replacement, or repaint.',
  repair_replace_windows: 'Windows are cracked, broken, fogged, or the frames are deteriorated and need repair or replacement. Unapproved coverings are Window/Door Coverings.',
  powerwash_driveway_sidewalk: 'The driveway, sidewalk, or other hardscape is stained, dirty, mildewed, or discolored and needs power-washing. Physical cracks/damage are Driveway Repair.',
  property_maintenance: 'General exterior maintenance or upkeep is needed and no more specific category fits. Prefer a specific category whenever one applies; use this only as a genuine catch-all.',
  // ---- Behavior / misc -----------------------------------------------------
  no_arc_on_file_for_the_modification: 'A visible exterior modification or improvement (structure, addition, paint color, hardscape, major landscaping) appears to have been made without an approved architectural (ARC/ACC) application on file.',
  flags_flagpoles: 'An unapproved flag, flagpole, banner, or pennant displayed in violation of the community flag rules.',
  fishing_violation: 'Fishing in a community lake or pond where it is prohibited or outside allowed rules.',
  running_a_business: 'Visible evidence of a business being operated from the residence: commercial signage, customer/commercial traffic, or business equipment/inventory in view.',
  portable_basketball_goal: 'A portable/movable basketball goal left in the street, right-of-way, sidewalk, or front of the property where the community does not permit it.',
  window_ac: 'A window-mounted air-conditioning unit visible where not permitted.',
};

const VOID_STORAGE_AT = ['16322 Lynn Crest Court']; // the item Ed flagged (Storage that is really trash)

(async () => {
  let updated = 0, missing = [];
  for (const [slug, description] of Object.entries(DEFS)) {
    const { data, error } = await s.from('enforcement_categories').update({ description }).eq('slug', slug).select('slug');
    if (error) { console.warn('  update failed', slug, error.message); continue; }
    if (!data || !data.length) { missing.push(slug); continue; }
    updated++;
  }
  console.log(`Defined ${updated} categories.`);
  if (missing.length) console.log('  (slugs not found, skipped):', missing.join(', '));

  // Fix 16322 Lynn Crest Court: void the "Storage Of Unapproved Items" violation
  // that is really trash (a Trash Debris violation already covers the property).
  for (const addr of VOID_STORAGE_AT) {
    const { data: props } = await s.from('properties').select('id').eq('street_address', addr);
    const pid = props && props[0] && props[0].id;
    if (!pid) { console.log('  16322 fix: property not found', addr); continue; }
    const { data: vs } = await s.from('violations')
      .select('id, cat:primary_category_id(label)')
      .eq('property_id', pid).in('current_stage', ['courtesy_1', 'courtesy_2', 'certified_209', 'fine_assessed']);
    const storage = (vs || []).find((v) => /storage of unapproved/i.test(v.cat?.label || ''));
    const trash = (vs || []).find((v) => /trash/i.test(v.cat?.label || ''));
    if (storage && trash) {
      const { error } = await s.from('violations').update({
        current_stage: 'voided', resolved_at: new Date().toISOString(), resolved_via: 'voided',
        resolved_notes: `Misclassified — the items (bags/boxes/bin) are trash, not stored belongings; Trash Debris violation ${trash.id} covers this property. Voided 2026-07-30 (Ed).`,
      }).eq('id', storage.id);
      console.log('  16322 Storage void:', error ? error.message : `voided ${storage.id.slice(0, 8)}, kept Trash ${trash.id.slice(0, 8)}`);
    } else console.log('  16322 fix: storage/trash pair not both open (no change)');
  }
})();
