#!/usr/bin/env node
// ============================================================================
// scripts/staff_reply_dry_run.js  (PR #225) — READ-ONLY report, never writes.
// ----------------------------------------------------------------------------
// Runs the Answered-by-Staff engine against the live shared mailboxes and the
// stored email_messages rows, and PRINTS what a Pull inbox would mark: answered
// (with the AI draft it would supersede) or Needs Review. The store here only
// records decisions; nothing is updated, moved, sent or deleted.
//
//   node scripts/staff_reply_dry_run.js [--days 21] [--mailbox info@bedrocktx.com]
// Needs SUPABASE_URL / SUPABASE_KEY and GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET.
// ============================================================================
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const days = Number(arg('--days', 21));
const { createClient } = require('@supabase/supabase-js');
const gs = require('../lib/email/graph_send');
const SR = require('../lib/email/staff_reply');

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const mailboxes = arg('--mailbox') ? [arg('--mailbox')] : SR.staffReplyMailboxes();
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const decisions = [];
  const readOnlyStore = {
    async inboundInConversation(mailbox, cid) {
      const { data, error } = await supabase.from('email_messages')
        .select('id, mailbox, conversation_id, internet_message_id, sender_email, sender_name, subject, body_full, body_preview, received_at, triage_status, persona, extracted')
        .eq('mailbox', mailbox).eq('conversation_id', cid).eq('direction', 'inbound').order('received_at', { ascending: true }).limit(50);
      if (error) throw new Error(error.message);
      return data || [];
    },
    async markAnswered(row, ev) { decisions.push({ kind: 'ANSWERED', row, ev }); },
    async markReview(row, ev) { decisions.push({ kind: 'NEEDS REVIEW', row, ev }); },
  };
  const svc = SR.createStaffReplyService({ graphGet: SR.graphGetFromToken(gs.getToken), store: readOnlyStore });
  for (const mb of mailboxes) {
    let replies;
    try { replies = await svc.listSentReplies(mb, since); }
    catch (e) { console.log(`${mb}: Sent Items not readable (${e.status || ''} ${e.message.slice(0, 120)})`); continue; }
    const st = await svc.reconcileStored(mb, replies);
    console.log(`${mb}: ${replies.length} replies sent since ${since.slice(0, 10)}; would mark answered ${st.answered}, needs review ${st.review}, unchanged ${st.unchanged}, errors ${st.errors.length}`);
  }
  const ct = (t) => new Date(t).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  for (const d of decisions) {
    const r = d.row, dr = r.extracted && r.extracted.draft;
    console.log(`\n${d.kind}  inbound ${r.id}  (${r.mailbox})`);
    console.log(`  received ${ct(r.received_at)} from ${r.sender_email} | "${String(r.subject || '').slice(0, 70)}" | now ${r.triage_status}, owner ${r.persona}`);
    if (d.kind === 'ANSWERED') console.log(`  staff reply sent ${ct(d.ev.sent_at)} to ${d.ev.to.join(', ')} | proof: journal In-Reply-To`);
    else console.log(`  reasons: ${(d.ev.reasons || []).join(', ')}`);
    console.log(`  AI draft: ${dr ? `${dr.status || 'pending'} -> ${d.kind === 'ANSWERED' ? 'would be flagged superseded_by_staff (text kept)' : 'would get a "may already be answered" hint'}` : 'none'}`);
  }
  console.log('\nREAD-ONLY: nothing was written.');
})().catch((e) => { console.error('dry run failed:', e.message); process.exit(1); });
