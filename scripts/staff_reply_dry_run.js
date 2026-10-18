#!/usr/bin/env node
// ============================================================================
// scripts/staff_reply_dry_run.js  (PR #225) — READ-ONLY report, never writes.
// ----------------------------------------------------------------------------
// Runs the Answered-by-Staff reconcile against the live shared mailboxes and the
// stored email_messages rows using the SAME store the Pull uses, in planning mode
// (supabaseStore { dryRun: true }): every line printed is exactly the change a
// Pull inbox would make, and nothing is updated, moved, sent or deleted.
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
  const store = SR.supabaseStore(supabase, { dryRun: true });
  const svc = SR.createStaffReplyService({ graphGet: SR.graphGetFromToken(gs.getToken), store });
  const changes = [];
  for (const mb of mailboxes) {
    let replies;
    try { replies = await svc.listSentReplies(mb, since); }
    catch (e) { console.log(`${mb}: Sent Items not readable (${e.code || e.status || ''} ${String(e.message).slice(0, 120)})`); continue; }
    const st = await svc.reconcileStored(mb, replies);
    console.log(`${mb}: ${replies.length} replies sent since ${since.slice(0, 10)}; would change ${st.changes.length} row(s): answered ${st.answered}, needs review ${st.review}, evidence noted ${st.noted}; unchanged ${st.unchanged}, dismissed/spam untouched ${st.skipped_closed}, errors ${st.errors.length}`);
    for (const e of st.errors) console.log('  error:', JSON.stringify(e));
    changes.push(...st.changes.map((c) => ({ ...c, mailbox: mb })));
  }
  const ids = changes.map((c) => c.id).filter(Boolean);
  const meta = new Map();
  if (ids.length) {
    const { data, error } = await supabase.from('email_messages').select('id, sender_email, subject, received_at, persona').in('id', ids);
    if (error) throw new Error(error.message);
    for (const r of data || []) meta.set(r.id, r);
  }
  const ct = (t) => new Date(t).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  for (const c of changes) {
    const r = meta.get(c.id) || {};
    console.log(`\n${String(c.action).toUpperCase()}  inbound ${c.id}  (${c.mailbox})`);
    console.log(`  received ${r.received_at ? ct(r.received_at) : '?'} from ${r.sender_email || '?'} | "${String(r.subject || '').slice(0, 70)}" | owner ${r.persona || '?'}`);
    console.log(`  status: ${c.from_status} -> ${c.to_status}${c.staff_reply_sent_at ? ` | staff reply sent ${ct(c.staff_reply_sent_at)}` : ''}${c.reasons ? ` | reasons: ${c.reasons.join(', ')}` : ''}`);
    console.log(`  AI draft: ${c.draft}`);
  }
  console.log('\nREAD-ONLY: nothing was written.');
})().catch((e) => { console.error('dry run failed:', e.message); process.exit(1); });
