#!/usr/bin/env node
// ============================================================================
// Graph mail send/reply failures are normalized: the raw Graph blob never reaches
// staff, a temporary mailbox state (ErrorMailboxMoveInProgress) gets a plain
// message, and nothing is retried. Fixture = the exact 2026-09-24 production
// error from miranda@bedrocktx.com.
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const { graphSendError } = require('../lib/email/graph_errors');
const { safeErrorMessage } = require('../api/_safe_error');

const PROD = '{"error":{"code":"ErrorMailboxMoveInProgress","message":"Mailbox move in progress. Try again later., Cross Server access is not allowed for mailbox 5bcbd794-9d45-4aaa-8a20-95a36dbd9326"}}';
const MSG = 'Microsoft is temporarily moving this mailbox. Your message was not sent. Please try again later.';
let failed = 0;
const t = async (name, fn) => { try { await fn(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); } };

(async () => {
  await t('ErrorMailboxMoveInProgress -> temporary, plain message, no raw JSON for staff', () => {
    const e = graphSendError('createReply', 503, PROD);
    assert.strictEqual(e.code, 'mailbox_move_in_progress');
    assert.strictEqual(e.graphCode, 'ErrorMailboxMoveInProgress');
    assert.strictEqual(e.temporary, true);
    assert.strictEqual(safeErrorMessage(e), MSG);
    assert.ok(!/\{|ErrorMailbox|5bcbd794/.test(safeErrorMessage(e)), 'raw Graph detail leaked');
    assert.ok(/createReply failed \(503\) ErrorMailboxMoveInProgress/.test(e.message), 'server log keeps the detail');
  });
  await t('any step (sendMail / patch / send reply) maps the same way', () => {
    for (const step of ['sendMail', 'patch reply', 'send reply']) assert.strictEqual(safeErrorMessage(graphSendError(step, 503, PROD)), MSG);
  });
  await t('other Graph errors stay generic (not labelled temporary)', () => {
    const e = graphSendError('sendMail', 400, '{"error":{"code":"ErrorInvalidRecipients","message":"bad address"}}');
    assert.strictEqual(e.temporary, false);
    assert.strictEqual(e.userMessage, null);
    assert.strictEqual(e.code, 'graph_send_failed');
    const n = graphSendError('sendMail', 500, 'not json at all');
    assert.strictEqual(n.graphCode, null);
  });
  await t('sendReplyAs: a 503 mailbox move throws the normalized error and makes NO further Graph calls', async () => {
    const graphSend = require('../lib/email/graph_send');
    if (!graphSend.isConfigured()) return console.log('      (skipped: Graph not configured locally)');
    const realFetch = global.fetch; const calls = [];
    global.fetch = async (url, opts) => {
      calls.push(String(url));
      if (/login\.microsoftonline|oauth2/.test(String(url))) return new Response(JSON.stringify({ access_token: 'x', expires_in: 3600 }), { status: 200 });
      if (/createReply/.test(String(url))) return new Response(PROD, { status: 503 });
      return new Response('{}', { status: 200 });
    };
    try {
      await assert.rejects(() => graphSend.sendReplyAs({ from: graphSend.MIRANDA_MAILBOX, sourceGraphId: 'AAMk-test', html: '<p>hi</p>' }),
        (e) => e.code === 'mailbox_move_in_progress' && e.temporary === true);
      assert.ok(!calls.some((u) => /\/send$|\/messages\/[^/]+$/.test(u)), 'no patch/send after the failure: ' + calls.join(', '));
      assert.strictEqual(calls.filter((u) => /createReply/.test(u)).length, 1, 'no automatic retry');
    } finally { global.fetch = realFetch; }
  });
  await t('triage /:id/send returns 503 + sent:false for a temporary mailbox state, and marks nothing before the send', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'api/email_triage.js'), 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf("router.post('/:id/send'");
    const block = src.slice(start, src.indexOf('\n});', start));
    assert.ok(/res\.status\(err && err\.temporary \? 503 : 500\)/.test(block));
    assert.ok(/sent: false/.test(block));
    const iSend = block.indexOf('graphSend.sendReplyAs(');
    const iHandled = block.indexOf("triage_status: 'handled'");
    const iOutbound = block.indexOf("direction: 'outbound'");
    assert.ok(iSend > 0 && iHandled > iSend && iOutbound > iSend, 'handled/outbound must come after the send');
  });

  console.log(failed ? `\n${failed} failure(s)` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
