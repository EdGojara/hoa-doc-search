-- ============================================================================
-- test_updated_at_triggers.sql  (migration 451)
-- ----------------------------------------------------------------------------
-- Proves, against a real database, that on each spine table:
--   1. an UPDATE that does not mention updated_at still refreshes it
--   2. an UPDATE that tries to set updated_at to a stale value is overridden
--   3. created_at never changes on UPDATE
--   4. an INSERT sets created_at = updated_at = NOW()
--
-- ZERO SIDE EFFECTS BY CONSTRUCTION: the whole test is ONE DO statement that
-- always ends in RAISE EXCEPTION, so Postgres rolls back every row it touched
-- (and any DDL in the prelude). Success is the message UPDATED_AT_TEST_PASS;
-- anything else is a failure. Run via tests/test_updated_at_triggers.js or
-- paste into the SQL editor.
--
-- Rows under test: one existing row per table (updated in place, rolled back)
-- and one throwaway contact (inserted, rolled back). No real data persists.
-- ============================================================================
DO $test$
DECLARE
  tbl  text;
  rid  uuid;
  c0   timestamptz; u0 timestamptz;
  c1   timestamptz; u1 timestamptz;
  out  text := '';
  tx   timestamptz := now();   -- trusted_set_updated_at() stamps NOW() = transaction start
BEGIN
  -- @@PRELUDE@@

  FOREACH tbl IN ARRAY ARRAY['contacts','property_ownerships','property_residencies','properties'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                    WHERE t.tgrelid = tbl::regclass AND NOT t.tgisinternal AND t.tgenabled <> 'D'
                      AND p.proname = 'trusted_set_updated_at') THEN
      RAISE EXCEPTION 'UPDATED_AT_TEST_FAIL %: no enabled trusted_set_updated_at trigger', tbl;
    END IF;

    EXECUTE format('SELECT id, created_at, updated_at FROM %I WHERE updated_at < $1 ORDER BY id LIMIT 1', tbl)
      INTO rid, c0, u0 USING tx;
    IF rid IS NULL THEN
      out := out || format('%s: skipped (no row older than this transaction); ', tbl);
      CONTINUE;
    END IF;

    -- 1. UPDATE that never mentions updated_at (same-value write to created_at)
    EXECUTE format('UPDATE %I SET created_at = created_at WHERE id = $1', tbl) USING rid;
    EXECUTE format('SELECT created_at, updated_at FROM %I WHERE id = $1', tbl) INTO c1, u1 USING rid;
    IF u1 IS DISTINCT FROM tx OR u1 <= u0 THEN
      RAISE EXCEPTION 'UPDATED_AT_TEST_FAIL %: updated_at not refreshed (before %, after %)', tbl, u0, u1;
    END IF;
    IF c1 IS DISTINCT FROM c0 THEN
      RAISE EXCEPTION 'UPDATED_AT_TEST_FAIL %: created_at changed (% -> %)', tbl, c0, c1;
    END IF;

    -- 2. caller tries to write a stale updated_at: trigger wins
    EXECUTE format('UPDATE %I SET updated_at = %L WHERE id = $1', tbl, '2000-01-01T00:00:00Z') USING rid;
    EXECUTE format('SELECT created_at, updated_at FROM %I WHERE id = $1', tbl) INTO c1, u1 USING rid;
    IF u1 IS DISTINCT FROM tx THEN
      RAISE EXCEPTION 'UPDATED_AT_TEST_FAIL %: stale updated_at was not overridden (%)', tbl, u1;
    END IF;
    IF c1 IS DISTINCT FROM c0 THEN
      RAISE EXCEPTION 'UPDATED_AT_TEST_FAIL %: created_at changed on second update', tbl;
    END IF;

    out := out || format('%s: ok (updated_at %s -> %s, created_at unchanged); ', tbl, u0, u1);
  END LOOP;

  -- 4. INSERT stamps both columns
  INSERT INTO contacts (full_name) VALUES ('__updated_at_test__ (rolled back)')
    RETURNING id, created_at, updated_at INTO rid, c1, u1;
  IF c1 IS DISTINCT FROM tx OR u1 IS DISTINCT FROM tx THEN
    RAISE EXCEPTION 'UPDATED_AT_TEST_FAIL contacts insert: created_at %, updated_at %', c1, u1;
  END IF;
  out := out || 'contacts insert: ok (created_at = updated_at = now()); ';

  RAISE EXCEPTION 'UPDATED_AT_TEST_PASS %', out;
END
$test$;
