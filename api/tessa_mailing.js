'use strict';
// ============================================================================
// api/tessa_mailing.js  (Ed 2026-10-19) — the staff side of an IRS mailing task
// ----------------------------------------------------------------------------
// When Ed assigns a staff member to print and mail a verified, filed return,
// that person gets a Mission Control task whose "Open" link is /app/irs-mailing.
// These routes give the ASSIGNED person (or Ed), and nobody else:
//   GET  /:taskId            the instructions, and the document's title
//   GET  /:taskId/document   the one document linked to that task (audited)
//   POST /:taskId/confirm    the mailing record: date, method, tracking number
// Never Ed's correspondence: the delegation's emails stay in Tessa's owner-only
// store and are not read here. Closing the task in Mission Control is NOT a
// confirmation; only POST /confirm (validated in lib/ea/delegation.js) is.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireStaff, OWNER_EMAIL } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const REF = /^tessa:delegation:([0-9a-f-]{36}):mail$/i;

const isOwner = (u) => !!(u && u.role === 'admin' && String(u.email || '').toLowerCase() === String(OWNER_EMAIL).toLowerCase());
const who = (u) => u.full_name || u.email;
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// The task, its delegation, and whether this user may handle it. Errors are explicit.
async function load(req, res) {
  const u = await requireStaff(req, res); if (!u) return null;
  const { data: task, error } = await supabase.from('work_items').select('id, title, status, assigned_to, community_id, library_document_id, source_ref, next_step, evidence_required, why, sla_due_at').eq('id', req.params.taskId).maybeSingle();
  if (error) { console.error('[tessa_mailing] task lookup failed:', error.message); res.status(500).json({ error: safeErrorMessage(error) }); return null; }
  const m = task && REF.exec(String(task.source_ref || ''));
  if (!task || !m) { res.status(404).json({ error: 'not_found' }); return null; }
  if (!isOwner(u) && !same(task.assigned_to, u.full_name) && !same(task.assigned_to, u.email)) {
    res.status(403).json({ error: 'not_assignee', detail: `This mailing is assigned to ${task.assigned_to}.` }); return null;
  }
  const { data: d, error: de } = await supabase.from('ea_followups').select('id, steps, community_id').eq('id', m[1]).maybeSingle();
  if (de) { console.error('[tessa_mailing] delegation lookup failed:', de.message); res.status(/does not exist|schema cache/i.test(de.message) ? 409 : 500).json({ error: /does not exist|schema cache/i.test(de.message) ? 'migration_537_required' : safeErrorMessage(de) }); return null; }
  if (!d || !d.steps) { res.status(404).json({ error: 'not_found' }); return null; }
  return { u, task, d };
}

router.get('/:taskId', async (req, res) => {
  const ctx = await load(req, res); if (!ctx) return;
  const { task, d } = ctx;
  const { data: doc } = task.library_document_id ? await supabase.from('library_documents').select('id, title').eq('id', task.library_document_id).maybeSingle() : { data: null };
  const { MAIL_METHODS } = require('../lib/ea/delegation');
  res.json({
    task: { id: task.id, title: task.title, status: task.status, assigned_to: task.assigned_to, next_step: task.next_step, evidence_required: task.evidence_required, why: task.why, due: task.sla_due_at },
    document: doc ? { title: doc.title } : null,
    mailed: d.steps.mailed && d.steps.mailed.state === 'confirmed_by_staff' ? d.steps.mailed : null,
    methods: Object.entries(MAIL_METHODS).map(([k, v]) => ({ value: k, label: v.label, tracked: v.tracked })).sort((a, b) => a.label.localeCompare(b.label)),
  });
});

router.get('/:taskId/document', async (req, res) => {
  const ctx = await load(req, res); if (!ctx) return;
  const { u, task, d } = ctx;
  try {
    if (!task.library_document_id || task.library_document_id !== (d.steps.filed && d.steps.filed.library_document_id)) return res.status(409).json({ error: 'document_mismatch', detail: 'This task is not linked to the filed return.' });
    const { data: doc, error } = await supabase.from('library_documents').select('file_path, file_name_normalized, file_hash').eq('id', task.library_document_id).maybeSingle();
    if (error) throw error;
    if (!doc || !doc.file_path) return res.status(404).json({ error: 'document_unavailable', detail: 'The filed return could not be found. Tell Ed.' });
    const { data: blob, error: se } = await supabase.storage.from('documents').download(doc.file_path);
    if (se || !blob) return res.status(502).json({ error: 'document_unavailable', detail: 'The filed return could not be opened right now. Try again, or tell Ed.' });
    const { recordEvent } = require('../lib/ea/delegation_store');
    await recordEvent(supabase, d.id, 'document_opened', who(u), { work_item_id: task.id, library_document_id: task.library_document_id, file_hash: doc.file_hash || null });
    const buf = Buffer.from(await blob.arrayBuffer());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${String(doc.file_name_normalized || 'return.pdf').replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) { console.error('[tessa_mailing] document failed:', e.message); res.status(500).json({ error: safeErrorMessage(e) }); }
});

router.post('/:taskId/confirm', express.json({ limit: '8kb' }), async (req, res) => {
  const ctx = await load(req, res); if (!ctx) return;
  const { u, task, d } = ctx;
  try {
    const D = require('../lib/ea/delegation');
    const S = require('../lib/ea/delegation_store');
    let steps;
    try { steps = D.applyMailingConfirmed(d.steps, { record: req.body || {}, by: who(u), isOwner: isOwner(u) }); }
    catch (e) { return res.status(e.code === 'not_assignee' ? 403 : e.code === 'already_mailed' ? 409 : 400).json({ error: e.code || 'bad_request', detail: e.message, errors: e.errors || undefined }); }
    const rec = steps.mailed;
    // Audit first: if it does not save, the mailing is not confirmed.
    await S.recordEvent(supabase, d.id, 'mailing_confirmed', who(u), { work_item_id: task.id, mailed_on: rec.mailed_on, method: rec.method, tracking_number: rec.tracking_number, notes: rec.notes, library_document_id: task.library_document_id });
    await S.saveSteps(supabase, d, steps);
    const summary = `Mailed ${rec.mailed_on} by ${who(u)}, ${rec.method_label}${rec.tracking_number ? ` #${rec.tracking_number}` : ''}.${rec.notes ? ' ' + rec.notes : ''}`;
    const { error: we } = await supabase.from('work_items').update({ status: 'done', completed_at: new Date().toISOString(), notes: summary }).eq('id', task.id);
    const { error: ee } = await supabase.from('work_item_events').insert({ work_item_id: task.id, event: 'closed_by_evidence', actor: who(u), detail: { mailed_on: rec.mailed_on, method: rec.method, tracking_number: rec.tracking_number } });
    if (we || ee) console.warn('[tessa_mailing] mailing recorded but task not closed', JSON.stringify({ task: task.id, error: (we || ee).message }));
    res.json({ ok: true, mailed: rec, task_closed: !(we || ee), ...(we || ee ? { warning: 'The mailing is recorded, but the Mission Control task could not be closed. Close it by hand.' } : {}) });
  } catch (e) { console.error('[tessa_mailing] confirm failed:', e.message); res.status(500).json({ error: safeErrorMessage(e) }); }
});

module.exports = { router };
