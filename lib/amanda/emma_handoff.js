// ============================================================================
// lib/amanda/emma_handoff.js  (Ed 2026-10-06) — Amanda hands routine payables to Emma
// ----------------------------------------------------------------------------
// When Amanda answers a routine receipt / reimbursement email (a board member
// bought something for the association and sent the receipt), the operational
// follow-through is Emma's: the receipt goes into AP for processing. Amanda's
// acknowledgment still goes through her normal review/send controls; the
// handoff itself is low-risk and can run automatically because it never pays
// anything:
//
//   * It uses Emma's ONE intake door (lib/ap/email_bill_intake.js -> autoIntake),
//     so the receipt is archived, deduped by file and source, and linked to the
//     email. Board-member reimbursements always land awaiting_approval or as a
//     needs_review item; a person reviews and Ed approves before a dollar moves.
//   * Amanda passes her judgment ("this is a board member's reimbursement") as an
//     explicit intent hint. Amount, community and coding are still established
//     by the existing rules: no amount typed in the email means the receipt total
//     is shown as evidence, not assumed; no staff coding instruction means
//     "coding needs review", never an invented account.
//   * One item per receipt: an existing AP invoice or intake item for the same
//     email is found first and nothing new is created.
//   * The email stays open in Amanda's inbox (her reply is still owed).
//
// Scar it closes: the Canyon Gate president sent a $51.05 sign receipt to Amanda.
// Her reply was fixed (PR #64), but nothing put the receipt in front of Emma, so
// processing depended on someone remembering to forward it.
// ============================================================================

const RECEIPT_RE = /\b(receipt|reimburs\w*|out[\s-]?of[\s-]?pocket|i (?:ordered|bought|purchased|paid for)|paid (?:for|on behalf)|expense report|invoice attached)\b/i;
// Not routine, whatever the amount: legal, insurance, contract, dispute or
// authority questions get Amanda's judgment and a person, not automatic intake.
// (Ed 2026-10-06: a $50 legal filing or something clearly unauthorized still matters.)
const NOT_ROUTINE_RE = /\b(attorney|lawyer|legal|lawsuit|court|filing fee|subpoena|insurance claim|claim number|adjuster|contract|retainer|agreement|dispute|chargeback|refund|unauthori[sz]ed|without approval|not approved|fraud)\b/i;

/**
 * Is this inbound a routine, low-risk payable intake Amanda can hand to Emma
 * automatically? Pure and conservative: it needs an attachment, receipt /
 * reimbursement language, a board member or Bedrock staff sender, and none of
 * the not-routine signals.
 */
function isRoutinePayableIntake(m, { boardMember = false } = {}) {
  if (!m || !m.has_attachments) return { ok: false, reason: 'no attachment' };
  const text = `${m.subject || ''}\n${m.body_full || m.body_preview || ''}`;
  const ex = m.extracted || {};
  const wantsProcessing = RECEIPT_RE.test(text) || /receipt|reimburs|invoice/i.test(String(ex.requested_action || ''));
  if (!wantsProcessing) return { ok: false, reason: 'no receipt or reimbursement request' };
  const internal = /@bedrocktx\.com$/i.test(String(m.sender_email || '').trim());
  if (!boardMember && !internal) return { ok: false, reason: 'sender is not a board member or Bedrock staff' };
  const flag = text.match(NOT_ROUTINE_RE);
  if (flag) return { ok: false, reason: `not routine: mentions "${flag[0]}"` };
  return { ok: true, reason: boardMember ? 'board member receipt' : 'staff receipt' };
}

const money = (c) => (c == null ? null : '$' + (c / 100).toFixed(2));

// The store the board member actually paid. Emma's reader names the SELLER
// ("Fastasticdeal"); on a marketplace receipt the useful vendor line is the
// marketplace plus the seller ("Amazon (sold by Fastasticdeal)"). Pure.
const MARKETPLACES = [['Amazon', /\bamazon(?:\.com)?\b/i], ['Walmart', /\bwal-?mart\b/i], ['Target', /\btarget(?:\.com)?\b/i], ['The Home Depot', /\bhome depot\b/i],
  ["Lowe's", /\blowe['\u2019]?s\b/i], ['Costco', /\bcostco\b/i], ["Sam's Club", /\bsam['\u2019]?s club\b/i], ['eBay', /\bebay\b/i]];
function storeLine(receiptText, sellerName) {
  const t = String(receiptText || '');
  const hit = MARKETPLACES.find(([, re]) => re.test(t));
  const soldBy = (t.match(/sold by:?\s*([^\n,]{2,60})/i) || [])[1];
  const seller = String(sellerName || soldBy || '').trim();
  if (hit) return seller && !hit[1].test(seller) ? `${hit[0]} (sold by ${seller})` : hit[0];
  return seller || null;
}
// A receipt line item reads like a product listing; keep it readable. Pure.
function purposeFrom(lines = []) {
  const first = lines.map((l) => String((l && l.description) || '').trim()).find((d) => d && !/^(estimated )?tax|gift card|shipping|subtotal|total/i.test(d));
  if (!first) return null;
  return first.length > 110 ? first.slice(0, 107).replace(/\s+\S*$/, '') + '…' : first;
}

/** Amanda's handoff note for Emma, from the receipt Emma's reader extracted. Pure. */
function handoffSummary({ communityName, senderName, senderRole, senderEmail, extracted = {}, coded = null, receiptText = '' }) {
  const purpose = purposeFrom(extracted.line_items || []);
  const store = storeLine(receiptText, extracted.vendor_name);
  const total = money(extracted.total_cents);
  const bits = [
    `Amanda handoff (routine ${senderRole === 'board' ? 'board member reimbursement' : 'receipt'}): please process.`,
    `Community: ${communityName || 'not identified'}`,
    `From: ${senderName || senderEmail || 'unknown'}${senderRole === 'board' ? ' (board member)' : ''}${senderEmail && senderName ? ` <${senderEmail}>` : ''}`,
    `Vendor: ${store || 'see receipt'}`,
    `Purpose: ${purpose || 'see receipt'}`,
    `Receipt total: ${total || 'see receipt'}${senderRole === 'board' ? ' (paid out of pocket; the email states no separate amount, so confirm the reimbursement amount)' : ''}`,
    `Date: ${extracted.invoice_date || 'see receipt'}`,
    coded ? `Coding: ${coded}` : 'Coding: needs review (no expense account was given; none was assumed)',
    'Source: the original email and attached receipt are linked. Do not ask the sender to resend anything.',
  ];
  return { text: bits.join('\n'), purpose, total_cents: extracted.total_cents || null, vendor: store || null };
}

/** Existing Emma items for this email (AP invoices or intake items). */
async function existingHandoff(supabase, m) {
  const refs = [...new Set([m.graph_id && `email:${m.graph_id}`, `email:${m.id}`].filter(Boolean))];
  const [inv, exc] = await Promise.all([
    supabase.from('ap_invoices').select('id, status, total_cents, intake_source_ref').in('intake_source_ref', refs),
    supabase.from('ap_intake_exceptions').select('id, status, reason, intake_source_ref, email_message_id').or([`email_message_id.eq.${m.id}`, ...refs.map((r) => `intake_source_ref.eq.${r}`)].join(',')),
  ]);
  if (inv.error) throw new Error('handoff lookup failed: ' + inv.error.message);
  if (exc.error) throw new Error('handoff lookup failed: ' + exc.error.message);
  return { invoices: inv.data || [], exceptions: exc.data || [] };
}

/**
 * Hand one email's receipt to Emma. Idempotent: returns the existing item when
 * one already exists. Never pays, never closes the email.
 * @returns {{ status: 'already_handed'|'handed'|'not_eligible'|'no_item', items, summary?, reason? }}
 */
async function handoffToEmma(supabase, emailId, deps = {}) {
  const intake = deps.intakeBillEmail || require('../ap/email_bill_intake').intakeBillEmail;
  const { data: m, error } = await supabase.from('email_messages')
    .select('id, mailbox, graph_id, subject, sender_name, sender_email, community_id, resolved_vendor_id, extracted, body_full, body_preview, classification, has_attachments, community:community_id(name)')
    .eq('id', emailId).maybeSingle();
  if (error) throw new Error('email lookup failed: ' + error.message);
  if (!m) return { status: 'not_found', items: {} };

  const before = await existingHandoff(supabase, m);
  const recorded = (m.extracted || {}).emma_handoff;
  if (before.invoices.length || before.exceptions.length) return { status: 'already_handed', items: before };
  // A handoff already recorded on the email counts too (e.g. its message id moved).
  if (recorded && ((recorded.invoice_ids || []).length || (recorded.exception_ids || []).length)) return { status: 'already_handed', items: before, recorded };

  const { data: bm } = await supabase.from('board_members').select('name, community_id, community_name')
    .neq('is_active', false).ilike('email', String(m.sender_email || '').trim()).limit(3);
  const boardMember = (bm || []).length ? bm : null;
  const elig = isRoutinePayableIntake(m, { boardMember: !!boardMember });
  if (!elig.ok && !deps.force) return { status: 'not_eligible', reason: elig.reason, items: before };

  const communityName = (m.community && m.community.name) || (boardMember && boardMember.length === 1 && boardMember[0].community_name) || null;
  const intentHint = boardMember ? {
    is_reimbursement: true, reimbursee_name: boardMember[0].name || m.sender_name || null,
    community_hint: communityName, board_member: boardMember, from_board_member: true, source: 'amanda_handoff',
  } : null;
  const out = await intake(m, { intentHint, keepOpen: true, classification: m.classification || 'vendor_financial' });

  const after = await existingHandoff(supabase, m);
  const result = (out && out.results) || [];
  const firstExtracted = (result.find((r) => r._out && r._out.extracted) || {})._out;
  // The receipt's own text, only to name the store for the note (best-effort).
  let receiptText = '';
  try {
    const pdf = (out && out.prepared && (out.prepared.files || []).find((f) => f.kind === 'pdf' && f.buffer)) || null;
    if (pdf) receiptText = (await (deps.pdfText || ((b) => require('pdf-parse')(b).then((r) => r.text)))(pdf.buffer)) || '';
  } catch (_) { /* naming the store is a nicety; the receipt itself is linked */ }
  const summary = handoffSummary({
    communityName, senderName: (boardMember && boardMember[0].name) || m.sender_name, senderEmail: m.sender_email,
    senderRole: boardMember ? 'board' : 'staff', extracted: (firstExtracted && firstExtracted.extracted) || {}, receiptText,
  });
  // Put Amanda's summary in front of Emma on each new item (her notes keep the
  // intake's own reason underneath, so every figure's source stays visible).
  for (const x of after.exceptions) {
    const { data: cur } = await supabase.from('ap_intake_exceptions').select('notes').eq('id', x.id).maybeSingle();
    if (cur && !String(cur.notes || '').startsWith('Amanda handoff')) {
      await supabase.from('ap_intake_exceptions').update({ notes: `${summary.text}\n\nIntake: ${cur.notes || ''}`.slice(0, 4000) }).eq('id', x.id);
    }
  }
  for (const v of after.invoices) {
    const { data: cur } = await supabase.from('ap_invoices').select('notes').eq('id', v.id).maybeSingle();
    if (cur && !String(cur.notes || '').startsWith('Amanda handoff')) {
      await supabase.from('ap_invoices').update({ notes: `${summary.text}\n\n${cur.notes || ''}`.slice(0, 4000) }).eq('id', v.id);
    }
  }
  const items = after;
  const status = items.invoices.length || items.exceptions.length ? 'handed' : 'no_item';
  // Record it on the email so the inbox shows the handoff (and a re-run is a no-op).
  const { data: fresh } = await supabase.from('email_messages').select('extracted').eq('id', m.id).maybeSingle();
  const ex = (fresh && fresh.extracted) || m.extracted || {};
  await supabase.from('email_messages').update({ extracted: { ...ex, emma_handoff: {
    at: new Date().toISOString(), by: 'amanda', status, reason: elig.reason,
    invoice_ids: items.invoices.map((i) => i.id), exception_ids: items.exceptions.map((i) => i.id),
  } } }).eq('id', m.id);
  return { status, items, summary, reason: status === 'no_item' ? 'Emma’s intake did not create an item; see the email’s ap_intake record' : elig.reason };
}

module.exports = { isRoutinePayableIntake, handoffSummary, storeLine, purposeFrom, existingHandoff, handoffToEmma, RECEIPT_RE, NOT_ROUTINE_RE };
