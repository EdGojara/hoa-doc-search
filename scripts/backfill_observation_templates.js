// scripts/backfill_observation_templates.js
// ---------------------------------------------------------------------------
// Backfill enforcement_categories.observation_template for every category that
// lacks one. That sentence PRINTS ON THE VIOLATION LETTER (violation_letter.js
// prints v.ai_description), and the Step-1 review UI copies it onto the
// observation when the operator reclassifies. Categories with no template were
// silently leaving the AI's stale wording on reclassified observations — the
// "still not changing text" gap (Ed 2026-09-17), including the very category
// from the 5818 Acacia Rose Court miss ("Grass in the expansion joints").
//
// Idempotent + non-destructive: only writes where observation_template is NULL
// or blank, so the 24 hand-tuned templates and any of Ed's later edits are
// never clobbered. Keyed by slug (stable).
//
// Voice matches the existing 24: neutral, descriptive, homeowner-facing,
// "observed condition + what's needed", no case numbers.
//
// Run:  node -r dotenv/config scripts/backfill_observation_templates.js
// ---------------------------------------------------------------------------

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const TEMPLATES = {
  address_numbers: "The property's address numbers are missing, damaged, or not clearly visible from the street.",
  'arc_approved_-_fence': "The fence at the property does not match the fence approved by the ACC on file.",
  atv_off_road_vehicle_motorcycles: "An ATV, off-road vehicle, or motorcycle is being stored or operated at the property in a manner that does not match the community's rules.",
  dead_shrubs_plants_trees_or_plant_material: "Dead or dying shrubs, plants, trees, or other plant material are visible and need to be removed or replaced.",
  driveway_repair: "The driveway is cracked, stained, or in disrepair and needs to be repaired or replaced.",
  'driveway_repair_-_submit_acc_form_before_repairs': "The driveway needs repair. Please submit an ACC application before beginning any driveway repairs.",
  'exterior_lighting_-_red_lighting_needs_to_be_removed': "Red exterior lighting is visible at the property and needs to be removed.",
  'exterior_lighting_-_repair_porch_light': "The porch light is damaged or inoperable and needs to be repaired.",
  fence_debris: "Debris has accumulated along the fence line and needs to be removed.",
  fence_staining: "The fence is weathered and needs to be stained or refinished to the community's standard.",
  fences: "The fence is damaged or in disrepair and needs to be repaired or replaced.",
  fishing_violation: "Fishing was observed in a community pond or common area where it is not permitted.",
  flags_flagpoles: "A flag or flagpole is displayed in a manner that does not match the community's rules.",
  garage_door: "The garage door is damaged or in disrepair and needs to be repaired or replaced.",
  grass_in_the_expansion_joints: "Grass or weeds are growing in the driveway or sidewalk expansion joints and need to be removed.",
  'gutters-debris': "Debris has accumulated in the gutters and needs to be cleared.",
  'gutters_downspout-repair': "The gutters or downspouts are damaged or detached and need to be repaired.",
  heavy_trash: "Heavy trash or bulk items are set out or accumulated at the property outside the permitted collection window.",
  landscaping_borders: "The landscaping borders are damaged, missing, or in need of repair.",
  'landscaping-borders': "The landscaping borders are damaged, missing, or in need of repair.",
  'landscaping-flowerbeds': "The flower beds need attention — weeding, fresh plantings, or general cleanup to the community's standard.",
  lawn_force_mow_10day: "The front lawn exceeds the community's maintenance height and requires immediate mowing.",
  lawn_maintenance: "The lawn needs maintenance — mowing, edging, or general upkeep to the community's standard.",
  mildew_on_gutters: "Mildew or staining is visible on the gutters and needs to be cleaned.",
  mow_and_edge: "The lawn needs to be mowed and edged to the community's standard.",
  no_arc_on_file_for_the_modification: "A visible exterior modification has been made to the property without an ACC application on file.",
  'no_arc_on_file_for_the_modification_-_please_submit_acc_appl': "A roof replacement has been made without an ACC application on file. Please submit an ACC application for the roof replacement.",
  'parking_-_please_refrain_from_blocking_sidewalk': "A vehicle is parked in a manner that blocks the sidewalk. Please refrain from blocking the sidewalk.",
  'play_equipment_-_portable_basketball_must_not_be_visible_fro': "A portable basketball goal is visible from the street. It must not be visible from the street when not in use.",
  portable_basketball_goal: "A portable basketball goal is stored where it is visible from the street when not in use.",
  powerwash_driveway_sidewalk: "The driveway or sidewalk is stained and needs to be power-washed.",
  property_maintenance: "The property shows visible maintenance items that need attention to meet the community's standard.",
  'property_maintenance_-_excessive_watering': "Excessive watering was observed at the property, causing runoff onto the sidewalk or street.",
  prune_trees: "Trees on the property need to be pruned — low or overgrown branches require trimming.",
  recreational_vehicle: "A recreational vehicle is parked or stored at the property in a manner that does not match the community's rules.",
  'repair_replace_window_coverings_-_blinds': "The window blinds are damaged and need to be repaired or replaced.",
  repair_replace_windows: "One or more windows are damaged and need to be repaired or replaced.",
  running_a_business: "Activity consistent with operating a business was observed at the property, which does not match the community's residential-use rules.",
  'running_a_business_-_day_care': "Activity consistent with operating a day care was observed at the property, which does not match the community's residential-use rules.",
  'shed_outbuilding_-_pod': "A shed, outbuilding, or portable storage container (POD) is placed at the property in a manner that does not match the community's rules.",
  shutters: "The shutters are damaged, missing, or in need of repair.",
  siding_needs_repaired_replaced: "The siding is damaged and needs to be repaired or replaced.",
  sod_yard: "Bare areas of the yard need to be sodded to restore full ground cover.",
  storage_of_unapproved_items: "Unapproved items are being stored in an area visible from the street and need to be removed or stored out of view.",
  'storage_of_unapproved_items_-_bricks_and_wheel_barrel_near_g': "Bricks and a wheelbarrow are stored near the garage in view of the street and need to be removed or stored out of view.",
  'storage_of_unapproved_items_-_couch': "A couch is stored in an area visible from the street and needs to be removed.",
  'storage_of_unapproved_items_-_mulch_bags': "Bags of mulch are stored in view of the street and need to be removed or stored out of view.",
  'storage_of_unapproved_items_-_mulch_bags_ladder_and_tables': "Mulch bags, a ladder, and tables are stored in view of the street and need to be removed or stored out of view.",
  'storage_of_unapproved_items_-_rope_front_tree_to_fence_needs': "A rope tied from the front tree to the fence needs to be removed.",
  'storage_of_unapproved_items_-_tire': "A tire is stored in an area visible from the street and needs to be removed.",
  stored_vehicle: "A stored or unused vehicle is parked at the property in a manner that does not match the community's rules.",
  the_heavy_trash_in_the_back_of_the_baldwin_elm_st_and_amber_: "Heavy trash at the back of the Baldwin Elm St. and Amber Hill St. intersection needs to be removed.",
  'trailer_-_legal_drv': "A trailer is parked or stored at the property in a manner that does not match the community's rules.",
  trash_cleanup_10day: "Trash and debris remain at the property and require immediate cleanup.",
  trash_cans_recycling_containers: "Trash or recycling containers are visible from the street outside the permitted collection window.",
  trash_debris: "Trash or debris has accumulated at the property and needs to be removed.",
  tree_hazard_10day: "A hazardous tree or limb on the property requires immediate removal.",
  tree_debris: "Tree debris — fallen limbs or cuttings — has accumulated at the property and needs to be removed.",
  stump: "A tree stump remains on the property and needs to be removed.",
  window_ac_unit: "A window air-conditioning unit is installed in a manner visible from the street, which does not match the community's rules.",
  window_door_coverings: "Window or door coverings that are not permitted (such as sheets or non-standard materials) are visible and need to be replaced with approved coverings.",
};

(async () => {
  const { data: cats, error } = await supabase
    .from('enforcement_categories')
    .select('id, slug, label, observation_template');
  if (error) { console.error('LOAD FAILED:', error.message); process.exit(1); }

  const bySlug = new Map(cats.map((c) => [c.slug, c]));
  let updated = 0, skippedHasText = 0, notFound = 0, alreadySet = 0;

  for (const [slug, template] of Object.entries(TEMPLATES)) {
    const cat = bySlug.get(slug);
    if (!cat) { console.warn('  (slug not found, skipping):', slug); notFound++; continue; }
    if (cat.observation_template && cat.observation_template.trim()) { skippedHasText++; continue; }
    const { error: upErr } = await supabase
      .from('enforcement_categories')
      .update({ observation_template: template })
      .eq('id', cat.id);
    if (upErr) { console.error('  UPDATE FAILED for', slug, '->', upErr.message); continue; }
    updated++;
  }

  // Report any category STILL without a template (so the gap can't hide).
  const { data: after, error: afterErr } = await supabase
    .from('enforcement_categories')
    .select('slug, label, observation_template');
  if (afterErr) { console.error('VERIFY FAILED:', afterErr.message); process.exit(1); }
  const stillEmpty = after.filter((c) => !c.observation_template || !c.observation_template.trim());

  console.log('\nBackfill complete.');
  console.log('  updated           :', updated);
  console.log('  skipped (had text):', skippedHasText);
  console.log('  slug not found    :', notFound);
  console.log('  categories total  :', after.length);
  console.log('  STILL empty       :', stillEmpty.length);
  if (stillEmpty.length) {
    console.log('  --- categories still missing a template ---');
    stillEmpty.forEach((c) => console.log('   •', c.slug, '::', c.label));
  }
})();
