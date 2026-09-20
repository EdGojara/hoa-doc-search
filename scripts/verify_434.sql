-- verify_434.sql — run in the Supabase SQL editor AFTER applying 434.
-- READ-ONLY. Verifies the deep schema PostgREST can't reflect: CHECK constraints,
-- FK ON DELETE rules, unique constraints/indexes, grants, and the updated_at trigger.
-- Eyeball each result against the intended design.

-- 1) Tables present
SELECT tablename FROM pg_tables
 WHERE schemaname='public'
   AND tablename IN ('acc_evidence_packages','acc_clarifications','acc_clarification_events')
 ORDER BY tablename;

-- 2) FK ON DELETE rules  (confdeltype: r=RESTRICT, a=NO ACTION, n=SET NULL, c=CASCADE)
--    Expect: acc_decision_id + clarification_id => r (RESTRICT);
--            community_id / outbound_draft_id / escalated_work_item_id /
--            owner_user_id / actor_user_id => n (SET NULL).
SELECT c.conrelid::regclass AS table_name, c.conname,
       pg_get_constraintdef(c.oid) AS definition, c.confdeltype
  FROM pg_constraint c
 WHERE c.contype='f'
   AND c.conrelid::regclass::text IN ('acc_evidence_packages','acc_clarifications','acc_clarification_events')
 ORDER BY table_name, conname;

-- 3) CHECK constraints  (expect owner combo, status, readiness, escalation_reason, actor_type)
SELECT c.conrelid::regclass AS table_name, c.conname, pg_get_constraintdef(c.oid) AS definition
  FROM pg_constraint c
 WHERE c.contype='c'
   AND c.conrelid::regclass::text IN ('acc_evidence_packages','acc_clarifications','acc_clarification_events')
 ORDER BY table_name, conname;

-- 4) Unique constraints + indexes  (expect UNIQUE(acc_decision_id,version);
--    UNIQUE(acc_decision_id,conflict_id,round); partial UNIQUE(answer_email_ref);
--    the waiting/owner/lookup indexes)
SELECT tablename, indexname, indexdef
  FROM pg_indexes
 WHERE schemaname='public'
   AND tablename IN ('acc_evidence_packages','acc_clarifications','acc_clarification_events')
 ORDER BY tablename, indexname;

-- 5) Grants  (expect: evidence_packages + events => SELECT,INSERT to service_role;
--    clarifications => SELECT,INSERT,UPDATE to service_role; SELECT to authenticated;
--    NO UPDATE/DELETE on the append-only tables)
SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
  FROM information_schema.role_table_grants
 WHERE table_name IN ('acc_evidence_packages','acc_clarifications','acc_clarification_events')
   AND grantee IN ('service_role','authenticated')
 GROUP BY table_name, grantee
 ORDER BY table_name, grantee;

-- 6) updated_at trigger on acc_clarifications only (append-only tables have none)
SELECT tgrelid::regclass AS table_name, tgname
  FROM pg_trigger
 WHERE NOT tgisinternal
   AND tgrelid::regclass::text IN ('acc_evidence_packages','acc_clarifications','acc_clarification_events')
 ORDER BY table_name;
