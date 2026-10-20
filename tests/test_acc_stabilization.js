'use strict';
// ============================================================================
// tests/test_acc_stabilization.js  (Ed 2026-10-20) — ACC stabilization Phase 1
// ----------------------------------------------------------------------------
// Sanitized fixtures from real Oct 2026 cases (names kept to first names, no
// account numbers, phone numbers removed):
//   Brian  (Waterview, driveway application): Annie disclosed open violations and
//          a $70 balance, and a blank form was offered back to someone who had just
//          submitted the completed application.
//   Stevie (Still Creek, backup battery): first email was a QUESTION; Annie's later
//          reply claimed "applications must be submitted at least 30 days before work
//          begins" (the documents say the ARC responds within 30 days AFTER receipt).
//   Karen  (Lakes of Pine Forest, website form): "I would like to paint my front door
//          black. Do I have to fill out a request form?" went to Claire, not Annie.
// Pins the rules (lib/email/acc_reply_rules.js), the website routing
// (lib/email/website_inquiry.js routeAccQuestion) and the REAL drafter
// (lib/email/draft_reply.js) with a stubbed model and database.
//   node tests/test_acc_stabilization.js
// ============================================================================
const assert = require('node:assert/strict');
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY']) process.env[k] = process.env[k] || (k === 'SUPABASE_URL' ? 'http://localhost:1' : 'test-key');
let pass = 0, fail = 0; const pending = [];
const check = (name, fn) => pending.push(async () => { try { await fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '\n     ', e && e.message); } });
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const R = require('../lib/email/acc_reply_rules');
const WI = require('../lib/email/website_inquiry');

// ---- fixtures (sanitized) ----
const BRIAN_IN = 'Hello, attached is the architectural review application form and additional project schematic for our driveway project. The contractors informed me the renovations should take roughly 5 business days, plus potentially 3 to 5 additional days for inspection purposes. Thank you, Brian';
const BRIAN_DRAFT = `Hi Brian,

You sent this to the right place.

The form and schematic you attached cover what the committee needs for concrete work: location, dimensions and materials. Our declaration requires driveways be located no closer than two feet from the side property line, so the committee will confirm that clearance.

If you can give me the roughly 5 business days plus 3-5 for inspection you mentioned, I'll note that as your estimated time frame.

I'll also flag that the account shows a couple of open items, a landscaping overgrowth notice and two certified-stage cases for driveway powerwashing and yard sod, plus a $70 balance. None of that stops this application from moving forward for review, just wanted you to be aware since the sod phase you mentioned ties into the open sod case on file.

I'll get this into the queue for committee review now.`;
const STEVIE_Q = "Hi, I'm planning to have a home backup battery installed on the side of my house and wanted to check with you first to make sure it's okay with the HOA. I've attached the manufacturer's HOA information packet. Please let me know if this is approved, or if there's a form or anything else you need from me.";
const STEVIE_APP = "Thank you for sending the form. I've attached the following for the Architectural Control Committee's review: ACC Form, completed and signed; Plat of Survey with the proposed battery location marked; the manufacturer's package. Install timing: planned for December 2026. The install takes about one day.";
const STEVIE_DRAFT = `Hi Stevie,

The committee has what it needs: the signed ACC form, the survey and the specifications.

One thing to flag for the file: the governing documents require ARC applications to be submitted at least 30 days before work begins. Since you're targeting December, you're in good shape.

This now goes to the Architectural Control Committee for formal review, and you'll get their written decision separately.`;
const SCR_DOCS = 'In the event the ARC fails to approve such plans and specifications within thirty (30) days after the receipt thereof, they shall be deemed to be disapproved. In no case may construction begin prior to approval of plans by the ARC. The ARC will use reasonable efforts to review submissions and to give notice of approval or disapproval within thirty (30) days following receipt of submissions.';
const WV_DOCS = 'In the event the Architectural Control Committee fails to indicate its approval or disapproval within forty-five (45) days after the receipt of the required documents, the request shall be deemed denied.';
const KAREN = { verified: true, purpose: 'homeowner', name: 'Karen', email: 'karen.homeowner@example.com', community: 'Lakes of Pine Forest', owner: 'claire', intent: 'homeowner_inquiry', draft_classification: 'homeowner_request', verified_by: 'dkim+format' };

// ---- 1. unrelated account matters ----
check('Brian: unrelated violations and the balance are removed from an ACC reply; the project content stays', () => {
  const r = R.stripUnrelatedAccountMatters(BRIAN_DRAFT, BRIAN_IN);
  assert.equal(r.removed.length, 2, JSON.stringify(r.removed));
  assert.ok(!/violation|certified|overgrowth|\$70|balance|sod case/i.test(r.body), r.body);
  assert.ok(r.body.includes('two feet from the side property line') && r.body.includes('committee review now'));
});
check('the homeowner raising a violation or balance themselves keeps it relevant; an ACC case reference is never stripped', () => {
  const raised = 'I fixed the sod from the violation notice and want to extend my driveway.';
  assert.equal(R.stripUnrelatedAccountMatters('The sod violation notice is noted as corrected. The driveway goes to the committee.', raised).removed.length, 0);
  assert.equal(R.stripUnrelatedAccountMatters('Your open ACC case is with the committee.', BRIAN_IN).removed.length, 0);
});

// ---- 2. timing / procedure claims ----
check('Stevie: "submitted at least 30 days before work begins" is removed (documents: within 30 days AFTER receipt)', () => {
  const r = R.removeUnsupportedDayClaims(STEVIE_DRAFT, { docs: SCR_DOCS, inbound: STEVIE_APP });
  assert.equal(r.removed.length, 1); assert.equal(r.removed[0].relation, 'before'); assert.equal(r.removed[0].inDocs, true, 'the number is in the documents, the direction is not');
  assert.ok(!/30 days/.test(r.body) && r.body.includes('formal review'));
});
check('grounded timing is kept: the documents\' own window, and the homeowner\'s own estimate', () => {
  assert.equal(R.unsupportedDayClaims('The committee responds within 30 days after it receives a complete submission.', { docs: SCR_DOCS }).length, 0);
  assert.equal(R.unsupportedDayClaims('Per the governing documents the committee has up to 45 days from when a complete application is received.', { docs: WV_DOCS }).length, 0);
  assert.equal(R.unsupportedDayClaims(BRIAN_DRAFT, { docs: WV_DOCS, inbound: BRIAN_IN }).length, 0, 'Brian\'s 5 business days came from Brian');
  assert.equal(R.unsupportedDayClaims('Most reviews come back within 10 business days.', { docs: SCR_DOCS }).length, 1, 'an invented turnaround is caught');
});

// ---- 3. forms: offered only when they did not just submit one ----
check('submitted application vs question: Brian and Stevie\'s application were submissions; Stevie\'s question and Karen\'s were not', () => {
  assert.equal(R.looksLikeSubmittedApplication({ bodyText: BRIAN_IN, hasAttachments: true }), true);
  assert.equal(R.looksLikeSubmittedApplication({ bodyText: STEVIE_APP, hasAttachments: true }), true);
  assert.equal(R.looksLikeSubmittedApplication({ bodyText: STEVIE_Q, hasAttachments: true }), false);
  assert.equal(R.looksLikeSubmittedApplication({ bodyText: 'I would like to paint my front door black. I wanted to know if I have to fill out a request form.', hasAttachments: false }), false);
});
check('an attachment claim by us is detected; the homeowner\'s own attachments are not', () => {
  assert.equal(R.claimsWeAttached("I've attached the Lakes of Pine Forest application form."), true);
  assert.equal(R.claimsWeAttached('Attached is the application for you to complete.'), true);
  assert.equal(R.claimsWeAttached('The form and schematic you attached cover what is needed.'), false);
});

// ---- 4. Karen: website ACC question -> Annie, reply to Karen ----
check('Karen: a verified homeowner website inquiry the model calls acc_request goes to Annie as ACC; the reply recipient stays Karen', () => {
  const w = WI.routeAccQuestion(KAREN, 'acc_request');
  assert.equal(w.owner, 'annie'); assert.equal(w.draft_classification, 'acc_request'); assert.equal(w.email, 'karen.homeowner@example.com');
  assert.equal(WI.routeAccQuestion(KAREN, 'homeowner_request').owner, 'claire', 'a non-ACC homeowner question stays with Claire');
  assert.equal(WI.routeAccQuestion({ ...KAREN, purpose: 'prospective', owner: 'maggie' }, 'acc_request').owner, 'maggie');
  assert.equal(WI.routeAccQuestion({ ...KAREN, verified: false, owner: undefined }, 'acc_request').owner, undefined, 'an unverified claim is never routed');
  assert.equal(require('../lib/email/persona').personaForMessage({ mailbox: 'welcome@bedrocktx.com', classification: 'website_inquiry', extracted: { website_inquiry: WI.publicRecord(w) } }), 'annie');
});

// ---- 5. the REAL drafter, stubbed model + database ----
let lastCtx = ''; let modelBody = '';
class FakeAnthropic { constructor() { this.messages = { create: async (o) => {
  const text = (o.messages && o.messages[0] && o.messages[0].content && o.messages[0].content[0] && o.messages[0].content[0].text) || '';
  if (/Classification: /.test(text)) { lastCtx = text + '\n' + (o.system || ''); return { content: [{ text: modelBody }] }; }
  return { content: [{ text: 'none' }] };
} }; } }
stub('../lib/ai/anthropic', FakeAnthropic);
const DOCS = { text: WV_DOCS };
stub('../lib/hybrid_retrieval', { getRelevantChunks: async () => DOCS.text });
stub('../lib/email/graph_attachments', { fetchAttachmentBlocks: async () => ({ blocks: [], summary: '' }), fetchMessageText: async () => '' });
const TABLES = {
  properties: [{ id: 'p1', street_address: '1 Example Trail' }],
  violations: [{ property_id: 'p1', resolved_at: null, current_stage: 'certified_209', opened_at: '2026-08-01', enforcement_categories: { label: 'Yard sod' } }],
  v_homeowner_current_balance: [{ property_id: 'p1', balance_cents: 7000 }],
};
function q(t) {
  const f = []; let single = false;
  const b = { select() { return b; }, eq(c, v) { f.push((r) => r[c] === v); return b; }, is(c, v) { f.push((r) => (r[c] == null) === (v === null)); return b; }, in() { return b; }, ilike() { return b; }, or() { return b; }, gte() { return b; }, lte() { return b; }, not() { return b; }, neq() { return b; }, order() { return b; }, limit() { return b; },
    maybeSingle() { single = true; return b; }, single() { single = true; return b; },
    then(a, c) { const rows = (TABLES[t] || []).filter((r) => f.every((g) => g(r))); return Promise.resolve({ data: single ? rows[0] || null : rows, error: null }).then(a, c); } };
  return b;
}
const realSB = require('@supabase/supabase-js');
stub('@supabase/supabase-js', { ...realSB, createClient: () => ({ from: q }) });
const { draftReply } = require('../lib/email/draft_reply');
const email = (body) => ({ subject: 'Architectural review', body_full: body, sender_email: 'owner@example.com' });

check('real drafter, Brian (ACC): the model never sees violations or the balance, and any it writes is removed', async () => {
  modelBody = BRIAN_DRAFT; DOCS.text = WV_DOCS;
  const d = await draftReply({ email: email(BRIAN_IN), classification: 'acc_request', propertyId: 'p1', contactName: 'Brian', communityName: 'Waterview Estates', persona: 'annie' });
  assert.ok(!/Open violations|Account balance/.test(lastCtx), 'no violations / balance in the ACC context');
  assert.ok(/ACC REPLY SCOPE/.test(lastCtx) && /ACC TIMING AND PROCEDURE/.test(lastCtx));
  assert.ok(!/violation|certified|\$70|balance/i.test(d.body), d.body);
  assert.ok(d.warnings.some((w) => /unrelated to this architectural request/.test(w)));
  assert.ok(!/Annie Reeves's lane/.test(d.review_hint || ''), 'no "hand it to Annie" on Annie\'s own draft');
});
check('real drafter, non-ACC homeowner email still gets its account context (the ACC scope does not leak into other lanes)', async () => {
  modelBody = 'Hi, thanks for your note.';
  await draftReply({ email: email('When is my assessment due?'), classification: 'homeowner_request', propertyId: 'p1', contactName: 'Pat', communityName: 'Waterview Estates', persona: 'claire' });
  assert.ok(/Open violations/.test(lastCtx) && /Account balance/.test(lastCtx));
});
check('real drafter, Stevie (ACC): the unsupported 30-days-before-work claim is removed and the draft is flagged careful', async () => {
  modelBody = STEVIE_DRAFT; DOCS.text = SCR_DOCS;
  const d = await draftReply({ email: email(STEVIE_APP), classification: 'acc_request', propertyId: 'p1', contactName: 'Stevie', communityName: 'Still Creek Ranch', persona: 'annie' });
  assert.ok(!/30 days before/.test(d.body)); assert.equal(d.careful, true);
  assert.ok(d.warnings.some((w) => /not supported by this community's documents/.test(w)));
});
check('real drafter, Karen (ACC, no verified form): told no form is attached, offer to send it; a false "attached" is flagged', async () => {
  modelBody = "Hi Karen,\n\nYes, painting your front door a different color needs approval from the committee first.\n\nI've attached the application form for you.";
  DOCS.text = 'nor shall any exterior addition to or change or alteration therein be made (including, without limitation, painting or staining of any exterior surface a different color than the one previously approved), unless and until two (2) copies of the plans and specifications ... have been submitted to and approved in writing by the Lakes of Pine Forest ARC.';
  const d = await draftReply({ email: email('I would like to paint my front door black. I wanted to know if I have to fill out a request form.'), classification: 'acc_request', propertyId: 'p1', contactName: 'Karen', communityName: 'Lakes of Pine Forest', persona: 'annie', arcFormUnavailable: true });
  assert.ok(/NO APPLICATION FORM IS ATTACHED/.test(lastCtx) && /no verified form on file/.test(lastCtx) && /our team will send them the current application form/.test(lastCtx));
  assert.equal(d.careful, true); assert.ok(d.warnings.some((w) => /says something is attached, but no form is attached/.test(w)));
  assert.ok(/needs approval/.test(d.body), 'the informational answer is never blocked by the missing form');
});

// ---- 6. the form shown is the form sent ----
check('ingest and re-draft stage the form the draft was told about; no display-only "auto" chip remains', () => {
  const fs = require('fs'); const p = (f) => fs.readFileSync(require('path').join(__dirname, '..', f), 'utf8');
  const ingest = p('lib/email/graph_ingest.js'); const triage = p('api/email_triage.js'); const ui = p('public/communications.html');
  assert.ok(/arcFormTitle: _accArcForm \? _accArcForm\.title : undefined, arcFormUnavailable: _accFormUnavailable/.test(ingest), 'ingest tells the drafter the truth');
  assert.ok(/if \(draft && _accArcForm && res\.community_id/.test(ingest), 'ingest stages only the form the draft was told about');
  assert.ok(!/autoAttachments\.push/.test(triage), 're-draft no longer returns a chip that is never sent');
  assert.ok(/stageArcFormAttachment\(communityId\)/.test(triage) && /draft: \{ \.\.\.\(ex0\.draft \|\| \{\}\), attachments \}/.test(triage), 're-draft stores the staged form on the draft Send attaches');
  assert.ok(/if \(opts && opts\.restore\) genAttsByMsg\[id\] = Array\.isArray\(genAtts\) \? genAtts : \[\];/.test(ui), 'the card shows the stored attachments');
  assert.ok(/routeAccQuestion\(webInq, ex\.classification\)/.test(ingest), 'ingest applies the website ACC routing');
});

(async () => {
  for (const p of pending) await p();
  console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ''}`);
  process.exitCode = fail ? 1 : 0;
})();
