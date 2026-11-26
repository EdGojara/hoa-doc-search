// ============================================================================
// tests/test_delivery_window.js  (Ed 2026-11-26)
// ----------------------------------------------------------------------------
// The shared communication window for AI teammates' routine outbound email
// (lib/email/delivery_window + the Draft Queue send): the work is done and
// approved now, delivery waits 2 minutes (configurable), and a newer message
// from the recipient holds it for review instead of crossing in the mail.
// Urgent / time-sensitive mail and workflows with their own window are exempt.
// Run: node tests/test_delivery_window.js
// ============================================================================
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
const fs = require('fs');
const path = require('path');
const DW = require('../lib/email/delivery_window');

let failures = 0;
const check = (name, cond, detail) => { if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`); else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); } };

(async () => {
  console.log('\nHow long a teammate email waits');
  delete process.env.AI_EMAIL_MIN_DELAY_SECONDS;
  check('routine: 2 minutes by default', DW.windowFor({ persona: 'kat', subject: 'Re: invoice question' }) === 120000);
  process.env.AI_EMAIL_MIN_DELAY_SECONDS = '300';
  check('configurable (AI_EMAIL_MIN_DELAY_SECONDS)', DW.windowFor({ persona: 'kat', subject: 'Re: x' }) === 300000);
  delete process.env.AI_EMAIL_MIN_DELAY_SECONDS;
  check('urgent / time-sensitive subjects go now', ['URGENT: water leak', 'Pool closing today only', 'Emergency gate repair', 'Time-sensitive: closing docs'].every((s) => DW.windowFor({ persona: 'amanda', subject: s }) === 0));
  check('a draft marked urgent or time-sensitive goes now', DW.windowFor({ persona: 'amanda', subject: 'Re: x', policy: { urgent: true } }) === 0 && DW.windowFor({ persona: 'amanda', subject: 'x', policy: { time_sensitive: true } }) === 0);
  check('"send now" from the person goes now', DW.windowFor({ persona: 'amanda', subject: 'x' }, { sendNow: true }) === 0);
  check('a workflow\'s own window takes precedence', DW.windowFor({ persona: 'annie', subject: 'x', policy: { delivery_window_seconds: 0 } }) === 0 && DW.windowFor({ persona: 'annie', subject: 'x', policy: { delivery_window_seconds: 1800 } }) === 1800000);
  check('Tessa (scheduling for Ed) is never delayed', DW.windowFor({ persona: 'tessa', subject: 'Lunch Thursday?' }) === 0);

  console.log('\nAccounting for newer correspondence');
  const calls = [];
  const fakeDb = (rows) => ({ from() { const q = { _f: [], select() { return q; }, eq(k, v) { q._f.push(['eq', k, v]); return q; }, gt(k, v) { q._f.push(['gt', k, v]); return q; }, order() { return q; }, limit() { return q; }, or(x) { q._f.push(['or', x]); return q; }, in(k, v) { q._f.push(['in', k, v]); return q; }, neq() { return q; },
    then(res) { calls.push(q._f); return Promise.resolve({ data: rows, error: null }).then(res); } }; return q; } });
  let n = await DW.newerInbound(fakeDb([{ id: 'm2', sender_email: 'owner@example.test', received_at: '2026-11-26T20:01:00Z', subject: 'one more thing' }]), { to: 'Owner@Example.test', conversationId: 'c1', since: '2026-11-26T20:00:00Z' });
  check('a message from the recipient (or the thread) after approval is found', n && n.id === 'm2');
  check('...checks inbound mail after the approval time, by thread or sender', JSON.stringify(calls[0]).includes('"inbound"') && JSON.stringify(calls[0]).includes('2026-11-26T20:00:00Z') && JSON.stringify(calls[0]).includes('conversation_id.eq.c1'));
  n = await DW.newerInbound(fakeDb([]), { to: 'owner@example.test', since: '2026-11-26T20:00:00Z' });
  check('nothing newer: it proceeds', n === null);
  const sup = await DW.supersededBy(fakeDb([{ id: 'd2', persona: 'amanda', policy: { scheduled_send: { approved_at: '2026-11-26T20:01:00Z' } } }]), { id: 'd1', persona: 'amanda', source_email_ref: 'e1', policy: { scheduled_send: { approved_at: '2026-11-26T20:00:00Z' } } });
  check('a newer approved reply on the same thread supersedes the older one (one email, not two)', sup && sup.id === 'd2');

  console.log('\nOne shared path (the Draft Queue send), durable and re-checked');
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'email_drafts.js'), 'utf8');
  check('the send schedules within the window after every pre-check, before rendering', src.indexOf('ReplyGuard.blockedBy(await ReplyGuard.existingClaim') < src.indexOf('DW.windowFor(d') && src.indexOf('DW.windowFor(d') < src.indexOf('Re-render the branded wrapper'));
  check('the schedule is stored on the draft (survives a restart) and re-armed at start-up', /scheduled_send: sched/.test(src) && /async function rearmScheduled/.test(src) && /rearmScheduled\(\)/.test(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')));
  check('the release holds on a newer message, an edit after approval, or supersedes; otherwise runs the full send as the approver', /hold\('the draft changed after it was approved/.test(src) && /DW\.newerInbound\(supabase/.test(src) && /DW\.supersededBy\(supabase, d\)/.test(src) && /_deliveryRelease: true/.test(src) && /_approver: \{ email: sched\.approved_by/.test(src));
  check('the approver on a release is set only in-process (never from HTTP)', /const approver = req\._approver \|\| await getActingUser\(req\)/.test(src) && !/req\.body\._approver|req\.body\.approver/.test(src));
  check('one-shot timers only (no polling)', /setTimeout\(/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'delivery_window.js'), 'utf8')) && !/setInterval\(/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'delivery_window.js'), 'utf8')));
  const sch = fs.readFileSync(path.join(__dirname, '..', 'lib', 'scheduler.js'), 'utf8');
  check('Amanda\'s communication check (overdue releases, holds) rides the existing sweep', /communicationCheck\(supabase, \{ send \}\)/.test(sch));

  console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall delivery-window checks passed\x1b[0m');
  process.exit(failures ? 1 : 0);
})();
