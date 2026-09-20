-- 439_demo_tenant_and_audit.sql
-- ----------------------------------------------------------------------------
-- Demo isolation foundation (Ed 2026-09-20, Option A):
--   * A dedicated DEMO management company (tenant). Demo organizations belong
--     here, NOT to Bedrock, so every `management_company_id = BEDROCK` portfolio
--     query, job, metric and the retrieval substrate exclude demo by construction.
--   * Move the demo community(ies) and ALL operational child records that carry a
--     management_company_id to the demo tenant, so no operational child is left
--     with a Bedrock tenant id when its parent org has moved. Identity
--     (portal_users) is intentionally NOT moved: it stays in the shared auth
--     structure and is isolated by the demo-sign-in gate + is_demo.
--   * demo_suppressed_actions: the "would-have-sent/performed" audit the outbound
--     guard writes when it blocks a demo action, so suppressed actions are
--     inspectable inside the demo.
-- Additive + idempotent. is_demo is preserved.
BEGIN;

-- 1) The dedicated demo tenant.
INSERT INTO management_companies (id, name, legal_name, active)
SELECT 'd0000000-0000-4000-a000-000000000000', 'Demo Management Company', 'Demo Management Company, LLC', true
WHERE NOT EXISTS (SELECT 1 FROM management_companies WHERE id = 'd0000000-0000-4000-a000-000000000000');

-- 2) Move demo communities to the demo tenant. is_demo stays TRUE.
UPDATE communities
   SET management_company_id = 'd0000000-0000-4000-a000-000000000000'
 WHERE is_demo = TRUE
   AND management_company_id IS DISTINCT FROM 'd0000000-0000-4000-a000-000000000000';

-- 3) Move every operational child record carrying BOTH management_company_id and
-- community_id whose community now belongs to the demo tenant. Dynamic over base
-- tables so no child is ever left with a Bedrock tenant id (present or future
-- tables), without hand-enumerating. `communities` has no community_id column so
-- it is not touched here (handled in step 2). portal_users has no community_id and
-- is intentionally excluded (identity stays shared).
DO $$
DECLARE
  demo_mc  uuid := 'd0000000-0000-4000-a000-000000000000';
  demo_ids uuid[];
  r RECORD;
BEGIN
  SELECT array_agg(id) INTO demo_ids FROM communities WHERE management_company_id = demo_mc;
  IF demo_ids IS NULL OR array_length(demo_ids, 1) IS NULL THEN RETURN; END IF;
  FOR r IN
    SELECT t.table_name
      FROM information_schema.tables t
     WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       AND EXISTS (SELECT 1 FROM information_schema.columns m
                    WHERE m.table_schema = 'public' AND m.table_name = t.table_name
                      AND m.column_name = 'management_company_id')
       AND EXISTS (SELECT 1 FROM information_schema.columns cc
                    WHERE cc.table_schema = 'public' AND cc.table_name = t.table_name
                      AND cc.column_name = 'community_id')
  LOOP
    EXECUTE format(
      'UPDATE public.%I SET management_company_id = $1 WHERE community_id = ANY($2) AND management_company_id IS DISTINCT FROM $1',
      r.table_name
    ) USING demo_mc, demo_ids;
  END LOOP;
END $$;

-- 4) Suppressed-action audit: what a demo org WOULD have sent/performed.
CREATE TABLE IF NOT EXISTS demo_suppressed_actions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel       TEXT NOT NULL,       -- email_graph | email_resend | sms | certified_mail | stripe:*
  community_id  UUID,
  recipient     TEXT,
  subject       TEXT,
  summary       TEXT,
  reason        TEXT NOT NULL,       -- demo_community | demo_context | demo_recipient (+ combos)
  payload       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_demo_suppressed_created   ON demo_suppressed_actions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_demo_suppressed_community ON demo_suppressed_actions (community_id);
GRANT SELECT, INSERT ON demo_suppressed_actions TO service_role;
GRANT SELECT           ON demo_suppressed_actions TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
