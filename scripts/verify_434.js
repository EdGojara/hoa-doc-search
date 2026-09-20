// scripts/verify_434.js — READ-ONLY post-apply verification for migration 434
// (ACC async clarification persistence). Confirms the three tables exist and every
// designed column is present, via PostgREST schema reflection. Writes NOTHING.
// Run AFTER Ed applies 434. For the deeper checks PostgREST can't see (CHECK
// constraints, FK ON DELETE rules, grants, trigger), run scripts/verify_434.sql in
// the Supabase SQL editor.
//   node -r dotenv/config scripts/verify_434.js
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const EXPECT = {
  acc_evidence_packages: ['id', 'acc_decision_id', 'version', 'content_hash', 'readiness', 'manifest', 'conflicts', 'bundle_text', 'assembled_at', 'record_ownership', 'created_at'],
  acc_clarifications: ['id', 'acc_decision_id', 'community_id', 'raised_from_version', 'conflict_id', 'topic', 'question', 'status', 'round', 'owner_type', 'owner_agent_key', 'owner_user_id', 'outbound_draft_id', 'conversation_id', 'sent_at', 'follow_up_count', 'follow_up_due_at', 'last_nudged_at', 'answer_text', 'answer_email_ref', 'answered_at', 'resolved_to_version', 'escalation_reason', 'escalated_at', 'escalated_work_item_id', 'record_ownership', 'created_at', 'updated_at'],
  acc_clarification_events: ['id', 'clarification_id', 'acc_decision_id', 'from_status', 'to_status', 'event_type', 'actor_type', 'actor_agent_key', 'actor_user_id', 'detail', 'record_ownership', 'created_at'],
};

(async () => {
  let bad = 0;
  console.log('\n434 post-apply verification (read-only column reflection)\n');
  for (const [table, cols] of Object.entries(EXPECT)) {
    // selecting the full column list with limit 0 fails if the table or any column is missing
    const { error } = await s.from(table).select(cols.join(','), { head: true, count: 'exact' }).limit(0);
    if (!error) { console.log(`  ok:   ${table} exists with all ${cols.length} expected columns`); continue; }
    bad++;
    console.log(`  FAIL: ${table} — ${error.message}`);
    // narrow down which column(s) are missing, if the table itself exists
    for (const c of cols) {
      const { error: ce } = await s.from(table).select(c, { head: true }).limit(0);
      if (ce) console.log(`          · column missing/unreadable: ${c} (${ce.message})`);
    }
  }
  console.log(bad
    ? `\n${bad} table(s) not verified. If you have NOT applied 434 yet, that's expected. After applying, re-run; then run scripts/verify_434.sql for constraint/FK/grant/trigger checks.\n`
    : '\nAll three tables + columns present. Now run scripts/verify_434.sql in the Supabase SQL editor for CHECK constraints, FK ON DELETE rules, grants, and the trigger.\n');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('verify failed:', e.message); process.exit(1); });
