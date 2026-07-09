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
function buildInvoiceNumber({ vantacaCode, period, type }) {
  const [yyyy, mm] = period.split('-');
  const yy = yyyy.slice(2);
  const suffix = type === 'activity' ? '2' : '';
  return `${yy}${mm}${vantacaCode}${suffix}`;
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
        id, name, legal_name, slug, vantaca_code, total_lots, active,
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

// ----------------------------------------------------------------------------
// POST /api/billing/communities/:communityId/draft-invoice
// body: { type: 'fixed' | 'activity', period: 'YYYY-MM', invoice_date?: 'YYYY-MM-DD' }
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
  const { type, period, invoice_date: invoiceDateOverride } = req.body || {};

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
      .select('id, name, vantaca_code, management_company_id')
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

    // Build line items from the rate card.
    let lineItems = [];
    if (type === 'fixed') {
      const { data: fixed, error: fErr } = await supabase
        .from('contract_fixed_items')
        .select('*')
        .eq('contract_id', contract.id)
        .order('sort_order');
      if (fErr) throw fErr;
      lineItems = (fixed || []).map(f => ({
        source: 'contract_fixed',
        source_ref_id: f.id,
        category: null,
        description: f.description,
        qty: 1,
        unit_price: Number(f.monthly_amount),
        amount: money(f.monthly_amount),
        sort_order: f.sort_order
      }));
    } else {
      // activity
      const { data: reimb, error: rErr } = await supabase
        .from('contract_reimbursables')
        .select('*')
        .eq('contract_id', contract.id)
        .order('sort_order');
      if (rErr) throw rErr;

      const { data: owner, error: oErr } = await supabase
        .from('contract_owner_charges')
        .select('*')
        .eq('contract_id', contract.id)
        .order('sort_order');
      if (oErr) throw oErr;

      // Reimbursables. qty=0 until staff/import sets it.
      lineItems = (reimb || []).map(r => ({
        source: 'reimbursable',
        source_ref_id: r.id,
        category: r.category,
        description: r.description,
        qty: 0,
        unit_price: r.unit_price !== null ? Number(r.unit_price) : 0,
        amount: 0,
        vantaca_source_ref: r.vantaca_source,
        sort_order: r.sort_order
      }));

      // Then owner charges, sorted after reimbursables.
      const ownerOffset = 1000;
      (owner || []).forEach(o => {
        lineItems.push({
          source: 'owner_charge',
          source_ref_id: o.id,
          category: o.category,
          description: o.description,
          qty: 0,
          unit_price: Number(o.fee_amount),
          amount: 0,
          sort_order: ownerOffset + o.sort_order
        });
      });
    }

    const subtotal = money(lineItems.reduce((s, li) => s + Number(li.amount || 0), 0));
    const { start: serviceStart, end: serviceEnd } = periodBoundaries(period);
    const invoiceDate = invoiceDateOverride || new Date().toISOString().slice(0, 10);
    const invoiceNumber = buildInvoiceNumber({
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
    if (!['draft', 'review'].includes(invoice.status)) {
      return res.status(400).json({
        error: `Cannot edit line items on invoice with status '${invoice.status}'. Only 'draft' or 'review' invoices are editable.`
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
      kind: 'edited',
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
router.get('/invoices/:invoiceId/pdf', async (req, res) => {
  const { invoiceId } = req.params;
  let browser;
  try {
    const { data: invoice, error: iErr } = await supabase
      .from('invoices')
      .select('*, community:communities(*)')
      .eq('id', invoiceId)
      .single();
    if (iErr || !invoice) return res.status(404).json({ error: 'Invoice not found' });

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

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: true
    });

    const filename = `invoice_${invoice.invoice_number || invoiceId}.pdf`;
    const dispo = req.query.inline === '1' ? 'inline' : 'attachment';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${dispo}; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[billing] PDF gen failed:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) { /* swallow */ }
    }
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
      sort_order: i
    }));
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
      sort_order: i
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
//   - notices_sent   : violation letters mailed (postmark_date in range)
//   - pages_printed  : physical pages of those letters (deduped by PDF path so
//                      a bundled letter's pages are counted once)
//   - arc_*          : ARC/ACC decisions rendered in range (builder_applications
//                      decided_at), split approved / denied / conditions / other
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
      letters = await letterCols('id, community_id, content, page_count, type, delivery_method, postmark_date');
    } catch (e) {
      if (/page_count/.test(e.message || '')) {
        hasPageCount = false;
        letters = await letterCols('id, community_id, content, type, delivery_method, postmark_date');
      } else { throw e; }
    }

    // 2) ARC/ACC decisions rendered in the period.
    let decisions = await fetchAll(() => {
      let q = supabase.from('builder_applications')
        .select('id, community_id, status, decided_at')
        .not('decided_at', 'is', null)
        .gte('decided_at', start + 'T00:00:00Z')
        .lt('decided_at', endEx + 'T00:00:00Z');
      if (communityId) q = q.eq('community_id', communityId);
      return q;
    });

    // Community name lookup.
    const { data: comms } = await supabase.from('communities').select('id, name');
    const nameById = Object.fromEntries((comms || []).map((c) => [c.id, c.name]));

    // Aggregate per community.
    const byComm = {};
    const row = (cid) => (byComm[cid] || (byComm[cid] = {
      community_id: cid, name: nameById[cid] || 'Unknown',
      notices_sent: 0, certified_sent: 0, first_class_sent: 0, pages_printed: 0,
      arc_approved: 0, arc_denied: 0, arc_conditions: 0, arc_other: 0,
      _seenPaths: new Set(),
    }));

    letters.forEach((l) => {
      const r = row(l.community_id);
      r.notices_sent += 1;
      // Split by mail class — certified costs materially more postage than
      // first-class, and the board detail bills them at different rates.
      if (l.delivery_method === 'certified_mail') r.certified_sent += 1;
      else r.first_class_sent += 1;
      // Pages: count each physical PDF once (bundled letters share a path).
      const key = l.content || l.id;
      if (!r._seenPaths.has(key)) {
        r._seenPaths.add(key);
        r.pages_printed += Number(l.page_count || 0);
      }
    });
    decisions.forEach((d) => {
      const r = row(d.community_id);
      const s = (d.status || '').toLowerCase();
      if (s === 'approved') r.arc_approved += 1;
      else if (s === 'denied' || s === 'rejected') r.arc_denied += 1;
      else if (s.includes('condition')) r.arc_conditions += 1;
      else r.arc_other += 1;
    });

    const communities = Object.values(byComm)
      .map(({ _seenPaths, ...r }) => ({ ...r, pages_unknown: r.notices_sent > 0 && r.pages_printed === 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const totals = communities.reduce((t, r) => ({
      notices_sent: t.notices_sent + r.notices_sent,
      certified_sent: t.certified_sent + r.certified_sent,
      first_class_sent: t.first_class_sent + r.first_class_sent,
      pages_printed: t.pages_printed + r.pages_printed,
      arc_approved: t.arc_approved + r.arc_approved,
      arc_denied: t.arc_denied + r.arc_denied,
      arc_conditions: t.arc_conditions + r.arc_conditions,
      arc_other: t.arc_other + r.arc_other,
    }), { notices_sent: 0, certified_sent: 0, first_class_sent: 0, pages_printed: 0, arc_approved: 0, arc_denied: 0, arc_conditions: 0, arc_other: 0 });

    res.json({ period: { start, end }, communities, totals, page_tracking: hasPageCount });
  } catch (err) {
    console.error('[billing] activity-report failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
