// ===========================================================================
// record_lifecycle.js  (Ed 2026-07-18)
// ---------------------------------------------------------------------------
// The "Finalize & Archive / Reopen" lifecycle for governance documents (board
// packets, meeting minutes, and future types). Mounted at /api/records.
//
//   POST /:type/:id/finalize  — staff+: locks the doc, seals an immutable
//                               hash-verified copy (version N+1), logs it.
//   POST /:type/:id/reopen    — ADMIN ONLY (Ed): returns it to draft so it can
//                               be edited + re-finalized; requires a reason;
//                               logged. Sealed versions are NEVER destroyed.
//   GET  /:type/:id/history   — the finalize/reopen audit trail + sealed
//                               versions, for the UI lock panel.
//
// Reopen is deliberately gated to role='admin' — that's the owner control Ed
// asked for. A re-finalize seals version N+1; the prior sealed version stands.
// ===========================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { sealFinalizedRecord } = require('../lib/record_archive');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Per-type config. resolvePdf returns { bucket, path } for the current render.
const TYPES = {
  board_packet: {
    table: 'board_packets',
    statusField: 'status',
    reopenStatus: 'in_review',
    resolvePdf: (row) => (row.rendered_pdf_path ? { bucket: 'documents', path: row.rendered_pdf_path } : null),
  },
  minutes: {
    table: 'meeting_minutes',
    statusField: 'status',
    reopenStatus: 'draft',
    resolvePdf: async (row) => {
      if (!row.rendered_document_id) return null;
      const { data: doc } = await supabase.from('library_documents').select('storage_path').eq('id', row.rendered_document_id).maybeSingle();
      return doc && doc.storage_path ? { bucket: 'documents', path: doc.storage_path } : null;
    },
  },
};

async function loadRow(cfg, id) {
  const { data, error } = await supabase.from(cfg.table).select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

// POST /api/records/:type/:id/finalize
router.post('/:type/:id/finalize', express.json(), async (req, res) => {
  try {
    const cfg = TYPES[req.params.type];
    if (!cfg) return res.status(400).json({ error: 'unknown record type' });
    const { resolveUserRole } = require('./users');
    const ctx = await resolveUserRole(req);
    if (!ctx.supabaseUserId) return res.status(401).json({ error: 'authentication required' });

    const row = await loadRow(cfg, req.params.id);
    if (!row) return res.status(404).json({ error: 'record not found' });
    if (row[cfg.statusField] === 'final') return res.status(409).json({ error: 'already finalized — reopen it first to make changes' });

    const pdf = typeof cfg.resolvePdf === 'function' ? await cfg.resolvePdf(row) : null;
    if (!pdf || !pdf.path) return res.status(422).json({ error: 'nothing to finalize — render the document first' });

    const version = (Number(row.finalized_version) || 0) + 1;
    const archivePath = `${req.params.type}/${row.community_id || 'unknown'}/${row.id}-v${version}.pdf`;
    const sealed = await sealFinalizedRecord(supabase, {
      record_type: req.params.type, record_id: row.id, community_id: row.community_id || null,
      archive_path: archivePath, source_bucket: pdf.bucket, source_path: pdf.path,
      sent_at: new Date().toISOString(), metadata: { version, finalized_by: ctx.user && ctx.user.email },
    });
    if (!sealed) return res.status(500).json({ error: 'could not seal the document — finalize aborted' });

    const patch = { [cfg.statusField]: 'final', finalized_version: version, finalized_at: new Date().toISOString(), finalized_by: ctx.supabaseUserId };
    const { error: upErr } = await supabase.from(cfg.table).update(patch).eq('id', row.id);
    if (upErr) return res.status(500).json({ error: 'finalize save failed: ' + upErr.message });

    await supabase.from('record_finalization_log').insert({
      record_type: req.params.type, record_id: row.id, community_id: row.community_id || null,
      action: 'finalize', version, archive_path: sealed.archive_path, sha256: sealed.sha256,
      actor_user_id: ctx.supabaseUserId, actor_email: ctx.user && ctx.user.email || null,
    });

    res.json({ ok: true, status: 'final', version, archive_path: sealed.archive_path, sha256: sealed.sha256 });
  } catch (err) {
    console.error('[record-lifecycle.finalize]', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /api/records/:type/:id/reopen  — ADMIN ONLY
router.post('/:type/:id/reopen', express.json(), async (req, res) => {
  try {
    const cfg = TYPES[req.params.type];
    if (!cfg) return res.status(400).json({ error: 'unknown record type' });
    const { resolveUserRole } = require('./users');
    const ctx = await resolveUserRole(req);
    if (!ctx.supabaseUserId) return res.status(401).json({ error: 'authentication required' });
    // Owner control: only an admin can reopen a finalized record.
    if (ctx.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can reopen a finalized document. Ask the owner to reopen it.' });
    }
    const reason = (req.body && String(req.body.reason || '').trim()) || null;
    if (!reason) return res.status(400).json({ error: 'a reason is required to reopen a finalized document' });

    const row = await loadRow(cfg, req.params.id);
    if (!row) return res.status(404).json({ error: 'record not found' });
    if (row[cfg.statusField] !== 'final') return res.status(409).json({ error: 'record is not finalized' });

    const { error: upErr } = await supabase.from(cfg.table).update({ [cfg.statusField]: cfg.reopenStatus }).eq('id', row.id);
    if (upErr) return res.status(500).json({ error: 'reopen failed: ' + upErr.message });

    await supabase.from('record_finalization_log').insert({
      record_type: req.params.type, record_id: row.id, community_id: row.community_id || null,
      action: 'reopen', version: row.finalized_version || null,
      actor_user_id: ctx.supabaseUserId, actor_email: ctx.user && ctx.user.email || null, reason,
    });

    // Note: the sealed version(s) stay in the archive — reopening never deletes
    // the record of what was finalized. A re-finalize seals the next version.
    res.json({ ok: true, status: cfg.reopenStatus, reopened_by: ctx.user && ctx.user.email });
  } catch (err) {
    console.error('[record-lifecycle.reopen]', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /api/records/:type/:id/history — audit trail for the lock panel
router.get('/:type/:id/history', async (req, res) => {
  try {
    if (!TYPES[req.params.type]) return res.status(400).json({ error: 'unknown record type' });
    const { data, error } = await supabase
      .from('record_finalization_log')
      .select('action, version, archive_path, sha256, actor_email, reason, created_at')
      .eq('record_type', req.params.type).eq('record_id', req.params.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ events: data || [] });
  } catch (err) {
    console.error('[record-lifecycle.history]', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
