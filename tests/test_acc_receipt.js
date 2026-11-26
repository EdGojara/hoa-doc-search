// ============================================================================
// tests/test_acc_receipt.js  (Ed 2026-11-26, 6331 Clear Canyon)
// ----------------------------------------------------------------------------
// Annie acknowledges a current architectural application herself (no Draft
// Queue wait), the receipt states the homeowner's ORIGINAL submission date
// (read from a property manager's forward), and nothing goes to a historical
// (backlog) case.
// Run: node tests/test_acc_receipt.js
// ============================================================================
const fs = require('fs');
const path = require('path');
const RD = require('../lib/acc/received_date');
const ACK = require('../lib/acc/acknowledge');

let failures = 0;
const check = (name, cond, detail) => { if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`); else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); } };

// The real shape of the Canyon Gate forward (names/addresses replaced).
const OUTLOOK_FWD = `<div>Martha<br>Community Manager</div><hr><div><b>From:</b> Owner One &lt;owner@example.test&gt;<br><b>Sent:</b> Thursday, November 26, 2026 11:19 AM<br><b>To:</b> Property Manager<br><b>Subject:</b> 123 Example Ln - Application for submission to the architectural control committee</div><p>Attached please find our application.</p>`;
const GMAIL_FWD = `FYI\n\n---------- Forwarded message ---------\nFrom: Owner Two <owner2@example.test>\nDate: Tue, Nov 24, 2026 at 4:05 PM\nSubject: Fence application\nTo: <manager@example.test>\n\nHere is our fence application.`;
const ON_WROTE = `Please review.\n\nOn Mon, Nov 23, 2026 at 9:30 AM Owner Three <o3@example.test> wrote:\n> Attached is our patio application.`;

(async () => {
  console.log('\nThe original receipt date (homeowner submission, not the forward)');
  let r = RD.originalReceivedAt({ subject: 'Fw: 123 Example Ln - Application', body: OUTLOOK_FWD, receivedAt: '2026-11-26T18:14:33Z' });
  check('Outlook forward: 11:19 AM Central on 11/26 = 17:19Z', r.at === '2026-11-26T17:19:00.000Z' && r.basis === 'forwarded_original', JSON.stringify(r));
  r = RD.originalReceivedAt({ subject: 'Fwd: Fence application', body: GMAIL_FWD, receivedAt: '2026-11-25T14:00:00Z' });
  check('Gmail forward header (Date:)', r.at === '2026-11-24T22:05:00.000Z' && r.basis === 'forwarded_original', JSON.stringify(r));
  r = RD.originalReceivedAt({ subject: 'FW: patio', body: ON_WROTE, receivedAt: '2026-11-23T20:00:00Z' });
  check('"On <date>, X wrote:" quote', r.at === '2026-11-23T15:30:00.000Z', JSON.stringify(r));
  r = RD.originalReceivedAt({ subject: 'Fence application', body: 'Here is my application.', receivedAt: '2026-11-26T18:14:33Z' });
  check('a homeowner\'s own email: its arrival time', r.at === '2026-11-26T18:14:33.000Z' && r.basis === 'email_received', JSON.stringify(r));
  r = RD.originalReceivedAt({ subject: 'Fw: x', body: OUTLOOK_FWD.replace('November 26, 2026', 'November 28, 2026'), receivedAt: '2026-11-26T18:14:33Z' });
  check('a quoted date AFTER the email arrived is not believed', r.basis === 'email_received', JSON.stringify(r));
  r = RD.originalReceivedAt({ subject: 'Fw: x', body: OUTLOOK_FWD.replace('November 26, 2026', 'November 26, 2025'), receivedAt: '2026-11-26T18:14:33Z' });
  check('an implausibly old quote (over 120 days) is not believed', r.basis === 'email_received', JSON.stringify(r));
  r = RD.originalReceivedAt({ subject: 'Fw: x', body: '<p>no header here</p>', receivedAt: null });
  check('nothing to go on: null, never a guess', r.at === null && r.basis === 'email_received');
  check('summer time (CDT) is handled', RD.parseHeaderDate('Monday, July 13, 2026 9:00 AM') === Date.parse('2026-07-13T14:00:00Z'));
  check('an explicit offset wins over Central', RD.parseHeaderDate('Thu, 26 Nov 2026 11:19:00 -0500') === Date.parse('2026-11-26T16:19:00Z'));
  check('12:05 PM and 12:05 AM', RD.parseHeaderDate('11/26/2026 12:05 PM') === Date.parse('2026-11-26T18:05:00Z') && RD.parseHeaderDate('11/26/2026 12:05 AM') === Date.parse('2026-11-26T06:05:00Z'));
  check('the receipt label is the Central calendar date', RD.receivedDateLabel('2026-11-26T17:19:00Z') === 'November 26, 2026' && RD.receivedDateLabel('2026-11-27T03:00:00Z') === 'November 26, 2026');

  console.log('\nThe receipt text');
  const t = ACK.acknowledgmentText({ applicantName: 'I-Tsun and Sheree', reference: 'CAN-ARC-2026-0005', address: '123 Example Ln', receivedAt: '2026-11-26T17:19:00Z' });
  check('names the reference and the original submission date', /CAN-ARC-2026-0005/.test(t.subject) && /submitted on November 26, 2026/.test(t.body) && /CAN-ARC-2026-0005/.test(t.body));
  check('decides nothing (no approval/denial wording)', require('../lib/acc/decision_authority').checkOutboundText(`${t.subject}\n${t.body}`).ok);
  check('no em-dashes in homeowner text', !/—/.test(t.subject + t.body) && !/—/.test(ACK.acknowledgmentText({ applicantName: 'A', additional: true }).body));

  console.log('\nAnnie sends it herself, for current cases only');
  const sends = []; const writes = [];
  const graph = { ANNIE_MAILBOX: 'annie@bedrocktx.com', isConfigured: () => true, async sendAs(m) { sends.push(m); return { sent: true, internetMessageId: '<m1@x>' }; } };
  const db = (row) => ({ from(table) {
    const q = { _op: null, select() { q._op = q._op || 'select'; return q; }, update(p) { q._op = 'update'; q._p = p; return q; }, insert(p) { writes.push({ table, op: 'insert', p }); return Promise.resolve({ error: null }); },
      eq() { return q; }, in() { return q; }, is() { return q; },
      async maybeSingle() { return { data: row, error: null }; },
      then(res) { if (q._op === 'update') writes.push({ table, op: 'update', p: q._p }); return Promise.resolve({ error: null }).then(res); } };
    return q;
  } });
  const cur = { id: 'd1', status: 'pending_review', created_at: '2026-11-26T18:17:04Z', acknowledged_at: null };
  let a = await ACK.acknowledgeApplication(db(cur), { graph, decisionId: 'd1', to: 'owner@example.test, manager@example.test', applicantName: 'Owner', communityName: 'Canyon Gate at Cinco Ranch', reference: 'CAN-ARC-2026-0005', address: '123 Example Ln', receivedAt: '2026-11-26T17:19:00Z' });
  check('a current application: the receipt is SENT (not parked in the Draft Queue)', a.sent === true && sends.length === 1, JSON.stringify(a));
  check('...from Annie\'s mailbox, branded, to the applicant and the forwarding manager', sends[0].from === 'annie@bedrocktx.com' && /owner@example\.test/.test(sends[0].to) && /manager@example\.test/.test(sends[0].to) && /<html|<div|<p/i.test(sends[0].html || ''));
  check('...through the ACC transport guard (case named)', sends[0].accDecisionId === 'd1');
  check('...stamped acknowledged on the case', writes.some((w) => w.table === 'acc_decisions' && w.op === 'update' && w.p.acknowledged_at && w.p.acknowledgment_error === null));
  check('...logged on Annie\'s board', writes.some((w) => w.table === 'email_messages' && w.op === 'insert' && w.p.persona === 'annie' && w.p.direction === 'outbound'));
  check('...any old receipt draft for the case is cleared', writes.some((w) => w.table === 'outbound_email_drafts' && w.op === 'update' && w.p.status === 'discarded'));
  const n = sends.length;
  a = await ACK.acknowledgeApplication(db({ ...cur, acknowledged_at: '2026-11-26T18:20:00Z' }), { graph, decisionId: 'd1', to: 'owner@example.test' });
  check('never twice', a.skipped === 'already acknowledged' && sends.length === n);
  a = await ACK.acknowledgeApplication(db({ ...cur, created_at: '2026-10-13T21:36:00Z' }), { graph, decisionId: 'd1', to: 'owner@example.test' });
  check('a historical (backlog) application: nothing goes to the homeowner', /backlog hold/.test(a.skipped || '') && sends.length === n, JSON.stringify(a));
  a = await ACK.acknowledgeApplication(db({ ...cur, status: 'decided' }), { graph, decisionId: 'd1', to: 'owner@example.test' });
  check('a decided application: no receipt', /decided/.test(a.skipped || '') && sends.length === n);
  const held = { ...graph, async sendAs() { return { sent: false, suppressed: true, reason: 'demo' }; } };
  a = await ACK.acknowledgeApplication(db(cur), { graph: held, decisionId: 'd1', to: 'owner@example.test' });
  check('a suppressed send is an error the caller records, never "sent"', !a.sent && /held it/.test(a.error || ''));
  const broken = { ...graph, async sendAs() { throw new Error('Graph 503'); } };
  a = await ACK.acknowledgeApplication(db(cur), { graph: broken, decisionId: 'd1', to: 'owner@example.test' });
  check('a failed send is an error (caller falls back to the Draft Queue)', !a.sent && /503/.test(a.error || ''));
  process.env.ACC_AUTO_ACKNOWLEDGE = 'off';
  a = await ACK.acknowledgeApplication(db(cur), { graph, decisionId: 'd1', to: 'owner@example.test' });
  delete process.env.ACC_AUTO_ACKNOWLEDGE;
  check('kill switch: receipts go back to the Draft Queue', /turned off/.test(a.skipped || '') && sends.length === n);

  console.log('\nWired into the email door');
  const ei = fs.readFileSync(path.join(__dirname, '..', 'lib', 'applications', 'email_intake.js'), 'utf8');
  check('the email door uses Annie\'s receipt sender, Draft Queue only as fallback', /acknowledgeApplication\(supabase/.test(ei) && ei.indexOf('acknowledgeApplication(supabase') < ei.indexOf('const q = await queueDraft({'));
  check('the original receipt date is read and passed to the case', /originalReceivedAt\(\{ subject: email\.subject/.test(ei) && /receivedAt: received\.at, receivedAtBasis: received\.basis/.test(ei));
  check('a sent first message is not overwritten with "not acknowledged"', ei.includes('if (!ackSent && ackError)') && ei.includes(".is('acknowledged_at', null)"));
  const pi = fs.readFileSync(path.join(__dirname, '..', 'lib', 'acc', 'pending_intake.js'), 'utf8');
  check('the case insert degrades until migration 579 (never loses the application)', /received_at column missing \(apply migration 579\)/.test(pi));
  check('migration 579 adds received_at + basis', /ADD COLUMN IF NOT EXISTS received_at timestamptz/.test(fs.readFileSync(path.join(__dirname, '..', 'migrations', '579_acc_received_at.sql'), 'utf8')));

  console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall ACC receipt checks passed\x1b[0m');
  process.exit(failures ? 1 : 0);
})();
