-- ============================================================================
-- 382 — a community can be leaving without being gone.
-- ----------------------------------------------------------------------------
-- Record ownership: the columns are workpaper (Bedrock's own view of the
-- engagement). The RECORDS they govern are association_record and must still be
-- exported at handover — see the note at the bottom.
--
-- Ed 2026-08-21: "we aren't going to onboard eaglewood, we are losing them as a
-- client. we need to keep the DRV and ARC in our system but lets not do any
-- financials or payments. our last day will be 9/30."
--
-- communities.active is a single boolean, and it is the only lifecycle state
-- there is. Turning it off would take DRV and ARC down with everything else,
-- which is exactly what Ed does NOT want: enforcement and architectural review
-- keep running to the last day, because a violation case that goes quiet for six
-- weeks is a §209 problem handed to whoever takes over.
--
-- So a community needs to be able to be winding down in one area and fully
-- operating in another:
--
--   management_status   where the engagement stands
--   management_end_date the last day we manage it — 2026-09-30 for Eaglewood
--   financials_active   GL, AP, checks, payments
--   enforcement_active  DRV / §209
--   arc_active          architectural review
--
-- Per-service flags rather than one switch, because "losing a client" is never
-- a single event. Financials stop when the books are handed over; enforcement
-- runs until the last day; records stay reachable long after both.
--
-- A FLAG NOTHING READS IS WORSE THAN NO FLAG — it says the case is handled.
-- Today alone produced six bugs of exactly that shape (a value computed and
-- never consumed), so these are wired to real refusals in the same change, not
-- left as decoration for a future one.
-- ============================================================================
BEGIN;

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS management_status TEXT NOT NULL DEFAULT 'active'
    CHECK (management_status IN ('prospect', 'onboarding', 'active', 'terminating', 'terminated')),
  ADD COLUMN IF NOT EXISTS management_start_date DATE,
  ADD COLUMN IF NOT EXISTS management_end_date   DATE,
  ADD COLUMN IF NOT EXISTS termination_notes     TEXT,
  -- Default TRUE so every existing community is unaffected. Only a community
  -- explicitly wound down differs from today's behaviour.
  ADD COLUMN IF NOT EXISTS financials_active  BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS enforcement_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS arc_active         BOOLEAN NOT NULL DEFAULT TRUE,
  -- Handover tracking. The management agreement gives a window (typically
  -- 15-30 days) to hand over the association's records, and the industry's
  -- normal failure is that it quietly does not happen. Being the operator who
  -- exports cleanly is a board-pitch differentiator when we are on the other
  -- side of a takeover complaining about a sloppy predecessor.
  ADD COLUMN IF NOT EXISTS records_handover_due_date DATE,
  ADD COLUMN IF NOT EXISTS records_handover_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS records_handover_by       TEXT;

CREATE INDEX IF NOT EXISTS communities_management_status_idx
  ON communities (management_status) WHERE management_status <> 'active';

COMMENT ON COLUMN communities.management_status IS
  'Where the engagement stands. terminating = still ours, with an end date. terminated = past it.';
COMMENT ON COLUMN communities.financials_active IS
  'FALSE stops NEW GL, AP, check and payment activity. Reading and exporting stay open — the books still have to be handed over.';
COMMENT ON COLUMN communities.enforcement_active IS
  'DRV / §209. Runs to the last day: a case that goes quiet mid-ladder is a statutory problem for whoever takes over.';
COMMENT ON COLUMN communities.records_handover_due_date IS
  'When the association records must be exported and handed over. Association records remain the HOA''s property regardless of how the engagement ended.';

-- Which system holds the association's books.
--
-- Ed 2026-08-21: "yeah we are going to keep in vantaca and stop all migration."
--
-- Eaglewood was mid-cutover — 179 journal entries covering 2026-01-01 to
-- 2026-08-19 are in trustEd right now, from a migration that is being abandoned.
-- They are a PARTIAL PARALLEL LEDGER, not the association's books, and nothing
-- in the schema said so. A balance sheet rendered for Eaglewood out of trustEd
-- would look completely normal and be wrong, because the other half of the year
-- lives in Vantaca. That is the silent-wrong-answer failure this platform keeps
-- being bitten by.
ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS books_of_record TEXT NOT NULL DEFAULT 'trusted'
    CHECK (books_of_record IN ('trusted', 'vantaca', 'other'));

COMMENT ON COLUMN communities.books_of_record IS
  'Where the association''s general ledger actually lives. Anything other than trusted means financial statements must NOT be rendered from our data — it is partial by definition.';

-- ---------------------------------------------------------------------------
-- Eaglewood. Last day 2026-09-30.
--
--   financials   off. Vantaca keeps the books; the GL migration is cancelled.
--   DRV + ARC    keep running to the last day, and export afterwards.
--
-- Ed 2026-08-21: "we need to keep the DRV and ARC in our system but lets not do
-- any financials or payments, our last day will be 9/30" and "only DRV and ARC
-- will need to be exported later."
--
-- So the handover here is NARROW. The books are Vantaca's problem, not a
-- Bedrock export. What trustEd uniquely holds for Eaglewood is the enforcement
-- history (2,315 violations) and the architectural file — and those ARE
-- association records: an owner mid-§209 ladder on 9/30 does not restart because
-- the manager changed.
--
-- The handover date is 30 days past the last day, the outer edge of a typical
-- management agreement. Set explicitly rather than computed, so moving the end
-- date never silently moves a legal obligation.
-- ---------------------------------------------------------------------------
UPDATE communities SET
  management_status = 'terminating',
  management_end_date = DATE '2026-09-30',
  financials_active = FALSE,
  books_of_record = 'vantaca',
  enforcement_active = TRUE,
  arc_active = TRUE,
  records_handover_due_date = DATE '2026-10-30',
  termination_notes = 'Client leaving; last day of management 2026-09-30. '
    || 'Books stay in Vantaca and the GL migration is CANCELLED — the 179 journal entries in trustEd (2026-01-01 to 2026-08-19) are a partial parallel ledger from the abandoned cutover and are NOT the association''s books. Do not render financial statements for this community from trustEd. '
    || 'No Stripe onboarding. DRV and ARC continue to the last day; those two, and only those two, need exporting afterwards. (Ed 2026-08-21.)'
WHERE lower(name) LIKE '%eaglewood%';

COMMIT;
