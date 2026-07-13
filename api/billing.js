// ============================================================================
// Bedrock Billing API
// ----------------------------------------------------------------------------
// Endpoints under /api/billing for the Bedrock Office > Client Billing module.
//
// Tenancy: until auth lands, every call is scoped to BEDROCK_MGMT_CO_ID, the
// hardcoded UUID that already appears in server.js. This module reads the
// constant from the environment-loaded server context (passed via init).
//
// Endpoints (v0):
//   GET  /api/billing/communities
//        -> list active communities + active-contract summary
//   GET  /api/billing/communities/:communityId/contract
//        -> active contract + full fee schedule (via v_contract_fee_schedule)
//   POST /api/billing/communities/:communityId/draft-invoice
//        body: { type: 'fixed'|'activity', period: 'YYYY-MM' }
//        -> creates a draft invoice with line items pulled from the contract
//           rate card. For 'activity', quantities default to 0 — staff fills
//           them in (or the Vantaca activity import lands later and populates).
//   GET  /api/billing/invoices?status=draft&limit=50
//        -> list invoices with optional filters
//   GET  /api/billing/invoices/:invoiceId
//        -> invoice + line items + event history (the audit trail)
//
// Operating-model hook: every draft-invoice call first checks kill_switches
// for an active halt on the 'billing' module for this community. If halted,
// returns 423 Locked with the reason. Resumption is a manual DB update for
// now (eventually a privileged-user action in the UI).
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const puppeteer = require('puppeteer');
const { renderInvoiceHTML } = require('./invoice_template');
const BRAND = require('../lib/brand');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const router = express.Router();

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Generate the invoice number from the YYMM+vantaca_code+suffix pattern
 * Bedrock already uses (e.g. 2510WV for Oct 2025 Waterview fixed,
 * 2601WV2 for Jan 2026 Waterview activity).
 */
function buildInvoiceNumber({ billingCode, vantacaCode, period, type }) {
  const [yyyy, mm] = period.split('-');
  const yy = yyyy.slice(2);
  const suffix = type === 'activity' ? '2' : '';
  // billing_code is the community identifier now; fall back to the legacy
  // vantaca_code during the transition.
  const code = billingCode || vantacaCode || '';
  return `${yy}${mm}${code}${suffix}`;
}

/**
 * First and last day of a YYYY-MM period.
 */
function periodBoundaries(period) {
  const [y, m] = period.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));   // day 0 of next month = last day of this month
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

/**
 * Check for an active kill switch on a (mgmt_co, community, module) scope.
 * Returns the active row if halted, null if clear.
 */
async function getActiveKillSwitch({ managementCompanyId, communityId, module }) {
  // Halt can be community-specific or cross-community (community_id IS NULL).
  const { data, error } = await supabase
    .from('kill_switches')
    .select('*')
    .eq('management_company_id', managementCompanyId)
    .eq('module', module)
    .is('resumed_at', null)
    .or(`community_id.eq.${communityId},community_id.is.null`)
    .order('paused_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('[billing] kill switch check failed:', error.message);
    return null;
  }
  return data && data.length > 0 ? data[0] : null;
}

/**
 * Round to 2 decimal places without floating-point surprise.
 */
function money(n) {
  return Math.round(Number(n) * 100) / 100;
}

// ----------------------------------------------------------------------------
// GET /api/billing/communities
// ----------------------------------------------------------------------------
router.get('/communities', async (req, res) => {
  try {
    const { data: communities, error } = await supabase
      .from('communities')
      .select(`
        id, name, legal_name, slug, vantaca_code, billing_code, total_lots, active,
        contracts:contracts(id, version, effective_date, escalator_kind, escalator_pct, status)
      `)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('active', true)
      .order('name');

    if (error) throw error;

    // Reduce contract array to the one active contract (if any) for cleaner UI.
    const enriched = (communities || []).map(c => {
      const active = (c.contracts || []).find(ct => ct.status === 'active') || null;
      return {
        id: c.id,
        name: c.name,
        legal_name: c.legal_name,
        slug: c.slug,
        vantaca_code: c.vantaca_code,
        billing_code: c.billing_code,
        total_lots: c.total_lots,
        active_contract: active
          ? {
              id: active.id,
              version: active.version,
              effective_date: active.effective_date,
              escalator_kind: active.escalator_kind,
              escalator_pct: active.escalator_pct
            }
          : null
      };
    });

    res.json({ communities: enriched });
  } catch (err) {
    console.error('[billing] /communities failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/billing/communities/:communityId/contract
// Returns the active contract + full fee schedule (fixed, reimbursables,
// owner charges) via the v_contract_fee_schedule view.
// ----------------------------------------------------------------------------
router.get('/communities/:communityId/contract', async (req, res) => {
  const { communityId } = req.params;
  try {
    const { data: contractRows, error: contractErr } = await supabase
      .from('contracts')
      .select('*')
      .eq('community_id', communityId)
      .eq('status', 'active')
      .order('version', { ascending: false })
      .limit(1);

    if (contractErr) throw contractErr;
    if (!contractRows || contractRows.length === 0) {
      return res.status(404).json({ error: 'No active contract for this community' });
    }
    const contract = contractRows[0];

    const { data: schedule, error: schedErr } = await supabase
      .from('v_contract_fee_schedule')
      .select('*')
      .eq('contract_id', contract.id)
      .order('sort_order');

    if (schedErr) throw schedErr;

    // Group by section for cleaner consumption by the UI.
    const grouped = {
      fixed: (schedule || []).filter(r => r.section === 'fixed'),
      reimbursables: (schedule || []).filter(r => r.section === 'reimbursable'),
      owner_charges: (schedule || []).filter(r => r.section === 'owner_charge')
    };

    res.json({ contract, fee_schedule: grouped });
  } catch (err) {
    console.error('[billing] /contract failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Build the default draft line items for a contract + type + period. Fixed =
// one line per contract_fixed_items (qty 1). Activity = last month's billed
// lines (qty reset) if there is a prior invoice, else the default_on_invoice
// rate rows (mig 271), qty 0. Extracted so the generate-preview endpoint and
// the create endpoint share ONE definition of "what lines go on this invoice".
async function buildDraftLineItems({ contractId, type, period, communityId }) {
  if (type === 'fixed') {
    const { data: fixed, error } = await supabase
      .from('contract_fixed_items').select('*').eq('contract_id', contractId).order('sort_order');
    if (error) throw error;
    const lines = (fixed || []).map((f) => ({
      source: 'contract_fixed', source_ref_id: f.id, category: null, description: f.description,
      qty: 1, unit_price: Number(f.monthly_amount), amount: money(f.monthly_amount), sort_order: f.sort_order,
    }));
    // Per-lot management fee broken out as rate x lot count (Ed 2026-07-10) when
    // the contract carries a per-lot fee. lot_count is what we bill against
    // (homeowners on record); edit it on the contract as owners move in.
    const { data: c } = await supabase.from('contracts')
      .select('per_lot_monthly_fee, lot_count').eq('id', contractId).maybeSingle();
    if (c && c.per_lot_monthly_fee != null && Number(c.per_lot_monthly_fee) > 0) {
      const lots = Number(c.lot_count || 0);
      const rate = Number(c.per_lot_monthly_fee);
      lines.push({
        source: 'contract_fixed', source_ref_id: null, category: null,
        description: 'Management Fee — per lot', qty: lots, unit_price: rate,
        amount: money(rate * lots), sort_order: 15,
      });
    }
    return lines.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  }
  // activity — categories are sorted ALPHABETICALLY by description (Ed 2026-07-10,
  // easier to find), with sort_order reassigned so the order persists onto the
  // saved invoice + PDF.
  const alpha = (arr) => arr.slice()
    .sort((a, b) => String(a.description || '').localeCompare(String(b.description || '')))
    .map((l, i) => ({ ...l, sort_order: i * 10 }));
  const periodStart = period + '-01';
  const { data: priorInv } = await supabase
    .from('invoices').select('id')
    .eq('community_id', communityId).eq('invoice_type', 'activity').neq('status', 'voided')
    .lt('service_period_start', periodStart).order('service_period_start', { ascending: false })
    .limit(1).maybeSingle();
  let priorLines = [];
  if (priorInv) {
    const { data: pl } = await supabase
      .from('invoice_line_items').select('source, source_ref_id, category, description, unit_price, sort_order')
      .eq('invoice_id', priorInv.id).gt('qty', 0).order('sort_order');
    priorLines = pl || [];
  }
  if (priorLines.length > 0) {
    return alpha(priorLines.map((p) => ({
      source: p.source, source_ref_id: p.source_ref_id, category: p.category, description: p.description,
      qty: 0, unit_price: Number(p.unit_price || 0), amount: 0, sort_order: p.sort_order,
    })));
  }
  const { data: reimb, error: rErr } = await supabase
    .from('contract_reimbursables').select('*').eq('contract_id', contractId).eq('default_on_invoice', true).order('sort_order');
  if (rErr) throw rErr;
  const { data: owner, error: oErr } = await supabase
    .from('contract_owner_charges').select('*').eq('contract_id', contractId).eq('default_on_invoice', true).order('sort_order');
  if (oErr) throw oErr;
  const lines = (reimb || []).map((r) => ({
    source: 'reimbursable', source_ref_id: r.id, category: r.category, description: r.description,
    qty: 0, unit_price: r.unit_price !== null ? Number(r.unit_price) : 0, amount: 0,
    vantaca_source_ref: r.vantaca_source, sort_order: r.sort_order,
  }));
  const ownerOffset = 1000;
  (owner || []).forEach((o) => lines.push({
    source: 'owner_charge', source_ref_id: o.id, category: o.category, description: o.description,
    qty: 0, unit_price: Number(o.fee_amount), amount: 0, sort_order: ownerOffset + o.sort_order,
  }));
  return alpha(lines);
}

// Sanitize client-supplied line items to the exact invoice_line_items columns
// (the create endpoint spreads them straight into the insert).
function sanitizeDraftLines(arr) {
  return (Array.isArray(arr) ? arr : []).map((li, idx) => {
    const qty = Number(li.qty || 0);
    const unit = Number(li.unit_price || 0);
    return {
      source: li.source || 'adhoc', source_ref_id: li.source_ref_id || null,
      category: li.category || null, description: li.description || '(no description)',
      qty, unit_price: unit, amount: money(qty * unit),
      vantaca_source_ref: li.vantaca_source_ref || null,
      sort_order: li.sort_order != null ? li.sort_order : idx * 10,
    };
  });
}

// Pending ad-hoc charges (billing_pending_items) staged for a community, shaped
// as draft line objects so they drop onto the worksheet after the standard
// lines. Each carries a `pending_item_id` marker the generate endpoint uses to
// flip the staged row to 'billed'. Migration-safe: returns [] if 296 isn't
// applied yet.
async function pendingItemsAsLines(communityId) {
  const { data, error } = await supabase.from('billing_pending_items')
    .select('id, category, description, qty, unit_price, amount, source, submitted_by')
    .eq('community_id', communityId).eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) {
    if (!/billing_pending_items|relation|does not exist|column/i.test(error.message || '')) console.warn('[billing] pending items:', error.message);
    return [];
  }
  return (data || []).map((p, i) => ({
    source: 'adhoc', source_ref_id: null,
    category: p.category || null, description: p.description,
    qty: Number(p.qty || 0), unit_price: Number(p.unit_price || 0), amount: Number(p.amount || 0),
    sort_order: 5000 + i * 10,     // after the standard rate-card / activity lines
    pending_item_id: p.id,         // marker: generate flips these to 'billed'
    _pending_source: p.source, _pending_by: p.submitted_by || null,
  }));
}

// ----------------------------------------------------------------------------
// GET /api/billing/communities/:communityId/draft-invoice/preview?type=&period=
// The line items a draft WOULD get, without creating anything — so the operator
// can review/edit the categories before generating. Same builder as create.
// ----------------------------------------------------------------------------
router.get('/communities/:communityId/draft-invoice/preview', async (req, res) => {
  const { communityId } = req.params;
  const type = req.query.type;
  const period = req.query.period;
  if (!['fixed', 'activity'].includes(type)) return res.status(400).json({ error: "type must be 'fixed' or 'activity'" });
  if (!/^\d{4}-\d{2}$/.test(period || '')) return res.status(400).json({ error: "period must be 'YYYY-MM'" });
  try {
    const { data: contracts, error } = await supabase
      .from('contracts').select('id').eq('community_id', communityId).eq('status', 'active')
      .order('version', { ascending: false }).limit(1);
    if (error) throw error;
    if (!contracts || !contracts.length) return res.status(404).json({ error: 'No active contract for this community' });
    const lineItems = await buildDraftLineItems({ contractId: contracts[0].id, type, period, communityId });
    // Ad-hoc charges staged for this community (Tessa email intake / manual add)
    // ride on activity invoices, after the standard lines.
    const pending = type === 'activity' ? await pendingItemsAsLines(communityId) : [];
    res.json({ line_items: [...lineItems, ...pending], pending_count: pending.length });
  } catch (err) {
    console.error('[billing] draft-invoice preview failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/billing/communities/:communityId/recalc-lot-count
// Recompute the active contract's lot_count from HOMEOWNERS ON RECORD (properties
// with a current owner), so the per-lot management fee stays current as a
// community sells out. Returns the new count + per-lot dollar amount.
// ----------------------------------------------------------------------------
router.post('/communities/:communityId/recalc-lot-count', async (req, res) => {
  const { communityId } = req.params;
  try {
    const { data: contracts } = await supabase.from('contracts')
      .select('id, per_lot_monthly_fee, lot_count').eq('community_id', communityId)
      .eq('status', 'active').order('version', { ascending: false }).limit(1);
    if (!contracts || !contracts.length) return res.status(404).json({ error: 'No active contract for this community' });
    const contract = contracts[0];

    // All property ids for the community (paged past the 1000-row cap).
    const propIds = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('properties').select('id').eq('community_id', communityId).range(from, from + 999);
      if (error) throw error;
      propIds.push(...(data || []).map((p) => p.id));
      if (!data || data.length < 1000) break;
    }
    // Homeowners on record = properties with a current (active) owner contact.
    const owned = new Set();
    for (let i = 0; i < propIds.length; i += 200) {
      const { data: own } = await supabase.from('property_ownerships')
        .select('property_id, contact_id').in('property_id', propIds.slice(i, i + 200)).is('end_date', null);
      (own || []).forEach((o) => { if (o.contact_id) owned.add(o.property_id); });
    }
    const count = owned.size;
    const { error: upErr } = await supabase.from('contracts').update({ lot_count: count }).eq('id', contract.id);
    if (upErr) throw upErr;
    const rate = Number(contract.per_lot_monthly_fee || 0);
    res.json({ ok: true, lot_count: count, prior_lot_count: contract.lot_count, per_lot_monthly_fee: rate, per_lot_amount: money(rate * count), has_per_lot: rate > 0 });
  } catch (err) {
    console.error('[billing] recalc-lot-count failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/billing/communities/:communityId/draft-invoice
// body: { type: 'fixed' | 'activity', period: 'YYYY-MM', invoice_date?, line_items? }
//
// FIXED:
//   Creates a draft invoice with one line item per contract_fixed_items row.
//   subtotal = sum(monthly_amount).
//
// ACTIVITY:
//   Creates a draft invoice with one line item per contract_reimbursables and
//   contract_owner_charges row, qty=0 (staff fills in, or Vantaca import does).
//   amount = 0 until staff/import sets quantities.
//
// Rejects with 423 if billing is killed for this community.
// Records an invoice_events 'created' row with the inputs.
// ----------------------------------------------------------------------------
router.post('/communities/:communityId/draft-invoice', async (req, res) => {
  const { communityId } = req.params;
  const { type, period, invoice_date: invoiceDateOverride, line_items: clientLines } = req.body || {};

  if (!['fixed', 'activity'].includes(type)) {
    return res.status(400).json({ error: "type must be 'fixed' or 'activity'" });
  }
  if (!/^\d{4}-\d{2}$/.test(period || '')) {
    return res.status(400).json({ error: "period must be 'YYYY-MM'" });
  }

  try {
    // Kill switch check before any work.
    const halt = await getActiveKillSwitch({
      managementCompanyId: BEDROCK_MGMT_CO_ID,
      communityId,
      module: 'billing'
    });
    if (halt) {
      return res.status(423).json({
        error: 'Billing module is currently halted for this scope',
        reason: halt.reason,
        paused_at: halt.paused_at,
        kill_switch_id: halt.id
      });
    }

    // Resolve community + active contract.
    const { data: comm, error: commErr } = await supabase
      .from('communities')
      .select('id, name, vantaca_code, billing_code, management_company_id')
      .eq('id', communityId)
      .single();
    if (commErr || !comm) return res.status(404).json({ error: 'Community not found' });

    const { data: contracts, error: ctErr } = await supabase
      .from('contracts')
      .select('id, version, payment_terms')
      .eq('community_id', communityId)
      .eq('status', 'active')
      .order('version', { ascending: false })
      .limit(1);
    if (ctErr) throw ctErr;
    if (!contracts || contracts.length === 0) {
      return res.status(404).json({ error: 'No active contract for this community' });
    }
    const contract = contracts[0];

    // Build line items: use the operator's reviewed/edited lines from the
    // generate preview when supplied, else the default builder (same source the
    // preview endpoint uses, so they match).
    const lineItems = (Array.isArray(clientLines) && clientLines.length)
      ? sanitizeDraftLines(clientLines)
      : await buildDraftLineItems({ contractId: contract.id, type, period, communityId });

    const subtotal = money(lineItems.reduce((s, li) => s + Number(li.amount || 0), 0));
    const { start: serviceStart, end: serviceEnd } = periodBoundaries(period);
    const invoiceDate = invoiceDateOverride || new Date().toISOString().slice(0, 10);
    const invoiceNumber = buildInvoiceNumber({
      billingCode: comm.billing_code,
      vantacaCode: comm.vantaca_code,
      period,
      type
    });

    // Create the invoice.
    const { data: invoiceRows, error: insErr } = await supabase
      .from('invoices')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id: communityId,
        contract_id: contract.id,
        contract_version: contract.version,
        invoice_number: invoiceNumber,
        invoice_type: type,
        service_period_start: serviceStart,
        service_period_end: serviceEnd,
        invoice_date: invoiceDate,
        payment_terms: contract.payment_terms,
        status: 'draft',
        subtotal,
        total: subtotal,
        recipient_name: comm.name
      })
      .select()
      .single();
    if (insErr) {
      // 23505 = unique_violation. Most common cause: a draft already exists
      // for (community, type, period). Return 409 with the existing invoice
      // so the UI can offer to view it instead of silently failing.
      if (insErr.code === '23505') {
        const { data: existing } = await supabase
          .from('invoices')
          .select('id, invoice_number, invoice_type, status, subtotal, total, created_at, service_period_start, service_period_end')
          .eq('management_company_id', BEDROCK_MGMT_CO_ID)
          .eq('invoice_number', invoiceNumber)
          .single();
        return res.status(409).json({
          error: `Invoice ${invoiceNumber} already exists for this period.`,
          invoice_number: invoiceNumber,
          existing
        });
      }
      throw insErr;
    }

    // Insert line items.
    if (lineItems.length > 0) {
      const itemsToInsert = lineItems.map(li => ({
        ...li,
        invoice_id: invoiceRows.id
      }));
      const { error: liErr } = await supabase
        .from('invoice_line_items')
        .insert(itemsToInsert);
      if (liErr) throw liErr;
    }

    // Flip any staged pending charges that made it onto this invoice to 'billed'
    // (the client lines carry a pending_item_id marker; sanitize strips it, so
    // read it from the raw client lines). Best-effort — never fail the invoice.
    const pendingItemIds = (Array.isArray(clientLines) ? clientLines : [])
      .map((l) => l && l.pending_item_id).filter(Boolean);
    if (pendingItemIds.length) {
      const { error: pbErr } = await supabase.from('billing_pending_items')
        .update({ status: 'billed', invoice_id: invoiceRows.id, billed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .in('id', pendingItemIds).eq('status', 'pending');
      if (pbErr) console.warn('[billing] mark pending items billed failed:', pbErr.message);
    }

    // Event row.
    const { error: evErr } = await supabase
      .from('invoice_events')
      .insert({
        invoice_id: invoiceRows.id,
        kind: 'created',
        payload: {
          source: 'api/billing draft-invoice',
          type,
          period,
          line_count: lineItems.length,
          subtotal
        }
      });
    if (evErr) throw evErr;

    res.json({
      invoice: invoiceRows,
      line_items_count: lineItems.length,
      subtotal,
      invoice_number: invoiceNumber
    });
  } catch (err) {
    console.error('[billing] draft-invoice failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/billing/communities/:communityId/builder-invoice
//   body: { builder_company_id, period: 'YYYY-MM' }
// ----------------------------------------------------------------------------
// Builder ARC billing: Bedrock invoices the BUILDER (Lennar at Still Creek, DRB
// at August Meadows) for the new-home ARC submissions RECEIVED in the period,
// at communities.builder_arc_fee_cents each. Billed to the builder — NOT the
// association — so it is a separate invoice (invoice_type='builder_arc') with
// the builder as recipient. Per submission received (Ed 2026-07-10), so the
// count keys on submitted_at, not decided_at.
// ----------------------------------------------------------------------------
router.post('/communities/:communityId/builder-invoice', async (req, res) => {
  try {
    const { communityId } = req.params;
    const builderCompanyId = (req.body && req.body.builder_company_id) || null;
    const period = (req.body && req.body.period) || '';
    if (!builderCompanyId) return res.status(400).json({ error: 'builder_company_id required' });
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'period required as YYYY-MM' });

    const { data: comm, error: commErr } = await supabase
      .from('communities')
      .select('id, name, billing_code, vantaca_code, builder_arc_fee_cents, management_company_id')
      .eq('id', communityId)
      .single();
    if (commErr || !comm) return res.status(404).json({ error: 'Community not found' });
    const feeCents = Number(comm.builder_arc_fee_cents || 0);
    if (!feeCents) return res.status(400).json({ error: 'Builder ARC fee not configured for this community (builder_arc_fee_cents).' });
    const feeDollars = money(feeCents / 100);

    const { data: builder, error: bErr } = await supabase
      .from('builder_companies')
      .select('id, company_name, legal_name, mailing_address, primary_contact_email')
      .eq('id', builderCompanyId)
      .single();
    if (bErr || !builder) return res.status(404).json({ error: 'Builder company not found' });

    const { start: serviceStart, end: serviceEnd } = periodBoundaries(period);
    // Submissions RECEIVED in the period (submitted_at). Page through in case a
    // busy builder-month exceeds the 1000-row cap.
    const subs = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('builder_applications')
        .select('id, reference_number, street_address, submitter_name, submitted_at')
        .eq('community_id', communityId)
        .eq('builder_company_id', builderCompanyId)
        .gte('submitted_at', serviceStart + 'T00:00:00Z')
        .lt('submitted_at', serviceEnd + 'T23:59:59.999Z')
        .order('submitted_at')
        .range(from, from + 999);
      if (error) throw error;
      subs.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const count = subs.length;
    const subtotal = money(count * feeDollars);

    const invoiceNumber = `${period.slice(2, 4)}${period.slice(5, 7)}${comm.billing_code || comm.vantaca_code || ''}B`;

    const { data: invoice, error: insErr } = await supabase
      .from('invoices')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id: communityId,
        builder_company_id: builderCompanyId,
        invoice_number: invoiceNumber,
        invoice_type: 'builder_arc',
        service_period_start: serviceStart,
        service_period_end: serviceEnd,
        invoice_date: new Date().toISOString().slice(0, 10),
        status: 'draft',
        subtotal,
        total: subtotal,
        recipient_name: builder.company_name,
        recipient_email: builder.primary_contact_email || null,
        recipient_address: builder.mailing_address || null,
      })
      .select()
      .single();
    if (insErr) {
      if (insErr.code === '23505') {
        const { data: existing } = await supabase
          .from('invoices')
          .select('id, invoice_number, invoice_type, status, subtotal, total, created_at, service_period_start, service_period_end')
          .eq('management_company_id', BEDROCK_MGMT_CO_ID)
          .eq('invoice_number', invoiceNumber)
          .single();
        return res.status(409).json({ error: `Builder invoice ${invoiceNumber} already exists for this period.`, invoice_number: invoiceNumber, existing });
      }
      throw insErr;
    }

    // One line item: submissions x fee. Store each reference in vantaca_source_ref
    // so the builder invoice is self-documenting (which submissions it covers).
    if (count > 0) {
      const { error: liErr } = await supabase.from('invoice_line_items').insert({
        invoice_id: invoice.id,
        source: 'adhoc',
        description: `Architectural review — new-home submissions received (${period})`,
        qty: count,
        unit_price: feeDollars,
        amount: subtotal,
        sort_order: 10,
        vantaca_source_ref: subs.map((s) => s.reference_number).filter(Boolean).join(', ').slice(0, 500) || null,
      });
      if (liErr) throw liErr;
    }

    const { error: evErr } = await supabase.from('invoice_events').insert({
      invoice_id: invoice.id,
      kind: 'created',
      payload: { source: 'api/billing builder-invoice', builder_company_id: builderCompanyId, period, submissions: count, fee_cents: feeCents, subtotal },
    });
    if (evErr) throw evErr;

    res.json({
      invoice,
      invoice_number: invoiceNumber,
      builder_name: builder.company_name,
      submissions: count,
      fee: feeDollars,
      subtotal,
      submission_refs: subs.map((s) => ({ reference_number: s.reference_number, street_address: s.street_address, submitted_at: s.submitted_at })),
    });
  } catch (err) {
    console.error('[billing] builder-invoice failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/billing/communities/:communityId/builders
// ----------------------------------------------------------------------------
// Builders active at a community (for the builder-invoice picker) with their
// current-open submission counts, so staff sees who to bill.
// ----------------------------------------------------------------------------
router.get('/communities/:communityId/builders', async (req, res) => {
  try {
    const { communityId } = req.params;
    // Builders that have submitted at this community.
    const { data: apps, error } = await supabase
      .from('builder_applications')
      .select('builder_company_id')
      .eq('community_id', communityId)
      .not('builder_company_id', 'is', null)
      .limit(5000);
    if (error) throw error;
    const ids = [...new Set((apps || []).map((a) => a.builder_company_id))];
    if (!ids.length) return res.json({ builders: [] });
    const { data: builders } = await supabase
      .from('builder_companies')
      .select('id, company_name, mailing_address, primary_contact_email')
      .in('id', ids);
    const { data: comm } = await supabase
      .from('communities').select('builder_arc_fee_cents').eq('id', communityId).single();
    res.json({
      builders: builders || [],
      builder_arc_fee_cents: comm ? Number(comm.builder_arc_fee_cents || 0) : 0,
    });
  } catch (err) {
    console.error('[billing] builders failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/billing/invoices?status=draft&limit=50&community_id=...
// ----------------------------------------------------------------------------
router.get('/invoices', async (req, res) => {
  try {
    const { status, community_id, limit } = req.query;
    let q = supabase
      .from('invoices')
      .select(`
        id, invoice_number, invoice_type,
        service_period_start, service_period_end,
        invoice_date, due_date, status,
        subtotal, total,
        community_id, contract_id, contract_version,
        builder_company_id, recipient_name,
        sent_at, paid_at, created_at,
        community:communities(name, vantaca_code)
      `)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('invoice_date', { ascending: false })
      .limit(Number(limit) || 50);

    if (status) q = q.eq('status', status);
    if (community_id) q = q.eq('community_id', community_id);

    const { data, error } = await q;
    if (error) throw error;
    res.json({ invoices: data || [] });
  } catch (err) {
    console.error('[billing] /invoices failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/billing/invoices/:invoiceId/void
// body: { reason?: string }
// Marks a draft invoice as void. Records an invoice_event with the reason.
// Once voided, the invoice_number can be reused for a fresh draft (the
// partial unique index from migration 005 only enforces uniqueness for
// non-void rows). Voided invoices stay in the audit trail forever.
// ----------------------------------------------------------------------------
router.post('/invoices/:invoiceId/void', async (req, res) => {
  const { invoiceId } = req.params;
  const reason = (req.body && req.body.reason) || 'Voided by user';
  try {
    const { data: existing, error: findErr } = await supabase
      .from('invoices')
      .select('id, status, invoice_number, sent_at')
      .eq('id', invoiceId)
      .single();
    if (findErr || !existing) return res.status(404).json({ error: 'Invoice not found' });
    if (existing.status === 'void') {
      return res.status(400).json({ error: 'Invoice is already void' });
    }
    if (existing.status === 'paid') {
      return res.status(400).json({ error: 'Cannot void a paid invoice. Issue a credit instead.' });
    }

    const { data: updated, error: updErr } = await supabase
      .from('invoices')
      .update({ status: 'void', void_reason: reason, voided_at: new Date().toISOString() })
      .eq('id', invoiceId)
      .select()
      .single();
    if (updErr) throw updErr;

    await supabase.from('invoice_events').insert({
      invoice_id: invoiceId,
      kind: 'voided',
      payload: { reason, prior_status: existing.status, was_sent: !!existing.sent_at }
    });

    res.json({ invoice: updated, voided: true });
  } catch (err) {
    console.error('[billing] void failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/billing/invoices/:invoiceId/mark-sent
// Transitions a draft/review/approved invoice to 'sent' (keeps it — sent
// invoices are the ones we retain). Records an invoice_event. Idempotent-ish:
// re-marking a sent invoice is a no-op success.
// ----------------------------------------------------------------------------
router.post('/invoices/:invoiceId/mark-sent', async (req, res) => {
  const { invoiceId } = req.params;
  try {
    const { data: existing, error: findErr } = await supabase
      .from('invoices').select('id, status').eq('id', invoiceId).single();
    if (findErr || !existing) return res.status(404).json({ error: 'Invoice not found' });
    if (existing.status === 'sent') return res.json({ invoice: existing, already_sent: true });
    if (!['draft', 'review', 'approved'].includes(existing.status)) {
      return res.status(400).json({ error: `Cannot mark a '${existing.status}' invoice as sent.` });
    }
    const { data: updated, error: updErr } = await supabase
      .from('invoices')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', invoiceId).select().single();
    if (updErr) throw updErr;
    await supabase.from('invoice_events').insert({
      invoice_id: invoiceId, kind: 'sent', payload: { prior_status: existing.status, marked_manually: true }
    });
    res.json({ invoice: updated, sent: true });
  } catch (err) {
    console.error('[billing] mark-sent failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// Emma emails the bill. Two steps on purpose (Ed 2026-07-10: "draft, staff
// clicks Send") — nothing leaves the building without a human approving it,
// because outbound financial email is a catastrophic-output surface.
//   1. GET  /invoices/:id/email-preview  → resolves recipient + drafts the
//      cover note in Emma's voice. Sends NOTHING.
//   2. POST /invoices/:id/email-send     → renders the PDF, sends as Emma with
//      the Bedrock invoice attached, logs it, marks the invoice sent.
// ----------------------------------------------------------------------------
const EMAIL_ONE_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const fmtUsd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function periodMonthLabel(startYmd) {
  const m = String(startYmd || '').match(/^(\d{4})-(\d{2})/);
  if (!m) return '';
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

// Board-member fallback: an active board member with an email, treasurer first,
// then president, then anyone.
async function resolveBoardBillingEmail(communityId) {
  const { data } = await supabase.from('board_members')
    .select('name, position, email')
    .eq('community_id', communityId).eq('is_active', true)
    .not('email', 'is', null).limit(50);
  const rows = data || [];
  const pick = (re) => rows.find((r) => re.test(String(r.position || '').toLowerCase()));
  const chosen = pick(/treasurer/) || pick(/president/) || rows[0] || null;
  return chosen ? { email: chosen.email, name: chosen.name, position: chosen.position } : null;
}

// The invoice recipient for a community: the SAVED billing contact
// (communities.billing_contact_*) is the single source of truth; fall back to
// the board treasurer/president only when no billing contact is set. Returns
// { to, cc, name, source } or null.
async function resolveInvoiceRecipient(communityId) {
  if (!communityId) return null;
  // Migration-safe: if 295 hasn't been applied yet, the billing_contact_*
  // columns don't exist — degrade to the board fallback instead of 500ing.
  const { data: comm, error: commErr } = await supabase.from('communities')
    .select('billing_contact_name, billing_contact_email, billing_cc_emails')
    .eq('id', communityId).maybeSingle();
  if (commErr) {
    if (!/billing_contact|column/i.test(commErr.message || '')) console.warn('[billing] recipient lookup:', commErr.message);
    return resolveBoardBillingEmail(communityId).then((b) => b ? { to: b.email, cc: '', name: b.name || null, source: `board ${b.position || 'member'}${b.name ? ' (' + b.name + ')' : ''}` } : null);
  }
  if (comm && comm.billing_contact_email && EMAIL_ONE_RE.test(String(comm.billing_contact_email).trim())) {
    return {
      to: comm.billing_contact_email.trim(),
      cc: (comm.billing_cc_emails || '').trim(),
      name: comm.billing_contact_name || null,
      source: 'billing contact on file',
    };
  }
  const board = await resolveBoardBillingEmail(communityId);
  if (board) {
    return { to: board.email, cc: '', name: board.name || null, source: `board ${board.position || 'member'}${board.name ? ' (' + board.name + ')' : ''}` };
  }
  return null;
}

// Cover note deliberately carries NO dollar amounts (Ed 2026-07-13 — amounts
// live on the attached invoices, not in the email body). `attachmentsDesc`
// describes what's attached (a single invoice, or the monthly package).
function draftBillingCoverNote({ invoice, community, attachmentsDesc }) {
  const period = periodMonthLabel(invoice.service_period_start);
  const commName = (community && community.name) || 'your community';
  const what = attachmentsDesc || (invoice.invoice_type === 'builder_arc'
    ? "Bedrock's architectural review invoice"
    : invoice.invoice_type === 'activity'
      ? 'the activity invoice and supporting detail'
      : 'the management invoice');
  return `Hi,\n\nPlease see attached ${what} for ${commName}${period ? ', ' + period : ''}. Let me know if you have any questions, just reply here.`;
}

router.get('/invoices/:invoiceId/email-preview', async (req, res) => {
  try {
    const { data: invoice, error } = await supabase
      .from('invoices')
      .select('id, invoice_number, invoice_type, status, total, service_period_start, service_period_end, recipient_name, recipient_email, community_id, community:communities(name, legal_name)')
      .eq('id', req.params.invoiceId).single();
    if (error || !invoice) return res.status(404).json({ error: 'Invoice not found' });

    let to = invoice.recipient_email || '';
    let cc = '';
    let recipient_source = invoice.recipient_email ? 'invoice recipient' : null;
    if (!to && invoice.invoice_type !== 'builder_arc') {
      const rcpt = await resolveInvoiceRecipient(invoice.community_id);
      if (rcpt) { to = rcpt.to; cc = rcpt.cc || ''; recipient_source = rcpt.source; }
    }
    const commName = (invoice.community && invoice.community.name) || '';
    const subject = invoice.invoice_type === 'builder_arc'
      ? `${commName} — architectural review invoice ${invoice.invoice_number}`
      : `${commName} — invoice ${invoice.invoice_number} (${periodMonthLabel(invoice.service_period_start)})`;

    res.json({
      to, cc, subject,
      body: draftBillingCoverNote({ invoice, community: invoice.community || {} }),
      recipient_source,
      has_recipient: !!to,
      recipient_name: invoice.recipient_name || null,
      invoice_number: invoice.invoice_number,
      invoice_type: invoice.invoice_type,
      total: invoice.total,
      graph_connected: require('../lib/email/graph_send').isConfigured(),
    });
  } catch (err) {
    console.error('[billing] email-preview failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/invoices/:invoiceId/email-send', async (req, res) => {
  const { invoiceId } = req.params;
  try {
    const graphSend = require('../lib/email/graph_send');
    const { buildTessaEmail } = require('../lib/email/tessa_signature');
    if (!graphSend.isConfigured()) {
      return res.status(400).json({ error: 'Tessa is not connected to email yet (Microsoft Graph credentials missing).' });
    }
    const to = String((req.body && req.body.to) || '').split(/[,;]/).map((s) => s.trim()).filter((s) => EMAIL_ONE_RE.test(s));
    const cc = String((req.body && req.body.cc) || '').split(/[,;]/).map((s) => s.trim()).filter((s) => EMAIL_ONE_RE.test(s));
    const subject = String((req.body && req.body.subject) || '').trim() || '(no subject)';
    const body = String((req.body && req.body.body) || '').trim();
    if (to.length === 0) return res.status(400).json({ error: 'Add at least one valid recipient email.' });
    if (!body) return res.status(400).json({ error: 'The email body is empty.' });

    // Load invoice for logging + status + community scope.
    const { data: invoice, error: iErr } = await supabase
      .from('invoices')
      .select('id, invoice_number, invoice_type, status, community_id, total')
      .eq('id', invoiceId).single();
    if (iErr || !invoice) return res.status(404).json({ error: 'Invoice not found' });

    // Kill-switch: a billing halt stops outbound bills.
    const halt = await getActiveKillSwitch({ managementCompanyId: BEDROCK_MGMT_CO_ID, communityId: invoice.community_id, module: 'billing' });
    if (halt) return res.status(423).json({ error: `Billing is paused for this community (${halt.reason || 'kill switch active'}). Resume it before emailing invoices.` });

    // Render the Bedrock PDF and attach it (byte-identical to the download).
    const { buffer } = await renderInvoicePdfBuffer(invoiceId);
    const { html, attachments } = buildTessaEmail(body);
    attachments.push({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: `invoice_${invoice.invoice_number || invoiceId}.pdf`,
      contentType: 'application/pdf',
      contentBytes: Buffer.from(buffer).toString('base64'),
    });

    // Invoices are Bedrock billing the association (Bedrock's own AR), so they
    // come from Tessa (Ed's office / Bedrock-side), not a community-facing
    // persona and not Emma the AP/vendor persona (Ed 2026-07-13).
    await graphSend.sendAs({ from: graphSend.TESSA_MAILBOX, to, cc, subject, html, attachments });

    // Log the outbound correspondence (association record).
    const allRecipients = [...to, ...cc];
    await supabase.from('email_messages').insert({
      mailbox: graphSend.TESSA_MAILBOX, direction: 'outbound', sender_email: graphSend.TESSA_MAILBOX,
      sender_name: 'Tessa McCall (Bedrock)', recipients: allRecipients, subject,
      body_preview: body.slice(0, 2000), classification: 'outbound_reply', classification_confidence: 'high',
      ai_summary: `Tessa emailed invoice ${invoice.invoice_number} to ${allRecipients.join(', ')}`,
      community_id: invoice.community_id, triage_status: 'handled', record_ownership: 'association_record',
      reviewed_at: new Date().toISOString(),
    });

    // Mark the invoice sent (keep it) unless it already is.
    const wasSent = invoice.status === 'sent';
    if (['draft', 'review', 'approved'].includes(invoice.status)) {
      await supabase.from('invoices').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', invoiceId);
    }
    await supabase.from('invoice_events').insert({
      invoice_id: invoiceId, kind: wasSent ? 'resent' : 'sent',
      payload: { emailed: true, via: 'tessa', to: allRecipients, subject },
    });

    res.json({ sent: true, to, cc, invoice_number: invoice.invoice_number, from: graphSend.TESSA_MAILBOX });
  } catch (err) {
    console.error('[billing] email-send failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Saved "send invoices to" contact per community — the single source of truth
// the invoice email flow auto-fills from (see resolveInvoiceRecipient).
router.get('/communities/:communityId/billing-contact', async (req, res) => {
  try {
    const { data, error } = await supabase.from('communities')
      .select('billing_contact_name, billing_contact_email, billing_cc_emails')
      .eq('id', req.params.communityId).maybeSingle();
    // Migration-safe: before 295 is applied the columns don't exist — return
    // empty + the board fallback rather than erroring.
    if (error && /billing_contact|column/i.test(error.message || '')) {
      const board = await resolveBoardBillingEmail(req.params.communityId);
      return res.json({ billing_contact_name: null, billing_contact_email: null, billing_cc_emails: null, board_fallback: board ? { email: board.email, name: board.name, position: board.position } : null, needs_migration: true });
    }
    if (error) throw error;
    // Surface the board fallback so the UI can show who invoices would go to
    // when no billing contact is set.
    let fallback = null;
    if (!data || !data.billing_contact_email) {
      const board = await resolveBoardBillingEmail(req.params.communityId);
      if (board) fallback = { email: board.email, name: board.name, position: board.position };
    }
    res.json({
      billing_contact_name: data ? data.billing_contact_name : null,
      billing_contact_email: data ? data.billing_contact_email : null,
      billing_cc_emails: data ? data.billing_cc_emails : null,
      board_fallback: fallback,
    });
  } catch (err) {
    console.error('[billing] billing-contact get failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.put('/communities/:communityId/billing-contact', async (req, res) => {
  try {
    const b = req.body || {};
    const email = String(b.billing_contact_email || '').trim();
    if (email && !EMAIL_ONE_RE.test(email)) {
      return res.status(400).json({ error: 'That primary email doesn\'t look valid.' });
    }
    // Validate each Cc address; keep them comma-separated.
    const ccList = String(b.billing_cc_emails || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    const badCc = ccList.find((c) => !EMAIL_ONE_RE.test(c));
    if (badCc) return res.status(400).json({ error: `Cc address "${badCc}" doesn't look valid.` });

    const { error } = await supabase.from('communities').update({
      billing_contact_name: (b.billing_contact_name || '').trim() || null,
      billing_contact_email: email || null,
      billing_cc_emails: ccList.length ? ccList.join(', ') : null,
    }).eq('id', req.params.communityId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[billing] billing-contact put failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Poll the billing intake mailbox (staff -> Tessa billing items). Tessa reads
// each message, stages the charges, and replies. Manual trigger for now.
router.post('/poll-inbox', async (req, res) => {
  try {
    const { pollBillingInbox } = require('../lib/billing/email_intake');
    const out = await pollBillingInbox({ limit: Number(req.body?.limit) || 15 });
    res.json(out);
  } catch (err) {
    console.error('[billing] poll-inbox failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Pending billing items (staged ad-hoc charges) -------------------------
// List a community's staged charges (default: still-pending). Migration-safe.
router.get('/communities/:communityId/pending-items', async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    let q = supabase.from('billing_pending_items')
      .select('*').eq('community_id', req.params.communityId)
      .order('created_at', { ascending: false });
    if (status !== 'all') q = q.eq('status', status);
    const { data, error } = await q;
    if (error) {
      if (/billing_pending_items|relation|does not exist/i.test(error.message || '')) return res.json({ items: [], needs_migration: true });
      throw error;
    }
    res.json({ items: data || [] });
  } catch (err) {
    console.error('[billing] pending-items get failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Manually stage a charge (the same shape Tessa's email intake will insert).
router.post('/communities/:communityId/pending-items', async (req, res) => {
  try {
    const b = req.body || {};
    const description = String(b.description || '').trim();
    if (!description) return res.status(400).json({ error: 'A description is required.' });
    let qty = Number(b.qty); if (!(qty > 0)) qty = 1;
    let unit = Number(b.unit_price); if (!(unit >= 0)) unit = 0;
    let amount = (b.amount != null && b.amount !== '') ? Number(b.amount) : null;
    if (amount == null) amount = Math.round(qty * unit * 100) / 100;
    else if (!(unit > 0)) unit = qty > 0 ? Math.round((amount / qty) * 10000) / 10000 : amount; // amount typed directly
    const { data, error } = await supabase.from('billing_pending_items').insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id: req.params.communityId,
      category: (b.category || '').trim() || null,
      description, qty, unit_price: unit, amount,
      source: 'manual', submitted_by: b.submitted_by || null, note: b.note || null,
    }).select('id').single();
    if (error) {
      if (/billing_pending_items|relation|does not exist/i.test(error.message || '')) return res.status(400).json({ error: 'Billing items need migration 296 applied first.' });
      throw error;
    }
    res.json({ ok: true, id: data.id });
  } catch (err) {
    console.error('[billing] pending-items post failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Edit or dismiss a staged charge (no manual flip to 'billed' — only generating
// an invoice does that).
router.patch('/pending-items/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const { data: cur, error: e0 } = await supabase.from('billing_pending_items').select('*').eq('id', req.params.id).single();
    if (e0 || !cur) return res.status(404).json({ error: 'Item not found' });
    const patch = { updated_at: new Date().toISOString() };
    if (b.status && ['pending', 'dismissed'].includes(b.status)) patch.status = b.status;
    if (b.description != null) patch.description = String(b.description).trim() || cur.description;
    if (b.category != null) patch.category = String(b.category).trim() || null;
    if (b.note != null) patch.note = String(b.note).trim() || null;
    if (b.qty != null || b.unit_price != null) {
      const qty = b.qty != null ? Number(b.qty) : Number(cur.qty);
      const unit = b.unit_price != null ? Number(b.unit_price) : Number(cur.unit_price);
      patch.qty = qty; patch.unit_price = unit; patch.amount = Math.round(qty * unit * 100) / 100;
    }
    const { error } = await supabase.from('billing_pending_items').update(patch).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[billing] pending-items patch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// DELETE /api/billing/invoices/:invoiceId
// Hard-deletes a DRAFT/REVIEW invoice (and its line items + events cascade).
// Sent/approved/paid/void invoices are kept — those are voided, never deleted,
// so the audit trail and any sent record survive.
// ----------------------------------------------------------------------------
router.delete('/invoices/:invoiceId', async (req, res) => {
  const { invoiceId } = req.params;
  try {
    const { data: existing, error: findErr } = await supabase
      .from('invoices').select('id, status, invoice_number').eq('id', invoiceId).single();
    if (findErr || !existing) return res.status(404).json({ error: 'Invoice not found' });
    if (!['draft', 'review'].includes(existing.status)) {
      return res.status(400).json({
        error: `Only draft invoices can be deleted. This one is '${existing.status}' — void it instead to keep the record.`
      });
    }
    // Remove line items explicitly (in case the FK isn't ON DELETE CASCADE),
    // then the invoice (invoice_events cascade on the invoice FK).
    await supabase.from('invoice_line_items').delete().eq('invoice_id', invoiceId);
    const { error: delErr } = await supabase.from('invoices').delete().eq('id', invoiceId);
    if (delErr) throw delErr;
    res.json({ deleted: true, invoice_number: existing.invoice_number });
  } catch (err) {
    console.error('[billing] delete failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// PUT /api/billing/invoices/:invoiceId/line-items
// body: { line_items: [{ source_ref_id, description, qty, unit_price, ... }] }
//
// Replaces all line items for a draft invoice with the supplied list.
// Recomputes subtotal + total. Records an invoice_event with kind='edited'.
//
// Only allowed when invoice.status = 'draft' or 'review'. Anything sent or
// past sent stage requires an explicit edit_after_send flow (not yet built).
// ----------------------------------------------------------------------------
router.put('/invoices/:invoiceId/line-items', async (req, res) => {
  const { invoiceId } = req.params;
  const lineItems = (req.body && req.body.line_items) || [];
  if (!Array.isArray(lineItems)) {
    return res.status(400).json({ error: 'line_items must be an array' });
  }

  try {
    const { data: invoice, error: findErr } = await supabase
      .from('invoices')
      .select('id, status, invoice_type, contract_id')
      .eq('id', invoiceId)
      .single();
    if (findErr || !invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Editable while in draft/review, AND after it's been sent (Ed 2026-07-10 —
    // a sent invoice sometimes needs a correction). A sent edit is logged as
    // 'edited_after_send' for the audit trail. Void/paid stay locked.
    if (!['draft', 'review', 'sent'].includes(invoice.status)) {
      return res.status(400).json({
        error: `Cannot edit line items on invoice with status '${invoice.status}'. Only draft, review, or sent invoices are editable.`
      });
    }

    // Replace existing items. Simpler than diffing — invoice is in draft state.
    const { error: delErr } = await supabase
      .from('invoice_line_items')
      .delete()
      .eq('invoice_id', invoiceId);
    if (delErr) throw delErr;

    let subtotal = 0;
    if (lineItems.length > 0) {
      const itemsToInsert = lineItems.map((li, idx) => {
        const qty = Number(li.qty || 0);
        const unitPrice = Number(li.unit_price || 0);
        const amount = money(qty * unitPrice);
        subtotal += amount;
        return {
          invoice_id: invoiceId,
          source: li.source || 'adhoc',
          source_ref_id: li.source_ref_id || null,
          category: li.category || null,
          description: li.description || '(no description)',
          qty,
          unit_price: unitPrice,
          amount,
          vantaca_source_ref: li.vantaca_source_ref || null,
          manual_override: !!li.manual_override,
          manual_override_reason: li.manual_override_reason || null,
          sort_order: li.sort_order != null ? li.sort_order : idx * 10
        };
      });
      const { error: insErr } = await supabase
        .from('invoice_line_items')
        .insert(itemsToInsert);
      if (insErr) throw insErr;
    }

    subtotal = money(subtotal);
    const { data: updated, error: updErr } = await supabase
      .from('invoices')
      .update({ subtotal, total: subtotal })
      .eq('id', invoiceId)
      .select()
      .single();
    if (updErr) throw updErr;

    await supabase.from('invoice_events').insert({
      invoice_id: invoiceId,
      kind: invoice.status === 'sent' ? 'edited_after_send' : 'edited',
      payload: { line_count: lineItems.length, subtotal }
    });

    res.json({ invoice: updated, line_items_count: lineItems.length, subtotal });
  } catch (err) {
    console.error('[billing] line-items update failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// PATCH /api/billing/contracts/:contractId/rates
// body: { category, unit_price, reason, invoice_id? }
//
// Updates the rate for a category on the given contract. Postage categories
// (anything starting with 'postage') propagate to ALL active contracts in
// the management company since first-class postage is the same regardless
// of community. Non-postage categories update only this contract.
//
// "Going forward" semantics: future invoice line items pulled from the
// rate card will use the new rate. Existing lines on existing invoices
// keep their original rate (the line item stored its price at time of
// generation; we don't retroactively re-bill).
//
// invoice_id is optional and used only to record an invoice_events audit
// row tying the rate change to the invoice that triggered it.
// ----------------------------------------------------------------------------
router.patch('/contracts/:contractId/rates', async (req, res) => {
  const { contractId } = req.params;
  const { category, unit_price, reason, invoice_id } = req.body || {};

  if (!category || unit_price === undefined || unit_price === null) {
    return res.status(400).json({ error: 'category and unit_price required' });
  }
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'reason required for audit trail' });
  }

  try {
    const newPrice = Number(unit_price);
    if (Number.isNaN(newPrice) || newPrice < 0) {
      return res.status(400).json({ error: 'unit_price must be a non-negative number' });
    }
    const isPostage = String(category).startsWith('postage');

    // Try reimbursables first.
    const { data: reimb } = await supabase
      .from('contract_reimbursables')
      .select('id, contract_id, category, unit_price')
      .eq('contract_id', contractId)
      .eq('category', category)
      .maybeSingle();

    let oldPrice = null;
    let rowsUpdated = 0;
    let scope = 'this_contract';

    if (reimb) {
      oldPrice = Number(reimb.unit_price);
      const { error: updErr } = await supabase
        .from('contract_reimbursables')
        .update({ unit_price: newPrice })
        .eq('id', reimb.id);
      if (updErr) throw updErr;
      rowsUpdated = 1;

      // Postage propagates to all other active contracts in the same management company.
      if (isPostage) {
        scope = 'global_postage';
        const { data: others } = await supabase
          .from('contract_reimbursables')
          .select('id, contract_id')
          .eq('category', category)
          .neq('contract_id', contractId);
        if (others && others.length > 0) {
          const { error: bulkErr } = await supabase
            .from('contract_reimbursables')
            .update({ unit_price: newPrice })
            .in('id', others.map(o => o.id));
          if (bulkErr) throw bulkErr;
          rowsUpdated += others.length;
        }
      }
    } else {
      // Try owner_charges.
      const { data: oc } = await supabase
        .from('contract_owner_charges')
        .select('id, fee_amount')
        .eq('contract_id', contractId)
        .eq('category', category)
        .maybeSingle();
      if (!oc) {
        return res.status(404).json({ error: `Category '${category}' not found on this contract` });
      }
      oldPrice = Number(oc.fee_amount);
      const { error: updErr } = await supabase
        .from('contract_owner_charges')
        .update({ fee_amount: newPrice })
        .eq('id', oc.id);
      if (updErr) throw updErr;
      rowsUpdated = 1;
    }

    // Audit: record on the invoice that triggered the change (if provided).
    if (invoice_id) {
      await supabase.from('invoice_events').insert({
        invoice_id,
        kind: 'note_added',
        payload: {
          source: 'rate-change',
          category,
          old_price: oldPrice,
          new_price: newPrice,
          reason: String(reason).trim(),
          scope,
          rows_updated: rowsUpdated
        }
      });
    }

    res.json({
      category,
      old_price: oldPrice,
      new_price: newPrice,
      scope,
      rows_updated: rowsUpdated
    });
  } catch (err) {
    console.error('[billing] rate update failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/billing/invoices/:invoiceId/import-vantaca-violations
// multipart/form-data with field "pdf" containing the Vantaca Violation Report
//
// Parses the report's Summary section using the AI (resilient to format
// drift; PDF goes in as document content type), maps the status counts to
// billable line items via the contract's rate card, and replaces the
// invoice's line items with the result.
//
// Records an agent_run with the full prompt/response/tokens (P3 trade tape)
// and an invoice_event kind='edited' with the import provenance so the
// audit trail shows exactly where each line item came from.
//
// Mapping rules (v0):
//   certified_letter_notice  -> Deed Restriction Certified Demand Letter ($35/each)
//   first_notice + second_notice + certified_letter_notice
//                            -> Postage (description notes "DRV notices")
//
// Only allowed when invoice.status = 'draft' or 'review'.
// ----------------------------------------------------------------------------
router.post('/invoices/:invoiceId/import-vantaca-violations', upload.single('pdf'), async (req, res) => {
  const { invoiceId } = req.params;
  const t0 = Date.now();

  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded (expected field "pdf")' });
  if (req.file.mimetype !== 'application/pdf') {
    return res.status(400).json({ error: `Unsupported file type: ${req.file.mimetype}. PDF expected.` });
  }

  try {
    // Get invoice + verify it's editable.
    const { data: invoice, error: findErr } = await supabase
      .from('invoices')
      .select('id, status, invoice_type, contract_id, community_id')
      .eq('id', invoiceId)
      .single();
    if (findErr || !invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (!['draft', 'review'].includes(invoice.status)) {
      return res.status(400).json({ error: `Cannot import into invoice with status '${invoice.status}'` });
    }

    // Get contract rate card so we can map.
    const { data: reimb } = await supabase
      .from('contract_reimbursables')
      .select('id, category, description, unit_price')
      .eq('contract_id', invoice.contract_id);
    const { data: ownerCharges } = await supabase
      .from('contract_owner_charges')
      .select('id, category, description, fee_amount')
      .eq('contract_id', invoice.contract_id);

    const findReimb = (cat) => (reimb || []).find(r => r.category === cat);
    const findOwner = (cat) => (ownerCharges || []).find(r => r.category === cat);

    // Call the AI to extract the summary counts.
    const promptText = `Extract the SUMMARY status counts from this Vantaca Violation Report PDF.

Return ONLY a JSON object with these keys (use 0 if a status is not present in the summary):
{
  "certified_letter_notice": <int>,
  "first_notice": <int>,
  "second_notice": <int>,
  "closed": <int>,
  "owner_response": <int>,
  "pending_hearing": <int>,
  "resolved": <int>,
  "void": <int>,
  "report_period_start": "<YYYY-MM-DD or null>",
  "report_period_end": "<YYYY-MM-DD or null>",
  "community_name": "<string or null>"
}

Return ONLY the JSON. No markdown, no preamble, no commentary.`;

    const aiResp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: req.file.buffer.toString('base64')
            }
          },
          { type: 'text', text: promptText }
        ]
      }]
    });

    const rawText = (aiResp.content[0] && aiResp.content[0].text) || '';
    const cleanText = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleanText);
    } catch (e) {
      console.error('[billing] Failed to parse Vantaca extraction:', cleanText);
      throw new Error(`AI returned non-JSON: ${cleanText.slice(0, 200)}`);
    }

    // Build line items from the parsed counts.
    const newLines = [];
    let sortIdx = 0;

    const certCount = Number(parsed.certified_letter_notice || 0);
    const firstCount = Number(parsed.first_notice || 0);
    const secondCount = Number(parsed.second_notice || 0);
    const totalNotices = certCount + firstCount + secondCount;

    // 1. Certified letter fee (DRV).
    if (certCount > 0) {
      const owner = findOwner('deed_restriction_certified_demand_letter');
      if (owner) {
        const rate = Number(owner.fee_amount);
        newLines.push({
          source: 'owner_charge',
          source_ref_id: owner.id,
          category: owner.category,
          description: `${owner.description} (from Vantaca Violation Report — ${certCount} letters)`,
          qty: certCount,
          unit_price: rate,
          amount: Math.round(certCount * rate * 100) / 100,
          sort_order: (sortIdx += 10)
        });
      }
    }

    // 2. Postage for DRV first + second notices ONLY.
    //    Certified letters don't add postage — the $35 deed-restriction-
    //    certified-demand-letter fee covers the certified mail cost.
    //    Prefers the dedicated 'postage_drv_notices' subcategory (added in
    //    migration 006); falls back to generic 'postage' if not seeded.
    const drvNoticeCount = firstCount + secondCount;
    if (drvNoticeCount > 0) {
      const postage = findReimb('postage_drv_notices') || findReimb('postage');
      if (postage) {
        const rate = Number(postage.unit_price || 0);
        newLines.push({
          source: 'reimbursable',
          source_ref_id: postage.id,
          category: postage.category,
          description: `Postage — DRV notices (${firstCount} first, ${secondCount} second)`,
          qty: drvNoticeCount,
          unit_price: rate,
          amount: Math.round(drvNoticeCount * rate * 100) / 100,
          sort_order: (sortIdx += 10)
        });
      }
    }

    // Replace invoice line items with the imported set.
    await supabase.from('invoice_line_items').delete().eq('invoice_id', invoiceId);
    if (newLines.length > 0) {
      const itemsToInsert = newLines.map(li => ({ ...li, invoice_id: invoiceId }));
      const { error: insErr } = await supabase.from('invoice_line_items').insert(itemsToInsert);
      if (insErr) throw insErr;
    }
    const subtotal = Math.round(newLines.reduce((s, li) => s + Number(li.amount || 0), 0) * 100) / 100;
    const { data: updatedInvoice, error: updErr } = await supabase
      .from('invoices')
      .update({ subtotal, total: subtotal })
      .eq('id', invoiceId)
      .select()
      .single();
    if (updErr) throw updErr;

    // Persist the AI call (P3 trade tape).
    const { data: agentRun } = await supabase.from('agent_runs').insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id: invoice.community_id,
      module: 'billing',
      endpoint: 'POST /api/billing/invoices/:id/import-vantaca-violations',
      request_input: { invoice_id: invoiceId, file_name: req.file.originalname, file_size: req.file.size },
      retrieved_context: {
        contract_reimbursables: (reimb || []).map(r => r.category),
        contract_owner_charges: (ownerCharges || []).map(r => r.category)
      },
      prompt: promptText,
      model: 'claude-sonnet-4-6',
      response: { extracted: parsed, line_items_created: newLines.length, subtotal },
      input_tokens: aiResp.usage ? aiResp.usage.input_tokens : null,
      output_tokens: aiResp.usage ? aiResp.usage.output_tokens : null,
      duration_ms: Date.now() - t0
    }).select().single();

    await supabase.from('invoice_events').insert({
      invoice_id: invoiceId,
      kind: 'edited',
      payload: {
        source: 'vantaca-violation-import',
        file_name: req.file.originalname,
        extracted: parsed,
        line_count: newLines.length,
        subtotal
      },
      agent_run_id: agentRun ? agentRun.id : null
    });

    res.json({
      invoice: updatedInvoice,
      extracted: parsed,
      line_items_count: newLines.length,
      subtotal,
      duration_ms: Date.now() - t0
    });
  } catch (err) {
    console.error('[billing] vantaca import failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/billing/invoices/:invoiceId
// Returns the invoice header + line items + event history.
// ----------------------------------------------------------------------------
router.get('/invoices/:invoiceId', async (req, res) => {
  const { invoiceId } = req.params;
  try {
    const { data: invoice, error: iErr } = await supabase
      .from('invoices')
      .select(`*, community:communities(name, vantaca_code, legal_name)`)
      .eq('id', invoiceId)
      .single();
    if (iErr) throw iErr;
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const { data: lineItems, error: liErr } = await supabase
      .from('invoice_line_items')
      .select('*')
      .eq('invoice_id', invoiceId)
      .order('sort_order');
    if (liErr) throw liErr;

    const { data: events, error: evErr } = await supabase
      .from('invoice_events')
      .select('*')
      .eq('invoice_id', invoiceId)
      .order('occurred_at', { ascending: true });
    if (evErr) throw evErr;

    res.json({
      invoice,
      line_items: lineItems || [],
      events: events || []
    });
  } catch (err) {
    console.error('[billing] /invoices/:id failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/billing/invoices/:invoiceId/pdf
// query: ?inline=1 (open in browser) | omit (force download)
//
// Renders the invoice via the brand-aligned HTML template and converts to PDF
// with Puppeteer. Bedrock-styled, never a forwarded vendor template — per the
// brand-the-output rule. Logo is base64-embedded into the HTML so the PDF
// renders without network access.
// ----------------------------------------------------------------------------
// Render an invoice to a PDF Buffer (shared by the /pdf download route and the
// "Email as Emma" send path, so the attachment is byte-identical to the
// download). Returns { buffer, invoice }.
async function renderInvoicePdfBuffer(invoiceId) {
  const { data: invoice, error: iErr } = await supabase
    .from('invoices')
    .select('*, community:communities(*)')
    .eq('id', invoiceId)
    .single();
  if (iErr || !invoice) { const e = new Error('Invoice not found'); e.statusCode = 404; throw e; }

  const { data: lineItems } = await supabase
    .from('invoice_line_items')
    .select('*')
    .eq('invoice_id', invoiceId)
    .order('sort_order');

  const { data: managementCo } = await supabase
    .from('management_companies')
    .select('*')
    .eq('id', invoice.management_company_id)
    .single();

  const html = renderInvoiceHTML({
    invoice,
    lineItems: lineItems || [],
    community: invoice.community || {},
    managementCo: managementCo || {}
  });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    const buffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: true
    });
    return { buffer, invoice };
  } finally {
    if (browser) { try { await browser.close(); } catch (_) { /* swallow */ } }
  }
}

// Supporting "activity detail" PDF for the board — the per-property breakdown
// behind the activity invoice (violation letters + ARC/ACC decisions). Queries
// the SAME source tables + filters as GET /activity-detail and the activity
// report, so the counts reconcile with the invoice. (Kept separate from the
// interactive /activity-detail route, which adds signed letter links; unify if
// they drift.)
async function renderActivityDetailPdfBuffer(communityId, start, end) {
  const endEx = (() => { const d = new Date(end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
  const LETTER_TYPES = ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209', 'letter_postcard_reminder'];
  const STAGE_LABEL = { letter_courtesy_1: 'Courtesy 1', letter_courtesy_2: 'Courtesy 2', letter_209: 'Certified §209', letter_postcard_reminder: 'Postcard reminder' };
  async function fetchAll(build) { const out = []; for (let f = 0; ; f += 1000) { const { data, error } = await build().range(f, f + 999); if (error) break; out.push(...(data || [])); if (!data || data.length < 1000) break; } return out; }
  const { data: community } = await supabase.from('communities').select('id, name').eq('id', communityId).maybeSingle();
  const letters = await fetchAll(() => supabase.from('interactions').select('id, property_id, type, delivery_method, postmark_date, content, bundle_id').eq('community_id', communityId).in('type', LETTER_TYPES).not('printed_at', 'is', null).gte('postmark_date', start).lt('postmark_date', endEx));
  const accDecisions = await fetchAll(() => supabase.from('acc_decisions').select('homeowner_address, homeowner_name, project_summary, decision_type, created_at').eq('community_id', communityId).gte('created_at', start + 'T00:00:00Z').lt('created_at', endEx + 'T00:00:00Z'));
  const propIds = [...new Set(letters.map((l) => l.property_id).filter(Boolean))];
  const addrById = {};
  for (let i = 0; i < propIds.length; i += 500) { const { data: props } = await supabase.from('properties').select('id, street_address').in('id', propIds.slice(i, i + 500)); (props || []).forEach((p) => { addrById[p.id] = p.street_address; }); }
  const groups = new Map();
  for (const l of letters) { const key = l.bundle_id || l.content || ('id:' + l.id); let g = groups.get(key); if (!g) { g = { property: addrById[l.property_id] || '(unknown)', dates: [], stages: new Set(), delivery_method: l.delivery_method, violations: 0 }; groups.set(key, g); } g.violations += 1; if (l.postmark_date) g.dates.push(l.postmark_date); g.stages.add(STAGE_LABEL[l.type] || l.type); }
  const letterRows = [...groups.values()].map((g) => ({ property: g.property, date: g.dates.sort()[0] || null, stage: [...g.stages].join(', '), mail_class: g.delivery_method === 'certified_mail' ? 'Certified' : 'First-class', violations: g.violations })).sort((a, b) => a.property.localeCompare(b.property));
  const certCount = letterRows.filter((r) => r.mail_class === 'Certified').length;
  const outcomeOf = (s) => { s = (s || '').toLowerCase(); return s.includes('condition') ? 'Approved w/ conditions' : /approved/.test(s) ? 'Approved' : (s.includes('deni') || s.includes('reject')) ? 'Denied' : (s ? s[0].toUpperCase() + s.slice(1) : '—'); };
  const arcRows = accDecisions.map((d) => ({ property: d.homeowner_address || '(no address)', applicant: d.homeowner_name || '—', project: d.project_summary || '—', outcome: outcomeOf(d.decision_type), date: (d.created_at || '').slice(0, 10) })).sort((a, b) => a.property.localeCompare(b.property));

  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmtUS = (s) => { if (!s) return ''; const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? s + 'T12:00:00' : s); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' }); };
  const NAVY = '#0B1D34';
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><style>
    *{box-sizing:border-box;} body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;color:#1a1a1a;margin:0;background:#fff;font-size:12.5px;line-height:1.5;}
    .page{padding:0.55in 0.5in;} .head{border-bottom:2px solid ${NAVY};padding-bottom:12px;margin-bottom:18px;}
    .brand{font-weight:700;color:${NAVY};letter-spacing:.02em;} .tag{float:right;font-size:10px;letter-spacing:.12em;color:#64748b;}
    h1{font-size:19px;color:${NAVY};margin:10px 0 4px;} .sub{color:#475569;font-size:12px;} .meta{color:#64748b;font-size:10.5px;margin-top:5px;}
    .stats{display:flex;gap:14px;flex-wrap:wrap;margin:14px 0 20px;padding:11px 13px;background:#EAF0F7;border-radius:6px;}
    .stat{text-align:center;min-width:70px;} .stat-n{font-size:19px;font-weight:700;color:${NAVY};} .stat-l{font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:#475569;margin-top:2px;}
    h2{font-size:14px;color:${NAVY};margin:22px 0 8px;padding-bottom:5px;border-bottom:1px solid #d4d4d8;}
    table.t{width:100%;border-collapse:collapse;} table.t th{text-align:left;font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:#64748b;border-bottom:1.5px solid ${NAVY};padding:5px 7px;}
    table.t td{padding:5px 7px;border-bottom:1px solid #eee;vertical-align:top;} .cert{color:#92400e;font-weight:700;} .muted{color:#94a3b8;}
  </style></head><body><div class="page">
    <div class="head"><div><span class="brand">${esc(BRAND.service.name)}</span><span class="tag">${esc(BRAND.service.taglineUpper)}</span></div>
      <h1>${esc(community ? community.name : '')} — Compliance &amp; ARC Activity</h1>
      <div class="sub">Supporting detail for <strong>${esc(fmtUS(start))}</strong> through <strong>${esc(fmtUS(end))}</strong></div>
      <div class="meta">${esc(BRAND.service.legal)} on behalf of the ${esc(community ? community.name : '')} Board of Directors</div></div>
    <div class="stats">
      <div class="stat"><div class="stat-n">${letterRows.length}</div><div class="stat-l">Letters sent</div></div>
      <div class="stat"><div class="stat-n">${letterRows.length - certCount}</div><div class="stat-l">First-class</div></div>
      <div class="stat"><div class="stat-n">${certCount}</div><div class="stat-l">Certified</div></div>
      <div class="stat"><div class="stat-n">${arcRows.length}</div><div class="stat-l">ARC decisions</div></div></div>
    <h2>Violation letters</h2>
    ${letterRows.length ? `<table class="t"><thead><tr><th>Property</th><th>Date</th><th>Stage(s)</th><th>Mail class</th><th style="text-align:center;">Violations</th></tr></thead><tbody>${letterRows.map((r) => `<tr><td><strong>${esc(r.property)}</strong></td><td>${esc(fmtUS(r.date))}</td><td>${esc(r.stage)}</td><td>${r.mail_class === 'Certified' ? '<span class="cert">Certified</span>' : 'First-class'}</td><td style="text-align:center;">${r.violations}${r.violations > 1 ? ' <span class="muted">(bundle)</span>' : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No violation letters mailed in this period.</p>'}
    <h2>ARC / ACC decisions</h2>
    ${arcRows.length ? `<table class="t"><thead><tr><th>Property</th><th>Applicant</th><th>Project</th><th>Decision</th><th>Date</th></tr></thead><tbody>${arcRows.map((r) => `<tr><td><strong>${esc(r.property)}</strong></td><td>${esc(r.applicant)}</td><td>${esc(r.project)}</td><td>${r.outcome === 'Denied' ? `<span class="cert">${esc(r.outcome)}</span>` : esc(r.outcome)}</td><td>${esc(fmtUS(r.date))}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No ARC/ACC decisions rendered in this period.</p>'}
  </div></body></html>`;

  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    return await page.pdf({ format: 'Letter', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  } finally { if (browser) { try { await browser.close(); } catch (_) { /* swallow */ } } }
}

// Find the community's fixed (management-fee) draft for a period, or generate
// one. Safe to auto-generate: the fixed invoice is the deterministic recurring
// fee from the contract, no activity judgment involved.
async function ensureFixedInvoice(communityId, period) {
  const { start, end } = periodBoundaries(period);
  const { data: existing } = await supabase.from('invoices').select('id, invoice_number')
    .eq('community_id', communityId).eq('invoice_type', 'fixed').eq('service_period_start', start).neq('status', 'void').limit(1).maybeSingle();
  if (existing) return { invoiceId: existing.id, invoiceNumber: existing.invoice_number, generated: false };
  const { data: comm } = await supabase.from('communities').select('billing_code, vantaca_code, name').eq('id', communityId).maybeSingle();
  const { data: contracts } = await supabase.from('contracts').select('id, version, payment_terms').eq('community_id', communityId).eq('status', 'active').order('version', { ascending: false }).limit(1);
  if (!contracts || !contracts.length) return { missingContract: true };
  const contract = contracts[0];
  const lineItems = sanitizeDraftLines(await buildDraftLineItems({ contractId: contract.id, type: 'fixed', period, communityId }));
  const subtotal = money(lineItems.reduce((s, li) => s + Number(li.amount || 0), 0));
  const invoiceNumber = buildInvoiceNumber({ billingCode: comm.billing_code, vantacaCode: comm.vantaca_code, period, type: 'fixed' });
  const { data: inv, error } = await supabase.from('invoices').insert({
    management_company_id: BEDROCK_MGMT_CO_ID, community_id: communityId, contract_id: contract.id, contract_version: contract.version,
    invoice_number: invoiceNumber, invoice_type: 'fixed', service_period_start: start, service_period_end: end,
    invoice_date: new Date().toISOString().slice(0, 10), payment_terms: contract.payment_terms, status: 'draft', subtotal, total: subtotal, recipient_name: comm.name,
  }).select('id, invoice_number').single();
  if (error) {
    if (error.code === '23505') { const { data: ex2 } = await supabase.from('invoices').select('id, invoice_number').eq('invoice_number', invoiceNumber).maybeSingle(); if (ex2) return { invoiceId: ex2.id, invoiceNumber: ex2.invoice_number, generated: false }; }
    throw error;
  }
  if (lineItems.length) await supabase.from('invoice_line_items').insert(lineItems.map((li) => ({ ...li, invoice_id: inv.id })));
  await supabase.from('invoice_events').insert({ invoice_id: inv.id, kind: 'created', payload: { source: 'monthly-package fixed auto-generate', type: 'fixed', period } });
  return { invoiceId: inv.id, invoiceNumber: inv.invoice_number, generated: true };
}

// POST /communities/:communityId/monthly-package  body: { month:'YYYY-MM' }
// Assembles the board billing package: the fixed management invoice (this month,
// auto-generated if missing), the prior month's ACTIVITY invoice (must already
// be generated + reviewed in the worksheet — carries any pending billing items),
// and the supporting activity-detail PDF. Renders all three, SAVES them to
// storage, and EMAILS them to Ed (as Tessa) for review. Nothing goes to the
// board here — Ed reviews, then sends.
router.post('/communities/:communityId/monthly-package', async (req, res) => {
  try {
    const communityId = req.params.communityId;
    const month = String((req.body && req.body.month) || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month required as YYYY-MM' });
    const { data: comm } = await supabase.from('communities').select('id, name').eq('id', communityId).maybeSingle();
    if (!comm) return res.status(404).json({ error: 'community_not_found' });

    const [yy, mm] = month.split('-').map(Number);
    const prior = new Date(Date.UTC(yy, mm - 2, 1));
    const priorMonth = `${prior.getUTCFullYear()}-${String(prior.getUTCMonth() + 1).padStart(2, '0')}`;
    const { start: aStart, end: aEnd } = periodBoundaries(priorMonth);

    const fixed = await ensureFixedInvoice(communityId, month);
    if (fixed.missingContract) return res.status(400).json({ error: 'No active contract for this community.' });

    const { data: activityInv } = await supabase.from('invoices')
      .select('id, invoice_number').eq('community_id', communityId).eq('invoice_type', 'activity')
      .eq('service_period_start', aStart).neq('status', 'void').limit(1).maybeSingle();
    if (!activityInv) {
      return res.json({ ok: false, needs_activity_invoice: true, prior_month: priorMonth,
        message: `Generate ${comm.name}'s ${periodMonthLabel(aStart)} activity invoice in the worksheet first (so you review the month's numbers), then run this again.` });
    }

    const attachments = [], saved = [];
    async function addPdf(name, buffer) {
      attachments.push({ '@odata.type': '#microsoft.graph.fileAttachment', name, contentType: 'application/pdf', contentBytes: Buffer.from(buffer).toString('base64') });
      const path = `billing_packages/${communityId}/${month}/${name}`;
      try { await supabase.storage.from('documents').upload(path, buffer, { contentType: 'application/pdf', upsert: true }); saved.push(path); } catch (e) { console.warn('[monthly-package] save failed:', e.message); }
    }
    await addPdf(`${(fixed.invoiceNumber || 'management').replace(/[^A-Za-z0-9._-]+/g, '_')}.pdf`, (await renderInvoicePdfBuffer(fixed.invoiceId)).buffer);
    await addPdf(`${(activityInv.invoice_number || 'activity').replace(/[^A-Za-z0-9._-]+/g, '_')}.pdf`, (await renderInvoicePdfBuffer(activityInv.id)).buffer);
    await addPdf(`${comm.name.replace(/[^A-Za-z0-9]+/g, '_')}_activity_detail_${priorMonth}.pdf`, await renderActivityDetailPdfBuffer(communityId, aStart, aEnd));

    const graphSend = require('../lib/email/graph_send');
    let emailed = false, emailError = null;
    if (graphSend.isConfigured()) {
      try {
        const { buildTessaEmail } = require('../lib/email/tessa_signature');
        const body = `Hi Ed,\n\nHere is ${comm.name}'s billing package for your review: the management invoice for ${periodMonthLabel(month + '-01')}, the ${periodMonthLabel(aStart)} activity invoice, and the supporting activity detail. Take a look and let me know who to send it to, or if anything needs adjusting.`;
        const { html } = buildTessaEmail(body);
        await graphSend.sendAs({ from: graphSend.TESSA_MAILBOX, to: graphSend.ED_MAILBOX, subject: `${comm.name} — billing package for review (${periodMonthLabel(month + '-01')})`, html, attachments });
        emailed = true;
      } catch (e) { emailError = e.message; console.error('[monthly-package] email failed:', e.message); }
    } else { emailError = 'email_not_configured'; }

    res.json({ ok: true, community: comm.name, month, prior_month: priorMonth,
      fixed_invoice: fixed.invoiceNumber, fixed_generated: fixed.generated, activity_invoice: activityInv.invoice_number,
      attachments: attachments.length, saved_paths: saved, emailed, email_to: graphSend.ED_MAILBOX, email_error: emailError });
  } catch (err) {
    console.error('[billing] monthly-package failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/invoices/:invoiceId/pdf', async (req, res) => {
  const { invoiceId } = req.params;
  try {
    const { buffer, invoice } = await renderInvoicePdfBuffer(invoiceId);
    const filename = `invoice_${invoice.invoice_number || invoiceId}.pdf`;
    const dispo = req.query.inline === '1' ? 'inline' : 'attachment';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${dispo}; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) {
    console.error('[billing] PDF gen failed:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ============================================================================
// CONTRACT INTAKE — drop a Bedrock-Association management contract PDF,
// AI parses, user reviews, save populates contracts + child tables.
//
// Two-step flow on purpose:
//   1. POST /contracts/parse  → returns extracted structured data, no save
//   2. POST /contracts/save   → caller submits reviewed data, transactional save
//
// The review step is where Ed's CFE judgment encodes — humans verify the
// AI's extraction before it becomes a billing rate that real money flows on.
// ============================================================================

/**
 * the AI prompt for extracting Bedrock management contract terms.
 * Returns strict JSON shape that maps to contracts + child tables.
 */
const CONTRACT_EXTRACTION_PROMPT = `You are extracting structured data from a Bedrock Association Management management agreement PDF. Return a JSON object with EXACTLY this shape (omit fields you cannot determine):

{
  "community_name": "string",
  "effective_date": "YYYY-MM-DD",
  "signed_date": "YYYY-MM-DD",
  "end_date": null,
  "signatories": { "association": "string or null", "managing_agent": "string or null" },
  "notice_address": "full address string",
  "notice_email": "email",
  "agent_contact_name": "string",
  "agent_contact_email": "email",
  "escalator_kind": "max_cpi_or_pct | fixed_pct | cpi_only | none",
  "escalator_pct": 5.00,
  "payment_terms": "string (e.g. 'Net 30' or 'Monthly in advance')",
  "spending_authority_limit": 1500.00,
  "fixed_items": [
    { "description": "Monthly Management Fee", "monthly_amount": 2400.00, "notes": null }
  ],
  "reimbursables": [
    {
      "category": "snake_case_slug (e.g. community_mailings, work_outside_normal, postage, event_staffing, transition_setup, annual_statement_mailing)",
      "description": "human-readable",
      "billing_method": "per_unit | hourly | per_lot_plus_postage | at_cost",
      "unit_price": 0.50,
      "notes": "any unit context, e.g. per lot, per hour"
    }
  ],
  "owner_charges": [
    {
      "category": "snake_case_slug (e.g. assessment_late_reminder, assessment_certified_demand, drv_certified_demand, nsf_charge, attorney_legal_action, payment_plan_fee, arc_application_fee, mediation_court_appearance)",
      "description": "human-readable",
      "fee_amount": 25.00,
      "notes": null
    }
  ],
  "extraction_notes": "Free text. Anything unusual you noticed about this contract: ambiguous language, multiple rate tables, hand-written annotations, things that need human review."
}

Rules:
- Use null (not empty string) for fields you cannot find.
- All money values are NUMBERS, not strings, no $ sign, no commas.
- Dates are ISO YYYY-MM-DD only.
- For escalator: "max_cpi_or_pct" means "greater of CPI-U or X%"; "fixed_pct" is straight X%; "cpi_only" is CPI without floor; "none" if no escalator.
- For reimbursables, billing_method "per_unit" applies to per-mailing/per-lot rates; "hourly" for $/hour rates; "per_lot_plus_postage" for annual statement billing; "at_cost" for postage passthrough.
- Be conservative: if you're not sure of a field, return null and call it out in extraction_notes.

Return ONLY the JSON object, no preamble, no code fence, no commentary.`;

/**
 * POST /api/billing/contracts/parse
 * Multipart upload with field "pdf" (required) + body community_id (optional;
 * if omitted, the caller picks community after seeing extracted name).
 * Returns the parsed JSON for review (NO save).
 */
router.post('/contracts/parse', upload.single('pdf'), async (req, res) => {
  const t0 = Date.now();
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded (expected field "pdf")' });
  if (req.file.mimetype !== 'application/pdf') {
    return res.status(400).json({ error: `Unsupported file type: ${req.file.mimetype}` });
  }

  try {
    const pdfBase64 = req.file.buffer.toString('base64');

    const completion = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: CONTRACT_EXTRACTION_PROMPT }
        ]
      }]
    });

    const text = completion.content?.[0]?.text || '';
    let parsed;
    try {
      // Strip any code fences if the AI added them despite the instruction.
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (jsonErr) {
      console.error('[billing] contract parse JSON failed:', jsonErr.message);
      return res.status(500).json({
        error: 'Could not parse the AI response as JSON',
        raw_response: text
      });
    }

    // Persist trade-tape entry.
    await supabase.from('agent_runs').insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id: req.body?.community_id || null,
      module: 'billing',
      endpoint: 'POST /api/billing/contracts/parse',
      request_input: { file_name: req.file.originalname, file_size: req.file.size },
      retrieved_context: null,
      prompt: 'CONTRACT_EXTRACTION_PROMPT',
      model: 'claude-sonnet-4-5',
      response: parsed,
      input_tokens: completion.usage?.input_tokens || null,
      output_tokens: completion.usage?.output_tokens || null,
      duration_ms: Date.now() - t0
    });

    res.json({
      parsed,
      file_name: req.file.originalname,
      duration_ms: Date.now() - t0
    });
  } catch (err) {
    console.error('[billing] contract parse failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// The confirmed set of rate rows that seed a line on a fresh activity invoice
// (mirrors migration 271's default_on_invoice flags). Single source of truth so
// NEW community contracts get the same invoice floor migration 271 backfilled
// onto existing ones — the contract editor UI has no per-row toggle, so the flag
// is applied here by category, not by the operator.
const DEFAULT_INVOICE_REIMBURSABLES = new Set(['postage_drv_notices', 'color_copies', 'electronic_voting']);
const DEFAULT_INVOICE_OWNER_CHARGES = new Set(['deed_restriction_certified_demand_letter', 'arc_application_fee']);

/**
 * POST /api/billing/contracts/save
 * Body: { community_id, parsed }   where parsed matches the schema returned by /parse
 * Side-effects:
 *   - If an existing 'active' contract exists for the community, mark it 'superseded'
 *   - Insert new contracts row (version = prior + 1, or 1 if first)
 *   - Insert all contract_fixed_items / contract_reimbursables / contract_owner_charges
 * Returns the new contract_id and a summary count.
 */
router.post('/contracts/save', async (req, res) => {
  const { community_id, parsed } = req.body || {};
  if (!community_id) return res.status(400).json({ error: 'community_id required' });
  if (!parsed) return res.status(400).json({ error: 'parsed payload required' });

  try {
    // Verify community exists and belongs to Bedrock.
    const { data: community, error: commErr } = await supabase
      .from('communities')
      .select('id, name, management_company_id')
      .eq('id', community_id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (commErr || !community) return res.status(404).json({ error: 'Community not found' });

    // Find prior active contract (if any) so we can supersede + version-bump.
    const { data: priorContracts } = await supabase
      .from('contracts')
      .select('id, version, status')
      .eq('community_id', community_id)
      .order('version', { ascending: false })
      .limit(1);
    const priorActive = (priorContracts || []).find(c => c.status === 'active');
    const nextVersion = (priorContracts && priorContracts[0]) ? priorContracts[0].version + 1 : 1;

    // Mark prior active as superseded.
    if (priorActive) {
      await supabase
        .from('contracts')
        .update({ status: 'superseded' })
        .eq('id', priorActive.id);
    }

    // Insert new contract.
    const escalatorKind = ['max_cpi_or_pct', 'fixed_pct', 'cpi_only', 'none'].includes(parsed.escalator_kind)
      ? parsed.escalator_kind : 'none';

    const { data: newContract, error: insErr } = await supabase
      .from('contracts')
      .insert({
        community_id,
        version: nextVersion,
        effective_date: parsed.effective_date || new Date().toISOString().slice(0, 10),
        end_date: parsed.end_date || null,
        signed_date: parsed.signed_date || null,
        signatories: parsed.signatories || null,
        notice_address: parsed.notice_address || null,
        escalator_kind: escalatorKind,
        escalator_pct: parsed.escalator_pct != null ? Number(parsed.escalator_pct) : null,
        payment_terms: parsed.payment_terms || 'Net 30',
        status: 'active',
        notes: [
          parsed.extraction_notes,
          parsed.spending_authority_limit ? `Spending authority: $${parsed.spending_authority_limit}` : null,
          parsed.agent_contact_name ? `Day-to-day agent: ${parsed.agent_contact_name} (${parsed.agent_contact_email || ''})` : null
        ].filter(Boolean).join('\n\n') || null
      })
      .select()
      .single();
    if (insErr) throw insErr;

    const contractId = newContract.id;

    // Insert child rows.
    const fixedRows = (parsed.fixed_items || []).map((item, i) => ({
      contract_id: contractId,
      description: item.description,
      monthly_amount: Number(item.monthly_amount) || 0,
      notes: item.notes || null,
      sort_order: i
    }));
    if (fixedRows.length > 0) {
      const { error: fErr } = await supabase.from('contract_fixed_items').insert(fixedRows);
      if (fErr) throw fErr;
    }

    const reimbRows = (parsed.reimbursables || []).map((item, i) => ({
      contract_id: contractId,
      category: item.category,
      description: item.description,
      billing_method: ['per_unit', 'hourly', 'per_lot_plus_postage', 'at_cost'].includes(item.billing_method)
        ? item.billing_method : 'per_unit',
      unit_price: item.unit_price != null ? Number(item.unit_price) : null,
      notes: item.notes || null,
      sort_order: i,
      default_on_invoice: item.default_on_invoice != null
        ? !!item.default_on_invoice
        : DEFAULT_INVOICE_REIMBURSABLES.has(item.category),
    }));
    // Guarantee Electronic Voting ($750) is on every new contract's rate card —
    // same floor migration 271 backfilled onto existing contracts.
    if (!reimbRows.some(r => r.category === 'electronic_voting')) {
      reimbRows.push({
        contract_id: contractId,
        category: 'electronic_voting',
        description: 'Electronic Voting',
        billing_method: 'per_unit',
        unit_price: 750,
        notes: null,
        sort_order: 500,
        default_on_invoice: true,
      });
    }
    if (reimbRows.length > 0) {
      const { error: rErr } = await supabase.from('contract_reimbursables').insert(reimbRows);
      if (rErr) throw rErr;
    }

    const ownerRows = (parsed.owner_charges || []).map((item, i) => ({
      contract_id: contractId,
      category: item.category,
      description: item.description,
      fee_amount: Number(item.fee_amount) || 0,
      notes: item.notes || null,
      sort_order: i,
      default_on_invoice: item.default_on_invoice != null
        ? !!item.default_on_invoice
        : DEFAULT_INVOICE_OWNER_CHARGES.has(item.category),
    }));
    if (ownerRows.length > 0) {
      const { error: oErr } = await supabase.from('contract_owner_charges').insert(ownerRows);
      if (oErr) throw oErr;
    }

    res.json({
      contract_id: contractId,
      version: nextVersion,
      community: community.name,
      superseded_id: priorActive ? priorActive.id : null,
      counts: {
        fixed_items: fixedRows.length,
        reimbursables: reimbRows.length,
        owner_charges: ownerRows.length
      }
    });
  } catch (err) {
    console.error('[billing] contract save failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// MANAGEMENT-AGREEMENT MODULE (migration 041)
// ----------------------------------------------------------------------------
// Customer-facing management-agreement PDF generation. Sits on top of the
// existing contract/fee-schedule tables — adds per-lot math (internal only)
// and a Bedrock-branded document renderer. The legal body of the agreement
// lives once in `bedrock_contract_defaults.contract_body_template` with
// merge tokens; new community contracts inherit the rate sheet from the
// same row's default_* JSONB blobs (copy-on-create — edits to defaults do
// NOT retroactively change existing executed agreements).
// ============================================================================

const { renderManagementAgreementHTML, computeMonthlyFee } =
  require('../lib/contracts/management_agreement');

// GET /api/billing/contract-defaults — read the singleton.
router.get('/contract-defaults', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bedrock_contract_defaults')
      .select('*')
      .eq('id', 1)
      .maybeSingle();
    if (error) throw error;
    res.json({ defaults: data || null });
  } catch (err) {
    console.error('[billing] contract-defaults GET failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/billing/contract-defaults — upsert the singleton.
router.put('/contract-defaults', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {
      id: 1,
      default_per_lot_monthly_fee: b.default_per_lot_monthly_fee ?? null,
      default_term_months:         b.default_term_months ?? null,
      contract_body_template:      b.contract_body_template ?? null,
      default_fixed_items:         Array.isArray(b.default_fixed_items)   ? b.default_fixed_items   : [],
      default_reimbursables:       Array.isArray(b.default_reimbursables) ? b.default_reimbursables : [],
      default_owner_charges:       Array.isArray(b.default_owner_charges) ? b.default_owner_charges : [],
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase
      .from('bedrock_contract_defaults')
      .upsert(patch)
      .select()
      .single();
    if (error) throw error;
    res.json({ defaults: data });
  } catch (err) {
    console.error('[billing] contract-defaults PUT failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/billing/contracts/:id/pricing — update per-lot math + term on an
// existing contract. Internal-only fields; never prints on the agreement.
router.patch('/contracts/:id/pricing', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (b.lot_count            !== undefined) patch.lot_count            = b.lot_count            === null ? null : Number(b.lot_count);
    if (b.per_lot_monthly_fee  !== undefined) patch.per_lot_monthly_fee  = b.per_lot_monthly_fee  === null ? null : Number(b.per_lot_monthly_fee);
    if (b.monthly_fee_override !== undefined) patch.monthly_fee_override = b.monthly_fee_override === null ? null : Number(b.monthly_fee_override);
    if (b.term_months          !== undefined) patch.term_months          = b.term_months          === null ? null : Number(b.term_months);

    const { data, error } = await supabase
      .from('contracts')
      .update(patch)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ contract: data });
  } catch (err) {
    console.error('[billing] contract pricing PATCH failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/contracts/:id/management-agreement
//   Generates the Bedrock-branded management-agreement PDF for this contract
//   and stores it in the documents bucket. Returns a signed URL.
router.post('/contracts/:id/management-agreement', async (req, res) => {
  try {
    const contractId = req.params.id;

    const { data: contract, error: cErr } = await supabase
      .from('contracts').select('*').eq('id', contractId).maybeSingle();
    if (cErr || !contract) return res.status(404).json({ error: 'contract not found' });

    const { data: community, error: commErr } = await supabase
      .from('communities').select('*').eq('id', contract.community_id).maybeSingle();
    if (commErr || !community) return res.status(404).json({ error: 'community not found' });

    const { data: defaults } = await supabase
      .from('bedrock_contract_defaults').select('*').eq('id', 1).maybeSingle();

    const [{ data: fixedItems }, { data: reimbursables }, { data: ownerCharges }] = await Promise.all([
      supabase.from('contract_fixed_items').select('*').eq('contract_id', contractId).order('sort_order'),
      supabase.from('contract_reimbursables').select('*').eq('contract_id', contractId).order('sort_order'),
      supabase.from('contract_owner_charges').select('*').eq('contract_id', contractId).order('sort_order'),
    ]);

    const html = await renderManagementAgreementHTML({
      contract,
      community,
      defaults,
      fixedItems: fixedItems || [],
      reimbursables: reimbursables || [],
      ownerCharges: ownerCharges || [],
    });

    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--single-process'],
    });
    let pdfBuf;
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      pdfBuf = await page.pdf({ format: 'Letter', printBackground: true });
    } finally {
      await browser.close();
    }

    const storagePath = `contracts/${contractId}/management_agreement_v${contract.version}_${Date.now()}.pdf`;
    const { error: upErr } = await supabase.storage.from('documents').upload(storagePath, pdfBuf, {
      contentType: 'application/pdf', upsert: true,
    });
    if (upErr) throw upErr;

    const monthlyFee = computeMonthlyFee(contract, fixedItems || []);
    const { data: doc, error: docErr } = await supabase
      .from('management_agreement_documents')
      .insert({
        contract_id: contractId,
        community_id: contract.community_id,
        pdf_storage_path: storagePath,
        snapshot: {
          contract,
          community: { id: community.id, name: community.name, address: community.address },
          monthly_fee: monthlyFee,
          fixed_items: fixedItems || [],
          reimbursables: reimbursables || [],
          owner_charges: ownerCharges || [],
          rendered_at: new Date().toISOString(),
        },
        status: 'draft',
      })
      .select()
      .single();
    if (docErr) throw docErr;

    const { data: signed } = await supabase.storage.from('documents').createSignedUrl(storagePath, 3600);
    res.json({ document: doc, signed_url: signed && signed.signedUrl });
  } catch (err) {
    console.error('[billing] management-agreement generate failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/billing/activity-report
//   ?period_start=YYYY-MM-DD&period_end=YYYY-MM-DD&community_id=(optional)
// Billable production activity per community for a period (Ed 2026-07-02):
//   - violations     : individual violation letters generated (row count)
//   - letters_sent   : physical envelopes mailed — deduped by bundle_id so a
//                      bundle of several violations to one owner counts ONCE.
//                      first_class_sent / certified_sent split the same envelopes
//                      (postage bills per envelope, not per violation).
//   - pages_printed  : physical pages of those letters (per envelope)
//   - arc_*          : ARC/ACC decisions rendered in range — BOTH builder ARC
//                      (builder_applications.decided_at) AND resident ACC
//                      (arc_historical_decisions.decided_at — the ACC decision
//                      log, where both portal + committee decisions land). Split
//                      approved / denied / conditions / other.
// Dates are inclusive on the day boundary in the period. Read-only.
// ============================================================================
router.get('/activity-report', async (req, res) => {
  try {
    const start = (req.query.period_start || '').slice(0, 10);
    const end = (req.query.period_end || '').slice(0, 10);
    const communityId = req.query.community_id || null;
    if (!start || !end) return res.status(400).json({ error: 'period_start_and_period_end_required' });
    // Inclusive end: compare against < end+1day.
    const endExclusive = new Date(end + 'T00:00:00Z');
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
    const endEx = endExclusive.toISOString().slice(0, 10);

    const LETTER_TYPES = ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209', 'letter_postcard_reminder'];

    // Page through — a busy community-month can exceed the 1000-row cap.
    async function fetchAll(build) {
      const out = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await build().range(from, from + 999);
        if (error) throw error;
        out.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      return out;
    }

    // 1) Violation letters mailed in the period (postmark_date = the send date).
    // page_count arrives with migration 257 — degrade gracefully before it's
    // applied (pages show as unknown rather than 500ing the report).
    const letterCols = (cols) => fetchAll(() => {
      let q = supabase.from('interactions')
        .select(cols)
        .in('type', LETTER_TYPES)
        .not('printed_at', 'is', null)
        .gte('postmark_date', start)
        .lt('postmark_date', endEx);
      if (communityId) q = q.eq('community_id', communityId);
      return q;
    });
    let letters;
    let hasPageCount = true;
    try {
      letters = await letterCols('id, community_id, content, bundle_id, page_count, type, delivery_method, postmark_date');
    } catch (e) {
      if (/page_count/.test(e.message || '')) {
        hasPageCount = false;
        letters = await letterCols('id, community_id, content, bundle_id, type, delivery_method, postmark_date');
      } else { throw e; }
    }

    // 2) ARC/ACC decisions rendered in the period. TWO sources — both matter and
    // are billed the same: builder ARC (builder_applications) AND resident ACC
    // (community_applications, final_decided_at/final_status). Counting only one
    // was the "ARC shows 0" bug (Ed 2026-07-10).
    let decisions = await fetchAll(() => {
      let q = supabase.from('builder_applications')
        .select('community_id, status, decided_at')
        .not('decided_at', 'is', null)
        .gte('decided_at', start + 'T00:00:00Z')
        .lt('decided_at', endEx + 'T00:00:00Z');
      if (communityId) q = q.eq('community_id', communityId);
      return q;
    });
    // Resident ACC decisions we RAN through trustEd live in acc_decisions — the
    // decisions staff issued + generated a letter for (Ed 2026-07-10). That is the
    // billable ACC work; arc_historical_decisions is the prior manager's imported
    // history (decided before us) and must NOT be billed. created_at is the decision
    // timestamp; compare against the day-boundary UTC bounds.
    let accDecisions = await fetchAll(() => {
      let q = supabase.from('acc_decisions')
        .select('community_id, decision_type, created_at')
        .gte('created_at', start + 'T00:00:00Z')
        .lt('created_at', endEx + 'T00:00:00Z');
      if (communityId) q = q.eq('community_id', communityId);
      return q;
    });

    // Payment plans set up in the period — the HOA's payment-plan fee bills per
    // plan (Ed 2026-07-13, sourced from the payment plan module). NSF/returned
    // checks will come from the bank-activity import once that lands.
    let paymentPlans = [];
    try {
      paymentPlans = await fetchAll(() => {
        // Only plans INITIATED in the period — keyed on start_date (when the
        // plan was initiated). Fall back to created_at ONLY when a plan has no
        // start_date, so a plan entered late but initiated in another month
        // doesn't land on the wrong bill.
        let q = supabase.from('payment_plans')
          .select('community_id, start_date, created_at')
          .or(`and(start_date.gte.${start},start_date.lte.${end}),and(start_date.is.null,created_at.gte.${start}T00:00:00Z,created_at.lt.${endEx}T00:00:00Z)`);
        if (communityId) q = q.eq('community_id', communityId);
        return q;
      });
    } catch (_) { paymentPlans = []; }

    // Community name lookup.
    const { data: comms } = await supabase.from('communities').select('id, name');
    const nameById = Object.fromEntries((comms || []).map((c) => [c.id, c.name]));

    // A bundle_id is ONE physical envelope (auto-bundle groups a property's
    // violations into a single mailing that shares one PDF + one admin fee).
    // "violations" counts the letter rows; postage / certified / pages are billed
    // per ENVELOPE, so they dedupe to the distinct letter (bundle_id, then the
    // shared PDF path, then the row id for an un-bundled singleton).
    const letterKey = (l) => l.bundle_id || l.content || ('id:' + l.id);

    // Aggregate per community.
    const byComm = {};
    const row = (cid) => (byComm[cid] || (byComm[cid] = {
      community_id: cid, name: nameById[cid] || 'Unknown',
      violations: 0,
      // Resident ACC only — this is what the HOA's ARC application fee bills on.
      arc_approved: 0, arc_denied: 0, arc_conditions: 0, arc_other: 0,
      // Builder ARC (Lennar / DRB) is billed to the BUILDER, never the HOA, so it
      // is broken out separately and must NOT feed the arc_* counts above.
      builder_arc: 0,
      payment_plans: 0, // plans set up this period — bills the payment-plan fee
      _letters: new Map(), // envelope key -> { delivery_method, page_count }
    }));

    letters.forEach((l) => {
      const r = row(l.community_id);
      r.violations += 1;
      const key = letterKey(l);
      if (!r._letters.has(key)) {
        r._letters.set(key, { delivery_method: l.delivery_method, page_count: Number(l.page_count || 0), postmark_date: l.postmark_date });
      }
    });
    // First-class postage bills at the USPS rate in effect on each letter's MAIL
    // date (auto-adjusts as USPS changes rates — no per-community rate editing).
    const { firstClassRateCents } = require('../lib/postage/usps_rates');
    const tallyArc = (cid, statusRaw) => {
      const r = row(cid);
      const s = (statusRaw || '').toLowerCase();
      // Approved-with-conditions counts as APPROVED (Ed 2026-07-10) — it IS an
      // approval, just contingent on conditions.
      if (s === 'approved' || s.includes('condition')) r.arc_approved += 1;
      else if (s === 'denied' || s === 'rejected') r.arc_denied += 1;
      else r.arc_other += 1; // pending / withdrawn / tabled / other
    };
    // Resident ACC decisions feed the HOA's ARC fee counts. Builder ARC does NOT —
    // it is billed to the builder on a separate builder invoice, so it is only
    // counted for the break-out (Ed 2026-07-10: separate homeowner vs builder ARC).
    accDecisions.forEach((d) => tallyArc(d.community_id, d.decision_type));
    decisions.forEach((d) => { row(d.community_id).builder_arc += 1; });
    paymentPlans.forEach((p) => { if (p.community_id) row(p.community_id).payment_plans += 1; });

    const communities = Object.values(byComm)
      .map(({ _letters, ...r }) => {
        const vals = [..._letters.values()];
        const letters_sent = vals.length;
        const firstClass = vals.filter((x) => x.delivery_method !== 'certified_mail');
        const certified_sent = letters_sent - firstClass.length;
        const pages_printed = vals.reduce((s, x) => s + x.page_count, 0);
        // Date-aware first-class postage: rate effective on each letter's postmark.
        const first_class_postage_cents = firstClass.reduce((s, x) => s + firstClassRateCents(x.postmark_date), 0);
        const rateSet = [...new Set(firstClass.map((x) => firstClassRateCents(x.postmark_date)))].sort((a, b) => a - b);
        return {
          ...r,
          letters_sent,
          certified_sent,
          first_class_sent: firstClass.length,
          first_class_postage_cents,
          // Effective per-piece rate(s) in cents — one value normally; a range in
          // the month a USPS increase lands.
          first_class_rate_cents: rateSet.length ? rateSet[rateSet.length - 1] : null,
          first_class_rate_mixed: rateSet.length > 1,
          // Period-level first-class rate from the ONE USPS schedule
          // (lib/postage/usps_rates.js), always present even with no letters, so
          // EVERY postage line (annual billing, meeting notices, nomination, etc.)
          // can price date-aware off a single source — not just the DRV line.
          postage_rate_cents: firstClassRateCents(end),
          pages_printed,
          payment_plans: r.payment_plans || 0,
          pages_unknown: letters_sent > 0 && pages_printed === 0,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const totals = communities.reduce((t, r) => ({
      violations: t.violations + r.violations,
      letters_sent: t.letters_sent + r.letters_sent,
      certified_sent: t.certified_sent + r.certified_sent,
      first_class_sent: t.first_class_sent + r.first_class_sent,
      first_class_postage_cents: t.first_class_postage_cents + (r.first_class_postage_cents || 0),
      pages_printed: t.pages_printed + r.pages_printed,
      arc_approved: t.arc_approved + r.arc_approved,
      arc_denied: t.arc_denied + r.arc_denied,
      arc_conditions: t.arc_conditions + r.arc_conditions,
      arc_other: t.arc_other + r.arc_other,
      builder_arc: t.builder_arc + r.builder_arc,
      payment_plans: t.payment_plans + (r.payment_plans || 0),
    }), { violations: 0, letters_sent: 0, certified_sent: 0, first_class_sent: 0, first_class_postage_cents: 0, pages_printed: 0, arc_approved: 0, arc_denied: 0, arc_conditions: 0, arc_other: 0, builder_arc: 0, payment_plans: 0 });

    res.json({ period: { start, end }, communities, totals, page_tracking: hasPageCount, postage_rate_cents: firstClassRateCents(end) });
  } catch (err) {
    console.error('[billing] activity-report failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/billing/activity-detail
//   ?community_id= &period_start=YYYY-MM-DD &period_end=YYYY-MM-DD &format=html|json
// ----------------------------------------------------------------------------
// The board-facing DETAIL behind the activity-report counts: every violation
// letter (property, date, stage, mail class, clickable PDF) and every ARC/ACC
// decision (property, applicant, outcome) for one community in the period.
// Bedrock-branded + printable so it can be sent to the board. Letter PDFs are
// exposed as 7-day signed URLs so a board member (no staff login) can open the
// supporting document straight from the report.
// ============================================================================
router.get('/activity-detail', async (req, res) => {
  try {
    const communityId = req.query.community_id;
    const start = (req.query.period_start || '').slice(0, 10);
    const end = (req.query.period_end || '').slice(0, 10);
    const format = (req.query.format || 'html').toLowerCase();
    // Optional focus from the activity-report column links: arc=approved|denied
    // filters the ARC section; the #letters / #arc URL anchor scrolls to it.
    const arcFilter = ['approved', 'denied'].includes((req.query.arc || '').toLowerCase())
      ? (req.query.arc || '').toLowerCase() : 'all';
    if (!communityId) return res.status(400).json({ error: 'community_id required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return res.status(400).json({ error: 'period_start and period_end required as YYYY-MM-DD' });
    }
    const endEx = (() => { const d = new Date(end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();

    const LETTER_TYPES = ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209', 'letter_postcard_reminder'];
    const STAGE_LABEL = {
      letter_courtesy_1: 'Courtesy 1', letter_courtesy_2: 'Courtesy 2',
      letter_209: 'Certified §209', letter_postcard_reminder: 'Postcard reminder',
    };

    async function fetchAll(build) {
      const out = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await build().range(from, from + 999);
        if (error) throw error;
        out.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      return out;
    }

    const [{ data: community }, letters, decisions, accDecisions] = await Promise.all([
      supabase.from('communities').select('id, name, legal_name').eq('id', communityId).maybeSingle(),
      fetchAll(() => supabase.from('interactions')
        .select('id, property_id, type, delivery_method, postmark_date, content, bundle_id, page_count, violation_id')
        .eq('community_id', communityId).in('type', LETTER_TYPES)
        .not('printed_at', 'is', null).gte('postmark_date', start).lt('postmark_date', endEx)),
      fetchAll(() => supabase.from('builder_applications')
        .select('id, reference_number, street_address, submitter_name, status, decided_at')
        .eq('community_id', communityId)
        .not('decided_at', 'is', null)
        .gte('decided_at', start + 'T00:00:00Z').lt('decided_at', endEx + 'T00:00:00Z')),
      // Resident ACC decisions we ran through trustEd (acc_decisions) — the ones
      // staff issued + generated a letter for. created_at is the decision timestamp.
      fetchAll(() => supabase.from('acc_decisions')
        .select('id, homeowner_address, homeowner_name, project_summary, decision_type, created_at, letter_pdf_storage_path')
        .eq('community_id', communityId)
        .gte('created_at', start + 'T00:00:00Z').lt('created_at', endEx + 'T00:00:00Z')),
    ]);
    if (!community) return res.status(404).json({ error: 'community_not_found' });

    // Violation type (category) for each letter — this is what the board wants to
    // see, not a PDF link (Ed 2026-07-10). letter interaction -> violation ->
    // primary_category_id -> enforcement_categories.label.
    const violationIds = [...new Set(letters.map((l) => l.violation_id).filter(Boolean))];
    const catByViolation = {};
    if (violationIds.length) {
      const vios = [];
      for (let i = 0; i < violationIds.length; i += 500) {
        const { data: v } = await supabase.from('violations')
          .select('id, primary_category_id').in('id', violationIds.slice(i, i + 500));
        vios.push(...(v || []));
      }
      const catIds = [...new Set(vios.map((v) => v.primary_category_id).filter(Boolean))];
      const catLabel = {};
      if (catIds.length) {
        const { data: cats } = await supabase.from('enforcement_categories').select('id, label').in('id', catIds);
        (cats || []).forEach((c) => { catLabel[c.id] = c.label; });
      }
      vios.forEach((v) => { catByViolation[v.id] = catLabel[v.primary_category_id] || null; });
    }

    // Property addresses for the letters.
    const propIds = [...new Set(letters.map((l) => l.property_id).filter(Boolean))];
    const addrById = {};
    for (let i = 0; i < propIds.length; i += 500) {
      const { data: props } = await supabase.from('properties')
        .select('id, street_address, unit').in('id', propIds.slice(i, i + 500));
      (props || []).forEach((p) => { addrById[p.id] = p.street_address + (p.unit ? ' #' + p.unit : ''); });
    }

    // Group by ENVELOPE (bundle_id) so the detail reconciles with the report:
    // one row per physical letter, listing the violations it covers. This is why
    // the PDF count in the detail now matches "Letters sent," not "Violations".
    const letterKey = (l) => l.bundle_id || l.content || ('id:' + l.id);
    const groups = new Map();
    for (const l of letters) {
      const key = letterKey(l);
      let g = groups.get(key);
      if (!g) {
        g = { property: addrById[l.property_id] || '(unknown address)', dates: [], stages: new Set(),
              types: new Set(), violations: 0, delivery_method: l.delivery_method, page_count: 0, content: l.content || null };
        groups.set(key, g);
      }
      g.violations += 1;
      if (l.postmark_date) g.dates.push(l.postmark_date);
      g.stages.add(STAGE_LABEL[l.type] || l.type);
      const cat = l.violation_id ? catByViolation[l.violation_id] : null;
      if (cat) g.types.add(cat);
      g.page_count = Math.max(g.page_count, Number(l.page_count || 0)); // members share one PDF
      if (!g.content && l.content) g.content = l.content;
    }
    const letterRows = [...groups.values()].map((g) => ({
      property: g.property,
      date: g.dates.sort()[0] || null,
      stage: [...g.stages].join(', '),
      violation_type: [...g.types].join(', ') || '—',
      violations: g.violations,
      pages: g.page_count,
      mail_class: g.delivery_method === 'certified_mail' ? 'Certified' : 'First-class',
    })).sort((a, b) => (a.property).localeCompare(b.property) || String(a.date).localeCompare(String(b.date)));

    // 7-day signed URLs for the ACC decision letters (the PDF sent to the
    // homeowner) so the board can open them straight from the report, no login.
    const accPaths = [...new Set(accDecisions.map((d) => d.letter_pdf_storage_path).filter(Boolean))];
    const accSignedByPath = {};
    for (let i = 0; i < accPaths.length; i += 100) {
      const { data: signed } = await supabase.storage.from('documents')
        .createSignedUrls(accPaths.slice(i, i + 100), 60 * 60 * 24 * 7);
      (signed || []).forEach((s) => { if (s && s.signedUrl && !s.error) accSignedByPath[s.path] = s.signedUrl; });
    }

    const outcomeOf = (statusRaw) => {
      const s = (statusRaw || '').toLowerCase();
      return s === 'approved' ? 'Approved'
        : (s === 'denied' || s === 'rejected') ? 'Denied'
        : s.includes('condition') ? 'Approved w/ conditions'
        : (statusRaw ? statusRaw.charAt(0).toUpperCase() + statusRaw.slice(1) : '—');
    };
    const arcRows = [
      // Builder ARC
      ...decisions.map((d) => ({
        property: d.street_address || '(no address)', applicant: d.submitter_name || '—',
        project: d.reference_number || null, conditions: null, kind: 'Builder ARC',
        outcome: outcomeOf(d.status), date: (d.decided_at || '').slice(0, 10),
      })),
      // Resident ACC — capture WHAT was approved: the project + a link to the
      // actual approval letter trustEd generated + sent to the homeowner.
      ...accDecisions.map((d) => ({
        property: d.homeowner_address || '(no address)', applicant: d.homeowner_name || '—',
        project: d.project_summary || null, conditions: null, kind: 'Resident ACC',
        outcome: outcomeOf(d.decision_type), date: (d.created_at || '').slice(0, 10),
        letter_url: d.letter_pdf_storage_path ? (accSignedByPath[d.letter_pdf_storage_path] || null) : null,
      })),
    ].sort((a, b) => a.property.localeCompare(b.property));

    // Apply the ARC filter (from the ARC Approved / ARC Denied column links).
    const arcRowsShown = arcFilter === 'all' ? arcRows
      : arcRows.filter((r) => arcFilter === 'approved'
        ? /^approved/i.test(r.outcome)
        : r.outcome === 'Denied');

    const certCount = letterRows.filter((r) => r.mail_class === 'Certified').length;
    const summary = {
      violations: letters.length,
      letters_total: letterRows.length,
      certified: certCount,
      first_class: letterRows.length - certCount,
      arc_decisions: arcRows.length,
    };

    if (format === 'json') {
      return res.json({ community: { id: community.id, name: community.name }, period: { start, end }, arc_filter: arcFilter, summary, letters: letterRows, arc_decisions: arcRowsShown });
    }

    // ---- Branded, printable HTML ----
    const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const fmtUS = (s) => { if (!s) return ''; const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? s + 'T12:00:00' : s); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' }); };
    const fmtLong = (s) => { const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? s + 'T12:00:00' : s); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' }); };
    const NAVY = '#0B1D34';
    const letterTable = letterRows.length ? `
      <p class="muted" style="margin:0 0 10px;"><strong>${summary.violations}</strong> violation${summary.violations === 1 ? '' : 's'} mailed across <strong>${summary.letters_total}</strong> letter${summary.letters_total === 1 ? '' : 's'} (${summary.certified} certified, ${summary.first_class} first-class). One row per letter; a bundle to one owner counts once.</p>
      <table class="t">
        <thead><tr><th>Property</th><th>Date</th><th>Violation type</th><th>Stage(s)</th><th>Mail class</th><th style="text-align:center;">Violations</th></tr></thead>
        <tbody>${letterRows.map((r) => `<tr>
          <td><strong>${esc(r.property)}</strong></td><td>${esc(fmtUS(r.date))}</td>
          <td>${esc(r.violation_type)}</td>
          <td>${esc(r.stage)}</td>
          <td>${r.mail_class === 'Certified' ? '<span class="cert">Certified</span>' : 'First-class'}</td>
          <td style="text-align:center;">${r.violations}${r.violations > 1 ? ' <span class="muted">(bundle)</span>' : ''}</td>
        </tr>`).join('')}</tbody>
      </table>` : '<p class="muted">No violation letters mailed in this period.</p>';
    const arcTable = arcRowsShown.length ? `
      <table class="t">
        <thead><tr><th>Property</th><th>Applicant</th><th>Type</th><th>Project — what was approved</th><th>Decision</th><th>Date</th></tr></thead>
        <tbody>${arcRowsShown.map((r) => `<tr>
          <td><strong>${esc(r.property)}</strong></td><td>${esc(r.applicant)}</td>
          <td>${esc(r.kind || '—')}</td>
          <td>${esc(r.project || '—')}${r.conditions ? `<div class="muted" style="font-size:11px; margin-top:2px;">Conditions: ${esc(String(r.conditions).slice(0, 160))}</div>` : ''}</td>
          <td>${r.outcome === 'Denied' ? `<span class="denied">${esc(r.outcome)}</span>` : esc(r.outcome)}${r.letter_url ? `<div style="font-size:11px; margin-top:2px;"><a href="${esc(r.letter_url)}" target="_blank" rel="noopener">Approval letter ↗</a></div>` : ''}</td>
          <td>${esc(fmtUS(r.date))}</td>
        </tr>`).join('')}</tbody>
      </table>` : '<p class="muted">No ARC/ACC decisions rendered in this period.</p>';

    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(community.name)} — Activity Detail ${esc(fmtUS(start))}–${esc(fmtUS(end))}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif; color: #1a1a1a; margin: 0; background: #f4f4f5; font-size: 13px; line-height: 1.5; }
  .page { max-width: 8.5in; margin: 22px auto; background: #fff; padding: 0.6in 0.55in; box-shadow: 0 4px 16px rgba(0,0,0,0.06); }
  .head { border-bottom: 2px solid ${NAVY}; padding-bottom: 14px; margin-bottom: 20px; }
  .brand { font-weight: 700; color: ${NAVY}; letter-spacing: 0.02em; }
  .tag { float: right; font-size: 10.5px; letter-spacing: 0.12em; color: #64748b; }
  h1 { font-size: 21px; color: ${NAVY}; margin: 10px 0 4px; }
  .sub { color: #475569; font-size: 12.5px; }
  .meta { color: #64748b; font-size: 11px; margin-top: 6px; }
  .stats { display: flex; gap: 14px; flex-wrap: wrap; margin: 16px 0 24px; padding: 12px 14px; background: #EAF0F7; border-radius: 6px; }
  .stat { text-align: center; min-width: 76px; }
  .stat-n { font-size: 20px; font-weight: 700; color: ${NAVY}; }
  .stat-l { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #475569; margin-top: 2px; }
  h2 { font-size: 15px; color: ${NAVY}; margin: 24px 0 8px; padding-bottom: 5px; border-bottom: 1px solid #d4d4d8; }
  table.t { width: 100%; border-collapse: collapse; }
  table.t th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; border-bottom: 1.5px solid ${NAVY}; padding: 5px 8px; }
  table.t td { padding: 6px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  a { color: #1F3A5F; font-weight: 600; }
  .cert { color: #92400e; font-weight: 700; }
  .denied { color: #b91c1c; font-weight: 700; }
  .muted { color: #94a3b8; }
  .foot { margin-top: 26px; padding-top: 12px; border-top: 1px solid #e5e5e5; font-size: 10.5px; color: #94a3b8; display: flex; justify-content: space-between; }
  .noprint { background: #fef9c3; border-bottom: 1px solid #fde047; padding: 8px 12px; font-size: 12px; text-align: center; }
  @media print { .noprint { display: none; } body { background: #fff; } .page { box-shadow: none; margin: 0; max-width: none; } }
</style></head>
<body>
  <div class="noprint">Tip: hit <strong>Ctrl/Cmd-P</strong> → "Save as PDF" to send this to the board.</div>
  <div class="page">
    <div class="head">
      <div><span class="brand">${esc(BRAND.service.name)}</span><span class="tag">${esc(BRAND.service.taglineUpper)}</span></div>
      <h1>${esc(community.name)} — Compliance & ARC Activity</h1>
      <div class="sub">Detail for <strong>${esc(fmtLong(start))}</strong> through <strong>${esc(fmtLong(end))}</strong></div>
      <div class="meta">${esc(BRAND.service.legal)} on behalf of the ${esc(community.name)} Board of Directors</div>
    </div>
    <div class="stats">
      <div class="stat"><div class="stat-n">${summary.letters_total}</div><div class="stat-l">Letters sent</div></div>
      <div class="stat"><div class="stat-n">${summary.first_class}</div><div class="stat-l">First-class</div></div>
      <div class="stat"><div class="stat-n">${summary.certified}</div><div class="stat-l">Certified</div></div>
      <div class="stat"><div class="stat-n">${summary.arc_decisions}</div><div class="stat-l">ARC decisions</div></div>
    </div>
    <h2 id="letters">Violation letters</h2>
    ${letterTable}
    <h2 id="arc">ARC / ACC decisions${arcFilter === 'all' ? '' : ` — ${arcFilter === 'approved' ? 'Approved' : 'Denied'} only`}</h2>
    ${arcTable}
    <div class="foot"><span>${esc(BRAND.service.name)}</span><span>${esc(community.name)} · ${esc(fmtUS(start))}–${esc(fmtUS(end))}</span></div>
  </div>
</body></html>`);
  } catch (err) {
    console.error('[billing] activity-detail failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/billing/communities/:communityId/billing-code   { billing_code }
// Sets the short per-community code used in invoice numbers. Uppercased,
// alphanumerics only, max 8 chars.
// ---------------------------------------------------------------------------
router.put('/communities/:communityId/billing-code', express.json(), async (req, res) => {
  try {
    const code = String((req.body && req.body.billing_code) || '')
      .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!code) return res.status(400).json({ error: 'billing_code required (letters/numbers)' });
    const { error } = await supabase.from('communities')
      .update({ billing_code: code })
      .eq('id', req.params.communityId)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    if (error) throw error;
    res.json({ ok: true, billing_code: code });
  } catch (err) {
    console.error('[billing] set billing-code failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
