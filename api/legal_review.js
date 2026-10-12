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
//   GET  /invoices/:id/evidence       the retained originals this review relied
//                                     on, with what each proves / leaves open
//   GET  /evidence/:docId/file        short-lived link to one retained original
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
const ES = require('../lib/legal/evidence_store');

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

// The originals relied on for this invoice's review (lib/legal/evidence_store):
// what each one proves and what it leaves uncertain. Staff only, scoped to the
// invoice's own association. The file itself opens through /evidence/:docId.
router.get('/invoices/:id/evidence', async (req, res) => {
  const staff = await requireStaff(req, res); if (!staff) return;
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'invoice_id_invalid' });
    const { data: inv, error } = await supabase.from('ap_invoices').select('id, community_id, vendor_id').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    const { vendors } = await R.legalVendors(supabase);
    if (!inv || !vendors.some((v) => v.id === inv.vendor_id)) return res.status(404).json({ error: 'not_a_legal_invoice' });
    const docs = await ES.findEvidence(supabase, { communityId: inv.community_id, apInvoiceId: inv.id });
    res.json({ evidence: docs.map(ES.evidenceSummary) });
  } catch (err) {
    console.error('[legal-review] evidence list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/evidence/:docId/file', async (req, res) => {
  const staff = await requireStaff(req, res); if (!staff) return;
  try {
    if (!UUID.test(req.params.docId)) return res.status(400).json({ error: 'document_id_invalid' });
    const url = await ES.signedUrl(supabase, req.params.docId);
    if (!url) return res.status(404).json({ error: 'not_legal_evidence' });
    console.log('[legal-review] evidence opened', JSON.stringify({ document_id: req.params.docId, by: staff.email || staff.id || null }));
    res.json({ url });
  } catch (err) {
    console.error('[legal-review] evidence open failed:', err.message);
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
  const postings = ready ? await T.loadPostings(supabase, d.invoice.id) : [];
  return { plan, postings, migration_508: ready, billback: await billbackSummary(d, plan, postings) };
}

// The homeowner bill-back as AP staff see it on the invoice screen (Ed 2026-10-12):
// per homeowner-recoverable allocation, the property, the owner on file, the amount,
// the source invoice line and whether it has posted; plus the association lines and
// what still needs a person. Read only: posting stays Approve Treatment (owner).
async function billbackSummary(d, plan, postings) {
  const items = (d.saved && d.saved.items) || [];
  const lineText = new Map((d.lines || []).map((l) => [l.id, l.description]));
  const allocs = items.flatMap((it) => (it.allocations || []).map((a) => ({ it, a })));
  const props = [...new Set(allocs.map((x) => x.a.property_id).filter(Boolean))];
  const addr = new Map(); const owners = new Map();
  if (props.length) {
    const { data: pr, error: pe } = await supabase.from('properties').select('id, street_address, unit').in('id', props);
    if (pe) throw pe;
    (pr || []).forEach((p) => addr.set(p.id, [p.street_address, p.unit].filter(Boolean).join(' #')));
    const tenures = [...new Set(allocs.map((x) => x.a.tenure_id).filter(Boolean))];
    if (tenures.length) {
      const { data: po, error: oe } = await supabase.from('property_ownerships').select('tenure_id, contacts(full_name)').in('tenure_id', tenures);
      if (oe) throw oe;
      (po || []).forEach((o) => { const n = o.contacts && o.contacts.full_name; if (n) owners.set(o.tenure_id, [...(owners.get(o.tenure_id) || []), n]); });
    }
  }
  const posted = new Map((postings || []).filter((p) => p.status === 'posted' && !p.reversed_at).map((p) => [p.allocation_id, p]));
  const S2 = require('../lib/legal/review_suggest');
  const rows = allocs.map(({ it, a }) => {
    const t = S2.triageItem(it);
    const p = posted.get(a.id);
    return { classification: a.classification, amount_cents: Number(a.amount_cents), property: a.property_id ? addr.get(a.property_id) || null : null,
      owner: a.tenure_id ? (owners.get(a.tenure_id) || []).join('; ') || null : null, confidence: a.confidence || null, charge_category: a.charge_category || null,
      source_text: (it.source_line_ids || []).map((id) => lineText.get(id)).filter(Boolean).join(' / ') || it.source_text || null,
      status: p ? 'charged' : (a.classification === 'association_legal_expense' && plan.review && plan.review.status === 'approved') ? 'association_final' : t.status === 'exception' ? 'needs_review' : 'pending_approval', reasons: t.status === 'exception' ? t.reasons : [],
      posting: p ? { journal_entry_id: p.journal_entry_id, homeowner_transaction_id: p.homeowner_transaction_id, posted_at: p.posted_at } : null };
  });
  const sum = (f) => rows.filter(f).reduce((t, r) => t + r.amount_cents, 0);
  // The FINAL accounting the invoice ends with (Ed 2026-10-12): homeowner AR vs association
  // expense by account, against AP for the invoice total, and how it got there.
  const lineAcct = new Map((d.lines || []).map((l) => [l.id, l.account]));
  const expense = new Map();
  for (const { it, a } of allocs) {
    if (a.classification !== 'association_legal_expense') continue;
    const accts = [...new Set((it.source_line_ids || []).map((id) => lineAcct.get(id)).filter(Boolean))];
    const k = accts.length === 1 ? accts[0] : 'association legal expense';
    expense.set(k, (expense.get(k) || 0) + Number(a.amount_cents));
  }
  const homeowner = sum((r) => r.classification === 'homeowner_recoverable');
  const charged = sum((r) => r.status === 'charged');
  const final = { ar_cents: homeowner, owners: rows.filter((r) => r.classification === 'homeowner_recoverable').length,
    expense: [...expense.entries()].map(([account, cents]) => ({ account, cents })), bedrock_cents: sum((r) => r.classification === 'bedrock_corporate'), ap_cents: Number(d.invoice.total_cents),
    method: plan.mode === 'direct' ? (charged ? 'posted directly to homeowner AR with the accrual' : 'posts directly to homeowner AR with the accrual when approved')
      : charged ? 'accrued to legal expense, owner share then billed back to homeowner AR (net result shown)' : 'accrued to legal expense; the owner share is billed back to homeowner AR when approved',
    posted: homeowner === 0 ? !!plan.accrual : charged === homeowner };
  return { review_status: plan.review ? plan.review.status : 'none', ready: plan.ready, blocking: plan.blocking, final,
    homeowner_cents: sum((r) => r.classification === 'homeowner_recoverable'), charged_cents: sum((r) => r.status === 'charged'),
    association_cents: sum((r) => r.classification === 'association_legal_expense'), rows, review_url: `/app/financial/legal?id=${d.invoice.id}` };
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
