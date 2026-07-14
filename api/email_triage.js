// ============================================================================
// api/email_triage.js — Communications hub Phase 1 (read-only ingest + triage)
// ----------------------------------------------------------------------------
// Serves the triage board and the per-record communications feed. Nothing here
// sends email; a human confirms/redirects the AI's proposed linkage, and the
// confirmation writes back (adds the sender's address to the contact) so the
// next email from that address auto-links — the encode-Ed learning loop.
//
// Mounted at /api/email-triage:
//   GET  /            ?status &classification &community_id &q &limit &offset
//   GET  /stats       counts by triage_status + classification
//   GET  /:id
//   POST /:id/link    { contact_id?, property_id?, vendor_id?, community_id?, write_back_email? }
//   POST /:id/dismiss { as: 'dismissed' | 'spam' | 'handled' }
//   GET  /for-record  ?contact_id= | property_id= | vendor_id=   (record's comms feed)
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { draftReply } = require('../lib/email/draft_reply');
const graphSend = require('../lib/email/graph_send');
const graphIngest = require('../lib/email/graph_ingest');
const { requireAdmin, getAuthedUser, OWNER_EMAIL } = require('./_require_admin');

// Is the requester Ed (the owner)? Gates Tessa's PRIVATE mail off the shared
// board — she is only visible to Ed, never to staff.
async function isOwner(req) {
  const u = await getAuthedUser(req);
  return !!(u && u.role === 'admin' && String(u.email || '').toLowerCase() === OWNER_EMAIL);
}

// Which team member owns this email? Emma (AP) when it arrived at emma@, resolves
// to a vendor, or is a vendor/financial message; Claire (front office) otherwise.
// One brain, two faces — Emma grounds in the AP ledger, Claire in the 360.
function personaFor(m) {
  if (!m) return 'claire';
  // DRV: an inbound Claire routed to Miranda (open enforcement case) carries a
  // drv persona hint stamped at ingest — her approved reply sends from miranda@.
  if (m.extracted && m.extracted.drv && m.extracted.drv.persona === 'miranda') return 'miranda';
  const mailbox = String(m.mailbox || '').toLowerCase();
  if (mailbox === String(graphSend.EMMA_MAILBOX || '').toLowerCase()) return 'emma';
  if (m.resolved_vendor_id) return 'emma';
  if (['vendor_financial', 'vendor_general'].includes(m.classification)) return 'emma';
  return 'claire';
}

// Claire's honest-AI signature — every AI-sent email identifies as AI and
// offers a human (same rule as the voice persona).
function claireSignature(communityName) {
  return `\n\n— Claire, AI assistant${communityName ? ` for ${communityName}` : ''} · Bedrock Association Management\nWant a person instead? Just reply and I'll pass you to the team.`;
}

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// BETA GATE (Ed 2026-07-07): Communications is owner-only for now. Every
// endpoint on this router requires the admin (Ed) JWT — staff get 403, so the
// inbox data never loads for them even if they reach the page directly. The
// page itself shows a "coming soon" screen for non-admins. Ed forwards to a
// staffer via Claire when someone needs to get involved. Flip this to a role
// allowlist when Communications graduates from beta.
router.use(async (req, res, next) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return; // 403 already sent
  req.admin = admin;
  next();
});

const SELECT = 'id, mailbox, direction, sender_email, sender_name, subject, body_preview, received_at, has_attachments, classification, classification_confidence, ai_summary, extracted, community_id, resolved_contact_id, resolved_property_id, resolved_vendor_id, resolution_confidence, resolution_candidates, triage_status, priority, reviewed_by, reviewed_at, created_at, resolved_contact:resolved_contact_id(full_name), resolved_property:resolved_property_id(street_address), resolved_vendor:resolved_vendor_id(name), community:community_id(name)';

// GET / — triage list
router.get('/', async (req, res) => {
  try {
    const { status, classification, community_id, persona, q } = req.query;
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const owner = await isOwner(req);
    // Tessa's mail is Ed's private EA workspace — non-owners can never request
    // it, and it's excluded from every non-owner query regardless of filter.
    if (persona && String(persona).split(',').includes('tessa') && !owner) {
      return res.status(403).json({ error: 'owner_only' });
    }
    let query = supabase.from('email_messages').select(SELECT).order('received_at', { ascending: false }).range(offset, offset + limit - 1);
    if (status) query = query.in('triage_status', String(status).split(','));
    if (classification) query = query.in('classification', String(classification).split(','));
    if (persona) query = query.in('persona', String(persona).split(','));
    if (!owner) query = query.neq('persona', 'tessa');
    if (community_id) query = query.eq('community_id', community_id);
    if (q) query = query.or(`subject.ilike.%${q}%,sender_email.ilike.%${q}%,ai_summary.ilike.%${q}%`);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ messages: data || [] });
  } catch (err) {
    console.error('[email_triage] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /team — the AI team roster: one row per teammate with their mail counts,
// so the board shows names you can click to expand all of their emails.
router.get('/team', async (req, res) => {
  try {
    const { TEAM, TESSA_CARD } = require('../lib/email/persona');
    const owner = await isOwner(req);
    const list = owner ? [...TEAM, TESSA_CARD] : TEAM;
    // Each teammate's OWN address — used to split "addressed directly to them"
    // vs "came to info@ and was routed to them."
    const SELF = { claire: 'claire@', emma: 'emma@', annie: 'annie@', miranda: 'miranda@' };
    const roster = [];
    for (const t of list) {
      const total = await supabase.from('email_messages').select('id', { count: 'exact', head: true }).eq('persona', t.persona);
      const unrev = await supabase.from('email_messages').select('id', { count: 'exact', head: true }).eq('persona', t.persona).in('triage_status', ['needs_review', 'new']);
      const latest = await supabase.from('email_messages').select('received_at').eq('persona', t.persona).order('received_at', { ascending: false }).limit(1).maybeSingle();
      const entry = { ...t, total: total.count || 0, unreviewed: unrev.count || 0, latest_at: latest.data ? latest.data.received_at : null };
      if (SELF[t.persona]) {
        const d = await supabase.from('email_messages').select('id', { count: 'exact', head: true }).eq('persona', t.persona).ilike('mailbox', `%${SELF[t.persona]}%`);
        const direct = d.count || 0;
        entry.routing = { direct, via_info: Math.max(0, entry.total - direct) };
      }
      roster.push(entry);
    }
    res.json({ team: roster });
  } catch (err) {
    console.error('[email_triage] team failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /stats — board header counts
router.get('/stats', async (req, res) => {
  try {
    const owner = await isOwner(req);
    let sq = supabase.from('email_messages').select('triage_status, classification').limit(5000);
    if (!owner) sq = sq.neq('persona', 'tessa'); // keep Tessa's private mail out of staff counts
    const { data, error } = await sq;
    if (error) throw error;
    const byStatus = {}, byClass = {};
    (data || []).forEach((r) => { byStatus[r.triage_status] = (byStatus[r.triage_status] || 0) + 1; byClass[r.classification] = (byClass[r.classification] || 0) + 1; });
    res.json({ total: (data || []).length, by_status: byStatus, by_classification: byClass });
  } catch (err) {
    console.error('[email_triage] stats failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /for-record — every message linked to a homeowner/vendor record
router.get('/for-record', async (req, res) => {
  try {
    const { contact_id, property_id, vendor_id } = req.query;
    if (!contact_id && !property_id && !vendor_id) return res.status(400).json({ error: 'a record id is required' });
    let query = supabase.from('email_messages').select(SELECT).order('received_at', { ascending: false }).limit(200);
    if (contact_id) query = query.eq('resolved_contact_id', contact_id);
    else if (property_id) query = query.eq('resolved_property_id', property_id);
    else if (vendor_id) query = query.eq('resolved_vendor_id', vendor_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ messages: data || [] });
  } catch (err) {
    console.error('[email_triage] for-record failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /:id
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('email_messages').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json({ message: data });
  } catch (err) {
    console.error('[email_triage] get failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /:id/thread — the full body of this message + the rest of its email
// chain (same Graph conversation), oldest first, so staff can read the
// back-and-forth for reference.
router.get('/:id/thread', async (req, res) => {
  try {
    const { data: m, error } = await supabase.from('email_messages')
      .select('conversation_id, body_full, body_preview, subject, graph_id, mailbox').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!m) return res.status(404).json({ error: 'not_found' });
    let thread = [];
    if (m.conversation_id) {
      const { data } = await supabase.from('email_messages')
        .select('id, direction, sender_name, sender_email, subject, body_preview, received_at')
        .eq('conversation_id', m.conversation_id).order('received_at', { ascending: true }).limit(30);
      thread = data || [];
    }
    // Image/PDF attachments — homeowners photograph violations, and iPhone photos
    // arrive INLINE (Outlook reports hasAttachments=false), so fetch straight from
    // Graph by id. Staff need to SEE the evidence Claire read, not just her word
    // for it. (Ed 2026-07-14 — a violation report's photo wasn't visible.)
    let attachments = [];
    try {
      const { fetchAllAttachmentBuffers } = require('../lib/email/graph_attachments');
      const files = await fetchAllAttachmentBuffers(m.mailbox, m.graph_id);
      attachments = files.filter((f) => f.buffer && f.buffer.length <= 8 * 1024 * 1024).slice(0, 8)
        .map((f) => ({ name: f.filename, is_pdf: !!f.isPdf, data_uri: `data:${f.contentType};base64,${f.buffer.toString('base64')}` }));
    } catch (_) { /* best-effort — thread still renders without them */ }
    // Full body: body_preview is Microsoft's ~255-char teaser, and body_full is
    // often empty (not captured at ingest), so "see the original" gets cut off.
    // Pull the real body from Graph when what we have looks like a preview, and
    // backfill body_full so it's not lost next time. (Ed 2026-07-14.)
    let fullBody = m.body_full || '';
    if (m.graph_id && m.mailbox && fullBody.length < 4000) {
      try {
        const { fetchMessageText } = require('../lib/email/graph_attachments');
        const t = await fetchMessageText(m.mailbox, m.graph_id);
        if (t && t.length > fullBody.length) {
          fullBody = t;
          try { await supabase.from('email_messages').update({ body_full: t }).eq('id', req.params.id); } catch (_) {}
        }
      } catch (_) { /* fall back to what we have */ }
    }
    if (!fullBody) fullBody = m.body_preview || '';
    res.json({ ok: true, full_body: fullBody, thread, attachments });
  } catch (err) {
    console.error('[email_triage] thread failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /:id/link — human confirms (or redirects) the linkage.
router.post('/:id/link', express.json(), async (req, res) => {
  try {
    const { contact_id, property_id, vendor_id, community_id, write_back_email, reviewed_by } = req.body || {};
    const patch = { triage_status: 'linked', reviewed_by: reviewed_by || 'staff', reviewed_at: new Date().toISOString(), resolution_confidence: 'high' };
    if (contact_id !== undefined) patch.resolved_contact_id = contact_id;
    if (property_id !== undefined) patch.resolved_property_id = property_id;
    if (vendor_id !== undefined) patch.resolved_vendor_id = vendor_id;
    if (community_id !== undefined) patch.community_id = community_id;

    const { data: msg } = await supabase.from('email_messages').select('sender_email, extracted').eq('id', req.params.id).maybeSingle();
    const { data, error } = await supabase.from('email_messages').update(patch).eq('id', req.params.id).select(SELECT).single();
    if (error) throw error;

    // Learning loop: capture the sender's email + the phone in their signature
    // onto the confirmed contact (contact_methods — the canonical store the
    // resolver reads, so the NEXT email auto-links, and we keep their number).
    let learned = false;
    if (write_back_email && contact_id && msg && msg.sender_email) {
      try {
        const { enrichContactFromEmail } = require('../lib/email/contact_enrich');
        const added = await enrichContactFromEmail(supabase, contact_id, { email: msg.sender_email, phone: msg.extracted && msg.extracted.sender_phone });
        learned = added.length > 0;
      } catch (e) { console.warn('[email_triage] enrich on link failed:', e.message); }
    }
    res.json({ message: data, learned });
  } catch (err) {
    console.error('[email_triage] link failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /ingest — pull Outlook mail into the 360 from a mailbox (default the
// archive journal). Backfill: since_days=365, light=true, only_linked=true so
// only homeowner-linked mail is kept out of the 65k-message firehose.
// Incremental/current: pass light=false + a short since_days. Needs the Azure
// app (Mail.Read) + GRAPH_* env; returns a clean message until then.
router.post('/ingest', express.json(), async (req, res) => {
  try {
    if (!graphIngest.isConfigured()) return res.status(400).json({ error: 'graph_not_connected', detail: 'Outlook ingest needs the Azure app (Mail.Read, scoped to include the mailbox) + GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET.' });
    const b = req.body || {};
    const mailbox = b.mailbox || 'archive1emails@bedrocktx.com';
    const sinceDays = Math.min(2000, parseInt(b.since_days, 10) || 365);
    const sinceISO = new Date(Date.now() - sinceDays * 864e5).toISOString();
    const light = b.light !== false;               // default light (cheap backfill)
    const onlyLinked = b.only_linked !== false;     // default keep only homeowner-linked
    const max = Math.min(20000, parseInt(b.max, 10) || 5000);
    const stats = await graphIngest.ingestMailbox(mailbox, { sinceISO, light, onlyLinked, max });
    res.json({ ok: true, mailbox, since: sinceISO, ...stats });
  } catch (err) {
    console.error('[email_triage] ingest failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Other UNHANDLED inbound emails from the SAME sender within a short window —
// homeowners often send a second (or third) note because they forgot something
// or want to add info. One reply should cover them all so the homeowner gets a
// single coherent answer, not several. Returns [{id, subject, body, received_at}].
async function findSiblingEmails(message) {
  if (!message || message.direction === 'outbound' || !message.sender_email) return [];
  const center = new Date(message.received_at || Date.now()).getTime();
  if (!Number.isFinite(center)) return [];
  const WINDOW = 2 * 3600 * 1000; // 2 hours either side — a real "forgot something" burst, not unrelated later mail
  try {
    const { data } = await supabase.from('email_messages')
      .select('id, subject, body_full, body_preview, received_at')
      .ilike('sender_email', message.sender_email)
      .eq('direction', 'inbound')
      .neq('id', message.id)
      .in('triage_status', ['new', 'needs_review', 'linked'])
      .gte('received_at', new Date(center - WINDOW).toISOString())
      .lte('received_at', new Date(center + WINDOW).toISOString())
      .order('received_at', { ascending: true }).limit(6);
    return (data || []).map((s) => ({ id: s.id, subject: s.subject, body: s.body_full || s.body_preview || '', received_at: s.received_at }));
  } catch (_) { return []; }
}

// Greet the person who actually emailed, NOT the household account name. A joint
// owner record ("Julie McKay & James Storm") would otherwise make Claire greet
// the first-listed owner (Julie) even when James is the one who wrote in. The
// sender's own display name is the truest signal of who to address; when that's
// missing we match the sender's email local-part to the right side of a joint
// name (jim.storm@ -> "...James Storm"). Ed 2026-07-13 (the Jim Storm thread).
function greetingNameFor(m) {
  const sender = (m.sender_name || '').trim();
  const isPersonal = (s) => s && /[A-Za-z]/.test(s) && !s.includes('@')
    && !/^(the\s|info|admin|board|office|no.?reply|noreply|do.?not.?reply|billing|accounts?|management|support|team)\b/i.test(s);
  if (isPersonal(sender)) return sender;

  const contactFull = m.resolved_contact ? (m.resolved_contact.full_name || '').trim() : '';
  // Joint household + no usable sender name: pick the owner the sender's email
  // points at, so a reply to jim.storm@ greets "James", not "Julie".
  const parts = contactFull.split(/\s+(?:&|and)\s+/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const local = String(m.sender_email || '').split('@')[0].toLowerCase();
    const tokens = local.split(/[^a-z]+/).filter((t) => t.length > 2);
    const hit = parts.find((p) => { const pl = p.toLowerCase(); return tokens.some((t) => pl.includes(t)); });
    if (hit) return hit;
  }
  return contactFull || sender || null;
}

// POST /:id/draft-reply — AI suggests a reply (NOT sent). Guardrails in the lib
// force a human for legal/enforcement/ACC/financial. Returns the draft for
// review; the row's triage_status is left as-is until a human acts.
router.post('/:id/draft-reply', express.json(), async (req, res) => {
  try {
    // Optional reviewer steering: notes (Ed's thoughts to incorporate) + the
    // current draft text to revise instead of starting fresh.
    const notes = (req.body && req.body.notes) ? String(req.body.notes).slice(0, 3000) : null;
    const currentDraft = (req.body && req.body.current_draft) ? String(req.body.current_draft).slice(0, 4000) : null;
    const { data: m, error } = await supabase.from('email_messages')
      .select('subject, body_preview, body_full, conversation_id, sender_email, sender_name, classification, community_id, resolved_contact_id, resolved_property_id, resolved_vendor_id, graph_id, mailbox, has_attachments, received_at, direction, resolved_contact:resolved_contact_id(full_name), resolved_vendor:resolved_vendor_id(name), community:community_id(name)')
      .eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!m) return res.status(404).json({ error: 'not_found' });

    // Other UNHANDLED inbound emails from the same homeowner in a short window —
    // "forgot something / sent more info." Reply once, cover them all.
    const siblings = await findSiblingEmails({ id: req.params.id, ...m });

    // Persona routing: a vendor / AP conversation (came to emma@, or resolves to
    // a vendor, or is vendor-financial) is Emma's — she grounds the reply in the
    // AP subledger. Everything else is Claire's (homeowner/front-office).
    const covers = siblings.map((s) => ({ id: s.id, subject: s.subject }));
    if (personaFor(m) === 'emma') {
      const { draftEmmaReply } = require('../lib/email/emma_reply');
      const draft = await draftEmmaReply({
        email: { subject: m.subject, body_preview: m.body_preview, body_full: m.body_full },
        vendorId: m.resolved_vendor_id, vendorName: m.resolved_vendor ? m.resolved_vendor.name : (m.sender_name || null),
        notes, currentDraft,
      });
      return res.json({ ...draft, covers });
    }

    // Homeowner linked but community/property didn't come across (e.g. matched by
    // name from a NEW email address) — derive their current property + community so
    // Claire pulls THAT community's rules and confirms the address, instead of
    // asking "what's your address?". (Ed 2026-07-14, the Bishen Calloo shed thread.)
    let communityId = m.community_id, propertyId = m.resolved_property_id;
    let communityName = m.community ? m.community.name : null;
    if (m.resolved_contact_id && (!communityId || !propertyId)) {
      try {
        const { data: po } = await supabase.from('property_ownerships')
          .select('property:property_id(id, street_address, community_id)')
          .eq('contact_id', m.resolved_contact_id).is('end_date', null)
          .order('is_primary', { ascending: false }).limit(1);
        const prop = po && po[0] && po[0].property;
        if (prop) {
          propertyId = propertyId || prop.id;
          communityId = communityId || prop.community_id;
          if (!communityName && communityId) {
            const { data: cm } = await supabase.from('communities').select('name').eq('id', communityId).maybeSingle();
            communityName = cm ? cm.name : null;
          }
        }
      } catch (_) { /* best-effort — Claire will ask for the address if we can't derive it */ }
    }

    const draft = await draftReply({
      email: { subject: m.subject, body_preview: m.body_preview, body_full: m.body_full, conversation_id: m.conversation_id, sender_email: m.sender_email, graph_id: m.graph_id, mailbox: m.mailbox, has_attachments: m.has_attachments },
      classification: m.classification,
      contactId: m.resolved_contact_id, propertyId, communityId,
      // Greet whoever actually wrote in (the sender), not the household account
      // name — so a joint "Julie McKay & James Storm" record still gets "Hi James"
      // when James emailed. Account DATA still comes from contactId/propertyId.
      contactName: greetingNameFor(m),
      communityName,
      force: true, // Ed clicked "Draft reply" explicitly — always produce a reply, even internal/spam
      notes, currentDraft, // reviewer steering (Rewrite with my notes)
      siblings, // cover the homeowner's other recent emails in one reply
    });
    res.json({ ...draft, covers });
  } catch (err) {
    console.error('[email_triage] draft-reply failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /:id/forward-internal — hand this item to a teammate to verify / weigh
// in BEFORE we reply. Sends the homeowner's message + Claire's draft + your note
// from Ed's office to the teammate's inbox, and records the hand-off on the item.
// Nothing goes to the homeowner. (Ed 2026-07-13 — the light-touch "loop someone
// in" option, not a new assignment workflow.)
router.post('/:id/forward-internal', express.json(), async (req, res) => {
  try {
    const { to_email, to_name, note } = req.body || {};
    // Accept one OR several recipients (comma/semicolon-separated) so "Everyone"
    // can forward to the whole team at once. sendAs handles the list.
    const recips = String(to_email || '').split(/[,;]/).map((x) => x.trim()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
    if (!recips.length) return res.status(400).json({ error: 'Pick a teammate with a valid email address.' });
    const to = recips.join(', ');
    const { data: m, error } = await supabase.from('email_messages')
      .select('subject, body_full, body_preview, sender_email, sender_name, classification, extracted, community:community_id(name)')
      .eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!m) return res.status(404).json({ error: 'not_found' });
    if (!graphSend.isConfigured()) return res.status(400).json({ error: 'email_not_connected', detail: 'Graph credentials missing — internal forward needs email connected.' });

    const draft = m.extracted && m.extracted.draft;
    const orig = (m.body_full || m.body_preview || '').slice(0, 6000);
    const e = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a2230;">
${note ? `<p style="margin:0 0 12px;"><strong>Note:</strong> ${e(note).replace(/\n/g, '<br>')}</p>` : ''}
<p style="margin:0 0 6px;color:#5a7390;">Forwarding this homeowner email for your review before we reply — nothing has been sent to the homeowner yet.</p>
<div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin:10px 0;">
  <div style="font-size:12px;color:#5a7390;">From ${e(m.sender_name || m.sender_email || '')}${m.community ? ' · ' + e(m.community.name) : ''}${m.classification ? ' · ' + e(m.classification) : ''}</div>
  <div style="font-weight:700;margin:4px 0;">${e(m.subject || '(no subject)')}</div>
  <div style="white-space:pre-wrap;">${e(orig)}</div>
</div>
${draft && draft.body ? `<div style="border-left:3px solid #D4AF37;padding:8px 12px;margin:10px 0;background:#fbf7ec;"><div style="font-size:12px;color:#5a7390;">Claire's draft reply (not sent):</div><div style="white-space:pre-wrap;">${e(draft.body)}</div></div>` : ''}
${draft && draft.review_hint ? `<p style="margin:8px 0;color:#8a6d00;"><strong>Claire suggests:</strong> ${e(draft.review_hint)}</p>` : ''}
<p style="margin:12px 0 0;">Reply here with what you find and we'll take it from there.</p>
</div>`;
    await graphSend.sendAs({ from: graphSend.ED_MAILBOX, to, subject: `For your review: ${m.subject || 'homeowner email'}`, html });

    // Record the hand-off on the item (no triage_status change — keeps it a
    // light annotation, not a workflow state).
    try {
      const merged = Object.assign({}, m.extracted || {}, { forwarded: { to, name: to_name || null, at: new Date().toISOString(), note: note || null } });
      await supabase.from('email_messages').update({ extracted: merged }).eq('id', req.params.id);
    } catch (_) { /* annotation best-effort */ }
    res.json({ ok: true, to });
  } catch (err) {
    console.error('[email_triage] forward-internal failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /:id/forward-note — "write my forward note from a few words." Same idea as
// "Rewrite with my notes" on replies: the operator types shorthand, we expand it
// into a short internal note to the teammate, referencing what's being forwarded.
// Nothing is sent — returns the note text for the operator to review/edit.
router.post('/:id/forward-note', express.json(), async (req, res) => {
  try {
    const thoughts = (req.body && req.body.thoughts) ? String(req.body.thoughts).slice(0, 1000) : '';
    const toName = (req.body && req.body.to_name) ? String(req.body.to_name) : '';
    const { data: m } = await supabase.from('email_messages')
      .select('subject, sender_name, ai_summary, extracted').eq('id', req.params.id).maybeSingle();
    if (!m) return res.status(404).json({ error: 'not_found' });
    const { draftForwardNote } = require('../lib/email/compose_draft');
    const out = await draftForwardNote({
      thoughts, toName,
      email: { subject: m.subject, sender_name: m.sender_name, ai_summary: m.ai_summary, draft_body: (m.extracted && m.extracted.draft && m.extracted.draft.body) || '' },
    });
    res.json({ ok: true, note: out.note, degraded: out.degraded });
  } catch (err) {
    console.error('[email_triage] forward-note failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /:id/send — approve-to-send: a human reviewed the draft; send it from
// claire@ (honest-AI signature), log it, mark the inbound handled. Defense in
// depth: refuse to send for non-draftable (compliance) classes even if asked.
router.post('/:id/send', express.json(), async (req, res) => {
  try {
    const { body, to, subject, reviewed_by } = req.body || {};
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'body_required' });
    const { data: m, error } = await supabase.from('email_messages')
      .select('sender_email, subject, classification, community_id, resolved_contact_id, resolved_property_id, resolved_vendor_id, mailbox, extracted, community:community_id(name)')
      .eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!m) return res.status(404).json({ error: 'not_found' });
    const persona = personaFor(m);
    // No classification block on send: Ed reviews and approves every outgoing
    // reply himself (admin-only), and explicitly wants to reply to any email,
    // including internal/staff mail (the staff-interaction loop). The human gate
    // is the control, not the classifier.
    if (!graphSend.isConfigured()) return res.status(400).json({ error: 'claire_not_connected', detail: 'claire@bedrocktx.com send is not wired yet — create the mailbox + Azure app (Mail.Send) and set GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET.' });

    const recipient = to || m.sender_email;
    if (!recipient) return res.status(400).json({ error: 'no_recipient' });
    const commName = m.community ? m.community.name : '';
    const subj = subject || (/^re:/i.test(m.subject || '') ? m.subject : `Re: ${m.subject || 'your message'}`);

    // Send in the right voice: Emma from emma@ for vendor/AP, Claire from claire@
    // otherwise. Both carry the branded logo + their own honest-AI signature.
    let html, attachments, fromMailbox, senderLabel;
    if (persona === 'emma') {
      const { buildEmmaEmail } = require('../lib/email/emma_signature');
      ({ html, attachments } = buildEmmaEmail(String(body).trim()));
      fromMailbox = graphSend.EMMA_MAILBOX; senderLabel = 'Emma Brooks (Bedrock AI)';
    } else if (persona === 'miranda') {
      const { buildMirandaEmail } = require('../lib/email/miranda_signature');
      ({ html, attachments } = buildMirandaEmail(String(body).trim(), commName));
      fromMailbox = graphSend.MIRANDA_MAILBOX; senderLabel = 'Miranda Pierce (Bedrock AI)';
    } else {
      const { buildClaireEmail } = require('../lib/email/claire_signature');
      ({ html, attachments } = buildClaireEmail(String(body).trim(), commName));
      fromMailbox = graphSend.CLAIRE_MAILBOX; senderLabel = 'Claire (Bedrock AI)';
    }

    await graphSend.sendAs({ from: fromMailbox, to: recipient, subject: subj, html, attachments });

    // Mark the inbound handled + log the outbound reply on the record.
    await supabase.from('email_messages').update({ triage_status: 'handled', reviewed_by: reviewed_by || 'staff', reviewed_at: new Date().toISOString() }).eq('id', req.params.id);
    // This reply covered the homeowner's other recent emails — mark those
    // handled too, so sending once clears them all instead of leaving stragglers.
    const alsoHandle = Array.isArray(req.body && req.body.also_handle) ? req.body.also_handle.filter(Boolean).slice(0, 10) : [];
    if (alsoHandle.length) {
      try { await supabase.from('email_messages').update({ triage_status: 'handled', reviewed_by: `${reviewed_by || 'staff'} (covered by one reply)`, reviewed_at: new Date().toISOString() }).in('id', alsoHandle); } catch (_) {}
    }
    await supabase.from('email_messages').insert({
      mailbox: fromMailbox, direction: 'outbound', sender_email: fromMailbox,
      sender_name: senderLabel, recipients: [recipient], subject: subj, body_preview: String(body).trim().slice(0, 2000),
      classification: 'outbound_reply', classification_confidence: 'high', ai_summary: `${senderLabel.split(' ')[0]} replied to ${recipient}`, persona,
      community_id: m.community_id, resolved_contact_id: m.resolved_contact_id, resolved_property_id: m.resolved_property_id, resolved_vendor_id: m.resolved_vendor_id,
      resolution_confidence: 'high', triage_status: 'handled', record_ownership: 'association_record', reviewed_by: reviewed_by || 'staff', reviewed_at: new Date().toISOString(),
    });
    // DRV: log Miranda's sent reply onto the enforcement case history.
    if (persona === 'miranda' && m.extracted && m.extracted.drv && m.extracted.drv.violation_id) {
      try {
        const { logDrvOutbound } = require('../lib/enforcement/drv_reply');
        await logDrvOutbound({ violationId: m.extracted.drv.violation_id, communityId: m.community_id, propertyId: m.resolved_property_id, contactId: m.resolved_contact_id, subject: subj, body: String(body).trim(), sentBy: reviewed_by || 'staff' });
      } catch (e) { console.warn('[email_triage] drv outbound log skipped:', e.message); }
    }
    res.json({ sent: true, to: recipient, from: fromMailbox, persona, also_handled: alsoHandle.length });
  } catch (err) {
    console.error('[email_triage] send failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /:id/to-payables — Emma files an emailed bill into the AP queue (the
// same deduped intake as uploads/scans), marks the email handled, sends NO
// reply. The bill posts to the GL on approval in Payables.
router.post('/:id/to-payables', express.json(), async (req, res) => {
  try {
    const { data: m } = await supabase.from('email_messages')
      .select('id, mailbox, graph_id, subject, community_id, resolved_vendor_id, has_attachments, extracted, sender_name')
      .eq('id', req.params.id).maybeSingle();
    if (!m) return res.status(404).json({ error: 'not_found' });
    if (!m.graph_id || !m.has_attachments) return res.status(400).json({ error: 'no_attachment', detail: 'No bill is attached to file. Use Record to GL for a payment confirmation, or handle it in Accounting.' });
    const { fetchAllAttachmentBuffers } = require('../lib/email/graph_attachments');
    const { autoIntake } = require('../lib/ap/intake');
    const pdfs = (await fetchAllAttachmentBuffers(m.mailbox, m.graph_id)).filter((f) => f.isPdf);
    if (!pdfs.length) return res.status(400).json({ error: 'no_pdf', detail: 'No PDF bill attached to file to Payables.' });
    let loaded = 0, dup = 0;
    for (const pdf of pdfs) {
      const out = await autoIntake({ buffer: pdf.buffer, filename: pdf.filename, intakeMethod: 'email', sourceRef: `email:${m.graph_id}`, communityId: m.community_id || null, vendorIdHint: m.resolved_vendor_id || null, achHintText: m.subject || '' });
      if (out && out.outcome === 'loaded') loaded += 1;
      else if (out && out.outcome === 'held_suspected_duplicate') dup += 1;
    }
    // Teach the map so the next bill on this account/vendor auto-routes.
    if (m.community_id) {
      try {
        const { learnMapping } = require('../lib/ap/vendor_community');
        await learnMapping({ accountNumber: (m.extracted && m.extracted.account_number) || null, vendorId: m.resolved_vendor_id || null, vendorName: m.sender_name || null, communityId: m.community_id });
      } catch (e) { console.warn('[email_triage] learn (payables) skipped:', e.message); }
    }
    await supabase.from('email_messages').update({ triage_status: 'handled', reviewed_by: (req.body || {}).reviewed_by || 'staff', reviewed_at: new Date().toISOString() }).eq('id', m.id);
    res.json({ ok: true, loaded, duplicates: dup });
  } catch (err) { console.error('[email_triage] to-payables failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /:id/to-gl — Emma records an already-handled payment (e.g. an auto-pay
// confirmation) straight to the GL: Dr the classified expense / Cr 1000
// Operating Cash, flagged needs_review for month-end. NO reply is sent. Guarded
// hard — bails (never posts) unless community + a single clear amount + a
// confident expense account are all present, so it can't corrupt the books.
router.post('/:id/to-gl', express.json(), async (req, res) => {
  try {
    const { data: m } = await supabase.from('email_messages')
      .select('id, graph_id, subject, sender_name, community_id, resolved_vendor_id, extracted, received_at')
      .eq('id', req.params.id).maybeSingle();
    if (!m) return res.status(404).json({ error: 'not_found' });
    if (!m.community_id) return res.status(400).json({ error: 'no_community', detail: 'Link this email to a community first — the entry has to post to the right association books.' });

    const b = req.body || {};
    const { recordVendorPaymentToGL, singleAmountCents } = require('../lib/accounting/record_vendor_payment');
    let cents = (b.amount_cents && Number.isInteger(+b.amount_cents) && +b.amount_cents > 0) ? +b.amount_cents : singleAmountCents(m.extracted && m.extracted.amounts);
    if (!cents) return res.status(400).json({ error: 'ambiguous_amount', detail: 'Couldn\'t pin a single amount. Record this one in Accounting so the figure is exact.' });
    const desc = `Emma: ${String(m.subject || m.sender_name || 'Vendor payment').slice(0, 110)}`;
    const out = await recordVendorPaymentToGL({
      communityId: m.community_id, amountCents: cents, glAccountId: b.gl_account_id || null,
      vendorId: m.resolved_vendor_id || null, vendorName: m.sender_name || null, description: desc,
      postingDate: String(m.received_at || new Date().toISOString()).slice(0, 10), sourceRef: `email:${m.graph_id || m.id}`,
      notes: `Recorded from Emma's inbox (${m.sender_name || 'vendor'}). Flagged for month-end review.`,
    });
    if (out.error) {
      const detail = out.error === 'no_account' ? 'Couldn\'t confidently pick an expense account. Record it in Accounting so it\'s coded right.'
        : out.error === 'no_cash' ? 'No 1000 Operating Cash account on this community\'s chart.'
        : out.error === 'period_closed' ? 'That accounting period is closed. Record it in the current period from Accounting.'
        : 'Could not record to the GL.';
      return res.status(400).json({ error: out.error, detail });
    }
    // Teach the map: this vendor + account number -> this community + GL account,
    // so the next identical bill records itself.
    try {
      const { learnMapping } = require('../lib/ap/vendor_community');
      const admin = await getAuthedUser(req);
      await learnMapping({ accountNumber: (m.extracted && m.extracted.account_number) || null, vendorId: m.resolved_vendor_id || null, vendorName: m.sender_name || null, communityId: m.community_id, glAccountId: out.gl_account_id, taughtByUserId: admin && admin.user ? admin.user.id : null, taughtByName: admin ? admin.full_name : null });
    } catch (e) { console.warn('[email_triage] learn mapping skipped:', e.message); }
    await supabase.from('email_messages').update({ triage_status: 'handled', reviewed_by: b.reviewed_by || 'staff', reviewed_at: new Date().toISOString() }).eq('id', m.id);
    res.json({ ok: true, amount_cents: cents, needs_review: true });
  } catch (err) { console.error('[email_triage] to-gl failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /pull — ADMIN ONLY. On-demand "pull now": ingest current mail from both
// info@ and claire@ (replies to Claire), draft every reply for review. Manual
// by design — Ed reviews everything, so a button he presses beats a silent
// auto-feed he might miss. Idempotent (delete-then-insert by message id), so
// pressing it repeatedly is safe.
router.post('/pull', express.json(), async (req, res) => {
  try {
    if (!graphIngest.isConfigured()) return res.status(400).json({ error: 'graph_not_connected', detail: 'Outlook ingest needs the Azure app (Mail.Read) + GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET.' });
    // ALWAYS pull both info@ and claire@ (union with any env override), so a
    // single-value EMAIL_INGEST_MAILBOX on Render can't silently drop claire@.
    const extra = (process.env.EMAIL_INGEST_MAILBOX || '').split(',').map((m) => m.trim()).filter(Boolean);
    const mailboxes = [...new Set(['info@bedrocktx.com', 'claire@bedrocktx.com', graphSend.EMMA_MAILBOX, graphSend.ANNIE_MAILBOX, graphSend.MIRANDA_MAILBOX, ...extra])];
    const days = Math.min(60, parseInt((req.body || {}).days, 10) || 14);
    const sinceISO = new Date(Date.now() - days * 864e5).toISOString();
    const results = {}; let kept = 0, drafted = 0, invoicesLoaded = 0, filed = 0;
    // Mailboxes are independent — pull them at the same time instead of waiting
    // for each to finish before starting the next.
    await Promise.all(mailboxes.map(async (mbx) => {
      try {
        const s = await graphIngest.ingestMailbox(mbx, { sinceISO, light: false, onlyLinked: false, max: 500 });
        results[mbx] = s; kept += s.kept || 0; invoicesLoaded += s.invoices_loaded || 0; filed += s.filed || 0;
      } catch (e) { results[mbx] = { error: e.message }; }
    }));
    // Count fresh drafts awaiting review (non-spam/internal inbound with a draft)
    try {
      const { count } = await supabase.from('email_messages').select('id', { count: 'exact', head: true })
        .eq('direction', 'inbound').eq('triage_status', 'needs_review').not('extracted->draft', 'is', null);
      drafted = count || 0;
    } catch (_) {}
    res.json({ ok: true, since: sinceISO, mailboxes, kept, drafts_waiting: drafted, invoices_loaded: invoicesLoaded, filed, results });
  } catch (err) {
    console.error('[email_triage] pull failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /compose — ADMIN ONLY (Ed). Compose and send a fresh email as Claire
// straight from trustEd (not a reply to an inbound). Branded HTML + logo +
// honest-AI signature, sent from claire@, logged as association-record
// correspondence (and linked to the homeowner when the address matches).
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function parseAddrs(v) {
  return String(v || '').split(/[,;]/).map((s) => s.trim()).filter((s) => EMAIL_RE.test(s));
}

router.post('/compose', express.json(), async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return; // 403 already sent
    const { to, cc, subject, body, community_name, persona } = req.body || {};
    const P = ['emma', 'annie', 'miranda'].includes(String(persona || '').toLowerCase()) ? String(persona).toLowerCase() : 'claire';
    const asEmma = P === 'emma';
    const toList = parseAddrs(to);
    const ccList = parseAddrs(cc);
    if (toList.length === 0) return res.status(400).json({ error: 'to_required', detail: 'Enter at least one valid recipient email.' });
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'body_required' });
    if (!graphSend.isConfigured()) return res.status(400).json({ error: 'claire_not_connected', detail: 'AI-team email send is not wired yet — the Azure app (Mail.Send) + GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET must be set.' });

    const subj = (subject && String(subject).trim()) ? String(subject).trim() : '(no subject)';

    // Homeowner linkage only makes sense for Claire (front office). Emma's
    // recipients are vendors, so we don't file her mail onto a homeowner record.
    let resolved_contact_id = null, resolved_property_id = null, community_id = null, commName = community_name || '';
    if (!asEmma) {
      // Place this on the right homeowner for the record (best-effort, keyed on
      // the FIRST recipient — the primary addressee).
      try {
        const { data: c } = await supabase.from('contacts').select('id').or(`primary_email.ilike.${toList[0]},secondary_email.ilike.${toList[0]}`).limit(1);
        if (c && c[0]) {
          resolved_contact_id = c[0].id;
          const { data: o } = await supabase.from('property_ownerships').select('property_id, properties(community_id, communities:community_id(name))').eq('contact_id', resolved_contact_id).is('end_date', null).limit(1);
          if (o && o[0]) { resolved_property_id = o[0].property_id; if (o[0].properties) { community_id = o[0].properties.community_id; if (!commName && o[0].properties.communities) commName = o[0].properties.communities.name; } }
        }
      } catch (_) { /* non-fatal — send anyway, just less linkage */ }
    }

    // Send in each teammate's voice + from their own mailbox, all branded.
    let html, attachments, fromMailbox, senderLabel, personaName;
    if (P === 'emma') {
      const { buildEmmaEmail } = require('../lib/email/emma_signature');
      ({ html, attachments } = buildEmmaEmail(String(body).trim()));
      fromMailbox = graphSend.EMMA_MAILBOX; senderLabel = 'Emma Brooks (Bedrock AI)'; personaName = 'Emma';
    } else if (P === 'annie') {
      const { buildAnnieEmail } = require('../lib/email/annie_signature');
      ({ html, attachments } = buildAnnieEmail(String(body).trim(), commName));
      fromMailbox = graphSend.ANNIE_MAILBOX; senderLabel = 'Annie Reeves (Bedrock AI)'; personaName = 'Annie';
    } else if (P === 'miranda') {
      const { buildMirandaEmail } = require('../lib/email/miranda_signature');
      ({ html, attachments } = buildMirandaEmail(String(body).trim(), commName));
      fromMailbox = graphSend.MIRANDA_MAILBOX; senderLabel = 'Miranda Pierce (Bedrock AI)'; personaName = 'Miranda';
    } else {
      const { buildClaireEmail } = require('../lib/email/claire_signature');
      ({ html, attachments } = buildClaireEmail(String(body).trim(), commName));
      fromMailbox = graphSend.CLAIRE_MAILBOX; senderLabel = 'Claire (Bedrock AI)'; personaName = 'Claire';
    }
    await graphSend.sendAs({ from: fromMailbox, to: toList, cc: ccList, subject: subj, html, attachments });

    const allRecipients = [...toList, ...ccList];
    await supabase.from('email_messages').insert({
      mailbox: fromMailbox, direction: 'outbound', sender_email: fromMailbox,
      sender_name: senderLabel, recipients: allRecipients, subject: subj, body_preview: String(body).trim().slice(0, 2000),
      classification: 'outbound_reply', classification_confidence: 'high', persona: P, ai_summary: `${personaName} emailed ${allRecipients.join(', ')} (composed by ${admin.full_name || admin.email})`,
      community_id, resolved_contact_id, resolved_property_id, resolution_confidence: resolved_contact_id ? 'high' : 'low',
      triage_status: 'handled', record_ownership: 'association_record', reviewed_by: admin.full_name || admin.email || 'admin', reviewed_at: new Date().toISOString(),
    });

    res.json({ sent: true, to: toList, cc: ccList, from: fromMailbox, persona: personaName.toLowerCase(), linked_to_homeowner: !!resolved_contact_id });
  } catch (err) {
    console.error('[email_triage] compose failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /compose-draft — ADMIN ONLY. "Claire, write this for me." Turns a short
// intent into a subject + body in Claire's voice; the operator edits before
// sending via /compose. Nothing is sent here.
router.post('/compose-draft', express.json(), async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return; // 403 already sent
    const { intent, to, community_name, persona } = req.body || {};
    const draftPersona = ['emma', 'annie', 'miranda'].includes(String(persona || '').toLowerCase()) ? String(persona).toLowerCase() : 'claire';
    if (!intent || !String(intent).trim()) return res.status(400).json({ error: 'intent_required', detail: 'Tell the AI what you want the email to say.' });

    // Light recipient context so the draft can greet by name / fit the community.
    const firstTo = parseAddrs(to)[0] || null;
    let recipientName = null, commName = community_name || '';
    if (firstTo) {
      try {
        const { data: c } = await supabase.from('contacts').select('full_name, id').or(`primary_email.ilike.${firstTo},secondary_email.ilike.${firstTo}`).limit(1);
        if (c && c[0]) {
          recipientName = c[0].full_name || null;
          if (!commName) {
            const { data: o } = await supabase.from('property_ownerships').select('properties(communities:community_id(name))').eq('contact_id', c[0].id).is('end_date', null).limit(1);
            if (o && o[0] && o[0].properties && o[0].properties.communities) commName = o[0].properties.communities.name;
          }
        }
      } catch (_) { /* best-effort */ }
    }

    const { draftEmailFromIntent } = require('../lib/email/compose_draft');
    const draft = await draftEmailFromIntent(intent, { to: firstTo, recipientName, community: commName, persona: draftPersona });
    if (draft.degraded) return res.status(503).json({ error: 'draft_unavailable', detail: 'Claire could not draft this right now. Write it yourself, or try again.' });
    res.json({ ok: true, subject: draft.subject, body: draft.body });
  } catch (err) {
    console.error('[email_triage] compose-draft failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /:id/dismiss — mark spam / dismissed / handled without linking.
router.post('/:id/dismiss', express.json(), async (req, res) => {
  try {
    const as = ['dismissed', 'spam', 'handled'].includes((req.body || {}).as) ? req.body.as : 'dismissed';
    const { data, error } = await supabase.from('email_messages')
      .update({ triage_status: as, reviewed_by: (req.body || {}).reviewed_by || 'staff', reviewed_at: new Date().toISOString() })
      .eq('id', req.params.id).select(SELECT).single();
    if (error) throw error;
    res.json({ message: data });
  } catch (err) {
    console.error('[email_triage] dismiss failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /dismiss-bulk — dismiss/spam MANY emails at once (checkbox multi-select),
// so staff aren't clicking one by one. Status-only, same as /:id/dismiss — the
// homeowner link (resolved_contact_id/property) is preserved, so dismissed mail
// still shows on the homeowner's 360.
router.post('/dismiss-bulk', express.json(), async (req, res) => {
  try {
    const as = ['dismissed', 'spam', 'handled'].includes((req.body || {}).as) ? req.body.as : 'dismissed';
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.filter(Boolean).slice(0, 500) : [];
    if (!ids.length) return res.status(400).json({ error: 'no_ids', detail: 'Select at least one email.' });
    const { data, error } = await supabase.from('email_messages')
      .update({ triage_status: as, reviewed_by: (req.body || {}).reviewed_by || 'staff', reviewed_at: new Date().toISOString() })
      .in('id', ids).select('id');
    if (error) throw error;
    res.json({ ok: true, updated: (data || []).length });
  } catch (err) {
    console.error('[email_triage] dismiss-bulk failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
