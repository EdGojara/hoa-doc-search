-- ============================================================================
-- 077_owner_ar_snapshots.sql
-- ----------------------------------------------------------------------------
-- Owner Receivables module (project_owner_receivables.md). Until full
-- accounting integration ships, this is the bridge: drag-drop monthly
-- Vantaca AR reports, AI extracts per-property balances + aging buckets +
-- status flags, snapshot persists. Joins into v_property_summary so the
-- board portal property tile shows current balance + at-legal flag.
--
-- IMPORTANT — single source of truth discipline (feedback_single_source_of_truth.md):
-- Vantaca remains canonical for AR. These rows are time-stamped snapshots
-- for visibility, NOT live ledger state. Every surface that displays an AR
-- balance must label it 'as of [snapshot_date]' so no one confuses our
-- snapshot for the live record.
--
-- Schema designed to be REPLACEABLE — when Bedrock eventually owns the GL
-- and writes its own AR, this table converts cleanly into 'AR audit trail'
-- (history of what we knew when); the live AR table joins on top. Don't
-- overbuild the snapshot layer; overbuild the contract with consumers.
--
-- Apply AFTER 076. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) owner_ar_snapshots — one row per property × snapshot date
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS owner_ar_snapshots (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id    UUID NOT NULL REFERENCES management_companies(id),
  community_id             UUID NOT NULL REFERENCES communities(id),  -- denormalized for fast portfolio queries
  property_id              UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,

  -- The as-of date claimed by this snapshot. Operators set this from the
  -- header of the uploaded report (e.g., 'Aging report as of 2026-04-30').
  -- Multiple snapshots per property allowed (one per month is typical).
  snapshot_date            DATE NOT NULL,

  -- Provenance
  source_filename          TEXT,
  source_storage_path      TEXT,                  -- Supabase storage path to the original PDF
  ingest_batch_id          UUID,                  -- groups all rows from one Vantaca report upload

  -- Balance + aging buckets. NUMERIC for accounting precision; not money type
  -- because Postgres money is locale-fragile.
  balance_total            NUMERIC(12, 2),
  bucket_0_30              NUMERIC(12, 2),
  bucket_31_60             NUMERIC(12, 2),
  bucket_61_90             NUMERIC(12, 2),
  bucket_91_120            NUMERIC(12, 2),
  bucket_over_120          NUMERIC(12, 2),

  -- Status flags surface the most common dunning-stage signals boards care
  -- about. All optional; only set when the AR report indicates them.
  at_legal                 BOOLEAN NOT NULL DEFAULT FALSE,         -- with attorney / in collections
  in_collections           BOOLEAN NOT NULL DEFAULT FALSE,         -- formal collections process
  payment_plan_active      BOOLEAN NOT NULL DEFAULT FALSE,
  payment_plan_terms_text  TEXT,                                   -- '$200/mo through Dec 2026'
  enforcement_stage        TEXT
                             CHECK (enforcement_stage IS NULL OR enforcement_stage IN (
                               'reminder', 'courtesy_1', 'courtesy_2',
                               'certified_209', 'at_legal', 'with_attorney',
                               'in_collections', 'judgment', 'lien_filed'
                             )),
  enforcement_notes        TEXT,                                   -- free-form context from the AR report

  -- Audit + review
  raw_extraction           JSONB,                                  -- full per-row extraction from AI
  extracted_by_model       TEXT,
  extraction_confidence    TEXT
                             CHECK (extraction_confidence IS NULL OR extraction_confidence IN ('high', 'medium', 'low')),
  ingested_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ingested_by_user_id      UUID,
  approved_at              TIMESTAMPTZ,                            -- NULL = pending operator review
  approved_by_user_id      UUID,
  notes                    TEXT,                                   -- operator review notes

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One snapshot per property per snapshot_date. Re-uploading the same
  -- report shouldn't produce duplicate rows; operator re-extract path
  -- updates the existing row instead.
  UNIQUE (property_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_ar_snapshots_property_date
  ON owner_ar_snapshots(property_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_ar_snapshots_community_date
  ON owner_ar_snapshots(community_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_ar_snapshots_at_legal
  ON owner_ar_snapshots(community_id, at_legal, snapshot_date DESC)
  WHERE at_legal = TRUE;
CREATE INDEX IF NOT EXISTS idx_ar_snapshots_pending
  ON owner_ar_snapshots(community_id, ingested_at DESC)
  WHERE approved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ar_snapshots_batch
  ON owner_ar_snapshots(ingest_batch_id)
  WHERE ingest_batch_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_ar_snapshots_updated_at ON owner_ar_snapshots;
CREATE TRIGGER trg_ar_snapshots_updated_at
  BEFORE UPDATE ON owner_ar_snapshots
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- 2) ar_ingest_batches — one row per Vantaca AR upload, for ingest history UI
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ar_ingest_batches (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id    UUID NOT NULL REFERENCES management_companies(id),
  community_id             UUID REFERENCES communities(id),  -- NULL for multi-community batches (rare)
  uploaded_by_user_id      UUID,
  uploaded_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_filename          TEXT,
  source_storage_path      TEXT,
  snapshot_date            DATE,                              -- as-of date claimed by the report
  total_rows               INTEGER NOT NULL DEFAULT 0,
  rows_matched_property    INTEGER NOT NULL DEFAULT 0,        -- how many AR rows resolved to a property
  rows_unmatched           INTEGER NOT NULL DEFAULT 0,
  status                   TEXT NOT NULL DEFAULT 'previewed'
                             CHECK (status IN ('previewed', 'approved', 'discarded')),
  approved_at              TIMESTAMPTZ,
  approved_by_user_id      UUID,
  raw_extraction           JSONB,                             -- full extracted preview
  extraction_model         TEXT,
  notes                    TEXT
);

CREATE INDEX IF NOT EXISTS idx_ar_ingest_batches_community
  ON ar_ingest_batches(community_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_ar_ingest_batches_status
  ON ar_ingest_batches(status, uploaded_at DESC);

-- ----------------------------------------------------------------------------
-- 3) v_latest_ar_per_property — one row per property, latest snapshot
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_latest_ar_per_property AS
SELECT DISTINCT ON (property_id)
  property_id,
  community_id,
  snapshot_date,
  balance_total,
  bucket_0_30,
  bucket_31_60,
  bucket_61_90,
  bucket_91_120,
  bucket_over_120,
  at_legal,
  in_collections,
  payment_plan_active,
  payment_plan_terms_text,
  enforcement_stage,
  enforcement_notes,
  CURRENT_DATE - snapshot_date AS days_since_snapshot
FROM owner_ar_snapshots
WHERE approved_at IS NOT NULL   -- only show approved snapshots; pending stays out of board surfaces
ORDER BY property_id, snapshot_date DESC;

COMMENT ON VIEW v_latest_ar_per_property IS
  'One row per property, latest approved AR snapshot. days_since_snapshot lets the UI flag stale data (default warning at >35 days). Pending/discarded snapshots excluded.';

-- ----------------------------------------------------------------------------
-- 4) Extend v_property_summary to expose AR fields
-- ----------------------------------------------------------------------------
-- The property tile in the board portal needs current_balance + at_legal_flag
-- + days_since_ar_snapshot. Drop and recreate v_property_summary so the JOIN
-- to v_latest_ar_per_property lights up automatically.

DROP VIEW IF EXISTS v_property_summary;

CREATE OR REPLACE VIEW v_property_summary AS
WITH
  vio_open AS (
    SELECT
      property_id,
      COUNT(*)::int                                            AS open_count,
      MAX(CASE current_stage
            WHEN 'fine_assessed'  THEN 5
            WHEN 'certified_209'  THEN 4
            WHEN 'courtesy_2'     THEN 3
            WHEN 'courtesy_1'     THEN 2
            ELSE 1 END)                                        AS max_stage_rank
    FROM violations
    WHERE current_stage NOT IN ('cured','closed','voided')
    GROUP BY property_id
  ),
  vio_all AS (
    SELECT
      property_id,
      COUNT(*)::int                                            AS lifetime_violations,
      COUNT(*) FILTER (WHERE opened_at >= NOW() - INTERVAL '12 months')::int AS violations_last_12mo,
      MAX(opened_at)                                           AS last_violation_at
    FROM violations
    GROUP BY property_id
  ),
  arc_rollup AS (
    SELECT
      property_id,
      COUNT(*)::int                                            AS arc_decisions_count,
      COUNT(*) FILTER (WHERE decision_type = 'approved')::int  AS arc_approved_count,
      COUNT(*) FILTER (WHERE decision_type = 'denied')::int    AS arc_denied_count,
      COUNT(*) FILTER (WHERE decision_type = 'conditional')::int AS arc_conditional_count,
      MAX(decided_at)                                          AS last_arc_decided_at
    FROM arc_historical_decisions
    WHERE property_id IS NOT NULL
    GROUP BY property_id
  ),
  interaction_rollup AS (
    SELECT
      property_id,
      COUNT(*)::int                                            AS interactions_count,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '12 months')::int AS interactions_last_12mo,
      MAX(created_at)                                          AS last_interaction_at
    FROM interactions
    WHERE property_id IS NOT NULL
    GROUP BY property_id
  ),
  substrate_rollup AS (
    SELECT
      property_id,
      COUNT(*)::int                                            AS substrate_doc_count
    FROM knowledge_documents
    WHERE property_id IS NOT NULL
      AND status = 'active'
    GROUP BY property_id
  ),
  inspection_rollup AS (
    SELECT
      property_id,
      COUNT(*)::int                                            AS inspections_count,
      MAX(created_at)                                          AS last_inspected_at
    FROM property_observations
    WHERE property_id IS NOT NULL
    GROUP BY property_id
  )
SELECT
  p.id                                       AS property_id,
  p.community_id,
  c.name                                     AS community_name,
  p.street_address,
  p.unit,
  p.city,
  p.state,
  p.zip,
  p.property_type,
  p.lot_number,
  p.vantaca_account_id,

  own.owner_contact_id,
  own.owner_name,
  own.owner_email,
  own.owner_phone,
  own.owned_since,
  own.vesting,

  res.resident_contact_id,
  res.resident_name,
  res.resident_email,
  res.residency_type,
  res.lease_end_date,
  (res.residency_type = 'owner_occupied') AS owner_occupied,

  COALESCE(vo.open_count, 0)                 AS open_violations,
  CASE COALESCE(vo.max_stage_rank, 0)
    WHEN 5 THEN 'fine_assessed'
    WHEN 4 THEN 'certified_209'
    WHEN 3 THEN 'courtesy_2'
    WHEN 2 THEN 'courtesy_1'
    ELSE NULL
  END                                        AS worst_open_stage,
  COALESCE(va.lifetime_violations, 0)        AS lifetime_violations,
  COALESCE(va.violations_last_12mo, 0)       AS violations_last_12mo,
  va.last_violation_at,

  COALESCE(arc.arc_decisions_count, 0)       AS arc_decisions_count,
  COALESCE(arc.arc_approved_count, 0)        AS arc_approved_count,
  COALESCE(arc.arc_denied_count, 0)          AS arc_denied_count,
  COALESCE(arc.arc_conditional_count, 0)     AS arc_conditional_count,
  arc.last_arc_decided_at,

  COALESCE(ix.interactions_count, 0)         AS interactions_count,
  COALESCE(ix.interactions_last_12mo, 0)     AS interactions_last_12mo,
  ix.last_interaction_at,

  COALESCE(sub.substrate_doc_count, 0)       AS substrate_doc_count,

  COALESCE(insp.inspections_count, 0)        AS inspections_count,
  insp.last_inspected_at,

  -- AR fields (NEW)
  ar.balance_total                           AS current_balance,
  ar.bucket_0_30                             AS ar_bucket_0_30,
  ar.bucket_31_60                            AS ar_bucket_31_60,
  ar.bucket_61_90                            AS ar_bucket_61_90,
  ar.bucket_91_120                           AS ar_bucket_91_120,
  ar.bucket_over_120                         AS ar_bucket_over_120,
  ar.at_legal                                AS ar_at_legal,
  ar.in_collections                          AS ar_in_collections,
  ar.payment_plan_active                     AS ar_payment_plan_active,
  ar.enforcement_stage                       AS ar_enforcement_stage,
  ar.snapshot_date                           AS ar_snapshot_date,
  ar.days_since_snapshot                     AS ar_days_since_snapshot

FROM properties p
JOIN communities c                       ON c.id = p.community_id
LEFT JOIN v_current_property_owners own  ON own.property_id = p.id
LEFT JOIN v_current_residents      res   ON res.property_id = p.id
LEFT JOIN vio_open vo                    ON vo.property_id = p.id
LEFT JOIN vio_all va                     ON va.property_id = p.id
LEFT JOIN arc_rollup arc                 ON arc.property_id = p.id
LEFT JOIN interaction_rollup ix          ON ix.property_id = p.id
LEFT JOIN substrate_rollup sub           ON sub.property_id = p.id
LEFT JOIN inspection_rollup insp         ON insp.property_id = p.id
LEFT JOIN v_latest_ar_per_property ar    ON ar.property_id = p.id;

COMMENT ON VIEW v_property_summary IS
  'Single-row-per-property aggregator for the board portal property tile. After migration 077: now includes AR snapshot fields (current_balance, aging buckets, at_legal flag, days_since_snapshot). NULL AR columns indicate no approved snapshot exists yet for that property.';

GRANT SELECT ON v_property_summary, v_latest_ar_per_property TO service_role, authenticated;
GRANT ALL  ON owner_ar_snapshots, ar_ingest_batches TO service_role;
GRANT SELECT ON owner_ar_snapshots, ar_ingest_batches TO authenticated;
