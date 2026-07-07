// ============================================================================
// api/pool_access.js  (Ed 2026-07-07) — mounted at /api/pool-access
// ----------------------------------------------------------------------------
// Pool access roster: fob (key-tag) registrations + extended-hours swim
// approvals, filed onto the homeowner + property. Batch upload -> AI extract ->
// operator review -> approve -> rows land in pool_access. History/roster, not
// payment.
//
// Flow mirrors api/owner_ar.js (extract -> stage 'previewed' batch -> approve):
//   POST /ingest                     multi-file drag-drop; returns preview,
//                                     does NOT persist to the roster
//   POST /ingest/:batch_id/approve   commit the previewed forms
//   POST /ingest/:batch_id/discard
//   GET  /roster?community_id=       the tab's main list (who + tag numbers)
//   GET  /property/:id               pool access for one property (360 card)
//   GET  /batches?community_id=      upload history
//   POST /grant                      manual single grant (no form to upload)
//   PATCH /:id                       edit status / tag / people / notes
//
// REISSUE: a physical fob is one device. Approving a tag that is already
// active elsewhere supersedes the prior registration (old row -> 'revoked').
// The partial unique index uq_pool_access_active_tag makes a silent
// double-active-tag impossible; the pre-revoke keeps reissue legitimate.
// ============================================================================
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { extractPoolForms } = require('../lib/pool_access/extract');
const { resolveProperty } = require('../lib/entity_resolution');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 50 } });
const router = express.Router();

const FILEABLE = new Set(['fob_registration', 'extended_hours']);

// ----------------------------------------------------------------------------
// Paged fetch — never trust the implicit 1000-row PostgREST cap on a roster
// (CLAUDE.md: Supabase 1000-row silent truncation).
// ----------------------------------------------------------------------------
async function fetchAll(build) {
  const out = [];
  const page = 1000;
  for (let from = 0; from < 100000; from += page) {
    const { data, error } = await build().range(from, from + page - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < page) break;
  }
  return out;
}

// Current owner of a property (for filing onto the homeowner).
async function ownerOfProperty(propertyId) {
  if (!propertyId) return { contact_id: null, name: null };
  const { data } = await supabase
    .from('property_ownerships')
    .select('contact_id, contacts(full_name)')
    .eq('property_id', propertyId).is('end_date', null).limit(1);
  const row = data && data[0];
  return { contact_id: row ? row.contact_id : null, name: row && row.contacts ? row.contacts.full_name : null };
}

// Expand extracted forms into ROSTER ROWS (one per fob tag, one per
// extended-hours approval), resolve each to a property + owner, and cross-check
// fob tags against existing active grants.
async function resolveRows(forms, communityId, sourceFilename) {
  const rows = [];
  for (const f of forms) {
    // Resolve property (match-only; unmatched surfaces for operator triage)
    let match = null;
    if (communityId && f.property_address) {
      try { const m = await resolveProperty(supabase, communityId, f.property_address); if (m && m.id) match = m; } catch (_) {}
    }
    const owner = match ? await ownerOfProperty(match.id) : { contact_id: null, name: null };
    const base = {
      form_type: f.form_type,
      property_address: f.property_address,
      primary_homeowner_name: f.primary_homeowner_name,
      authorized_persons: f.authorized_persons || [],
      season_year: f.season_year,
      extended_hours_detail: f.extended_hours_detail,
      form_signed_date: f.form_signed_date,
      notes: f.notes,
      source_filename: sourceFilename,
      property_id: match ? match.id : null,
      matched_address: match ? `${match.street_address}${match.unit ? ' #' + match.unit : ''}` : null,
      match_confidence: match ? match.match_confidence : null,
      contact_id: owner.contact_id,
      contact_name: owner.name,
      needs_review: !FILEABLE.has(f.form_type) || !match,
    };
    if (f.form_type === 'fob_registration' && Array.isArray(f.fobs) && f.fobs.length) {
      for (const fob of f.fobs) {
        const dup = await activeTagHolder(communityId, fob.tag_number, match ? match.id : null);
        rows.push({ ...base, fob_tag_number: fob.tag_number, fob_issued_to: fob.issued_to || null, dup_active: !!dup, dup_on: dup });
      }
    } else {
      // extended_hours, or a fob form with no tag yet (operator adds it), or unknown
      rows.push({ ...base, fob_tag_number: null, dup_active: false, dup_on: null });
    }
  }
  return rows;
}

// If tag is already active in this community on a DIFFERENT property, return a
// label of who holds it (the reissue/duplicate flag). Same property = fine.
async function activeTagHolder(communityId, tag, propertyId) {
  if (!communityId || !tag) return null;
  const { data } = await supabase
    .from('pool_access')
    .select('property_id, properties(street_address)')
    .eq('community_id', communityId).eq('fob_tag_number', String(tag).trim()).eq('status', 'active').limit(1);
  const row = data && data[0];
  if (!row || row.property_id === propertyId) return null;
  return row.properties ? row.properties.street_address : 'another property';
}

// ----------------------------------------------------------------------------
// POST /ingest — multi-file drag-drop. Stages a 'previewed' batch. No roster
// write until /approve. Field name 'forms' (accepts several files).
// ----------------------------------------------------------------------------
router.post('/ingest', upload.array('forms', 50), async (req, res) => {
  const t0 = Date.now();
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded (expected field "forms")' });
    const communityId = (req.body && req.body.community_id) || null;
    if (!communityId) return res.status(400).json({ error: 'community_id required — pick the community before uploading.' });

    let allForms = [];
    let model = null, anyDegraded = false;
    for (const file of files) {
      if (file.mimetype !== 'application/pdf') {
        allForms.push({ form_type: 'unknown', property_address: null, primary_homeowner_name: null, authorized_persons: [], fobs: [], season_year: null, extended_hours_detail: null, form_signed_date: null, notes: `Unsupported file type ${file.mimetype} — ${file.originalname}`, _source_filename: file.originalname });
        continue;
      }
      // Stash the source PDF for the audit trail (board question -> source form)
      let storagePath = null;
      try {
        const hash = crypto.createHash('sha256').update(file.buffer).digest('hex').slice(0, 16);
        const safeName = (file.originalname || 'pool_form.pdf').replace(/[^a-zA-Z0-9._\-]/g, '_');
        storagePath = `pool_forms/${hash}_${safeName}`;
        await supabase.storage.from('documents').upload(storagePath, file.buffer, { contentType: 'application/pdf', upsert: true });
      } catch (e) { console.warn('[pool_access] storage upload failed (non-fatal):', e.message); storagePath = null; }

      const { forms, model: m, degraded } = await extractPoolForms(file.buffer, file.originalname);
      model = model || m; anyDegraded = anyDegraded || degraded;
      for (const fm of forms) { fm._source_filename = file.originalname; fm._storage_path = storagePath; allForms.push(fm); }
    }

    const rows = await resolveRows(allForms, communityId, null);
    // carry per-form source into rows (resolveRows flattened; re-attach)
    let ri = 0;
    for (const fm of allForms) {
      const count = (fm.form_type === 'fob_registration' && Array.isArray(fm.fobs) && fm.fobs.length) ? fm.fobs.length : 1;
      for (let k = 0; k < count; k++) { if (rows[ri]) { rows[ri].source_filename = fm._source_filename; rows[ri]._storage_path = fm._storage_path; } ri++; }
    }

    const matched = rows.filter((r) => r.property_id && FILEABLE.has(r.form_type)).length;
    const { data: batch, error: bErr } = await supabase
      .from('pool_access_batches')
      .insert({
        community_id: communityId,
        source_filename: files.length === 1 ? files[0].originalname : `${files.length} files`,
        total_forms: rows.length,
        forms_matched: matched,
        forms_unmatched: rows.length - matched,
        status: 'previewed',
        raw_extraction: { rows },
        extraction_model: model,
      })
      .select('id').single();
    if (bErr) throw bErr;

    res.json({
      ok: true,
      batch_id: batch.id,
      total_forms: rows.length,
      forms_matched: matched,
      forms_unmatched: rows.length - matched,
      degraded: anyDegraded,
      rows,
      duration_ms: Date.now() - t0,
    });
  } catch (err) {
    console.error('[pool_access] ingest failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /ingest/:batch_id/approve — commit fileable, matched rows into the
// roster. Unmatched / unknown-type rows are skipped (surfaced in the count).
// ----------------------------------------------------------------------------
router.post('/ingest/:batch_id/approve', express.json(), async (req, res) => {
  try {
    const { data: batch, error: bErr } = await supabase
      .from('pool_access_batches').select('*').eq('id', req.params.batch_id).maybeSingle();
    if (bErr) throw bErr;
    if (!batch) return res.status(404).json({ error: 'batch_not_found' });
    if (batch.status !== 'previewed') return res.status(409).json({ error: `batch already ${batch.status}` });

    const rows = (batch.raw_extraction && Array.isArray(batch.raw_extraction.rows)) ? batch.raw_extraction.rows : [];
    let filed = 0, skipped = 0, superseded = 0;
    for (const r of rows) {
      if (!r.property_id || !FILEABLE.has(r.form_type)) { skipped++; continue; }
      // Reissue: revoke any active grant on this tag (existing OR earlier this
      // batch) so exactly one active row per tag survives. Last write wins.
      if (r.form_type === 'fob_registration' && r.fob_tag_number) {
        const { data: prior } = await supabase
          .from('pool_access').select('id')
          .eq('community_id', batch.community_id).eq('fob_tag_number', String(r.fob_tag_number).trim()).eq('status', 'active');
        for (const p of (prior || [])) {
          await supabase.from('pool_access').update({ status: 'revoked', notes: `Superseded by reissue ${new Date().toISOString().slice(0, 10)}` }).eq('id', p.id);
          superseded++;
        }
      }
      const { error: insErr } = await supabase.from('pool_access').insert({
        community_id: batch.community_id,
        property_id: r.property_id,
        contact_id: r.contact_id || null,
        form_type: r.form_type,
        fob_tag_number: r.fob_tag_number ? String(r.fob_tag_number).trim() : null,
        season_year: r.season_year || null,
        extended_hours_detail: r.extended_hours_detail || null,
        authorized_persons: r.authorized_persons || [],
        form_signed_date: r.form_signed_date || null,
        status: 'active',
        notes: r.notes || null,
        source_batch_id: batch.id,
        source_storage_path: r._storage_path || null,
        source_filename: r.source_filename || null,
        record_ownership: 'association_record',
      });
      if (insErr) { console.warn('[pool_access] insert failed:', insErr.message); skipped++; continue; }
      filed++;
    }
    await supabase.from('pool_access_batches').update({ status: 'approved', approved_at: new Date().toISOString() }).eq('id', batch.id);
    res.json({ ok: true, filed, skipped, superseded });
  } catch (err) {
    console.error('[pool_access] approve failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /ingest/:batch_id/discard
// ----------------------------------------------------------------------------
router.post('/ingest/:batch_id/discard', async (req, res) => {
  try {
    await supabase.from('pool_access_batches').update({ status: 'discarded' }).eq('id', req.params.batch_id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ----------------------------------------------------------------------------
// GET /roster?community_id=&status=active — the tab's main list.
// ----------------------------------------------------------------------------
router.get('/roster', async (req, res) => {
  try {
    const communityId = req.query.community_id;
    if (!communityId) return res.status(400).json({ error: 'community_id required' });
    const status = req.query.status || 'active';
    const rows = await fetchAll(() => {
      let q = supabase.from('pool_access')
        .select('id, form_type, fob_tag_number, season_year, extended_hours_detail, authorized_persons, form_signed_date, status, notes, source_storage_path, source_filename, property_id, contact_id, properties(street_address), contacts(full_name)')
        .eq('community_id', communityId).order('form_type', { ascending: true }).order('fob_tag_number', { ascending: true });
      if (status !== 'all') q = q.eq('status', status);
      return q;
    });
    const flat = rows.map((r) => ({
      id: r.id, form_type: r.form_type, fob_tag_number: r.fob_tag_number, season_year: r.season_year,
      extended_hours_detail: r.extended_hours_detail, authorized_persons: r.authorized_persons || [],
      form_signed_date: r.form_signed_date, status: r.status, notes: r.notes,
      source_storage_path: r.source_storage_path, source_filename: r.source_filename,
      property_id: r.property_id, contact_id: r.contact_id,
      address: r.properties ? r.properties.street_address : null,
      homeowner: r.contacts ? r.contacts.full_name : null,
    }));
    res.json({
      ok: true,
      rows: flat,
      counts: {
        total: flat.length,
        fobs: flat.filter((r) => r.form_type === 'fob_registration').length,
        extended_hours: flat.filter((r) => r.form_type === 'extended_hours').length,
      },
    });
  } catch (err) {
    console.error('[pool_access] roster failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /property/:id — pool access for one property (360 card).
// ----------------------------------------------------------------------------
router.get('/property/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('pool_access')
      .select('id, form_type, fob_tag_number, season_year, extended_hours_detail, authorized_persons, status, form_signed_date, source_storage_path')
      .eq('property_id', req.params.id).order('status', { ascending: true }).limit(200);
    if (error) throw error;
    res.json({ ok: true, rows: data || [] });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ----------------------------------------------------------------------------
// GET /batches?community_id= — upload history.
// ----------------------------------------------------------------------------
router.get('/batches', async (req, res) => {
  try {
    let q = supabase.from('pool_access_batches')
      .select('id, community_id, source_filename, total_forms, forms_matched, forms_unmatched, status, uploaded_at, approved_at')
      .order('uploaded_at', { ascending: false }).limit(100);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ ok: true, batches: data || [] });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ----------------------------------------------------------------------------
// POST /grant — manual single grant (staff enters a fob / extended-hours by
// hand, no form to upload). Body: { community_id, property_id | address,
// form_type, fob_tag_number?, season_year?, extended_hours_detail?,
// authorized_persons?, form_signed_date?, notes? }
// ----------------------------------------------------------------------------
router.post('/grant', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.community_id) return res.status(400).json({ error: 'community_id required' });
    if (!FILEABLE.has(b.form_type)) return res.status(400).json({ error: 'form_type must be fob_registration or extended_hours' });

    let propertyId = b.property_id || null;
    if (!propertyId && b.address) {
      const m = await resolveProperty(supabase, b.community_id, b.address);
      if (m && m.id) propertyId = m.id;
    }
    if (!propertyId) return res.status(400).json({ error: 'could not resolve a property — pass property_id or a matchable address' });
    const owner = await ownerOfProperty(propertyId);

    if (b.form_type === 'fob_registration' && b.fob_tag_number) {
      const { data: prior } = await supabase.from('pool_access').select('id')
        .eq('community_id', b.community_id).eq('fob_tag_number', String(b.fob_tag_number).trim()).eq('status', 'active');
      for (const p of (prior || [])) await supabase.from('pool_access').update({ status: 'revoked', notes: `Superseded by reissue ${new Date().toISOString().slice(0, 10)}` }).eq('id', p.id);
    }
    const { data, error } = await supabase.from('pool_access').insert({
      community_id: b.community_id, property_id: propertyId, contact_id: owner.contact_id,
      form_type: b.form_type, fob_tag_number: b.fob_tag_number ? String(b.fob_tag_number).trim() : null,
      season_year: b.season_year || null, extended_hours_detail: b.extended_hours_detail || null,
      authorized_persons: Array.isArray(b.authorized_persons) ? b.authorized_persons : [],
      form_signed_date: /^\d{4}-\d{2}-\d{2}$/.test(b.form_signed_date || '') ? b.form_signed_date : null,
      status: 'active', notes: b.notes || null, record_ownership: 'association_record',
    }).select('id').single();
    if (error) throw error;
    res.json({ ok: true, id: data.id });
  } catch (err) {
    console.error('[pool_access] grant failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// PATCH /:id — edit status / tag / people / notes (allowedFields only).
// ----------------------------------------------------------------------------
router.patch('/:id', express.json(), async (req, res) => {
  try {
    const allowed = ['status', 'fob_tag_number', 'season_year', 'extended_hours_detail', 'authorized_persons', 'form_signed_date', 'notes'];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    if (patch.status && !['active', 'revoked', 'expired'].includes(patch.status)) return res.status(400).json({ error: 'bad status' });
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'no fields to update' });
    const { error } = await supabase.from('pool_access').update(patch).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[pool_access] patch failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
