// ============================================================================
// lib/authorization/legal_reversals.js  (Ed 2026-11-27, migration 585)
// ----------------------------------------------------------------------------
// The Owner Authorization Service for reversing posted legal bill-backs
// (legal_invoice_postings, migration 508). Kat prepares the reversal; Tessa sends
// the owner ONE request listing each posting (property, amount, the owner charge's
// description, the stated reason, the owner balance before and after, the GL
// effect). The owner replies "approved"; Kat executes each reversal through the
// module's own path, lib/legal/treatment.js reversePosting (reversing journal
// entry or direct correction, the offsetting owner credit, the legal review audit
// event), only if the posting is exactly what the owner saw (the database
// fingerprint, legal_posting_reversal_sha256). Nothing here writes an entry or a
// ledger row itself, and the owner-only in-app reverse button is unchanged.
// ============================================================================
const crypto = require('crypto');

const AGENT_ID = 'ai-team:kat';
const SCOPE = 'legal_posting_reversals';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const must = async (q, w) => { const { data, error } = await q; if (error) throw new Error(`${w}: ${error.message}`); return data; };
const usd = (c) => (Number(c) < 0 ? '-' : '') + '$' + (Math.abs(Number(c)) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// The GL effect the module will post, from the stored entry (never a re-plan).
// Direct-to-receivable postings (credit account 2000 / 20100, mig 508) are corrected
// with Dr the invoice line's expense / Cr 1300; the rest by reversing the bill-back entry.
async function glEffect(supabase, row) {
  const credit = await must(supabase.from('chart_of_accounts').select('account_number, account_name').eq('id', row.credit_account_id).maybeSingle(), 'credit account');
  const direct = !!credit && /^(2000|20100)$/.test(String(credit.account_number));
  if (direct) {
    const debit = await must(supabase.from('chart_of_accounts').select('account_number, account_name').eq('id', row.debit_account_id).maybeSingle(), 'debit account');
    return { method: 'direct_correction', lines: [
      { account: 'the invoice line\'s legal expense account', debit_cents: Number(row.amount_cents), credit_cents: 0 },
      { account: debit ? `${debit.account_number} ${debit.account_name}` : 'the owner receivable', debit_cents: 0, credit_cents: Number(row.amount_cents), property: true }] };
  }
  const lines = await must(supabase.from('journal_entry_lines').select('debit_cents, credit_cents, property_id, chart_of_accounts(account_number, account_name)').eq('journal_entry_id', row.journal_entry_id).limit(50), 'bill-back entry lines');
  return { method: 'reversing_entry', lines: (lines || []).map((l) => ({ account: l.chart_of_accounts ? `${l.chart_of_accounts.account_number} ${l.chart_of_accounts.account_name}` : 'account', debit_cents: Number(l.credit_cents || 0), credit_cents: Number(l.debit_cents || 0), property: !!l.property_id })) };
}

// Every posting verified exactly as the request would show it.
// requests = [{ posting_id, reason, reversal_date?, expect: { amount_cents?, address?, description? } }]
async function buildPackage(supabase, requests) {
  const postings = []; const problems = [];
  for (const rq of requests || []) {
    const pr = [];
    const id = rq && rq.posting_id;
    const row = await must(supabase.from('legal_invoice_postings').select('*, properties(street_address)').eq('id', id).maybeSingle(), 'posting');
    if (!row) { problems.push({ posting_id: id, problems: ['not a legal posting'] }); continue; }
    const why = String((rq && rq.reason) || '').trim();
    if (why.length < 5) pr.push('state why it is being reversed');
    if (why.length > 1000) pr.push('the reason is over 1000 characters');
    const reversalDate = rq.reversal_date || null;
    if (reversalDate && !DATE.test(reversalDate)) pr.push('the reversal date must be YYYY-MM-DD');
    if (reversalDate && reversalDate < String(row.posting_date)) pr.push(`a reversal cannot be dated before the posting (${row.posting_date})`);
    if (row.status !== 'posted') pr.push(`it is ${row.status}, not posted`);
    if (row.reversal_journal_entry_id || row.reversal_homeowner_transaction_id || row.reversed_at) pr.push('it has already been reversed');
    const address = row.properties && row.properties.street_address;
    const je = row.journal_entry_id ? await must(supabase.from('journal_entries').select('id, status, reference, posting_date, description').eq('id', row.journal_entry_id).maybeSingle(), 'bill-back entry') : null;
    if (!je) pr.push('its bill-back entry was not found');
    else if (je.status !== 'posted') pr.push(`its bill-back entry is ${je.status}`);
    let charge = null;
    if (row.kind === 'homeowner_chargeback') {
      charge = row.homeowner_transaction_id ? await must(supabase.from('homeowner_transactions').select('id, transaction_date, description, amount_cents, tenure_id').eq('id', row.homeowner_transaction_id).maybeSingle(), 'owner charge') : null;
      if (!charge) pr.push('its owner charge was not found');
      else if (Number(charge.amount_cents) !== Number(row.amount_cents)) pr.push(`the owner charge is ${usd(charge.amount_cents)}, the posting ${usd(row.amount_cents)}`);
      const done = await must(supabase.from('homeowner_transactions').select('id').eq('community_id', row.community_id).eq('raw_row_jsonb->>reverses_legal_posting_id', row.id).limit(1), 'owner correction lookup');
      if (done && done.length) pr.push('an owner credit reversing it already exists');
    }
    // The module credits the property's CURRENT owner account: refuse when that is not the account charged.
    let balance = null;
    if (row.property_id) {
      const b = await must(supabase.from('v_current_owner_balance').select('tenure_id, balance_cents').eq('property_id', row.property_id).limit(2), 'owner balance');
      balance = b && b[0] ? b[0] : null;
      if (row.kind === 'homeowner_chargeback' && (!balance || balance.tenure_id !== row.tenure_id)) pr.push('the owner charged is no longer the current owner; the credit would land on another account');
    }
    const expect = (rq && rq.expect) || {};
    if (expect.amount_cents != null && Number(expect.amount_cents) !== Number(row.amount_cents)) pr.push(`expected ${usd(expect.amount_cents)}, the posting is ${usd(row.amount_cents)}`);
    if (expect.address && !norm(address).includes(norm(expect.address))) pr.push(`expected ${expect.address}, the posting is at ${address || 'no property'}`);
    if (expect.description && !norm(charge && charge.description).includes(norm(expect.description))) pr.push(`expected the charge "${expect.description}", it reads "${charge ? charge.description : ''}"`);
    let closedThrough = null;
    try { const { data, error } = await supabase.rpc('close_closed_through', { p_community: row.community_id }); if (!error && data) closedThrough = String(data).slice(0, 10); } catch (_) { /* before the close module: none */ }
    const effDate = reversalDate || today();
    if (closedThrough && effDate <= closedThrough) pr.push(`the reversal date ${effDate} is in a closed period (closed through ${closedThrough})`);
    let gl = null;
    try { gl = await glEffect(supabase, row); } catch (e) { pr.push(`cannot preview the GL effect: ${e.message}`); }
    const before = balance ? Number(balance.balance_cents) : null;
    if (pr.length) problems.push({ posting_id: row.id, address, amount_cents: row.amount_cents, problems: pr });
    postings.push({ posting: row, address, charge, entry: je, gl, reason: why, reversal_date: reversalDate, effective_date: effDate,
      balance_before_cents: before, balance_after_cents: before == null ? null : before - (row.kind === 'homeowner_chargeback' ? Number(row.amount_cents) : 0) });
  }
  if (!requests || !requests.length) problems.push({ posting_id: null, problems: ['list at least one posting'] });
  return { ok: !problems.length, problems, postings };
}

function requestSubject(code, postings) {
  const total = postings.reduce((t, p) => t + Number(p.posting.amount_cents), 0);
  return `Owner authorization ${code}: reverse ${postings.length} legal bill-back${postings.length === 1 ? '' : 's'} (${usd(total)})`;
}

// PURE: Tessa's request email. Plain language, no em dashes.
function renderRequest({ subject, postings, communityName, expiresAt }) {
  const blocks = postings.map((p, i) => {
    const r = p.posting;
    const gl = (p.gl && p.gl.lines || []).map((l) => `   ${l.debit_cents ? 'Dr' : 'Cr'} ${l.account}${l.property ? ' (this property)' : ''}: ${usd(l.debit_cents || l.credit_cents)}`);
    return [
      `${i + 1}. ${p.address || 'no property'}: ${usd(r.amount_cents)} legal bill-back posted ${r.posting_date}`,
      `   Owner charge: ${p.charge ? `"${p.charge.description}" dated ${p.charge.transaction_date}` : 'none (Bedrock recovery)'}`,
      `   Why: ${p.reason}`,
      ...(p.balance_before_cents == null ? [] : [`   Homeowner balance: ${usd(p.balance_before_cents)} before, ${usd(p.balance_after_cents)} after`]),
      `   GL effect, dated ${p.effective_date}${p.gl && p.gl.method === 'direct_correction' ? ' (correction entry)' : ' (reversing entry)'}:`, ...gl,
      `   Posting ${r.id}`,
    ].join('\n');
  });
  const intro = `Kat has prepared ${postings.length === 1 ? 'a reversal' : `${postings.length} reversals`} of a legal bill-back in ${communityName}. Each charged a homeowner for attorney fees that should not stand, so the charge comes off the homeowner's account and the cost returns to the association's legal expense. The original entries stay on the books with the reversal next to them.`;
  const how = `Reply "approved" to authorize exactly these reversals. Kat posts each one through Legal Invoice Review (the same reversal as the Reverse button: a reversing entry plus an offsetting credit on the owner's account, with the reason on the audit trail), attributed to you, and reports back. If a posting changes before then, it is not reversed. No money moves and nothing is refunded. Reply anything else (or nothing) and nothing happens. This request expires ${expiresAt}.`;
  const text = ['Ed,', '', intro, '', how, '', ...blocks, '', 'Tessa'].join('\n');
  const html = `<p>Ed,</p><p>${esc(intro)}</p><p>${esc(how)}</p><pre style="font-family:Consolas,monospace;font-size:12px;white-space:pre-wrap">${esc(blocks.join('\n\n'))}</pre><p>Tessa</p>`;
  return { subject, text, html };
}

async function requestAuthorization({ supabase, rpc, send, requests, ownerEmail, fromMailbox, summary, hours = 72 }) {
  const pkg = await buildPackage(supabase, requests);
  if (!pkg.ok) throw Object.assign(new Error('not requested; fix first: ' + pkg.problems.map((p) => `${p.address || p.posting_id} ${p.problems.join('; ')}`).join(' | ')), { code: 'verification_failed', problems: pkg.problems });
  const ids = pkg.postings.map((p) => p.posting.id);
  const open = await must(supabase.from('owner_authorizations').select('id, subject, items').eq('scope', SCOPE).in('status', ['requested', 'authorized']).limit(50), 'open requests');
  const dup = (open || []).find((a) => (a.items || []).some((i) => ids.includes(i.posting_id)));
  if (dup) throw Object.assign(new Error(`an open request already covers these postings: ${dup.subject}`), { code: 'duplicate_request' });
  const cids = [...new Set(pkg.postings.map((p) => p.posting.community_id))];
  const comms = await must(supabase.from('communities').select('id, name').in('id', cids), 'communities');
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  const subject = requestSubject(code, pkg.postings);
  const r = await rpc('owner_authorization_request_legal_reversals', { p_subject: subject, p_summary: summary,
    p_postings: pkg.postings.map((p) => ({ posting_id: p.posting.id, reason: p.reason, reversal_date: p.reversal_date })), p_owner_email: ownerEmail, p_requested_by: AGENT_ID, p_hours: hours });
  const expiresAt = new Date(Date.now() + hours * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const mail = renderRequest({ subject, postings: pkg.postings, communityName: (comms || []).map((c) => c.name).join(', '), expiresAt });
  const sent = await send({ from: fromMailbox, to: ownerEmail, subject: mail.subject, text: mail.text, html: mail.html });
  if (!sent || !sent.internetMessageId || !sent.conversationId) throw new Error('the request email was not sent with a message identity; nothing can authorize it');
  await rpc('owner_authorization_sent', { p_id: r.id, p_message_id: sent.internetMessageId, p_conversation_id: sent.conversationId });
  const AZ = require('./index');
  await AZ.recordEvents(supabase, (r.items || []).flatMap((i) => ['requested', 'sent'].map((event) => ({ community_id: i.community_id, authority_kind: 'request', authorization_id: r.id,
    action_type: 'legal_posting_reversal', target_id: i.posting_id, fingerprint: i.fingerprint, event, channel: 'email', requested_by: AGENT_ID,
    evidence: event === 'sent' ? { subject, request_message_id: sent.internetMessageId, conversation_id: sent.conversationId } : { summary, reason: i.reason, amount_cents: i.amount_cents } }))));
  return { id: r.id, subject, postings: pkg.postings.length, items_sha256: r.items_sha256 };
}

// Execute an AUTHORIZED request: each posting through reversePosting, only if unchanged.
async function executeAuthorized(ctx, authorization) {
  const { supabase } = ctx;
  if (!authorization || authorization.status !== 'authorized' || authorization.scope !== SCOPE || !authorization.authorized_by_email) throw Object.assign(new Error('no authorized legal posting reversal'), { code: 'approval_required' });
  const reverse = ctx.reversePosting || require('../legal/treatment').reversePosting;
  const actor = `${authorization.authorized_by_email} (owner, authorized by email reply, owner authorization ${authorization.id}; executed by Kat)`;
  const results = [];
  for (const item of authorization.items || []) {
    const res = { posting_id: item.posting_id, amount_cents: item.amount_cents, property_id: item.property_id };
    try {
      const { data: fp, error } = await supabase.rpc('legal_posting_reversal_sha256', { p_posting_id: item.posting_id });
      if (error) throw new Error(error.message);
      if (!fp || fp !== item.fingerprint) throw new Error('the posting changed after the owner authorized it; not reversed');
      const out = await reverse(supabase, item.posting_id, { actor, actorUserId: authorization.authorized_by_user_id || null, reason: item.reason, reversalDate: item.reversal_date || undefined });
      res.ok = !!(out && out.ok);
      if (res.ok) Object.assign(res, { reversal_journal_entry_id: out.reversal_journal_entry_id, reversal_homeowner_transaction_id: out.reversal_homeowner_transaction_id });
      else res.error = (out && (out.detail || out.error)) || 'not reversed';
      if (res.ok && item.property_id) {
        try { const b = await must(supabase.from('v_current_owner_balance').select('balance_cents').eq('property_id', item.property_id).limit(1), 'balance'); res.balance_after_cents = b && b[0] ? Number(b[0].balance_cents) : null; } catch (_) { /* reported without it */ }
      }
    } catch (e) { res.ok = false; res.error = e.message; }
    results.push(res);
  }
  const failed = results.filter((r) => !r.ok).length;
  if (results.some((r) => r.ok)) {
    try { (ctx.resumeAfter || require('../onboarding/resume').resumeAfter)({ reason: 'legal posting reversed' }); } catch (e) { console.warn('[legal_reversals] conversion resume not started:', e.message); }
  }
  if (!failed && ctx.rpc) await ctx.rpc('owner_authorization_mark_executed', { p_id: authorization.id, p_execution: { reversed: results.length, results, executed_by: AGENT_ID } });
  return { ok: !failed, reversed: results.length - failed, failed, results };
}

function renderCompletion(authorization, out) {
  const byId = new Map((authorization.items || []).map((i) => [i.posting_id, i]));
  const lines = out.results.map((r) => { const i = byId.get(r.posting_id) || {};
    return `- ${usd(r.amount_cents)} legal bill-back (posting ${String(r.posting_id).slice(0, 8)}): ${r.ok ? `reversed (entry ${String(r.reversal_journal_entry_id || '').slice(0, 8)}${r.reversal_homeowner_transaction_id ? `, owner credit ${String(r.reversal_homeowner_transaction_id).slice(0, 8)}` : ''})${r.balance_after_cents != null ? `; homeowner balance now ${usd(r.balance_after_cents)}` : ''}. Reason: ${i.reason || ''}` : 'NOT reversed: ' + r.error}`; });
  const text = ['Ed,', '', `Kat carried out your authorization ${String(authorization.id).slice(0, 8)}: ${out.reversed} legal bill-back${out.reversed === 1 ? '' : 's'} reversed, ${out.failed} not.`, '', ...lines, '',
    'The originals stay on the books with each reversal beside them, and the reason is on the Legal Invoice Review audit trail. No money moved.', '', 'Tessa'].join('\n');
  return { subject: `Done: ${authorization.subject}`, text, html: `<pre style="font-family:Consolas,monospace;font-size:12px;white-space:pre-wrap">${esc(text)}</pre>` };
}

module.exports = { AGENT_ID, SCOPE, buildPackage, glEffect, requestSubject, renderRequest, requestAuthorization, executeAuthorized, renderCompletion };
