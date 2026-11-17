// tests/test_acc_intake_exceptions.js — ACC emails that never reached the queue are visible
// (Ed 2026-11-17). findIntakeExceptions lists ACC mail with no record, with the reason; a filed,
// linked, covered or dismissed email is not listed; replies in one thread collapse to one row.
// Ingest and the manual filer stamp every intake outcome; the queue shows the list.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const X = require('../lib/acc/intake_exceptions');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const T = (d) => `2026-11-${String(d).padStart(2, '0')}T12:00:00Z`;
const em = (o = {}) => ({ id: 'e1', graph_id: 'g1', conversation_id: 'c1', mailbox: 'info@bedrocktx.com', direction: 'inbound', subject: 'ARC application 100 Sample Oak Cir', sender_email: 'h@x.com', received_at: T(2), has_attachments: true, classification: 'acc_request', triage_status: 'needs_review', extracted: {}, property_address: '100 Sample Oak Circle', ...o });
const dec = (o = {}) => ({ id: 'd1', reference_number: 'WAT-ARC-1', status: 'pending_review', homeowner_address: '1 Other St', intake_source_ref: null, source_email_refs: [], conversation_id: null, created_at: T(1), ...o });
const run = (emails, decisions = [], accMailboxes = ['annie@bedrocktx.com']) => X.findIntakeExceptions({ emails, decisions, accMailboxes });

check('an ACC email with no record is listed with a reason', () => {
  const r = run([em()]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].status, 'not_attempted');
  assert.ok(r[0].reason.length > 10);
  const f = run([em({ extracted: { acc_intake: { status: 'no_address', detail: null } } })]);
  assert.strictEqual(f[0].status, 'no_address'); assert.ok(/address/i.test(f[0].reason));
  assert.strictEqual(run([em({ extracted: { acc_intake: { status: 'engine_not_ready' } } })])[0].status, 'engine_not_ready');
});

check('filed, linked, thread-linked, covered or dismissed emails are not listed', () => {
  assert.strictEqual(run([em({ extracted: { acc_intake: { status: 'created' } } })]).length, 0);
  assert.strictEqual(run([em({ extracted: { acc_intake: { status: 'attached' } } })]).length, 0);
  assert.strictEqual(run([em()], [dec({ intake_source_ref: 'email:g1' })]).length, 0);
  assert.strictEqual(run([em()], [dec({ source_email_refs: ['email:g1'] })]).length, 0);
  assert.strictEqual(run([em()], [dec({ conversation_id: 'c1' })]).length, 0);
  assert.strictEqual(run([em()], [dec({ homeowner_address: '100 Sample Oak Cir, Richmond', status: 'pending_review' })]).length, 0, 'open record for the property');
  assert.strictEqual(run([em()], [dec({ homeowner_address: '100 Sample Oak Cir', status: 'decided', created_at: T(3) })]).length, 0, 'record made after the email');
  for (const st of ['handled', 'dismissed', 'spam']) assert.strictEqual(run([em({ triage_status: st })]).length, 0, st);
});

check('a decided record from before does not hide a new request; it is shown as context', () => {
  const r = run([em({ received_at: T(12) })], [dec({ homeowner_address: '100 Sample Oak Cir', status: 'decided', created_at: '2026-07-08T00:00:00Z' })]);
  assert.strictEqual(r.length, 1); assert.deepStrictEqual(r[0].prior_records, ['WAT-ARC-1 decided']);
});

check("non-ACC mail is ignored; anything in Annie's mailbox counts; one row per thread (the attachment wins)", () => {
  assert.strictEqual(run([em({ classification: 'homeowner_request' })]).length, 0);
  assert.strictEqual(run([em({ classification: 'internal', mailbox: 'annie@bedrocktx.com' })]).length, 1);
  assert.strictEqual(run([em({ direction: 'outbound' })]).length, 0);
  const r = run([em(), em({ id: 'e2', graph_id: 'g2', received_at: T(5), has_attachments: false }), em({ id: 'e3', graph_id: 'g3', received_at: T(4) })]);
  assert.strictEqual(r.length, 1); assert.strictEqual(r[0].messages, 3); assert.strictEqual(r[0].email_id, 'e3');
});

check('wiring: ingest and the manual filer stamp every outcome; staff endpoint paginates; the queue shows the list', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const gi = read('lib/email/graph_ingest.js');
  assert.ok(/await recordIntakeOutcome\(supabase, insId, out\);/.test(gi) && /recordIntakeOutcome\(supabase, insId, \{ status: 'error'/.test(gi), 'ingest records the outcome and errors');
  const et = read('api/email_triage.js');
  assert.ok(/recordIntakeOutcome\(supabase, m\.id, out\)/.test(et), 'manual filer records the outcome');
  assert.ok(!/await fetchAll\(\(\) =>/.test(et), 'acc-leaks uses the builder helper correctly');
  const sv = read('server.js');
  const ep = sv.slice(sv.indexOf("app.get('/acc-review/intake-exceptions'"), sv.indexOf("app.get('/acc-review/decisions/:id/email'"));
  assert.ok(ep.length > 100 && /fetchAllQuery\(\(\) => supabase\.from\('email_messages'\)/.test(ep) && /fetchAllQuery\(\(\) => supabase\.from\('acc_decisions'\)/.test(ep), 'paginated reads');
  const ui = read('public/index.html');
  assert.ok(ui.includes("fetch('/acc-review/intake-exceptions')") && ui.includes("key: 'not_filed'") && ui.includes("/to-acc'"), 'queue shows Received, not filed with File to ACC queue');
  assert.ok(ui.includes("await window._authFetch('/api/email-triage/' + encodeURIComponent(emailId) + '/to-acc'") && ui.includes("await window._authFetch('/api/email-triage/' + encodeURIComponent(emailId) + '/dismiss'"), 'the buttons send the sign-in token (the email-triage routes are admin-gated)');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n    ' + e.message); } }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
