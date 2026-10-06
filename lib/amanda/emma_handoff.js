// ============================================================================
// lib/amanda/emma_handoff.js  (Ed 2026-10-06) — Amanda hands routine receipts to Emma
// ----------------------------------------------------------------------------
// When a routine receipt reaches Amanda (a board member or Bedrock staff sends a
// receipt for a normal community purchase), Amanda acknowledges the sender through
// her normal review/send controls, and hands Emma a structured PAYMENT-EVIDENCE
// PACKAGE. Amanda reads; Emma classifies. Nothing here pays anything, and nothing
// assumes reimbursement or card ownership.
//
// THE PACKAGE (buildPaymentPackage, pure):
//   expense      the whole purchase (item subtotal + shipping + tax), coded as ONE
//                expense; coding needs review unless given.
//   components   each way it was paid, separately: a card (brand, last four, amount)
//                and any gift card / store credit (issuer, amount). The components
//                must add up to the expense; if they don't, that is flagged.
//   per component, the funding owner from the evidence:
//     association  the email says the association's card/gift card was used, a
//                  DEDICATED association-card record matches the card's last four, or
//                  exactly one imported association bank/card charge matches the
//                  CARD amount. bank_accounts.account_last4 is NOT card evidence.
//     personal     the sender says that component (or the whole purchase) was paid
//                  personally, and nothing shows the association funded it
//     unknown      anything else, including a personal claim that conflicts with
//                  association evidence
//   treatment
//     association card           -> card substantiation + coding (no reimbursement)
//     association gift card      -> nothing to reimburse (noted on the package)
//     personal (any component)   -> ONE reimbursement item for the personal-funded total
//     unknown (each component)   -> ONE review question for that component's amount only;
//                                   it never blocks the other components
//
// Emma's items are ap_intake_exceptions rows (her review queue), one per treatment,
// each carrying the receipt and the whole package. A reimbursement item is shaped
// for her existing "promote to reimbursement" action (payee = the person, store as
// the source, she picks the account, it lands awaiting approval). One item per
// component per email: re-running creates nothing new. The email stays open for
// Amanda's reply.
//
// Scar (Canyon Gate, 10/06): the board president's $62.19 Amazon order for a "Do
// Not Block Intersection" sign was paid $51.05 on a MasterCard ending 4738 plus an
// $11.14 Amazon gift card. A board member's receipt had been treated as a
// reimbursement to him; most likely it was the association's debit card, and the
// gift card's owner is unknown.
// ============================================================================

const RECEIPT_RE = /\b(receipt|reimburs\w*|out[\s-]?of[\s-]?pocket|i (?:ordered|bought|purchased|paid for)|paid (?:for|on behalf)|expense report|invoice attached)\b/i;
// Not routine, whatever the amount (a $50 legal filing still matters).
const NOT_ROUTINE_RE = /\b(attorney|lawyer|legal|lawsuit|court|filing fee|subpoena|insurance claim|claim number|adjuster|contract|retainer|agreement|dispute|chargeback|refund|unauthori[sz]ed|without approval|not approved|fraud)\b/i;

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
const cents = (s) => (s == null ? null : Math.round(Number(String(s).replace(/,/g, '')) * 100));

// ---- Store + purpose (for the note) ---------------------------------------
const MARKETPLACES = [['Amazon', /\bamazon(?:\.com)?\b/i], ['Walmart', /\bwal-?mart\b/i], ['Target', /\btarget(?:\.com)?\b/i], ['The Home Depot', /\bhome depot\b/i],
  ["Lowe's", /\blowe['’]?s\b/i], ['Costco', /\bcostco\b/i], ["Sam's Club", /\bsam['’]?s club\b/i], ['eBay', /\bebay\b/i]];
function storeLine(receiptText, sellerName) {
  const t = String(receiptText || '');
  const hit = MARKETPLACES.find(([, re]) => re.test(t));
  const soldBy = (t.match(/sold by:?\s*([^\n,]{2,60})/i) || [])[1];
  const seller = String(sellerName || soldBy || '').trim();
  if (hit) return seller && !hit[1].test(seller) ? `${hit[0]} (sold by ${seller})` : hit[0];
  return seller || null;
}
function purposeFrom(lines = []) {
  const first = lines.map((l) => String((l && l.description) || '').trim()).find((d) => d && !/^(estimated )?tax|gift card|shipping|subtotal|total/i.test(d));
  if (!first) return null;
  return first.length > 110 ? first.slice(0, 107).replace(/\s+\S*$/, '') + '…' : first;
}

// ---- Tenders: how the purchase was paid, from the receipt's own text -------
/**
 * Read the expense and each payment component. Pure.
 * Amazon-style receipts print: Item(s) Subtotal, Shipping, Total before tax,
 * Estimated tax, Gift Card Amount (-), Grand Total (what the card was charged).
 */
function parseTenders(receiptText, extracted = {}) {
  const t = String(receiptText || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ');
  const flat = t.replace(/\n/g, ' ');
  const amt = (re) => { const m = flat.match(re); return m ? cents(m[1]) : null; };
  const beforeTax = amt(/total before tax:?\s*\$?\s*([\d,]+\.\d{2})/i);
  const tax = amt(/estimated tax(?: to be collected)?:?\s*\$?\s*([\d,]+\.\d{2})/i);
  const grand = amt(/grand total:?\s*\$?\s*([\d,]+\.\d{2})/i) ?? amt(/order total:?\s*\$?\s*([\d,]+\.\d{2})/i);
  const gift = amt(/gift card amount:?\s*-?\s*\$?\s*([\d,]+\.\d{2})/i) ?? amt(/\$?\s*([\d,]+\.\d{2})\s*(?:gift card )?balance applied/i);
  const storeCredit = amt(/(?:store credit|promotional credit|reward points?)(?: applied)?:?\s*-?\s*\$?\s*([\d,]+\.\d{2})/i);
  const card = flat.match(/\b(visa|mastercard|master\s*card|amex|american\s+express|discover|debit card)\b[^\d]{0,12}(\d{4})\b/i);
  const charged = grand ?? (extracted.total_cents || null);
  const other = (gift || 0) + (storeCredit || 0);
  const expense = beforeTax != null && tax != null ? beforeTax + tax : (charged != null ? charged + other : null);
  const components = [];
  if (charged != null && charged > 0) {
    components.push(card
      ? { kind: 'card', label: `${card[1].replace(/\s+/g, '')} ending ${card[2]}`, card_brand: card[1].replace(/\s+/g, '').toLowerCase(), card_last4: card[2], amount_cents: charged }
      : { kind: 'payment', label: 'payment (method not printed)', amount_cents: charged });
  }
  if (gift) components.push({ kind: 'gift_card', label: `${/amazon/i.test(flat) ? 'Amazon ' : ''}gift card`, amount_cents: gift });
  if (storeCredit) components.push({ kind: 'store_credit', label: 'store credit', amount_cents: storeCredit });
  const sum = components.reduce((s, c) => s + c.amount_cents, 0);
  const reconciles = expense != null && sum === expense;
  return { expense_cents: expense, components, reconciles, components_total_cents: sum,
    note: expense == null ? 'the receipt total could not be read' : (reconciles ? null : `payments add to ${money(sum)} but the order total is ${money(expense)}`) };
}

// ---- Ownership evidence per component ---------------------------------------
const PERSONAL_ALL_RE = /\b(?:i\s+paid\s+(?:for\s+(?:this|it|these)\s+)?(?:personally|myself|out\s+of\s+(?:my\s+own\s+)?pocket|with\s+my\s+(?:own|personal)\s+(?:money|funds))|paid\s+(?:for\s+(?:this|it)\s+)?out\s+of\s+pocket|out[\s-]of[\s-]pocket|please\s+reimburse|reimburse\s+me|pay\s+me\s+back)\b/i;
const ASSOC_CARD_RE = /\b(?:(?:hoa|association|community|our|the\s+hoa['’]?s?)\s+(?:debit|credit|bank)?\s*card|charged\s+(?:it\s+)?to\s+the\s+(?:hoa|association)|used\s+the\s+(?:hoa|association)['’]?s?\s+card)\b/i;
const PERSONAL_CARD_RE = /\b(?:my\s+(?:own\s+|personal\s+)?(?:credit|debit)?\s*card|personal\s+(?:credit|debit)\s+card)\b/i;
const ASSOC_GIFT_RE = /\b(?:(?:hoa|association|community)['’]?s?\s+(?:amazon\s+)?(?:gift\s*card|store\s+credit|amazon\s+balance)|gift\s*card\s+(?:belongs?\s+to|from|owned\s+by)\s+the\s+(?:hoa|association))\b/i;
const PERSONAL_GIFT_RE = /\b(?:my\s+(?:own\s+|personal\s+)?(?:amazon\s+)?(?:gift\s*card|gift\s+balance|store\s+credit|amazon\s+balance)|personal\s+gift\s*card|gift\s*card\s+(?:was|is)\s+mine|i\s+used\s+my\s+(?:own\s+)?(?:amazon\s+)?(?:gift\s*card|balance))\b/i;

/** Who funded one component. Pure. */
function classifyComponent(c, { emailText = '', associationCardLast4s = [], cardMatches = [] } = {}) {
  const t = String(emailText || '');
  const allPersonal = PERSONAL_ALL_RE.test(t);
  if (c.kind === 'card' || c.kind === 'payment') {
    const ev = [];
    if (ASSOC_CARD_RE.test(t)) ev.push('the email says the association card was used');
    // Only a DEDICATED association-card record counts. A bank ACCOUNT's last four
    // (bank_accounts.account_last4) is not card ownership evidence. (Ed 2026-10-06.)
    if (c.card_last4 && associationCardLast4s.includes(c.card_last4)) ev.push(`the card ending ${c.card_last4} is on file as an association card`);
    if (cardMatches.length === 1) ev.push(`one association bank charge matches ${money(c.amount_cents)}`);
    const personal = PERSONAL_CARD_RE.test(t) || allPersonal;
    if (ev.length && personal) return { owner: 'unknown', why: `the sender says it was personal, but ${ev.join(' and ')}` };
    if (ev.length) return { owner: 'association', why: ev.join('; '), transaction: cardMatches.length === 1 ? cardMatches[0] : null };
    if (cardMatches.length > 1) return { owner: 'unknown', why: `${cardMatches.length} association bank charges could match ${money(c.amount_cents)}` };
    if (personal) return { owner: 'personal', why: 'the sender says they paid personally' };
    return { owner: 'unknown', why: `${c.card_last4 ? `the card ending ${c.card_last4} is not on file as an association card` : 'the payment method is not printed'} and no matching association bank charge was found yet` };
  }
  // gift card / store credit
  const assoc = ASSOC_GIFT_RE.test(t);
  const personal = PERSONAL_GIFT_RE.test(t) || allPersonal;
  if (assoc && personal) return { owner: 'unknown', why: 'the email says both that it was personal and that it was the association’s' };
  if (assoc) return { owner: 'association', why: 'the email says the gift card / credit was the association’s' };
  if (personal) return { owner: 'personal', why: 'the sender says it was their own' };
  return { owner: 'unknown', why: 'who owned the gift card / credit is not stated' };
}

/**
 * The payment-evidence package and the Emma items it implies. Pure.
 * items: [{ kind: 'card_substantiation'|'reimbursement'|'funding_review', amount_cents, components: [idx], why }]
 */
function buildPaymentPackage({ emailText = '', receiptText = '', extracted = {}, associationCardLast4s = [], cardMatches = [] } = {}) {
  const tenders = parseTenders(receiptText, extracted);
  const components = tenders.components.map((c) => {
    const cls = classifyComponent(c, { emailText, associationCardLast4s, cardMatches: (c.kind === 'card' || c.kind === 'payment') ? cardMatches : [] });
    const treatment = cls.owner === 'personal' ? 'reimburse'
      : cls.owner === 'association' ? ((c.kind === 'card' || c.kind === 'payment') ? 'card_substantiation' : 'association_funded')
        : 'review';
    return { ...c, owner: cls.owner, why: cls.why, treatment, transaction_id: cls.transaction ? cls.transaction.id : null, transaction: cls.transaction || null };
  });
  const items = [];
  components.forEach((c, i) => {
    if (c.treatment === 'card_substantiation') items.push({ kind: 'card_substantiation', key: `card${i}`, amount_cents: c.amount_cents, components: [i], why: c.why });
  });
  const personal = components.map((c, i) => [c, i]).filter(([c]) => c.treatment === 'reimburse');
  if (personal.length) items.push({ kind: 'reimbursement', key: 'reimb', amount_cents: personal.reduce((s, [c]) => s + c.amount_cents, 0), components: personal.map(([, i]) => i), why: personal.map(([c]) => `${c.label}: ${c.why}`).join('; ') });
  components.forEach((c, i) => {
    if (c.treatment === 'review') items.push({ kind: 'funding_review', key: `review${i}`, amount_cents: c.amount_cents, components: [i], why: c.why, label: c.label });
  });
  if (!tenders.reconciles && tenders.note) items.push({ kind: 'funding_review', key: 'reconcile', amount_cents: tenders.expense_cents, components: [], why: tenders.note });
  return {
    expense_cents: tenders.expense_cents, components, items, reconciles: tenders.reconciles,
    reimbursement_cents: personal.reduce((s, [c]) => s + c.amount_cents, 0),
  };
}

/** Amanda's note for Emma: the expense once, the funding split underneath. Pure. */
function handoffSummary({ communityName, senderName, senderRole, senderEmail, extracted = {}, receiptText = '', pkg }) {
  const purpose = purposeFrom(extracted.line_items || []);
  const store = storeLine(receiptText, extracted.vendor_name);
  const TREAT = { card_substantiation: 'association card: match to the bank charge, attach the receipt, code it (not a reimbursement)', association_funded: 'association-owned: nothing to reimburse', reimburse: `personal: reimburse ${senderName || 'the sender'}`, review: 'unresolved: review this component only' };
  const comp = (pkg.components || []).map((c) => `  - ${c.label} ${money(c.amount_cents)}: ${TREAT[c.treatment]} (${c.why})`);
  const items = (pkg.items || []).map((x) => `  - ${{ card_substantiation: 'Card charge to code', reimbursement: `Reimbursement to ${senderName || 'the sender'}`, funding_review: 'Question' }[x.kind]} ${money(x.amount_cents)}${x.kind === 'funding_review' ? `: ${x.why}` : ''}`);
  const bits = [
    'Amanda handoff (routine receipt): payment evidence for Emma.',
    `Community: ${communityName || 'not identified'}`,
    `From: ${senderName || senderEmail || 'unknown'}${senderRole === 'board' ? ' (board member)' : ''}${senderEmail && senderName ? ` <${senderEmail}>` : ''}`,
    `Vendor: ${store || 'see receipt'}`,
    `Purpose: ${purpose || 'see receipt'}`,
    `Expense: ${money(pkg.expense_cents) || 'see receipt'} (one expense line; coding needs review, none assumed)`,
    'Funding:', ...comp,
    pkg.reconciles ? null : 'Note: the payment components do not add up to the order total; see the question below.',
    'Emma items:', ...(items.length ? items : ['  - none']),
    `Date: ${extracted.invoice_date || 'see receipt'}`,
    'Source: the original email and attached receipt are linked. Do not ask the sender to resend anything.',
  ].filter((x) => x != null);
  return { text: bits.join('\n'), purpose, vendor: store || null };
}

/**
 * Association bank charges that could be the CARD component: same community, the
 * card amount (a debit), posted 2 days before to 10 days after the receipt date,
 * store-named when possible.
 */
async function findCardMatches(supabase, { communityId, amountCents, date, storeTokens = [] }) {
  if (!communityId || !amountCents || !date) return [];
  const d = new Date(date + 'T00:00:00Z');
  const from = new Date(d.getTime() - 2 * 86400e3).toISOString().slice(0, 10);
  const to = new Date(d.getTime() + 10 * 86400e3).toISOString().slice(0, 10);
  const { data: imps, error: ie } = await supabase.from('bank_statement_imports').select('id').eq('community_id', communityId).limit(500);
  if (ie) throw new Error('card match lookup failed: ' + ie.message);
  const ids = (imps || []).map((i) => i.id);
  if (!ids.length) return [];
  const { data: txns, error: te } = await supabase.from('bank_statement_transactions')
    .select('id, posting_date, amount_cents, description, bank_statement_import_id')
    .in('bank_statement_import_id', ids).eq('amount_cents', -Math.abs(amountCents))
    .gte('posting_date', from).lte('posting_date', to).limit(20);
  if (te) throw new Error('card match lookup failed: ' + te.message);
  const rows = txns || [];
  const named = rows.filter((x) => storeTokens.some((tok) => new RegExp(tok, 'i').test(x.description || '')));
  return named.length ? named : rows;
}

/** Existing Emma items for this email. */
async function existingHandoff(supabase, m) {
  const refs = [...new Set([m.graph_id && `email:${m.graph_id}`, `email:${m.id}`].filter(Boolean))];
  const [inv, exc] = await Promise.all([
    supabase.from('ap_invoices').select('id, status, total_cents, intake_source_ref').in('intake_source_ref', refs),
    supabase.from('ap_intake_exceptions').select('id, status, reason, intake_source_ref, email_message_id').eq('email_message_id', m.id),
  ]);
  if (inv.error) throw new Error('handoff lookup failed: ' + inv.error.message);
  if (exc.error) throw new Error('handoff lookup failed: ' + exc.error.message);
  return { invoices: inv.data || [], exceptions: exc.data || [] };
}

const ITEM_REASON = {
  card_substantiation: (x) => `card transaction substantiation: ${money(x.amount_cents)} card charge to match and code (not a reimbursement)`,
  reimbursement: (x) => `reimbursement: ${money(x.amount_cents)} personally funded portion; pick the expense account and promote`,
  // Short and label-safe: Emma's queue labels a reason by its words (e.g. any
  // "association"/"community" reads as "no community"), so the full why lives in
  // Amanda's note on the item, not here.
  funding_review: (x) => `payment component needs review: ${money(x.amount_cents)}${x.label ? ` (${x.label})` : ''}; who funded it is unconfirmed`,
};

/**
 * Hand one email's receipt to Emma as a payment-evidence package. Idempotent per
 * component. Never pays, never closes the email.
 */
async function handoffToEmma(supabase, emailId, deps = {}) {
  const { data: m, error } = await supabase.from('email_messages')
    .select('id, mailbox, graph_id, subject, sender_name, sender_email, community_id, extracted, body_full, body_preview, classification, has_attachments, community:community_id(name)')
    .eq('id', emailId).maybeSingle();
  if (error) throw new Error('email lookup failed: ' + error.message);
  if (!m) return { status: 'not_found', items: {} };
  const recorded = (m.extracted || {}).emma_handoff;
  if (recorded && recorded.status === 'handed') return { status: 'already_handed', items: await existingHandoff(supabase, m), recorded };
  const before = await existingHandoff(supabase, m);
  if (before.invoices.length) return { status: 'already_handed', items: before };

  const { data: bm } = await supabase.from('board_members').select('name, community_id, community_name')
    .neq('is_active', false).ilike('email', String(m.sender_email || '').trim()).limit(3);
  const boardMember = (bm || []).length ? bm : null;
  const elig = isRoutinePayableIntake(m, { boardMember: !!boardMember });
  if (!elig.ok && !deps.force) return { status: 'not_eligible', reason: elig.reason, items: before };
  const communityName = (m.community && m.community.name) || (boardMember && boardMember.length === 1 && boardMember[0].community_name) || null;
  const communityId = m.community_id || (boardMember && boardMember.length === 1 ? boardMember[0].community_id : null);
  const senderName = (boardMember && boardMember[0].name) || m.sender_name;

  // Amanda reads the receipt (Emma's own stager archives + hashes + extracts it).
  const loadAtts = deps.loadAttachments || (async (row) => { const L = require('../ap/email_bill_intake'); return L.loadBillAttachments(row, L.withDeps({})); });
  const stage = deps.stageInvoice || require('../ap/intake').stageInvoice;
  const file = ((await loadAtts(m)) || []).find((a) => a && a.buffer && !a.isInline && /pdf|image/i.test(`${a.contentType || ''} ${a.name || ''}`)) || null;
  if (!file) return { status: 'no_item', reason: 'no readable receipt attachment', items: before };
  const staged = await stage(file.buffer, file.name || 'receipt.pdf', null);
  const extracted = (staged && staged.extracted) || {};
  let receiptText = '';
  try { if (/pdf/i.test(`${file.contentType || ''} ${file.name || ''}`)) receiptText = (await (deps.pdfText || ((b) => require('pdf-parse')(b).then((r) => r.text)))(file.buffer)) || ''; } catch (_) { /* tenders fall back to the extracted total */ }

  const emailText = `${m.subject || ''}\n${m.body_full || m.body_preview || ''}`;
  const tenders = parseTenders(receiptText, extracted);
  const cardComp = tenders.components.find((c) => c.kind === 'card' || c.kind === 'payment');
  const store = storeLine(receiptText, extracted.vendor_name);
  const storeTokens = [store && store.split(' ')[0], extracted.vendor_name, /amazon/i.test(store || '') ? 'amzn' : null].filter(Boolean).map((s) => String(s).replace(/[^a-z0-9]/gi, '').slice(0, 12)).filter((s) => s.length >= 3);
  let cardMatches = [];
  if (cardComp) {
    try { cardMatches = await (deps.findCardMatches || findCardMatches)(supabase, { communityId, amountCents: cardComp.amount_cents, date: extracted.invoice_date, storeTokens }); }
    catch (e) { console.warn('[emma_handoff] card match lookup failed (treated as no match):', e.message); }
  }
  // Dedicated association-card records (card last four -> community). None are
  // stored yet, so this is empty until that record exists; bank_accounts is NOT
  // consulted (an account number is not a card).
  let cardLast4s = [];
  try { cardLast4s = ((deps.loadAssociationCards ? await deps.loadAssociationCards(communityId) : []) || []).map(String).filter(Boolean); } catch (_) {}
  const pkg = buildPaymentPackage({ emailText, receiptText, extracted, associationCardLast4s: cardLast4s, cardMatches });
  const summary = handoffSummary({ communityName, senderName, senderRole: boardMember ? 'board' : 'staff', senderEmail: m.sender_email, extracted, receiptText, pkg });

  // One Emma item per treatment, each with the receipt and the whole package.
  // Each has its own source key, so a re-run finds it instead of adding another.
  const record = deps.recordException || require('../ap/intake_exceptions').recordException;
  const baseRef = `email:${m.graph_id || m.id}`;
  const pkgForRow = { expense_cents: pkg.expense_cents, reconciles: pkg.reconciles, components: pkg.components.map(({ transaction, ...c }) => c), reimbursement_cents: pkg.reimbursement_cents };
  let first = true;
  for (const item of pkg.items) {
    const ex = { ...extracted, total_cents: item.amount_cents, payment_package: pkgForRow, handoff_item: { kind: item.kind, amount_cents: item.amount_cents, components: item.components, why: item.why } };
    if (item.kind === 'reimbursement') ex.reimbursement = { reimbursee: senderName || null, community_id: communityId, requested_cents: item.amount_cents, requested_source: 'personally funded components of the receipt (Amanda handoff)', receipt_total_cents: pkg.expense_cents };
    if (item.kind === 'card_substantiation') ex.card_transaction_id = (pkg.components[item.components[0]] || {}).transaction_id || null;
    const reason = item.key === 'reconcile' ? `receipt payments do not reconcile to the order total (${item.why})` : ITEM_REASON[item.kind](item);
    const r = await record({ emailMessageId: m.id, sourceRef: `${baseRef}#${item.key}`, reason, storagePath: staged.storagePath,
      sha256: first ? staged.sha256 : null, communityId, extracted: ex });
    first = false;
    if (!r || !r.ok) throw new Error('could not record Emma’s item: ' + ((r && r.reason) || 'unknown'));
    if (r.id && !r.existing) {
      const { data: cur } = await supabase.from('ap_intake_exceptions').select('notes').eq('id', r.id).maybeSingle();
      if (cur && !String(cur.notes || '').startsWith('Amanda handoff')) await supabase.from('ap_intake_exceptions').update({ notes: `${summary.text}\n\nThis item: ${cur.notes || ''}`.slice(0, 4000) }).eq('id', r.id);
    }
  }
  const after = await existingHandoff(supabase, m);
  const status = after.exceptions.length || after.invoices.length ? 'handed' : 'no_item';
  const { data: fresh } = await supabase.from('email_messages').select('extracted').eq('id', m.id).maybeSingle();
  const exNow = (fresh && fresh.extracted) || m.extracted || {};
  await supabase.from('email_messages').update({ extracted: { ...exNow, emma_handoff: {
    at: new Date().toISOString(), by: 'amanda', status, expense_cents: pkg.expense_cents, reimbursement_cents: pkg.reimbursement_cents,
    items: pkg.items.map((x) => ({ kind: x.kind, amount_cents: x.amount_cents })), exception_ids: after.exceptions.map((i) => i.id),
  } } }).eq('id', m.id);
  return { status, pkg, items: after, summary, reason: status === 'no_item' ? 'no Emma item was created' : elig.reason };
}

module.exports = {
  isRoutinePayableIntake, storeLine, purposeFrom, parseTenders, classifyComponent, buildPaymentPackage, handoffSummary,
  findCardMatches, existingHandoff, handoffToEmma, ITEM_REASON, RECEIPT_RE, NOT_ROUTINE_RE,
};
