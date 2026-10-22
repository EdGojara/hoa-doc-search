// tests/test_graph_push_desks.js  (Ed 2026-10-22) — Graph push for the AI employee email desks.
// The five desks (Amanda, Kat, Annie, Maggie, Miranda) and the shared inboxes routing already
// gives them (accounting@ -> Kat, violations@ -> Miranda) are always subscribed; Ed's
// "[TrustEd push test]" email is stored, routed and deduplicated through the REAL ingestMailbox
// with no classifier, no draft and no workflow; ingest never sends automatically. Graph and
// Supabase are stubbed; no network, no production.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) process.env[k] = process.env[k] || 'test-key';
process.env.SUPABASE_URL = 'http://localhost:1'; process.env.SUPABASE_KEY = 'test-key';
process.env.FILE_PROCESSED_MAIL = 'false';
const tests = []; const check = (n, fn) => tests.push([n, fn]);
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// Real graph_send (mailbox constants), with the token call stubbed before graph_ingest loads.
const gs = require('../lib/email/graph_send');
gs.getToken = async () => 'token'; gs.isConfigured = () => true;
const calls = { classify: 0 };
stub('../lib/email/triage', { classifyAndExtract: async () => { calls.classify += 1; return {}; }, resolveEntities: async () => ({ community_id: null, contact_id: null, property_id: null, vendor_id: null, confidence: 'none', candidates: [] }) });
const db = { email_messages: [], other: [] };
stub('@supabase/supabase-js', { createClient: () => ({ from(t) {
  let op = 'select', payload = null; const f = [];
  const q = {
    select() { return q; }, eq(c, v) { f.push((r) => r[c] === v); return q; }, single() { return q; }, order() { return q; }, limit() { return q; }, not() { return q; },
    in(c, v) { f.push((r) => v.includes(r[c])); return q; },
    insert(r) { op = 'insert'; payload = r; return q; }, update(p) { op = 'update'; payload = p; return q; }, delete() { op = 'delete'; return q; },
    then(res, rej) {
      let out;
      if (t !== 'email_messages') { if (op !== 'select') db.other.push(t + '.' + op); out = { data: [], error: null }; }
      else if (op === 'insert') { const row = { id: 'em' + (db.email_messages.length + 1), ...payload }; db.email_messages.push(row); out = { data: { id: row.id }, error: null }; }
      else if (op === 'delete') { db.email_messages = db.email_messages.filter((r) => !f.every((g) => g(r))); out = { data: null, error: null }; }
      else if (op === 'update') { db.email_messages.filter((r) => f.every((g) => g(r))).forEach((r) => Object.assign(r, payload)); out = { data: null, error: null }; }
      else out = { data: db.email_messages.filter((r) => f.every((g) => g(r))), error: null };
      return Promise.resolve(out).then(res, rej);
    },
  };
  return q;
} }) });
const page = [];
global.fetch = async () => ({ ok: true, json: async () => ({ value: page }) });

const GP = require('../lib/email/graph_push');
const { ingestMailbox, isPushTest, PUSH_TEST_PREFIX } = require('../lib/email/graph_ingest');
const ED = gs.ED_MAILBOX;
const testMsg = (to, n, over = {}) => ({ id: 'g' + n, internetMessageId: `<push-test-${n}@bedrocktx.com>`, conversationId: 'c' + n, subject: `${PUSH_TEST_PREFIX} ${to}`,
  bodyPreview: 'Push test. No action needed.', body: { contentType: 'text', content: 'Push test. No action needed.' },
  from: { emailAddress: { address: ED, name: 'Ed Gojara' } }, sender: { emailAddress: { address: ED } }, toRecipients: [{ emailAddress: { address: to } }],
  receivedDateTime: new Date(Date.now() - 4000).toISOString(), sentDateTime: new Date(Date.now() - 5000).toISOString(), hasAttachments: false, parentFolderId: 'INBOX', ...over });

check('REGISTRY: the five desks and the shared inboxes routed to them are always subscribed, exactly once, with no env list needed', () => {
  const want = [gs.KAT_MAILBOX, gs.ANNIE_MAILBOX, gs.MIRANDA_MAILBOX, gs.AMANDA_MAILBOX, 'violations@bedrocktx.com', 'accounting@bedrocktx.com', gs.MAGGIE_MAILBOX].map((x) => x.toLowerCase()).sort();
  assert.deepStrictEqual(GP.deskMailboxes().map((x) => x.toLowerCase()).sort(), want);
  const r = GP.resolveRegistry('amanda@bedrocktx.com, kat@bedrocktx.com', undefined, { includeDesks: true });
  assert.deepStrictEqual(r.mailboxes.map((x) => x.toLowerCase()).sort(), want, 'env entries already covered by the desks subscribe once');
  assert.deepStrictEqual(r.refused, []);
  assert.ok(!GP.deskMailboxes().some((m) => /^(info|welcome|claire|emma|reese|paige)@/.test(m)), 'other teammates and the front door are not added');
  assert.deepStrictEqual(GP.resolveRegistry('').mailboxes, [], 'without includeDesks the env list alone decides (tests, tools)');
});

check('PUSH TEST marker: only Ed\'s own email with the exact subject prefix', () => {
  const base = { direction: 'inbound', sender_email: ED, subject: `${PUSH_TEST_PREFIX} kat` };
  assert.strictEqual(isPushTest(base), true);
  assert.strictEqual(isPushTest({ ...base, sender_email: 'mhess@newfirst.com' }), false, 'anyone else');
  assert.strictEqual(isPushTest({ ...base, subject: 'RE: ' + base.subject }), false, 'a reply or forward is ordinary mail');
  assert.strictEqual(isPushTest({ ...base, subject: 'push test' }), false);
  assert.strictEqual(isPushTest({ ...base, direction: 'outbound' }), false);
});

check('PUSH TEST end to end through the REAL ingestMailbox: stored once per desk with the routed owner, dismissed, timed; no classifier, draft or workflow; a repeat is a duplicate', async () => {
  const boxes = [[gs.KAT_MAILBOX, 'kat'], [gs.ANNIE_MAILBOX, 'annie'], [gs.MIRANDA_MAILBOX, 'miranda'], [gs.AMANDA_MAILBOX, 'amanda'], [gs.MAGGIE_MAILBOX, 'maggie'], ['accounting@bedrocktx.com', 'kat'], ['violations@bedrocktx.com', 'miranda']];
  let n = 0;
  for (const [mbx, persona] of boxes) {
    n += 1; page.length = 0; page.push(testMsg(mbx, n));
    const s = await ingestMailbox(mbx, { sinceISO: new Date(Date.now() - 3600e3).toISOString(), max: 50, fileBacklog: false });
    assert.strictEqual(s.kept, 1, mbx + ' kept');
    const row = db.email_messages.find((r) => r.internet_message_id === `<push-test-${n}@bedrocktx.com>`);
    assert.ok(row, mbx + ' stored');
    assert.strictEqual(row.persona, persona, mbx + ' routed to ' + row.persona);
    assert.strictEqual(row.triage_status, 'dismissed'); assert.strictEqual(row.mailbox, mbx);
    assert.ok(row.extracted.push_test && Number.isFinite(row.extracted.push_test.latency_ms), 'processing time recorded');
    assert.ok(!row.extracted.draft, 'no draft');
    const again = await ingestMailbox(mbx, { sinceISO: new Date(Date.now() - 3600e3).toISOString(), max: 50, fileBacklog: false });
    assert.strictEqual(again.kept, 0); assert.strictEqual(again.skipped, 1, 'the duplicate notification processes nothing');
    assert.strictEqual(db.email_messages.filter((r) => r.internet_message_id === `<push-test-${n}@bedrocktx.com>`).length, 1, 'one row');
  }
  assert.strictEqual(calls.classify, 0, 'no classifier call');
  assert.deepStrictEqual(db.other, [], 'no other table touched (no work item, objective, ACC, violation, AP or draft row)');
});

check('NO AUTOMATIC SEND: ingest never decides on or starts an automatic reply, for any agent', () => {
  const ing = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'graph_ingest.js'), 'utf8');
  assert.ok(!/getAutoReply\(\)\.(decide|execute)\(/.test(ing));
  assert.ok(!/sendReplyAs|sendAs\(/.test(ing.replace(/\/\/[^\n]*/g, '')), 'ingest has no send call');
});

check('NO MAILBOX POLLING: kat_banking_mail is gone; the scheduler ingests no mailbox on a timer', () => {
  const sched = fs.readFileSync(path.join(__dirname, '..', 'lib', 'scheduler.js'), 'utf8');
  assert.ok(!/kat_banking_mail/.test(sched));
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'lib', 'banking', 'kat_banking_mail.js')));
  assert.match(sched, /if \(process\.env\.EMAIL_INGEST_AUTO !== 'true'\) return \{ fired: false, reason: 'manual_only' \}/, 'the general job stays manual');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) {
    try { await fn(); pass += 1; console.log('  ✓ ' + n); }
    catch (e) { fail += 1; console.log('  ✗ ' + n + '\n    ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n    ')); }
  }
  console.log(`\ngraph_push_desks: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
