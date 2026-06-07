-- ============================================================================
-- 187_drama_creek_demo_depth.sql
-- ----------------------------------------------------------------------------
-- Drama Creek demo depth — Day 2 seed data for the demo community built in
-- migration 184. Adds scenario-appropriate AR snapshots and sample
-- homeowner_calls so prospect walkthroughs see real data, not empty tiles.
--
-- WHAT'S IN THIS MIGRATION:
--   1. AR snapshots — one per demo persona with scenario-appropriate balance,
--      enforcement_stage, at_legal / payment_plan flags
--   2. Sample homeowner_calls — recent calls for select personas so Claire's
--      pre-call warmup context has something to surface
--
-- WHAT'S NOT YET (will land in follow-up migrations):
--   - Violations (needs enforcement_categories seeded first for Drama Creek)
--   - ACC pipeline (schema source-of-truth still being settled)
--   - Financials (GL, budget, reserve study) — bigger scope
--   - Vendor contracts (landscape, pool, gate)
--   - Annual meeting cycle
--   - Sample email threads
--
-- All inserts guarded with ON CONFLICT — safe to re-run.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) AR SNAPSHOTS
--
-- One per demo persona, snapshot_date = 5 days ago (recent enough to be
-- credible, old enough to reasonably need a "live number from accounting"
-- disclosure per HARD RULE #5).
--
-- Scenarios:
--   Bob Steady          — model owner, $0, current
--   Jennifer Lateleaves — small balance $75 (late fee in courtesy stage)
--   Marcus Behindbills  — $2,400 on active payment plan, courtesy_2 stage
--   Patricia Newpaint   — $0, current (her ACC drama is separate from AR)
--   Greg Yardgone       — $4,800, at_legal=true, with_attorney stage
--   Sarah Welcome       — $325 (one assessment payment just due, new owner)
--   Margaret Foundingmember — $0 (perfect record after 28 years)
--   Tom Investorson     — $300 (one assessment late, off-site landlord)
--   All board members   — $0 (they're on the board, gotta be current)
-- ----------------------------------------------------------------------------
INSERT INTO owner_ar_snapshots (
  id, management_company_id, community_id, property_id,
  snapshot_date, balance_total,
  bucket_0_30, bucket_31_60, bucket_61_90, bucket_91_120, bucket_over_120,
  at_legal, in_collections, payment_plan_active, payment_plan_terms_text,
  enforcement_stage, enforcement_notes,
  approved_at, notes
) VALUES
  -- Bob Steady — model owner, current. Property dc110001 (101 Tranquility Trail)
  ('dc150001-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'dc100000-0000-4000-a000-000000000000', 'dc110001-0000-4000-a000-000000000000',
   CURRENT_DATE - 5, 0.00, 0, 0, 0, 0, 0,
   FALSE, FALSE, FALSE, NULL,
   NULL, NULL,
   NOW(), 'Demo: model homeowner, clean record.'),
  -- Jennifer Lateleaves — small $75 balance (late fee). Property dc110011 (102 Serenity Court)
  ('dc150002-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'dc100000-0000-4000-a000-000000000000', 'dc110011-0000-4000-a000-000000000000',
   CURRENT_DATE - 5, 75.00, 75.00, 0, 0, 0, 0,
   FALSE, FALSE, FALSE, NULL,
   'courtesy_1', 'Late fee from missed payment; current cycle.',
   NOW(), 'Demo: active enforcement scenario, minor AR.'),
  -- Marcus Behindbills — $2,400 with active payment plan. Property dc110021 (201 Harmony Lane)
  ('dc150003-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'dc100000-0000-4000-a000-000000000000', 'dc110021-0000-4000-a000-000000000000',
   CURRENT_DATE - 5, 2400.00, 400.00, 800.00, 600.00, 400.00, 200.00,
   FALSE, FALSE, TRUE, '$200/month through October 2026',
   'courtesy_2', 'Active payment plan since April 2026. Current on plan; total assessment debt being paid down.',
   NOW(), 'Demo: payment plan scenario, working with accounting team.'),
  -- Patricia Newpaint — $0, current. Property dc110035 (210 Peaceful Pond Drive)
  ('dc150004-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'dc100000-0000-4000-a000-000000000000', 'dc110035-0000-4000-a000-000000000000',
   CURRENT_DATE - 5, 0.00, 0, 0, 0, 0, 0,
   FALSE, FALSE, FALSE, NULL,
   NULL, NULL,
   NOW(), 'Demo: ACC-in-review scenario, AR is clean.'),
  -- Greg Yardgone — $4,800 at-legal. Property dc110041 (301 Calm Waters Way)
  ('dc150005-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'dc100000-0000-4000-a000-000000000000', 'dc110041-0000-4000-a000-000000000000',
   CURRENT_DATE - 5, 4800.00, 0, 0, 0, 600.00, 4200.00,
   TRUE, FALSE, FALSE, NULL,
   'with_attorney', 'Account turned over to collection counsel March 2026. Multiple violations also outstanding.',
   NOW(), 'Demo: at-legal scenario, attorney handling.'),
  -- Sarah Welcome — $325 (one assessment, new owner just got first bill). Property dc110050 (331 Calm Waters Way)
  ('dc150006-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'dc100000-0000-4000-a000-000000000000', 'dc110050-0000-4000-a000-000000000000',
   CURRENT_DATE - 5, 325.00, 325.00, 0, 0, 0, 0,
   FALSE, FALSE, FALSE, NULL,
   NULL, 'First assessment after recent closing.',
   NOW(), 'Demo: new owner scenario.'),
  -- Margaret Foundingmember — $0, perfect record. Property dc110010 (131 Tranquility Trail)
  ('dc150007-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'dc100000-0000-4000-a000-000000000000', 'dc110010-0000-4000-a000-000000000000',
   CURRENT_DATE - 5, 0.00, 0, 0, 0, 0, 0,
   FALSE, FALSE, FALSE, NULL,
   NULL, NULL,
   NOW(), 'Demo: long-tenured original buyer, never missed an assessment.'),
  -- Tom Investorson — $300 (rental, off-site mailing, just one assessment late). Property dc110030 (231 Harmony Lane)
  ('dc150008-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'dc100000-0000-4000-a000-000000000000', 'dc110030-0000-4000-a000-000000000000',
   CURRENT_DATE - 5, 300.00, 300.00, 0, 0, 0, 0,
   FALSE, FALSE, FALSE, NULL,
   'reminder', 'Late assessment — investor/LLC ownership; mailing address differs from property.',
   NOW(), 'Demo: investor/landlord scenario.'),
  -- Board members — all $0, all current. Required for board service.
  ('dc150009-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'dc100000-0000-4000-a000-000000000000', 'dc110005-0000-4000-a000-000000000000',
   CURRENT_DATE - 5, 0.00, 0, 0, 0, 0, 0, FALSE, FALSE, FALSE, NULL, NULL, NULL, NOW(),
   'Demo: Sunny Meadows, board president.'),
  ('dc15000a-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'dc100000-0000-4000-a000-000000000000', 'dc110031-0000-4000-a000-000000000000',
   CURRENT_DATE - 5, 0.00, 0, 0, 0, 0, 0, FALSE, FALSE, FALSE, NULL, NULL, NULL, NOW(),
   'Demo: Byron T. Bylaw, VP.'),
  ('dc15000b-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'dc100000-0000-4000-a000-000000000000', 'dc110023-0000-4000-a000-000000000000',
   CURRENT_DATE - 5, 0.00, 0, 0, 0, 0, 0, FALSE, FALSE, FALSE, NULL, NULL, NULL, NOW(),
   'Demo: Cassandra Complaine, Secretary.'),
  ('dc15000c-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'dc100000-0000-4000-a000-000000000000', 'dc110015-0000-4000-a000-000000000000',
   CURRENT_DATE - 5, 0.00, 0, 0, 0, 0, 0, FALSE, FALSE, FALSE, NULL, NULL, NULL, NOW(),
   'Demo: Tally Hawthorne, Treasurer.'),
  ('dc15000d-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'dc100000-0000-4000-a000-000000000000', 'dc110043-0000-4000-a000-000000000000',
   CURRENT_DATE - 5, 0.00, 0, 0, 0, 0, 0, FALSE, FALSE, FALSE, NULL, NULL, NULL, NOW(),
   'Demo: Felix Goodneighbor, Member-at-Large.')
ON CONFLICT (id) DO UPDATE
  SET balance_total = EXCLUDED.balance_total,
      bucket_0_30 = EXCLUDED.bucket_0_30,
      bucket_31_60 = EXCLUDED.bucket_31_60,
      bucket_61_90 = EXCLUDED.bucket_61_90,
      bucket_91_120 = EXCLUDED.bucket_91_120,
      bucket_over_120 = EXCLUDED.bucket_over_120,
      at_legal = EXCLUDED.at_legal,
      in_collections = EXCLUDED.in_collections,
      payment_plan_active = EXCLUDED.payment_plan_active,
      payment_plan_terms_text = EXCLUDED.payment_plan_terms_text,
      enforcement_stage = EXCLUDED.enforcement_stage,
      enforcement_notes = EXCLUDED.enforcement_notes,
      snapshot_date = EXCLUDED.snapshot_date,
      notes = EXCLUDED.notes,
      updated_at = NOW();

-- ----------------------------------------------------------------------------
-- 2) SAMPLE HOMEOWNER_CALLS
--
-- Recent calls for select personas so Claire's pre-call warmup picks them
-- up. When the demo persona calls in, Claire's opener can reference the
-- prior interaction.
--
-- Spread across last 14 days. Brief field carries the concern text per the
-- v1 brief shape (concern + answer_or_status + next_step).
-- ----------------------------------------------------------------------------
INSERT INTO homeowner_calls (
  id, community_id, call_sid, caller_phone, caller_homeowner_id,
  status, started_at, ended_at, duration_seconds, turn_count,
  brief, brief_extracted_at,
  handoff_offered, handoff_accepted, handoff_reason,
  compliance_flag, raw_provider_metadata
) VALUES
  -- Jennifer Lateleaves — called 4 days ago about her courtesy notice
  ('dc160001-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', 'DEMO-CA-jen-001', '(832) 555-0107', 'dc100007-0000-4000-a000-000000000000',
   'completed', NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days' + INTERVAL '6 minutes', 360, 12,
   jsonb_build_object(
     'concern', 'Front-yard landscaping courtesy notice — contractor scheduled, asking for cure-period extension',
     'answer_or_status', 'Confirmed contractor visit Tuesday; courtesy cycle covers the work window.',
     'next_step', 'Will follow up after contractor confirms completion.',
     'owner', 'jennifer@dramacreekhoa.demo',
     'specific_detail', 'Contractor: GreenLine Landscape, scheduled Tuesday 9am',
     'channel', 'voice',
     'category', 'landscape',
     'escalate', false,
     'compliance_flag', true
   ), NOW() - INTERVAL '4 days' + INTERVAL '15 minutes',
   FALSE, FALSE, NULL,
   TRUE, NULL),
  -- Marcus Behindbills — called 9 days ago confirming payment plan
  ('dc160002-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', 'DEMO-CA-marcus-001', '(832) 555-0108', 'dc100008-0000-4000-a000-000000000000',
   'completed', NOW() - INTERVAL '9 days', NOW() - INTERVAL '9 days' + INTERVAL '8 minutes', 480, 16,
   jsonb_build_object(
     'concern', 'Confirming September payment plan installment posted',
     'answer_or_status', 'Confirmed payment received; account current per plan terms.',
     'next_step', 'Next installment due October 1.',
     'owner', 'marcus@dramacreekhoa.demo',
     'specific_detail', '$200/month plan through October 2026',
     'channel', 'voice',
     'category', 'accounting',
     'escalate', false,
     'compliance_flag', false
   ), NOW() - INTERVAL '9 days' + INTERVAL '20 minutes',
   FALSE, FALSE, NULL,
   FALSE, NULL),
  -- Sarah Welcome — called 2 days ago after closing
  ('dc160003-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', 'DEMO-CA-sarah-001', '(832) 555-0111', 'dc10000b-0000-4000-a000-000000000000',
   'completed', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days' + INTERVAL '11 minutes', 660, 22,
   jsonb_build_object(
     'concern', 'New owner orientation — pool access, assessment schedule, ARC process',
     'answer_or_status', 'Walked through pool fob, assessment cadence, ARC submission flow.',
     'next_step', 'Welcome package emailed; pool fob request submitted.',
     'owner', 'sarah@dramacreekhoa.demo',
     'specific_detail', 'Closed 2026-05-15; first assessment due',
     'channel', 'voice',
     'category', 'orientation',
     'escalate', false,
     'compliance_flag', false
   ), NOW() - INTERVAL '2 days' + INTERVAL '18 minutes',
   FALSE, FALSE, NULL,
   FALSE, NULL),
  -- Patricia Newpaint — called yesterday checking ACC status
  ('dc160004-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', 'DEMO-CA-patricia-001', '(832) 555-0109', 'dc100009-0000-4000-a000-000000000000',
   'completed', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day' + INTERVAL '4 minutes', 240, 8,
   jsonb_build_object(
     'concern', 'ARC submission status — exterior repaint, awaiting committee review',
     'answer_or_status', 'Confirmed submission received; ARC reviewing next cycle.',
     'next_step', 'Decision letter expected within 10 business days.',
     'owner', 'patricia@dramacreekhoa.demo',
     'specific_detail', 'Repaint application submitted 2026-06-01; sage green w/ white trim',
     'channel', 'voice',
     'category', 'acc',
     'escalate', false,
     'compliance_flag', false
   ), NOW() - INTERVAL '1 day' + INTERVAL '12 minutes',
   FALSE, FALSE, NULL,
   FALSE, NULL)
ON CONFLICT (call_sid) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
--
--   SELECT count(*) FROM owner_ar_snapshots
--     WHERE community_id = 'dc100000-0000-4000-a000-000000000000'
--     AND notes LIKE 'Demo:%';
--   -- Expected: 13 (8 demo personas + 5 board members)
--
--   SELECT count(*) FROM homeowner_calls
--     WHERE community_id = 'dc100000-0000-4000-a000-000000000000'
--     AND call_sid LIKE 'DEMO-CA-%';
--   -- Expected: 4 (Jennifer, Marcus, Sarah, Patricia)
-- ============================================================================
