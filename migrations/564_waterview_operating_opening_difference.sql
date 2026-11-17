-- ============================================================================
-- 564_waterview_operating_opening_difference.sql  (Ed 2026-11-17)
-- ----------------------------------------------------------------------------
-- Waterview Operating Checking (5961): the opening reconciled position (migration 563) is restated on
-- trustEd's 7/31 opening GL cash, $85,270.36, which equals Vantaca's own GL Trial Balance for 1000 at 7/31.
-- Vantaca's 7/31 bank reconciliation printed a book balance of $85,295.36, $25.00 higher. That $25.00 is
-- UNRESOLVED: it is recorded as an opening reconciling item labeled as an unexplained difference, so it
-- appears on every reconciliation as an open item until it is explained. No journal entry, no cash
-- adjustment, and the difference is not treated as resolved.
--   bank $80,210.75 + deposits in transit $5,457.82 - outstanding $373.21 - unresolved opening difference
--   $25.00 = trustEd book $85,270.36.
-- Changes only bank_accounts.opening_position for this one account (an UPDATE; net rows 0).
-- Record ownership: association_record.
-- ============================================================================
BEGIN;

UPDATE bank_accounts
   SET opening_position = jsonb_set(jsonb_set(jsonb_set(opening_position,
         '{book_balance_cents}', '8527036'::jsonb),
         '{outstanding_checks}', (opening_position->'outstanding_checks') || '[{"check_number": "OPENING-DIFF-25", "amount_cents": 2500, "issue_date": "2026-07-31", "payee": "UNRESOLVED opening difference: Vantaca 7/31 bank reconciliation book $85,295.36 vs Vantaca GL 1000 / trustEd opening $85,270.36; not a check, not adjusted, open until explained"}]'::jsonb),
         '{opening_exceptions}', '[{"code": "vantaca_rec_book_vs_gl", "amount_cents": 2500, "status": "unresolved", "text": "Vantaca 7/31 bank reconciliation book balance $85,295.36 exceeds Vantaca GL Trial Balance 1000 ($85,270.36, carried by trustEd) by $25.00; cause not established"}]'::jsonb)
 WHERE id = '829b287e-3d9f-4a4e-9eab-4ba437a329be'
   AND (opening_position->>'book_balance_cents')::bigint = 8529536
   AND NOT (opening_position ? 'opening_exceptions');

COMMIT;
