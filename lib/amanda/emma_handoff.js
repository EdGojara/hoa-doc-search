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
//   * PAYMENT METHOD FIRST (Ed 2026-10-06): a board member's receipt is not
//     presumed to be a reimbursement. Association card use -> card substantiation
//     and coding; clearly personal payment -> reimbursement; unclear -> Emma
//     reviews the payment method. Only the personal case passes Amanda's judgment
//     to intake as an explicit reimbursement intent hint. Amount, community and coding are still established
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
function handoffSummary({ communityName, senderName, senderRole, senderEmail, extracted = {}, coded = null, receiptText = '', payment = null }) {
  const purpose = purposeFrom(extracted.line_items || []);
  const store = storeLine(receiptText, extracted.vendor_name);
  const total = money(extracted.total_cents);
  const method = payment && payment.method;
  const pay = (payment && payment.pay) || {};
  const card = pay.card_last4 ? `${pay.card_brand || 'card'} ending ${pay.card_last4}` : null;
  const txn = payment && payment.transaction;
  const treatment = method === 'personal'
    ? `Treatment: reimbursement to ${senderName || 'the sender'} (${payment.why}).`
    : method === 'association_card'
      ? `Treatment: association card purchase (${payment.why}). Match the receipt to the card charge${txn ? ` (bank line ${txn.posting_date} ${money(Math.abs(txn.amount_cents))} "${String(txn.description || '').slice(0, 60)}")` : ''}, attach it, and code the expense. Not a reimbursement.`
      : `Treatment: payment method needs review (${payment ? payment.why : 'not determined'}). Check the association's card / bank activity first; do not create a reimbursement unless the records show ${senderName || 'the sender'} paid personally.`;
  const bits = [
    'Amanda handoff (routine receipt): please process.',
    treatment,
    `Community: ${communityName || 'not identified'}`,
    `From: ${senderName || senderEmail || 'unknown'}${senderRole === 'board' ? ' (board member)' : ''}${senderEmail && senderName ? ` <${senderEmail}>` : ''}`,
    `Vendor: ${store || 'see receipt'}`,
    `Purpose: ${purpose || 'see receipt'}`,
    `Receipt total: ${total || 'see receipt'}${card ? ` (paid with ${card}${pay.gift_card_cents ? ` plus a $${(pay.gift_card_cents / 100).toFixed(2)} gift card` : ''})` : ''}${method === 'personal' ? '; the email states no separate amount, so confirm the reimbursement amount' : ''}`,
    `Date: ${extracted.invoice_date || 'see receipt'}`,
    coded ? `Coding: ${coded}` : 'Coding: needs review (no expense account was given; none was assumed)',
    'Source: the original email and attached receipt are linked. Do not ask the sender to resend anything.',
  ];
  return { text: bits.join('\n'), purpose, total_cents: extracted.total_cents || null, vendor: store || null, treatment: method || null };
}

// ---------------------------------------------------------------------------
// PAYMENT METHOD FIRST (Ed 2026-10-06). A board member's receipt is NOT presumed
// to be a reimbursement. Board members often buy with the association's debit
// card; then the receipt is substantiation for a card charge that needs coding,
// and a payable to the board member would be wrong (it would pay twice).
//   personal          the sender clearly says they paid personally / asks to be
//                     reimbursed, and nothing shows an association card -> reimbursement
//   association_card  the email says the association/HOA card was used, the receipt's
//                     card matches an association account on file, or exactly one
//                     association bank charge matches -> card substantiation + coding
//   unclear           anything else (including a personal claim that conflicts with
//                     association-card evidence, or several candidate charges)
//                     -> Emma reviews the payment method; no reimbursement is created
// ---------------------------------------------------------------------------
const PERSONAL_RE = /\b(?:i\s+paid\s+(?:for\s+(?:this|it|these)\s+)?(?:personally|myself|out\s+of\s+(?:my\s+own\s+)?pocket|with\s+my\s+(?:own|personal))|paid\s+(?:for\s+(?:this|it)\s+)?out\s+of\s+pocket|out[\s-]of[\s-]pocket|(?:with|on)\s+my\s+(?:own|personal)\s+(?:card|money|funds|credit\s+card|debit\s+card)|please\s+reimburse|reimburse\s+me|pay\s+me\s+back)\b/i;
const ASSOCIATION_CARD_RE = /\b(?:(?:hoa|association|community|our|the\s+hoa['’]?s?)\s+(?:debit|credit|bank)?\s*card|(?:debit|credit)\s+card\s+(?:for|of)\s+the\s+(?:hoa|association)|charged\s+(?:it\s+)?to\s+the\s+(?:hoa|association)|used\s+the\s+(?:hoa|association)['’]?s?\s+card)\b/i;

/** Card and gift-card details printed on a receipt. Pure. */
function receiptPayment(receiptText) {
  const t = String(receiptText || '');
  const card = t.match(/\b(visa|mastercard|master\s*card|amex|american\s+express|discover|debit)\b[^\d\n]{0,12}(\d{4})\b/i);
  const gift = t.match(/gift\s*card(?:\s*amount)?:?\s*-?\$?\s*(\d+(?:,\d{3})*\.\d{2})/i);
  return {
    card_brand: card ? card[1].replace(/\s+/g, '').toLowerCase() : null,
    card_last4: card ? card[2] : null,
    gift_card_cents: gift ? Math.round(Number(gift[1].replace(/,/g, '')) * 100) : null,
  };
}

/** Decide the likely payment method. Pure. */
function classifyPaymentMethod({ emailText = '', receiptText = '', matches = [], associationLast4s = [] } = {}) {
  const pay = receiptPayment(receiptText);
  const personal = PERSONAL_RE.test(emailText);
  const assocStated = ASSOCIATION_CARD_RE.test(emailText);
  const cardOnFile = !!(pay.card_last4 && associationLast4s.includes(pay.card_last4));
  const evidence = [];
  if (assocStated) evidence.push('the email says the association card was used');
  if (cardOnFile) evidence.push(`the receipt card ending ${pay.card_last4} matches an association account on file`);
  if (matches.length === 1) evidence.push('one matching association bank charge');
  const assoc = assocStated || cardOnFile || matches.length === 1;
  if (personal && assoc) return { method: 'unclear', why: `the sender says they paid personally, but ${evidence.join(' and ')}`, pay, matches };
  if (assoc) return { method: 'association_card', why: evidence.join('; '), pay, matches, transaction: matches.length === 1 ? matches[0] : null };
  if (matches.length > 1) return { method: 'unclear', why: `${matches.length} association bank charges could match; pick the right one`, pay, matches };
  if (personal) return { method: 'personal', why: 'the sender says they paid personally / asks to be reimbursed', pay, matches };
  return { method: 'unclear', why: `the receipt shows ${pay.card_last4 ? `${pay.card_brand || 'a card'} ending ${pay.card_last4}` : 'no card detail'}${pay.gift_card_cents ? ` and a $${(pay.gift_card_cents / 100).toFixed(2)} gift card` : ''}, it is not on file as an association card, and no matching association bank charge was found yet`, pay, matches };
}

/**
 * Association bank charges that could be this receipt: same community, amount
 * equal to the receipt total (a debit), posted from 2 days before to 10 days
 * after the receipt date, description naming the store when it can.
 */
async function findCardMatches(supabase, { communityId, totalCents, date, storeTokens = [] }) {
  if (!communityId || !totalCents || !date) return [];
  const d = new Date(date + 'T00:00:00Z');
  const from = new Date(d.getTime() - 2 * 86400e3).toISOString().slice(0, 10);
  const to = new Date(d.getTime() + 10 * 86400e3).toISOString().slice(0, 10);
  const { data: imps, error: ie } = await supabase.from('bank_statement_imports').select('id').eq('community_id', communityId).limit(500);
  if (ie) throw new Error('card match lookup failed: ' + ie.message);
  const ids = (imps || []).map((i) => i.id);
  if (!ids.length) return [];
  const { data: txns, error: te } = await supabase.from('bank_statement_transactions')
    .select('id, posting_date, amount_cents, description, bank_statement_import_id')
    .in('bank_statement_import_id', ids).in('amount_cents', [-Math.abs(totalCents), Math.abs(totalCents)])
    .gte('posting_date', from).lte('posting_date', to).limit(20);
  if (te) throw new Error('card match lookup failed: ' + te.message);
  const rows = (txns || []).filter((x) => x.amount_cents <= 0 || !/deposit|credit/i.test(x.description || ''));
  const named = rows.filter((x) => storeTokens.some((tok) => new RegExp(tok, 'i').test(x.description || '')));
  return named.length ? named : rows;
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
 * Hand one email's receipt to Emma. Payment method is decided FIRST; only a
 * clearly personal payment becomes a reimbursement. Idempotent: returns the
 * existing item when one exists. Never pays, never closes the email.
 * @returns {{ status: 'already_handed'|'handed'|'not_eligible'|'no_item'|'not_found', treatment?, items, summary?, reason? }}
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
  if (recorded && ((recorded.invoice_ids || []).length || (recorded.exception_ids || []).length)) return { status: 'already_handed', items: before, recorded };

  const { data: bm } = await supabase.from('board_members').select('name, community_id, community_name')
    .neq('is_active', false).ilike('email', String(m.sender_email || '').trim()).limit(3);
  const boardMember = (bm || []).length ? bm : null;
  const elig = isRoutinePayableIntake(m, { boardMember: !!boardMember });
  if (!elig.ok && !deps.force) return { status: 'not_eligible', reason: elig.reason, items: before };
  const communityName = (m.community && m.community.name) || (boardMember && boardMember.length === 1 && boardMember[0].community_name) || null;
  const communityId = m.community_id || (boardMember && boardMember.length === 1 ? boardMember[0].community_id : null);
  const senderName = (boardMember && boardMember[0].name) || m.sender_name;
  const senderRole = boardMember ? 'board' : 'staff';

  // Read the receipt with Emma's own stager (archives the file, hashes it, extracts it).
  const loadAtts = deps.loadAttachments || (async (row) => {
    const L = require('../ap/email_bill_intake');
    return L.loadBillAttachments(row, L.withDeps({}));
  });
  const stage = deps.stageInvoice || require('../ap/intake').stageInvoice;
  const atts = (await loadAtts(m)) || [];
  const file = atts.find((a) => a && a.buffer && !a.isInline && /pdf|image/i.test(`${a.contentType || ''} ${a.name || ''}`)) || null;
  if (!file) return { status: 'no_item', reason: 'no readable receipt attachment', items: before };
  const staged = await stage(file.buffer, file.name || 'receipt.pdf', null);
  const extracted = (staged && staged.extracted) || {};
  let receiptText = '';
  try { if (/pdf/i.test(`${file.contentType || ''} ${file.name || ''}`)) receiptText = (await (deps.pdfText || ((b) => require('pdf-parse')(b).then((r) => r.text)))(file.buffer)) || ''; } catch (_) { /* card detail is a nicety */ }

  // Payment method first.
  const store = storeLine(receiptText, extracted.vendor_name);
  const storeTokens = [store && store.split(' ')[0], extracted.vendor_name, /amazon/i.test(store || '') ? 'amzn' : null].filter(Boolean).map((s) => String(s).replace(/[^a-z0-9]/gi, '').slice(0, 12)).filter((s) => s.length >= 3);
  let matches = [];
  try { matches = await (deps.findCardMatches || findCardMatches)(supabase, { communityId, totalCents: extracted.total_cents, date: extracted.invoice_date, storeTokens }); }
  catch (e) { console.warn('[emma_handoff] card match lookup failed (treated as no match):', e.message); }
  let last4s = [];
  try { const { data: ba } = await supabase.from('bank_accounts').select('account_last4').eq('community_id', communityId || '00000000-0000-0000-0000-000000000000'); last4s = (ba || []).map((x) => x.account_last4).filter(Boolean); } catch (_) {}
  const pm = classifyPaymentMethod({ emailText: `${m.subject || ''}\n${m.body_full || m.body_preview || ''}`, receiptText, matches, associationLast4s: last4s });

  const summary = handoffSummary({ communityName, senderName, senderEmail: m.sender_email, senderRole, extracted, receiptText, payment: pm });
  const sourceRef = `email:${m.graph_id || m.id}`;
  if (pm.method === 'personal') {
    // Clearly paid personally: the existing reimbursement path (payee = the
    // person, store as the source, awaiting_approval or needs_review).
    const intentHint = { is_reimbursement: true, reimbursee_name: senderName || null, community_hint: communityName, board_member: boardMember, from_board_member: !!boardMember, source: 'amanda_handoff' };
    await intake(m, { intentHint, keepOpen: true, classification: m.classification || 'vendor_financial', atts: [file] });
  } else {
    // Card substantiation or payment method review: ONE Emma review item with the
    // receipt and Amanda's note. No reimbursement payable is created.
    const record = deps.recordException || require('../ap/intake_exceptions').recordException;
    const reason = pm.method === 'association_card'
      ? 'card transaction substantiation: match this receipt to the card charge and code it (not a reimbursement)'
      : 'payment method needs review: confirm how this was paid before any reimbursement';
    const r = await record({ emailMessageId: m.id, sourceRef, reason, storagePath: staged.storagePath, sha256: staged.sha256, communityId,
      extracted: { ...extracted, payment_method: { method: pm.method, why: pm.why, receipt: pm.pay, card_transaction_id: pm.transaction ? pm.transaction.id : null, candidate_transaction_ids: (pm.matches || []).map((x) => x.id) } } });
    if (!r || !r.ok) throw new Error('could not record Emma’s review item: ' + ((r && r.reason) || 'unknown'));
  }

  const after = await existingHandoff(supabase, m);
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
  const status = after.invoices.length || after.exceptions.length ? 'handed' : 'no_item';
  const { data: fresh } = await supabase.from('email_messages').select('extracted').eq('id', m.id).maybeSingle();
  const ex = (fresh && fresh.extracted) || m.extracted || {};
  await supabase.from('email_messages').update({ extracted: { ...ex, emma_handoff: {
    at: new Date().toISOString(), by: 'amanda', status, treatment: pm.method, reason: pm.why,
    invoice_ids: after.invoices.map((i) => i.id), exception_ids: after.exceptions.map((i) => i.id),
  } } }).eq('id', m.id);
  return { status, treatment: pm.method, payment: pm, items: after, summary, reason: status === 'no_item' ? 'Emma’s intake did not create an item' : pm.why };
}

module.exports = { isRoutinePayableIntake, handoffSummary, storeLine, purposeFrom, receiptPayment, classifyPaymentMethod, findCardMatches, existingHandoff, handoffToEmma, RECEIPT_RE, NOT_ROUTINE_RE, PERSONAL_RE, ASSOCIATION_CARD_RE };
