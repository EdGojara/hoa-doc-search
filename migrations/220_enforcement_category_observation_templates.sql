-- ============================================================================
-- 220_enforcement_category_observation_templates.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-13: "When we change the category, can we add the language for
-- that category also — creates mismatch that we have to type."
--
-- When the operator reclassifies a draft, the AI's old description doesn't
-- match the new category. Force operator to retype = friction. The fix:
-- each enforcement category gets a default observation_template — a
-- Bedrock-voice conversational starter sentence that fills the description
-- textarea the moment the operator picks the new category. They can tweak
-- to add photo-specific detail; they're not typing from scratch.
--
-- Templates follow the no-document-citation voice (per memory note
-- feedback_no_document_citation_voice.md): conversational, no §X.Y refs,
-- no formal document titles. What Ed would say over coffee.
--
-- Idempotent: ALTER ADD COLUMN IF NOT EXISTS + UPDATE WHERE template IS NULL
-- means re-runs are safe and won't overwrite per-community customizations.
-- ============================================================================

BEGIN;

ALTER TABLE enforcement_categories
  ADD COLUMN IF NOT EXISTS observation_template TEXT;

-- Standard templates per the 21 seeded categories (migration 050).
-- Only fill where NULL so any community/operator override stays intact.
UPDATE enforcement_categories SET observation_template = 'Tree branches are extending past the property line and encroaching on the neighboring lot or right-of-way.' WHERE slug = 'tree_overgrowth' AND observation_template IS NULL;

UPDATE enforcement_categories SET observation_template = 'A tree on the property shows visible decline — dead limbs, missing canopy, or signs of disease that may present a hazard.' WHERE slug = 'tree_dead_dying' AND observation_template IS NULL;

UPDATE enforcement_categories SET observation_template = 'Mildew or mold is visible on the exterior — siding, roof, fence, or driveway.' WHERE slug = 'mildew_mold_visible' AND observation_template IS NULL;

UPDATE enforcement_categories SET observation_template = 'The front lawn grass exceeds the community''s standard maintenance height across the visible area.' WHERE slug = 'lawn_height' AND observation_template IS NULL;

UPDATE enforcement_categories SET observation_template = 'Dead grass or bare dirt patches are visible in the front lawn.' WHERE slug = 'lawn_dead_patches' AND observation_template IS NULL;

UPDATE enforcement_categories SET observation_template = 'Weeds are growing in the landscaping beds, pavement cracks, or the lawn.' WHERE slug = 'weeds' AND observation_template IS NULL;

UPDATE enforcement_categories SET observation_template = 'Landscaping is overgrown — beds need trimming, shrubs are encroaching on walkways, or vegetation is blocking the sidewalk.' WHERE slug = 'landscaping_overgrown' AND observation_template IS NULL;

UPDATE enforcement_categories SET observation_template = 'Exterior paint is peeling, faded, or otherwise below the community''s maintenance standard on visible surfaces.' WHERE slug = 'paint_peeling' AND observation_template IS NULL;

UPDATE enforcement_categories SET observation_template = 'Visible damage to the siding — missing pieces, cracks, or significant weathering.' WHERE slug = 'siding_damage' AND observation_template IS NULL;

UPDATE enforcement_categories SET observation_template = 'Visible roof damage from the street — missing shingles, debris, or signs of significant wear.' WHERE slug = 'roof_damage' AND observation_template IS NULL;

UPDATE enforcement_categories SET observation_template = 'Visible damage to the fence — leaning sections, missing slats, or other wear that needs repair.' WHERE slug = 'fence_damage' AND observation_template IS NULL;

UPDATE enforcement_categories SET observation_template = 'A fence has been installed without ACC approval, or the current fence does not match what was approved.' WHERE slug = 'fence_unauthorized' AND observation_template IS NULL;

UPDATE enforcement_categories SET observation_template = 'A vehicle on the property appears inoperable — expired tags, on blocks, or visible damage suggesting it is not currently being driven.' WHERE slug = 'vehicle_inoperable' AND observation_template IS NULL;

UPDATE enforcement_categories SET observation_template = 'A commercial vehicle is parked at the property in a manner that does not match the community''s commercial-vehicle rules.' WHERE slug = 'vehicle_commercial' AND observation_template IS NULL;

UPDATE enforcement_categories SET observation_template = 'An RV, boat, or trailer is parked at the property in a location or manner that does not match the community''s rules.' WHERE slug = 'vehicle_rv' AND observation_template IS NULL;

UPDATE enforcement_categories SET observation_template = 'Trash bins are visible from the street outside the community''s permitted collection window.' WHERE slug = 'trash_visible' AND observation_template IS NULL;

UPDATE enforcement_categories SET observation_template = 'Holiday decorations remain on display past the community''s seasonal deadline for removal.' WHERE slug = 'holiday_decorations_late' AND observation_template IS NULL;

UPDATE enforcement_categories SET observation_template = 'The mailbox is damaged, missing, or does not match the community''s standard.' WHERE slug = 'mailbox_damage' AND observation_template IS NULL;

UPDATE enforcement_categories SET observation_template = 'A visible exterior modification has been made to the property without ACC approval on file.' WHERE slug = 'unauthorized_modification' AND observation_template IS NULL;

UPDATE enforcement_categories SET observation_template = 'A vehicle is parked at the property in a manner that does not match the community''s parking rules.' WHERE slug = 'parking_violation' AND observation_template IS NULL;

UPDATE enforcement_categories SET observation_template = 'A pet was observed off-leash, out of containment, or with waste left in a common area.' WHERE slug = 'pet_violation' AND observation_template IS NULL;

COMMIT;
