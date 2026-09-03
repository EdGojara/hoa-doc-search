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
// Does this contact GENUINELY match what Ed said, or did the hint just happen
// to appear inside a domain name?
//
// Ed 2026-08-21 asked Tessa to "copy ed and martha" and she came back asking
// which of five people he meant, offering Hope Lloyd, HomeWiseDocs and a
// RealPage rep. The query is an ILIKE %ed% across name, organization, email
// and title, and "ed" appears inside b-ed-rocktx.com, homewis-ed-ocs.com,
// f-ed-ex.com, inde-ed-email.com and the word "B-ed-rock" itself. 96 of 539
// contacts "matched".
//
// So the database query stays broad (it is one indexed round trip) and this
// decides what actually counts:
//
//   - the DOMAIN half of an email never counts. Nobody searches for a person
//     by their mail provider, and it is the single biggest source of noise.
//   - a SHORT hint (under 4 characters) must match a whole word. "ed" matches
//     "Ed Gojara" and "Ed Hyde", not "Bedrock" or "Teddy".
//   - a longer hint may match anywhere, which is what makes "waterv" or
//     "protect" useful.
function contactMatchesHint(c, q) {
  const hint = String(q || '').toLowerCase().trim();
  if (!hint) return true;
  const local = String(c.email || '').toLowerCase().split('@')[0];
  const fields = [c.name, c.org, c.role, local].map((s) => String(s || '').toLowerCase());

  if (hint.length >= 4) return fields.some((f) => f.includes(hint));

  // Whole-word match for short hints. Split on anything that is not a letter
  // or digit so "ed.gojara", "ed-gojara" and "Ed Gojara" all tokenise the same.
  const esc = hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`);
  return fields.some((f) => re.test(f));
}

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
  // Drop the coincidences before ranking. See contactMatchesHint above.
  const real = out.filter((c) => contactMatchesHint(c, q));
  // If filtering leaves nothing but the broad query found something, the hint
  // is probably a fragment worth showing rather than a dead end.
  return (real.length ? real : out).slice(0, 50);
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

// GET /mail-search?q= — Tessa searches ED'S OWN mailbox, live. (Ed 2026-08-18.)
//
// Ed: "is there a way tessa can have access to my email history and addresses
// so she can look up in search — i tried to search ramsey but she couldn't find
// it." She could not, because searchContacts reads email_messages and Ed's
// mailbox has never been ingested into it.
//
// The tempting fix is to point the ingest at egojara@. That is the wrong one:
// it copies Ed's entire correspondence into the shared Communications table
// that every staff surface reads. Tessa is owner-only ("tessa only works for
// me, no one else here") and this keeps that true — the search runs against the
// live mailbox at request time and stores nothing, so there is no second copy
// to leak from.
router.get('/mail-search', async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q_required' });
    const { searchMailbox, contactsFromMessages } = require('../lib/email/graph_search');
    const r = await searchMailbox(graphSend.ED_MAILBOX, q, { top: Math.min(Number(req.query.top) || 25, 50) });
    res.json({ ok: true, query: r.query, count: r.count, messages: r.messages, people: contactsFromMessages(r.messages) });
  } catch (err) {
    // The tenant can block app-only access per mailbox (Exchange
    // ApplicationAccessPolicy). That is a configuration answer, not a bug, and
    // it must not read as "no results" — which is exactly how it would look if
    // this returned an empty list. (Ed 2026-08-18: egojara@ is blocked while
    // info@ and tessa@ are allowed.)
    if (/AppOnly AccessPolicy|Access to OData is disabled|RAOP/i.test(String(err.message))) {
      return res.status(403).json({
        error: 'mailbox_not_permitted',
        detail: "Microsoft 365 is blocking app access to this mailbox. Add it to the Exchange ApplicationAccessPolicy for the trustEd app registration, then try again.",
      });
    }
    console.error('[tessa] mail search failed:', err.message);
    res.status(500).json({ error: 'mail_search_failed' });
  }
});

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
    // Ed typed or dictated this, so the content came from him and she is
    // PERMITTED to say so. She still decides whether the reader needs telling;
    // a note that stands on its own does not get an 'Ed asked me to' opener.
    const draft = await draftEmail({ thought, mode: 'tessa', recipientName: recipient_name || null, onEdsBehalf: true });
    if (draft.degraded) return res.status(503).json({ error: 'Tessa could not draft this right now. Try again or write it yourself.' });
    res.json({ subject: draft.subject, body: draft.body, mode: draft.mode });
  } catch (err) {
    console.error('[tessa] draft failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /request — the one box. Ed says what he wants; Tessa works out who,
// looks the thread up in his own mailbox, and comes back with a draft.
//
// Ed 2026-08-21: "tessa please send email to canyon gate board and ask if they
// want us to set up a follow up virtual meeting with security company the one
// with Grant as the contact."
//
// NOTHING IS SENT HERE. This returns a draft plus the resolved recipients and
// any questions she has. Ed reviews, then POSTs /send. Booking a meeting is a
// separate deliberate call to /meeting for the same reason: both put mail in
// real board members' inboxes, so Ed clicking IS the approval.
router.post('/request', express.json({ limit: '16kb' }), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const text = String((req.body || {}).request || '').trim();
    if (!text) return res.status(400).json({ error: 'request_required', detail: 'Tell Tessa what you need.' });

    const { runRequest } = require('../lib/ea/tessa_request');
    const { searchMailbox } = require('../lib/email/graph_search');
    // Ed's own mailbox first (his inbox AND sent items — Graph /messages spans
    // both), then Tessa's, which holds anything he forwarded her.
    const mailboxes = graphSend.isConfigured()
      ? [graphSend.ED_MAILBOX, graphSend.TESSA_MAILBOX].filter(Boolean)
      : [];

    const out = await runRequest(text, { resolveRecipient, searchMailbox, mailboxes });
    if (out.degraded) return res.status(503).json({ error: 'Tessa could not work that one out. Try saying it a different way.' });

    res.json({
      ok: true,
      request: text,
      instruction: out.parsed.instruction,
      to: out.to, cc: out.cc, mentions: out.mentions,
      questions: out.questions,
      draft: out.draft,
      context: out.context,
      context_errors: out.context_errors,
      wants_meeting: out.wants_meeting,
      resolved: out.resolved,
    });
  } catch (err) {
    console.error('[tessa] request failed:', err.message);
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
    const asEd = false;  // Tessa sends as herself, always.
    if (!to.length) return res.status(400).json({ error: 'Add at least one valid recipient.' });
    if (!body) return res.status(400).json({ error: 'The email body is empty.' });

    const from = asEd ? graphSend.ED_MAILBOX : graphSend.TESSA_MAILBOX;
    // As Ed = his own email, no signature block. As Tessa = light branded sign-off.
    let html, attachments;
    if (asEd) {
      html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a2230;">${body.split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px;">${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
    } else {
      // A NEW email has no original to quote. The reply path
      // (/inbox/:id/send) quotes the incoming thread; this one composes from
      // scratch, so there is nothing to attach.
      //
      // SCAR: this handler carried a copy of the reply path's quoting block,
      // which referenced `item` — a variable that only exists in the reply
      // handler. asEd is always false so the else branch ALWAYS ran, meaning
      // every send threw ReferenceError and returned a generic 500. The Send
      // button looked like it simply did nothing. (Found 2026-08-21.)
      ({ html, attachments } = require('../lib/email/tessa_signature').buildTessaEmail(body, null, null));
    }
    await graphSend.sendAs({ from, to, cc, subject, html, attachments });

    // Log the outbound (best-effort; a log failure never blocks the send).
    try {
      await supabase.from('email_messages').insert({
        mailbox: from, direction: 'outbound', sender_email: from,
        sender_name: asEd ? 'Ed Gojara' : 'Tessa McCall (Bedrock EA)',
        // body_full, not just the preview: what Tessa sent on Ed's behalf has to
        // be readable in full afterwards, or the record of his own
        // correspondence is a 2,000-character stub. (Ed 2026-08-20.)
        recipients: [...to, ...cc], subject, body_preview: body.slice(0, 2000), body_full: body,
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

// POST /meeting — Tessa books a Teams meeting on Ed's calendar and invites the
// room. Returns the join link so it can go straight into the email that follows.
//
// Owner-gated, and deliberately NOT reachable from the mail pipeline: booking
// mails an invitation to real board members and a real vendor, so Ed calling
// this IS the approval. Tessa never books because an email told her to.
//
// Times are LOCAL WALL TIMES plus a zone ("2026-08-25T14:00:00" + Central).
// A bare date or an absolute timestamp is refused rather than reinterpreted —
// see the election-date scar in CLAUDE.md.
router.post('/meeting', express.json({ limit: '32kb' }), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    if (!graphSend.isConfigured()) {
      return res.status(400).json({ error: 'Email and calendar are not connected yet (Microsoft Graph credentials must be set up).' });
    }
    const b = req.body || {};
    const attendees = parseAddrs([].concat(b.attendees || [], b.to || []).join(','));
    if (!b.subject || !String(b.subject).trim()) return res.status(400).json({ error: 'Give the meeting a subject.' });
    if (!b.start || !b.end) return res.status(400).json({ error: 'Give the meeting a start and end time.' });

    const { createTeamsMeeting } = require('../lib/ea/tessa_meeting');
    const meeting = await createTeamsMeeting({
      organizer: b.organizer || graphSend.ED_MAILBOX,
      subject: String(b.subject).trim(),
      start: b.start, end: b.end,
      timeZone: b.time_zone || undefined,
      attendees,
      body: String(b.body || b.agenda || ''),
      optionalAttendees: !!b.optional,
      location: b.location || null,
    });

    // A booking with no join link is a calendar block whose invitation says
    // Teams and links nowhere. Say so instead of reporting a clean success.
    if (meeting.warning) console.warn('[tessa] meeting booked without a join link:', meeting.warning);
    console.log('[tessa] booked "' + meeting.subject + '" for ' + attendees.length + ' attendee(s)');
    res.json({ booked: true, ...meeting });
  } catch (err) {
    console.error('[tessa] meeting failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// DELETE /meeting/:id — call it off. Graph notifies whoever was invited.
router.delete('/meeting/:id', async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    const { cancelMeeting } = require('../lib/ea/tessa_meeting');
    const out = await cancelMeeting({
      organizer: req.query.organizer || graphSend.ED_MAILBOX,
      eventId: req.params.id,
      comment: String(req.query.comment || ''),
    });
    res.json(out);
  } catch (err) {
    console.error('[tessa] meeting cancel failed:', err.message);
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
    const out = await pollTessaInbox({ max: 25, mode: 'tessa' });
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
    // Tell the screen exactly where a reply would land, both ways.
    //
    // Ed 2026-08-21: "how do i know tessa is replying to all or just sender?"
    // He could not: the reply box showed one unlabelled address and no Cc field.
    // Computing this server-side means the label and the actual send agree,
    // rather than the UI guessing.
    const { replyOptions, describeRecipients } = require('../lib/ea/tessa_reply_recipients');
    const inbox = (data || []).map((item) => {
      const opts = replyOptions(item, graphSend);
      return {
        ...item,
        reply_to_sender: opts.sender,
        reply_to_all: opts.all,
        reply_recipients_known: opts.known,
        reply_others_count: opts.others,
        reply_sender_label: describeRecipients('sender', opts),
        reply_all_label: opts.all ? describeRecipients('all', opts) : null,
      };
    });
    res.json({ inbox });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// GET /sent — mail Tessa has actually sent (as Ed or as Tessa). Logged to
// email_messages on every /send. Owner-only. (Ed 2026-08-10 — "how do I see
// Tessa's sent mail".)
router.get('/sent', async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const { data, error } = await supabase.from('email_messages')
      .select('id, mailbox, sender_name, recipients, subject, body_preview, ai_summary, created_at')
      .eq('persona', 'tessa').eq('direction', 'outbound')
      .order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    const ed = graphSend.ED_MAILBOX;
    res.json({ sent: (data || []).map((m) => ({ ...m, as_ed: m.mailbox === ed })) });
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
    // replySubject() never produces "Re: (none)". Martha got exactly that,
    // because the placeholder the screen uses for a blank subject was being
    // sent as if it were one. (Ed 2026-08-20.)
    const { quotedOriginal, replySubject } = require('../lib/email/quote_original');
    const subject = String(b.subject || item.draft_subject || '').trim()
      || replySubject(item.subject);
    const body = String(b.body || item.draft_body || '').trim();
    const asEd = false;  // Tessa sends as herself, always.
    if (!to.length) return res.status(400).json({ error: 'No recipient to reply to.' });
    if (!body) return res.status(400).json({ error: 'The reply body is empty.' });

    const from = asEd ? graphSend.ED_MAILBOX : graphSend.TESSA_MAILBOX;
    // As Ed = his own email, no signature block. As Tessa = light branded sign-off.
    let html, attachments;
    if (asEd) {
      html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a2230;">${body.split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px;">${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
    } else {
      // The thread goes out with the reply. Without it the recipient gets a
      // sentence with no context, which is both unhelpful and the clearest
      // tell that nobody read what they wrote.
      const quoted = quotedOriginal({
        fromName: item.from_name, fromEmail: item.from_email,
        sentAt: item.received_at, to: 'Tessa McCall',
        subject: item.subject,
        bodyText: item.body_full || item.body_preview,
      });
      ({ html, attachments } = require('../lib/email/tessa_signature').buildTessaEmail(body, null, quoted));
    }
    await graphSend.sendAs({ from, to, cc, subject, html, attachments });

    await supabase.from('ea_inbox').update({ status: 'replied', draft_subject: subject, draft_body: body, draft_mode: asEd ? 'ed' : 'tessa', updated_at: new Date().toISOString() }).eq('id', item.id);
    try {
      await supabase.from('email_messages').insert({
        mailbox: from, direction: 'outbound', sender_email: from,
        sender_name: asEd ? 'Ed Gojara' : 'Tessa McCall (Bedrock EA)',
        // body_full, not just the preview: what Tessa sent on Ed's behalf has to
        // be readable in full afterwards, or the record of his own
        // correspondence is a 2,000-character stub. (Ed 2026-08-20.)
        recipients: [...to, ...cc], subject, body_preview: body.slice(0, 2000), body_full: body,
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
    const mode = 'tessa';   // she always sends as herself
    const { handleForwarded } = require('../lib/ea/tessa');
    const d = await handleForwarded({ incomingSubject: item.subject, incomingBody: item.body_full || item.body_preview, fromName: item.from_name || item.from_email, instruction, mode });
    if (!d || d.degraded) return res.status(502).json({ error: 'draft_failed', detail: 'Tessa couldn’t draft that one. Try rephrasing the instruction.' });

    // For a forward, resolve who it goes to from the address book.
    let recipient = null, toEmail = null;
    if (d.action === 'forward' && d.recipient_hint) {
      try { recipient = await resolveRecipient(d.recipient_hint); toEmail = recipient && recipient.best ? recipient.best.email : null; } catch (_) {}
    }

    // "reply to all board" — a direction about RECIPIENTS, not about wording.
    //
    // Ed 2026-08-21: "cant we add — i want to be able to give tessa command to
    // reply to all board." This is better than reply-all rebuilt from a stored
    // recipient list: that only works for mail polled after migration 380, and
    // it copies whoever happened to be on one message. The board is the board,
    // whether or not every member was on this thread.
    //
    // She has to work out WHICH association first, and if she cannot tell she
    // asks instead of guessing — mail landing at the wrong board is worse than
    // a question.
    let group = null;
    const { wantsBoard, communityForThread } = require('../lib/ea/tessa_thread_community');
    if (wantsBoard(instruction)) {
      try {
        const { resolveBoardGroup } = require('../lib/ea/tessa_resolve');
        const found = await communityForThread(item);
        if (!found.community) {
          group = { kind: 'board', resolved: false,
            ask: 'Which community\'s board? I couldn\'t tell from this message — name it in your note (for example "reply to the Canyon Gate board").' };
        } else {
          const board = await resolveBoardGroup(`${found.community.name} board`);
          const people = (board && board.people) || [];
          if (!people.length) {
            group = { kind: 'board', resolved: false, community: found.community.name,
              ask: `I don't have board addresses on file for ${found.community.name}.` };
          } else {
            group = {
              kind: 'board', resolved: true,
              community: found.community.name,
              how: found.how,
              confident: found.confident,
              to: people.map((p) => p.email).filter(Boolean),
              people: people.map((p) => ({ name: p.name, email: p.email })),
            };
          }
        }
      } catch (e) {
        console.warn('[tessa] board group resolve failed:', e.message);
        group = { kind: 'board', resolved: false, ask: 'I could not look up the board just now.' };
      }
    }

    await supabase.from('ea_inbox').update({ draft_subject: d.subject, draft_body: d.body, draft_mode: d.mode, updated_at: new Date().toISOString() }).eq('id', item.id);
    res.json({ ok: true, action: d.action, subject: d.subject, body: d.body, mode: d.mode, to: toEmail, recipient_hint: d.recipient_hint || null, recipient, group });
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
    const mode = 'tessa';   // she always sends as herself
    const { draftEmail } = require('../lib/ea/tessa');
    const d = await draftEmail({ thought, mode, onEdsBehalf: true });   // a standing task is Ed's content
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
      subject: String(b.subject).trim(), body: String(b.body).trim(), mode: 'tessa',
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

// ---- Tessa's OUTBOX: prepared work she holds for Ed to release ---------------
// North star (Ed 2026-09-03): the AI team does the work like real people in
// their roles; the human supervises and releases. A queued email or meeting
// sits here until Ed hits release. Nothing leaves on its own. (Migration 405.)
const OUTBOX_COLS = 'id, kind, status, title, note, to_emails, cc_emails, subject, body_text, attachment_name, attachment_mime, attachment_path, attachment_bucket, organizer, meeting_start, meeting_end, meeting_time_zone, meeting_location, meeting_attendees, result, send_error, created_at, sent_at';

// GET /outbox?status=queued — Tessa's prepared items (default: still queued).
router.get('/outbox', async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    let q = supabase.from('tessa_outbox').select(OUTBOX_COLS).order('created_at', { ascending: false }).limit(100);
    const status = req.query.status || 'queued';
    if (status !== 'all') q = q.eq('status', status);
    const { data, error } = await q;
    if (error) {
      if (/could not find|does not exist|42P01|PGRST20[45]|schema cache/i.test(`${error.message} ${error.code}`)) {
        return res.json({ items: [], migration_pending: true });
      }
      throw error;
    }
    res.json({ items: data || [] });
  } catch (err) { console.error('[tessa] outbox list failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /outbox — stage a prepared item. { kind, title, ... }. Nothing is sent.
router.post('/outbox', express.json({ limit: '64kb' }), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const b = req.body || {};
    const kind = String(b.kind || '').trim();
    if (!['email', 'meeting'].includes(kind)) return res.status(400).json({ error: 'kind must be email or meeting' });
    if (!String(b.title || '').trim()) return res.status(400).json({ error: 'title_required' });
    const row = {
      kind, title: String(b.title).trim(), note: b.note || null, status: 'queued',
      to_emails: b.to_emails || null, cc_emails: b.cc_emails || null,
      subject: b.subject || null, body_text: b.body_text || null,
      attachment_path: b.attachment_path || null, attachment_name: b.attachment_name || null,
      attachment_mime: b.attachment_mime || null, attachment_bucket: b.attachment_bucket || 'documents',
      organizer: b.organizer || null, meeting_start: b.meeting_start || null, meeting_end: b.meeting_end || null,
      meeting_time_zone: b.meeting_time_zone || null, meeting_location: b.meeting_location || null,
      meeting_attendees: b.meeting_attendees || null, created_by: owner.email || 'Ed',
    };
    const { data, error } = await supabase.from('tessa_outbox').insert(row).select(OUTBOX_COLS).single();
    if (error) throw error;
    res.json({ ok: true, item: data });
  } catch (err) { console.error('[tessa] outbox stage failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /outbox/:id/release — Ed releases a queued item. Email -> Tessa sends it
// (her branded signature + headshot, plus the stored attachment). Meeting ->
// Tessa books it (organizer = Tessa, per Ed 2026-09-03). The click IS the
// approval, same gate as the Draft Queue and /meeting.
router.post('/outbox/:id/release', express.json({ limit: '4kb' }), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    if (!graphSend.isConfigured()) return res.status(400).json({ error: 'Email/calendar is not connected yet (Microsoft Graph credentials must be set up).' });
    const { data: item, error } = await supabase.from('tessa_outbox').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!item) return res.status(404).json({ error: 'not_found' });
    if (item.status === 'sent') return res.status(409).json({ error: 'already_released' });

    if (item.kind === 'email') {
      const to = parseAddrs(item.to_emails), cc = parseAddrs(item.cc_emails);
      if (!to.length) return res.status(400).json({ error: 'no valid recipient on this item' });
      const subject = String(item.subject || '').trim() || '(no subject)';
      const body = String(item.body_text || '').trim();
      if (!body) return res.status(400).json({ error: 'the email body is empty' });

      // Tessa's branded wrapper: signature + headshot + logo (Ed's directive that
      // every AI-team email carries the block + picture).
      const { buildTessaEmail } = require('../lib/email/tessa_signature');
      const built = buildTessaEmail(body, null, null);
      const attachments = Array.isArray(built.attachments) ? built.attachments.slice() : [];

      // Pull the stored file attachment (e.g. the NDA PDF) and base64 it for Graph.
      if (item.attachment_path) {
        const { data: blob, error: dErr } = await supabase.storage.from(item.attachment_bucket || 'documents').download(item.attachment_path);
        if (dErr) {
          await supabase.from('tessa_outbox').update({ status: 'error', send_error: 'attachment download failed: ' + dErr.message }).eq('id', item.id);
          return res.status(502).json({ error: 'could not load the attachment — nothing was sent' });
        }
        const buf = Buffer.from(await blob.arrayBuffer());
        attachments.push({ '@odata.type': '#microsoft.graph.fileAttachment', name: item.attachment_name || 'attachment.pdf', contentType: item.attachment_mime || 'application/octet-stream', contentBytes: buf.toString('base64') });
      }

      try {
        await graphSend.sendAs({ from: graphSend.TESSA_MAILBOX, to, cc, subject, html: built.html, attachments });
      } catch (e) {
        await supabase.from('tessa_outbox').update({ status: 'error', send_error: e.message }).eq('id', item.id);
        return res.status(502).json({ error: `send failed: ${e.message}` });
      }
      const result = { from: graphSend.TESSA_MAILBOX, to, cc, attachments: attachments.length };
      await supabase.from('tessa_outbox').update({ status: 'sent', sent_at: new Date().toISOString(), released_by: owner.email || 'Ed', result, send_error: null }).eq('id', item.id);
      // Log to correspondence so it shows in Tessa's Sent.
      try {
        await supabase.from('email_messages').insert({
          mailbox: graphSend.TESSA_MAILBOX, direction: 'outbound', sender_email: graphSend.TESSA_MAILBOX,
          sender_name: 'Tessa McCall (Bedrock EA)', persona: 'tessa',
          recipients: [...to, ...cc], subject, body_preview: body.slice(0, 2000), body_full: body,
          classification: 'outbound_reply', classification_confidence: 'high',
          ai_summary: `Tessa released "${item.title}" to ${[...to, ...cc].join(', ')}`,
          triage_status: 'handled', reviewed_at: new Date().toISOString(),
        });
      } catch (e) { console.warn('[tessa] outbox send-log skipped:', e.message); }
      return res.json({ ok: true, kind: 'email', ...result });
    }

    // kind === 'meeting'
    const attendees = parseAddrs(item.meeting_attendees);
    if (!attendees.length) return res.status(400).json({ error: 'no valid attendees on this meeting' });
    if (!item.meeting_start || !item.meeting_end) return res.status(400).json({ error: 'the meeting is missing a start/end time' });
    const { createTeamsMeeting } = require('../lib/ea/tessa_meeting');
    let meeting;
    try {
      meeting = await createTeamsMeeting({
        organizer: item.organizer || graphSend.TESSA_MAILBOX,
        subject: String(item.subject || item.title).trim(),
        start: item.meeting_start, end: item.meeting_end,
        timeZone: item.meeting_time_zone || undefined,
        attendees, body: String(item.body_text || ''),
        location: item.meeting_location || null,
      });
    } catch (e) {
      await supabase.from('tessa_outbox').update({ status: 'error', send_error: e.message }).eq('id', item.id);
      return res.status(502).json({ error: `booking failed: ${e.message}` });
    }
    await supabase.from('tessa_outbox').update({ status: 'sent', sent_at: new Date().toISOString(), released_by: owner.email || 'Ed', result: meeting, send_error: meeting.warning || null }).eq('id', item.id);
    res.json({ ok: true, kind: 'meeting', ...meeting });
  } catch (err) { console.error('[tessa] outbox release failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// DELETE /outbox/:id — Tessa stands the item down (never sent).
router.delete('/outbox/:id', async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const { data, error } = await supabase.from('tessa_outbox').update({ status: 'cancelled' }).eq('id', req.params.id).eq('status', 'queued').select('id').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'not_cancellable' });
    res.json({ ok: true });
  } catch (err) { console.error('[tessa] outbox cancel failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

module.exports = { router };
