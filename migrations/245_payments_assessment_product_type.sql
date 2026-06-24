-- ============================================================================
-- 245_payments_assessment_product_type.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-24 — Online assessment payments (Stripe Connect) insert into the
-- `payments` ledger with product_type='assessment_payment'. The original CHECK
-- constraint (migration 081) predates that work and only allowed amenity / ARC
-- / builder / fob product types — so every assessment-payment ledger insert was
-- silently failing the CHECK (and the error was swallowed by an unchecked
-- insert in api/payments.js, now also fixed). Result: a homeowner paid, money
-- routed to the connected account, but NO ledger row was ever recorded.
--
-- This expands the CHECK to include 'assessment_payment'. Defensive DO-block
-- drops whatever the existing product_type CHECK is named before re-adding, so
-- we don't end up with two CHECKs where the old (narrower) one still rejects.
--
-- Record ownership: payments is `mixed` — the payment receipt delivered to the
-- homeowner is association_record; the platform routing/fee detail is workpaper.
-- No ownership column change needed here (constraint-only).
-- ============================================================================

BEGIN;

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.payments'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%product_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.payments DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_product_type_check
  CHECK (product_type IN (
    'amenity_rental',
    'arc_application',
    'builder_application',
    'key_fob',
    'pool_key',
    'gate_remote',
    'assessment_payment',
    'other'
  ));

COMMIT;
