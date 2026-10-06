// ============================================================================
// tests/test_reply_judgment.js  (Ed 2026-10-06)
// ----------------------------------------------------------------------------
// Attachment-first, proportionate replies. Regression: the Canyon Gate sign email.
//
// A board president wrote "I ordered a new road sign for the neighborhood. I have
// attached the receipt." with a one-page receipt PDF (an online order for a "Do
// Not Block Intersection" sign, about $51). Amanda's draft said she could not see
// the amount or vendor, asked for the dollar amount, quoted the association's cash
// and laid out ratification options. Expected: a short acknowledgment that uses
// the receipt's facts and says it goes to accounting. (Names, addresses and the
// association's figures are sanitized here; this repo is public.)
//
//   node tests/test_reply_judgment.js
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const J = require('../lib/team/reply_judgment');

let passed = 0; const pending = [];
function check(name, fn) {
  pending.push(Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓ ' + name); },
    (e) => { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }));
}

// The draft Amanda actually produced (sanitized: name and cash figure replaced).
const BAD_DRAFT = `Good afternoon President,

Thank you for sending the receipt for the new road sign. Before this can be processed for reimbursement, I want to lay out a couple of things for the board's awareness.

1. I do not have visibility in your message to the actual receipt amount or vendor name, so I cannot confirm yet whether this falls within an existing budget line or would need board authorization as an out-of-budget spend. If you can confirm the dollar amount, I can speak to where it fits.

2. Our available operating cash on hand is $XX,XXX, so funding is not a concern for a sign-sized purchase, but any board expenditure should still be properly authorized.

Your options as I see them:
1. If this was a budgeted expense and within your authorized spending authority as president, I can route the receipt to accounting now.
2. If this falls outside the current budget, the board can ratify the purchase at the next meeting or by written consent.
3. I can hold the receipt and bring it to the board as an agenda item for a vote.

Let me know the amount and which account you would like this charged to.`;

// What it should look like (the drafter's output after this fix, sanitized).
const GOOD_DRAFT = `Good morning,

Thank you for sending this along. The receipt shows the online order for the "Do Not Block Intersection" aluminum sign, total $51.05, placed October 6.

I will route this to our accounting team for processing and reimbursement through the normal payables process. No action needed from you on this one.

Best,`;

console.log('\nThe Canyon Gate sign email');
check('the original draft is caught: it claims the amount/vendor is unavailable although the receipt was attached', () => {
  const c = J.checkReply(BAD_DRAFT, { attachmentsRead: true });
  assert.strictEqual(c.claims_unavailable, true);
});
check('the original draft is flagged for governance framing on a routine receipt (options, ratify, cash on hand)', () => {
  assert.strictEqual(J.checkReply(BAD_DRAFT, { attachmentsRead: true }).governance_framing, true);
});
check('the expected reply passes: uses the receipt facts, short, routes to accounting, no governance framing', () => {
  const c = J.checkReply(GOOD_DRAFT, { attachmentsRead: true });
  assert.deepStrictEqual([c.claims_unavailable, c.governance_framing], [false, false]);
  assert.match(GOOD_DRAFT, /\$51\.05/);
  assert.match(GOOD_DRAFT, /accounting/);
  assert.ok(GOOD_DRAFT.split(/\s+/).length < 90, 'routine reply stays short');
});

console.log('\nThe check does not over-fire');
check('asking for something genuinely missing is fine when nothing was attached', () => {
  assert.strictEqual(J.checkReply('Could you send the receipt when you have it?', { attachmentsRead: false }).claims_unavailable, false);
});
check('ordinary sentences are not mistaken for an unavailable-claim', () => {
  for (const s of ['I don’t see any issue with this.', 'I can confirm we received it.', 'Accounting will confirm the posting date.', 'Thanks, I have the receipt and will send it to accounting.']) {
    assert.strictEqual(J.checkReply(s, { attachmentsRead: true }).claims_unavailable, false, s);
  }
});
check('common unavailable-claims are all caught when an attachment was read', () => {
  for (const s of ['I cannot see the amount on the receipt.', 'I don’t have visibility into the vendor.', 'Please confirm the dollar amount.', 'Can you send the invoice total?', 'I was unable to find the total on the attachment.']) {
    assert.strictEqual(J.checkReply(s, { attachmentsRead: true }).claims_unavailable, true, s);
  }
});

console.log('\nAmanda’s desk drafter reads attachments and self-corrects');
function mockAnthropic(replies) {
  const calls = [];
  return { calls, messages: { create: async (req) => { calls.push(req); return { content: [{ text: JSON.stringify(replies[Math.min(calls.length - 1, replies.length - 1)]) }] }; } } };
}
const desk = require('../lib/amanda/email_console');
const PDF_BLOCK = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' } };
check('the receipt goes in as a readable document block and the rules are in the system prompt', async () => {
  const anthropic = mockAnthropic([{ subject: 'Re: Sign Receipt', body: GOOD_DRAFT }]);
  const d = await desk.draftAmandaEmail({ thought: 'Reply to the sign receipt email.', attachmentBlocks: [PDF_BLOCK], attachmentSummary: 'Block Inter Sign.pdf (PDF)' }, { anthropic });
  const req = anthropic.calls[0];
  assert.ok(Array.isArray(req.messages[0].content) && req.messages[0].content[0].type === 'document', 'PDF block sent first');
  assert.match(req.messages[0].content[1].text, /ATTACHMENTS: Block Inter Sign\.pdf/);
  assert.ok(req.system.includes('ATTACHMENTS COME FIRST') && req.system.includes('PROPORTIONALITY'));
  assert.strictEqual(anthropic.calls.length, 1);
  assert.match(d.body, /\$51\.05/);
});
check('a draft that claims the facts are unavailable is re-asked once with the correction, and the corrected draft is used', async () => {
  const anthropic = mockAnthropic([{ subject: 'Re: Sign Receipt', body: 'I cannot see the amount on the receipt. Please confirm the dollar amount.' }, { subject: 'Re: Sign Receipt', body: GOOD_DRAFT }]);
  const d = await desk.draftAmandaEmail({ thought: 'Reply to the sign receipt email.', attachmentBlocks: [PDF_BLOCK], attachmentSummary: 'Block Inter Sign.pdf (PDF)' }, { anthropic });
  assert.strictEqual(anthropic.calls.length, 2);
  assert.ok(anthropic.calls[1].messages[0].content[1].text.includes(J.RETRY_NOTE));
  assert.match(d.body, /\$51\.05/);
});
check('a rejected attachment falls back to text-only, naming the file, instead of failing the draft', async () => {
  let n = 0;
  const anthropic = { messages: { create: async (req) => { n++; if (Array.isArray(req.messages[0].content)) throw new Error('document rejected'); return { content: [{ text: JSON.stringify({ subject: 's', body: 'Thank you, I received Block Inter Sign.pdf and will review it.' }) }] }; } } };
  const d = await desk.draftAmandaEmail({ thought: 'x', attachmentBlocks: [PDF_BLOCK], attachmentSummary: 'Block Inter Sign.pdf (PDF)' }, { anthropic });
  assert.strictEqual(n, 2);
  assert.match(d.body, /Block Inter Sign\.pdf/);
});

console.log('\nAmanda’s escalation drafter (the one that wrote the bad draft)');
const AR = fs.readFileSync(path.join(__dirname, '..', 'lib', 'community', 'amanda_reply.js'), 'utf8');
check('fetches the attachments (not just photos) before the model call and sends them as blocks', () => {
  const f = AR.indexOf('fetchAttachmentBlocks(mb, gid)'); const c = AR.indexOf('anthropic.messages.create', f);
  assert.ok(f > 0 && c > f, 'attachments fetched before drafting');
  assert.match(AR, /attachBlocks\.length \? \[\.\.\.attachBlocks, \{ type: 'text', text \}\] : text/);
});
check('both rules are in her system prompt, and the board prompt no longer forces options on routine items', () => {
  assert.match(AR, /judgment\.ATTACHMENT_RULE \+ '\\n\\n' \+ judgment\.PROPORTIONALITY_RULE/);
  assert.match(AR, /When they send you something routine \(a receipt for a normal purchase/);
  assert.ok(!/Do not hand them a single answer or make the decision for them — lay out the relevant facts, give 2 to 3 clear options with the tradeoffs, and state YOUR recommendation\. The board decides, often by a vote\.`/.test(AR), 'unconditional options rule removed');
});
check('the unavailable-claim guard re-asks once and the reviewer hint carries any remaining issue', () => {
  assert.match(AR, /if \(check\.claims_unavailable\) \{\s*out = await ask\(judgment\.RETRY_NOTE\);/);
  assert.match(AR, /CHECK: \$\{judgmentIssues\.join\('; '\)\}/);
});

Promise.all(pending).then(() => console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', with failures' : '')));
