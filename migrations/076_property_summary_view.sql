-- ============================================================================
-- 076_property_summary_view.sql
-- ----------------------------------------------------------------------------
-- Phase 3 deliverable (project_unified_architecture.md). The single SQL view
-- that powers the board portal's property tile (project_board_portal.md):
-- one row per property, with everything currently known about it joined in.
--
-- After this view ships, the entire board-portal data layer is one query:
--   SELECT * FROM v_property_summary WHERE community_id = $1
-- Returns one row per home, with owner, residency type, violation counts,
-- ARC activity, interaction counts, knowledge-doc breadth — all the inputs
-- the property tile needs.
--
-- WHAT IT INCLUDES TODAY:
--   - Property identity (address, unit, type)
--   - Current owner (from v_current_property_owners view, migration 049)
--   - Current residency type (from v_current_residents, migration 049)
--   - Open violations count + most-severe stage (from violations, migration 050)
--   - Total violations + last opened date (last 12mo + lifetime)
--   - ARC decisions count + last decided date (from arc_historical_decisions)
--   - Interactions count + last interaction type/date (from interactions,
--     migration 050 — currently mostly empty until DRV/email integrations
--     write to it, but the view reads it correctly when data lands)
--   - Knowledge-substrate doc count linked to this property (from
--     knowledge_documents.property_id added in migration 075)
--   - Latest inspection date (from inspections, migration 050)
--
-- WHAT IT DOESN'T INCLUDE YET:
--   - AR balance / at-legal flag — lives in Vantaca today, requires a sync
--     pipeline to mirror locally. Add column to view (or join) when that lands.
--   - Outstanding ARC requests in flight (separate from historical decisions)
--   - Future common-area-impact rollups (when DRV inspections accumulate)
-- Add additional columns to the view as those data sources connect.
--
-- Apply AFTER 075. Idempotent (CREATE OR REPLACE VIEW).
-- ============================================================================

CREATE OR REPLACE VIEW v_property_summary AS
WITH
  -- Per-property open-violation rollup
  vio_open AS (
    SELECT
      property_id,
      COUNT(*)::int                                            AS open_count,
      -- Most-severe stage among open violations on this property
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
  -- Lifetime / 12mo violation counts
  vio_all AS (
    SELECT
      property_id,
      COUNT(*)::int                                            AS lifetime_violations,
      COUNT(*) FILTER (WHERE opened_at >= NOW() - INTERVAL '12 months')::int AS violations_last_12mo,
      MAX(opened_at)                                           AS last_violation_at
    FROM violations
    GROUP BY property_id
  ),
  -- ARC decisions rollup (uses property_id added in migration 075)
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
  -- Interactions rollup (memory-layer activity)
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
  -- Substrate breadth: how many askEd-searchable docs link to this property
  substrate_rollup AS (
    SELECT
      property_id,
      COUNT(*)::int                                            AS substrate_doc_count
    FROM knowledge_documents
    WHERE property_id IS NOT NULL
      AND status = 'active'
    GROUP BY property_id
  ),
  -- Most recent inspection observation per property. NB: inspections is the
  -- route/session record (community-scoped, no property_id). The per-property
  -- inspection findings live in property_observations — that's where the
  -- "when was this house last observed" signal actually lives.
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
  -- Property identity
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

  -- Current owner
  own.owner_contact_id,
  own.owner_name,
  own.owner_email,
  own.owner_phone,
  own.owned_since,
  own.vesting,

  -- Current resident / residency status
  res.resident_contact_id,
  res.resident_name,
  res.resident_email,
  res.residency_type,
  res.lease_end_date,
  -- Convenience flag: true when residency_type='owner_occupied'
  (res.residency_type = 'owner_occupied') AS owner_occupied,

  -- Violations — open + history
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

  -- ARC activity
  COALESCE(arc.arc_decisions_count, 0)       AS arc_decisions_count,
  COALESCE(arc.arc_approved_count, 0)        AS arc_approved_count,
  COALESCE(arc.arc_denied_count, 0)          AS arc_denied_count,
  COALESCE(arc.arc_conditional_count, 0)     AS arc_conditional_count,
  arc.last_arc_decided_at,

  -- Memory-layer interactions
  COALESCE(ix.interactions_count, 0)         AS interactions_count,
  COALESCE(ix.interactions_last_12mo, 0)     AS interactions_last_12mo,
  ix.last_interaction_at,

  -- askEd-searchable doc breadth tied to this property
  COALESCE(sub.substrate_doc_count, 0)       AS substrate_doc_count,

  -- Inspection history
  COALESCE(insp.inspections_count, 0)        AS inspections_count,
  insp.last_inspected_at

FROM properties p
JOIN communities c                       ON c.id = p.community_id
LEFT JOIN v_current_property_owners own  ON own.property_id = p.id
LEFT JOIN v_current_residents      res   ON res.property_id = p.id
LEFT JOIN vio_open vo                    ON vo.property_id = p.id
LEFT JOIN vio_all va                     ON va.property_id = p.id
LEFT JOIN arc_rollup arc                 ON arc.property_id = p.id
LEFT JOIN interaction_rollup ix          ON ix.property_id = p.id
LEFT JOIN substrate_rollup sub           ON sub.property_id = p.id
LEFT JOIN inspection_rollup insp         ON insp.property_id = p.id;

COMMENT ON VIEW v_property_summary IS
  'Single-row-per-property aggregator for the board portal property tile. Joins ownership, residency, violations, ARC decisions, interactions, knowledge-substrate breadth, and inspection history. Add columns here when new data sources connect (AR balance from Vantaca sync, common-area linkages, etc.). See project_board_portal.md.';

GRANT SELECT ON v_property_summary TO service_role, authenticated;
