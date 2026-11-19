-- ============================================================================
-- 571_acc_developer_authorization.sql  (Ed 2026-11-18)
-- ----------------------------------------------------------------------------
-- STILL CREEK RANCH AND AUGUST MEADOWS: the developer (Declarant) of each
-- community has asked Bedrock to handle ACC applications on its behalf. Ed:
-- "This is an existing business arrangement, not a new delegation we're
-- requesting. Do not block routine ACC operations simply because a formal
-- delegation document isn't indexed in TrustEd."
--
-- Replaces the needs_clarification flags 570 set on both communities with the
-- developer's authorization, as reported by Ed, so Annie processes their
-- routine applications like the other associations (Ed approves only concrete
-- additions and driveway modifications). Recorded with:
--   basis       developer_authorization (reported by Ed Gojara, 2026-11-18)
--   instrument  the Declaration, which gives the Declarant the ARC during
--               development (Still Creek Ranch Art. X.A; August Meadows Art. XI.A)
--   supporting  Still Creek Ranch: the developer's builder ARC submittals emailed
--               to Bedrock for review (email_messages 195a76aa, 0e4ab244).
--               August Meadows: no supporting correspondence found in trustEd.
--   follow_up   obtain each developer's written confirmation
--   reserved_to developer: a decision the governing documents reserve to the
--               Declarant (a variance or deviation, an appeal) goes to the
--               developer, never automatically to Ed, and is never issued as
--               an approval until the developer decides.
-- Data only; no schema change; no acc_decisions change.
--
-- Record ownership: association_record (communities configuration).
-- ============================================================================
BEGIN;

UPDATE communities SET acc_delegation = jsonb_build_object(
    'library_document_id', '887a9352-bff5-4148-80be-28b1d36ce112',
    'library_document_title', 'Declaration of Covenants, Conditions and Restrictions - Still Creek Ranch',
    'reference', 'Declaration Art. X.A (Declarant authority over the Architectural Review Committee): the Declarant has engaged Bedrock Association Management to handle ACC applications on its behalf',
    'acts_as', 'committee', 'committee_name', 'Architectural Review Committee', 'basis', 'developer_authorization',
    'reported_by', 'Ed Gojara, 2026-11-18: the developer has at least implicitly authorized Bedrock through its requests, knowledge and established business practice',
    'supporting_correspondence', jsonb_build_array('email_messages 195a76aa-f557-4fbe-b1c1-69dec479732d (2026-07-21)', 'email_messages 0e4ab244-a28a-4813-bd95-08b5892be807 (2026-08-05)'),
    'follow_up', 'obtain the developer''s written confirmation of the arrangement',
    'reserved_to', 'developer',
    'verified_at', '2026-11-18')
  WHERE id = 'a0000000-0000-4000-8000-000000000006' AND name = 'Still Creek Ranch'
    AND EXISTS (SELECT 1 FROM library_documents d WHERE d.id = '887a9352-bff5-4148-80be-28b1d36ce112' AND d.community_id = 'a0000000-0000-4000-8000-000000000006');

UPDATE communities SET acc_delegation = jsonb_build_object(
    'library_document_id', '8e31062b-a590-413c-bc5d-1979848d23ad',
    'library_document_title', 'Declaration of Covenants, Conditions, and Restrictions for August Meadows',
    'reference', 'Declaration Art. XI.A (Declarant appoints the ARC until ARC Turnover): the Declarant has engaged Bedrock Association Management to handle ACC applications on its behalf',
    'acts_as', 'committee', 'committee_name', 'Architectural Review Committee', 'basis', 'developer_authorization',
    'reported_by', 'Ed Gojara, 2026-11-18: the developer has at least implicitly authorized Bedrock through its requests, knowledge and established business practice',
    'supporting_correspondence', '[]'::jsonb,
    'follow_up', 'obtain the developer''s written confirmation of the arrangement (no supporting correspondence found in trustEd)',
    'reserved_to', 'developer',
    'verified_at', '2026-11-18')
  WHERE id = 'a0000000-0000-4000-8000-000000000007' AND name = 'August Meadows'
    AND EXISTS (SELECT 1 FROM library_documents d WHERE d.id = '8e31062b-a590-413c-bc5d-1979848d23ad' AND d.community_id = 'a0000000-0000-4000-8000-000000000007');

COMMIT;
