-- ============================================================================
-- 495_onboarding_evidence.sql  (Ed 2026-10-07)
-- ----------------------------------------------------------------------------
-- EVIDENCE-ONLY documents on an onboarding batch, at any stage before execution.
--
-- Why: opening reclassifications, corrections and ledger dispositions must cite a
-- document that belongs to the batch (sha256 + locator). Source reports may only be
-- registered in intake (onboarding_register_artifact), so a document discovered
-- later (a prior manager's coded balance sheet, a bank statement proving a source
-- error) could never be attached. This adds a SEPARATE, append-only evidence store:
--   * it never replaces or mutates a source report (onboarding_artifacts untouched);
--   * it never changes the cutoff date, the stage, or any recorded result;
--   * nothing is rerun: normalization and source controls never read evidence;
--   * every row records who attached it, when, the file name, its fingerprint
--     (sha256 of the stored bytes) and the evidence purpose;
--   * refused once the batch is in execute / post_proof / complete.
-- The snapshot accepts these fingerprints as citable evidence; execution can
-- reference them through the snapshot's provenance.
--
-- Record ownership: workpaper (Bedrock's conversion working papers; the source
-- documents themselves may be association records held elsewhere).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS onboarding_evidence (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              uuid NOT NULL,
  community_id          uuid NOT NULL,
  filename              text NOT NULL,
  sha256                text NOT NULL,
  bytes                 bigint NOT NULL,
  storage_path          text NOT NULL,
  purpose               text NOT NULL,
  batch_stage_at_attach text NOT NULL,
  attached_by_kind      text NOT NULL,
  attached_by           text NOT NULL,
  attached_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT onboarding_evidence_batch_fk FOREIGN KEY (batch_id) REFERENCES conversion_batches(id) ON DELETE RESTRICT,
  CONSTRAINT onboarding_evidence_community_fk FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE RESTRICT,
  CONSTRAINT onboarding_evidence_sha_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT onboarding_evidence_bytes_check CHECK (bytes > 0),
  CONSTRAINT onboarding_evidence_purpose_check CHECK (length(btrim(purpose)) >= 10),
  CONSTRAINT onboarding_evidence_kind_check CHECK (attached_by_kind IN ('human', 'agent', 'system')),
  CONSTRAINT uq_onboarding_evidence_batch_sha UNIQUE (batch_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_onboarding_evidence_batch ON onboarding_evidence (batch_id, attached_at);

DROP TRIGGER IF EXISTS trg_onboarding_evidence_append_only ON onboarding_evidence;
CREATE TRIGGER trg_onboarding_evidence_append_only BEFORE UPDATE OR DELETE ON onboarding_evidence
  FOR EACH ROW EXECUTE FUNCTION onboarding_append_only();

CREATE OR REPLACE FUNCTION onboarding_register_evidence(p_batch UUID, p_evidence JSONB, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS UUID LANGUAGE plpgsql AS $fn$
DECLARE bt conversion_batches%ROWTYPE; e UUID;
BEGIN
  PERFORM onboarding_assert_actor(p_actor_kind, p_actor_id, FALSE);
  SELECT * INTO bt FROM conversion_batches WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'onboarding: no such batch' USING ERRCODE = 'check_violation'; END IF;
  IF bt.onboarding_stage IS NULL OR bt.onboarding_stage IN ('execute', 'post_proof', 'complete') THEN
    RAISE EXCEPTION 'onboarding: evidence can only be attached before execution (batch is in %)', coalesce(bt.onboarding_stage, '(not enrolled)') USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO onboarding_evidence (batch_id, community_id, filename, sha256, bytes, storage_path, purpose, batch_stage_at_attach, attached_by_kind, attached_by)
  VALUES (p_batch, bt.community_id, p_evidence->>'filename', p_evidence->>'sha256', (p_evidence->>'bytes')::bigint, p_evidence->>'storage_path',
          p_evidence->>'purpose', bt.onboarding_stage, p_actor_kind, p_actor_id)
  RETURNING id INTO e;
  RETURN e;
END;
$fn$;

CREATE OR REPLACE FUNCTION onboarding_evidence_view(p_batch UUID)
RETURNS JSONB LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'filename', filename, 'sha256', sha256, 'bytes', bytes, 'storage_path', storage_path, 'purpose', purpose,
           'batch_stage_at_attach', batch_stage_at_attach, 'attached_by_kind', attached_by_kind, 'attached_by', attached_by, 'attached_at', attached_at) ORDER BY attached_at, id), '[]'::jsonb)
    FROM onboarding_evidence WHERE batch_id = p_batch;
$fn$;

GRANT SELECT, INSERT ON onboarding_evidence TO service_role;
REVOKE ALL ON FUNCTION onboarding_register_evidence(UUID, JSONB, TEXT, TEXT), onboarding_evidence_view(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION onboarding_register_evidence(UUID, JSONB, TEXT, TEXT), onboarding_evidence_view(UUID) TO service_role;

COMMIT;
