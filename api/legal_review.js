// ============================================================================
// api/legal_review.js — Legal Invoice Review (Issue #9 step 2: DRAFT ONLY)
// ----------------------------------------------------------------------------
// Mounted at /api/legal-review. Staff sign-in required. Powers
// /app/financial/legal.
//
//   GET  /invoices                    attorney invoices (the three firms), newest
//                                     first, with draft status
//   GET  /invoices/:id                one invoice: lines, suggestions with their
//                                     evidence, the saved draft, reconciliation
//   GET  /invoices/:id/properties?q=  property search inside the invoice's
//                                     community (for overriding a match)
//   POST /invoices/:id/draft          save the draft (revisioned; 409 when
//                                     someone else saved first)
//
// Nothing here posts to the GL, reclassifies an accrual or charges a
// homeowner. The save writes only the review workpaper tables, through the
// atomic legal_review_save_draft() function (migration 473). Evidence, tenure
// and the bankruptcy stop are recomputed on the server for every save.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { requireStaff } = require('./_require_admin');
const R = require('../lib/legal/review_data');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/invoices', async (req, res) => {
  const staff = await requireStaff(req, res); if (!staff) return;
  try {
    res.json(Object.assign({ generated_at: new Date().toISOString() }, await R.listInvoices(supabase)));
  } catch (err) {
    console.error('[legal-review] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/invoices/:id', async (req, res) => {
  const staff = await requireStaff(req, res); if (!staff) return;
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'invoice_id_invalid' });
    const d = await R.loadInvoice(supabase, req.params.id);
    if (!d) return res.status(404).json({ error: 'not_a_legal_invoice' });
    res.json(R.detailPayload(d));
  } catch (err) {
    console.error('[legal-review] detail failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/invoices/:id/properties', async (req, res) => {
  const staff = await requireStaff(req, res); if (!staff) return;
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'invoice_id_invalid' });
    const q = String(req.query.q || '').replace(/[%_,()*\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (q.length < 2) return res.json({ properties: [] });
    const { data: inv, error } = await supabase.from('ap_invoices').select('id, community_id, vendor_id').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    const { vendors } = await R.legalVendors(supabase);
    if (!inv || !vendors.some((v) => v.id === inv.vendor_id)) return res.status(404).json({ error: 'not_a_legal_invoice' });
    const { data, error: pe } = await supabase.from('properties').select('id, street_address, unit, trusted_account_number')
      .eq('community_id', inv.community_id).ilike('street_address', `%${q}%`).order('street_address').limit(25);
    if (pe) throw pe;
    res.json({ properties: (data || []).map((p) => ({ id: p.id, label: [p.street_address, p.unit].filter(Boolean).join(' #'), account: p.trusted_account_number || null })) });
  } catch (err) {
    console.error('[legal-review] property search failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/invoices/:id/draft', express.json({ limit: '256kb' }), async (req, res) => {
  const staff = await requireStaff(req, res); if (!staff) return;
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'invoice_id_invalid' });
    const base = Number(req.body && req.body.base_revision);
    if (!Number.isInteger(base) || base < 0) return res.status(400).json({ error: 'base_revision_required' });
    const d = await R.loadInvoice(supabase, req.params.id);
    if (!d) return res.status(404).json({ error: 'not_a_legal_invoice' });
    if (d.readOnly) return res.status(409).json({ error: 'read_only', detail: d.readOnly });
    if (!d.schemaReady) return res.status(409).json({ error: 'migration_pending', detail: 'Saving drafts turns on once migration 473 is applied.' });
    const built = R.buildDraft(d, req.body);
    if (built.errors) return res.status(400).json({ error: 'draft_invalid', errors: built.errors });
    const actor = staff.email || staff.id || 'staff';
    const rec = built.reconciliation;
    const summary = {
      items: built.items.length,
      allocations: built.items.reduce((s, it) => s + it.allocations.length, 0),
      invoice_total_cents: rec.invoice_total_cents, allocated_cents: rec.allocated_cents,
      reconciled: rec.reconciled, ready_for_approval: rec.ready_for_approval, blocking: rec.blocking.length,
    };
    const { data, error } = await supabase.rpc('legal_review_save_draft', {
      p_ap_invoice_id: d.invoice.id, p_community_id: d.invoice.community_id, p_base_revision: base,
      p_actor: actor, p_items: built.items, p_summary: summary,
    });
    if (error) throw error;
    if (!data || data.ok !== true) {
      if (data && data.error === 'stale') return res.status(409).json({ error: 'stale', revision: data.revision, detail: 'Someone saved this draft after you opened it. Reload to see their changes.' });
      throw new Error('save returned no result');
    }
    console.log('[legal-review] draft saved', JSON.stringify({ invoice: d.invoice.id, revision: data.revision, actor, ...summary }));
    const fresh = await R.loadInvoice(supabase, req.params.id);
    res.json(Object.assign({ saved: true }, R.detailPayload(fresh)));
  } catch (err) {
    console.error('[legal-review] save failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
