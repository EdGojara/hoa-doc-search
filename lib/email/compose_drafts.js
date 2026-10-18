// ============================================================================
// lib/email/compose_drafts.js  (Ed 2026-10-16)
// ----------------------------------------------------------------------------
// The New Email window's drafts, and the agent task that keeps each one visible.
//
// Ed's rule for the AI team: work an agent started that still needs a person
// stays on that agent's to-do list until it is resolved. A drafted email is
// exactly that. So every compose draft is:
//   * a row on the EXISTING draft store, outbound_email_drafts (migration 327),
//     draft_kind = 'compose', status = 'draft' until it is sent or discarded;
//   * a Mission Control task (work_items, via upsertAgentTask) assigned to the
//     agent it is sent as, keyed by source_ref 'compose_draft:<draft id>'. The
//     open-source_ref unique index (migration 513) makes a second open task for
//     the same draft impossible, so reopening or re-saving never duplicates it.
//
// The task closes only when the email is sent (closed_by_evidence, with the sent
// email's id), the draft is discarded, or a person marks it complete in Mission
// Control. Closing the window does neither: the draft and the task stay.
//
// Attachment bytes live in the 'documents' bucket at
// email_outbound_attachments/compose/<draft id>/<timestamp>_<name>; the draft row
// keeps [{ name, storage_path, mime, size }], the descriptor shape the Draft
// Queue send path already attaches. Nothing in this file sends email.
// ============================================================================
'use strict';

const { createClient } = require('@supabase/supabase-js');
const roster = require('../team/roster');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const COMPOSE_KIND = 'compose';
const BUCKET = 'documents';
// No separators or quoting characters: an address is also used inside PostgREST
// filters downstream, where , ( ) are syntax.
const EMAIL_RE = /^[^@\s,;()<>"'`]+@[^@\s,;()<>"'`]+\.[^@\s,;()<>"'`]+$/;
const OPEN = ['new', 'in_progress', 'waiting'];
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 10;
// PDF, Word, Excel (and CSV) and common images. Anything else is refused at upload
// with a reason, never accepted and dropped later.
const ALLOWED_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff'];
const MIME_BY_EXT = {
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
};

const taskRef = (draftId) => `compose_draft:${draftId}`;

function isMissingColumn(err) {
  return !!err && (String(err.code) === '42703' || /column .* does not exist|could not find the .* column|schema cache/i.test(err.message || ''));
}
function httpError(status, code, detail) { return Object.assign(new Error(detail || code), { status, code, detail }); }

/** The agent's name as it appears on Mission Control ("Claire", "Amanda"). */
function agentName(persona) {
  const m = roster.get(String(persona || 'claire').toLowerCase()) || roster.get('claire');
  return String(m.name || 'Claire').split(/\s+/)[0];
}

/**
 * Normalize a recipient list (chips from the UI, or a typed string) into
 * [{ email, name, role, community_name, source }], de-duplicated by address
 * (case-insensitive). `exclude` drops addresses already used elsewhere (To wins
 * over Cc). Returns { list, invalid } so a bad entry is reported, never dropped.
 */
function normalizeRecipients(input, { exclude = [] } = {}) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[,;]/);
  const seen = new Set(exclude.map((e) => String(e).toLowerCase()));
  const list = []; const invalid = [];
  for (const r of raw) {
    const o = typeof r === 'string' ? { email: r } : (r || {});
    const email = String(o.email || '').trim();
    if (!email) continue;
    if (!EMAIL_RE.test(email)) { invalid.push(email); continue; }
    const k = email.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    list.push({ email, name: o.name ? String(o.name).slice(0, 200) : null, role: o.role ? String(o.role).slice(0, 120) : null,
      community_name: o.community_name ? String(o.community_name).slice(0, 200) : null, source: o.source ? String(o.source).slice(0, 40) : null });
  }
  return { list, invalid };
}

/** Restore chips from a draft (compose_state when present, else the to/cc text). */
function chipsFromDraft(d) {
  const st = (d && d.compose_state) || {};
  const to = Array.isArray(st.to) && st.to.length ? st.to : normalizeRecipients(d.to_email).list;
  const cc = Array.isArray(st.cc) && st.cc.length ? st.cc : normalizeRecipients(d.cc).list;
  return { to, cc };
}

function attachmentCheck(name, size, existing = []) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (!ALLOWED_EXT.includes(ext)) return `"${name}" is not a supported file type. Attach a PDF, Word, Excel or image file.`;
  if (size > MAX_FILE_BYTES) return `"${name}" is larger than 15 MB, too big to email.`;
  if (existing.length >= MAX_FILES) return `An email can carry at most ${MAX_FILES} attachments.`;
  const total = existing.reduce((s, a) => s + (Number(a.size) || 0), 0) + size;
  if (total > MAX_TOTAL_BYTES) return `"${name}" would bring the attachments to more than 20 MB, too large for one email.`;
  return null;
}
function safeFileName(name) {
  return String(name || 'attachment').replace(/[^\w.\-() ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'attachment';
}

async function getDraft(id) {
  if (!id || !/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  const { data, error } = await supabase.from('outbound_email_drafts').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data && data.draft_kind === COMPOSE_KIND ? data : null;
}

/** Open compose drafts, newest first (bounded; this is a UI list). */
async function listOpenDrafts({ persona = null, limit = 50 } = {}) {
  let q = supabase.from('outbound_email_drafts')
    .select('id, persona, to_email, to_name, cc, subject, community_id, community_name, attachments, created_at, updated_at, send_error, status')
    .eq('draft_kind', COMPOSE_KIND).eq('status', 'draft').order('updated_at', { ascending: false }).limit(Math.min(limit, 100));
  if (persona) q = q.eq('persona', persona);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

function hasContent(f) {
  return !!(f.to.length || f.cc.length || String(f.subject || '').trim() || String(f.body || '').trim() || String(f.intent || '').trim());
}

/**
 * Create or update a compose draft, then make sure its agent task exists and
 * matches. Returns { draft, task } where task is { id, created, reopened } or
 * { error } when Mission Control could not record it (the caller must show it).
 */
async function saveComposeDraft(input, { actor = 'staff', fromMailbox = null } = {}) {
  const persona = String(input.persona || 'claire').toLowerCase();
  const to = normalizeRecipients(input.to);
  const cc = normalizeRecipients(input.cc, { exclude: to.list.map((r) => r.email) });
  if (to.invalid.length || cc.invalid.length) {
    throw httpError(400, 'invalid_recipient', `Not a valid email address: ${[...to.invalid, ...cc.invalid].join(', ')}`);
  }
  const fields = { to: to.list, cc: cc.list, subject: input.subject, body: input.body, intent: input.intent };
  let existing = null;
  if (input.draft_id) {
    existing = await getDraft(input.draft_id);
    if (!existing) throw httpError(404, 'not_found', 'That draft was not found.');
    if (existing.status !== 'draft') throw httpError(409, `draft_${existing.status}`, existing.status === 'sent' ? 'This email was already sent.' : 'This draft is no longer open.');
  } else if (!hasContent(fields) && !input.for_attachment) {   // a file being attached is content
    throw httpError(400, 'empty_draft', 'Nothing to save yet.');
  }
  const row = {
    persona, from_mailbox: fromMailbox,
    to_email: to.list.map((r) => r.email).join(', '), to_name: (to.list[0] && to.list[0].name) || null,
    cc: cc.list.map((r) => r.email).join(', ') || null,
    subject: String(input.subject || '').trim().slice(0, 500), body_text: String(input.body == null ? '' : input.body),
    community_id: input.community_id || null, community_name: input.community_name ? String(input.community_name).slice(0, 200) : null,
    ai_drafted: !!input.ai_drafted,
    compose_state: { to: to.list, cc: cc.list, intent: input.intent ? String(input.intent).slice(0, 2000) : null,
      source_email_id: input.source_email_id || (existing && existing.compose_state && existing.compose_state.source_email_id) || null },
  };
  let saved;
  if (existing) {
    saved = await writeDraft('update', row, existing.id);
    if (!saved) throw httpError(409, 'draft_not_open', 'This draft was sent or discarded in another window.');
  } else {
    saved = await writeDraft('insert', { ...row, management_company_id: require('../company').BEDROCK_MGMT_CO_ID, draft_kind: COMPOSE_KIND,
      status: 'draft', created_by: actor, disposition: 'needs_review', draft_reason: 'Composed in New Email. Waits for a person to send it.', attachments: [] });
  }
  const task = await syncComposeTask(saved, actor);
  return { draft: saved, task };
}

// Insert/update with the migration-532 columns, retrying without them before 532
// is applied (the draft must never be lost because a column is missing).
async function writeDraft(op, row, id = null) {
  const run = (r) => {
    const q = op === 'insert' ? supabase.from('outbound_email_drafts').insert(r)
      : supabase.from('outbound_email_drafts').update(r).eq('id', id).eq('status', 'draft');
    return q.select('*').maybeSingle();
  };
  let res = await run(row);
  if (res.error && isMissingColumn(res.error)) {
    const { compose_state: _c, work_item_id: _w, ...base } = row;
    console.warn('[compose_drafts] migration 532 not applied; saving without compose_state', JSON.stringify({ op, id }));
    res = await run(base);
  }
  if (res.error) throw res.error;
  return res.data;
}

function taskFields(d, actor) {
  const { to, cc } = chipsFromDraft(d);
  const who = to[0] ? (to[0].name || to[0].email) : 'no recipient yet';
  const more = to.length > 1 ? ` +${to.length - 1}` : '';
  const atts = Array.isArray(d.attachments) ? d.attachments : [];
  const agent = agentName(d.persona);
  const summary = [
    `To: ${to.map((r) => (r.name ? `${r.name} <${r.email}>` : r.email)).join(', ') || '(none yet)'}`,
    cc.length ? `Cc: ${cc.map((r) => (r.name ? `${r.name} <${r.email}>` : r.email)).join(', ')}` : null,
    `Subject: ${d.subject || '(no subject)'}`,
    `Community: ${d.community_name || '(none)'}`,
    atts.length ? `Attachments: ${atts.map((a) => a.name).join(', ')}` : null,
  ].filter(Boolean).join('\n');
  return {
    title: `Email to ${who}${more}: ${d.subject || '(no subject)'}`.slice(0, 300),
    summary, assigned_to: agent, requested_by: actor || agent, item_type: 'email_draft', urgency: 'normal',
    why: `${agent} has a drafted email that has not been sent. It stays on ${agent}'s list until it is sent or discarded.`,
    next_step: 'Open the draft, review it, and send it, or discard it.',
    evidence_required: 'The email is sent from this draft, or the draft is discarded.',
    action_url: `/admin/communications?compose_draft=${d.id}`,
    community_id: d.community_id || null, community_name: d.community_name || null,
    source_ref: taskRef(d.id),
  };
}

async function latestTask(draftId) {
  const { data, error } = await supabase.from('work_items').select('id, status, assigned_to, title, summary, community_id, action_url')
    .eq('source_ref', taskRef(draftId)).order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

async function logEvent(work_item_id, event, actor, detail) {
  const { error } = await supabase.from('work_item_events').insert({ work_item_id, event, actor, detail });
  if (error) console.warn('[compose_drafts] task event not recorded', JSON.stringify({ work_item_id, event, error: error.message }));
}

/**
 * Make the draft's task exist and match it. One task per draft, ever: an open
 * task is updated in place; a task someone closed while the draft is still open
 * is REOPENED rather than duplicated (the draft is still unresolved work).
 */
async function syncComposeTask(d, actor) {
  try {
    const f = taskFields(d, actor);
    const prior = await latestTask(d.id);
    let result;
    if (prior && !OPEN.includes(prior.status)) {
      const { source_ref: _s, ...patch } = f;
      const { error } = await supabase.from('work_items').update({ ...patch, status: 'in_progress', completed_at: null }).eq('id', prior.id);
      if (error) throw error;
      await logEvent(prior.id, 'reopened', actor || 'staff', { reason: 'the draft is still unsent and was edited', draft_id: d.id });
      result = { id: prior.id, created: false, reopened: true };
    } else if (prior && ['title', 'summary', 'assigned_to', 'community_id', 'action_url'].every((k) => (prior[k] ?? null) === (f[k] ?? null))) {
      // Autosave with nothing the task shows changed: no write, no audit noise.
      result = { id: prior.id, created: false, reopened: false };
    } else {
      const { upsertAgentTask } = require('../../api/mission_control');
      const r = await upsertAgentTask(f);
      if (!r) throw new Error('Mission Control did not record the task');
      result = { ...r, reopened: false };
    }
    if (d.work_item_id !== result.id && Object.prototype.hasOwnProperty.call(d, 'work_item_id')) {
      const { error } = await supabase.from('outbound_email_drafts').update({ work_item_id: result.id }).eq('id', d.id);
      if (error) console.warn('[compose_drafts] work_item_id not stamped', JSON.stringify({ draft_id: d.id, error: error.message }));
      else d.work_item_id = result.id;
    }
    return result;
  } catch (e) {
    console.warn('[compose_drafts] agent task not recorded', JSON.stringify({ draft_id: d && d.id, error: e.message }));
    return { error: `The draft is saved, but it could not be added to ${agentName(d && d.persona)}'s to-do list.` };
  }
}

/**
 * Close the draft's task because the draft was resolved: 'sent' (with the sent
 * email's id) or 'discarded'. Only an OPEN task is closed; a task already closed
 * by a person is left as they left it. Never throws.
 */
async function resolveComposeTask(d, { outcome, emailMessageId = null, actor = 'staff' } = {}) {
  try {
    const t = await latestTask(d.id);
    if (!t || !OPEN.includes(t.status)) return { closed: false, id: t ? t.id : null };
    const sent = outcome === 'sent';
    const note = sent ? `Sent by ${actor} on ${new Date().toISOString().slice(0, 10)}.` : `Draft discarded by ${actor}.`;
    const { error } = await supabase.from('work_items').update({ status: sent ? 'done' : 'dismissed', completed_at: new Date().toISOString(), notes: note }).eq('id', t.id).in('status', OPEN);
    if (error) throw error;
    await logEvent(t.id, 'closed_by_evidence', actor, { outcome, draft_id: d.id, email_message_id: emailMessageId });
    return { closed: true, id: t.id };
  } catch (e) {
    console.warn('[compose_drafts] task not closed', JSON.stringify({ draft_id: d && d.id, outcome, error: e.message }));
    return { closed: false, error: e.message };
  }
}

// ---- attachments ------------------------------------------------------------

/**
 * Store an uploaded file with the draft. Bytes go to storage first; the draft's
 * attachment list is then updated with a compare-and-set on updated_at so two
 * uploads can never overwrite each other's entry. If the list update fails the
 * stored object is removed and the error is returned: nothing is half-attached.
 */
async function addAttachment(draftId, file) {
  const d = await getDraft(draftId);
  if (!d) throw httpError(404, 'not_found', 'That draft was not found.');
  if (d.status !== 'draft') throw httpError(409, 'draft_not_open', 'This draft is no longer open.');
  const name = safeFileName(file.originalname);
  const size = file.buffer ? file.buffer.length : 0;
  if (!size) throw httpError(400, 'empty_file', `"${name}" is empty.`);
  const problem = attachmentCheck(name, size, Array.isArray(d.attachments) ? d.attachments : []);
  if (problem) throw httpError(400, 'attachment_refused', problem);
  const ext = name.toLowerCase().split('.').pop();
  const mime = (file.mimetype && file.mimetype !== 'application/octet-stream') ? file.mimetype : (MIME_BY_EXT[ext] || 'application/octet-stream');
  const storage_path = `email_outbound_attachments/compose/${d.id}/${Date.now()}_${name}`;
  const up = await supabase.storage.from(BUCKET).upload(storage_path, file.buffer, { contentType: mime, upsert: false });
  if (up.error) { console.warn('[compose_drafts] attachment upload failed', JSON.stringify({ draft_id: d.id, name, error: up.error.message })); throw httpError(502, 'upload_failed', `"${name}" could not be stored. It is not attached; try again.`); }
  const entry = { name, storage_path, mime, size, uploaded_at: new Date().toISOString() };
  try {
    const next = await casAttachments(d.id, (list) => {
      const p2 = attachmentCheck(name, size, list);
      if (p2) throw httpError(400, 'attachment_refused', p2);
      return [...list, entry];
    });
    return { attachment: entry, attachments: next };
  } catch (e) {
    await supabase.storage.from(BUCKET).remove([storage_path]).catch(() => {});
    throw e.status ? e : httpError(500, 'attach_failed', `"${name}" could not be added to the draft. It is not attached; try again.`);
  }
}

async function removeAttachment(draftId, storagePath) {
  const d = await getDraft(draftId);
  if (!d) throw httpError(404, 'not_found', 'That draft was not found.');
  if (d.status !== 'draft') throw httpError(409, 'draft_not_open', 'This draft is no longer open.');
  if (!(d.attachments || []).some((a) => a.storage_path === storagePath)) throw httpError(404, 'attachment_not_found', 'That attachment is not on this draft.');
  const next = await casAttachments(d.id, (list) => list.filter((a) => a.storage_path !== storagePath));
  const rm = await supabase.storage.from(BUCKET).remove([storagePath]);
  if (rm && rm.error) console.warn('[compose_drafts] removed attachment bytes not deleted', JSON.stringify({ draft_id: d.id, storagePath, error: rm.error.message }));
  return { attachments: next };
}

async function casAttachments(id, change) {
  for (let i = 0; i < 4; i++) {
    const { data: cur, error } = await supabase.from('outbound_email_drafts').select('attachments, updated_at, status').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!cur || cur.status !== 'draft') throw httpError(409, 'draft_not_open', 'This draft is no longer open.');
    const next = change(Array.isArray(cur.attachments) ? cur.attachments : []);
    const { data: upd, error: ue } = await supabase.from('outbound_email_drafts').update({ attachments: next })
      .eq('id', id).eq('status', 'draft').eq('updated_at', cur.updated_at).select('id').maybeSingle();
    if (ue) throw ue;
    if (upd) return next;
  }
  throw httpError(409, 'busy', 'The draft changed while attaching. Try again.');
}

/**
 * Download every stored attachment for the send. ALL or NOTHING: if one file
 * cannot be read the send must stop, because sending without it would be a
 * silently lost attachment. Returns Graph fileAttachment objects.
 */
async function loadAttachmentsForSend(list) {
  const out = []; const failed = [];
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || !a.storage_path) continue;
    try {
      const { data: blob, error } = await supabase.storage.from(a.bucket || BUCKET).download(a.storage_path);
      if (error || !blob) throw new Error(error ? error.message : 'missing');
      const buf = Buffer.from(await blob.arrayBuffer());
      out.push({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.name || 'attachment', contentType: a.mime || 'application/octet-stream', contentBytes: buf.toString('base64') });
    } catch (e) {
      console.warn('[compose_drafts] attachment unreadable at send', JSON.stringify({ storage_path: a.storage_path, error: e.message }));
      failed.push(a.name || a.storage_path);
    }
  }
  if (failed.length) throw httpError(502, 'attachment_unavailable', `Could not load ${failed.join(', ')}. Nothing was sent; the draft is unchanged.`);
  return out;
}

// ---- send claim (exactly once) ----------------------------------------------

/**
 * Claim a draft for sending: draft -> send_requested, compare-and-set on status.
 * Only one caller can win; a double-click or a second tab gets 409. The claim is
 * written BEFORE Graph is called, so a crash mid-send leaves the draft visibly
 * 'send_requested' (its task still open) instead of resending.
 */
async function claimForSend(id, patch = {}) {
  const { data, error } = await supabase.from('outbound_email_drafts')
    .update({ ...patch, status: 'send_requested', send_error: null }).eq('id', id).eq('status', 'draft').eq('draft_kind', COMPOSE_KIND)
    .select('*').maybeSingle();
  if (error) throw error;
  return data || null;
}
async function releaseClaim(id, reason) {
  const { error } = await supabase.from('outbound_email_drafts').update({ status: 'draft', send_error: String(reason || '').slice(0, 1000) }).eq('id', id).eq('status', 'send_requested');
  if (error) console.error('[compose_drafts] claim not released', JSON.stringify({ id, error: error.message }));
}
async function markSent(id, { from, approvedBy, emailMessageId }) {
  const row = { status: 'sent', sent_at: new Date().toISOString(), sent_from: from, approved_by: approvedBy, send_error: null, record_ownership: 'association_record', sent_email_message_id: emailMessageId || null };
  let { error } = await supabase.from('outbound_email_drafts').update(row).eq('id', id);
  if (error && isMissingColumn(error)) { const { sent_email_message_id: _s, ...base } = row; ({ error } = await supabase.from('outbound_email_drafts').update(base).eq('id', id)); }
  if (error) console.error('[compose_drafts] SENT but draft not marked sent', JSON.stringify({ id, error: error.message }));
  return !error;
}

async function discardDraft(id, actor) {
  const d = await getDraft(id);
  if (!d) throw httpError(404, 'not_found', 'That draft was not found.');
  const { data, error } = await supabase.from('outbound_email_drafts').update({ status: 'discarded' }).eq('id', id).eq('status', 'draft').select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw httpError(409, 'not_discardable', 'This draft was already sent or discarded.');
  const task = await resolveComposeTask(d, { outcome: 'discarded', actor });
  return { discarded: true, task };
}

module.exports = {
  COMPOSE_KIND, ALLOWED_EXT, taskRef, agentName, normalizeRecipients, chipsFromDraft, attachmentCheck,
  getDraft, listOpenDrafts, saveComposeDraft, syncComposeTask, resolveComposeTask,
  addAttachment, removeAttachment, loadAttachmentsForSend, claimForSend, releaseClaim, markSent, discardDraft,
  isMissingColumn,
};
