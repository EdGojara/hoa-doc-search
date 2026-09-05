-- ============================================================================
-- 407_lunch_order_rounds.sql  (Ed 2026-09-05)
-- ----------------------------------------------------------------------------
-- Tessa's lunch-order collection. Ed asks Tessa to collect a team/guest lunch
-- order; she emails the list, captures each reply, and assembles the order for
-- Ed to approve. Modeled on the board-voting collection loop (migration 352 /
-- 356 ref_code / 357 inbox-seen) — a round header + one row per participant +
-- an idempotent inbox dedup log.
--
-- Record ownership: WORKPAPER. This is Bedrock-internal EA activity (ordering
-- lunch for the team), not an association record — it is never handed over on an
-- HOA termination. Single-class, so documented here, no per-row column.
--
-- The actual placement on Lunchdrop is a supervised browser step on Ed's own
-- signed-in session (the server never holds his Lunchdrop credentials); these
-- tables hold the collection + assembly only.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS lunch_order_rounds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_code      text UNIQUE NOT NULL,                       -- e.g. LUN-3F9A (subject token for reply matching)
  title         text,
  restaurant    text,
  lunch_date    date,
  order_url     text,                                       -- Lunchdrop day/restaurant URL used to place it
  deadline      timestamptz,                                -- the 10:30am cutoff
  created_by    text,                                       -- Ed's email
  status        text NOT NULL DEFAULT 'collecting'
                  CHECK (status IN ('collecting','assembled','approved','placed','cancelled')),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lunch_order_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id          uuid NOT NULL REFERENCES lunch_order_rounds(id) ON DELETE CASCADE,
  participant_email text NOT NULL,
  participant_name  text,
  raw_reply         text,                                   -- exactly what they wrote — never dropped
  parsed_item       text,                                   -- best-effort extracted menu item
  parsed_notes      text,                                   -- customizations / "no onions"
  price_cents       integer,
  status            text NOT NULL DEFAULT 'invited'
                      CHECK (status IN ('invited','responded','confirmed','unclear','cancelled')),
  responded_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, participant_email)
);
CREATE INDEX IF NOT EXISTS idx_lunch_items_round ON lunch_order_items (round_id);

-- Idempotent inbound dedup — a reply is processed once even across polls.
-- (Mirrors board_vote_inbox_seen; keeps the Graph app on Mail.Read only.)
CREATE TABLE IF NOT EXISTS lunch_reply_inbox_seen (
  graph_id   text PRIMARY KEY,
  from_email text,
  outcome    text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- updated_at maintenance (standard helper).
DROP TRIGGER IF EXISTS trg_lunch_rounds_updated ON lunch_order_rounds;
CREATE TRIGGER trg_lunch_rounds_updated BEFORE UPDATE ON lunch_order_rounds
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();
DROP TRIGGER IF EXISTS trg_lunch_items_updated ON lunch_order_items;
CREATE TRIGGER trg_lunch_items_updated BEFORE UPDATE ON lunch_order_items
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- New tables are silently unwritable without the service_role grant (named scar).
GRANT SELECT, INSERT, UPDATE, DELETE ON lunch_order_rounds     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON lunch_order_items      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON lunch_reply_inbox_seen TO service_role;
GRANT SELECT ON lunch_order_rounds     TO authenticated;
GRANT SELECT ON lunch_order_items      TO authenticated;
GRANT SELECT ON lunch_reply_inbox_seen TO authenticated;

COMMIT;
