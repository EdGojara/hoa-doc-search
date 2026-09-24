// ============================================================================
// Home Sales API — the resale lifecycle (mounted at /api/home-sales)
// ----------------------------------------------------------------------------
// Two real-world events, one row (see migration 243):
//
//   PART 1  Resale request (pre-closing). HomeWise/title emails. We respond with
//           the DRV status, a fresh inspection, and the current balance.
//           NO ownership change.
//
//   PART 2  Closing (post-closing). Title's physical mail + transfer-fee check
//           arrives; we scan it. Ownership transitions seller -> buyer on the
//           closing date (via approve_ownership_proposal), we verify the
//           seller's balance cleared to zero, and record the fees.
//
// trustEd is the operator workspace + system of record here. The title-facing
// delivery stays on HomeWise until that's cut over too.
// ============================================================================

const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { safeErrorMessage } = require('./_safe_error');
const { getLegalFlag } = require('../lib/enforcement/legal_flag');
const { resolveCurrentAR } = require('../lib/ar/resolve_current_ar');
const { planTenurePayment, postTenurePayment } = require('../lib/accounting/homeowner_payment');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = express.Router();

// Stages that mean a violation is still OPEN (everything else = resolved).
const OPEN_VIOLATION_STAGES = ['courtesy_1', 'courtesy_2', 'certified_209', 'fine_assessed'];

// The seller's balance for a resale disclosure / closing, from the shared
// resolver (the same homeowner ledger the portal, Claire and payments read).
// No balance on file is UNKNOWN, never $0: a disclosure that says "cleared"
// when we simply have no data is the most dangerous wrong answer title can get.
function balanceFromAR(ar) {
  const known = !!ar && ar.balance_cents != null && Number.isFinite(Number(ar.balance_cents));
  const cents = known ? Number(ar.balance_cents) : null;
  return {
    balance_status: known ? 'KNOWN' : 'UNKNOWN',
    balance_cents: cents,
    balance_as_of: known ? (ar.as_of || null) : null,
    balance_source: ar ? ar.source : 'none',
    balance_is_zero: known && cents === 0,
  };
}

// ----------------------------------------------------------------------------
// Helper — the disclosure snapshot for a property: current owner, balance, DRV.
// This is the Part-1 answer (what title is asking for) and is also captured at
// closing to prove the seller's account cleared.
// ----------------------------------------------------------------------------
async function propertySnapshot(community_id, property_id) {
  const [propRes, ownerRes, ar, violRes, legal] = await Promise.all([
    supabase.from('properties')
      .select('id, community_id, street_address, unit, city, state, zip')
      .eq('id', property_id).maybeSingle(),
    supabase.from('v_current_property_owners')
      .select('*').eq('property_id', property_id).maybeSingle(),
    resolveCurrentAR(supabase, { propertyId: property_id }),
    supabase.from('violations')
      .select('id, current_stage, opened_at')
      .eq('property_id', property_id)
      .in('current_stage', OPEN_VIOLATION_STAGES),
    // Legal/lien/bankruptcy status (property_enforcement_states SSOT). A resale
    // disclosure that shows a clean DRV + zero balance but omits a FILED LIEN or
    // an at-legal/bankruptcy status is the highest-liability miss at a closing —
    // the one thing title most needs. (Ed 2026-08-06.)
    getLegalFlag(property_id),
  ]);

  if (propRes.error) throw propRes.error;
  const prop = propRes.data;
  if (!prop) return null;
  // Defense in depth: never leak another community's property.
  if (community_id && prop.community_id !== community_id) return null;

  if (ownerRes.error) throw ownerRes.error;
  if (violRes.error) throw violRes.error;
  const owner = ownerRes.data || null;
  const openViolations = violRes.data || [];

  // Worst open stage = latest in the enforcement ladder.
  let worst = null;
  for (const v of openViolations) {
    if (OPEN_VIOLATION_STAGES.indexOf(v.current_stage) > OPEN_VIOLATION_STAGES.indexOf(worst || '')) {
      worst = v.current_stage;
    }
  }

  return {
    property: prop,
    owner,                                         // owner_contact_id, owner_name, primary_email, mailing_address, owned_since, vesting
    ...balanceFromAR(ar),                          // balance_status KNOWN|UNKNOWN; UNKNOWN never reads as $0
    drv_clean: openViolations.length === 0,
    open_violations_count: openViolations.length,
    worst_open_stage: worst,
    // Legal encumbrance disclosure. legal_clean=false means a lien / at-legal /
    // bankruptcy / judgment is on record — title must NOT treat this as a clean
    // close. Surfaced explicitly so it can never be silently omitted.
    legal_clean: !legal,
    legal_status: legal ? legal.label : null,
    legal_state: legal ? legal.state : null,
    lien_filed: !!(legal && legal.lien_filed),
    at_legal: !!(legal && legal.at_legal),
    in_bankruptcy: !!(legal && legal.in_bankruptcy),
    judgment: !!(legal && legal.judgment),
    in_collections: !!(legal && legal.in_collections),
    legal_attorney: legal ? (legal.attorney_name || null) : null,
    legal_as_of: legal ? (legal.as_of || null) : null,
  };
}

// ----------------------------------------------------------------------------
// GET /api/home-sales?community_id   — the lifecycle list (open + closed)
// ----------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { community_id, status } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    let q = supabase.from('home_sales')
      .select('*, properties(street_address, unit)')
      .eq('community_id', community_id)
      .order('created_at', { ascending: false })
      .limit(500);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ sales: data || [] });
  } catch (err) {
    console.error('[home-sales] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /api/home-sales/properties/search?community_id&q  — pick the lot selling
// ----------------------------------------------------------------------------
router.get('/properties/search', async (req, res) => {
  try {
    const { community_id, q } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    let query = supabase.from('v_current_property_owners')
      .select('property_id, street_address, unit, owner_name')
      .eq('community_id', community_id)
      .limit(25);
    if (q && q.trim()) {
      const term = `%${q.trim()}%`;
      query = query.or(`street_address.ilike.${term},owner_name.ilike.${term}`);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ properties: data || [] });
  } catch (err) {
    console.error('[home-sales] property search failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /api/home-sales/property/:property_id/snapshot?community_id
//   The Part-1 disclosure: current owner + balance + clean-DRV status.
// ----------------------------------------------------------------------------
router.get('/property/:property_id/snapshot', async (req, res) => {
  try {
    const { property_id } = req.params;
    const { community_id } = req.query;
    const snap = await propertySnapshot(community_id, property_id);
    if (!snap) return res.status(404).json({ error: 'property_not_found' });
    res.json(snap);
  } catch (err) {
    console.error('[home-sales] snapshot failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /api/home-sales/property/:property_id/history?community_id
//   Ownership history (prior owners + dates) + any recorded sales/balances.
// ----------------------------------------------------------------------------
router.get('/property/:property_id/history', async (req, res) => {
  try {
    const { property_id } = req.params;
    const [ownRes, saleRes, propRes] = await Promise.all([
      supabase.from('property_ownerships')
        .select('id, contact_id, start_date, end_date, vesting, is_primary, source, notes, contacts(full_name, primary_email, vantaca_account_id)')
        .eq('property_id', property_id)
        // Same-day sequential closings share a start date: the open (current) owner
        // first, then the one-day intermediate owner, then by creation (approval) order.
        .order('start_date', { ascending: false })
        .order('end_date', { ascending: false, nullsFirst: true })
        .order('created_at', { ascending: false }),
      supabase.from('home_sales')
        .select('*')
        .eq('property_id', property_id)
        .order('closing_date', { ascending: false, nullsFirst: false }),
      // The transfer audit trail — who proposed each ownership change, its
      // source (vantaca_import / title_company / manual), and who approved it.
      supabase.from('ownership_change_proposals')
        .select('id, current_owner_name, proposed_owner_name, source, source_filename, vantaca_account_id, status, effective_start_date, reviewed_at, reviewed_by, decision_notes, created_at')
        .eq('property_id', property_id)
        .order('created_at', { ascending: false }),
    ]);
    if (ownRes.error) throw ownRes.error;
    if (saleRes.error) throw saleRes.error;
    if (propRes.error) throw propRes.error;
    res.json({ ownerships: ownRes.data || [], sales: saleRes.data || [], transfers: propRes.data || [] });
  } catch (err) {
    console.error('[home-sales] history failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /api/home-sales/request   — Part 1: log a resale request
//   body: { community_id, property_id, request_source, requested_by, request_received_at, notes }
//   Captures the disclosure snapshot (balance + DRV) onto the row at intake.
// ----------------------------------------------------------------------------
router.post('/request', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.community_id) return res.status(400).json({ error: 'community_id_required' });
    if (!b.property_id) return res.status(400).json({ error: 'property_id_required' });

    const snap = await propertySnapshot(b.community_id, b.property_id);
    if (!snap) return res.status(404).json({ error: 'property_not_found' });

    const row = {
      community_id: b.community_id,
      property_id: b.property_id,
      status: 'requested',
      request_received_at: b.request_received_at || new Date().toISOString().slice(0, 10),
      request_source: b.request_source || 'homewise',
      requested_by: b.requested_by || null,
      seller_contact_id: snap.owner ? snap.owner.owner_contact_id : null,
      seller_name: snap.owner ? snap.owner.owner_name : null,
      drv_clean: snap.drv_clean,
      open_violations_count: snap.open_violations_count,
      worst_open_stage: snap.worst_open_stage,
      inspection_status: 'pending',
      balance_cents: snap.balance_cents,
      balance_as_of_date: snap.balance_as_of,
      notes: b.notes || null,
    };
    const { data, error } = await supabase.from('home_sales').insert(row).select().maybeSingle();
    if (error) throw error;
    res.json({ sale: data, snapshot: snap });
  } catch (err) {
    console.error('[home-sales] request intake failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /api/home-sales/:id/disclose   — Part 1: mark disclosures sent
// ----------------------------------------------------------------------------
router.post('/:id/disclose', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {
      status: 'disclosed',
      disclosures_sent_at: b.disclosures_sent_at || new Date().toISOString().slice(0, 10),
      disclosures_sent_to: b.disclosures_sent_to || null,
    };
    if (b.inspection_status) patch.inspection_status = b.inspection_status;
    if (b.inspection_id) patch.inspection_id = b.inspection_id;
    const { data, error } = await supabase.from('home_sales')
      .update(patch).eq('id', req.params.id).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'sale_not_found' });
    res.json({ sale: data });
  } catch (err) {
    console.error('[home-sales] disclose failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /api/home-sales/scan   — Part 2: read the title closing packet
//   multipart: file (PDF or image), community_id
//   Extracts buyer/seller/closing date/fees and proposes a property match.
//   Pure read — records nothing. The operator confirms, then calls record-closing.
// ----------------------------------------------------------------------------
const SCAN_PROMPT = `You are reading a closing packet a title company mailed to an HOA management company after a home sale closed. It typically includes a cover/transfer letter and a check for the association's transfer/capital-contribution fee (and sometimes the management company's transfer fee).

Extract EXACTLY this JSON (no prose, no markdown fence):
{
  "property_address": "street address of the property that sold, or null",
  "seller_name": "the seller / grantor (current owner of record), or null",
  "buyer_name": "the buyer / grantee (new owner), or null",
  "buyer_mailing_address": "where the buyer receives mail AFTER closing: the grantee's mailing / 'after recording return to' address on the deed if shown; if the documents say the buyer will occupy the home, the property address; never the buyer's pre-closing address from the closing statement header; else null",
  "buyer_email": "buyer email if shown anywhere (including handwritten), or null",
  "buyer_phone": "buyer phone if shown anywhere (including handwritten), or null",
  "closing_date": "the closing/settlement/funding date as YYYY-MM-DD, or null",
  "transfer_fee_dollars": <number or null>,            // fee paid TO the association (capital contribution / transfer fee / working capital)
  "management_transfer_fee_dollars": <number or null>, // fee paid to the management company, if itemized separately
  "check_total_dollars": <number or null>,             // total of all enclosed checks
  "checks": [                                           // EVERY check enclosed, one entry per physical check
    { "check_number": "string or null", "amount_dollars": <number or null>, "check_date": "YYYY-MM-DD or null",
      "payee": "exactly as printed on the PAY TO THE ORDER OF line, or null", "memo": "memo line text, or null" }
  ],
  "title_company_name": "title/escrow company, or null",
  "document_type": "transfer_letter | settlement_statement | check | other",
  "confidence": "high | medium | low",
  "notes": "anything notable (multiple buyers, trust/LLC vesting, missing fee, etc.), or null"
}
Dollar amounts: numbers only, no $ or commas. List each check separately even when several share a stub or page; never combine checks. If a field is genuinely absent, use null — do not guess.`;

// ----------------------------------------------------------------------------
// Check classification — by PAYEE, never by memo (a memo is what the title
// company typed, the payee is who can cash it). Anything not clearly Bedrock or
// clearly this Association is left for staff.
// ----------------------------------------------------------------------------
const CHECK_CLASSES = ['BEDROCK_FEE', 'ASSOCIATION_PAYMENT', 'NEEDS_CLASSIFICATION'];
function _normName(v) {
  return String(v || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(inc|incorporated|llc|co|corp|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
function classifyCheckPayee(payee, community) {
  const p = _normName(payee);
  if (!p) return 'NEEDS_CLASSIFICATION';
  const isBedrock = /\bbedrock\b/.test(p);
  const legalNames = [community && community.hoa_legal_name, community && community.legal_name]
    .map(_normName).filter((n) => n && n.length >= 6);
  // The full legal name, or the community name PLUS an association word
  // ("Lakes of Pine Forest HOA"). The bare community name alone ("... Swim
  // Team", "... MUD") is someone else.
  const core = community && _normName(community.name);
  const isAssoc = legalNames.some((n) => p === n || p.includes(n))
    || (!!core && core.length >= 6 && p.includes(core) && /\b(hoa|homeowners?|owners|association|assn|poa|community association)\b/.test(p));
  if (isBedrock && !isAssoc) return 'BEDROCK_FEE';
  if (isAssoc && !isBedrock) return 'ASSOCIATION_PAYMENT';
  return 'NEEDS_CLASSIFICATION';
}

function dollarsToCents(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

router.post('/scan', upload.single('file'), async (req, res) => {
  try {
    const community_id = req.body && req.body.community_id;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    if (!req.file) return res.status(400).json({ error: 'file_required' });

    const mime = req.file.mimetype || '';
    const isPdf = mime.includes('pdf') || /\.pdf$/i.test(req.file.originalname || '');
    const isImage = mime.startsWith('image/');
    if (!isPdf && !isImage) return res.status(400).json({ error: 'file_must_be_pdf_or_image' });

    // Send the binary straight to the model — never pre-extract form PDFs (scar: pdf-parse on Adobe forms).
    const source = isPdf
      ? { type: 'base64', media_type: 'application/pdf', data: req.file.buffer.toString('base64') }
      : { type: 'base64', media_type: mime, data: req.file.buffer.toString('base64') };
    const docBlock = isPdf
      ? { type: 'document', source }
      : { type: 'image', source };

    const completion = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      messages: [{ role: 'user', content: [docBlock, { type: 'text', text: SCAN_PROMPT }] }],
    });
    const text = (completion.content && completion.content[0] && completion.content[0].text) || '';
    console.log('[home-sales] scan model returned:', text);
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
    } catch (e) {
      return res.status(422).json({ error: 'could_not_parse_document', raw_extracted: text });
    }

    const extracted = {
      property_address: parsed.property_address || null,
      seller_name: parsed.seller_name || null,
      buyer_name: parsed.buyer_name || null,
      buyer_mailing_address: parsed.buyer_mailing_address || null,
      buyer_email: parsed.buyer_email || null,
      buyer_phone: parsed.buyer_phone || null,
      closing_date: parsed.closing_date || null,
      transfer_fee_cents: dollarsToCents(parsed.transfer_fee_dollars),
      management_transfer_fee_cents: dollarsToCents(parsed.management_transfer_fee_dollars),
      check_total_cents: dollarsToCents(parsed.check_total_dollars),
      title_company_name: parsed.title_company_name || null,
      document_type: parsed.document_type || null,
      confidence: parsed.confidence || null,
      notes: parsed.notes || null,
    };

    // Every check, classified by payee in code (never by the model, never by memo).
    const { data: comm, error: commErr } = await supabase.from('communities')
      .select('name, legal_name, hoa_legal_name').eq('id', community_id).maybeSingle();
    if (commErr) throw commErr;
    extracted.checks = (Array.isArray(parsed.checks) ? parsed.checks : []).map((c) => ({
      check_number: c && c.check_number != null ? String(c.check_number).trim() : null,
      amount_cents: dollarsToCents(c && c.amount_dollars),
      check_date: (c && c.check_date) || null,
      payee: (c && c.payee) || null,
      memo: (c && c.memo) || null,
      classification: classifyCheckPayee(c && c.payee, comm),
    }));

    // Propose a property match within this community by address.
    let matches = [];
    if (extracted.property_address) {
      // Match on the leading street portion (drop city/state/zip after the first comma).
      const street = extracted.property_address.split(',')[0].trim();
      const term = `%${street.replace(/\s+/g, '%')}%`;
      const { data: mdata } = await supabase.from('v_current_property_owners')
        .select('property_id, street_address, unit, owner_name')
        .eq('community_id', community_id)
        .ilike('street_address', term)
        .limit(10);
      matches = mdata || [];
    }

    res.json({ extracted, raw_extracted: parsed, property_matches: matches });
  } catch (err) {
    console.error('[home-sales] scan failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /api/home-sales/record-closing   — Part 2: transition ownership
//   body: {
//     community_id, property_id, sale_id?(existing request to close),
//     closing_date (= settlement date), buyer_name, buyer_email?, buyer_mailing_address?,
//     transfer_fee_cents?, management_transfer_fee_cents?,
//     raw_extraction?, reviewed_by?, notes?
//   }
//   One transfer path (mig 459): the sale row is written first (not closed),
//   then a proposal carrying home_sale_id + the settlement date, then
//   approve_ownership_proposal closes the seller (settlement - 1), opens the
//   buyer's new tenure (settlement), and closes + links the home_sales row, all
//   in ONE database transaction. If the transfer is refused nothing changes
//   ownership; the proposal is withdrawn with the reason and a freshly created
//   sale row is removed, so a retry starts clean.
// ----------------------------------------------------------------------------
router.post('/record-closing', express.json({ limit: '256kb' }), async (req, res) => {
  let createdSaleId = null;
  let proposalId = null;
  try {
    const b = req.body || {};
    if (!b.community_id) return res.status(400).json({ error: 'community_id_required' });
    if (!b.property_id) return res.status(400).json({ error: 'property_id_required' });
    if (!b.buyer_name || !String(b.buyer_name).trim()) return res.status(400).json({ error: 'buyer_name_required' });
    if (!b.closing_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.closing_date))) return res.status(400).json({ error: 'closing_date_required' });

    const snap = await propertySnapshot(b.community_id, b.property_id);
    if (!snap) return res.status(404).json({ error: 'property_not_found' });
    if (!snap.owner || !snap.owner.owner_contact_id) return res.status(409).json({ error: 'seller_required: this lot has no current owner on file' });
    // The seller named on the closing document must be the owner of record now.
    // This is what keeps sequential closings in order (A -> B, then B -> C): if
    // B -> C is entered first, the owner on file is still A and it is refused,
    // instead of silently recording A -> C.
    if (!b.seller_name || !String(b.seller_name).trim()) return res.status(400).json({ error: 'seller_name_required: enter the seller shown on the closing document' });
    if (!sellerMatchesOwner(b.seller_name, snap.owner.owner_name)) {
      return res.status(409).json({ error: `seller_not_current_owner: the document's seller "${String(b.seller_name).trim()}" is not the owner on file ("${snap.owner.owner_name}"). If this lot sold more than once, enter the earlier closing first.` });
    }

    // 0) Checks in the packet. Each one is classified (by payee) and confirmed by
    // staff before anything posts. Bedrock fees never touch the Association's
    // books; an Association check is either the seller's payoff or an
    // Association fee, never guessed.
    const checkPlan = validateClosingChecks(b);
    if (checkPlan.error) return res.status(400).json({ error: checkPlan.error });
    const sellerTenureBefore = snap.owner.tenure_id;
    let payoffPlan = null;
    if (checkPlan.payoff) {
      if (b.payoff_confirmed !== true) return res.status(400).json({ error: 'payoff_not_confirmed: confirm the seller payoff before recording' });
      // Prove the payoff applies cleanly to the seller's tenure before the transfer runs,
      // so a payoff that cannot post never leaves a half-finished closing behind.
      try {
        payoffPlan = await planTenurePayment(supabase, payoffArgs(b, checkPlan.payoff, sellerTenureBefore, null, null));
      } catch (e) {
        return res.status(409).json({ error: 'payoff_cannot_apply: ' + e.message });
      }
      if (payoffPlan.already_posted) return res.status(409).json({ error: 'payoff_already_posted: check ' + checkPlan.payoff.check_number + ' was already posted' });
      if (Number(payoffPlan.applied_cents) !== Number(checkPlan.payoff.amount_cents)) return res.status(409).json({ error: 'payoff_does_not_tie' });
    }

    // 1) The sale row, with everything staff entered, still open (requested/disclosed).
    const saleFields = {
      seller_contact_id: snap.owner.owner_contact_id,
      seller_name: snap.owner.owner_name,
      closing_notice_received_at: b.closing_notice_received_at || new Date().toISOString().slice(0, 10),
      buyer_name: String(b.buyer_name).trim(),
      buyer_email: b.buyer_email || null,
      buyer_mailing_address: b.buyer_mailing_address || null,
      transfer_fee_cents: checkPlan.checks ? checkPlan.associationFeeCents : (b.transfer_fee_cents != null ? b.transfer_fee_cents : null),
      management_transfer_fee_cents: checkPlan.checks ? checkPlan.bedrockFeeCents : (b.management_transfer_fee_cents != null ? b.management_transfer_fee_cents : null),
      raw_extraction: { ...(b.raw_extraction && typeof b.raw_extraction === 'object' ? b.raw_extraction : { model_output: b.raw_extraction || null }),
        closing_checks: checkPlan.checks || null, closing_payoff: checkPlan.payoff || null,
        buyer_phone: b.buyer_phone || null, source_document_name: b.source_document_name || null },
      notes: b.notes || null,
    };
    let saleId;
    if (b.sale_id) {
      const { data: existing, error } = await supabase.from('home_sales')
        .select('id, property_id, status').eq('id', b.sale_id).maybeSingle();
      if (error) throw error;
      if (!existing || existing.property_id !== b.property_id) return res.status(404).json({ error: 'home_sale_not_found_for_this_property' });
      if (!['requested', 'disclosed'].includes(existing.status)) return res.status(409).json({ error: 'home_sale_already_' + existing.status });
      const { error: uErr } = await supabase.from('home_sales').update(saleFields).eq('id', b.sale_id);
      if (uErr) throw uErr;
      saleId = b.sale_id;
    } else {
      const { data: created, error } = await supabase.from('home_sales')
        .insert({ community_id: b.community_id, property_id: b.property_id, status: 'requested', request_source: 'other', ...saleFields })
        .select('id').single();
      if (error) throw error;
      saleId = created.id;
      createdSaleId = created.id;
    }

    // 2) The proposal (source: title_company), carrying the sale + settlement date.
    const { data: prop, error: propErr } = await supabase.from('ownership_change_proposals').insert({
      property_id: b.property_id,
      community_id: b.community_id,
      current_contact_id: snap.owner.owner_contact_id,
      current_owner_name: snap.owner.owner_name,
      current_owner_email: snap.owner.owner_email,
      proposed_owner_name: String(b.buyer_name).trim(),
      proposed_owner_email: b.buyer_email || null,
      proposed_owner_phone: b.buyer_phone || null,
      proposed_mailing_address: b.buyer_mailing_address || null,
      source: 'title_company',
      status: 'pending',
      effective_start_date: b.closing_date,
      home_sale_id: saleId,
    }).select('id').single();
    if (propErr) throw propErr;
    proposalId = prop.id;

    // 3) The one transfer path.
    const { data: t, error: tErr } = await supabase.rpc('approve_ownership_proposal', {
      p_proposal_id: prop.id,
      p_reviewed_by: b.reviewed_by || 'home_sales',
      p_notes: `Closing recorded via Home Sales${b.notes ? ': ' + b.notes : ''}`,
      p_settlement_date: b.closing_date,
      p_home_sale_id: saleId,
    });
    if (tErr) {
      await undoRecordClosing(proposalId, createdSaleId, tErr.message);
      proposalId = null;
      if (tErr.code === 'P0001') return res.status(409).json({ error: tErr.message });
      throw tErr;
    }

    // Buyer contact: fill phone/email the transfer did not set (never overwrite).
    if (t.new_contact_id && (b.buyer_phone || b.buyer_email)) {
      const { data: bc, error: bcErr } = await supabase.from('contacts').select('primary_phone, primary_email').eq('id', t.new_contact_id).maybeSingle();
      if (bcErr) console.warn('[home-sales] buyer contact read failed:', bcErr.message);
      const patch = {};
      if (bc && !bc.primary_phone && b.buyer_phone) patch.primary_phone = String(b.buyer_phone).trim();
      if (bc && !bc.primary_email && b.buyer_email) patch.primary_email = String(b.buyer_email).trim();
      if (Object.keys(patch).length) {
        const { error: pErr } = await supabase.from('contacts').update(patch).eq('id', t.new_contact_id);
        if (pErr) console.warn('[home-sales] buyer contact update failed:', pErr.message);
      }
    }

    // Seller payoff: posted to the SELLER tenure the transfer just closed, never the
    // buyer. A failure here does not undo the transfer; it is reported as pending
    // and retried idempotently from the sale (POST /payoff-retry).
    let payoff = null;
    if (checkPlan.payoff) {
      if (t.seller_tenure_id !== sellerTenureBefore) {
        payoff = { status: 'pending', error: 'seller tenure changed during the transfer; payoff not posted' };
      } else {
        try {
          payoff = await postTenurePayment(supabase, payoffArgs(b, checkPlan.payoff, t.seller_tenure_id, saleId, prop.id));
        } catch (e) {
          console.error('[home-sales] payoff post failed (transfer stands):', e.message);
          payoff = { status: 'pending', error: safeErrorMessage(e) };
        }
      }
    }

    const { data: sale, error: sErr } = await supabase.from('home_sales').select('*').eq('id', saleId).maybeSingle();
    if (sErr) throw sErr;
    const sellerFinalCents = t.seller_balance_cents;
    const sellerCleared = snap.balance_status !== 'UNKNOWN' && Number(sellerFinalCents) === 0;
    res.json({
      sale,
      ownership_proposal_id: prop.id,
      new_owner_contact_id: t.new_contact_id,
      settlement_date: t.settlement_date,
      seller_end_date: t.seller_end_date,
      seller_final_balance_cents: sellerFinalCents,
      seller_cleared: sellerCleared,
      seller_balance_status: snap.balance_status,
      transfer_exceptions: t.transfer_exceptions || [],
      seller_tenure_id: t.seller_tenure_id,
      payoff,
      warning: sellerCleared ? null : (snap.balance_status === 'UNKNOWN' ? 'seller_balance_unknown' : 'seller_balance_not_zero'),
    });
  } catch (err) {
    console.error('[home-sales] record-closing failed:', err.message);
    if (proposalId) await undoRecordClosing(proposalId, createdSaleId, err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Closing checks from the scan form: [{check_number, amount_cents, check_date,
// payee, memo, classification, purpose}]. Returns totals by class and the one
// seller payoff (if any), or an error. Absent checks = the older single-fee form.
function validateClosingChecks(b) {
  if (!Array.isArray(b.checks) || !b.checks.length) return { checks: null, payoff: null };
  const checks = [];
  let bedrockFeeCents = 0, associationFeeCents = 0; const payoffs = [];
  for (const c of b.checks) {
    const cls = String(c.classification || '');
    const amt = Math.round(Number(c.amount_cents));
    if (!CHECK_CLASSES.includes(cls)) return { error: 'check_classification_invalid' };
    if (cls === 'NEEDS_CLASSIFICATION') return { error: `check_needs_classification: check ${c.check_number || '(no number)'} must be classified by payee before recording` };
    if (!(amt > 0)) return { error: `check_amount_required: check ${c.check_number || '(no number)'}` };
    const row = { check_number: c.check_number ? String(c.check_number).trim() : null, amount_cents: amt, check_date: c.check_date || null,
      payee: c.payee || null, memo: c.memo || null, classification: cls, purpose: c.purpose || null };
    if (cls === 'BEDROCK_FEE') bedrockFeeCents += amt;
    if (cls === 'ASSOCIATION_PAYMENT') {
      if (row.purpose === 'seller_payoff') payoffs.push(row);
      else if (row.purpose === 'association_fee') associationFeeCents += amt;
      else return { error: `association_check_purpose_required: say whether check ${row.check_number || ''} pays the seller's balance or an Association fee` };
    }
    checks.push(row);
  }
  if (payoffs.length > 1) return { error: 'one_seller_payoff_check_per_closing' };
  const payoff = payoffs[0] || null;
  if (payoff && (!payoff.check_number || !/^\d{4}-\d{2}-\d{2}$/.test(String(payoff.check_date || '')))) {
    return { error: 'payoff_check_number_and_date_required' };
  }
  return { checks, payoff, bedrockFeeCents, associationFeeCents };
}

function payoffArgs(b, payoff, tenureId, saleId, proposalId) {
  return {
    communityId: b.community_id, propertyId: b.property_id, tenureId,
    amountCents: payoff.amount_cents, paymentDate: payoff.check_date, checkNumber: payoff.check_number, payee: payoff.payee,
    approvedBy: b.reviewed_by || 'home_sales', label: b.property_label || null,
    source: { home_sale_id: saleId, ownership_proposal_id: proposalId, closing_date: b.closing_date,
      document: b.source_document_name || 'closing packet', title_company: b.title_company_name || null, memo: payoff.memo || null },
  };
}

// ----------------------------------------------------------------------------
// POST /api/home-sales/payoff-preview — dry run of a seller payoff (no writes).
//   body: { community_id, property_id, check_number, amount_cents, check_date, payee }
//   Shows the seller tenure, balance by category, the 209.0063 application order,
//   the ending balance, the payment row and the GL entry that would post.
// ----------------------------------------------------------------------------
router.post('/payoff-preview', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    for (const k of ['community_id', 'property_id', 'check_number', 'amount_cents', 'check_date']) {
      if (!b[k]) return res.status(400).json({ error: k + '_required' });
    }
    const snap = await propertySnapshot(b.community_id, b.property_id);
    if (!snap) return res.status(404).json({ error: 'property_not_found' });
    if (!snap.owner || !snap.owner.tenure_id) return res.status(409).json({ error: 'seller_required' });
    const plan = await planTenurePayment(supabase, payoffArgs({ ...b, property_label: snap.property.street_address },
      { check_number: b.check_number, amount_cents: Math.round(Number(b.amount_cents)), check_date: b.check_date, payee: b.payee || null }, snap.owner.tenure_id, null, null));
    res.json({ seller_name: snap.owner.owner_name, seller_tenure_id: snap.owner.tenure_id, seller_balance_status: snap.balance_status,
      seller_balance_cents: snap.balance_cents, plan, ties: !plan.already_posted && Number(plan.applied_cents) === Math.round(Number(b.amount_cents)) });
  } catch (err) {
    console.error('[home-sales] payoff-preview failed:', err.message);
    res.status(err.code === 'P0001' ? 409 : 500).json({ error: err.code === 'P0001' ? err.message : safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /api/home-sales/payoff-retry — finish a seller payoff that did not post
// after the transfer succeeded. Idempotent; always the sale's SELLER tenure.
//   body: { home_sale_id, reviewed_by? }
// ----------------------------------------------------------------------------
router.post('/payoff-retry', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.home_sale_id) return res.status(400).json({ error: 'home_sale_id_required' });
    const { data: sale, error } = await supabase.from('home_sales')
      .select('id, community_id, property_id, status, closing_date, ownership_proposal_id, raw_extraction, properties(street_address)')
      .eq('id', b.home_sale_id).maybeSingle();
    if (error) throw error;
    if (!sale) return res.status(404).json({ error: 'home_sale_not_found' });
    if (sale.status !== 'closed' || !sale.ownership_proposal_id) return res.status(409).json({ error: 'sale_not_closed' });
    const payoff = sale.raw_extraction && sale.raw_extraction.closing_payoff;
    if (!payoff) return res.status(409).json({ error: 'no_seller_payoff_on_this_sale' });
    const { data: pr, error: pe } = await supabase.from('ownership_change_proposals')
      .select('seller_tenure_id, status').eq('id', sale.ownership_proposal_id).maybeSingle();
    if (pe) throw pe;
    if (!pr || pr.status !== 'approved' || !pr.seller_tenure_id) return res.status(409).json({ error: 'seller_tenure_unknown' });
    const r = await postTenurePayment(supabase, payoffArgs({
      community_id: sale.community_id, property_id: sale.property_id, closing_date: sale.closing_date, reviewed_by: b.reviewed_by,
      property_label: sale.properties && sale.properties.street_address,
      source_document_name: sale.raw_extraction.source_document_name,
    }, payoff, pr.seller_tenure_id, sale.id, sale.ownership_proposal_id));
    res.json({ payoff: r });
  } catch (err) {
    console.error('[home-sales] payoff-retry failed:', err.message);
    res.status(err.code === 'P0001' ? 409 : 500).json({ error: err.code === 'P0001' ? err.message : safeErrorMessage(err) });
  }
});

// Loose name match between the closing document's seller and the owner of
// record: any significant word in common ("Jeanne Baker" ~ "Jim & Jeanne Baker").
// Entity boilerplate is ignored so "Harkor Homes LLC" never matches "Fiat Homes LLC".
const NAME_NOISE = new Set(['llc', 'inc', 'co', 'corp', 'company', 'ltd', 'lp', 'llp', 'homes', 'home', 'trust', 'trustee', 'trustees',
  'revocable', 'living', 'family', 'estate', 'the', 'and', 'of', 'et', 'al', 'ux', 'mr', 'mrs', 'ms', 'jr', 'sr']);
function nameWords(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 2 && !NAME_NOISE.has(w));
}
function sellerMatchesOwner(docSeller, ownerName) {
  const owner = new Set(nameWords(ownerName));
  return nameWords(docSeller).some((w) => owner.has(w));
}

// A refused or failed transfer leaves no half-state: the pending proposal is
// withdrawn with the reason (kept for audit) and a sale row created by this
// request is removed. Ownership was never touched (the DB transfer is atomic).
async function undoRecordClosing(proposalId, createdSaleId, reason) {
  try {
    const { data: p, error: pErr } = await supabase.from('ownership_change_proposals').select('status').eq('id', proposalId).maybeSingle();
    if (pErr) throw pErr;
    if (p && p.status === 'approved') return;               // the transfer did happen; keep everything
    if (p && p.status === 'pending') {
      const { error } = await supabase.from('ownership_change_proposals')
        .update({ status: 'withdrawn', decision_notes: 'Home Sales record-closing refused: ' + String(reason).slice(0, 500), home_sale_id: null })
        .eq('id', proposalId);
      if (error) console.warn('[home-sales] could not withdraw proposal', proposalId, error.message);
    }
    if (createdSaleId) {
      const { error } = await supabase.from('home_sales').delete().eq('id', createdSaleId).neq('status', 'closed');
      if (error) console.warn('[home-sales] could not remove unclosed sale row', createdSaleId, error.message);
    }
  } catch (e) {
    console.warn('[home-sales] undoRecordClosing failed:', e.message);
  }
}

module.exports = router;
module.exports._test = { balanceFromAR, propertySnapshot, sellerMatchesOwner, classifyCheckPayee, validateClosingChecks };
