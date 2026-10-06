// ============================================================================
// tests/test_amanda_inbox.js  (Ed 2026-10-06)
// ----------------------------------------------------------------------------
// Mail ADDRESSED to Amanda shows in her inbox, whoever routing filed it under,
// and Reply as Amanda stages a threaded reply for review instead of sending.
//
// The scar: the Canyon Gate president's "New Team Member for Canyon Gate at Cinco
// Ranch HOA" went to amandaalbright@ (cc Ed). Ingest stored it in her mailbox with
// the community, but routing set persona='miranda' and every Amanda screen
// filtered on persona, so it never appeared on Amanda's screens.
//
//   node tests/test_amanda_inbox.js
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ib = require('../lib/amanda/email_inbox');
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

let passed = 0; const pending = [];
function check(name, fn) {
  pending.push(Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓ ' + name); },
    (e) => { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }));
}
const AMANDA = 'amandaalbright@bedrocktx.com';
const graphSend = { AMANDA_MAILBOX: AMANDA };

// Chainable fake: records every filter, returns canned data per table.
function fakeSb(tables, log = []) {
  return {
    log,
    from(t) {
      const q = { t, f: [], op: 'select', row: null };
      const api = {
        select() { return api; }, order() { return api; }, limit() { return api; }, range() { return api; },
        eq(c, v) { q.f.push(['eq', c, v]); return api; }, neq(c, v) { q.f.push(['neq', c, v]); return api; },
        gte(c, v) { q.f.push(['gte', c, v]); return api; }, in(c, v) { q.f.push(['in', c, v]); return api; },
        insert(row) { q.op = 'insert'; q.row = row; return api; }, update(row) { q.op = 'update'; q.row = row; return api; },
        single() { return api.then ? run(true) : null; }, maybeSingle() { return run(true); },
        then(res, rej) { return run(false).then(res, rej); },
      };
      async function run(one) {
        log.push(q);
        const h = tables[t];
        const out = typeof h === 'function' ? h(q) : h;
        if (out && out.error) return out;
        const data = q.op === 'insert' || q.op === 'update' ? { id: 'new', ...q.row, created_at: 'now' } : (one ? (Array.isArray(out) ? out[0] || null : out) : out);
        return { data, error: null };
      }
      api.single = () => run(true);
      return api;
    },
  };
}

console.log('\nReply status');
check('needs reply / staged / replied / auto-replied / handled', () => {
  const m = { id: 'm1', internet_message_id: '<a@x>', triage_status: 'needs_review' };
  assert.strictEqual(ib.replyStatus(m), 'needs_reply');
  assert.strictEqual(ib.replyStatus(m, { replies: [{ source_email_ref: 'm1', status: 'draft' }] }), 'reply_staged');
  assert.strictEqual(ib.replyStatus(m, { replies: [{ source_email_ref: 'm1', status: 'draft' }, { source_email_ref: 'm1', status: 'sent' }] }), 'replied');
  assert.strictEqual(ib.replyStatus(m, { receipts: [{ source_email_ref: 'email:<a@x>', status: 'sent' }] }), 'auto_replied');
  assert.strictEqual(ib.replyStatus({ ...m, triage_status: 'handled' }), 'handled');
  assert.strictEqual(ib.replyStatus(m, { replies: [{ source_email_ref: 'other', status: 'sent' }] }), 'needs_reply', 'another message’s reply does not count');
});

console.log('\nThe inbox is "delivered to Amanda", not "routed to Amanda"');
check('loadInbox filters on Amanda’s mailbox + inbound, never on persona; a Miranda-routed message is included', async () => {
  const sb = fakeSb({
    email_messages: [{ id: 'cg', sender_email: 'president@canyongateatcincoranch.com', subject: 'New Team Member for Canyon Gate at Cinco Ranch HOA', received_at: '2026-10-06T15:51:25Z',
      persona: 'miranda', triage_status: 'needs_review', internet_message_id: '<cg@x>', community: { name: 'Canyon Gate at Cinco Ranch' } }],
    outbound_email_drafts: [],
  });
  const r = await ib.loadInbox(sb, { days: 30 }, { graphSend });
  const q = sb.log.find((x) => x.t === 'email_messages');
  assert.deepStrictEqual(q.f.filter((f) => f[0] === 'eq'), [['eq', 'mailbox', AMANDA], ['eq', 'direction', 'inbound']]);
  assert.ok(!q.f.some((f) => f[1] === 'persona'), 'no persona filter');
  assert.strictEqual(r.items.length, 1);
  assert.deepStrictEqual([r.items[0].community, r.items[0].routed_to, r.items[0].reply_status], ['Canyon Gate at Cinco Ranch', 'miranda', 'needs_reply']);
  assert.strictEqual(r.needs_reply, 1);
});
check('a failed inbox read is reported, not shown as an empty inbox', async () => {
  const r = await ib.loadInbox(fakeSb({ email_messages: { error: { message: 'boom' } } }), {}, { graphSend });
  assert.deepStrictEqual([r.items.length, r.source_errors.inbox], [0, 'boom']);
});

console.log('\nThread + reply prefill');
const cgRow = { id: 'cg', mailbox: AMANDA, direction: 'inbound', sender_name: 'Board President', sender_email: 'President@CanyonGateAtCincoRanch.com',
  recipients: ['treasurer@cg.com', AMANDA], subject: 'New Team Member', body_full: 'short', received_at: 'x', graph_id: 'g1', conversation_id: null, community: { name: 'Canyon Gate at Cinco Ranch' } };
const ga = { fetchMessageText: async () => 'The full body from Microsoft 365, longer than the stored copy.', fetchMessageRecipients: async () => ({ to: ['treasurer@cg.com', AMANDA, 'amanda@bedrocktx.com'], cc: ['egojara@bedrocktx.com'] }) };
check('the thread carries the full body and the CC that email_messages does not store', async () => {
  const t = await ib.loadThread(fakeSb({ email_messages: cgRow }), 'cg', { graphSend, graphAttachments: ga });
  assert.match(t.message.body, /full body from Microsoft 365/);
  assert.deepStrictEqual(t.message.cc, ['egojara@bedrocktx.com']);
  assert.strictEqual(t.message.threaded_reply_possible, true);
});
check('reply prefill: to the sender, Re: subject, reply-all CC = everyone else, never Amanda or the sender', async () => {
  const t = await ib.loadThread(fakeSb({ email_messages: cgRow }), 'cg', { graphSend, graphAttachments: ga });
  assert.strictEqual(t.reply.to, 'President@CanyonGateAtCincoRanch.com');
  assert.strictEqual(t.reply.subject, 'Re: New Team Member');
  assert.deepStrictEqual(t.reply.reply_all_cc, ['treasurer@cg.com', 'egojara@bedrocktx.com']);
});
check('a message from another mailbox is not served as Amanda’s', async () => {
  const t = await ib.loadThread(fakeSb({ email_messages: { ...cgRow, mailbox: 'info@bedrocktx.com' } }), 'cg', { graphSend, graphAttachments: ga });
  assert.deepStrictEqual(t, { not_amanda: true });
});

console.log('\nReply as Amanda is staged, not sent');
const msg = { id: 'cg', from_email: 'president@cg.com', from_name: 'Board President', subject: 'New Team Member', community: 'Canyon Gate at Cinco Ranch', community_id: 'c3' };
check('stageReply writes an Amanda reply draft linked to the inbound (kind, link, To sender, Re: subject, no em-dashes)', async () => {
  const sb = fakeSb({ outbound_email_drafts: (q) => (q.op === 'select' ? [] : null) });
  const r = await ib.stageReply(sb, { message: msg, body: 'Welcome aboard — thank you.', cc: 'president@cg.com, egojara@bedrocktx.com', createdBy: 'egojara@bedrocktx.com' });
  const ins = sb.log.find((x) => x.op === 'insert').row;
  assert.deepStrictEqual([ins.persona, ins.status, ins.draft_kind, ins.related_type, ins.related_id, ins.source_email_ref], ['amanda', 'draft', 'amanda_reply', 'email_triage', 'cg', 'cg']);
  assert.strictEqual(ins.to_email, 'president@cg.com');
  assert.strictEqual(ins.cc, 'egojara@bedrocktx.com', 'the sender is not repeated in CC');
  assert.strictEqual(ins.subject, 'Re: New Team Member');
  assert.ok(!/—/.test(ins.body_text));
  assert.strictEqual(r.replaced, false);
});
check('staging again updates the one open reply instead of creating a second', async () => {
  const sb = fakeSb({ outbound_email_drafts: (q) => (q.op === 'select' ? [{ id: 'open1' }] : null) });
  const r = await ib.stageReply(sb, { message: msg, body: 'Second version.' });
  assert.ok(sb.log.some((x) => x.op === 'update') && !sb.log.some((x) => x.op === 'insert'));
  assert.strictEqual(r.replaced, true);
});
check('stageReply refuses an empty reply and throws on a write error (never silently lost)', async () => {
  await assert.rejects(ib.stageReply(fakeSb({ outbound_email_drafts: [] }), { message: msg, body: '  ' }), /body_required/);
  const bad = fakeSb({ outbound_email_drafts: (q) => (q.op === 'insert' ? { error: { message: 'boom' } } : []) });
  await assert.rejects(ib.stageReply(bad, { message: msg, body: 'x' }), /stage_failed/);
});

console.log('\nReply All is the default');
const cgThread = { reply: { to: 'president@canyongateatcincoranch.com', reply_all_cc: ['treasurer@canyongateatcincoranch.com', 'vicepresident@canyongateatcincoranch.com',
  'secretary@canyongateatcincoranch.com', 'director@canyongateatcincoranch.com', 'propertymanager@canyongateatcincoranch.com', 'egojara@bedrocktx.com'], default_mode: 'all' } };
check('Canyon Gate reply all: sender in To, all five board addresses + Ed in CC, Amanda never', () => {
  const r = ib.replyRecipients(cgThread);
  assert.strictEqual(r.mode, 'all');
  assert.strictEqual(r.to, 'president@canyongateatcincoranch.com');
  assert.deepStrictEqual(r.cc, cgThread.reply.reply_all_cc);
});
check('extra CC is merged, de-duplicated (case-insensitive), and can never add Amanda or the sender', () => {
  const r = ib.replyRecipients(cgThread, { extraCc: 'TREASURER@canyongateatcincoranch.com, amanda@bedrocktx.com, amandaalbright@bedrocktx.com, President@CanyonGateAtCincoRanch.com, new@x.com' });
  assert.strictEqual(r.cc.length, 7);
  assert.ok(r.cc.includes('new@x.com'));
  for (const a of ['amanda@bedrocktx.com', 'amandaalbright@bedrocktx.com', 'president@canyongateatcincoranch.com']) assert.ok(!r.cc.includes(a), a + ' must not be in CC');
  assert.ok(r.cc.includes('vicepresident@canyongateatcincoranch.com'));
});
check('Reply to sender only stays available: no original recipients, extra CC still honored', () => {
  assert.deepStrictEqual(ib.replyRecipients(cgThread, { mode: 'sender' }).cc, []);
  assert.deepStrictEqual(ib.replyRecipients(cgThread, { mode: 'sender', extraCc: 'x@y.com' }).cc, ['x@y.com']);
});
check('the thread defaults to Reply all when there are other recipients, sender-only when there are none', async () => {
  const t = await ib.loadThread(fakeSb({ email_messages: cgRow }), 'cg', { graphSend, graphAttachments: ga });
  assert.strictEqual(t.reply.default_mode, 'all');
  const solo = { fetchMessageText: async () => '', fetchMessageRecipients: async () => ({ to: [AMANDA], cc: [] }) };
  const t2 = await ib.loadThread(fakeSb({ email_messages: { ...cgRow, recipients: [AMANDA] } }), 'cg', { graphSend, graphAttachments: solo });
  assert.strictEqual(t2.reply.default_mode, 'sender');
});
check('the reply route stages with Reply All unless reply_mode is "sender"', () => {
  const s = src('api/amanda_email.js');
  assert.match(s, /inbox\.replyRecipients\(t, \{ mode: b\.reply_mode === 'sender' \? 'sender' : 'all', extraCc: b\.cc \}\)/);
});

console.log('\nRouting: direct mailbox identity beats content inference');
const { personaForMessage, directIdentityPersona } = require('../lib/email/persona');
const gsReal = require('../lib/email/graph_send');
check('the Canyon Gate case: To amandaalbright@, board sender, enforcement-looking content -> Amanda, not Miranda', () => {
  const got = personaForMessage({
    mailbox: gsReal.AMANDA_MAILBOX, direction: 'inbound', classification: 'internal',
    sender_email: 'president@canyongateatcincoranch.com', subject: 'New Team Member for Canyon Gate at Cinco Ranch HOA',
    body_preview: 'Board, I would like to welcome Amanda Albright to our team. Courtesy notice, violation, deed restriction follow-up.',
    extracted: { drv: { persona: 'miranda', violation_id: 'v1', current_stage: 'courtesy_1' } },
  });
  assert.strictEqual(got, 'amanda');
});
check('an ACC-looking or vendor-looking email to Amanda’s own mailbox also stays Amanda’s', () => {
  assert.strictEqual(personaForMessage({ mailbox: gsReal.AMANDA_MAILBOX, classification: 'acc_request' }), 'amanda');
  assert.strictEqual(personaForMessage({ mailbox: gsReal.AMANDA_MAILBOX, classification: 'vendor_financial', subject: 'Invoice past due' }), 'amanda');
});
check('explicit routes are unchanged: functional inboxes, Miranda’s box, and DRV mail to info@ / claire@ still go to Miranda', () => {
  assert.strictEqual(personaForMessage({ mailbox: 'violations@bedrocktx.com' }), 'miranda');
  assert.strictEqual(personaForMessage({ mailbox: 'acc@bedrocktx.com' }), 'annie');
  assert.strictEqual(personaForMessage({ mailbox: 'info@bedrocktx.com', extracted: { drv: { persona: 'miranda' } } }), 'miranda');
  assert.strictEqual(personaForMessage({ mailbox: gsReal.CLAIRE_MAILBOX, extracted: { drv: { persona: 'miranda' } } }), 'miranda', 'claire@ is the front office: DRV still hands off');
  assert.strictEqual(directIdentityPersona(gsReal.CLAIRE_MAILBOX), null);
});
check('thread continuity cannot pull a directly-addressed message back to another teammate', () => {
  const g = src('lib/email/graph_ingest.js');
  assert.match(g, /const _direct = require\('\.\/persona'\)\.directIdentityPersona\(row\.mailbox\);/);
  assert.match(g, /&& !\(_direct && _direct === row\.persona\)\) \{/);
});

console.log('\nWiring');
check('inbox routes are admin-gated and never send', () => {
  const s = src('api/amanda_email.js');
  for (const r of ["router.get('/inbox'", "router.get('/inbox/:id'", "router.post('/inbox/:id/reply'"]) {
    const k = s.indexOf(r); assert.ok(k > 0, r); assert.match(s.slice(k, k + 200), /requireAdmin/, r);
  }
  assert.ok(!/sendAs\(|sendReplyAs\(/.test(s), 'the desk stages; sending stays on the draft route');
});
check('releasing an Amanda reply: double-send guard first, then a threaded reply, then the inbound marked handled', () => {
  const s = src('api/email_drafts.js');
  const g = s.indexOf("d.draft_kind === 'amanda_reply'"), guard = s.indexOf('humanSendGuard(rcpt', g), rep = s.indexOf('graphSend.sendReplyAs(', g);
  const sentUpd = s.indexOf("status: 'sent', sent_at", rep), handled = s.indexOf("triage_status: 'handled'", sentUpd);
  assert.ok(g > 0 && guard > g && rep > guard && sentUpd > rep && handled > sentUpd, 'order: kind check < guard < threaded reply < sent < handled');
  assert.match(s, /const threaded = !!\(replyTo && replyTo\.graph_id && graphSend\.sameMailbox\(replyTo\.mailbox, from\)\)/);
});
check('other drafts send exactly as before (sendAs path unchanged for non-reply kinds)', () => {
  assert.match(src('api/email_drafts.js'), /: await graphSend\.sendAs\(\{ from, to: d\.to_email, cc: d\.cc \|\| undefined, subject, html, attachments: \[\.\.\.personaAttachments, \.\.\.fileAttachments\] \}\)/);
});
check('the card has an Inbox tab, loads it, and opens threads / stages replies through the desk routes', () => {
  const h = src('public/app/today.html');
  assert.ok(h.includes('id="th-em-t-inbox"') && h.includes('id="th-em-p-inbox"'));
  assert.ok(h.includes("TX.get('/api/amanda/email/inbox')") && h.includes("'/api/amanda/email/inbox/' + encodeURIComponent(id)"));
  assert.ok(h.includes("'/reply'"));
  assert.ok(h.includes('value="all"') && h.includes('Reply to sender only') && h.includes("rp.default_mode !== 'sender' ? ' checked'"), 'Reply all selected by default, sender-only visible');
  assert.ok(h.includes('reply_mode: ibModeVal') && h.includes("data-ibf=\"rcpt\""), 'mode sent to the server and recipients previewed');
});

Promise.all(pending).then(() => console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', with failures' : '')));
