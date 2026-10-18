// ============================================================================
// tests/test_welcome_mailbox.js  (Ed 2026-10-18, PR #224)
// ----------------------------------------------------------------------------
// welcome@bedrocktx.com is the public front door. It must behave exactly like
// info@: ingested from the ONE canonical list, routed by the same front-office
// rules (Claire by default; content sends DRV to Miranda, ACC to Annie, vendor
// bills to Emma), never copied on our own Reply All, and never silently missing
// from a second hand-kept list (the scheduler's used to drift).
//
//   node tests/test_welcome_mailbox.js
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '\n     ', e.message); } };

const gs = require('../lib/email/graph_send');
const { personaForMessage } = require('../lib/email/persona');
const WELCOME = 'welcome@bedrocktx.com', INFO = 'info@bedrocktx.com';

console.log('welcome@ mailbox');
check('welcome@ is in the canonical ingest list, and info@ still is', () => {
  const l = gs.TEAM_INGEST_MAILBOXES.map((m) => String(m).toLowerCase());
  assert.ok(l.includes(WELCOME), 'welcome@ missing'); assert.ok(l.includes(INFO), 'info@ missing');
  assert.strictEqual(new Set(l).size, l.length, 'duplicate entries');
});
check('welcome@ routes exactly like info@ (same front-office and content rules)', () => {
  const samples = [
    { classification: 'homeowner_request', subject: 'Pool hours?' },
    { classification: 'acc_request', subject: 'Fence application' },
    { classification: 'spam', subject: 'SEO services' },
    { classification: 'other', subject: 'hello' },
    { classification: 'internal', subject: 'fyi' },
  ];
  for (const s of samples) {
    const w = personaForMessage({ ...s, mailbox: WELCOME, sender_email: 'someone@example.com', direction: 'inbound' });
    const i = personaForMessage({ ...s, mailbox: INFO, sender_email: 'someone@example.com', direction: 'inbound' });
    assert.strictEqual(w, i, `${s.classification}: welcome@ -> ${w}, info@ -> ${i}`);
  }
  assert.strictEqual(personaForMessage({ classification: 'homeowner_request', mailbox: WELCOME, sender_email: 'a@example.com' }), 'claire');
  assert.strictEqual(personaForMessage({ classification: 'acc_request', mailbox: WELCOME, sender_email: 'a@example.com' }), 'annie');
});
check('the scheduler has no hand-kept mailbox list: it reads the canonical one (and keeps tessa@ out)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/scheduler.js'), 'utf8');
  const i = src.indexOf("name: 'email_ingest_incremental'"); assert.ok(i > 0, 'job not found');
  const job = src.slice(i, src.indexOf('scheduler.register(', i + 10));
  assert.ok(/TEAM_INGEST_MAILBOXES/.test(job), 'scheduler must derive from graph_send.TEAM_INGEST_MAILBOXES');
  assert.ok(!/'info@bedrocktx\.com'/.test(job), 'scheduler still carries a literal mailbox list');
  assert.ok(/TESSA_MAILBOX/.test(job), 'scheduler must keep the owner-only tessa@ mailbox out');
});
check('Reply All never copies one of our own ingest mailboxes (welcome@ included)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api/email_triage.js'), 'utf8');
  const m = src.match(/const SYSTEM_MAILBOXES = new Set\(\[([\s\S]*?)\]\)/); assert.ok(m, 'SYSTEM_MAILBOXES not found');
  assert.ok(/\.\.\.graphSend\.TEAM_INGEST_MAILBOXES/.test(m[1]), 'SYSTEM_MAILBOXES must include every ingest mailbox');
});
check('a message that fails during ingest is reported as failed, not hidden among skips', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/email/graph_ingest.js'), 'utf8');
  assert.ok(/failed: 0, errors: \[\]/.test(src), 'stats must carry failed + errors');
  assert.ok(!/handleMessage\(gm\)\.catch\(\(\) => \(\{ r: 'skipped' \}\)\)/.test(src), 'a throw is still swallowed as skipped');
  assert.ok(/r: 'failed'/.test(src) && /stats\.failed \+= 1/.test(src), 'failures are not counted');
});
check('automatic outbound stays held unless AUTO_OUTBOUND_EMAIL is deliberately on', () => {
  const prev = process.env.AUTO_OUTBOUND_EMAIL;
  delete process.env.AUTO_OUTBOUND_EMAIL; assert.strictEqual(gs.autoSendEnabled(), false);
  process.env.AUTO_OUTBOUND_EMAIL = 'off'; assert.strictEqual(gs.autoSendEnabled(), false);
  if (prev === undefined) delete process.env.AUTO_OUTBOUND_EMAIL; else process.env.AUTO_OUTBOUND_EMAIL = prev;
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
