// ============================================================================
// lib/payments/check_receipts.js  (Ed 2026-10-12)
// ----------------------------------------------------------------------------
// Scanned homeowner checks: read -> match -> (staff confirm) -> record once ->
// deposit (bank confirmation) -> reconcile (bank line) | return.
//
// Reuses the existing machinery; builds no parallel ledger:
//   * images         library_documents + storage bucket 'documents'
//   * reading        Claude document/image read (lib/ap/bill_files contentBlockFor),
//                    workflow 'payments.check_extract' (high consequence)
//   * identity       properties.trusted_account_number, ownership_tenures, the
//                    current-owner view, lib/entity_resolution name/address normalizers
//   * ledger         post_check_receipt_payment (mig 514), the same 209.0063 order and
//                    draft-until-GL pattern as Stripe payments (mig 469)
//   * GL             lib/accounting/posting.js postJournalEntry, accounts by role
//                    (community_account_roles: undeposited_funds, operating_cash, homeowner_ar)
//
// Controls:
//   * A scan is never proof of a deposit. Cash moves only on a recorded bank confirmation.
//   * The payer name alone never matches a homeowner. A match needs corroboration, and an
//     ambiguous one is held (status 'exception'), never guessed.
//   * Every check is recorded once: same image, same MICR (routing + account + number),
//     same community + check number + amount, or a same-amount payment already on the
//     homeowner ledger near that date (a Vantaca import, a closing payoff, an online
//     payment) blocks or holds it.
//   * The full bank account number is never stored: last 4 + a SHA-256 fingerprint.
// ============================================================================
const crypto = require('crypto');

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const LEDGER_DUP_WINDOW_DAYS = 14;
const RECORDED = ['recorded', 'deposited', 'reconciled'];
// Community management status (lib/community/lifecycle): an archived / ended community gets no
// new financial activity. Reading its records is never gated.
const financialsGate = (communityId, what) => require('../community/lifecycle').assertCanDo('financials', communityId, what);
const OPEN_FOR_DUPES = ['scanned', 'matched', 'recorded', 'deposited', 'reconciled', 'exception'];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
const must = async (q, what) => { const { data, error } = await q; if (error) throw Object.assign(new Error(`${what}: ${error.message}`), { code: error.code }); return data; };
const todayCentral = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const money = (c) => `$${(Math.round(Number(c) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---------------------------------------------------------------------------
// 1) Reading the check
// ---------------------------------------------------------------------------
const PROMPT = `You are reading a paper CHECK that a homeowner mailed to their homeowners
association. You are given the FRONT of the check and, when available, the BACK. Extract
ONLY what is printed or handwritten. Never guess a digit. Return JSON exactly of this shape
(no prose, no markdown fence):

{
  "is_check": true,
  "check_number": "string as printed (top right, and in the MICR line), or null",
  "check_date": "YYYY-MM-DD, or null",
  "amount_numeric": "the numeric (courtesy) amount, e.g. 414.53, or null",
  "amount_written": "the written (legal) amount line exactly as written, or null",
  "amount_written_value": "the written amount as a number, e.g. 414.53, or null",
  "payer_name": "the account holder name printed top left, or null",
  "payer_address": "the payer address printed under the name, one line, or null",
  "payee_name": "the Pay to the order of line, or null",
  "memo": "the memo / for line, or null",
  "written_account_number": "any HOA account number, lot or property reference the payer wrote (memo, face, or back), or null",
  "property_address_written": "any street address of the property written in the memo or elsewhere (NOT the printed payer address), or null",
  "micr_routing": "9-digit routing number from the MICR line, or null",
  "micr_account": "bank account number from the MICR line (digits only), or null",
  "micr_check_number": "check number from the MICR line, or null",
  "signed": true,
  "back_endorsed": "true if the back shows an endorsement / deposit stamp, false if blank, null if no back image",
  "legibility": "clear | partial | poor",
  "notes": "anything unusual (altered, two different amounts, stale date, post-dated), or null"
}`;

function toCents(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

// The model's answer -> the receipt's fields. Pure. The full bank account number is
// used only to compute the fingerprint and is never returned.
function normalizeCheckExtraction(p) {
  const x = p || {};
  const routing = digits(x.micr_routing);
  const account = digits(x.micr_account);
  const printedNum = digits(x.check_number);
  const micrNum = digits(x.micr_check_number);
  const checkNumber = printedNum || micrNum || null;
  const numeric = toCents(x.amount_numeric);
  const written = toCents(x.amount_written_value);
  const issues = [];
  if (x.is_check === false) issues.push('not_a_check');
  if (numeric != null && written != null && numeric !== written) issues.push('amounts_disagree');
  if (printedNum && micrNum && printedNum.replace(/^0+/, '') !== micrNum.replace(/^0+/, '')) issues.push('check_number_mismatch');
  if (!checkNumber) issues.push('no_check_number');
  if (numeric == null && written == null) issues.push('no_amount');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x.check_date || ''))) issues.push('no_date');
  if (x.signed === false) issues.push('unsigned');
  if (x.legibility === 'poor') issues.push('poor_legibility');
  const fingerprint = routing.length === 9 && account.length >= 4 && checkNumber ? sha256(`${routing}|${account}|${checkNumber.replace(/^0+/, '')}`) : null;
  return {
    check_number: checkNumber,
    // The written (legal) amount governs a check; when the two disagree the receipt is held.
    amount_cents: written != null ? written : numeric,
    check_date: /^\d{4}-\d{2}-\d{2}$/.test(String(x.check_date || '')) ? x.check_date : null,
    payer_name: x.payer_name ? String(x.payer_name).trim() : null,
    payer_address: x.payer_address ? String(x.payer_address).trim() : null,
    payee_name: x.payee_name ? String(x.payee_name).trim() : null,
    memo: x.memo ? String(x.memo).trim() : null,
    written_account_number: digits(x.written_account_number) || null,
    property_address_written: x.property_address_written ? String(x.property_address_written).trim() : null,
    routing_number: routing.length === 9 ? routing : null,
    account_last4: account.length >= 4 ? account.slice(-4) : null,
    micr_fingerprint: fingerprint,
    issues,
  };
}

async function extractCheck({ front, back }) {
  const { route: aiRoute } = require('../ai/router');
  const Anthropic = require('../ai/anthropic');
  const { contentBlockFor } = require('../ap/bill_files');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const blocks = [{ type: 'text', text: 'FRONT of the check:' }, contentBlockFor(front)];
  if (back) blocks.push({ type: 'text', text: 'BACK of the check:' }, contentBlockFor(back));
  blocks.push({ type: 'text', text: PROMPT });
  const resp = await anthropic.messages.create({ model: aiRoute('payments.check_extract'), max_tokens: 1500, messages: [{ role: 'user', content: blocks }] });
  const text = (resp.content && resp.content[0] && resp.content[0].text) || '';
  let raw;
  try { raw = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()); }
  catch (e) { throw Object.assign(new Error(`check read returned malformed JSON: ${e.message}`), { code: 'extract_failed' }); }
  // Log what the reader said, without the bank account number.
  const { micr_account, ...loggable } = raw;
  console.log('[payments.check_extract] model returned:', JSON.stringify({ ...loggable, micr_account: micr_account ? `***${digits(micr_account).slice(-4)}` : null }));
  const raw_extracted = { ...raw, micr_account: micr_account ? `***${digits(micr_account).slice(-4)}` : null };
  return { ...normalizeCheckExtraction(raw), raw_extracted };
}

// ---------------------------------------------------------------------------
// 2) Matching the check to an association and an owner account
// ---------------------------------------------------------------------------
const tokens = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !['the', 'inc', 'homeowners', 'association', 'owners', 'hoa', 'community', 'property', 'llc', 'and', 'for'].includes(w));

// Which community does the payee line name? Pure: returns {community_id, score} for the best.
function payeeCommunity(payee, communities) {
  const p = new Set(tokens(payee));
  if (!p.size) return null;
  let best = null;
  for (const c of communities || []) {
    const names = [c.hoa_legal_name, c.legal_name, c.name].filter(Boolean);
    for (const n of names) {
      const t = tokens(n); if (!t.length) continue;
      const hit = t.filter((w) => p.has(w)).length / t.length;
      if (!best || hit > best.score) best = { community_id: c.id, name: c.name, score: hit };
    }
  }
  return best && best.score > 0 ? best : null;
}

// Score candidates. Pure. A candidate: { property_id, tenure_id, street_address, owner_names[],
// mailing_street, trusted_account_number, vantaca_account_ids[], balance_cents, micr_history }.
// Strong signals tie the CHECK to the ACCOUNT (an account number, the property address the
// payer wrote, this exact bank account paid this account before). Medium signals tie the
// PAYER to the OWNER (name equivalence, the printed address is the owner's or the lot's).
// The payer name alone is one medium signal and never enough.
function scoreCandidates(check, candidates, helpers) {
  const { namesAreEquivalent, normalizeAddress } = helpers;
  const street = (s) => (normalizeAddress(s) || {}).canonical || null;
  const writtenAcct = digits(check.written_account_number);
  const writtenStreet = street(check.property_address_written) || street(check.memo);
  const payerStreet = street(check.payer_address);
  const out = [];
  for (const c of candidates || []) {
    const ev = [];
    const accts = [c.trusted_account_number, ...(c.vantaca_account_ids || [])].map(digits).filter(Boolean);
    if (writtenAcct && accts.includes(writtenAcct)) ev.push({ signal: 'account_number', strength: 'strong', detail: `Account number ${writtenAcct} written on the check is this account` });
    if (c.micr_history) ev.push({ signal: 'bank_account_history', strength: 'strong', detail: 'This bank account paid this owner account before (prior recorded check)' });
    const lot = street(c.street_address);
    if (writtenStreet && lot && writtenStreet === lot) ev.push({ signal: 'property_address_written', strength: 'strong', detail: `Property address written on the check: ${c.street_address}` });
    if (payerStreet && lot && payerStreet === lot) ev.push({ signal: 'payer_address_is_lot', strength: 'medium', detail: 'The address printed on the check is this lot' });
    else if (payerStreet && street(c.mailing_street) && payerStreet === street(c.mailing_street)) ev.push({ signal: 'payer_address_is_mailing', strength: 'medium', detail: "The address printed on the check is the owner's mailing address" });
    const names = (c.owner_names || []).filter(Boolean);
    const payerParts = String(check.payer_name || '').split(/\s*(?:&|\band\b|\bor\b|\/)\s*/i).map((s) => s.trim()).filter(Boolean);
    const lastOf = (n) => String(n).trim().split(/\s+/).pop().toLowerCase().replace(/[^a-z]/g, '');
    if (payerParts.some((p) => names.some((n) => namesAreEquivalent(p, n)))) ev.push({ signal: 'payer_name', strength: 'medium', detail: 'Payer name matches an owner of record' });
    else if (payerParts.some((p) => names.some((n) => lastOf(p) && lastOf(p) === lastOf(n)))) ev.push({ signal: 'payer_last_name', strength: 'weak', detail: 'Payer last name matches an owner of record' });
    if (check.amount_cents && c.balance_cents && check.amount_cents === c.balance_cents) ev.push({ signal: 'amount_equals_balance', strength: 'weak', detail: `Amount equals the account balance (${money(c.balance_cents)})` });
    const strong = ev.filter((e) => e.strength === 'strong').length;
    const medium = ev.filter((e) => e.strength === 'medium').length;
    const confidence = (strong >= 2 || (strong >= 1 && medium >= 1)) ? 'high' : (strong === 1 || medium >= 2) ? 'medium' : ev.length ? 'low' : 'none';
    out.push({ ...c, evidence: ev, confidence, score: strong * 10 + medium * 3 + (ev.length - strong - medium) });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// The proposal. Pure. Matched only with a unique high/medium candidate; anything else is held.
function decideMatch(scored) {
  const viable = (scored || []).filter((c) => c.confidence === 'high' || c.confidence === 'medium');
  if (!viable.length) return { status: 'exception', reason: scored && scored.length ? 'No candidate has enough corroborating evidence (the payer name alone is not a match). Choose the account.' : 'No matching homeowner account found. Choose the account.' };
  const [top, next] = viable;
  if (next && (next.confidence === top.confidence || next.score >= top.score - 2)) return { status: 'exception', reason: `Ambiguous: ${viable.length} accounts fit (${viable.slice(0, 3).map((c) => c.street_address).join('; ')}). Choose the account.` };
  if (!top.tenure_id) return { status: 'exception', reason: `${top.street_address} has no current owner account (tenure). Resolve ownership first.` };
  return { status: 'matched', property_id: top.property_id, tenure_id: top.tenure_id, confidence: top.confidence, evidence: top.evidence };
}

async function loadCandidates(supabase, communityId, check) {
  const { fetchAllQuery } = require('../db/fetch_all');
  const { normalizeAddress } = require('../entity_resolution');
  const street = (s) => (normalizeAddress(s) || {}).canonical || null;
  const ids = new Set();
  const acct = digits(check.written_account_number);
  if (acct) {
    for (const r of await must(supabase.from('properties').select('id').eq('community_id', communityId).or(`trusted_account_number.eq.${acct},vantaca_account_id.eq.${acct}`).limit(5), 'properties by account')) ids.add(r.id);
    for (const r of await must(supabase.from('ownership_tenures').select('property_id').eq('community_id', communityId).eq('vantaca_account_id', acct).limit(5), 'tenures by account')) if (r.property_id) ids.add(r.property_id);
  }
  const micrProps = new Set();
  if (check.micr_fingerprint) {
    for (const r of await must(supabase.from('homeowner_check_receipts').select('property_id').eq('community_id', communityId).eq('micr_fingerprint', check.micr_fingerprint).in('status', [...RECORDED, 'returned']).limit(10), 'micr history')) if (r.property_id) { ids.add(r.property_id); micrProps.add(r.property_id); }
  }
  const owners = await fetchAllQuery(() => supabase.from('v_current_property_owners').select('property_id, owner_name, owner_mailing_street, street_address').eq('community_id', communityId), { orderBy: 'property_id' });
  const wantStreets = [street(check.property_address_written), street(check.memo), street(check.payer_address)].filter(Boolean);
  const payerLast = String(check.payer_name || '').split(/\s*(?:&|\band\b)\s*/i).map((p) => p.trim().split(/\s+/).pop().toLowerCase()).filter((x) => x && x.length >= 2);
  for (const o of owners) {
    if (wantStreets.length && (wantStreets.includes(street(o.street_address)) || wantStreets.includes(street(o.owner_mailing_street)))) ids.add(o.property_id);
    const ownerLasts = String(o.owner_name || '').split(/\s*(?:&|\band\b|,)\s*/i).map((p) => p.trim().split(/\s+/).pop().toLowerCase());
    if (payerLast.some((l) => ownerLasts.includes(l))) ids.add(o.property_id);
  }
  const list = [...ids].slice(0, 25);
  if (!list.length) return [];
  const props = await must(supabase.from('properties').select('id, street_address, trusted_account_number, vantaca_account_id').in('id', list), 'properties');
  const tens = await must(supabase.from('ownership_tenures').select('id, property_id, vantaca_account_id, end_date, kind').in('property_id', list).eq('kind', 'owner').is('end_date', null), 'current tenures');
  const ob = await require('../ar/owner_balance').ownerBalancesForProperties(supabase, list);   // THE homeowner balance
  const bals = Object.values(ob).map((b) => ({ property_id: b.property_id, balance_cents: b.net_due_cents }));
  return props.map((p) => {
    const t = tens.filter((x) => x.property_id === p.id);
    const os = owners.filter((o) => o.property_id === p.id);
    return {
      property_id: p.id, tenure_id: t.length === 1 ? t[0].id : null, street_address: p.street_address,
      owner_names: os.flatMap((o) => String(o.owner_name || '').split(/\s*(?:&|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean)),
      mailing_street: (os[0] || {}).owner_mailing_street || null, trusted_account_number: p.trusted_account_number,
      vantaca_account_ids: [p.vantaca_account_id, ...t.map((x) => x.vantaca_account_id)].filter(Boolean),
      balance_cents: Number((bals.find((b) => b.property_id === p.id) || {}).balance_cents || 0), micr_history: micrProps.has(p.id),
    };
  });
}

// ---------------------------------------------------------------------------
// 3) Duplicates
// ---------------------------------------------------------------------------
// Pure classification of what the loader found. 'blocking' stops a receipt; 'possible'
// holds it until staff record a reason.
function classifyDuplicates({ check, sameImage = [], sameMicr = [], sameNumber = [], ledger = [], manual = [] }) {
  const f = [];
  for (const r of sameImage) f.push({ kind: 'same_image', severity: 'blocking', receipt_id: r.id, detail: `This image was already scanned (receipt ${String(r.id).slice(0, 8)}, ${r.status}).` });
  for (const r of sameMicr) f.push({ kind: 'same_check', severity: 'blocking', receipt_id: r.id, detail: `This check (same bank account and number) is already receipt ${String(r.id).slice(0, 8)} (${r.status}).` });
  for (const r of sameNumber) {
    if (check.account_last4 && r.account_last4 && check.account_last4 !== r.account_last4) continue;
    f.push({ kind: 'same_number_amount', severity: 'blocking', receipt_id: r.id, detail: `Check #${r.check_number} for ${money(r.amount_cents)} is already receipt ${String(r.id).slice(0, 8)} (${r.status}).` });
  }
  for (const t of ledger) {
    const src = (t.raw_row_jsonb && t.raw_row_jsonb.source) || 'import';
    if (src === 'check_receipt' && check.id && t.raw_row_jsonb.check_receipt_id === check.id) continue;
    f.push({ kind: 'ledger_payment', severity: 'possible', homeowner_txn_id: t.id, detail: `A ${money(-t.amount_cents)} payment is already on this account on ${t.transaction_date} (${src === 'closing_payoff' ? 'closing payoff' : src === 'stripe_payment' ? 'online payment' : src === 'check_receipt' ? 'recorded check' : 'imported from Vantaca'}: "${t.description || ''}").` });
  }
  // The older Record payment form (lib/accounting/record_payment.js) writes ar_payments, not
  // the homeowner ledger: a same-amount payment there is a possible duplicate too.
  for (const p of manual) f.push({ kind: 'manual_payment', severity: 'possible', ar_payment_id: p.id, detail: `A ${money(p.amount_cents)} payment was entered by hand on ${p.payment_date}${p.source_reference ? ` (ref ${p.source_reference})` : ''}.` });
  return f;
}

async function findDuplicates(supabase, check) {
  const ex = (rows) => (rows || []).filter((r) => r.id !== check.id);
  const sameImage = check.front_sha256 ? ex(await must(supabase.from('homeowner_check_receipts').select('id, status').eq('front_sha256', check.front_sha256).in('status', OPEN_FOR_DUPES).limit(5), 'image dupes')) : [];
  const sameMicr = check.micr_fingerprint ? ex(await must(supabase.from('homeowner_check_receipts').select('id, status').eq('community_id', check.community_id).eq('micr_fingerprint', check.micr_fingerprint).in('status', OPEN_FOR_DUPES).limit(5), 'micr dupes')) : [];
  const sameNumber = check.check_number && check.amount_cents ? ex(await must(supabase.from('homeowner_check_receipts').select('id, status, check_number, amount_cents, account_last4').eq('community_id', check.community_id).eq('check_number', check.check_number).eq('amount_cents', check.amount_cents).in('status', OPEN_FOR_DUPES).limit(5), 'number dupes')) : [];
  let ledger = [];
  if (check.property_id && check.amount_cents) {
    const d0 = check.received_date || todayCentral();
    const rows = await must(supabase.from('homeowner_transactions').select('id, transaction_date, description, amount_cents, raw_row_jsonb, transaction_upload_batches!inner(status)')
      .eq('community_id', check.community_id).eq('property_id', check.property_id).eq('amount_cents', -check.amount_cents)
      .gte('transaction_date', addDays(d0, -LEDGER_DUP_WINDOW_DAYS)).lte('transaction_date', addDays(d0, LEDGER_DUP_WINDOW_DAYS))
      .eq('transaction_upload_batches.status', 'committed').limit(10), 'ledger dupes');
    ledger = rows;
  }
  let manual = [];
  if (check.property_id && check.amount_cents) {
    const d0 = check.received_date || todayCentral();
    manual = await must(supabase.from('ar_payments').select('id, payment_date, amount_cents, source_reference, status').eq('property_id', check.property_id).eq('amount_cents', check.amount_cents)
      .gte('payment_date', addDays(d0, -LEDGER_DUP_WINDOW_DAYS)).lte('payment_date', addDays(d0, LEDGER_DUP_WINDOW_DAYS)).neq('status', 'voided').limit(10), 'manual payments');
  }
  return classifyDuplicates({ check, sameImage, sameMicr, sameNumber, ledger, manual });
}

// ---------------------------------------------------------------------------
// 4) Intake: store images, read, match, check duplicates -> a receipt row
// ---------------------------------------------------------------------------
async function storeImage(supabase, { communityId, file }) {
  const sha = sha256(file.buffer);
  const existing = await must(supabase.from('library_documents').select('id').eq('file_hash', sha).limit(1), 'existing image');
  if (existing.length) return { id: existing[0].id, sha };
  const ext = (file.mediaType || '').includes('pdf') ? 'pdf' : (file.mediaType || '').includes('png') ? 'png' : 'jpg';
  const path = `homeowner-checks/${communityId}/${sha.slice(0, 16)}.${ext}`;
  const { error: upErr } = await supabase.storage.from('documents').upload(path, file.buffer, { contentType: file.mediaType || 'application/octet-stream', upsert: false });
  if (upErr && !/exists/i.test(upErr.message)) throw upErr;
  const comm = await must(supabase.from('communities').select('management_company_id').eq('id', communityId).single(), 'community');
  const doc = await must(supabase.from('library_documents').insert({
    management_company_id: comm.management_company_id, community_id: communityId, category: 'homeowner_check',
    title: `Homeowner check image ${sha.slice(0, 8)}`, file_name_original: file.name || null, file_path: path, file_hash: sha,
    file_size_bytes: file.buffer.length, created_by_mgmt_company: 'Bedrock', source_origin: 'library', uploaded_at: new Date().toISOString(),
  }).select('id').single(), 'image record');
  return { id: doc.id, sha };
}

function fileFrom(upload) {
  if (!upload || !upload.buffer) return null;
  if (upload.buffer.length > MAX_FILE_BYTES) throw Object.assign(new Error(`${upload.originalname || 'file'} is larger than 15 MB`), { code: 'too_large' });
  const mt = upload.mimetype || '';
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mt) && mt !== 'application/pdf') throw Object.assign(new Error(`${upload.originalname || 'file'} is not an image or PDF`), { code: 'bad_type' });
  return { name: upload.originalname, buffer: upload.buffer, mediaType: mt, kind: mt === 'application/pdf' ? 'pdf' : 'image' };
}

// A scanned PDF is one check per page (front only). Pages are split deterministically (fixed
// metadata) so the same scan always produces the same page bytes, and the duplicate-image
// guard catches a re-upload. A single page or an image passes through unchanged.
const MAX_PAGES = 50;
async function splitUpload(upload) {
  if (!upload || !upload.buffer) return [];
  if ((upload.mimetype || '') !== 'application/pdf') return [upload];
  const { PDFDocument } = require('pdf-lib');
  let doc;
  try { doc = await PDFDocument.load(upload.buffer); } catch (e) { throw Object.assign(new Error(`${upload.originalname || 'PDF'} could not be opened (damaged or password-protected); rescan it`), { code: 'bad_type' }); }
  const n = doc.getPageCount();
  if (n <= 1) return [upload];
  if (n > MAX_PAGES) throw Object.assign(new Error(`${upload.originalname || 'PDF'} has ${n} pages; scan at most ${MAX_PAGES} checks per file`), { code: 'too_large' });
  const out = [];
  for (let i = 0; i < n; i++) {
    const one = await PDFDocument.create();
    const [pg] = await one.copyPages(doc, [i]);
    one.addPage(pg);
    one.setCreationDate(new Date(0)); one.setModificationDate(new Date(0)); one.setProducer('trustEd'); one.setCreator('trustEd');
    out.push({ buffer: Buffer.from(await one.save({ useObjectStreams: false })), mimetype: 'application/pdf', originalname: `${upload.originalname || 'scan.pdf'} (page ${i + 1} of ${n})`, page: i + 1, pages: n });
  }
  return out;
}

// Attach the back of a check later (deposit documentation, a dispute, a returned check).
// Evidence only: no status, ledger or GL change. An existing back is never overwritten.
async function attachBack(supabase, receiptId, { back, actor }) {
  const f = fileFrom(back);
  if (!f) throw Object.assign(new Error('choose the image or PDF of the back'), { code: 'invalid_input' });
  const rc = await must(supabase.from('homeowner_check_receipts').select('id, community_id, back_document_id, front_sha256').eq('id', receiptId).single(), 'receipt');
  if (rc.back_document_id) throw Object.assign(new Error('A back is already attached to this check.'), { code: 'conflict' });
  const img = await storeImage(supabase, { communityId: rc.community_id, file: f });
  if (img.sha === rc.front_sha256) throw Object.assign(new Error('That is the same image as the front.'), { code: 'invalid_input' });
  return must(supabase.from('homeowner_check_receipts').update({ back_document_id: img.id, back_sha256: img.sha, updated_at: new Date().toISOString() }).eq('id', receiptId).is('back_document_id', null).select('id, back_document_id').single(), `attach back (${actor})`);
}

async function intakeCheck(supabase, { communityId, front, back, scanBatchId, actor, extract = extractCheck, gate = financialsGate }) {
  await gate(communityId, 'Scanning a check');
  const { namesAreEquivalent, normalizeAddress } = require('../entity_resolution');
  const f = fileFrom(front); const b = fileFrom(back);
  if (!f) throw Object.assign(new Error('front image required'), { code: 'invalid_input' });
  const frontSha = sha256(f.buffer);
  const already = await must(supabase.from('homeowner_check_receipts').select('id, status').eq('front_sha256', frontSha).in('status', OPEN_FOR_DUPES).limit(1), 'image check');
  if (already.length) return { duplicate: true, receipt_id: already[0].id, status: already[0].status, detail: 'This image was already scanned.' };

  const x = await extract({ front: f, back: b });
  const img = await storeImage(supabase, { communityId, file: f });
  const bimg = b ? await storeImage(supabase, { communityId, file: b }) : null;

  const comms = await must(supabase.from('communities').select('id, name, legal_name, hoa_legal_name'), 'communities');
  const payee = payeeCommunity(x.payee_name, comms);
  const received = todayCentral();
  let status = 'scanned'; let reason = null; let match = { evidence: [], candidates: [] };
  const holds = [];
  if (x.issues.includes('not_a_check')) holds.push('This image does not look like a check.');
  if (x.issues.includes('amounts_disagree')) holds.push('The numeric and written amounts disagree; confirm the amount (the written amount governs).');
  if (x.issues.includes('check_number_mismatch')) holds.push('The printed check number and the MICR check number disagree.');
  if (x.issues.includes('no_amount')) holds.push('No amount could be read.');
  if (x.issues.includes('no_check_number')) holds.push('No check number could be read.');
  if (x.issues.includes('no_date')) holds.push('No check date could be read.');
  if (x.issues.includes('unsigned')) holds.push('The check appears unsigned.');
  if (x.check_date && x.check_date > received) holds.push(`Post-dated check (${x.check_date}); it cannot be recorded before that date.`);
  if (payee && payee.community_id !== communityId && payee.score >= 0.6) holds.push(`The check is payable to ${payee.name}, not this association.`);

  const scored = scoreCandidates(x, await loadCandidates(supabase, communityId, x), { namesAreEquivalent, normalizeAddress });
  const decision = decideMatch(scored);
  match = { candidates: scored.slice(0, 5).map((c) => ({ property_id: c.property_id, tenure_id: c.tenure_id, street_address: c.street_address, owner_names: c.owner_names, confidence: c.confidence, evidence: c.evidence, balance_cents: c.balance_cents })) };
  if (decision.status === 'matched' && !holds.length) { status = 'matched'; }
  else { status = 'exception'; reason = [...holds, decision.status === 'exception' ? decision.reason : null].filter(Boolean).join(' '); }

  const row = {
    community_id: communityId, scan_batch_id: scanBatchId, status, exception_reason: reason,
    front_document_id: img.id, back_document_id: bimg ? bimg.id : null, front_sha256: img.sha, back_sha256: bimg ? bimg.sha : null,
    check_number: x.check_number, amount_cents: x.amount_cents, check_date: x.check_date, received_date: received,
    payer_name: x.payer_name, payer_address: x.payer_address, payee_name: x.payee_name, memo: x.memo,
    written_account_number: x.written_account_number, routing_number: x.routing_number, account_last4: x.account_last4, micr_fingerprint: x.micr_fingerprint,
    extracted: { ...x.raw_extracted, issues: x.issues, payee_community: payee },
    property_id: decision.status === 'matched' ? decision.property_id : null, tenure_id: decision.status === 'matched' ? decision.tenure_id : null,
    match_confidence: decision.status === 'matched' ? decision.confidence : (scored[0] ? scored[0].confidence : 'none'),
    match_evidence: decision.status === 'matched' ? decision.evidence : null, match_candidates: match.candidates,
    created_by: actor,
  };
  const dupes = await findDuplicates(supabase, { ...row, id: null });
  row.duplicate_findings = dupes;
  if (dupes.some((d) => d.severity === 'blocking')) { row.status = 'exception'; row.exception_reason = [dupes.filter((d) => d.severity === 'blocking').map((d) => d.detail).join(' '), row.exception_reason].filter(Boolean).join(' '); }
  const { data: saved, error } = await supabase.from('homeowner_check_receipts').insert(row).select('*').single();
  if (error) {
    if (error.code === '23505') return { duplicate: true, detail: 'This check (same image or same bank account and check number) is already in trustEd.' };
    throw error;
  }
  return { receipt: saved };
}

// ---------------------------------------------------------------------------
// 5) Staff confirmation and recording (once)
// ---------------------------------------------------------------------------
async function roleAccounts(supabase, communityId, roles) {
  const rows = await must(supabase.from('community_account_roles').select('role, account_id, chart_of_accounts!inner(id, account_number, fund_id)').eq('community_id', communityId).in('role', roles), 'account roles');
  const by = Object.fromEntries(rows.map((r) => [r.role, r.chart_of_accounts]));
  const missing = roles.filter((r) => !by[r]);
  if (missing.length) throw Object.assign(new Error(`This community has no ${missing.join(', ')} account configured (migration 514 adds Undeposited Funds).`), { code: 'blocked' });
  return by;
}

// Staff edits / confirms the receipt's facts and the account. Never posts.
const EDITABLE = ['check_number', 'amount_cents', 'check_date', 'payer_name', 'memo', 'written_account_number'];
async function confirmMatch(supabase, receiptId, { fields = {}, property_id, tenure_id, note, actor }) {
  const rc = await must(supabase.from('homeowner_check_receipts').select('*').eq('id', receiptId).single(), 'receipt');
  if (!['scanned', 'matched', 'exception'].includes(rc.status)) throw Object.assign(new Error(`This check is ${rc.status}; it can no longer be changed.`), { code: 'conflict' });
  const patch = {};
  for (const k of EDITABLE) if (fields[k] !== undefined) patch[k] = k === 'amount_cents' ? (Number.isInteger(Number(fields[k])) && Number(fields[k]) > 0 ? Number(fields[k]) : null) : (fields[k] === '' ? null : fields[k]);
  if (patch.amount_cents === null) throw Object.assign(new Error('amount must be a positive number of cents'), { code: 'invalid_input' });
  const next = { ...rc, ...patch };
  if (property_id) {
    const t = await must(supabase.from('ownership_tenures').select('id, property_id, community_id, kind, end_date').eq('property_id', property_id).eq('kind', 'owner').is('end_date', null), 'tenure');
    const chosen = tenure_id ? t.find((x) => x.id === tenure_id) : (t.length === 1 ? t[0] : null);
    if (!chosen || chosen.community_id !== rc.community_id) throw Object.assign(new Error('That property has no single current owner account in this association.'), { code: 'invalid_input' });
    const picked = (rc.match_candidates || []).find((c) => c.property_id === property_id);
    const proposed = rc.property_id === property_id;
    if (!proposed && !String(note || '').trim()) throw Object.assign(new Error('Choosing an account the system did not propose needs a short reason (what on the check identifies it).'), { code: 'invalid_input' });
    patch.property_id = property_id; patch.tenure_id = chosen.id;
    if (!proposed) patch.match_evidence = [...((picked && picked.evidence) || []), { signal: 'staff_selected', strength: 'staff', detail: `Selected by ${actor}: ${String(note).trim()}` }];
    next.property_id = property_id; next.tenure_id = chosen.id;
  }
  const holds = [];
  if (!next.check_number) holds.push('check number'); if (!next.amount_cents) holds.push('amount'); if (!next.check_date) holds.push('check date'); if (!next.property_id || !next.tenure_id) holds.push('owner account');
  if (next.check_date && next.check_date > next.received_date) holds.push(`post-dated (${next.check_date})`);
  const dupes = await findDuplicates(supabase, next);
  patch.duplicate_findings = dupes;
  const blocking = dupes.filter((d) => d.severity === 'blocking');
  if (holds.length || blocking.length) { patch.status = 'exception'; patch.exception_reason = [holds.length ? `Missing or invalid: ${holds.join(', ')}.` : null, ...blocking.map((d) => d.detail)].filter(Boolean).join(' '); }
  else { patch.status = 'matched'; patch.exception_reason = null; }
  if (note) patch.override_note = String(note).slice(0, 1000);
  patch.updated_at = new Date().toISOString();
  return must(supabase.from('homeowner_check_receipts').update(patch).eq('id', receiptId).in('status', ['scanned', 'matched', 'exception']).select('*').single(), 'confirm');
}

async function previewRecording(supabase, receiptId) {
  const { data, error } = await supabase.rpc('post_check_receipt_payment', { p_receipt_id: receiptId, p_approved_by: null, p_dry_run: true });
  if (error) throw Object.assign(new Error(error.message), { code: 'blocked' });
  return data;
}

// Record exactly once: ledger row + applications (draft) -> GL Dr Undeposited / Cr AR -> commit.
async function recordReceipt(supabase, receiptId, { actor, overrideNote, post = require('../accounting/posting').postJournalEntry, gate = financialsGate }) {
  const rc = await must(supabase.from('homeowner_check_receipts').select('*').eq('id', receiptId).single(), 'receipt');
  if (RECORDED.includes(rc.status) || rc.status === 'returned') return { status: 'already_recorded', receipt: rc };
  await gate(rc.community_id, 'Recording a check');
  if (rc.status !== 'matched') throw Object.assign(new Error(`This check is ${rc.status}; confirm the account first.`), { code: 'conflict' });
  const dupes = await findDuplicates(supabase, rc);
  if (dupes.some((d) => d.severity === 'blocking')) throw Object.assign(new Error(dupes.filter((d) => d.severity === 'blocking').map((d) => d.detail).join(' ')), { code: 'duplicate' });
  const possible = dupes.filter((d) => d.severity === 'possible');
  const note = String(overrideNote || rc.override_note || '').trim();
  if (possible.length && !note) throw Object.assign(new Error(`${possible.map((d) => d.detail).join(' ')} Record a reason to post this check anyway.`), { code: 'possible_duplicate', findings: possible });
  if (overrideNote) await must(supabase.from('homeowner_check_receipts').update({ override_note: note.slice(0, 1000) }).eq('id', receiptId).select('id'), 'note');

  const acct = await roleAccounts(supabase, rc.community_id, ['undeposited_funds', 'homeowner_ar']);
  const { data: led, error: le } = await supabase.rpc('post_check_receipt_payment', { p_receipt_id: receiptId, p_approved_by: actor, p_dry_run: false });
  if (le) throw Object.assign(new Error(le.message), { code: 'blocked' });
  const ref = `checkrcpt:${receiptId}`;
  const prior = await must(supabase.from('journal_entries').select('id, reference').eq('community_id', rc.community_id).eq('source_reference', ref).eq('status', 'posted').limit(1), 'existing GL');
  let je = prior[0];
  if (!je) {
    const r = await post({
      community_id: rc.community_id, posting_date: rc.received_date, source_module: 'payment_intake', source_reference: ref,
      description: `Homeowner check #${rc.check_number}${rc.payer_name ? ` from ${rc.payer_name}` : ''} received (held in Undeposited Funds until deposited)`,
      notes: `Check receipt ${receiptId}; ledger batch ${led.batch_id}; applied per Tex. Prop. Code 209.0063; confirmed by ${actor}${note ? `; note: ${note}` : ''}.`,
      lines: [
        { account_id: acct.undeposited_funds.id, fund_id: acct.undeposited_funds.fund_id, debit_cents: rc.amount_cents, credit_cents: 0, memo: `Check #${rc.check_number} received` },
        { account_id: acct.homeowner_ar.id, fund_id: acct.homeowner_ar.fund_id, debit_cents: 0, credit_cents: rc.amount_cents, property_id: rc.property_id, memo: `Homeowner payment, check #${rc.check_number}` },
      ],
    });
    je = r.entry;
  }
  const { data: c, error: ce } = await supabase.rpc('check_receipt_commit_posting', { p_receipt_id: receiptId, p_journal_entry_id: je.id, p_confirmed_by: actor });
  if (ce) throw Object.assign(new Error(`GL ${je.reference} posted but the receipt could not be committed: ${ce.message}. Retry to finish.`), { code: 'commit_pending' });
  return { status: 'recorded', journal_reference: je.reference, journal_entry_id: je.id, applied_cents: led.applied_cents, unapplied_cents: led.unapplied_cents, ledger: c };
}

async function voidReceipt(supabase, receiptId, { reason, actor }) {
  if (!String(reason || '').trim()) throw Object.assign(new Error('a reason is required'), { code: 'invalid_input' });
  const rc = await must(supabase.from('homeowner_check_receipts').select('id, status').eq('id', receiptId).single(), 'receipt');
  if (!['scanned', 'matched', 'exception'].includes(rc.status)) throw Object.assign(new Error(`A ${rc.status} check is reversed with Return, not voided.`), { code: 'conflict' });
  return must(supabase.from('homeowner_check_receipts').update({ status: 'voided', exception_reason: `Voided by ${actor}: ${String(reason).trim()}`, updated_at: new Date().toISOString() }).eq('id', receiptId).select('*').single(), 'void');
}

// ---------------------------------------------------------------------------
// 6) Deposits and bank reconciliation
// ---------------------------------------------------------------------------
// Pure validation of a proposed deposit.
function validateDeposit({ receipts, depositDate, bankReference, bankTotalCents }) {
  const errs = [];
  if (!receipts.length) errs.push('Select at least one recorded check.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(depositDate || ''))) errs.push('Deposit date required.');
  if (!String(bankReference || '').trim()) errs.push("The bank's deposit confirmation / reference number is required.");
  const comms = new Set(receipts.map((r) => r.community_id));
  if (comms.size > 1) errs.push('A deposit is for one association.');
  for (const r of receipts) {
    if (r.status !== 'recorded') errs.push(`Check #${r.check_number} is ${r.status}, not recorded.`);
    if (r.deposit_id) errs.push(`Check #${r.check_number} is already on a deposit.`);
    if (depositDate && r.received_date && depositDate < r.received_date) errs.push(`Check #${r.check_number} was received ${r.received_date}, after the deposit date.`);
  }
  const total = receipts.reduce((s, r) => s + Number(r.amount_cents || 0), 0);
  if (bankTotalCents != null && Number(bankTotalCents) !== total) errs.push(`The bank confirmation total ${money(bankTotalCents)} does not equal the selected checks ${money(total)}.`);
  return { ok: !errs.length, errors: errs, total_cents: total };
}

async function createDeposit(supabase, { communityId, receiptIds, depositDate, bankReference, bankTotalCents, evidenceDocumentId = null, actor, post = require('../accounting/posting').postJournalEntry, gate = financialsGate }) {
  await gate(communityId, 'Recording a deposit');
  const receipts = await must(supabase.from('homeowner_check_receipts').select('*').in('id', receiptIds || []), 'receipts');
  if (receipts.length !== (receiptIds || []).length) throw Object.assign(new Error('Some selected checks were not found.'), { code: 'invalid_input' });
  if (receipts.some((r) => r.community_id !== communityId)) throw Object.assign(new Error('A selected check belongs to another association.'), { code: 'invalid_input' });
  const v = validateDeposit({ receipts, depositDate, bankReference, bankTotalCents });
  if (!v.ok) throw Object.assign(new Error(v.errors.join(' ')), { code: 'invalid_input' });
  const ref = String(bankReference).trim();
  const dup = await must(supabase.from('homeowner_check_deposits').select('id').eq('community_id', communityId).eq('bank_reference', ref).limit(1), 'deposit ref');
  if (dup.length) throw Object.assign(new Error(`Deposit reference ${ref} is already recorded.`), { code: 'duplicate' });
  const acct = await roleAccounts(supabase, communityId, ['operating_cash', 'undeposited_funds']);
  const id = crypto.randomUUID();
  const r = await post({
    community_id: communityId, posting_date: depositDate, source_module: 'bank_reconciliation', source_reference: `chkdep:${id}`,
    description: `Bank deposit ${ref}: ${receipts.length} homeowner check(s)`,
    notes: `Remote deposit confirmation ${ref}, recorded by ${actor}. Checks: ${receipts.map((x) => `#${x.check_number} ${money(x.amount_cents)}`).join(', ')}.`,
    lines: [
      { account_id: acct.operating_cash.id, fund_id: acct.operating_cash.fund_id, debit_cents: v.total_cents, credit_cents: 0, memo: `Deposit ${ref}` },
      { account_id: acct.undeposited_funds.id, fund_id: acct.undeposited_funds.fund_id, debit_cents: 0, credit_cents: v.total_cents, memo: `Deposit ${ref}: ${receipts.length} check(s)` },
    ],
  });
  const dep = await must(supabase.from('homeowner_check_deposits').insert({ id, community_id: communityId, deposit_date: depositDate, bank_reference: ref, cash_account_id: acct.operating_cash.id,
    total_cents: v.total_cents, check_count: receipts.length, evidence_document_id: evidenceDocumentId, journal_entry_id: r.entry.id, created_by: actor }).select('*').single(), 'deposit');
  await must(supabase.from('homeowner_check_receipts').update({ status: 'deposited', deposit_id: id, updated_at: new Date().toISOString() }).in('id', receiptIds).eq('status', 'recorded').select('id'), 'mark deposited');
  return { deposit: dep, journal_reference: r.entry.reference };
}

// Bank lines that could be this deposit: same association, a credit of exactly the deposit
// total, dated on or within 5 business-ish days after the deposit date, not already matched.
async function bankLineCandidates(supabase, deposit) {
  const lines = await must(supabase.from('bank_statement_transactions').select('id, posting_date, amount_cents, description, transaction_type, bank_statement_imports!inner(community_id)')
    .eq('bank_statement_imports.community_id', deposit.community_id).eq('amount_cents', deposit.total_cents)
    .gte('posting_date', addDays(deposit.deposit_date, -1)).lte('posting_date', addDays(deposit.deposit_date, 7)).limit(10), 'bank lines');
  const taken = await must(supabase.from('homeowner_check_deposits').select('bank_statement_transaction_id').in('bank_statement_transaction_id', lines.map((l) => l.id).length ? lines.map((l) => l.id) : ['00000000-0000-0000-0000-000000000000']), 'taken');
  const used = new Set(taken.map((t) => t.bank_statement_transaction_id));
  return lines.filter((l) => !used.has(l.id));
}

async function reconcileDeposit(supabase, depositId, { bankTransactionId, actor }) {
  const dep = await must(supabase.from('homeowner_check_deposits').select('*').eq('id', depositId).single(), 'deposit');
  if (dep.status === 'reconciled') return { status: 'already_reconciled', deposit: dep };
  if (dep.status !== 'deposited') throw Object.assign(new Error(`Deposit is ${dep.status}.`), { code: 'conflict' });
  const cands = await bankLineCandidates(supabase, dep);
  const line = bankTransactionId ? cands.find((c) => c.id === bankTransactionId) : (cands.length === 1 ? cands[0] : null);
  if (!line) throw Object.assign(new Error(bankTransactionId ? 'That bank line is not a match for this deposit (amount, date or already matched).' : cands.length ? `${cands.length} bank lines fit; choose one.` : 'No imported bank line matches this deposit yet (import the statement in Bank Rec).'), { code: 'no_match', candidates: cands });
  const upd = await must(supabase.from('homeowner_check_deposits').update({ status: 'reconciled', bank_statement_transaction_id: line.id, reconciled_at: new Date().toISOString(), reconciled_by: actor, updated_at: new Date().toISOString() }).eq('id', depositId).eq('status', 'deposited').select('*').single(), 'reconcile');
  await must(supabase.from('homeowner_check_receipts').update({ status: 'reconciled', updated_at: new Date().toISOString() }).eq('deposit_id', depositId).eq('status', 'deposited').select('id'), 'receipts reconciled');
  return { status: 'reconciled', deposit: upd, bank_line: line };
}

// ---------------------------------------------------------------------------
// 7) Returned check (controlled reversal)
// ---------------------------------------------------------------------------
async function returnReceipt(supabase, receiptId, { returnDate, reason, actor, post = require('../accounting/posting').postJournalEntry }) {
  if (!String(reason || '').trim()) throw Object.assign(new Error('a reason is required (e.g. NSF, stop payment, account closed)'), { code: 'invalid_input' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(returnDate || ''))) throw Object.assign(new Error('return date required'), { code: 'invalid_input' });
  const rc = await must(supabase.from('homeowner_check_receipts').select('*').eq('id', receiptId).single(), 'receipt');
  if (rc.status === 'returned') return { status: 'already_returned', receipt: rc };
  if (!RECORDED.includes(rc.status)) throw Object.assign(new Error(`A ${rc.status} check has no posting to reverse; void it instead.`), { code: 'conflict' });
  await financialsGate(rc.community_id, 'Reversing a check');
  const deposited = rc.status !== 'recorded';
  const acct = await roleAccounts(supabase, rc.community_id, [deposited ? 'operating_cash' : 'undeposited_funds', 'homeowner_ar']);
  const creditAcct = deposited ? acct.operating_cash : acct.undeposited_funds;
  const ref = `checkret:${receiptId}`;
  const pay = await must(supabase.from('homeowner_transactions').select('*').eq('id', rc.homeowner_txn_id).single(), 'payment row');
  const already = await must(supabase.from('homeowner_transactions').select('id').eq('reverses_txn_id', pay.id).limit(1), 'existing reversal');
  if (already.length) throw Object.assign(new Error('This payment is already reversed on the homeowner ledger.'), { code: 'conflict' });
  const comm = await must(supabase.from('communities').select('management_company_id').eq('id', rc.community_id).single(), 'community');
  const b = await must(supabase.from('transaction_upload_batches').insert({ management_company_id: comm.management_company_id, community_id: rc.community_id, period_label: `Returned check #${rc.check_number}`, as_of_date: returnDate,
    source_format: 'manual', row_count: 1, account_count: 1, total_charges_cents: rc.amount_cents, total_payments_cents: 0, status: 'draft', min_transaction_date: returnDate, max_transaction_date: returnDate,
    uploaded_by: 'check_receipt', notes: `Returned check ${receiptId}: ${String(reason).trim()}. Recorded by ${actor}.`.slice(0, 2000) }).select('id').single(), 'batch');
  const revert = async (why) => { await supabase.from('transaction_upload_batches').update({ status: 'reverted', reverted_at: new Date().toISOString(), reverted_reason: String(why).slice(0, 500) }).eq('id', b.id); };
  const { data: rev, error: ie } = await supabase.from('homeowner_transactions').insert({ source_batch_id: b.id, source_row_index: 1, community_id: rc.community_id, vantaca_account_id: pay.vantaca_account_id, trusted_account_number: pay.trusted_account_number,
    property_id: pay.property_id, contact_id: pay.contact_id, tenure_id: pay.tenure_id, transaction_date: returnDate, txn_type: 'charge', charge_category: 'payment_reversal', amount_cents: -pay.amount_cents, reverses_txn_id: pay.id,
    description: `Returned check #${rc.check_number} (${String(reason).trim()})`, raw_row_jsonb: { source: 'check_return', check_receipt_id: receiptId } }).select('id').single();
  if (ie) { await revert(ie.message); throw new Error(`ledger row: ${ie.message}`); }
  let je;
  try {
    const prior = await must(supabase.from('journal_entries').select('id, reference').eq('community_id', rc.community_id).eq('source_reference', ref).eq('status', 'posted').limit(1), 'existing GL');
    je = prior[0] || (await post({ community_id: rc.community_id, posting_date: returnDate, source_module: 'payment_intake', source_reference: ref,
      description: `Returned homeowner check #${rc.check_number}: ${String(reason).trim()}`,
      notes: `Reverses check receipt ${receiptId} (${rc.journal_entry_id}). ${deposited ? 'The bank returned the deposited item.' : 'The check was never deposited.'} Recorded by ${actor}.`,
      lines: [
        { account_id: acct.homeowner_ar.id, fund_id: acct.homeowner_ar.fund_id, debit_cents: rc.amount_cents, credit_cents: 0, property_id: rc.property_id, memo: `Returned check #${rc.check_number}` },
        { account_id: creditAcct.id, fund_id: creditAcct.fund_id, debit_cents: 0, credit_cents: rc.amount_cents, memo: `Returned check #${rc.check_number}` },
      ] })).entry;
  } catch (e) { await revert(e.message); throw e; }
  await must(supabase.from('transaction_upload_batches').update({ status: 'committed', committed_at: new Date().toISOString() }).eq('id', b.id).select('id'), 'commit');
  const upd = await must(supabase.from('homeowner_check_receipts').update({ status: 'returned', returned_at: new Date().toISOString(), return_reason: String(reason).trim(), return_txn_id: rev.id, return_journal_entry_id: je.id, updated_at: new Date().toISOString() }).eq('id', receiptId).select('*').single(), 'mark returned');
  return { status: 'returned', receipt: upd, journal_reference: je.reference, note: 'No returned-check (NSF) fee was charged; apply one only under the association\'s collection policy.' };
}

// ---------------------------------------------------------------------------
// 8) Import guard: a later Vantaca snapshot never re-adds a recorded check
// ---------------------------------------------------------------------------
// Pure: which parsed import payment rows are a check already recorded in trustEd
// (same account, same amount, within the window). Each recorded check absorbs at most one row.
function recordedCheckRowsToSkip(rows, recorded, propByAcct) {
  const skip = new Map(); const used = new Set();
  for (const r of rows || []) {
    if (!(Number(r.amount_cents) < 0)) continue;
    const pid = propByAcct[r.vantaca_account_id]; if (!pid) continue;
    const hit = (recorded || []).find((c) => !used.has(c.id) && c.property_id === pid && Number(c.amount_cents) === -Number(r.amount_cents)
      && Math.abs((Date.parse(`${r.transaction_date}T00:00:00Z`) - Date.parse(`${c.received_date}T00:00:00Z`)) / 86400000) <= LEDGER_DUP_WINDOW_DAYS);
    if (hit) { used.add(hit.id); skip.set(r.source_row_index, hit); }
  }
  return skip;
}

async function recordedChecksForImport(supabase, communityId, minDate, maxDate) {
  return must(supabase.from('homeowner_check_receipts').select('id, property_id, amount_cents, received_date, check_number')
    .eq('community_id', communityId).in('status', RECORDED).gte('received_date', addDays(minDate, -LEDGER_DUP_WINDOW_DAYS)).lte('received_date', addDays(maxDate, LEDGER_DUP_WINDOW_DAYS)).limit(2000), 'recorded checks');
}

module.exports = {
  PROMPT, normalizeCheckExtraction, extractCheck, splitUpload, attachBack, MAX_PAGES, payeeCommunity, scoreCandidates, decideMatch, loadCandidates,
  classifyDuplicates, findDuplicates, intakeCheck, confirmMatch, previewRecording, recordReceipt, voidReceipt,
  validateDeposit, createDeposit, bankLineCandidates, reconcileDeposit, returnReceipt,
  recordedCheckRowsToSkip, recordedChecksForImport, RECORDED, LEDGER_DUP_WINDOW_DAYS,
};
