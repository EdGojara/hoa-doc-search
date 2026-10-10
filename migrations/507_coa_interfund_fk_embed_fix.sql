-- ============================================================================
-- 507_coa_interfund_fk_embed_fix.sql  (Ed 2026-10-10, production regression fix)
-- ----------------------------------------------------------------------------
-- Migration 506 added two foreign keys from chart_of_accounts to account_funds
-- (interfund_from_fund_id, interfund_to_fund_id). With three relationships
-- between the two tables, every PostgREST query that embeds account_funds from
-- chart_of_accounts without naming the relationship fails with "Could not embed
-- because more than one relationship was found" (financial statements, board
-- portal budget, living budget, working forecast).
--
-- This drops ONLY those two foreign keys, restoring the single
-- chart_of_accounts -> account_funds relationship (fund_id) that every existing
-- query relies on. The columns, the CHECK (subtype interfund_transfer exactly
-- when both are set, distinct, revenue / expense only) and the guard trigger
-- (both funds must exist in the account's community; the account sits in one of
-- them) remain, so the interfund configuration is still validated on every write.
-- Data: no row changes (Canyon Gate 4010's configuration is kept as is).
-- ============================================================================
BEGIN;

ALTER TABLE chart_of_accounts DROP CONSTRAINT IF EXISTS chart_of_accounts_interfund_from_fk;
ALTER TABLE chart_of_accounts DROP CONSTRAINT IF EXISTS chart_of_accounts_interfund_to_fk;

COMMENT ON COLUMN chart_of_accounts.interfund_from_fund_id IS 'Set only when account_subtype = interfund_transfer: the fund the transfer leaves (e.g. Operating). No FK on purpose (a second chart_of_accounts -> account_funds relationship breaks unhinted API embeds); trg_chart_of_accounts_interfund_guard validates the fund on every write. Read by the working forecast; nothing posts from it.';
COMMENT ON COLUMN chart_of_accounts.interfund_to_fund_id IS 'Set only when account_subtype = interfund_transfer: the fund the transfer enters (e.g. Reserve). No FK on purpose; validated by trg_chart_of_accounts_interfund_guard.';

COMMIT;
