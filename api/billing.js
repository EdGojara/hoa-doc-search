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
// POST /api/billing/invoices/:invoiceId/import-vantaca-violations
// multipart/form-data with field "pdf" containing the Vantaca Violation Report
//
// Parses the report's Summary section using Claude (resilient to format
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

    // Call Claude to extract the summary counts.
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

    // 2. Postage for DRV notices (first + second + certified mail).
    if (totalNotices > 0) {
      const postage = findReimb('postage');
      if (postage) {
        const rate = Number(postage.unit_price || 0);
        newLines.push({
          source: 'reimbursable',
          source_ref_id: postage.id,
          category: postage.category,
          description: `Postage — DRV notices (${firstCount} first, ${secondCount} second, ${certCount} certified)`,
          qty: totalNotices,
          unit_price: rate,
          amount: Math.round(totalNotices * rate * 100) / 100,
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

module.exports = { router };
