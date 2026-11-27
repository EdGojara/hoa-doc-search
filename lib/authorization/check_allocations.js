// ============================================================================
// lib/authorization/check_allocations.js  (Ed 2026-11-28, migration 584)
// ----------------------------------------------------------------------------
// The Owner Authorization Service for recording split checks: Tessa sends the owner ONE
// request listing each prepared check, its allocation lines (owner account, funding party,
// purpose, amount, basis) and how each account's share applies. The owner replies
// "approved"; Kat records each check through Check Receipts (lib/payments/check_receipts
// recordReceipt, the ordinary once-only recording path) only if its allocation is exactly
// what the owner saw (the database fingerprint). Recording never deposits, refunds or moves
// money: cash moves when the bank deposit is recorded.
// ============================================================================
const crypto = require('crypto');
const CR = require('../payments/check_receipts');

const AGENT_ID = 'ai-team:kat';
const must = async (q, w) => { const { data, error } = await q; if (error) throw new Error(`${w}: ${error.message}`); return data; };
const usd = (c) => (Number(c) < 0 ? '-' : '') + '$' + (Math.abs(Number(c)) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PARTY = { seller: 'seller', buyer: 'buyer', payer: 'payer', third_party: 'third party', unknown: 'unknown' };
const PURPOSE = { assessment: 'assessment', capitalization_fee: 'capitalization fee', other: 'other charge', excess: 'excess, stays as credit', held: 'held' };

// Every receipt verified exactly as the request would show it.
async function buildPackage(supabase, receiptIds) {
  const checks = []; const problems = [];
  for (const id of receiptIds) {
    const rc = await must(supabase.from('homeowner_check_receipts').select('*, properties(street_address)').eq('id', id).single(), 'receipt');
    const lines = await CR.describeAllocation(supabase, await CR.allocationLines(supabase, id, ['prepared']));
    const pr = [];
    if (rc.status !== 'matched') pr.push(`status is ${rc.status}, not matched`);
    if (lines.length < 2) pr.push('no split allocation is prepared');
    const total = lines.reduce((t, l) => t + Number(l.amount_cents), 0);
    if (lines.length && total !== Number(rc.amount_cents)) pr.push(`lines total ${usd(total)}, check is ${usd(rc.amount_cents)}`);
    let preview = null;
    try { preview = await CR.previewRecording(supabase, id); } catch (e) { pr.push(`cannot preview: ${e.message}`); }
    const dupes = await CR.findDuplicates(supabase, rc);
    if (dupes.some((d) => d.severity === 'blocking')) pr.push(dupes.filter((d) => d.severity === 'blocking').map((d) => d.detail).join(' '));
    // A possible duplicate needs a staff reason before it records (recordReceipt); settle it before asking the owner.
    if (dupes.some((d) => d.severity === 'possible') && !String(rc.override_note || '').trim()) pr.push('possible duplicate without a recorded reason: ' + dupes.filter((d) => d.severity === 'possible').map((d) => d.detail).join(' '));
    if (pr.length) problems.push({ receipt_id: id, check_number: rc.check_number, problems: pr });
    checks.push({ receipt: rc, lines, preview, address: rc.properties && rc.properties.street_address });
  }
  return { ok: !problems.length, problems, checks };
}

function requestSubject(code, checks) {
  const total = checks.reduce((t, c) => t + Number(c.receipt.amount_cents), 0);
  return `Owner authorization ${code}: record ${checks.length} split check${checks.length === 1 ? '' : 's'} (${usd(total)})`;
}

// PURE: Tessa's request email.
function renderRequest({ subject, checks, communityName, expiresAt }) {
  const blocks = checks.map((c, i) => {
    const r = c.receipt; const p = c.preview || {};
    const lines = c.lines.map((l) => `   ${l.line_no}. ${l.kind === 'held' ? 'HELD in Unidentified Receipts (funding party not established)' : `${l.address}, ${l.tenure_label || 'owner account'}`}: ${usd(l.amount_cents)}, funded by ${PARTY[l.funding_party] || l.funding_party}, for ${PURPOSE[l.purpose] || l.purpose}. Basis: ${l.basis}`);
    const applies = (p.accounts || []).map((a) => `   ${a.funding_parties} share ${usd(a.amount_cents)}: applied ${usd(a.applied_cents)}${a.unapplied_cents ? `, unapplied credit ${usd(a.unapplied_cents)} on that account` : ''}`);
    return [`${i + 1}. ${c.address || ''} check #${r.check_number}, ${usd(r.amount_cents)}, dated ${r.check_date}${r.payer_name ? `, from ${r.payer_name}` : ''}`, ...lines, '   How it applies (Tex. Prop. Code 209.0063):', ...applies, ...(p.held_cents ? [`   Held: ${usd(p.held_cents)}`] : [])].join('\n');
  });
  const intro = `${checks.length} closing check${checks.length === 1 ? ' is' : 's are'} ready to record in ${communityName} Check Receipts. Each stays one check (one number, one amount, one deposit) split by its settlement statement between the accounts that funded it. Excess stays as an unapplied credit on the funding party's own account; nothing is refunded. Previously billed charges are unchanged.`;
  const how = `Reply "approved" to authorize recording exactly these checks and allocations. Kat records each through Check Receipts (Dr Undeposited Funds / Cr Accounts Receivable per account) and reports back. If an allocation changes before then, that check is not recorded. Recording does not deposit or move money: the bank deposit is recorded separately when the bank confirms it. Reply anything else (or nothing) and nothing happens. This request expires ${expiresAt}.`;
  const text = ['Ed,', '', intro, '', how, '', ...blocks, '', 'Tessa'].join('\n');
  const html = `<p>Ed,</p><p>${esc(intro)}</p><p>${esc(how)}</p><pre style="font-family:Consolas,monospace;font-size:12px;white-space:pre-wrap">${esc(blocks.join('\n\n'))}</pre><p>Tessa</p>`;
  return { subject, text, html };
}

async function requestAuthorization({ supabase, rpc, send, receiptIds, ownerEmail, fromMailbox, summary, hours = 72 }) {
  const pkg = await buildPackage(supabase, receiptIds);
  if (!pkg.ok) throw Object.assign(new Error('not requested; fix first: ' + pkg.problems.map((p) => `#${p.check_number} ${p.problems.join('; ')}`).join(' | ')), { code: 'verification_failed', problems: pkg.problems });
  const open = await must(supabase.from('owner_authorizations').select('id, subject, items').eq('scope', 'check_receipt_allocations').in('status', ['requested', 'authorized']).limit(50), 'open requests');
  const dup = open.find((a) => (a.items || []).some((i) => receiptIds.includes(i.receipt_id)));
  if (dup) throw Object.assign(new Error(`an open request already covers these checks: ${dup.subject}`), { code: 'duplicate_request' });
  const cids = [...new Set(pkg.checks.map((c) => c.receipt.community_id))];
  const comms = await must(supabase.from('communities').select('id, name').in('id', cids), 'communities');
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  const subject = requestSubject(code, pkg.checks);
  const r = await rpc('owner_authorization_request_check_allocations', { p_subject: subject, p_summary: summary, p_receipts: receiptIds, p_owner_email: ownerEmail, p_requested_by: 'ai-team:amanda', p_hours: hours });
  const expiresAt = new Date(Date.now() + hours * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const mail = renderRequest({ subject, checks: pkg.checks, communityName: comms.map((c) => c.name).join(', '), expiresAt });
  const sent = await send({ from: fromMailbox, to: ownerEmail, subject: mail.subject, text: mail.text, html: mail.html });
  if (!sent || !sent.internetMessageId || !sent.conversationId) throw new Error('the request email was not sent with a message identity; nothing can authorize it');
  await rpc('owner_authorization_sent', { p_id: r.id, p_message_id: sent.internetMessageId, p_conversation_id: sent.conversationId });
  const AZ = require('./index');
  await AZ.recordEvents(supabase, (r.items || []).flatMap((i) => ['requested', 'sent'].map((event) => ({ community_id: i.community_id, authority_kind: 'request', authorization_id: r.id,
    action_type: 'check_allocation', target_id: i.receipt_id, fingerprint: i.fingerprint, event, channel: 'email', requested_by: 'ai-team:amanda',
    evidence: event === 'sent' ? { subject, request_message_id: sent.internetMessageId, conversation_id: sent.conversationId } : { summary, check_number: i.check_number, amount_cents: i.amount_cents } }))));
  return { id: r.id, subject, checks: pkg.checks.length, items_sha256: r.items_sha256 };
}

// Execute an AUTHORIZED request: each check through recordReceipt, only if unchanged.
async function executeAuthorized(ctx, authorization) {
  const { supabase } = ctx;
  if (authorization.status !== 'authorized' || authorization.scope !== 'check_receipt_allocations' || !authorization.authorized_by_email) throw Object.assign(new Error('no authorized check allocation authorization'), { code: 'approval_required' });
  const record = ctx.recordReceipt || CR.recordReceipt;
  const actor = `${authorization.authorized_by_email} (owner, authorized by email reply, owner authorization ${authorization.id}; executed by Kat)`;
  const results = [];
  for (const item of authorization.items || []) {
    const res = { receipt_id: item.receipt_id, check_number: item.check_number, amount_cents: item.amount_cents };
    try {
      const { data: fp, error } = await supabase.rpc('check_receipt_allocation_sha256', { p_receipt_id: item.receipt_id });
      if (error) throw new Error(error.message);
      if (fp !== item.fingerprint) throw new Error('the allocation changed after the owner authorized it; not recorded');
      const out = await record(supabase, item.receipt_id, { actor });
      res.ok = out.status === 'recorded' || out.status === 'already_recorded';
      Object.assign(res, { status: out.status, journal_reference: out.journal_reference || null, applied_cents: out.applied_cents, unapplied_cents: out.unapplied_cents, held_cents: out.held_cents, accounts: out.accounts });
    } catch (e) { res.ok = false; res.error = e.message; }
    results.push(res);
  }
  const failed = results.filter((r) => !r.ok).length;
  if (!failed && ctx.rpc) await ctx.rpc('owner_authorization_mark_executed', { p_id: authorization.id, p_execution: { recorded: results.length, results, executed_by: AGENT_ID } });
  return { ok: !failed, recorded: results.length - failed, failed, results };
}

function renderCompletion(authorization, out) {
  const lines = out.results.map((r) => `- check #${r.check_number} ${usd(r.amount_cents)}: ${r.ok ? `recorded (${r.journal_reference || r.status}); applied ${usd(r.applied_cents || 0)}${r.unapplied_cents ? `, unapplied credit ${usd(r.unapplied_cents)}` : ''}${r.held_cents ? `, held ${usd(r.held_cents)}` : ''}` : 'NOT recorded: ' + r.error}`);
  const text = ['Ed,', '', `Kat carried out your authorization ${authorization.id.slice(0, 8)}: ${out.recorded} check(s) recorded, ${out.failed} not.`, '', ...lines, '',
    'Recording is not a deposit: each check moves to cash when the bank deposit is recorded. Nothing was refunded.', '', 'Tessa'].join('\n');
  return { subject: `Done: ${authorization.subject}`, text, html: `<pre style="font-family:Consolas,monospace;font-size:12px;white-space:pre-wrap">${esc(text)}</pre>` };
}

module.exports = { AGENT_ID, buildPackage, requestSubject, renderRequest, requestAuthorization, executeAuthorized, renderCompletion };
