-- ============================================================================
-- 570_acc_bedrock_acts_as_committee.sql  (Ed 2026-11-18)
-- ----------------------------------------------------------------------------
-- WHERE BEDROCK ACTS AS THE ACC/ARC. Ed: "Bedrock already handles ACC
-- applications on behalf of these associations because they do not have
-- functioning volunteer ACC committees. The boards know we perform this work.
-- Do not assume that the absence of a separately indexed delegation resolution
-- means Bedrock has no authority." Decision letters say the ACC/ARC Committee
-- decided; Annie acts for Bedrock and stays in the internal record.
--
-- Data only (communities.acc_delegation, added by 569). Per association, from
-- the governing documents, the management agreements and board records on file,
-- and Bedrock's established ACC practice (decided cases in acc_decisions):
--   Waterview Estates     acts as ACC  Guidelines (2016) §1.4.4.1-1.4.4.2
--                                      delegation to the Managing Agent; 43+
--                                      decisions since 2026-05-19
--   Lakes of Pine Forest  acts as ARC  Declaration Art. VI §2 (Board-appointed
--                                      ARC); Bedrock's ARC decisions since
--                                      2026-05-28; Board aware (Ed)
--   Canyon Gate           acts as ACC  Declaration Art. II (assignment of ACC
--                                      duties to the managing agent); decisions
--                                      since 2026-05-19; Board aware (Ed)
--   Quail Ridge           acts as ACC  Bylaws Art. VIII §1 (Board designates
--                                      representatives to perform the ACC's
--                                      duties); Board aware (Ed)
--   Still Creek Ranch     FLAGGED      Declaration Art. X.A: the Declarant
--                                      designates the ARC during development; no
--                                      written assignment of resident review found
--   August Meadows        FLAGGED      Declaration Art. XI.A: the Declarant
--                                      appoints the ARC until ARC Turnover;
--                                      Management Agreement §4.2 makes Bedrock
--                                      administrative support only
-- A flagged association keeps its committee/Board process (staff record that
-- decision); every other association proceeds. No schema change, no
-- acc_decisions row changes.
--
-- Record ownership: association_record (communities configuration).
-- ============================================================================
BEGIN;

UPDATE communities SET acc_delegation = acc_delegation || jsonb_build_object(
    'acts_as', 'committee', 'committee_name', 'Architectural Control Committee', 'basis', 'governing_document')
  WHERE id = 'a0000000-0000-4000-8000-000000000001' AND name = 'Waterview Estates' AND acc_delegation IS NOT NULL;

UPDATE communities SET acc_delegation = jsonb_build_object(
    'library_document_id', '13848636-9a4f-4bbe-9d63-6ba76abedcf6',
    'library_document_title', 'Master Declaration of Covenants, Conditions and Restrictions',
    'reference', 'Declaration Art. VI §2 (Architectural Review Committee appointed by the Board): Bedrock Association Management acts as the Lakes of Pine Forest Architectural Review Committee for the Board',
    'acts_as', 'committee', 'committee_name', 'Architectural Review Committee', 'basis', 'established_practice',
    'practice', 'Bedrock ARC decisions issued since 2026-05-28; the Board knows Bedrock performs ACC review (Ed Gojara, 2026-11-18)',
    'note', 'Bylaws §6.2 describes committees with at least one Director; a Board resolution designating Bedrock would document the practice',
    'verified_at', '2026-11-18')
  WHERE id = 'a0000000-0000-4000-8000-000000000002' AND name = 'Lakes of Pine Forest'
    AND EXISTS (SELECT 1 FROM library_documents d WHERE d.id = '13848636-9a4f-4bbe-9d63-6ba76abedcf6' AND d.community_id = 'a0000000-0000-4000-8000-000000000002');

UPDATE communities SET acc_delegation = jsonb_build_object(
    'library_document_id', '0edb274a-f334-435e-a379-58dc933f11a4',
    'library_document_title', 'Canyon Gate at Cinco Ranch - Declaration (Article II Architectural Control)',
    'reference', 'Declaration Art. II (assignment of Architectural Control Committee duties to the managing agent): Bedrock Association Management acts as the Canyon Gate at Cinco Ranch Architectural Control Committee',
    'acts_as', 'committee', 'committee_name', 'Architectural Control Committee', 'basis', 'established_practice',
    'practice', 'Bedrock ACC decisions issued since 2026-05-19; the Board knows Bedrock performs ACC review (Ed Gojara, 2026-11-18)',
    'note', 'Once the Board is responsible the Declaration makes the whole Board the ACC; the signed management agreement and a Board designation would document the practice',
    'verified_at', '2026-11-18')
  WHERE id = 'a0000000-0000-4000-8000-000000000003' AND name = 'Canyon Gate at Cinco Ranch'
    AND EXISTS (SELECT 1 FROM library_documents d WHERE d.id = '0edb274a-f334-435e-a379-58dc933f11a4' AND d.community_id = 'a0000000-0000-4000-8000-000000000003');

UPDATE communities SET acc_delegation = jsonb_build_object(
    'library_document_id', '3ba3d5f0-5884-4743-88bd-e8276e669e38',
    'library_document_title', 'Quail Ridge Homeowners Association Bylaws',
    'reference', 'Bylaws Art. VIII §1 (the Board designates representatives to perform the duties and exercise the authority of the Architectural Control Committee): Bedrock Association Management acts as the Quail Ridge Architectural Control Committee',
    'acts_as', 'committee', 'committee_name', 'Architectural Control Committee', 'basis', 'established_practice',
    'practice', 'Bedrock ACC decisions issued since 2026-07-06; the Board knows Bedrock performs ACC review (Ed Gojara, 2026-11-18)',
    'note', 'A Board resolution under Art. VIII §1 naming Bedrock would document the designation',
    'verified_at', '2026-11-18')
  WHERE id = 'a0000000-0000-4000-8000-000000000005' AND name = 'Quail Ridge'
    AND EXISTS (SELECT 1 FROM library_documents d WHERE d.id = '3ba3d5f0-5884-4743-88bd-e8276e669e38' AND d.community_id = 'a0000000-0000-4000-8000-000000000005');

UPDATE communities SET acc_delegation = jsonb_build_object(
    'status', 'needs_clarification',
    'reason', 'the Declarant designates the ARC during development (Declaration Art. X.A) and no written assignment of resident review to Bedrock is on file',
    'verified_at', '2026-11-18')
  WHERE id = 'a0000000-0000-4000-8000-000000000006' AND name = 'Still Creek Ranch';

UPDATE communities SET acc_delegation = jsonb_build_object(
    'status', 'needs_clarification',
    'reason', 'the Declarant appoints the ARC until ARC Turnover (Declaration Art. XI.A) and the management agreement (§4.2) makes Bedrock administrative support for the ARC',
    'verified_at', '2026-11-18')
  WHERE id = 'a0000000-0000-4000-8000-000000000007' AND name = 'August Meadows';

COMMIT;
