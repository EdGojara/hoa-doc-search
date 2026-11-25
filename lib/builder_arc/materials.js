// ============================================================================
// lib/builder_arc/materials.js  (Ed 2026-11-25)
// ----------------------------------------------------------------------------
// ONE reader for a builder application's materials, whatever shape they were
// stored in. builder_applications.application_data has three writers that never
// agreed on a vocabulary:
//
//   1. Builder portal forms (builder-submit-still-creek-lennar.html, DRB form):
//      flat { brick, paint, trim, stone, siding, shingles }
//   2. PDF extraction (upload-on-behalf): nested { materials: { brick: {type,
//      color}, rock, siding, trim_paint, shingles, garage_door, stucco_paint,
//      mortar, chimney, windows } } plus flat brick_color / stone_color / ...
//   3. The renderer's own flat vocabulary: brick_color, brick_manufacturer,
//      stone_color, siding_color, trim_color, roof_color, ...
//
// Every consumer (the decision letter, the letter validator, the queue
// recommendation, Annie's review) read only shape 3, so every portal
// submission (shape 1) looked like it had no materials: the recommendation fell
// to "rules did not match cleanly" and approval letters printed "approved as
// submitted" with no Approved Specifications table. Scar 2026-11-25: all 52
// approved Lennar portal applications re-render without the table.
//
// normalizeMaterials() maps every known shape onto the renderer vocabulary.
// Explicit renderer-vocabulary values win over mapped ones (an operator's edit
// is never overwritten by the raw form value).
// ============================================================================

const clean = (v) => {
  if (v == null) return null;
  if (typeof v === 'object') return null;
  const s = String(v).trim();
  if (!s || /^(n\/?a|none|null|undefined|-+)$/i.test(s)) return null;
  return s;
};

// A nested extraction row ({type, color} or a plain string).
function rowParts(r) {
  if (r == null) return { type: null, color: null };
  if (typeof r !== 'object') return { type: null, color: clean(r) };
  return { type: clean(r.type || r.manufacturer || r.material), color: clean(r.color || r.name || r.value) };
}

// Keys the renderer reads (lib/builder_letter.js renderMaterialSpec).
const RENDER_KEYS = [
  'brick_color', 'brick_manufacturer', 'stone_color', 'stone_type', 'siding_material', 'siding_color',
  'paint_color', 'trim_color', 'shutter_color', 'shutters_present', 'front_door_color', 'garage_door_color',
  'garage_door_style', 'roof_color', 'roof_material', 'shingle_color', 'mortar_color',
  'masonry_percentage_front', 'masonry_percentage_sides', 'masonry_percentage_rear',
  'masonry_wrap_distance_sides', 'masonry_two_story_compliance', 'driveway_material',
  'fence_present', 'fence_material', 'fence_height_feet', 'fence_orientation',
];

/**
 * @param {object} applicationData  builder_applications.application_data
 * @returns {object} renderer-vocabulary materials (only keys with values)
 */
function normalizeMaterials(applicationData) {
  const d = (applicationData && typeof applicationData === 'object') ? applicationData : {};
  const nested = (d.materials && typeof d.materials === 'object' && !Array.isArray(d.materials)) ? d.materials : {};
  const out = {};
  const set = (k, v) => { const c = typeof v === 'boolean' || typeof v === 'number' ? v : clean(v); if (c != null && out[k] == null) out[k] = c; };

  // 3. Renderer vocabulary already present: highest precedence.
  for (const k of RENDER_KEYS) if (d[k] != null) set(k, d[k]);

  // 2. Nested extraction rows.
  const brick = rowParts(nested.brick);
  set('brick_color', brick.color); set('brick_manufacturer', brick.type);
  const rock = rowParts(nested.rock || nested.stone);
  set('stone_color', rock.color); set('stone_type', rock.type);
  const siding = rowParts(nested.siding);
  set('siding_color', siding.color); set('siding_material', siding.type);
  const trim = rowParts(nested.trim_paint || nested.trim);
  set('trim_color', trim.color || trim.type);
  const stucco = rowParts(nested.stucco_paint || nested.paint);
  set('paint_color', stucco.color || stucco.type);
  const shingles = rowParts(nested.shingles || nested.roof);
  set('shingle_color', shingles.color || shingles.type);
  const garage = rowParts(nested.garage_door);
  set('garage_door_color', garage.color); set('garage_door_style', garage.type);
  const mortar = rowParts(nested.mortar);
  set('mortar_color', mortar.color || mortar.type);

  // 1. Builder portal flat keys (plain strings).
  set('brick_color', typeof d.brick === 'string' ? d.brick : null);
  set('stone_color', typeof d.stone === 'string' ? d.stone : null);
  set('siding_color', typeof d.siding === 'string' ? d.siding : null);
  set('paint_color', typeof d.paint === 'string' ? d.paint : null);
  set('trim_color', typeof d.trim === 'string' ? d.trim : null);
  set('shingle_color', typeof d.shingles === 'string' ? d.shingles : null);
  // Older flat extraction keys.
  set('stone_color', d.stone_type);
  set('roof_color', d.roof_color);
  set('garage_door_color', d.garage_door_color);
  return out;
}

/** True when at least one exterior material is on file. */
function hasMaterials(applicationData) {
  const m = normalizeMaterials(applicationData);
  return ['brick_color', 'stone_color', 'siding_color', 'paint_color', 'trim_color', 'shingle_color', 'roof_color'].some((k) => m[k] != null);
}

// Comparable key for a color/material ("Claymex - Oxford" == "Claymex Oxford").
function colorKey(v) {
  const s = clean(v);
  return s ? s.toLowerCase().replace(/[^a-z0-9]+/g, '') : null;
}

module.exports = { normalizeMaterials, hasMaterials, colorKey, RENDER_KEYS };
