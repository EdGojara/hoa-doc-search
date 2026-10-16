#!/usr/bin/env node
// ============================================================================
// scripts/amanda_reply_dry_run.js  (Ed 2026-10-16)
// ----------------------------------------------------------------------------
// Regenerate Amanda's reply to one stored inbound message, LIVE and READ-ONLY:
// the real drafter (lib/community/amanda_reply.js), the real model, production
// reads. Nothing is saved or sent: the Supabase client is wrapped so any
// insert / update / upsert / delete / rpc throws, and no Graph send or draft
// call exists on this path.
//
// It prints what the drafter was given (diagnostic-first: the latest text, the
// audience, the greeting name, the full prompt with --prompt) and the draft,
// then the reply-focus check and, for the Kevin Thoms regression thread, Ed's
// acceptance criteria.
//
//   node scripts/amanda_reply_dry_run.js --message=fa4743bd-eb8f-41b0-b90e-f9f527e4d7aa
//   node scripts/amanda_reply_dry_run.js --message=<id> --prompt     (also print the full prompt)
//   node scripts/amanda_reply_dry_run.js --message=<id> --as-ingest  (drop the row id, as at ingest)
// ============================================================================
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const flag = (k) => process.argv.includes(`--${k}`);

// Read-only guard: every write path throws before it reaches the network.
function readOnly(sb) {
  const BLOCK = new Set(['insert', 'update', 'upsert', 'delete']);
  const wrap = (builder) => new Proxy(builder, {
    get(target, prop) {
      if (BLOCK.has(prop)) return () => { throw new Error(`dry run is read-only: blocked .${String(prop)}()`); };
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return new Proxy(sb, {
    get(target, prop) {
      if (prop === 'from') return (t) => wrap(target.from(t));
      if (prop === 'rpc') return () => { throw new Error('dry run is read-only: blocked .rpc()'); };
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

(async () => {
  const id = arg('message');
  if (!id) { console.error('usage: --message=<email_messages id>'); process.exit(2); }
  const supabase = readOnly(createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY));
  const { data: email, error } = await supabase.from('email_messages').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!email) { console.error(`no email_messages row ${id}`); process.exit(1); }
  let communityName = null;
  if (email.community_id) {
    const { data: c, error: ce } = await supabase.from('communities').select('name').eq('id', email.community_id).maybeSingle();
    if (ce) throw ce;
    communityName = c && c.name;
  }
  const asIngest = flag('as-ingest');
  const input = { ...email };
  if (asIngest) delete input.id;

  const stored = email.extracted && email.extracted.draft;
  console.log(`MESSAGE ${email.id}  ${email.received_at}  from ${email.sender_name} <${email.sender_email}>  "${email.subject}"`);
  console.log(`STORED DRAFT (unchanged): ${stored ? JSON.stringify(stored.body) : '(none)'}`);
  console.log(`STORED review_hint: ${stored ? stored.review_hint : '(none)'}\n`);

  // --path=amanda (default: Amanda's ingest drafter), persona (the inbox re-draft for
  // Kat / Amanda / Reese / Paige), general (Claire and every specialist, the "Draft reply"
  // button). Those two build their own clients; this script never writes through them
  // either (they only read), and nothing here sends.
  const which = arg('path') || 'amanda';
  let d;
  if (which === 'amanda') {
    const { draftAmandaReply } = require('../lib/community/amanda_reply');
    d = await draftAmandaReply({ email: input, supabase, communityId: email.community_id, communityName, contactName: null,
      sourceMessageId: asIngest ? null : email.id, mailbox: email.mailbox, graphId: email.graph_id, diagnostic: true });
  } else {
    const focus = require('../lib/amanda/reply_focus');
    const fctx = await focus.gatherReplyContext(supabase, input, { communityId: email.community_id, contactName: email.sender_name });
    if (which === 'persona') {
      const { draftPersonaReply } = require('../lib/email/persona_reply');
      d = await draftPersonaReply({ persona: email.persona || 'amanda', email: input, context: { communityId: email.community_id, communityName, contactName: email.sender_name } });
    } else {
      const { draftReply } = require('../lib/email/draft_reply');
      d = await draftReply({ email: input, classification: email.classification, communityId: email.community_id, communityName, contactName: email.sender_name, force: true, persona: email.persona || 'claire' });
    }
    d.disposition = d.careful ? 'careful' : 'normal'; d.confidence = '-';
    d.diagnostic = { audience: fctx.audience, sender_first_name: fctx.senderFirstName, latest_text: fctx.latestText, settled_constraints: fctx.settled.map((c) => c.text), prompt: fctx.promptBlock };
    d.focus_issues = d.focus_issues || [];
  }
  console.log(`PATH: ${which}`);

  console.log('WHAT THE DRAFTER SAW');
  console.log(`  audience: ${d.diagnostic.audience}   greeting name: ${d.diagnostic.sender_first_name || '(none)'}`);
  console.log(`  settled constraints: ${(d.diagnostic.settled_constraints || []).map((c) => `"${c}"`).join(' | ') || '(none)'}`);
  console.log(`  latest message:\n${d.diagnostic.latest_text.split('\n').map((l) => '    | ' + l).join('\n')}`);
  if (flag('prompt')) console.log(`\n  FULL PROMPT:\n${d.diagnostic.prompt}`);

  console.log('\nREGENERATED DRAFT (not saved, not sent)\n' + '-'.repeat(60) + `\n${d.body}\n` + '-'.repeat(60));
  console.log(`disposition: ${d.disposition}/${d.confidence}   reply-focus issues: ${d.focus_issues.length ? d.focus_issues.join(', ') : 'none'}`);
  console.log(`review_hint: ${d.review_hint}`);
  if (d.focus_retry) console.log(`corrective retry: ran=${d.focus_retry.retried}; first draft failed on: ${(d.focus_retry.first_issues || []).join(', ') || 'nothing'}${d.focus_retry.retry_error ? `; retry error: ${d.focus_retry.retry_error}` : ''}${d.focus_retry.retry_note ? `\n  retry note:\n${d.focus_retry.retry_note.split('\n').map((l) => '    ' + l).join('\n')}` : ''}`);

  if (/^treasurer@canyongateatcincoranch\.com$/i.test(email.sender_email) && /camera/i.test(email.subject || '')) {
    const { verifyKevinReply } = require('../tests/fixtures/amanda-reply-focus/kevin_expectations');
    const v = verifyKevinReply(d.body);
    console.log('\nACCEPTANCE (Kevin Thoms regression):');
    for (const r of v.results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
    process.exitCode = v.ok && !d.focus_issues.length ? 0 : 1;
  }
  if (/^president@canyongateatcincoranch\.com$/i.test(email.sender_email) && /\bRFP\b/i.test(email.subject || '')) {
    const { verifyHughReply } = require('../tests/fixtures/amanda-reply-focus/hugh_expectations');
    const v = verifyHughReply(d.body);
    console.log('\nACCEPTANCE (Hugh "Create RFP" regression):');
    for (const r of v.results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
    process.exitCode = v.ok && !d.focus_issues.length ? 0 : 1;
  }
})().catch((e) => { console.error('dry run failed:', e.message); process.exit(1); });
