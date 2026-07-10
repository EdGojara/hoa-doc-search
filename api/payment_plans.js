// ============================================================================
// api/payment_plans.js  (Ed 2026-07-10) — mounted at /api/payment-plans
// ----------------------------------------------------------------------------
// Payment-plan intake + roster. The operator drops a signed plan agreement (or
// a firm report listing several); the AI extracts the terms; each is matched to
// a property (and its current owner) and previewed; on approve the plans are
// filed into the canonical payment_plans table (mig 273) — one ACTIVE plan per
// property, so re-uploading a corrected agreement updates rather than dupes.
// Each plan then surfaces on that homeowner's 360. Admin-only.
//
//   POST  /api/payment-plans/ingest            drop PDF -> preview (no write)
//   POST  /api/payment-plans/approve           file the reviewed rows
//   GET   /api/payment-plans/list              roster (optional community filter)
//   PATCH /api/payment-plans/:id               update status / terms on a plan
// ============================================================================
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { extractPaymentPlans, FREQUENCIES, PLAN_STATUSES } = require('../lib/payment_plans/extract');
const { resolveProperty } = require('../lib/entity_resolution');
// Access: staff-accessible (Ed 2026-07-10 — staff upload/manage payment plans).
// Protected by the global staff-cookie gate in server.js; no admin-only gate.
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = express.Router();

// Dollars (number/string) -> integer cents. null-safe: blank/invalid -> null.
function toCents(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
const cleanDate = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : null);

// The current owner (contact) of a matched property, for linkage + display.
async function ownerOf(propertyId) {
  const { data } = await supabase.from('property_ownerships')
    .select('contact_id, contacts(full_name)').eq('property_id', propertyId).is('end_date', null).limit(1);
  const row = data && data[0];
  return row ? { contact_id: row.contact_id, name: row.contacts ? row.contacts.full_name : null } : { contact_id: null, name: null };
}

// ----------------------------------------------------------------------------
// POST /ingest — extract + resolve + preview. Writes NOTHING to payment_plans;
// stashes the source PDF for the audit trail and returns rows for review.
// ----------------------------------------------------------------------------
router.post('/ingest', upload.single('pdf'), async (req, res) => {
  const t0 = Date.now();
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded (expected field "pdf").' });
    if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: `Unsupported file type: ${req.file.mimetype}` });
    const communityId = (req.body && req.body.community_id) || null;
    if (!communityId) return res.status(400).json({ error: 'community_id required (pick the association).' });

    // Stash the source PDF (non-fatal). Lives in the 'documents' bucket so the
    // 360 can link the actual agreement behind each plan.
    let storagePath = null;
    try {
      const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 16);
      const safe = (req.file.originalname || 'payment_plan.pdf').replace(/[^a-zA-Z0-9._\-]/g, '_');
      storagePath = `payment_plan_ingests/${hash}_${safe}`;
      await supabase.storage.from('documents').upload(storagePath, req.file.buffer, { contentType: 'application/pdf', upsert: true });
    } catch (e) { console.warn('[payment_plans] storage upload failed (non-fatal):', e.message); storagePath = null; }

    const { parsed, plans } = await extractPaymentPlans(req.file.buffer);

    const rows = []; let matched = 0;
    for (const p of plans) {
      let prop = null;
      if (p.property_address) { try { prop = await resolveProperty(supabase, communityId, p.property_address); } catch (_) {} }
      const owner = prop && prop.id ? await ownerOf(prop.id) : { contact_id: null, name: null };
      if (prop && prop.id) matched += 1;
      rows.push({
        debtor_name: p.debtor_name || owner.name || null,
        property_address: p.property_address || null,
        property_id: prop && prop.id ? prop.id : null,
        matched_address: prop && prop.id ? prop.street_address : null,
        contact_id: owner.contact_id,
        contact_name: owner.name,
        total_amount: p.total_amount ?? null,
        down_payment: p.down_payment ?? null,
        installment_amount: p.installment_amount ?? null,
        num_installments: p.num_installments ?? null,
        frequency: p.frequency,
        start_date: cleanDate(p.start_date),
        first_payment_date: cleanDate(p.first_payment_date),
        next_due_date: cleanDate(p.next_due_date),
        end_date: cleanDate(p.end_date),
        balance_remaining: p.balance_remaining ?? null,
        status: p.status_hint || 'active',
        terms_summary: p.terms_summary || null,
        delta: prop && prop.id ? 'matched' : 'unmatched',
      });
    }

    res.json({
      ok: true,
      document_date: parsed.document_date || null,
      association_name: parsed.association_name || null,
      source_filename: req.file.originalname || null,
      source_storage_path: storagePath,
      total_plans: plans.length, plans_matched: matched, plans_unmatched: plans.length - matched,
      rows,
      allowed_statuses: PLAN_STATUSES, allowed_frequencies: FREQUENCIES,
      duration_ms: Date.now() - t0,
    });
  } catch (err) {
    console.error('[payment_plans] ingest failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /approve — file the reviewed rows into payment_plans.
// Body: { community_id, source_filename, source_storage_path, rows: [ ... ] }
// One ACTIVE plan per property: an existing active plan is UPDATED, else INSERT.
// ----------------------------------------------------------------------------
router.post('/approve', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const communityId = b.community_id;
    if (!communityId) return res.status(400).json({ error: 'community_id required' });
    const rows = Array.isArray(b.rows) ? b.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'no rows to file' });

    let written = 0, updated = 0, skipped = 0;
    for (const r of rows) {
      if (!r.property_id) { skipped += 1; continue; } // never file an unmatched plan
      const status = PLAN_STATUSES.includes(r.status) ? r.status : 'active';
      const record = {
        community_id: communityId,
        property_id: r.property_id,
        contact_id: r.contact_id || null,
        status,
        debtor_name: r.debtor_name || r.contact_name || null,
        property_address: r.property_address || r.matched_address || null,
        total_amount_cents: toCents(r.total_amount),
        down_payment_cents: toCents(r.down_payment),
        installment_amount_cents: toCents(r.installment_amount),
        num_installments: (r.num_installments === '' || r.num_installments == null) ? null : parseInt(r.num_installments, 10) || null,
        frequency: FREQUENCIES.includes(r.frequency) ? r.frequency : 'monthly',
        start_date: cleanDate(r.start_date),
        first_payment_date: cleanDate(r.first_payment_date),
        next_due_date: cleanDate(r.next_due_date),
        end_date: cleanDate(r.end_date),
        balance_remaining_cents: toCents(r.balance_remaining),
        terms_summary: r.terms_summary || null,
        source_filename: b.source_filename || null,
        source_document_path: b.source_storage_path || null,
        extraction_model: 'claude-sonnet-4-5',
      };

      // One active plan per property: update the existing active one if present.
      let existingId = null;
      if (status === 'active') {
        const { data: ex } = await supabase.from('payment_plans')
          .select('id').eq('property_id', r.property_id).eq('status', 'active').limit(1);
        existingId = ex && ex[0] ? ex[0].id : null;
      }
      if (existingId) {
        const { error } = await supabase.from('payment_plans').update(record).eq('id', existingId);
        if (error) throw error;
        updated += 1;
      } else {
        const { error } = await supabase.from('payment_plans').insert(record);
        if (error) throw error;
        written += 1;
      }
    }

    res.json({ ok: true, plans_filed: written, plans_updated: updated, rows_skipped_unmatched: skipped });
  } catch (err) {
    console.error('[payment_plans] approve failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /list?community_id=&status= — the roster. Defaults to active plans across
// the whole portfolio; community_id / status narrow it. Links each plan to the
// owner + property for the 360.
// ----------------------------------------------------------------------------
router.get('/list', async (req, res) => {
  try {
    let q = supabase.from('payment_plans')
      .select('id, community_id, property_id, contact_id, status, debtor_name, property_address, total_amount_cents, installment_amount_cents, num_installments, frequency, start_date, next_due_date, end_date, balance_remaining_cents, terms_summary, source_document_path, created_at, updated_at, communities(name), contacts(full_name), properties(street_address)')
      .order('created_at', { ascending: false }).limit(1000);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    if (req.query.status) q = q.eq('status', req.query.status);
    else q = q.eq('status', 'active');
    const { data, error } = await q;
    if (error) throw error;
    const plans = (data || []).map((p) => ({
      ...p,
      community: p.communities ? p.communities.name : null,
      contact_name: p.contacts ? p.contacts.full_name : p.debtor_name,
      address: p.properties ? p.properties.street_address : p.property_address,
    }));
    res.json({ ok: true, plans });
  } catch (err) {
    console.error('[payment_plans] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// PATCH /:id — update a plan's status or terms (mark completed/defaulted, fix a
// number). allowedFields only — never patch raw body.
// ----------------------------------------------------------------------------
router.patch('/:id', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    if (b.status !== undefined) {
      if (!PLAN_STATUSES.includes(b.status)) return res.status(400).json({ error: 'invalid_status' });
      patch.status = b.status;
    }
    if (b.next_due_date !== undefined) patch.next_due_date = cleanDate(b.next_due_date);
    if (b.balance_remaining !== undefined) patch.balance_remaining_cents = toCents(b.balance_remaining);
    if (b.installment_amount !== undefined) patch.installment_amount_cents = toCents(b.installment_amount);
    if (b.notes !== undefined) patch.notes = b.notes ? String(b.notes) : null;
    if (b.terms_summary !== undefined) patch.terms_summary = b.terms_summary ? String(b.terms_summary) : null;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no_fields' });

    const { data, error } = await supabase.from('payment_plans').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ ok: true, plan: data });
  } catch (err) {
    console.error('[payment_plans] patch failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
