// ============================================================================
// tests/test_acc_finalize.js  (Issue #14, Ed 2026-10-02)
// ----------------------------------------------------------------------------
// The ACC completion path: staff approve or deny an open case, review Annie's
// letter, send it to the homeowner, and the case records what happened.
//   - approval / denial claim the case (open -> decided) and email once
//   - earlier correspondence (acknowledged_at from an acknowledgment, reply or
//     request-for-information) does NOT block the final decision (the bug)
//   - duplicate / racing sends: exactly one email, the rest refused
//   - send failure: nothing marked done, case restored exactly, retry works
//   - request_more_info keeps the case open and never rewrites a decided one
//   - a letter with a [STAFF: ...] placeholder (missing fact) cannot go out
// In-memory store; no network, no email.
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { finalizeAccDecision } = require('../lib/acc/finalize');
const tests = []; const check = (n, fn) => tests.push([n, fn]);
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function store(row) {
  const T = { acc_decisions: [{ ...row }] }; const writes = [];
  const from = (t) => {
    const f = []; let mode = 'select'; let payload = null; let single = false; let ret = false;
    const api = {
      select() { if (mode !== 'select') ret = true; return api; },
      eq(c, v) { f.push((r) => r[c] === v); return api; }, in(c, vs) { f.push((r) => vs.includes(r[c])); return api; },
      maybeSingle() { single = true; return api; },
      update(p) { mode = 'update'; payload = p; return api; },
      then(res, rej) {
        return Promise.resolve().then(() => {
          const rows = T[t].filter((r) => f.every((p) => p(r)));
          if (mode === 'update') { rows.forEach((r) => Object.assign(r, payload)); writes.push({ payload, n: rows.length }); return { data: ret ? rows.map((r) => ({ id: r.id })) : null, error: null }; }
          return { data: single ? (rows[0] || null) : rows, error: null };
        }).then(res, rej);
      },
    };
    return api;
  };
  return { T, writes, from, row: () => T.acc_decisions[0] };
}
const OPEN = { id: 'acc1', status: 'pending_review', decision_type: null, letter_body: 'old draft', letter_pdf_storage_path: null, decided_by_user_id: null, decided_at: null, acknowledged_at: null, acknowledged_to: null, ai_recommendation: 'request_more_info' };
const run = (db, over = {}) => finalizeAccDecision(db, { dec: { ...db.row() }, decisionType: 'approved_with_conditions', bodyText: 'Dear Pat, approved subject to 1. 4 in slab.', toEmail: 'owner@example.test', send: true, actorId: 'reviewer-1', letterStoragePath: 'acc_decisions/acc1/letter.pdf', sendEmail: async () => {}, ...over });

check('approval: claims the case, emails once, ends decided with decision, letter, reviewer and decided_at', async () => {
  const db = store(OPEN); let sends = 0;
  const r = await run(db, { sendEmail: async () => { sends++; } });
  assert.ok(r.ok && r.final && r.email.sent); assert.strictEqual(sends, 1);
  const x = db.row();
  assert.deepStrictEqual([x.status, x.decision_type, x.decided_by_user_id, x.letter_pdf_storage_path], ['decided', 'approved_with_conditions', 'reviewer-1', 'acc_decisions/acc1/letter.pdf']);
  assert.ok(x.decided_at); assert.ok(/approved subject to/.test(x.letter_body));
});
check('denial: same path, ends decided as denied', async () => {
  const db = store(OPEN);
  const r = await run(db, { decisionType: 'denied', bodyText: 'Dear Pat, we cannot approve the request as submitted.' });
  assert.ok(r.ok && r.final); assert.deepStrictEqual([db.row().status, db.row().decision_type], ['decided', 'denied']);
});
check('THE BUG: earlier correspondence (acknowledged_at set) does NOT stop the final decision from being sent', async () => {
  const db = store({ ...OPEN, acknowledged_at: '2026-09-16T00:00:00Z', acknowledged_to: 'owner@example.test' }); let sends = 0;
  const r = await run(db, { sendEmail: async () => { sends++; } });
  assert.ok(r.ok && r.email.sent, JSON.stringify(r)); assert.strictEqual(sends, 1);
  assert.strictEqual(db.row().status, 'decided');
  assert.strictEqual(db.row().acknowledged_at, '2026-09-16T00:00:00Z', 'prior correspondence history untouched');
});
check('prior request for more information, then the final decision: both send; info request leaves the case open', async () => {
  const db = store(OPEN); let sends = 0; const send = async () => { sends++; };
  const a = await run(db, { decisionType: 'request_more_info', bodyText: 'Dear Pat, please send 1. a survey.', sendEmail: send });
  assert.ok(a.ok && !a.final); assert.strictEqual(db.row().status, 'pending_review'); assert.strictEqual(db.row().decision_type, 'request_more_info');
  db.row().acknowledged_at = '2026-09-20T00:00:00Z'; // the info-request email stamps it in server.js
  const b = await run(db, { sendEmail: send });
  assert.ok(b.ok && b.final && b.email.sent); assert.strictEqual(sends, 2); assert.strictEqual(db.row().status, 'decided');
});
check('duplicate send: a second finalize on a decided case is refused (409) and emails NOTHING', async () => {
  const db = store(OPEN); let sends = 0; const send = async () => { sends++; };
  await run(db, { sendEmail: send });
  const again = await run(db, { sendEmail: send });
  assert.strictEqual(again.ok, false); assert.strictEqual(again.httpStatus, 409); assert.ok(again.already_decided); assert.strictEqual(sends, 1);
  assert.ok(/Nothing was sent again/.test(again.error));
});
check('race: two simultaneous sends on the same open case -> exactly one email, one refused', async () => {
  const db = store(OPEN); let sends = 0; const send = async () => { sends++; await new Promise((r) => setTimeout(r, 5)); };
  const dec = { ...db.row() }; // both requests loaded the case while it was open
  const args = { dec, decisionType: 'approved_no_conditions', bodyText: 'Dear Pat, approved.', toEmail: 'o@example.test', send: true, letterStoragePath: 'p', sendEmail: send };
  const [x, y] = await Promise.all([finalizeAccDecision(db, args), finalizeAccDecision(db, args)]);
  assert.strictEqual([x, y].filter((r) => r.ok).length, 1); assert.strictEqual([x, y].filter((r) => r.httpStatus === 409).length, 1); assert.strictEqual(sends, 1);
});
check('send failure: 502, NOT marked done, case restored exactly as it was; a retry then succeeds', async () => {
  const before = { ...OPEN, decision_type: 'request_more_info', letter_body: 'info draft', acknowledged_at: '2026-09-20T00:00:00Z' };
  const db = store(before);
  const r = await run(db, { sendEmail: async () => { throw new Error('mailbox unavailable'); } });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.httpStatus, 502); assert.ok(r.reverted); assert.ok(/Nothing was marked done/.test(r.error));
  const x = db.row();
  for (const k of ['status', 'decision_type', 'letter_body', 'letter_pdf_storage_path', 'decided_by_user_id', 'decided_at', 'acknowledged_at']) assert.deepStrictEqual(x[k], before[k], k);
  let sends = 0; const ok = await run(db, { sendEmail: async () => { sends++; } });
  assert.ok(ok.ok && ok.email.sent); assert.strictEqual(sends, 1); assert.strictEqual(db.row().status, 'decided');
});
check('mark done without emailing: decided, no email attempted', async () => {
  const db = store(OPEN); let sends = 0;
  const r = await run(db, { send: false, sendEmail: async () => { sends++; } });
  assert.ok(r.ok && r.final && !r.email.attempted); assert.strictEqual(sends, 0); assert.strictEqual(db.row().status, 'decided');
});
check('request_more_info never rewrites a decided case; send needs a recipient; [STAFF: ...] placeholder blocks the send', async () => {
  const db = store({ ...OPEN, status: 'decided', decision_type: 'approved_no_conditions', decided_at: '2026-09-30T00:00:00Z' });
  const r = await run(db, { decisionType: 'request_more_info' });
  assert.strictEqual(r.httpStatus, 409); assert.strictEqual(db.row().decision_type, 'approved_no_conditions');
  const db2 = store(OPEN);
  assert.strictEqual((await run(db2, { toEmail: '' })).httpStatus, 400);
  const p = await run(db2, { decisionType: 'denied', bodyText: 'Dear Pat, this conflicts with [STAFF: cite the governing provision].' });
  assert.strictEqual(p.httpStatus, 400); assert.ok(/placeholder/.test(p.error)); assert.strictEqual(db2.row().status, 'pending_review');
});
check('awaiting_info counts as open (a final decision can be sent)', async () => {
  const db = store({ ...OPEN, status: 'awaiting_info' });
  const r = await run(db); assert.ok(r.ok); assert.strictEqual(db.row().status, 'decided');
});

// ---------------------------------------------------------------- wiring
check('server finalize: uses the claim path; the acknowledged_at "already sent" guard is gone; refuses closed cases BEFORE rendering', () => {
  const s = src('server.js'); const fin = s.slice(s.indexOf("app.post('/acc-review/decisions/:id/finalize'"), s.indexOf("app.post('/acc-review/decisions/:id/redraft'"));
  assert.ok(/require\('\.\/lib\/acc\/finalize'\)\.finalizeAccDecision\(supabase,/.test(fin));
  assert.ok(!/body\.send && dec\.acknowledged_at/.test(fin), 'old acknowledged_at guard removed');
  assert.ok(fin.indexOf('OPEN_STATUSES.includes(dec.status)') < fin.indexOf('renderLetterPdfBuffer('), 'closed-case refusal precedes the PDF render');
  // provenance after a successful send is still recorded (outbound email log, timeline, seal, ack stamp only if empty)
  assert.ok(/if \(emailResult\.sent\) \{/.test(fin) && /from\('email_messages'\)\.insert\(/.test(fin) && /from\('interactions'\)\.insert\(/.test(fin) && /sealFinalizedRecord/.test(fin));
  assert.ok(/\.eq\('id', id\)\.is\('acknowledged_at', null\)/.test(fin), 'prior acknowledgment history is never overwritten');
});
check('screen: send enabled for any OPEN case (prior email shown as a note, not a block); decided shows "Decision recorded"', () => {
  const ui = src('public/index.html'); const d = ui.slice(ui.indexOf('function accRenderDetail'), ui.indexOf('async function accSend'));
  assert.ok(/const isOpen = a\.status === 'pending_review' \|\| a\.status === 'awaiting_info';/.test(d));
  assert.ok(/\$\{isOpen\s*\n?\s*\? `<button class="acc-action-btn approve acc-send-btn"/.test(d));
  assert.ok(!/\$\{a\.acknowledged_at\s*\n\s*\? `<button class="acc-action-btn" disabled/.test(d), 'acknowledged_at no longer disables the send');
  assert.ok(/That does not stop this decision from being sent\./.test(d) && /Decision recorded/.test(d));
  const s = ui.slice(ui.indexOf('async function accSend'), ui.indexOf('async function accRedraft'));
  assert.ok(/\[\\s\*STAFF\\s\*:\/i\.test\(body_text\)/.test(s) && /window\.accDraftFor !== decision/.test(s) && /b\.disabled = true/.test(s) && /j\.already_decided/.test(s));
});
check('Annie drafting: facts only from the case; denial cites a provision only if given, else a [STAFF: ...] placeholder', () => {
  const s = src('server.js'); const r = s.slice(s.indexOf("app.post('/acc-review/decisions/:id/redraft'"), s.indexOf("app.post('/acc-review/render-letter'"));
  assert.ok(/FACTS: use ONLY what is in the case details/.test(r) && /NEVER invent or guess a section number/.test(r));
  assert.ok(!/citing the specific governing-document provision that cannot be met/.test(r));
  assert.ok(/has_placeholders: require\('\.\/lib\/acc\/finalize'\)\.PLACEHOLDER_RE\.test\(screen\.text\)/.test(r));
});

(async () => {
  let pass = 0, fail = 0;
  console.log('ACC completion path (Issue #14)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + e.message); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
