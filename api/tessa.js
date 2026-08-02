// ============================================================================
// api/tessa.js — mounted at /api/tessa. Ed's executive assistant, Tessa McCall.
// ----------------------------------------------------------------------------
// OWNER-ONLY (requireOwner — Ed's email, not merely any admin). Draft an email from a thought, review, send it (as Ed
// or as Tessa), and track Ed's personal follow-ups. Payment items belong to
// Emma, not here — Tessa handles Ed's correspondence + admin/banking/vendor
// chase-ups, not AP.
// ============================================================================
const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { requireOwner } = require('./_require_admin');
const { draftEmail } = require('../lib/ea/tessa');
const { pollTessaInbox } = require('../lib/ea/tessa_inbox');
const { transcribeAudio, routeDictation, sttConfigured } = require('../lib/ea/tessa_voice');
const graphSend = require('../lib/email/graph_send');
const { safeErrorMessage } = require('./_safe_error');

const uploadAudio = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const parseAddrs = (v) => String(v || '').split(/[,;]/).map((s) => s.trim()).filter((s) => EMAIL_RE.test(s));

// Search Tessa's contacts across the saved EA book + vendor reps + per-community
// contacts (bank / attorney / insurance). Returns [{name, org, email, phone,
// role, source}], deduped by email. Shared by /contacts and the voice resolver.
async function searchContacts(q) {
  q = String(q || '').trim();
  const like = `%${q.replace(/[%,]/g, ' ')}%`;
  const out = []; const seen = new Set();
  const add = (c) => { if (!c.email) return; const k = c.email.toLowerCase(); if (seen.has(k)) return; seen.add(k); out.push(c); };
  let eaQ = supabase.from('ea_contacts').select('name, organization, email, phone, role, category, title, responsibilities').limit(40);
  if (q) eaQ = eaQ.or(`name.ilike.${like},organization.ilike.${like},email.ilike.${like},title.ilike.${like}`);
  const { data: ea } = await eaQ;
  for (const c of (ea || [])) add({ name: c.name, org: c.organization, email: c.email, phone: c.phone, role: c.title || c.role || c.category, source: 'address_book' });
  let vQ = supabase.from('vendors').select('name, contact_name, contact_email, email, phone').neq('is_active', false).limit(30);
  if (q) vQ = vQ.or(`name.ilike.${like},contact_name.ilike.${like},contact_email.ilike.${like}`);
  const { data: vs } = await vQ;
  for (const v of (vs || [])) { const em = v.contact_email || v.email; if (em) add({ name: v.contact_name || v.name, org: v.name, email: em, phone: v.phone, role: 'vendor', source: 'vendor' }); }
  let ccQ = supabase.from('community_contacts').select('name, email, phone, category, community:community_id(name)').not('email', 'is', null).limit(30);
  if (q) ccQ = ccQ.or(`name.ilike.${like},category.ilike.${like}`);
  const { data: cc } = await ccQ;
  for (const c of (cc || [])) add({ name: c.name, org: (c.community && c.community.name) || null, email: c.email, phone: c.phone, role: c.category, source: 'community_contact' });
  // Homeowners on file — she can email an owner by name too. (Directory only.)
  if (q) {
    const { data: ho } = await supabase.from('contacts').select('full_name, primary_email').not('primary_email', 'is', null).or(`full_name.ilike.${like},primary_email.ilike.${like}`).limit(20);
    for (const c of (ho || [])) add({ name: c.full_name, org: 'homeowner', email: c.primary_email, role: 'homeowner', source: 'homeowner' });
  }
  // Anyone who has corresponded through the company mailboxes — NAME + ADDRESS
  // only, never message content. Skips no-reply / automated senders. (Ed 2026-08-01.)
  if (q) {
    const { data: em } = await supabase.from('email_messages').select('sender_name, sender_email').not('sender_email', 'is', null).or(`sender_name.ilike.${like},sender_email.ilike.${like}`).order('received_at', { ascending: false }).limit(40);
    for (const e of (em || [])) {
      const addr = e.sender_email;
      if (!addr || /no-?reply|do-?not-?reply|noreply|mailer-daemon|postmaster|notifications?@|@.*(mailchimp|constantcontact|sendgrid|salesforce)/i.test(addr)) continue;
      add({ name: e.sender_name || addr, org: null, email: addr, role: 'from email', source: 'correspondent' });
    }
  }
  return out.slice(0, 50);
}

// Resolve a spoken recipient like "Melody at New First National Bank" to a real
// contact. Splits "<name> at <org>", scores name+org matches, returns the best
// plus a few alternates. { best, matches, hint } — best is null if unsure.
async function resolveRecipient(hint) {
  hint = String(hint || '').trim(); if (!hint) return null;
  const m = hint.match(/^(.+?)\s+(?:at|from|with|@)\s+(.+)$/i);
  const norm = (s) => String(s || '').toLowerCase();
  let cands = [];
  if (m) {
    const name = m[1].trim(), org = m[2].trim();
    const byName = await searchContacts(name);
    const byOrg = await searchContacts(org);
    const pool = [...byName, ...byOrg];
    const seen = new Set();
    for (const c of pool) { const k = norm(c.email); if (k && !seen.has(k)) { seen.add(k); cands.push(c); } }
    cands = cands.map((c) => ({ c, s: (c.org && norm(c.org).includes(norm(org)) ? 2 : 0) + (norm(c.name).includes(norm(name)) ? 1 : 0) }))
      .sort((a, b) => b.s - a.s).map((x) => x.c);
  } else {
    cands = await searchContacts(hint);
  }
  // Only auto-fill To when there's exactly one strong match; otherwise let Ed pick.
  const best = cands.length === 1 ? cands[0] : (cands.length && m ? cands[0] : null);
  return { best, matches: cands.slice(0, 5), hint };
}

// GET /contacts?q= — Tessa's address book search. (Ed 2026-08-01.)
router.get('/contacts', async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try { res.json({ contacts: await searchContacts(req.query.q) }); }
  catch (err) { console.error('[tessa] contacts failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /contacts — save a contact to the EA book (upsert on email) so it resolves
// next time. { name, organization?, email?, phone?, role?, category?, notes? }.
router.post('/contacts', express.json(), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim();
    if (!name) return res.status(400).json({ error: 'name_required', detail: 'A name is required.' });
    if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'bad_email', detail: 'That email doesn\'t look valid.' });
    const row = { name, organization: b.organization || null, email: email || null, phone: b.phone || null, title: b.title || null, category: b.category || null, responsibilities: b.responsibilities || null, notes: b.notes || null, created_by: owner.email || owner.full_name || 'Ed' };
    if (email) {
      const { data: ex } = await supabase.from('ea_contacts').select('id').ilike('email', email).limit(1);
      if (ex && ex.length) { const { data } = await supabase.from('ea_contacts').update(row).eq('id', ex[0].id).select().single(); return res.json({ ok: true, contact: data, updated: true }); }
    }
    const { data, error } = await supabase.from('ea_contacts').insert(row).select().single();
    if (error) throw error;
    res.json({ ok: true, contact: data });
  } catch (err) { console.error('[tessa] add contact failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// GET /contacts/book — the MANAGED address book (ea_contacts only), with ids for
// editing. Separate from /contacts (which resolves across every source). (Ed 2026-08-01.)
router.get('/contacts/book', async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const q = String(req.query.q || '').trim();
    let query = supabase.from('ea_contacts').select('id, name, organization, title, email, phone, category, responsibilities, notes').order('name').limit(500);
    if (q) query = query.or(`name.ilike.%${q}%,organization.ilike.%${q}%,email.ilike.%${q}%,title.ilike.%${q}%`);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ contacts: data || [] });
  } catch (err) { console.error('[tessa] book failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// PATCH /contacts/:id — edit a saved contact.
router.patch('/contacts/:id', express.json(), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const b = req.body || {}; const upd = {};
    for (const f of ['name', 'organization', 'title', 'email', 'phone', 'category', 'responsibilities', 'notes']) if (f in b) upd[f] = (b[f] === '' ? null : b[f]);
    if (upd.email && !EMAIL_RE.test(String(upd.email))) return res.status(400).json({ error: 'bad_email', detail: 'That email doesn\'t look valid.' });
    if (!Object.keys(upd).length) return res.status(400).json({ error: 'nothing_to_update' });
    const { data, error } = await supabase.from('ea_contacts').update(upd).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ ok: true, contact: data });
  } catch (err) { console.error('[tessa] edit contact failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// DELETE /contacts/:id — remove a saved contact.
router.delete('/contacts/:id', async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const { error } = await supabase.from('ea_contacts').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { console.error('[tessa] delete contact failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /draft — turn a thought into a send-ready email (nothing sent).
router.post('/draft', express.json({ limit: '32kb' }), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    const { thought, mode, recipient_name } = req.body || {};
    if (!thought || !String(thought).trim()) return res.status(400).json({ error: 'thought_required' });
    const draft = await draftEmail({ thought, mode: mode === 'ed' ? 'ed' : 'tessa', recipientName: recipient_name || null });
    if (draft.degraded) return res.status(503).json({ error: 'Tessa could not draft this right now. Try again or write it yourself.' });
    res.json({ subject: draft.subject, body: draft.body, mode: draft.mode });
  } catch (err) {
    console.error('[tessa] draft failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /send — send the approved draft, as Ed (ghostwrite) or as Tessa.
router.post('/send', express.json({ limit: '64kb' }), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    if (!graphSend.isConfigured()) return res.status(400).json({ error: 'Email is not connected yet (Microsoft Graph credentials + the mailbox must be set up).' });
    const b = req.body || {};
    const to = parseAddrs(b.to), cc = parseAddrs(b.cc);
    const subject = String(b.subject || '').trim() || '(no subject)';
    const body = String(b.body || '').trim();
    const asEd = String(b.mode || '') === 'ed';
    if (!to.length) return res.status(400).json({ error: 'Add at least one valid recipient.' });
    if (!body) return res.status(400).json({ error: 'The email body is empty.' });

    const from = asEd ? graphSend.ED_MAILBOX : graphSend.TESSA_MAILBOX;
    // As Ed = his own email, no signature block. As Tessa = light branded sign-off.
    let html, attachments;
    if (asEd) {
      html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a2230;">${body.split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px;">${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
    } else {
      ({ html, attachments } = require('../lib/email/tessa_signature').buildTessaEmail(body));
    }
    await graphSend.sendAs({ from, to, cc, subject, html, attachments });

    // Log the outbound (best-effort; a log failure never blocks the send).
    try {
      await supabase.from('email_messages').insert({
        mailbox: from, direction: 'outbound', sender_email: from,
        sender_name: asEd ? 'Ed Gojara' : 'Tessa McCall (Bedrock EA)',
        recipients: [...to, ...cc], subject, body_preview: body.slice(0, 2000),
        classification: 'outbound_reply', classification_confidence: 'high', persona: 'tessa',
        ai_summary: `Tessa sent ${asEd ? 'as Ed' : 'as Tessa'} to ${[...to, ...cc].join(', ')}`,
        triage_status: 'handled', reviewed_at: new Date().toISOString(),
      });
    } catch (e) { console.warn('[tessa] send-log skipped:', e.message); }

    // Optionally spin a follow-up so Tessa can chase it.
    let followup = null;
    if (b.create_followup) {
      const { data } = await supabase.from('ea_followups').insert({
        title: b.followup_title || `Follow up: ${subject}`, detail: b.followup_detail || null,
        category: ['admin', 'banking', 'vendor', 'personal', 'other'].includes(b.followup_category) ? b.followup_category : 'other',
        status: 'waiting', waiting_on: to[0] || null, due_date: b.followup_due_date || null, created_by: 'tessa',
      }).select('id').single();
      followup = data ? data.id : null;
    }
    res.json({ sent: true, from, to, cc, followup_id: followup });
  } catch (err) {
    console.error('[tessa] send failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /voice — Ed dictates; transcribe, then route into an email draft and/or
// follow-up tasks. Nothing is sent or saved; the UI confirms. Owner-only.
router.post('/voice', uploadAudio.single('audio'), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    if (!sttConfigured()) return res.status(400).json({ error: 'Voice is not connected yet (transcription key missing).' });
    if (!req.file || !req.file.buffer || !req.file.buffer.length) return res.status(400).json({ error: 'No audio came through. Try recording again.' });
    let transcript = '';
    try { transcript = await transcribeAudio(req.file.buffer, req.file.mimetype); }
    catch (e) {
      console.error('[tessa] transcribe failed:', e.message, e.detail || '');
      return res.status(502).json({ error: 'Tessa could not hear that clearly. Try again in a quieter spot.' });
    }
    if (!transcript) return res.status(200).json({ transcript: '', summary: '', email: null, tasks: [], note: 'Nothing was picked up.' });
    const routed = await routeDictation(transcript);
    // If she heard "contact <someone>", resolve it to a real address so the UI can
    // read it back and fill To — the "just talk to her" loop. (Ed 2026-08-01.)
    let recipient = null;
    if (routed.email && routed.email.recipient_hint) {
      try { recipient = await resolveRecipient(routed.email.recipient_hint); } catch (_) {}
    }
    res.json({ transcript, summary: routed.summary || '', email: routed.email, tasks: routed.tasks || [], recipient });
  } catch (err) {
    console.error('[tessa] voice failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /followups/bulk — add several follow-ups at once (from a dictation).
router.post('/followups/bulk', express.json({ limit: '32kb' }), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    const items = Array.isArray(req.body && req.body.tasks) ? req.body.tasks : [];
    if (!items.length) return res.status(400).json({ error: 'no_tasks' });
    const cats = ['admin', 'banking', 'vendor', 'personal', 'other'];
    const rows = items.filter((x) => x && x.title && String(x.title).trim()).slice(0, 25).map((x) => ({
      title: String(x.title).trim(), detail: x.detail || null,
      category: cats.includes(x.category) ? x.category : 'other',
      status: x.waiting_on ? 'waiting' : 'open', waiting_on: x.waiting_on || null,
      due_date: x.due_date || null, created_by: 'tessa-voice',
    }));
    if (!rows.length) return res.status(400).json({ error: 'no_valid_tasks' });
    const { data, error } = await supabase.from('ea_followups').insert(rows).select('id');
    if (error) throw error;
    res.json({ added: data ? data.length : 0 });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ---- Follow-up ledger --------------------------------------------------------
router.get('/followups', async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    let q = supabase.from('ea_followups').select('*').order('due_date', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false }).limit(500);
    const status = req.query.status;
    if (status === 'active') q = q.in('status', ['open', 'waiting']);
    else if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ followups: data || [] });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post('/followups', express.json(), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    const b = req.body || {};
    if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'title_required' });
    const { data, error } = await supabase.from('ea_followups').insert({
      title: String(b.title).trim(), detail: b.detail || null,
      category: ['admin', 'banking', 'vendor', 'personal', 'other'].includes(b.category) ? b.category : 'other',
      status: 'open', waiting_on: b.waiting_on || null, due_date: b.due_date || null, created_by: admin.full_name || admin.email || 'Ed',
    }).select('*').single();
    if (error) throw error;
    res.json({ followup: data });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.patch('/followups/:id', express.json(), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    const b = req.body || {}; const patch = {};
    if (b.status !== undefined) { if (!['open', 'waiting', 'done', 'dropped'].includes(b.status)) return res.status(400).json({ error: 'bad_status' }); patch.status = b.status; }
    if (b.category !== undefined) { if (!['admin', 'banking', 'vendor', 'personal', 'other'].includes(b.category)) return res.status(400).json({ error: 'bad_category' }); patch.category = b.category; }
    if (b.title !== undefined) patch.title = String(b.title);
    if (b.detail !== undefined) patch.detail = b.detail || null;
    if (b.waiting_on !== undefined) patch.waiting_on = b.waiting_on || null;
    if (b.due_date !== undefined) patch.due_date = b.due_date || null;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'no_fields' });
    patch.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('ea_followups').update(patch).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json({ followup: data });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ---- Forwarded-inbox: emails Ed sends Tessa, she drafts a reply -------------

// POST /poll-inbox — pull new tessa@ mail, draft a reply for each, queue it.
// Owner-only, and reads ONLY into ea_inbox (never the staff triage table).
router.post('/poll-inbox', async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    const out = await pollTessaInbox({ max: 25, mode: 'ed' });
    if (out.error) {
      const hint = out.error.startsWith('graph_read_failed_403')
        ? 'Tessa can’t read her mailbox yet. In Azure, add tessa@bedrocktx.com to the app’s Mail.Read access policy.'
        : out.error === 'graph_not_configured'
        ? 'Email is not connected yet (Microsoft Graph credentials must be set up).'
        : out.error === 'tessa_mailbox_not_configured'
        ? 'Tessa’s mailbox (TESSA_MAILBOX) is not set in the environment yet.'
        : 'Could not read Tessa’s mailbox right now.';
      return res.status(400).json({ error: hint, code: out.error });
    }
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error('[tessa] poll-inbox failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /inbox — the review queue (defaults to items still needing review).
router.get('/inbox', async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    let q = supabase.from('ea_inbox').select('*').order('received_at', { ascending: false, nullsFirst: false }).limit(200);
    const status = req.query.status || 'needs_review';
    if (status !== 'all') q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ inbox: data || [] });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// PATCH /inbox/:id — edit the draft, or mark replied / dismissed.
router.patch('/inbox/:id', express.json(), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    const b = req.body || {}; const patch = {};
    if (b.status !== undefined) { if (!['needs_review', 'replied', 'dismissed'].includes(b.status)) return res.status(400).json({ error: 'bad_status' }); patch.status = b.status; }
    if (b.draft_subject !== undefined) patch.draft_subject = String(b.draft_subject || '');
    if (b.draft_body !== undefined) patch.draft_body = String(b.draft_body || '');
    if (b.draft_mode !== undefined) { if (!['ed', 'tessa'].includes(b.draft_mode)) return res.status(400).json({ error: 'bad_mode' }); patch.draft_mode = b.draft_mode; }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'no_fields' });
    patch.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('ea_inbox').update(patch).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json({ item: data });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /inbox/:id/send — send the reviewed reply (as Ed or Tessa) + mark replied.
router.post('/inbox/:id/send', express.json({ limit: '64kb' }), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    if (!graphSend.isConfigured()) return res.status(400).json({ error: 'Email is not connected yet (Microsoft Graph credentials + the mailbox must be set up).' });
    const { data: item, error: e0 } = await supabase.from('ea_inbox').select('*').eq('id', req.params.id).single();
    if (e0 || !item) return res.status(404).json({ error: 'not_found' });

    const b = req.body || {};
    const to = parseAddrs(b.to || item.from_email);
    const cc = parseAddrs(b.cc);
    const subject = String(b.subject || item.draft_subject || item.subject || '').trim() || '(no subject)';
    const body = String(b.body || item.draft_body || '').trim();
    const asEd = String(b.mode || item.draft_mode || 'ed') === 'ed';
    if (!to.length) return res.status(400).json({ error: 'No recipient to reply to.' });
    if (!body) return res.status(400).json({ error: 'The reply body is empty.' });

    const from = asEd ? graphSend.ED_MAILBOX : graphSend.TESSA_MAILBOX;
    // As Ed = his own email, no signature block. As Tessa = light branded sign-off.
    let html, attachments;
    if (asEd) {
      html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a2230;">${body.split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px;">${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
    } else {
      ({ html, attachments } = require('../lib/email/tessa_signature').buildTessaEmail(body));
    }
    await graphSend.sendAs({ from, to, cc, subject, html, attachments });

    await supabase.from('ea_inbox').update({ status: 'replied', draft_subject: subject, draft_body: body, draft_mode: asEd ? 'ed' : 'tessa', updated_at: new Date().toISOString() }).eq('id', item.id);
    try {
      await supabase.from('email_messages').insert({
        mailbox: from, direction: 'outbound', sender_email: from,
        sender_name: asEd ? 'Ed Gojara' : 'Tessa McCall (Bedrock EA)',
        recipients: [...to, ...cc], subject, body_preview: body.slice(0, 2000),
        classification: 'outbound_reply', classification_confidence: 'high', persona: 'tessa',
        ai_summary: `Tessa reply ${asEd ? 'as Ed' : 'as Tessa'} to ${[...to, ...cc].join(', ')}`,
        triage_status: 'handled', reviewed_at: new Date().toISOString(),
      });
    } catch (e) { console.warn('[tessa] inbox-send log skipped:', e.message); }
    res.json({ sent: true, from, to, cc });
  } catch (err) {
    console.error('[tessa] inbox-send failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /inbox/:id/handle — "handle this": Ed gives a one-line instruction and
// Tessa drafts the right action (reply to the sender, or forward to someone he
// named), resolving the forward recipient from his address book. Updates the
// stored draft and returns it for review. Nothing is sent here. (Ed 2026-08-01.)
router.post('/inbox/:id/handle', express.json(), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const { data: item, error } = await supabase.from('ea_inbox').select('*').eq('id', req.params.id).single();
    if (error || !item) return res.status(404).json({ error: 'not_found' });
    const instruction = String((req.body && req.body.instruction) || '').trim();
    const mode = (req.body && req.body.mode) === 'ed' ? 'ed' : 'tessa';
    const { handleForwarded } = require('../lib/ea/tessa');
    const d = await handleForwarded({ incomingSubject: item.subject, incomingBody: item.body_full || item.body_preview, fromName: item.from_name || item.from_email, instruction, mode });
    if (!d || d.degraded) return res.status(502).json({ error: 'draft_failed', detail: 'Tessa couldn’t draft that one. Try rephrasing the instruction.' });

    // For a forward, resolve who it goes to from the address book.
    let recipient = null, toEmail = null;
    if (d.action === 'forward' && d.recipient_hint) {
      try { recipient = await resolveRecipient(d.recipient_hint); toEmail = recipient && recipient.best ? recipient.best.email : null; } catch (_) {}
    }
    await supabase.from('ea_inbox').update({ draft_subject: d.subject, draft_body: d.body, draft_mode: d.mode, updated_at: new Date().toISOString() }).eq('id', item.id);
    res.json({ ok: true, action: d.action, subject: d.subject, body: d.body, mode: d.mode, to: toEmail, recipient_hint: d.recipient_hint || null, recipient });
  } catch (err) { console.error('[tessa] inbox handle failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ---- Standing instructions: recurring emails Tessa sends on schedule ---------
const STANDING_FIELDS = ['title', 'recipients_spec', 'to_emails', 'subject', 'body', 'mode', 'freq', 'day_of_week', 'day_of_month', 'active'];

// GET /standing — list Ed's standing instructions.
router.get('/standing', async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const { data, error } = await supabase.from('ea_standing_tasks').select('*').order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    res.json({ tasks: data || [] });
  } catch (err) { console.error('[tessa] standing list failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /standing/draft — turn a thought into a ready subject + body (nothing saved).
router.post('/standing/draft', express.json(), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const thought = String((req.body && req.body.thought) || '').trim();
    if (!thought) return res.status(400).json({ error: 'thought_required' });
    const mode = (req.body && req.body.mode) === 'ed' ? 'ed' : 'tessa';
    const { draftEmail } = require('../lib/ea/tessa');
    const d = await draftEmail({ thought, mode });
    res.json({ ok: true, subject: d.subject, body: d.body, mode });
  } catch (err) { console.error('[tessa] standing draft failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /standing — create a standing instruction.
router.post('/standing', express.json(), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const b = req.body || {};
    if (!String(b.title || '').trim() || !String(b.subject || '').trim() || !String(b.body || '').trim()) return res.status(400).json({ error: 'title_subject_body_required' });
    const freq = ['daily', 'weekly', 'monthly'].includes(b.freq) ? b.freq : 'monthly';
    const row = {
      title: String(b.title).trim(), recipients_spec: b.recipients_spec === 'team' ? 'team' : 'custom',
      to_emails: b.recipients_spec === 'team' ? null : String(b.to_emails || '').trim() || null,
      subject: String(b.subject).trim(), body: String(b.body).trim(), mode: b.mode === 'ed' ? 'ed' : 'tessa',
      freq, day_of_week: freq === 'weekly' ? (Number(b.day_of_week) || 1) : null,
      day_of_month: freq === 'monthly' ? Math.min(28, Math.max(1, Number(b.day_of_month) || 1)) : null,
      active: b.active !== false, created_by: owner.email || 'Ed',
    };
    const { data, error } = await supabase.from('ea_standing_tasks').insert(row).select().single();
    if (error) throw error;
    res.json({ ok: true, task: data });
  } catch (err) { console.error('[tessa] standing create failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// PATCH /standing/:id — edit / pause / resume.
router.patch('/standing/:id', express.json(), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const b = req.body || {}; const upd = {};
    for (const f of STANDING_FIELDS) if (f in b) upd[f] = b[f];
    if ('day_of_month' in upd && upd.day_of_month != null) upd.day_of_month = Math.min(28, Math.max(1, Number(upd.day_of_month) || 1));
    if (!Object.keys(upd).length) return res.status(400).json({ error: 'nothing_to_update' });
    const { data, error } = await supabase.from('ea_standing_tasks').update(upd).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ ok: true, task: data });
  } catch (err) { console.error('[tessa] standing patch failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// DELETE /standing/:id
router.delete('/standing/:id', async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try { const { error } = await supabase.from('ea_standing_tasks').delete().eq('id', req.params.id); if (error) throw error; res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /standing/:id/run-now — send it now to test (ignores the schedule).
router.post('/standing/:id/run-now', express.json(), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    if (!graphSend.isConfigured()) return res.status(400).json({ error: 'email_not_connected' });
    const { runTaskNow } = require('../lib/ea/tessa_standing');
    const out = await runTaskNow(req.params.id);
    if (!out.sent) return res.status(400).json({ error: out.reason || 'not_sent', detail: out.reason === 'no_recipients' ? 'No valid recipients on this task.' : 'Could not send.' });
    res.json({ ok: true, to: out.to });
  } catch (err) { console.error('[tessa] standing run-now failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

module.exports = { router };
