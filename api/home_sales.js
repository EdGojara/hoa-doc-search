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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = express.Router();

// Stages that mean a violation is still OPEN (everything else = resolved).
const OPEN_VIOLATION_STAGES = ['courtesy_1', 'courtesy_2', 'certified_209', 'fine_assessed'];

// ----------------------------------------------------------------------------
// Helper — the disclosure snapshot for a property: current owner, balance, DRV.
// This is the Part-1 answer (what title is asking for) and is also captured at
// closing to prove the seller's account cleared.
// ----------------------------------------------------------------------------
async function propertySnapshot(community_id, property_id) {
  const [propRes, ownerRes, balRes, violRes] = await Promise.all([
    supabase.from('properties')
      .select('id, community_id, street_address, unit, city, state, zip')
      .eq('id', property_id).maybeSingle(),
    supabase.from('v_current_property_owners')
      .select('*').eq('property_id', property_id).maybeSingle(),
    supabase.from('v_owner_ar_balance')
      .select('*').eq('property_id', property_id).maybeSingle(),
    supabase.from('violations')
      .select('id, current_stage, opened_at')
      .eq('property_id', property_id)
      .in('current_stage', OPEN_VIOLATION_STAGES),
  ]);

  if (propRes.error) throw propRes.error;
  const prop = propRes.data;
  if (!prop) return null;
  // Defense in depth: never leak another community's property.
  if (community_id && prop.community_id !== community_id) return null;

  const owner = ownerRes.data || null;
  const bal = balRes.data || null;
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
    balance_cents: bal ? Number(bal.total_balance_cents || 0) : 0,
    balance_as_of: bal ? (bal.snapshot_date || bal.as_of_date || null) : null,
    balance_is_zero: bal ? Number(bal.total_balance_cents || 0) === 0 : true,
    drv_clean: openViolations.length === 0,
    open_violations_count: openViolations.length,
    worst_open_stage: worst,
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
    const [ownRes, saleRes] = await Promise.all([
      supabase.from('property_ownerships')
        .select('id, contact_id, start_date, end_date, vesting, is_primary, source, contacts(full_name, primary_email)')
        .eq('property_id', property_id)
        .order('start_date', { ascending: false }),
      supabase.from('home_sales')
        .select('*')
        .eq('property_id', property_id)
        .order('closing_date', { ascending: false, nullsFirst: false }),
    ]);
    if (ownRes.error) throw ownRes.error;
    if (saleRes.error) throw saleRes.error;
    res.json({ ownerships: ownRes.data || [], sales: saleRes.data || [] });
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
  "buyer_mailing_address": "buyer's mailing address if shown, or null",
  "buyer_email": "buyer email if shown, or null",
  "closing_date": "the closing/settlement/funding date as YYYY-MM-DD, or null",
  "transfer_fee_dollars": <number or null>,            // fee paid TO the association (capital contribution / transfer fee / working capital)
  "management_transfer_fee_dollars": <number or null>, // fee paid to the management company, if itemized separately
  "check_total_dollars": <number or null>,             // total amount of the enclosed check
  "title_company_name": "title/escrow company, or null",
  "document_type": "transfer_letter | settlement_statement | check | other",
  "confidence": "high | medium | low",
  "notes": "anything notable (multiple buyers, trust/LLC vesting, missing fee, etc.), or null"
}
Dollar amounts: numbers only, no $ or commas. If a field is genuinely absent, use null — do not guess.`;

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
      closing_date: parsed.closing_date || null,
      transfer_fee_cents: dollarsToCents(parsed.transfer_fee_dollars),
      management_transfer_fee_cents: dollarsToCents(parsed.management_transfer_fee_dollars),
      check_total_cents: dollarsToCents(parsed.check_total_dollars),
      title_company_name: parsed.title_company_name || null,
      document_type: parsed.document_type || null,
      confidence: parsed.confidence || null,
      notes: parsed.notes || null,
    };

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
//     closing_date, buyer_name, buyer_email?, buyer_mailing_address?,
//     transfer_fee_cents?, management_transfer_fee_cents?,
//     raw_extraction?, reviewed_by?, notes?
//   }
//   Captures the seller's final balance (verify zero), creates + approves an
//   ownership_change_proposal (seller -> buyer on closing_date), and writes the
//   closed home_sales row linked to the proposal.
// ----------------------------------------------------------------------------
router.post('/record-closing', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.community_id) return res.status(400).json({ error: 'community_id_required' });
    if (!b.property_id) return res.status(400).json({ error: 'property_id_required' });
    if (!b.buyer_name) return res.status(400).json({ error: 'buyer_name_required' });
    if (!b.closing_date) return res.status(400).json({ error: 'closing_date_required' });

    const snap = await propertySnapshot(b.community_id, b.property_id);
    if (!snap) return res.status(404).json({ error: 'property_not_found' });

    const sellerFinalCents = snap.balance_cents;          // captured at the moment of recording
    const sellerCleared = sellerFinalCents === 0;

    // 1) Create the ownership-change proposal (source: title_company).
    const propRow = {
      property_id: b.property_id,
      community_id: b.community_id,
      current_contact_id: snap.owner ? snap.owner.owner_contact_id : null,
      current_owner_name: snap.owner ? snap.owner.owner_name : null,
      current_owner_email: snap.owner ? snap.owner.owner_email : null,
      proposed_owner_name: b.buyer_name,
      proposed_owner_email: b.buyer_email || null,
      proposed_mailing_address: b.buyer_mailing_address || null,
      source: 'title_company',
      status: 'pending',
      effective_start_date: b.closing_date,
      effective_end_date_prior: b.closing_date,
    };
    const { data: prop, error: propErr } = await supabase
      .from('ownership_change_proposals').insert(propRow).select().maybeSingle();
    if (propErr) throw propErr;

    // 2) Approve it — this closes the seller (end_date = closing_date) and opens the buyer.
    const { data: approveRes, error: approveErr } = await supabase.rpc('approve_ownership_proposal', {
      p_proposal_id: prop.id,
      p_reviewed_by: b.reviewed_by || 'home_sales',
      p_notes: `Closing recorded via Home Sales${b.notes ? ' — ' + b.notes : ''}`,
    });
    if (approveErr) throw approveErr;
    const newContactId = approveRes && approveRes.new_contact_id ? approveRes.new_contact_id : null;

    // 3) Write/upsert the closed home_sales row linked to the proposal.
    const saleRow = {
      community_id: b.community_id,
      property_id: b.property_id,
      status: 'closed',
      seller_contact_id: snap.owner ? snap.owner.owner_contact_id : null,
      seller_name: snap.owner ? snap.owner.owner_name : null,
      closing_notice_received_at: b.closing_notice_received_at || new Date().toISOString().slice(0, 10),
      closing_date: b.closing_date,
      buyer_name: b.buyer_name,
      buyer_email: b.buyer_email || null,
      buyer_mailing_address: b.buyer_mailing_address || null,
      buyer_contact_id: newContactId,
      transfer_fee_cents: b.transfer_fee_cents != null ? b.transfer_fee_cents : null,
      management_transfer_fee_cents: b.management_transfer_fee_cents != null ? b.management_transfer_fee_cents : null,
      seller_final_balance_cents: sellerFinalCents,
      raw_extraction: b.raw_extraction || null,
      ownership_proposal_id: prop.id,
      ownership_updated_at: new Date().toISOString(),
      notes: b.notes || null,
    };

    let sale;
    if (b.sale_id) {
      const { data, error } = await supabase.from('home_sales')
        .update(saleRow).eq('id', b.sale_id).select().maybeSingle();
      if (error) throw error;
      sale = data;
    } else {
      const { data, error } = await supabase.from('home_sales')
        .insert(saleRow).select().maybeSingle();
      if (error) throw error;
      sale = data;
    }

    res.json({
      sale,
      ownership_proposal_id: prop.id,
      new_owner_contact_id: newContactId,
      seller_final_balance_cents: sellerFinalCents,
      seller_cleared: sellerCleared,
      warning: sellerCleared ? null : 'seller_balance_not_zero',
    });
  } catch (err) {
    console.error('[home-sales] record-closing failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
