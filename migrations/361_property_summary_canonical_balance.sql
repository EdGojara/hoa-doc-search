-- ============================================================================
-- 361_property_summary_canonical_balance.sql
-- ----------------------------------------------------------------------------
-- Make v_property_summary.current_balance read the CANONICAL owner balance, so
-- every surface that reads this view (Owner AR tab, community map AR status,
-- contact search, board portal) shows the same accurate number.
--
-- Scar (Ed 2026-08-10): current_balance came only from v_latest_ar_per_property
-- (owner_ar_snapshots) — a legacy/collections snapshot that is NULL for the
-- Vantaca-migrated communities, whose real AR lives in the transaction ledger
-- (v_homeowner_current_balance). So the Owner AR tab and community map showed
-- $0/null AR for Waterview et al., while $251,838 was actually owed across 290
-- accounts. Three different balance sources, and these surfaces read the empty
-- one.
--
-- Fix: COALESCE the canonical ledger (v_homeowner_current_balance, summed to one
-- row per property so it can't fan out this single-row-per-property view;
-- balance_cents -> dollars to match the existing column) ahead of the legacy
-- snapshot. Snapshot stays as the fallback for any community with no ledger.
-- CREATE OR REPLACE keeps the exact column list, so grants + dependents are
-- preserved (no DROP-VIEW grant-loss scar). Aging buckets + at_legal still come
-- from the snapshot here; consumers that need the legal flag should read the
-- enforcement SSOT (property_enforcement_states) — a follow-up.
--
-- Record ownership: DDL only (a view). association_record N/A.
-- ============================================================================
BEGIN;

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
  ),
  -- Canonical current balance: the transaction ledger, summed to ONE row per
  -- property so the LEFT JOIN below can't multiply this per-property view.
  hcb AS (
    SELECT property_id, SUM(balance_cents) AS balance_cents
    FROM v_homeowner_current_balance
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

  -- AR fields. current_balance now prefers the canonical transaction ledger
  -- (dollars), falling back to the legacy snapshot only where there is no ledger.
  COALESCE(hcb.balance_cents / 100.0, ar.balance_total)  AS current_balance,
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
LEFT JOIN v_latest_ar_per_property ar    ON ar.property_id = p.id
LEFT JOIN hcb                            ON hcb.property_id = p.id;

GRANT SELECT ON v_property_summary TO service_role, authenticated;

COMMIT;
