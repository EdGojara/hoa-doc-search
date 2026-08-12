// ============================================================================
// lib/ap/intake.js  (Ed 2026-07-08)
// ----------------------------------------------------------------------------
// THE single door into ap_invoices. Email (emma@), manual upload, and Mail Scan
// all come through here, so a bill can't be entered twice by arriving on two
// channels. Flow:
//
//   stageInvoice(buffer)  -> extract fields + sha256 + stash the PDF (no DB write)
//   resolveVendor/Community -> match to masters (never auto-creates junk)
//   commitInvoice(...)    -> re-run dedup, then:
//        certain duplicate  -> BLOCK (no new payable; point at the original)
//        suspected duplicate -> insert on_hold + flag (visible, unpayable until cleared)
//        unique             -> insert awaiting_approval
//
// ap_invoices requires community + vendor + a positive total + a date, so an
// invoice missing any of those is returned as needs_review rather than force-fit.
// ============================================================================
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { extractInvoice } = require('./invoice_extract');
const { findDuplicates } = require('./dedup');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const BUCKET = 'documents';

const normName = (s) => String(s || '').toLowerCase().replace(/\b(llc|inc|co|corp|ltd|company|services|service|the)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// ---- staging: read the PDF, don't touch the DB yet --------------------------
async function stageInvoice(buffer, filename) {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const extracted = await extractInvoice(buffer);
  let storagePath = null;
  try {
    const safe = (filename || 'invoice.pdf').replace(/[^a-zA-Z0-9._\-]/g, '_');
    storagePath = `ap_invoices/${sha256.slice(0, 16)}_${safe}`;
    await supabase.storage.from(BUCKET).upload(storagePath, buffer, { contentType: 'application/pdf', upsert: true });
  } catch (e) { console.warn('[ap_intake] stash failed (non-fatal):', e.message); storagePath = null; }
  return { extracted, sha256, storagePath };
}

// ---- vendor resolution: email first, then a confident name match ------------
async function resolveVendor({ name, email }) {
  // is_active only. A deactivated vendor is either retired or a merged duplicate;
  // matching it re-introduces the ambiguity a merge exists to remove. (Ed 2026-07-15.)
  if (email) {
    const { data } = await supabase.from('vendors').select('id, name, dba, email')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID).neq('is_active', false).ilike('email', email.trim()).limit(2);
    if (data && data.length === 1) return { vendor: data[0], candidates: data, method: 'email' };
  }
  if (name) {
    const n = normName(name);
    const { data } = await supabase.from('vendors').select('id, name, dba, email')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID).neq('is_active', false).limit(1000);
    const hits = (data || []).filter((v) => normName(v.name) === n || (v.dba && normName(v.dba) === n));
    if (hits.length === 1) return { vendor: hits[0], candidates: hits, method: 'name' };
    if (hits.length > 1) return { vendor: null, candidates: hits, method: 'name_ambiguous' };
    // loose contains match -> candidates only (operator picks)
    const loose = (data || []).filter((v) => normName(v.name).includes(n) || n.includes(normName(v.name))).slice(0, 8);
    return { vendor: null, candidates: loose, method: loose.length ? 'name_loose' : 'none' };
  }
  return { vendor: null, candidates: [], method: 'none' };
}

// Words that don't distinguish one community from another — dropped before the
// token-overlap match so "Canyon Gate Blvd" still resolves to "Canyon Gate at
// Cinco Ranch" (a human maps that instantly; the old substring match couldn't).
const COMMUNITY_STOP = new Set(['at', 'the', 'of', 'and', 'hoa', 'homeowners', 'homeowner', 'owners', 'association', 'assoc', 'community', 'communities', 'inc', 'llc', 'lp', 'blvd', 'street', 'drive', 'lane', 'road', 'avenue', 'court', 'circle', 'trail', 'estates', 'estate', 'section', 'phase']);
const communityTokens = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !COMMUNITY_STOP.has(w));

async function resolveCommunity(hint) {
  if (!hint) return { community: null, candidates: [] };
  const { data } = await supabase.from('communities').select('id, name').limit(1000);
  const h = normName(hint);
  const exact = (data || []).filter((c) => normName(c.name) === h);
  if (exact.length === 1) return { community: exact[0], candidates: exact };
  const loose = (data || []).filter((c) => { const cn = normName(c.name); return cn && (h.includes(cn) || cn.includes(h)); }).slice(0, 8);
  if (loose.length === 1) return { community: loose[0], candidates: loose };
  // Try the alias registry (MUD / billing entity / DBA). "North Mission Glen
  // MUD" -> Eaglewood. (Ed 2026-07-16.)
  try {
    const { resolveCommunityByAlias } = require('../email/community_alias');
    const a = await resolveCommunityByAlias(hint);
    if (a && a.community_id) {
      const c = (data || []).find((x) => x.id === a.community_id);
      if (c) return { community: c, candidates: [c], via_alias: true, alias_gl_account_id: a.gl_account_id || null };
    }
  } catch (_) { /* alias table may not be applied yet — fall through */ }
  // Token-overlap: match on shared DISTINCTIVE words, and only when exactly one
  // community wins outright (a tie stays unresolved — never guess between two).
  // "Canyon Gate Blvd" shares {canyon, gate} with "Canyon Gate at Cinco Ranch"
  // and no other community, so it resolves; a bill for the wrong books is worse
  // than one held for review, so the bar is a unique, strict winner.
  const hToks = new Set(communityTokens(hint));
  if (hToks.size) {
    const scored = (data || []).map((c) => {
      const shared = communityTokens(c.name).filter((t) => hToks.has(t));
      return { c, shared: shared.length, distinctive: shared.some((t) => t.length >= 6) };
    }).filter((x) => x.shared >= 2 || (x.shared === 1 && x.distinctive));
    scored.sort((a, b) => b.shared - a.shared);
    if (scored.length === 1 || (scored.length > 1 && scored[0].shared > scored[1].shared)) {
      return { community: scored[0].c, candidates: [scored[0].c], method: 'tokens' };
    }
    if (scored.length > 1) return { community: null, candidates: scored.slice(0, 8).map((x) => x.c), method: 'tokens_ambiguous' };
  }
  return { community: null, candidates: loose };
}

// ---- commit: dedup + insert-or-hold-or-block --------------------------------
// Returns { outcome, invoice_id?, duplicate_of?, matches }
async function commitInvoice({ extracted, vendorId, communityId, sha256, storagePath, intakeMethod, sourceRef, achHintText, staffGl }) {
  if (!vendorId || !communityId) return { outcome: 'needs_review', reason: 'missing vendor or community' };
  if (!extracted.total_cents || extracted.total_cents <= 0) return { outcome: 'needs_review', reason: 'no invoice total' };
  if (!extracted.invoice_date) return { outcome: 'needs_review', reason: 'no invoice date' };

  // ACH auto-pay: an auto-drafted bill (bank draft / DO NOT PAY) is paid by the
  // bank, so Emma records it but keeps it OUT of the check run — otherwise it
  // gets a check AND the draft = double payment. Trigger on the vendor flag OR
  // the bill's own text (extractor's auto_draft, or the email/scan hint). When
  // the bill says so but the vendor isn't flagged yet, LEARN it onto the vendor.
  // Whether a bill is paid by auto-draft is the VENDOR's banking arrangement,
  // not something to read off an invoice. Almost every invoice OFFERS ACH /
  // e-check / card as ways to pay — that's a vendor asking to be paid, the
  // OPPOSITE of auto-draft. So the vendor flag is authoritative; invoice text
  // only escalates on UNAMBIGUOUS "this is auto-drafted, do not pay" language,
  // and it NEVER silently flips the vendor to auto-pay (that would suppress
  // every future check). (Ed 2026-08-12: Superior LawnCare offers ACH but is
  // paid by check — Emma wrongly marked it record-only and stopped the check.)
  const vres = await supabase.from('vendors').select('auto_pay_ach').eq('id', vendorId).maybeSingle();
  const vendorFlag = !vres.error && vres.data && vres.data.auto_pay_ach;
  const hay = `${extracted.terms || ''} ${(extracted.line_items || []).map((l) => l.description).join(' ')} ${achHintText || ''}`.toLowerCase();
  const textSaysAutoDraft = extracted.auto_draft === true
    || /\bdo\s*not\s*pay\b/.test(hay)
    || /\bauto[-\s]?draft(?:ed|s|ing)?\b/.test(hay)
    || /\bautomatic(?:ally)?\s+(?:draft|debit|withdraw)/.test(hay)
    || /\b(?:will\s+be|is|are|being)\s+(?:automatically\s+)?drafted\b/.test(hay)
    || /\bdrafted\s+from\s+your\s+(?:bank|account)\b/.test(hay);
  const isAch = !!(vendorFlag || textSaysAutoDraft);
  const achConfirmed = isAch ? textSaysAutoDraft : null;

  // Per-vendor convenience fee (MUD water districts: $1 per invoice). Applied to
  // `extracted` BEFORE dedup + coding so total, lines, and the accrual all carry
  // it. Martha asks Emma to "add $1 to each" in the email body, which Emma can't
  // act on — flagging the MUD vendor makes it automatic. (Ed 2026-07-23.)
  let convenienceFeeCents = 0;
  try {
    const { getVendorConvenienceFee, applyConvenienceFee } = require('./convenience_fee');
    const fee = await getVendorConvenienceFee(supabase, vendorId);
    if (fee.cents > 0) {
      applyConvenienceFee(extracted, fee, 'line_items');
      convenienceFeeCents = fee.cents;
    }
  } catch (e) { console.warn('[ap intake] convenience fee skipped:', e.message); }

  const { verdict, matches } = await findDuplicates(supabase, {
    communityId, vendorId, invoiceNumber: extracted.invoice_number,
    totalCents: extracted.total_cents, invoiceDate: extracted.invoice_date, fileSha256: sha256,
    accountNumber: extracted.account_number || null,
    servicePeriodStart: extracted.service_period_start || null, servicePeriodEnd: extracted.service_period_end || null,
  });

  if (verdict === 'certain') {
    return { outcome: 'blocked_duplicate', duplicate_of: matches[0].invoice.id, matches };
  }

  const suspected = verdict === 'suspected';

  // AI-CPA coding: suggest the expense account from vendor default -> history ->
  // budget fit -> description (Ed 2026-07-11). Non-fatal: an unclassified bill
  // still loads, just flagged for review.
  let coded = null;
  try {
    const { suggestClassification } = require('../accounting/gl_classifier');
    const codeDesc = (Array.isArray(extracted.line_items) ? extracted.line_items.map((l) => l.description).filter(Boolean).join('; ') : '') || extracted.vendor_name || null;
    // Pass the amount: it decides WHICH of this vendor's jobs the bill looks
    // like when they're coded to more than one account (see gl_classifier
    // branch 3 — the Swim Houston splash-pad scar).
    coded = await suggestClassification({ communityId, vendorId, description: codeDesc, totalCents: extracted.total_cents });
  } catch (e) { console.warn('[ap intake] auto-code failed:', e.message); }

  // STAFF DIRECTIVE beats the guess. If the Bedrock staffer who forwarded this
  // bill named the account ("code to 5125"), that's an instruction from a
  // colleague, not a suggestion — execute it. staffGl is pre-resolved to THIS
  // community's chart (autoIntake), so it can only ever be a real account. This
  // is the Water Logic #21245 fix: Celina wrote "code to 5125" and Emma still
  // guessed 5120. (Ed 2026-07-31.)
  let codingSignal = 'gl_classifier';
  if (staffGl && staffGl.account_id) {
    coded = { account_id: staffGl.account_id, confidence: 'high', needs_review: false,
      reason: `Staff-directed: code ${staffGl.account_number} ${staffGl.account_name}` };
    codingSignal = 'staff_directive';
  }

  // DEPOSIT invoices: a 50% / progress deposit buys NOTHING yet — it's a PREPAID
  // ASSET, not an expense. Code it to the community's Prepaid Vendor Deposits
  // account so it posts Dr Prepaid / Cr AP (-> Cr Cash on payment). On the
  // completion invoice, staff relieve the prepaid into the project. Held for a
  // human to confirm the treatment. (Ed 2026-08-12: AAA Awning #83793.)
  if (extracted.is_deposit_invoice && !(staffGl && staffGl.account_id)) {
    const { data: dep } = await supabase.from('chart_of_accounts')
      .select('id, account_number, account_name').eq('community_id', communityId).eq('is_active', true)
      .or('account_number.eq.1430,account_name.ilike.%vendor deposit%,account_name.ilike.%prepaid deposit%')
      .order('account_number').limit(1).maybeSingle();
    if (dep && dep.id) {
      const balTxt = extracted.remaining_balance_cents != null ? `$${(extracted.remaining_balance_cents / 100).toFixed(2)}` : '(TBD)';
      coded = { account_id: dep.id, confidence: 'high', needs_review: true,
        reason: `Deposit invoice — prepaid asset (${dep.account_number} ${dep.account_name}), not an expense. Balance ${balTxt} due on completion; reclass to the project then.` };
      codingSignal = 'deposit_prepaid';
    }
  }

  // Decide the approval route NOW and store it, so a manager's queue is a column
  // lookup. Recomputing this live costs ~564ms a bill, which is why nothing was
  // routing bills to managers at all. Non-fatal: a bill with no stored path is
  // treated as manager_review by the queue — unrouted must fail toward MORE
  // scrutiny, never less. (Ed 2026-07-15.)
  let pathRow = {};
  try {
    const { decideApprovalPath } = require('./decide_path');
    pathRow = await decideApprovalPath({
      vendorId, vendorName: extracted.vendor_name || null,
      communityId, totalCents: extracted.total_cents,
    });
  } catch (e) { console.warn('[ap intake] approval path failed:', e.message); }

  const row = {
    ...pathRow,
    community_id: communityId, vendor_id: vendorId,
    vendor_invoice_number: extracted.invoice_number || null,
    invoice_date: extracted.invoice_date, due_date: extracted.due_date || null, terms: extracted.terms || null,
    subtotal_cents: extracted.subtotal_cents || 0, tax_cents: extracted.tax_cents || 0, total_cents: extracted.total_cents,
    account_number: extracted.account_number || null,
    service_period_start: extracted.service_period_start || null, service_period_end: extracted.service_period_end || null,
    status: suspected ? 'on_hold' : 'awaiting_approval',
    dedup_status: suspected ? 'suspected_duplicate' : 'unique',
    duplicate_of_invoice_id: suspected ? matches[0].invoice.id : null,
    intake_method: intakeMethod || 'manual_upload', intake_source_ref: sourceRef || null,
    source_storage_path: storagePath || null, source_filename: extracted._filename || null,
    file_sha256: sha256 || null,
    is_ach_autopay: isAch, ach_confirmed_by_invoice: achConfirmed,
    auto_coded: !!(coded && coded.account_id),
    auto_coding_confidence: (coded && ['high', 'medium', 'low'].includes(coded.confidence)) ? coded.confidence : 'low',
    auto_coding_signal: codingSignal,
    coded_gl_account_id: (coded && coded.account_id) || null,
    classification_reason: (coded && coded.reason) || null,
    // A bill from a vendor we just created is never "clean" — a never-seen payee
    // is the AP fraud surface, so force a human's eye before it can be released.
    needs_review: suspected || !(coded && coded.account_id) || !!(coded && coded.needs_review) || !!extracted._new_vendor,
    notes: suspected
      ? `Emma: possible duplicate of AP ${matches[0].invoice.id} — ${matches[0].reason}. Held for review.`
      : extracted.is_deposit_invoice
        ? `Emma: DEPOSIT invoice (only the deposit is due now) — coded to Prepaid Vendor Deposits (asset), not an expense.${extracted.remaining_balance_cents != null ? ` Balance $${(extracted.remaining_balance_cents / 100).toFixed(2)} due on completion.` : ''} Reclass to the project when it completes. Loaded from ${intakeMethod || 'upload'}.`
        : (isAch
        ? `Emma: paid by auto-draft — record only, do NOT cut a check.${vendorFlag ? ' Vendor is set to ACH auto-pay.' : ' Invoice states it is auto-drafted (do not pay).'} Loaded from ${intakeMethod || 'upload'}.`
        : `Emma: loaded from ${intakeMethod || 'upload'}.`),
  };
  if (convenienceFeeCents > 0) {
    row.notes += ` Added $${(convenienceFeeCents / 100).toFixed(2)} MUD convenience fee (vendor setting) — total includes it.`;
  }

  let { data, error } = await supabase.from('ap_invoices').insert(row).select('id').single();
  // Graceful degrade: if migration 267 (ACH columns) isn't applied yet, strip
  // those fields and load the invoice anyway — never regress the intake over a
  // pending migration. ACH flag simply isn't persisted until 267 lands.
  if (error && /ach_confirmed_by_invoice|is_ach_autopay|coded_gl_account_id|classification_reason|needs_review|account_number|service_period|column .* does not exist/i.test(String(error.message || ''))) {
    delete row.is_ach_autopay; delete row.ach_confirmed_by_invoice;
    delete row.coded_gl_account_id; delete row.classification_reason; delete row.needs_review;
    delete row.account_number; delete row.service_period_start; delete row.service_period_end;
    ({ data, error } = await supabase.from('ap_invoices').insert(row).select('id').single());
  }
  if (error) {
    // The UNIQUE (community, vendor, invoice#) backstop fired — it IS a duplicate.
    if (String(error.message || '').toLowerCase().includes('duplicate') || error.code === '23505') {
      const { data: orig } = await supabase.from('ap_invoices').select('id')
        .eq('community_id', communityId).eq('vendor_id', vendorId).eq('vendor_invoice_number', extracted.invoice_number).maybeSingle();
      return { outcome: 'blocked_duplicate', duplicate_of: orig ? orig.id : null, matches };
    }
    throw error;
  }
  // Persist the invoice's OWN LINES and code each from its own words.
  //
  // The extractor has always read these correctly — five lines on Swim Houston
  // 7316, including a -$1,470 credit, summing exactly to the total — and intake
  // threw them away, coding the whole bill to one account by vendor history. The
  // GL saw one lump, the credit was invisible, and Ed was told to chase a credit
  // that was already applied on the bill. (Ed 2026-07-15: "can you look at
  // invoice to code properly. very sloppy.")
  let codedLines = [];
  try {
    if (Array.isArray(extracted.line_items) && extracted.line_items.length) {
      const { codeInvoiceLines } = require('./code_lines');
      codedLines = await codeInvoiceLines({
        lineItems: extracted.line_items, communityId, vendorId,
        vendorName: extracted.vendor_name || null,
      });
      if (codedLines.length) {
        const rows = codedLines.map((l) => ({
          invoice_id: data.id, line_number: l.line_number, description: l.description.slice(0, 500),
          amount_cents: l.amount_cents, gl_account_id: l.gl_account_id || null,
          notes: l.reason ? String(l.reason).slice(0, 500) : null,
        }));
        const { error: lerr } = await supabase.from('ap_invoice_lines').insert(rows);
        if (lerr) { console.error('[ap intake] line insert failed:', lerr.message); codedLines = []; }
      }
    }
  } catch (e) { console.error('[ap intake] line coding failed:', e.message); codedLines = []; }

  // Auto-post the accrual to the GL (Dr coded expense / Cr A/P) so the bill hits
  // the books with no touch — the only human gate is check approval (Ed 2026-07-11).
  // Only for cleanly-loaded, coded invoices; suspected dups + uncoded ones wait.
  // A fully-coded multi-line bill posts SPLIT across its real accounts; anything
  // less falls back to the single-account accrual rather than posting a lie.
  const everyLineCoded = codedLines.length > 0 && codedLines.every((l) => l.gl_account_id);
  let accrualJeId = null;
  if (!suspected && ((coded && coded.account_id) || everyLineCoded)) {
    accrualJeId = await postAccrualForInvoice({
      invoiceId: data.id, communityId, vendorId, codedAccountId: coded && coded.account_id,
      glLines: everyLineCoded ? codedLines.map((l) => ({ accountId: l.gl_account_id, cents: l.amount_cents, memo: l.description })) : null,
      totalCents: extracted.total_cents, invoiceDate: extracted.invoice_date,
      vendorInvoiceNumber: extracted.invoice_number, vendorName: extracted.vendor_name,
      sourceDocumentId: extracted.source_document_id || null, sourceDocumentPath: storagePath || null,
      classificationReason: everyLineCoded
        ? `Coded line by line from the invoice — ${codedLines.length} lines across ${new Set(codedLines.map((l) => l.gl_account_id)).size} account(s).`
        : ((coded && coded.reason) || null),
    });
  }

  // On a SPLIT bill the invoice-level coded_gl_account_id is a display fallback,
  // not the truth — the truth is the lines. Point it at the biggest charge so the
  // list/detail show something honest rather than whatever the vendor-level guess
  // was, and flag review if any line needs it.
  if (everyLineCoded) {
    const biggest = codedLines.filter((l) => l.amount_cents > 0).sort((a, b) => b.amount_cents - a.amount_cents)[0];
    if (biggest) {
      try {
        await supabase.from('ap_invoices').update({
          coded_gl_account_id: biggest.gl_account_id,
          auto_coded: true,
          needs_review: codedLines.some((l) => l.needs_review),
        }).eq('id', data.id);
      } catch (e) { console.warn('[ap intake] split display-account update:', e.message); }
    }
  }
  return { outcome: suspected ? 'held_suspected_duplicate' : 'loaded', invoice_id: data.id, posting_journal_entry_id: accrualJeId, duplicate_of: suspected ? matches[0].invoice.id : null, matches, lines: codedLines.length };
}

// Post the AP accrual (Dr coded expense / Cr Accounts Payable). Heavily guarded
// + non-fatal: a missing precondition (no coding, no AP account, no open period
// for the invoice date — e.g. a community not yet GL-live) just leaves the
// invoice unposted for review; it never breaks intake or posts a bad entry.
// Posts the accrual. Two shapes:
//   * codedAccountId + totalCents         — the whole bill on one account
//   * glLines: [{accountId, cents, memo}] — the bill SPLIT across accounts, which
//     is what a real invoice usually is. Positive cents debit the expense;
//     NEGATIVE cents (a credit line on the bill) credit it. The AP leg is always
//     the NET — what we actually owe. (Ed 2026-07-15, Swim Houston 7316: four
//     expense accounts and a -$1,470 credit on one bill.)
async function postAccrualForInvoice(a) {
  try {
    const gl = (Array.isArray(a.glLines) ? a.glLines : []).filter((l) => l && l.accountId && Number.isFinite(l.cents) && l.cents !== 0);
    if (gl.length) return await postSplitAccrual(a, gl);
    if (!a.codedAccountId || !a.totalCents || a.totalCents <= 0 || !/^\d{4}-\d{2}-\d{2}/.test(String(a.invoiceDate || ''))) return null;
    let ap = null;
    for (const num of ['20100', '2000']) {
      const { data } = await supabase.from('chart_of_accounts').select('id').eq('community_id', a.communityId).eq('account_number', num).eq('is_active', true).maybeSingle();
      if (data) { ap = data; break; }
    }
    if (!ap) { const { data } = await supabase.from('chart_of_accounts').select('id').eq('community_id', a.communityId).ilike('account_name', '%accounts payable%').eq('is_active', true).limit(1).maybeSingle(); ap = data; }
    if (!ap) { console.warn('[ap intake] no A/P account for community — accrual skipped'); return null; }
    const { postJournalEntry } = require('../accounting/posting');
    const je = await postJournalEntry({
      community_id: a.communityId, posting_date: String(a.invoiceDate).slice(0, 10),
      description: `AP invoice ${a.vendorInvoiceNumber || ''} — ${a.vendorName || 'vendor'}`.trim(),
      source_module: 'ap_invoice', source_reference: a.invoiceId,
      lines: [
        { account_id: a.codedAccountId, debit_cents: a.totalCents, credit_cents: 0, memo: `Invoice ${a.vendorInvoiceNumber || ''}`.trim(), vendor_id: a.vendorId },
        { account_id: ap.id, debit_cents: 0, credit_cents: a.totalCents, memo: `AP — ${a.vendorName || 'vendor'}`.trim(), vendor_id: a.vendorId },
      ],
    });
    try { await supabase.from('journal_entries').update({ source_document_id: a.sourceDocumentId || null, source_document_path: a.sourceDocumentPath || null, classification_reason: a.classificationReason || null }).eq('id', je.entry.id); } catch (_) { /* Phase 1 doc-link cols */ }
    await supabase.from('ap_invoices').update({ posting_journal_entry_id: je.entry.id }).eq('id', a.invoiceId);
    return je.entry.id;
  } catch (e) { console.warn('[ap intake] accrual post skipped:', e.message); return null; }
}

// The split-accrual path. Same A/P account resolution as the single-account
// path — deliberately shared, so the two can't drift on which account is A/P.
async function postSplitAccrual(a, gl) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(a.invoiceDate || ''))) return null;
  const net = gl.reduce((n, l) => n + l.cents, 0);
  if (net <= 0) { console.warn('[ap intake] split accrual net <= 0 — skipped'); return null; }
  // The line amounts are the pre-tax SUBTOTAL — the extractor itemizes the
  // subtotal and parks sales tax (and non-itemized fees) at the header. So the
  // lines must equal (total - tax); if they don't, something was mis-extracted
  // and we must NOT post a plausible-looking wrong entry to the books. (Before
  // the tax was subtracted here, this refused every tax-bearing bill and left it
  // unposted on any line re-code or split — same tax-balance scar as
  // createInvoice, Ed 2026-08-10.)
  const taxCents = Number.isFinite(a.taxCents) ? a.taxCents : 0;
  const creditTotal = Number.isFinite(a.totalCents) ? a.totalCents : net;
  const expectedNet = creditTotal - taxCents;
  if (Number.isFinite(a.totalCents) && Math.abs(net - expectedNet) > 1) {
    console.error(`[ap intake] line sum ${net} != invoice subtotal ${expectedNet} (total ${a.totalCents} - tax ${taxCents}) — refusing to post a split accrual`);
    return null;
  }
  const ap = await findApAccount(a.communityId);
  if (!ap) { console.warn('[ap intake] no A/P account for community — accrual skipped'); return null; }
  const { postJournalEntry } = require('../accounting/posting');
  const lines = gl.map((l) => ({
    account_id: l.accountId,
    debit_cents: l.cents > 0 ? l.cents : 0,
    credit_cents: l.cents < 0 ? -l.cents : 0,   // a credit line on the bill credits the expense
    memo: (l.memo || `Invoice ${a.vendorInvoiceNumber || ''}`).slice(0, 200).trim(),
    vendor_id: a.vendorId,
  }));
  // Fold the header tax (total - net) into the largest expense debit so the JE
  // balances to the invoice TOTAL. Sales tax on a vendor service is part of that
  // expense for the association. Same reconciliation as createInvoice.
  const recon = creditTotal - net;
  if (recon !== 0) {
    let bi = -1;
    for (let i = 0; i < lines.length; i++) { if (lines[i].debit_cents > 0 && (bi < 0 || lines[i].debit_cents > lines[bi].debit_cents)) bi = i; }
    if (bi >= 0) lines[bi].debit_cents += recon;
  }
  lines.push({ account_id: ap.id, debit_cents: 0, credit_cents: creditTotal, memo: `AP — ${a.vendorName || 'vendor'}`.trim(), vendor_id: a.vendorId });
  const je = await postJournalEntry({
    community_id: a.communityId, posting_date: String(a.invoiceDate).slice(0, 10),
    description: `AP invoice ${a.vendorInvoiceNumber || ''} — ${a.vendorName || 'vendor'}`.trim(),
    source_module: 'ap_invoice', source_reference: a.invoiceId, lines,
  });
  try { await supabase.from('journal_entries').update({ source_document_id: a.sourceDocumentId || null, source_document_path: a.sourceDocumentPath || null, classification_reason: a.classificationReason || null }).eq('id', je.entry.id); } catch (_) { /* Phase 1 doc-link cols */ }
  await supabase.from('ap_invoices').update({ posting_journal_entry_id: je.entry.id }).eq('id', a.invoiceId);
  return je.entry.id;
}

async function findApAccount(communityId) {
  for (const num of ['20100', '2000']) {
    const { data } = await supabase.from('chart_of_accounts').select('id').eq('community_id', communityId).eq('account_number', num).eq('is_active', true).maybeSingle();
    if (data) return data;
  }
  const { data } = await supabase.from('chart_of_accounts').select('id').eq('community_id', communityId).ilike('account_name', '%accounts payable%').eq('is_active', true).limit(1).maybeSingle();
  return data || null;
}

// ---- autoIntake: non-interactive channels (email, mail scan) ----------------
// Stage -> resolve -> commit in one shot. Returns the commit outcome, or
// needs_review when the vendor/community/total/date can't be resolved without a
// human. Best-effort: callers should never let this throw into their own flow.
async function autoIntake({ buffer, filename, intakeMethod, sourceRef, communityId, vendorIdHint, achHintText, communityHint, staffNote, staffSenderEmail }) {
  const { extracted, sha256, storagePath } = await stageInvoice(buffer, filename);
  if (!extracted.looks_like_invoice) return { outcome: 'not_an_invoice', extracted };

  // STAFF DIRECTIVES — when a Bedrock colleague forwarded this bill to emma@ with
  // instructions ("for Waterview Estates, vendor is Water Logic, code to 5125"),
  // that note is an order to execute, not a hint to weigh. Only internal senders
  // count (a vendor must not be able to direct its own coding). Community + vendor
  // are parsed here; the GL account is matched after the community is known (its
  // chart is per-community). (Ed 2026-07-31.)
  const isStaffSender = /@bedrocktx\.com$/i.test(String(staffSenderEmail || '').trim().toLowerCase());
  let directives = { applies: false };
  if (isStaffSender && staffNote && String(staffNote).trim()) {
    try {
      const { parseStaffDirectives } = require('./staff_directives');
      const { data: comms } = await supabase.from('communities').select('id, name').limit(1000);
      directives = parseStaffDirectives({ text: staffNote, accounts: [], communities: comms || [], isStaffSender: true });
    } catch (e) { console.warn('[ap intake] staff directive parse failed:', e.message); }
  }

  const v = await resolveVendor({ name: extracted.vendor_name, email: extracted.vendor_email });
  // The invoice's OWN vendor name is the authoritative signal for who to pay —
  // same per-invoice rule as community resolution below. Fall back to the
  // email-level hint (the sender's resolved vendor) ONLY when the bill names no
  // vendor of its own. Trusting a shared email-level guess over the invoice's
  // clearly-printed payee mis-booked a Water Logic bill to Sweetwater Pools (a
  // retired vendor the email resolver fuzzy-matched on the word "water"). When
  // the invoice DOES name a vendor we can't match, the right move is to CREATE
  // that vendor from the bill (flagged NEW, below) — never to snap to an
  // unrelated existing payee. A wrong-but-real vendor reads as legitimate to an
  // approver; a NEW-vendor flag gets a human's eye. (Ed 2026-07-31)
  if (!v.vendor && vendorIdHint && !(extracted.vendor_name && extracted.vendor_name.trim())) {
    v.vendor = { id: vendorIdHint };
  }
  // A staffer who named the vendor ("vendor is Water Logic") gives us a second
  // way to match an EXISTING record before we create a new one — catches the
  // vendor already on file under a spelling closer to the note than to the bill.
  if (!v.vendor && directives.applies && directives.vendor_name) {
    try { const sv = await resolveVendor({ name: directives.vendor_name }); if (sv.vendor) v.vendor = sv.vendor; }
    catch (e) { console.warn('[ap intake] staff vendor resolve failed:', e.message); }
  }

  // Still unnamed? An AP clerk doesn't bounce the bill — she sets the vendor up
  // from the invoice in front of her. ensureVendorForInvoice resolves uniquely,
  // reports an ambiguity (our list has duplicates → dedupe, don't guess), or
  // CREATES the vendor from the invoice, flagged NEW so a first payment gets a
  // human's eye. Creating the record isn't paying — the bill still lands in
  // payables for Ed's approval. Lazy require: vendor_master imports normName from
  // this file. (Ed 2026-07-15: "emma is an AP professional she should do this".)
  let newVendorCreated = false;
  if (!v.vendor) {
    try {
      const { ensureVendorForInvoice } = require('./vendor_master');
      const e = await ensureVendorForInvoice({ extracted, actor: 'Emma (AP)' });
      if (e.vendor) { v.vendor = e.vendor; newVendorCreated = !!e.created; }
      else if (e.ambiguous) return { outcome: 'needs_review', reason: e.reason, extracted, storage_path: storagePath, sha256 };
    } catch (err) { console.warn('[ap intake] ensureVendorForInvoice failed:', err.message); }
  }

  // The bill's OWN bill-to association is the most authoritative signal for which
  // community it belongs to. A utility vendor (NRG, water districts) bills MANY
  // associations, and staff scan a whole stack into ONE email — so the email-level
  // community (passed in as communityId) must NOT override each bill's own bill-to,
  // or every bill in the batch inherits the first one's community. (Ed 2026-07-28:
  // 11 NRG bills for Still Creek Ranch / Lakes of Pine Forest booked to Canyon
  // Gate because the scanned email resolved to Canyon Gate and overrode every
  // attachment.) Read the PDF first; fall back to the caller's community only when
  // the bill names none. This is the multi-community-vendor rule from CLAUDE.md:
  // resolve per-invoice from the PDF, never by a shared email/remit context.
  let cid = null; let cidSource = null;
  const fromPdf = await resolveCommunity(extracted.community_hint);
  if (fromPdf.community) { cid = fromPdf.community.id; cidSource = 'pdf'; }
  // A staffer's explicit "for <community>" ranks above the generic email-level
  // community (the batch-inheritance risk), but below the bill's own bill-to.
  if (!cid && directives.applies && directives.community) { cid = directives.community.id; cidSource = 'directive'; }
  if (!cid && communityId) { cid = communityId; cidSource = 'email'; }
  if (!cid && communityHint) { const c = await resolveCommunity(communityHint); if (c.community) { cid = c.community.id; cidSource = 'hint'; } }
  if (!v.vendor || !cid) return { outcome: 'needs_review', reason: !v.vendor ? 'vendor not matched' : 'association not matched', extracted, storage_path: storagePath, sha256 };

  // Multi-community-vendor guard: the bill did NOT name its own community (no PDF
  // match), so we fell back to the shared email/default community — and for a
  // vendor that serves SEVERAL communities that fallback is a guess, which is
  // exactly how a Quail Ridge bill lands in Waterview (Superior LawnCare #43444,
  // Ed 2026-08-12). When the community wasn't read from the bill itself and this
  // vendor already has bills in more than one community, hold it for review
  // rather than silently guessing the wrong one.
  if ((cidSource === 'email' || cidSource === 'hint') && v.vendor && v.vendor.id) {
    const { data: prevComms } = await supabase.from('ap_invoices').select('community_id').eq('vendor_id', v.vendor.id).not('community_id', 'is', null).limit(100);
    const distinct = new Set((prevComms || []).map((r) => r.community_id));
    if (distinct.size > 1) {
      return { outcome: 'needs_review', reason: 'multi-community vendor — the bill did not name its community; confirm which one before it posts', extracted, storage_path: storagePath, sha256 };
    }
  }
  if (newVendorCreated) { extracted._new_vendor = true; }  // carry the flag so commit can surface it

  // Resolve the staff GL directive against THIS community's chart (accounts are
  // per-community, so it must wait until the community is known). matchGlDirective
  // can only return a real account on that chart. (Ed 2026-07-31.)
  let staffGl = null;
  if (directives.applies && cid) {
    try {
      const { data: accts } = await supabase.from('chart_of_accounts').select('id, account_number, account_name').eq('community_id', cid).eq('is_active', true).limit(2000);
      const { matchGlDirective } = require('./staff_directives');
      staffGl = matchGlDirective(staffNote, accts || []);
    } catch (e) { console.warn('[ap intake] staff GL match failed:', e.message); }
  }

  const commit = await commitInvoice({ extracted, vendorId: v.vendor.id, communityId: cid, sha256, storagePath, intakeMethod, sourceRef, achHintText, staffGl });
  // Carry the staged PDF + extraction on a needs_review passthrough (a bill with
  // no total/date) so the inbox->exceptions capture can hold it with its document,
  // not just a reason string. (Ed 2026-08-01.)
  if (commit && commit.outcome === 'needs_review') return { ...commit, extracted, storage_path: storagePath, sha256 };
  return commit;
}

module.exports = { stageInvoice, resolveVendor, resolveCommunity, commitInvoice, autoIntake, normName, postAccrualForInvoice };
