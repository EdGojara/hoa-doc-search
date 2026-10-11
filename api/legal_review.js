// ============================================================================
// api/legal_review.js — Legal Invoice Review (Issue #9 step 2: DRAFT ONLY)
// ----------------------------------------------------------------------------
// Mounted at /api/legal-review. Staff sign-in required. Powers
// /app/financial/legal.
//
//   GET  /invoices                    attorney invoices (the three firms), newest
//                                     first, with draft status
//   GET  /summaries                   the proposed outcome of every invoice
//                                     (accepted vs exceptions, in money)
//   GET  /invoices/:id                one invoice: lines, suggestions with their
//                                     evidence, the saved draft, reconciliation
//   GET  /invoices/:id/properties?q=  property search inside the invoice's
//                                     community (for overriding a match)
//   POST /invoices/:id/draft          save the draft (revisioned; 409 when
//                                     someone else saved first)
//   POST /invoices/:id/read-pdf       read the stored attorney PDF into
//                                     matters (step 2b; one model call; a
//                                     prior read of the same file is reused
//                                     unless {force:true}); writes only the
//                                     append-only extraction workpaper
//
//   GET  /invoices/:id/treatment      what Approve Treatment would post, or
//                                     why it can't, plus postings so far
//   POST /invoices/:id/approve-treatment  OWNER: lock the reviewed revision
//                                     and post its accounting (migration 508)
//   POST /postings/:id/reverse        OWNER: reverse one posting, with reason
//   POST /postings/:id/cancel         OWNER: cancel a pending posting that cannot
//                                     finish (reverses anything it wrote)
//   POST /invoices/:id/run-team       run Emma -> Amanda -> Kat now (prepares and
//                                     recommends only; never approves or posts)
//   GET  /invoices/:id/team           the team's latest findings + the activity
//   POST /invoices/:id/reopen         OWNER: reopen an approved review once
//                                     every posting is reversed, with reason
//
// Drafts write only the review workpaper tables, through the atomic
// legal_review_save_draft() function (migrations 473/508). Evidence, tenure
// and the bankruptcy stop are recomputed on the server for every save.
// Approve Treatment (lib/legal/treatment.js) is the chargeback authorization:
// it reclassifies accrued expense to the homeowner (or Bedrock) receivable. It
// never approves the AP invoice and never releases payment.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { requireStaff, requireOwner } = require('./_require_admin');
const T = require('../lib/legal/treatment');
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

router.get('/summaries', async (req, res) => {
  const staff = await requireStaff(req, res); if (!staff) return;
  try {
    res.json(await R.listSummaries(supabase));
  } catch (err) {
    console.error('[legal-review] summaries failed:', err.message);
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
    const actor = staff.email || staff.id || 'staff';
    const built = R.buildDraft(d, req.body, actor);
    if (built.errors) return res.status(400).json({ error: 'draft_invalid', errors: built.errors });
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
      if (data && data.error === 'approved_locked') return res.status(409).json({ error: 'approved_locked', detail: 'This treatment is approved. To change it, reverse its postings and reopen the review.' });
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

router.post('/invoices/:id/read-pdf', express.json({ limit: '4kb' }), async (req, res) => {
  const staff = await requireStaff(req, res); if (!staff) return;
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'invoice_id_invalid' });
    const d = await R.loadInvoice(supabase, req.params.id);
    if (!d) return res.status(404).json({ error: 'not_a_legal_invoice' });
    if (d.readOnly) return res.status(409).json({ error: 'read_only', detail: d.readOnly });
    const out = await R.readInvoicePdf(supabase, d, staff.email || staff.id || 'staff', { force: !!(req.body && req.body.force) });
    if (out.error) return res.status(out.http || 409).json({ error: out.error, detail: out.detail });
    const fresh = await R.loadInvoice(supabase, req.params.id);
    res.json(Object.assign({ read: { extraction_id: out.extraction_id, status: out.status, reused: out.reused } }, R.detailPayload(fresh)));
  } catch (err) {
    console.error('[legal-review] read-pdf failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

async function treatmentPayload(d, postingDate) {
  const plan = await T.planTreatment(supabase, d, { postingDate: postingDate || undefined });
  const ready = await T.postingsReady(supabase);
  return { plan, postings: ready ? await T.loadPostings(supabase, d.invoice.id) : [], migration_508: ready };
}

router.get('/invoices/:id/treatment', async (req, res) => {
  const staff = await requireStaff(req, res); if (!staff) return;
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'invoice_id_invalid' });
    const d = await R.loadInvoice(supabase, req.params.id);
    if (!d) return res.status(404).json({ error: 'not_a_legal_invoice' });
    const pd = req.query.posting_date && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.posting_date)) ? String(req.query.posting_date) : null;
    res.json(await treatmentPayload(d, pd));
  } catch (err) {
    console.error('[legal-review] treatment plan failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/invoices/:id/approve-treatment', express.json({ limit: '4kb' }), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'invoice_id_invalid' });
    const d = await R.loadInvoice(supabase, req.params.id);
    if (!d) return res.status(404).json({ error: 'not_a_legal_invoice' });
    if (d.readOnly) return res.status(409).json({ error: 'read_only', detail: d.readOnly });
    const out = await T.approveTreatment(supabase, d, {
      actor: admin.email, actorUserId: admin.user && admin.user.id, baseRevision: Number(req.body && req.body.revision),
      postingDate: req.body && req.body.posting_date ? String(req.body.posting_date) : undefined,
    });
    console.log('[legal-review] approve-treatment', JSON.stringify({ invoice: d.invoice.id, actor: admin.email, ok: out.ok, error: out.error || null, posted: (out.posted || []).length }));
    if (!out.ok) return res.status(out.error === 'migration_pending' ? 409 : out.error === 'stale' ? 409 : 400).json(out);
    const fresh = await R.loadInvoice(supabase, req.params.id);
    res.json(Object.assign({ approved: true, result: out }, await treatmentPayload(fresh)));
  } catch (err) {
    console.error('[legal-review] approve-treatment failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/postings/:id/reverse', express.json({ limit: '4kb' }), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'posting_id_invalid' });
    const out = await T.reversePosting(supabase, req.params.id, {
      actor: admin.email, actorUserId: admin.user && admin.user.id, reason: req.body && req.body.reason,
      reversalDate: req.body && req.body.reversal_date ? String(req.body.reversal_date) : undefined,
    });
    console.log('[legal-review] reverse posting', JSON.stringify({ posting: req.params.id, actor: admin.email, ok: out.ok, error: out.error || null }));
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) {
    console.error('[legal-review] reverse failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/postings/:id/cancel', express.json({ limit: '4kb' }), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'posting_id_invalid' });
    const out = await T.cancelPendingPosting(supabase, req.params.id, { actor: admin.email, actorUserId: admin.user && admin.user.id, reason: req.body && req.body.reason });
    console.log('[legal-review] cancel posting', JSON.stringify({ posting: req.params.id, actor: admin.email, ok: out.ok, error: out.error || null }));
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) {
    console.error('[legal-review] cancel failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/invoices/:id/run-team', express.json({ limit: '4kb' }), async (req, res) => {
  const staff = await requireStaff(req, res); if (!staff) return;
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'invoice_id_invalid' });
    const out = await require('../lib/legal/team').runLegalTeam(supabase, req.params.id, { trigger: `manual:${staff.email || 'staff'}` });
    console.log('[legal-review] run-team', JSON.stringify({ invoice: req.params.id, actor: staff.email, skipped: out.skipped || null }));
    res.json(out);
  } catch (err) {
    console.error('[legal-review] run-team failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/invoices/:id/team', async (req, res) => {
  const staff = await requireStaff(req, res); if (!staff) return;
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'invoice_id_invalid' });
    // Three activities per invoice: attorney payment, homeowner recovery, documentation.
    const keys = ['legal_invoice', 'legal_recovery', 'legal_documentation'].map((k) => `${k}:${req.params.id}`);
    const { data: objs, error } = await supabase.from('objectives').select('id, subject_key, title, status, autonomy_class, priority, next_action, updated_at, closed_reason')
      .in('subject_key', keys).order('created_at', { ascending: false }).limit(30);
    if (error) throw error;
    const activities = {};
    for (const o of objs || []) { const k = o.subject_key.split(':')[0]; if (!activities[k]) activities[k] = o; }
    const ids = Object.values(activities).map((o) => o.id);
    let decisions = [];
    if (ids.length) {
      const { data: dec, error: de } = await supabase.from('objective_decisions').select('decided_by, verdict, confidence, reason, evidence, proposed_action_detail, authorization_boundary, created_at')
        .in('objective_id', ids).order('created_at', { ascending: false }).limit(60);
      if (de) throw de;
      const latest = {};
      for (const d of dec || []) if (!latest[d.decided_by]) latest[d.decided_by] = d;
      decisions = ['emma', 'amanda', 'kat'].map((k) => latest[k]).filter(Boolean);
    }
    res.json({ activities, decisions });
  } catch (err) {
    console.error('[legal-review] team read failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/invoices/:id/reopen', express.json({ limit: '4kb' }), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'invoice_id_invalid' });
    const out = await T.reopenReview(supabase, req.params.id, { actor: admin.email, reason: req.body && req.body.reason });
    res.status(out.ok ? 200 : 409).json(out);
  } catch (err) {
    console.error('[legal-review] reopen failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
