-- ============================================================================
-- 022_arc_decisions_category.sql
-- ----------------------------------------------------------------------------
-- Adds a document category for historical ARC approval/denial letters and
-- meeting-minute excerpts referencing ARC decisions.
--
-- Strategic framing (per Ed's direction):
--   - Treated as INFORMATIONAL CONTEXT by the AI assessment engine
--   - NOT binding precedent
--   - Bedrock applies CURRENT governing documents as authority
--   - Past inconsistencies are documented but do not perpetuate
--
-- These documents are operational/reference, not lifecycle-tracked, so they
-- don't appear in the per-community Documents Coverage Matrix (same pattern
-- as forms_and_applications categories).
--
-- Apply AFTER 021. Idempotent.
-- ============================================================================

INSERT INTO document_categories (category, display_name, description,
                                 typical_frequency, required_for_resale,
                                 sort_order, show_in_matrix)
VALUES
  ('arc_historical_decision',
   'ARC Historical Decision',
   'Historical ARC approval or denial letter, or meeting-minute excerpt referencing an ARC decision. Used as INFORMATIONAL CONTEXT by the AI assessment engine — NOT binding precedent. Bedrock applies the community''s current governing documents (CC&Rs, Rules & Regulations, Design Standards) as the authoritative source. Past inconsistencies are documented but do not perpetuate.',
   'event_driven', FALSE, 230, FALSE)
ON CONFLICT (category) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_in_matrix = EXCLUDED.show_in_matrix;

-- Verify:
--   SELECT category, display_name, show_in_matrix
--     FROM document_categories
--    WHERE category = 'arc_historical_decision';
