// ============================================================================
// tests/test_shadow.js  (Ed 2026-08-29)
// ----------------------------------------------------------------------------
// Shadow mode records what a persona WOULD do on real inbound, and sends
// nothing. The safety-relevant invariants: it routes a message to the right
// lane, it records the judgment signals faithfully, it is idempotent (a re-run
// never double-records), and it never throws into the caller (a shadow failure
// must not disturb whatever pipeline is replaying mail). Deterministic: the
// drafter is stubbed, no model, no DB.
// ============================================================================
const assert = require('assert');
const { routePersonaForEmail } = require('../lib/team/shadow');

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }

// --- routing: a message lands in the right lane -----------------------------
console.log('\nRouting real messages to a lane:');
ok(routePersonaForEmail({ subject: 'Estoppel / resale certificate for closing', body_full: 'We are closing next week.' }).persona === 'reese', 'resale -> reese');
ok(routePersonaForEmail({ subject: 'Dispute my violation letter', body_full: 'I already fixed the fence, this is unfair.' }).persona === 'miranda', 'violation dispute -> miranda');
ok(['kat'].includes(routePersonaForEmail({ subject: 'Set up a payment plan for my past due', body_full: 'I want autopay.' }).persona), 'payment plan -> kat');
ok(routePersonaForEmail({ subject: 'Just a general question', body_full: 'Where do I find the pool hours?' }).persona === 'claire', 'general -> claire (front office default)');

// --- recording: faithful signals, idempotent, non-throwing -----------------
// A minimal thenable Supabase stub that captures inserts and can simulate a
// prior shadow (idempotency) and an insert error.
function stubDb({ existing = [], insertError = null, captured = [] } = {}) {
  return {
    from() {
      const b = {
        _op: 'select', _payload: null,
        select() { return b; }, eq() { return b; }, limit() { return b; },
        insert(row) { b._op = 'insert'; b._payload = row; return b; },
        single() { b._single = true; return b; },
        then(res, rej) {
          if (b._op === 'insert') {
            if (insertError) return Promise.resolve({ data: null, error: insertError }).then(res, rej);
            captured.push(b._payload);
            return Promise.resolve({ data: { id: 'shadow-1' }, error: null }).then(res, rej);
          }
          // select -> the "already shadowed?" probe
          return Promise.resolve({ data: existing, error: null }).then(res, rej);
        },
      };
      return b;
    },
  };
}

(async () => {
  const { runShadowForEmail } = require('../lib/team/shadow');
  // inject a stub drafter so no model/DB is touched
  const draftFn = async () => ({
    body: 'Hi there, I can help with that.', disposition: 'needs_review', confidence: 'medium',
    disposition_reason: 'sender not verified', audience: 'other', grounded: true,
    reserved: false, reserved_reason: null, escalation_reasons: [],
  });

  const emailRow = { id: 'em-1', internet_message_id: 'ref-1', subject: 'Where are the pool hours?', body_full: 'thanks', sender_email: 'r@x.com', sender_name: 'Rosa', community_id: 'c1' };

  console.log('\nRecording:');
  const captured = [];
  const db1 = stubDb({ existing: [], captured });
  const r1 = await runShadowForEmail(db1, emailRow, { persona: 'claire', reason: 'general', communityName: 'Test HOA', draftFn });
  ok(r1.status === 'recorded', 'records a new shadow draft');
  ok(captured.length === 1, 'exactly one insert');
  ok(captured[0].persona === 'claire' && captured[0].source_email_id === 'em-1', 'row carries persona + source email');
  ok(captured[0].disposition === 'needs_review' && captured[0].grounded === true && captured[0].audience === 'other', 'judgment signals recorded faithfully');
  ok(captured[0].body_text === 'Hi there, I can help with that.', 'the drafted body (never sent) is stored');

  console.log('\nIdempotency + safety:');
  const db2 = stubDb({ existing: [{ id: 'prev' }] });
  const r2 = await runShadowForEmail(db2, emailRow, { persona: 'claire', reason: 'general', draftFn });
  ok(r2.status === 'skipped', 're-run on an already-shadowed (email, persona) is skipped, not double-recorded');

  const db3 = stubDb({ existing: [], insertError: { message: 'permission denied', code: '42501' } });
  const r3 = await runShadowForEmail(db3, emailRow, { persona: 'claire', draftFn });
  ok(r3.status === 'error' && !/throw/i.test(String(r3.error)), 'a DB error is returned, never thrown into the caller');

  console.log(`\n${fail ? 'FAILED' : 'All'} shadow cases ${fail ? '' : 'passed'} (${pass} passed, ${fail} failed).`);
  process.exit(fail ? 1 : 0);
})();
