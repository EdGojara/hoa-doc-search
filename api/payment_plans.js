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
//   POST  /api/payment-plans/manual            hand-enter one plan (+ optional PDF)
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

// Normalize an association name for matching: drop the noise words ("homeowners
// association", "HOA", "Inc", "at", punctuation) that vary between how a plan
// document prints the name and how we store the community.
function normAssoc(s) {
  return String(s || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(the|at|of|a)\b/g, ' ')
    .replace(/\b(homeowners?|home|owners?|association|assoc|hoa|poa|coa|inc|incorporated|community|communities|property|master|residential|subdivision|ltd|llc)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Match a printed association name to a community. Returns the best candidate
// with a confidence, or null when nothing is close enough to trust. Property
// resolution downstream is the real confirmation, so a medium name match that
// then resolves a property in that community is trustworthy.
function matchCommunity(name, communities) {
  const target = normAssoc(name);
  if (!target) return null;
  let best = null;
  for (const c of communities) {
    for (const cand of [c.name, c.legal_name].filter(Boolean)) {
      const n = normAssoc(cand);
      if (!n) continue;
      let score = 0;
      if (n === target) score = 1;
      else if (n.includes(target) || target.includes(n)) {
        const shorter = Math.min(n.length, target.length), longer = Math.max(n.length, target.length);
        score = 0.3 + 0.6 * (shorter / longer);
      } else {
        const a = new Set(target.split(' ')), b = new Set(n.split(' '));
        const inter = [...a].filter((x) => b.has(x)).length;
        const uni = new Set([...a, ...b]).size;
        if (inter) score = 0.5 * (inter / uni);
      }
      if (!best || score > best.score) best = { community_id: c.id, community_name: c.name, score };
    }
  }
  if (!best || best.score < 0.5) return null;
  return { community_id: best.community_id, community_name: best.community_name, confidence: best.score >= 0.9 ? 'high' : 'medium' };
}

// Resolve one extracted plan to a property + owner within a community (or leave
// it unresolved when no community is known yet). Shared by /ingest and /resolve
// so the two paths can't drift.
async function resolvePlanRow(p, communityId, communityName, extra) {
  let prop = null;
  if (communityId && p.property_address) {
    try { prop = await resolveProperty(supabase, communityId, p.property_address); } catch (_) { prop = null; }
  }
  const owner = prop && prop.id ? await ownerOf(prop.id) : { contact_id: null, name: null };
  const matched = !!(prop && prop.id);
  return {
    debtor_name: p.debtor_name || owner.name || null,
    property_address: p.property_address || null,
    property_id: matched ? prop.id : null,
    matched_address: matched ? prop.street_address : null,
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
    status: p.status_hint || p.status || 'active',
    terms_summary: p.terms_summary || null,
    community_id: communityId || null,
    community_name: communityName || null,
    delta: matched ? 'matched' : (communityId ? 'unmatched' : 'no_community'),
    ...(extra || {}),
  };
}

// ----------------------------------------------------------------------------
// POST /ingest — extract + resolve + preview. Writes NOTHING to payment_plans;
// stashes each source PDF for the audit trail and returns rows for review.
//
// Bulk + auto-detect (Ed 2026-07-10): accepts ONE OR MANY PDFs at once and
// breaks them apart. community_id is OPTIONAL — when the operator doesn't pick
// an association, the association is read from each document and matched to a
// community (per plan, so a merged stack spanning associations splits too). A
// picked community_id forces every plan to that association.
// ----------------------------------------------------------------------------
router.post('/ingest', upload.array('pdf', 25), async (req, res) => {
  const t0 = Date.now();
  try {
    const files = (req.files && req.files.length) ? req.files : (req.file ? [req.file] : []);
    if (!files.length) return res.status(400).json({ error: 'No PDF uploaded (expected field "pdf").' });
    const bad = files.find((f) => f.mimetype !== 'application/pdf');
    if (bad) return res.status(400).json({ error: `Unsupported file type: ${bad.mimetype} (${bad.originalname || 'file'})` });
    const forcedCommunityId = (req.body && req.body.community_id) || null;

    const { data: communities } = await supabase.from('communities').select('id, name, legal_name');
    const commList = communities || [];
    const nameById = Object.fromEntries(commList.map((c) => [c.id, c.name]));

    const rows = [];
    const fileSummaries = [];
    let matched = 0, needAssoc = 0;

    for (const file of files) {
      // Stash the source PDF (non-fatal) in the 'documents' bucket so the 360 can
      // link the actual agreement behind each plan.
      let storagePath = null;
      try {
        const hash = crypto.createHash('sha256').update(file.buffer).digest('hex').slice(0, 16);
        const safe = (file.originalname || 'payment_plan.pdf').replace(/[^a-zA-Z0-9._\-]/g, '_');
        storagePath = `payment_plan_ingests/${hash}_${safe}`;
        await supabase.storage.from('documents').upload(storagePath, file.buffer, { contentType: 'application/pdf', upsert: true });
      } catch (e) { console.warn('[payment_plans] storage upload failed (non-fatal):', e.message); storagePath = null; }

      let parsed, plans;
      try {
        ({ parsed, plans } = await extractPaymentPlans(file.buffer));
      } catch (e) {
        fileSummaries.push({ source_filename: file.originalname || null, error: e.message, plan_count: 0 });
        continue;
      }

      for (const p of plans) {
        // Association: an explicit pick wins; else read it from the plan (or the
        // document), and match it to a community.
        const assocName = p.association_name || parsed.association_name || null;
        const detected = forcedCommunityId
          ? { community_id: forcedCommunityId, community_name: nameById[forcedCommunityId] || null, confidence: 'forced' }
          : matchCommunity(assocName, commList);
        const cid = detected ? detected.community_id : null;
        const row = await resolvePlanRow(p, cid, detected ? detected.community_name : null, {
          association_detected: assocName,
          association_confidence: detected ? detected.confidence : null,
          needs_community: !cid,
          source_filename: file.originalname || null,
          source_storage_path: storagePath,
        });
        if (row.delta === 'matched') matched += 1;
        if (!cid) needAssoc += 1;
        rows.push(row);
      }

      fileSummaries.push({
        source_filename: file.originalname || null,
        source_storage_path: storagePath,
        document_date: parsed.document_date || null,
        association_name: parsed.association_name || null,
        plan_count: plans.length,
      });
    }

    res.json({
      ok: true,
      files: fileSummaries,
      total_files: files.length,
      total_plans: rows.length,
      plans_matched: matched,
      plans_unmatched: rows.length - matched,
      plans_need_association: needAssoc,
      rows,
      communities: commList.map((c) => ({ id: c.id, name: c.name })),
      allowed_statuses: PLAN_STATUSES, allowed_frequencies: FREQUENCIES,
      duration_ms: Date.now() - t0,
    });
  } catch (err) {
    console.error('[payment_plans] ingest failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /resolve — cheap (no Claude) re-resolution when the operator assigns a
// community to a group whose association couldn't be auto-detected. Takes the
// already-extracted rows + a community_id and fills in property/owner matches.
//   body: { community_id, rows: [ {property_address, ...extracted fields} ] }
// ----------------------------------------------------------------------------
router.post('/resolve', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const communityId = b.community_id;
    if (!communityId) return res.status(400).json({ error: 'community_id required' });
    const inRows = Array.isArray(b.rows) ? b.rows : [];
    const { data: comm } = await supabase.from('communities').select('name').eq('id', communityId).maybeSingle();
    const communityName = comm ? comm.name : null;
    const rows = [];
    for (const p of inRows) {
      const row = await resolvePlanRow(p, communityId, communityName, {
        association_detected: p.association_detected || null,
        association_confidence: 'assigned',
        needs_community: false,
        source_filename: p.source_filename || null,
        source_storage_path: p.source_storage_path || null,
      });
      rows.push(row);
    }
    const matched = rows.filter((r) => r.delta === 'matched').length;
    res.json({ ok: true, rows, plans_matched: matched, plans_unmatched: rows.length - matched });
  } catch (err) {
    console.error('[payment_plans] resolve failed:', err.message);
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
    const fallbackCommunityId = b.community_id || null; // legacy single-community callers
    const rows = Array.isArray(b.rows) ? b.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'no rows to file' });

    let written = 0, updated = 0, skipped = 0;
    for (const r of rows) {
      // Bulk: each row carries its own community + source file. Never file a plan
      // without a resolved property (unmatched) or without a community.
      const communityId = r.community_id || fallbackCommunityId;
      if (!communityId || !r.property_id) { skipped += 1; continue; }
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
        source_filename: r.source_filename || b.source_filename || null,
        source_document_path: r.source_storage_path || b.source_storage_path || null,
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
// POST /manual — hand-enter a single plan (Ed 2026-07-17). For when there's no
// clean PDF to auto-extract, or the operator wants to key the terms directly.
// Multipart form; an optional `pdf` attaches the signed agreement (stashed the
// same way /ingest does, so the doc link works on the roster + 360 + billing
// activity-detail report). Resolves the property + current owner in the chosen
// community, then does the SAME one-active-per-property upsert as /approve.
// ----------------------------------------------------------------------------
router.post('/manual', upload.single('pdf'), async (req, res) => {
  try {
    const b = req.body || {};
    const communityId = b.community_id || null;
    if (!communityId) return res.status(400).json({ error: 'Association is required.' });

    // Resolve the property (+ current owner) within the community. A plan needs
    // a real property so it surfaces on that homeowner's 360.
    let propertyId = b.property_id || null;
    let matchedAddress = null;
    if (!propertyId && b.property_address) {
      let prop = null;
      try { prop = await resolveProperty(supabase, communityId, b.property_address); } catch (_) { prop = null; }
      if (prop && prop.id) { propertyId = prop.id; matchedAddress = prop.street_address; }
    }
    if (!propertyId) {
      return res.status(422).json({ error: `Couldn't match "${b.property_address || '(no address given)'}" to a property in this association. Check the address and try again.` });
    }
    const owner = b.contact_id ? { contact_id: b.contact_id, name: b.debtor_name || null } : await ownerOf(propertyId);

    // Optional attached agreement PDF -> stash in the documents bucket (non-fatal).
    let storagePath = null;
    if (req.file && req.file.buffer) {
      if (req.file.mimetype && req.file.mimetype !== 'application/pdf') {
        return res.status(400).json({ error: 'The attached agreement must be a PDF.' });
      }
      try {
        const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 16);
        const safe = (req.file.originalname || 'payment_plan.pdf').replace(/[^a-zA-Z0-9._\-]/g, '_');
        storagePath = `payment_plan_ingests/${hash}_${safe}`;
        await supabase.storage.from('documents').upload(storagePath, req.file.buffer, { contentType: 'application/pdf', upsert: true });
      } catch (e) { console.warn('[payment_plans] manual storage upload failed (non-fatal):', e.message); storagePath = null; }
    }

    const status = PLAN_STATUSES.includes(b.status) ? b.status : 'active';
    // Balance remaining defaults to the total for a fresh plan when not given.
    const balanceRaw = (b.balance_remaining != null && b.balance_remaining !== '') ? b.balance_remaining : b.total_amount;
    const record = {
      community_id: communityId,
      property_id: propertyId,
      contact_id: owner.contact_id || null,
      status,
      debtor_name: b.debtor_name || owner.name || null,
      property_address: b.property_address || matchedAddress || null,
      total_amount_cents: toCents(b.total_amount),
      down_payment_cents: toCents(b.down_payment),
      installment_amount_cents: toCents(b.installment_amount),
      num_installments: (b.num_installments === '' || b.num_installments == null) ? null : parseInt(b.num_installments, 10) || null,
      frequency: FREQUENCIES.includes(b.frequency) ? b.frequency : 'monthly',
      start_date: cleanDate(b.start_date),
      first_payment_date: cleanDate(b.first_payment_date),
      next_due_date: cleanDate(b.next_due_date),
      end_date: cleanDate(b.end_date),
      balance_remaining_cents: toCents(balanceRaw),
      terms_summary: b.terms_summary || null,
      notes: b.notes || null,
      source_filename: (req.file && req.file.originalname) || null,
      source_document_path: storagePath,
      extraction_model: 'manual',
    };

    // One active plan per property: update the existing active one if present
    // (same rule as /approve — a re-entered plan corrects, never dupes).
    let existingId = null;
    if (status === 'active') {
      const { data: ex } = await supabase.from('payment_plans')
        .select('id').eq('property_id', propertyId).eq('status', 'active').limit(1);
      existingId = ex && ex[0] ? ex[0].id : null;
    }
    let plan;
    if (existingId) {
      const { data, error } = await supabase.from('payment_plans').update(record).eq('id', existingId).select().single();
      if (error) throw error;
      plan = data;
    } else {
      const { data, error } = await supabase.from('payment_plans').insert(record).select().single();
      if (error) throw error;
      plan = data;
    }
    res.json({ ok: true, plan, updated: !!existingId, matched: { property_id: propertyId, matched_address: matchedAddress, contact_id: owner.contact_id, owner_name: owner.name } });
  } catch (err) {
    console.error('[payment_plans] manual create failed:', err.message);
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

module.exports = { router, matchCommunity, normAssoc };
