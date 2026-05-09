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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
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
        id, name, legal_name, vantaca_code, total_lots, active,
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
    if (insErr) throw insErr;

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

module.exports = { router };
