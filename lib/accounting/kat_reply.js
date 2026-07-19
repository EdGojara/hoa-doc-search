// ============================================================================
// lib/accounting/kat_reply.js  (Ed 2026-07-19)
// ----------------------------------------------------------------------------
// Katherine "Kat" Reed — the Accounting Manager's inbound handler. A manager
// (or Ed) emails kat@ ("Kat, where do the Lakes of Pine Forest books stand?"
// or "reconcile / close Waterview for the month") -> Kat identifies the
// community, runs the reconciliation dashboard over live trustEd data (TB
// balance, AR subledger tie, bank rec, budget), and drafts a REPLY-FIRST
// status: here's what's clean, here are the exceptions. Reply-first keeps a
// human in the loop; the draft is queued for review like every other agent
// (outbound stays manual). Kat REPORTS and RECOMMENDS — she never posts,
// forgives a balance, or moves money; every dollar change is a human decision.
// ============================================================================
const { reconciliationStatus, money } = require('./reconciliation_status');

const ACCT_INTENT = /\b(reconcil|close|month[-\s]?end|tie[-\s]?out|trial balance|balance sheet|financ|budget|books?|statement|aging|subledger|where.*stand)\b/i;

function katSignoff() {
  return '\n\nReply and I\'ll go deeper on any line, or loop in the team if you want a person on it.';
}

async function matchCommunity(text, supabase) {
  const { data: comms } = await supabase.from('communities').select('id, name');
  const low = String(text || '').toLowerCase();
  const sorted = (comms || []).slice().sort((a, b) => b.name.length - a.name.length);   // longest first
  for (const c of sorted) { const n = String(c.name || '').toLowerCase(); if (n && low.includes(n)) return c; }
  for (const c of sorted) {
    const toks = String(c.name || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !['the', 'of', 'at', 'and', 'lakes', 'estates'].includes(w));
    if (toks.length >= 1 && toks.every((t) => low.includes(t))) return c;
  }
  return null;
}

function statusLine(label, ok, detail) {
  return `  ${ok ? '✓' : '⚠'} ${label}${detail ? ` — ${detail}` : ''}`;
}

async function draftKatReply({ email, supabase }) {
  const text = [email.subject, email.body, email.body_preview].filter(Boolean).join('\n');
  const senderName = (String(email.sender_name || '').trim().split(/\s+/)[0]) || 'there';
  const isAccounting = ACCT_INTENT.test(text);
  const community = await matchCommunity(text, supabase);

  // Not an accounting request and no community named -> let the generic path handle it.
  if (!isAccounting && !community) return { draftable: false };

  if (!community) {
    return {
      draftable: true, careful: true,
      subject: `Re: ${email.subject || 'accounting'}`,
      body: `Hi ${senderName},\n\nHappy to pull that together — which community should I run the numbers for? Once I know, I'll tie out the GL, AR, bank rec, and budget and send you where it stands.${katSignoff()}`,
      review_hint: 'Kat: accounting request, community not identified',
    };
  }

  let st;
  try { st = await reconciliationStatus(supabase, community.id); }
  catch (e) {
    return { draftable: true, careful: true, subject: `Re: ${email.subject || community.name}`,
      body: `Hi ${senderName},\n\nI started reconciling ${community.name} and hit a problem I don't want to report around, so I've flagged it for the team rather than send you numbers I'm not sure of.${katSignoff()}` };
  }

  const lines = [
    statusLine('Trial balance', st.tb.ok, st.tb.ok ? `balances (${money(st.tb.debits)})` : `OUT by ${money(st.tb.diff)}`),
    statusLine('AR subledger', st.ar.ok, st.ar.ok ? `ties to GL (${money(st.ar.subledger)})` : `off ${money(st.ar.diff)} vs GL`),
    statusLine('Bank reconciliation', st.bank.ok, st.bank.ok ? `all accounts reconciled${st.bank.through ? ` through ${st.bank.through}` : ''}` : (st.bank.accounts.length ? 'incomplete' : 'none on file')),
    statusLine('Budget', st.budget.ok, st.budget.ok ? `FY${st.budget.fiscal_year} loaded (${st.budget.lines} lines)` : `no FY${st.budget.fiscal_year} budget`),
  ].join('\n');

  const body = `Hi ${senderName},\n\n`
    + `Here's where ${community.name}'s books stand:\n\n${lines}\n\n`
    + (st.all_clean
      ? `Everything ties — the books are clean and ready to close.\n`
      : `Open items to clear before close:\n${st.exceptions.map((x) => `  • ${x}`).join('\n')}\n`)
    + `\nWant me to go deeper on any of these, or draft the close package?`
    + katSignoff();

  return {
    draftable: true, careful: true,
    subject: `${community.name} — books ${st.all_clean ? 'clean' : `${st.exceptions.length} open item${st.exceptions.length === 1 ? '' : 's'}`}`,
    body,
    review_hint: `Kat reconciliation: ${st.all_clean ? 'CLEAN' : `${st.exceptions.length} exception(s)`}`,
  };
}

module.exports = { draftKatReply };
