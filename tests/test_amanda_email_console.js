// ============================================================================
// tests/test_amanda_email_console.js  (Ed 2026-10-06)
// ----------------------------------------------------------------------------
// Amanda's email desk: every email that really left her mailbox is findable,
// and a blocked or failed one stays visible with its reason.
//
// The scar: on 10/05 a one-off script sent "Photo check" by calling
// graph_send.sendAs directly, which records nothing, so it never appeared on any
// screen. On 10/06 an email to Martha and Alisha was blocked before it reached
// the platform and left no trace. The activity list now reconciles trustEd's own
// records with Amanda's Microsoft 365 Sent Items, and failures keep their reason.
//
//   node tests/test_amanda_email_console.js
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const desk = require('../lib/amanda/email_console');

let passed = 0; const pending = [];
function check(name, fn) {
  pending.push(Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓ ' + name); },
    (e) => { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }));
}

const T = (min) => new Date(Date.UTC(2026, 9, 6, 15, 0) + min * 60e3).toISOString();

console.log('\nAddresses');
check('parses commas, semicolons and "Name <addr>", dedupes and lowercases, drops junk', () => {
  assert.deepStrictEqual(desk.parseAddresses('Martha <MBravo@bedrocktx.com>; alisha@bedrocktx.com, not-an-email, mbravo@bedrocktx.com'),
    ['mbravo@bedrocktx.com', 'alisha@bedrocktx.com']);
  assert.deepStrictEqual(desk.parseAddresses(['a@x.com', '', null]), ['a@x.com']);
  assert.deepStrictEqual(desk.parseAddresses(''), []);
});

console.log('\nStatus of a prepared email');
check('a fresh draft is prepared; sent is sent; discarded is discarded', () => {
  assert.strictEqual(desk.classifyDraft({ status: 'draft' }).status, 'prepared');
  assert.strictEqual(desk.classifyDraft({ status: 'sent' }).status, 'sent');
  assert.strictEqual(desk.classifyDraft({ status: 'discarded' }).status, 'discarded');
});
check('a failed send stays a draft but shows FAILED with the error', () => {
  const c = desk.classifyDraft({ status: 'draft', send_error: 'Graph sendMail 500: server busy' });
  assert.deepStrictEqual(c, { status: 'failed', reason: 'Graph sendMail 500: server busy' });
});
check('a guard / permission stop shows BLOCKED with the reason', () => {
  assert.strictEqual(desk.classifyDraft({ status: 'draft', send_error: 'blocked: outbound guard suppressed this send (demo)' }).status, 'blocked');
  assert.strictEqual(desk.classifyDraft({ status: 'draft', send_error: 'Graph sendMail 403 ErrorAccessDenied' }).status, 'blocked');
});
check('an automatic reply that failed is visible as failed with last_error', () => {
  const c = desk.classifyDraft({ status: 'failed', draft_kind: 'amanda_auto_reply', last_error: 'Graph list attachments failed (400)' });
  assert.deepStrictEqual(c, { status: 'failed', reason: 'Graph list attachments failed (400)' });
});

console.log('\nRecent activity reconciles three sources');
const graphMsg = (subject, to, at, id) => ({ subject, sentDateTime: at, internetMessageId: id, toRecipients: [{ emailAddress: { address: to } }] });
check('the "Photo check" case: in Sent Items, no trustEd record, shows as an UNRECORDED exception (not a normal sent record)', () => {
  const a = desk.mergeActivity({ graph: [graphMsg('Photo check', 'egojara@bedrocktx.com', T(0), '<pc@x>')] });
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].status, 'unrecorded');
  assert.match(a[0].reason, /Needs investigation/);
  assert.strictEqual(a[0].unrecorded, true);
  assert.match(a[0].reason, /no trustEd record/);
});
check('a send trustEd recorded is not duplicated by its Sent Items copy (subject + recipient + time)', () => {
  const a = desk.mergeActivity({
    logged: [{ id: 'm1', subject: 'Re: Canyon Gate', recipients: ['egojara@bedrocktx.com'], created_at: T(1) }],
    graph: [graphMsg('RE: Canyon Gate', 'egojara@bedrocktx.com', T(0), '<cg@x>')],
  });
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].source, 'trustEd');
});
check('an outbox email that was sent appears once, not again from its timeline row or Sent Items', () => {
  const a = desk.mergeActivity({
    drafts: [{ id: 'd1', status: 'sent', to_email: 'mbravo@bedrocktx.com, alisha@bedrocktx.com', subject: 'Quail Ridge – Lawn Enforcement / Self-Help', created_at: T(-5), sent_at: T(0) }],
    logged: [{ id: 'm2', subject: 'Quail Ridge – Lawn Enforcement / Self-Help', recipients: ['mbravo@bedrocktx.com', 'alisha@bedrocktx.com'], created_at: T(0) }],
    graph: [graphMsg('Quail Ridge – Lawn Enforcement / Self-Help', 'mbravo@bedrocktx.com', T(0), '<qr@x>')],
  });
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].source, 'outbox');
});
check('blocked and failed items stay in the list with their reasons, newest first', () => {
  const a = desk.mergeActivity({ drafts: [
    { id: 'b', status: 'draft', send_error: 'blocked: outbound guard suppressed this send (demo)', subject: 'B', to_email: 'x@y.com', created_at: T(2) },
    { id: 'f', status: 'draft', send_error: 'Graph sendMail 500', subject: 'F', to_email: 'x@y.com', created_at: T(1) },
    { id: 'p', status: 'draft', subject: 'P', to_email: 'x@y.com', created_at: T(0) },
  ] });
  assert.deepStrictEqual(a.map((i) => [i.id, i.status]), [['b', 'blocked'], ['f', 'failed'], ['p', 'prepared']]);
  assert.ok(a[0].reason && a[1].reason);
});

check('detection never writes: the console module inserts only when staging a draft, and reads Sent Items with GET', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'amanda', 'email_console.js'), 'utf8');
  assert.deepStrictEqual(s.match(/\.(insert|update|upsert|delete)\(/g) || [], ['.insert('], 'only stageDraft writes');
  const read = s.slice(s.indexOf('async function readSentItems'), s.indexOf('async function loadEmailDesk'));
  assert.ok(!/method:/.test(read), 'Sent Items is read with a plain GET, never a write');
});

console.log('\nStaging');
function fakeSb() {
  const calls = [];
  return { calls, from(t) { return { insert(row) { calls.push({ t, row }); return { select() { return { single: async () => ({ data: { id: 'new', ...row, created_at: T(0) }, error: null }) }; } }; } }; } };
}
check('stageDraft writes an Amanda draft for review (persona, status draft, To/CC split, no em-dashes)', async () => {
  const sb = fakeSb();
  await desk.stageDraft(sb, { to: 'mbravo@bedrocktx.com; alisha@bedrocktx.com', cc: 'alisha@bedrocktx.com, egojara@bedrocktx.com', subject: 'Quail Ridge — Self-Help', body: 'Hi — there', createdBy: 'egojara@bedrocktx.com' });
  const r = sb.calls[0].row;
  assert.strictEqual(sb.calls[0].t, 'outbound_email_drafts');
  assert.strictEqual(r.persona, 'amanda');
  assert.strictEqual(r.status, 'draft');
  assert.strictEqual(r.to_email, 'mbravo@bedrocktx.com, alisha@bedrocktx.com');
  assert.strictEqual(r.cc, 'egojara@bedrocktx.com', 'a To address is not repeated in CC');
  assert.ok(!/—/.test(r.subject + r.body_text), 'em-dashes stripped');
});
check('stageDraft refuses without a recipient, subject or body (nothing half-staged)', async () => {
  for (const bad of [{ to: '', subject: 's', body: 'b' }, { to: 'a@b.com', subject: '', body: 'b' }, { to: 'a@b.com', subject: 's', body: ' ' }]) {
    await assert.rejects(desk.stageDraft(fakeSb(), bad));
  }
});
check('stageDraft throws when the insert fails, so a prepared email never silently vanishes', async () => {
  const sb = { from() { return { insert() { return { select() { return { single: async () => ({ data: null, error: { message: 'boom' } }) }; } }; } }; } };
  await assert.rejects(desk.stageDraft(sb, { to: 'a@b.com', subject: 's', body: 'b' }), /stage_failed/);
});

console.log('\nWiring');
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
check('the draft send route keeps a guard-suppressed send as a visible draft, never "sent"', () => {
  const s = src('api/email_drafts.js');
  const i = s.indexOf('if (sent && sent.suppressed)'); const j = s.indexOf("status: 'sent', sent_at");
  assert.ok(i > 0 && j > i, 'suppressed check must come before the sent update');
});
check('Amanda routes are admin-gated and never call sendAs', () => {
  const deskPart = src('api/amanda_email.js');
  assert.match(src('server.js'), /app\.use\('\/api\/amanda\/email', require\('\.\/api\/amanda_email'\)\)/);
  for (const r of ["router.get('/'", "router.post('/draft'", "router.post('/ask'"]) {
    const k = deskPart.indexOf(r); assert.ok(k > 0, r);
    assert.match(deskPart.slice(k, k + 200), /requireAdmin/, r + ' must be admin-gated');
  }
  assert.ok(!/sendAs\(|sendReplyAs\(/.test(deskPart), 'the desk prepares; sending stays on the draft route');
});
check('Amanda uses her own builder at send (existing signature path) via the draft route', () => {
  assert.match(src('api/email_drafts.js'), /amanda:\s*\{[^}]*buildAmandaEmail/);
});
check('Tessa keeps her address book by default; Amanda opts out of it', () => {
  assert.match(src('api/tessa.js'), /async function searchContacts\(q, \{ addressBook = true, staff = false \} = \{\}\)/);
  assert.match(src('api/amanda_email.js'), /AMANDA_LOOKUP = \{ addressBook: false, staff: true \}/);
});
check('the shared request runner defaults to Tessa’s drafter, so Tessa is unchanged', () => {
  assert.match(src('lib/ea/tessa_request.js'), /draft = draftEmail, onEdsBehalf = true/);
});
check('the card loads the desk and shows blocked/failed reasons', () => {
  const h = src('public/app/today.html');
  for (const id of ['th-em-p-outbox', 'th-em-p-ask', 'th-em-p-draft', 'th-em-p-activity']) assert.ok(h.includes('id="' + id + '"'), id);
  assert.ok(h.includes("TX.get('/api/amanda/email')"));
  assert.ok(/Blocked: /.test(h) && /Last attempt failed: /.test(h));
});

Promise.all(pending).then(() => console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', with failures' : '')));
