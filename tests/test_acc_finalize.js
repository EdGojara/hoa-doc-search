// ============================================================================
// tests/test_acc_finalize.js  (Issue #14, Ed 2026-10-02)
// ----------------------------------------------------------------------------
// The ordered, exactly-once ACC finalization (lib/acc/finalize.js):
//   claim ('finalizing') -> file + seal -> send -> append finalization record
//   -> 'decided' + finalization_id.
// Covered: approval / denial; earlier correspondence never blocks; request for
// more information then the final decision; duplicate + concurrent sends (one
// email, one record); filing failure, email failure, record failure and
// completion failure each leave a recoverable, TRUTHFUL state; exact email +
// hashes archived; mark done without emailing; pre-480 fallback.
// In-memory store that enforces the 480 status CHECK when asked.
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { finalizeAccDecision } = require('../lib/acc/finalize');
const tests = []; const check = (n, fn) => tests.push([n, fn]);
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function store(row, { pre480 = false, failComplete = false } = {}) {
  const T = { acc_decisions: [{ ...row }], acc_finalizations: [] }; const history = [];
  const from = (t) => {
    const f = []; let mode = 'select'; let payload = null; let single = false; let ret = false;
    const api = {
      select() { if (mode !== 'select') ret = true; return api; },
      eq(c, v) { f.push((r) => r[c] === v); return api; }, in(c, vs) { f.push((r) => vs.includes(r[c])); return api; },
      maybeSingle() { single = true; return api; },
      update(p) { mode = 'update'; payload = p; return api; },
      then(res, rej) {
        return Promise.resolve().then(() => {
          if (mode === 'update') {
            if (pre480 && (payload.status === 'finalizing' || 'finalizing_started_at' in payload)) return { data: null, error: { message: 'new row violates check constraint "acc_decisions_status_check"' } };
            if (failComplete && payload.status === 'decided' && 'finalization_id' in payload) return { data: null, error: { message: 'connection reset' } };
            const rows = T[t].filter((r) => f.every((p) => p(r)));
            rows.forEach((r) => { Object.assign(r, payload); history.push(payload.status || null); });
            return { data: ret ? rows.map((r) => ({ id: r.id })) : null, error: null };
          }
          const rows = T[t].filter((r) => f.every((p) => p(r)));
          return { data: single ? (rows[0] || null) : rows, error: null };
        }).then(res, rej);
      },
    };
    return api;
  };
  return { T, history, from, row: () => T.acc_decisions[0] };
}
const OPEN = { id: 'acc1', status: 'pending_review', decision_type: null, letter_body: 'old draft', letter_pdf_storage_path: null, decided_by_user_id: null, decided_at: null, acknowledged_at: null, community_id: 'c1', reference_number: 'WAT-ARC-1', homeowner_name: 'Pat Doe', homeowner_address: '1 Main St, Town, TX' };
const FILED = { letter: { sha256: 'L'.repeat(64), archive_path: 'arc/a-letter.pdf' }, packet: { sha256: 'P'.repeat(64), archive_path: 'arc/a-packet.pdf', path: 'acc_decisions/acc1/packet.pdf' }, documents: [{ what: 'application: application.pdf', sha256: 'A'.repeat(64) }] };
function deps(db, over = {}) {
  const calls = { seal: 0, send: 0, record: 0 };
  return {
    calls,
    args: {
      decisionType: 'approved_with_conditions', bodyText: 'Dear Pat, approved subject to 1. 4 in slab.', toEmail: 'owner@example.test', send: true, actorId: 'reviewer-1',
      letterStoragePath: 'acc_decisions/acc1/letter.pdf',
      sealRecord: async () => { calls.seal++; return FILED; },
      composeEmail: async () => ({ from: 'annie@bedrocktx.com', to: 'owner@example.test', subject: 'ACC Application Decision – 1 Main St', text: 'Dear Pat,\n\n... approved with conditions.', html: '<div>...</div>', attachments: [{ name: 'x' }], archive_attachments: [{ name: 'WAT-ARC-1.pdf', sha256: 'L'.repeat(64), bytes: 1234 }] }),
      sendEmail: async () => { calls.send++; await new Promise((r) => setTimeout(r, 2)); },
      recordFinalization: async (row) => { calls.record++; const rec = { id: 'fin-' + (db.T.acc_finalizations.length + 1), ...row }; db.T.acc_finalizations.push(rec); return { id: rec.id }; },
      ...over,
    },
  };
}
const run = (db, d) => finalizeAccDecision(db, { dec: { ...db.row() }, ...d.args });

check('approval: claim -> finalizing -> decided; one email, one sealed filing, one finalization record linked', async () => {
  const db = store(OPEN); const d = deps(db);
  const r = await run(db, d);
  assert.ok(r.ok && r.final && r.email.sent, JSON.stringify(r));
  assert.deepStrictEqual(db.history, ['finalizing', 'decided']);
  assert.deepStrictEqual([d.calls.seal, d.calls.send, d.calls.record], [1, 1, 1]);
  const x = db.row();
  assert.deepStrictEqual([x.status, x.decision_type, x.decided_by_user_id, x.finalization_id, x.packet_pdf_storage_path], ['decided', 'approved_with_conditions', 'reviewer-1', 'fin-1', 'acc_decisions/acc1/packet.pdf']);
  assert.ok(x.decided_at);
});
check('exact sent-email + attachment/hash archival: the record holds what the homeowner actually received', async () => {
  const db = store(OPEN); const d = deps(db); await run(db, d);
  const rec = db.T.acc_finalizations[0];
  assert.strictEqual(rec.delivery, 'email');
  assert.deepStrictEqual([rec.email.from, rec.email.to, rec.email.subject], ['annie@bedrocktx.com', 'owner@example.test', 'ACC Application Decision – 1 Main St']);
  assert.ok(rec.email.text && rec.email.html && rec.email.sent_at);
  assert.deepStrictEqual(rec.email.attachments, [{ name: 'WAT-ARC-1.pdf', sha256: 'L'.repeat(64), bytes: 1234 }]);
  assert.strictEqual(rec.email.attachments[0].sha256, rec.letter_sha256, 'the attached PDF is the sealed letter');
  assert.deepStrictEqual([rec.letter_sha256, rec.letter_archive_path, rec.packet_sha256, rec.packet_archive_path], [FILED.letter.sha256, FILED.letter.archive_path, FILED.packet.sha256, FILED.packet.archive_path]);
  assert.deepStrictEqual(rec.documents, FILED.documents);
  assert.deepStrictEqual([rec.letter_text, rec.decision_type, rec.decided_by_user_id, rec.reference_number, rec.homeowner_address], ['Dear Pat, approved subject to 1. 4 in slab.', 'approved_with_conditions', 'reviewer-1', 'WAT-ARC-1', '1 Main St, Town, TX']);
});
check('denial: same path, ends decided as denied', async () => {
  const db = store(OPEN); const r = await run(db, deps(db, { decisionType: 'denied', bodyText: 'Dear Pat, we cannot approve the request as submitted.' }));
  assert.ok(r.ok); assert.deepStrictEqual([db.row().status, db.row().decision_type], ['decided', 'denied']);
});
check('earlier correspondence (acknowledged_at set) never blocks the final decision; its history is untouched', async () => {
  const db = store({ ...OPEN, acknowledged_at: '2026-09-16T00:00:00Z' }); const d = deps(db);
  const r = await run(db, d); assert.ok(r.ok && r.email.sent); assert.strictEqual(db.row().acknowledged_at, '2026-09-16T00:00:00Z');
});
check('request for more information, then the final decision: both send; the request leaves the case open and is not claimed', async () => {
  const db = store(OPEN); const d = deps(db);
  const a = await run(db, deps(db, { decisionType: 'request_more_info', bodyText: 'Dear Pat, please send 1. a survey.', sendEmail: d.args.sendEmail }));
  assert.ok(a.ok && !a.final); assert.strictEqual(db.row().status, 'pending_review'); assert.deepStrictEqual(db.history, [null]);
  const b = await run(db, d); assert.ok(b.ok && b.final); assert.strictEqual(db.row().status, 'decided');
});
check('duplicate send: a second finalize is refused before anything is filed or sent', async () => {
  const db = store(OPEN); const d = deps(db); await run(db, d);
  const again = await run(db, d);
  assert.strictEqual(again.httpStatus, 409); assert.deepStrictEqual([d.calls.seal, d.calls.send, d.calls.record], [1, 1, 1]);
});
check('concurrent sends (double-click / second tab): exactly one filing, one email, one record', async () => {
  const db = store(OPEN); const d = deps(db); const dec = { ...db.row() };
  const [x, y] = await Promise.all([finalizeAccDecision(db, { dec, ...d.args }), finalizeAccDecision(db, { dec, ...d.args })]);
  assert.strictEqual([x, y].filter((r) => r.ok).length, 1); assert.strictEqual([x, y].filter((r) => r.httpStatus === 409).length, 1);
  assert.deepStrictEqual([d.calls.seal, d.calls.send, d.calls.record, db.T.acc_finalizations.length], [1, 1, 1, 1]);
});
check('filing failure: NOTHING is sent, the case is back in the queue exactly as it was, retry works', async () => {
  const before = { ...OPEN, decision_type: 'request_more_info', letter_body: 'info draft' };
  const db = store(before); let sends = 0;
  const r = await run(db, deps(db, { sealRecord: async () => { throw new Error('archive unavailable'); }, sendEmail: async () => { sends++; } }));
  assert.strictEqual(r.httpStatus, 500); assert.strictEqual(sends, 0); assert.ok(r.reverted); assert.ok(/Nothing was sent/.test(r.error));
  for (const k of ['status', 'decision_type', 'letter_body', 'decided_by_user_id']) assert.deepStrictEqual(db.row()[k], before[k], k);
  assert.ok((await run(db, deps(db))).ok, 'retry succeeds');
});
check('email failure: filed but NOT marked done; case back in the queue; no finalization record; retry works', async () => {
  const db = store(OPEN); const d = deps(db, { sendEmail: async () => { throw new Error('mailbox unavailable'); } });
  const r = await run(db, d);
  assert.strictEqual(r.httpStatus, 502); assert.ok(r.reverted); assert.ok(/Nothing was marked done/.test(r.error));
  assert.strictEqual(db.row().status, 'pending_review'); assert.strictEqual(db.T.acc_finalizations.length, 0); assert.strictEqual(db.row().decided_at, null);
  assert.ok((await run(db, deps(db))).ok);
});
check('record failure AFTER the email: the case is still marked decided (the homeowner was told) and the gap is flagged', async () => {
  const db = store(OPEN);
  const r = await run(db, deps(db, { recordFinalization: async () => { throw new Error('insert failed'); } }));
  assert.ok(r.ok); assert.strictEqual(db.row().status, 'decided'); assert.ok(/insert failed/.test(r.record_error));
});
check('completion failure AFTER the email: truthful 500 ("WAS emailed ... do not resend"), case stays finalizing, never reverted', async () => {
  const db = store(OPEN, { failComplete: true });
  const r = await run(db, deps(db));
  assert.strictEqual(r.httpStatus, 500); assert.ok(/WAS emailed/.test(r.error) && /do not resend/.test(r.error));
  assert.strictEqual(db.row().status, 'finalizing');
});
check('mark done without emailing: decided, delivery none, no email', async () => {
  const db = store(OPEN); const d = deps(db);
  const r = await run(db, deps(db, { send: false, sendEmail: d.args.sendEmail }));
  assert.ok(r.ok && !r.email.attempted); assert.strictEqual(d.calls.send, 0);
  assert.strictEqual(db.T.acc_finalizations[0].delivery, 'none'); assert.strictEqual(db.T.acc_finalizations[0].email, null);
});
check('before migration 480: claim goes straight to decided, reverted on failure, no record written', async () => {
  const db = store(OPEN, { pre480: true }); const d = deps(db);
  const r = await run(db, d); assert.ok(r.ok); assert.strictEqual(r.mode, 'legacy'); assert.strictEqual(db.row().status, 'decided'); assert.strictEqual(d.calls.record, 0);
  const db2 = store(OPEN, { pre480: true });
  const f = await run(db2, deps(db2, { sendEmail: async () => { throw new Error('x'); } }));
  assert.strictEqual(f.httpStatus, 502); assert.strictEqual(db2.row().status, 'pending_review');
});
check('request_more_info never touches a decided case; a placeholder or missing recipient blocks the send', async () => {
  const db = store({ ...OPEN, status: 'decided', decision_type: 'approved_no_conditions' });
  assert.strictEqual((await run(db, deps(db, { decisionType: 'request_more_info' }))).httpStatus, 409);
  const db2 = store(OPEN);
  assert.strictEqual((await run(db2, deps(db2, { toEmail: '' }))).httpStatus, 400);
  const p = await run(db2, deps(db2, { decisionType: 'denied', bodyText: 'Dear Pat, this conflicts with [STAFF: cite the governing provision].' }));
  assert.strictEqual(p.httpStatus, 400); assert.strictEqual(db2.row().status, 'pending_review');
});

// ---------------------------------------------------------------- wiring
check('server finalize: closed-case refusal and stale-draft gate come BEFORE rendering; filing is sealed BEFORE the email', () => {
  const s = src('server.js'); const fin = s.slice(s.indexOf("app.post('/acc-review/decisions/:id/finalize'"), s.indexOf("app.post('/acc-review/decisions/:id/redraft'"));
  const render = fin.indexOf('renderLetterPdfBuffer(');
  assert.ok(fin.indexOf('OPEN_STATUSES.includes(dec.status)') < render && fin.indexOf('draftStaleness(dec,') < render);
  assert.ok(/st\.stale && body\.acknowledge_stale !== true/.test(fin));
  assert.ok(/sealRecord, composeEmail, sendEmail, recordFinalization/.test(fin));
  assert.ok(/if \(pk\.omitted\.length\) throw new Error/.test(fin), 'an incomplete record blocks the send');
  assert.ok(/acc_decision\/\$\{dec\.community_id \|\| 'unknown'\}\/\$\{id\}\/\$\{attemptId\}/.test(fin), 'attempt-scoped write-once archive paths');
  assert.ok(/\.eq\('id', id\)\.is\('acknowledged_at', null\)/.test(fin), 'prior acknowledgment history is never overwritten');
});

(async () => {
  let pass = 0, fail = 0;
  console.log('ACC finalization: ordered + exactly once (Issue #14)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + e.message); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
