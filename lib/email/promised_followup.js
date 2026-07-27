// ============================================================================
// lib/email/promised_followup.js  (Ed 2026-07-27)
// ----------------------------------------------------------------------------
// "If Claire says she'll follow up, it should create a draft."
//
// When a reply Ed approves says "I'll let Carlos know…" / "we'll notify the
// homeowner…", the send only reaches the ADDRESSEE (Claire → Martha). Nothing
// then contacts Carlos, so the promise silently fails. This closes it: on send,
// detect the promise, resolve who the third party is FROM THE FORWARDED CHAIN /
// thread (their address rode in with it), draft a short note to them in the same
// persona's voice, and drop it in the draft queue for Ed to approve. Never sends
// on its own — it becomes a held draft, exactly like an ACC receipt.
//
// The send-gate warning (lib/email/draft_reply.js) is the safety net when we
// CAN'T resolve the party; this is the automation when we can.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { queueDraft } = require('./outbound_drafts');
const { fetchMessageText } = require('./graph_attachments');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;
const GENERIC = new Set(['the homeowner', 'the owner', 'the resident']);

// Detect third parties a draft PROMISES to contact. Returns the raw names (a
// proper name like "Carlos", or a generic "the homeowner"). Shared with the
// send-gate guard so the two never drift.
function detectPromisedContacts(text) {
  const stop = new Set(['you', 'them', 'us', 'the board', 'the team', 'the office', 'the committee', 'the group', 'everyone', 'the association', 'staff', 'the community']);
  const rx = /(?:\b[Ii](?:'|’)?ll|\b[Ww]e(?:'|’)?ll|\b[Ii] will|\b[Ww]e will)\s+(?:let|notify|tell|update|e-?mail|email|call|text|contact|loop in|reach out to|follow up with|circle back with|get (?:in touch|back) (?:with|to))\s+(the homeowner|the owner|the resident|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g;
  const out = new Set();
  let m;
  while ((m = rx.exec(String(text || '')))) {
    const who = m[1].trim();
    if (who && !stop.has(who.toLowerCase())) out.add(who);
  }
  return [...out];
}

// Pull "Name <email>" pairs and bare addresses out of a thread body.
function extractNameEmailPairs(text) {
  const t = String(text || '');
  const pairs = [];
  const rx = /([A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+){0,2})\s*[<(]\s*([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})\s*[>)]/g;
  let m;
  while ((m = rx.exec(t))) pairs.push({ name: m[1].trim(), email: m[2].toLowerCase() });
  return pairs;
}

const firstTok = (s) => String(s || '').trim().toLowerCase().split(/\s+/)[0] || '';
const isInternal = (e) => /@bedrocktx\.com$/i.test(String(e || ''));

// Resolve the promised party's email. Order: the forwarded chain / thread (their
// address came in with it) → the conversation's other participants → the
// property's owner (for "the homeowner") → a name match in contacts.
async function resolvePartyEmail({ name, threadText, conversationId, propertyId }) {
  const nm = String(name || '').trim();
  const generic = GENERIC.has(nm.toLowerCase());

  // Upgrade a bare first name to a full name using the thread history
  // ("Carlos" → "Carlos Allen"), which sharpens the lookups below.
  let fullName = nm;
  if (!generic) {
    const esc = nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fm = String(threadText || '').match(new RegExp('\\b' + esc + "\\s+([A-Z][a-zA-Z'\\-]+)"));
    if (fm) fullName = `${nm} ${fm[1]}`;
  }

  // 1) Named party inline in the thread body ("Carlos <carlos@…>").
  if (!generic) {
    const want = firstTok(nm);
    const pairs = extractNameEmailPairs(threadText);
    const hit = pairs.find((p) => firstTok(p.name) === want && !isInternal(p.email))
      || pairs.find((p) => p.email.split('@')[0].toLowerCase().includes(want) && want.length >= 3 && !isInternal(p.email));
    if (hit) return { email: hit.email, name: hit.name };
  }

  // 2) CROSS-THREAD: this person has emailed us before, in a DIFFERENT thread
  //    than the internal forward. Match by name across the mailbox → their real
  //    address. This is how "Carlos" in a forwarded note resolves to
  //    carlos@wehome500.com even though he isn't the titled owner (he manages the
  //    property for the LLC that owns it) and Martha's forward is a new thread.
  if (!generic) {
    try {
      const { data } = await supabase.from('email_messages')
        .select('sender_name, sender_email, received_at')
        .ilike('sender_name', `%${fullName}%`).not('sender_email', 'is', null)
        .order('received_at', { ascending: false }).limit(10);
      const hit = (data || []).find((r) => r.sender_email && EMAIL_RE.test(r.sender_email) && !isInternal(r.sender_email));
      if (hit) return { email: hit.sender_email.toLowerCase(), name: hit.sender_name || fullName };
    } catch (_) { /* best-effort */ }
  }

  // 2) Conversation participants (prior inbound messages in the same thread).
  if (conversationId) {
    try {
      const { data } = await supabase.from('email_messages')
        .select('sender_name, sender_email, direction')
        .eq('conversation_id', conversationId).order('received_at', { ascending: true }).limit(30);
      for (const r of (data || [])) {
        if (!r.sender_email || isInternal(r.sender_email) || !EMAIL_RE.test(r.sender_email)) continue;
        if (generic || firstTok(r.sender_name) === firstTok(nm)) return { email: r.sender_email.toLowerCase(), name: r.sender_name || nm };
      }
    } catch (_) { /* best-effort */ }
  }

  // 3) The property's owners. For "the homeowner" → the primary owner. For a
  //    named party ("Carlos") → the owner whose FIRST name matches (the requester
  //    is often a co-owner/occupant on the account, not the name on record).
  if (propertyId) {
    try {
      const { data } = await supabase.from('property_ownerships')
        .select('is_primary, contacts(full_name, primary_email, secondary_email)')
        .eq('property_id', propertyId).is('end_date', null)
        .order('is_primary', { ascending: false }).limit(5);
      const owners = (data || []).map((o) => o.contacts).filter(Boolean);
      const emailOf = (c) => [c.primary_email, c.secondary_email].find((e) => e && EMAIL_RE.test(e) && !isInternal(e));
      if (generic) {
        const o = owners.find(emailOf);
        if (o) return { email: emailOf(o).toLowerCase(), name: o.full_name || nm };
      } else {
        const want = firstTok(nm);
        const o = owners.find((c) => emailOf(c) && String(c.full_name || '').toLowerCase().split(/[\s&,/]+/).includes(want));
        if (o) return { email: emailOf(o).toLowerCase(), name: o.full_name || nm };
      }
    } catch (_) { /* best-effort */ }
  }

  // 4) Named contact lookup (last resort — only accept a single unambiguous hit).
  if (!generic) {
    try {
      const { data } = await supabase.from('contacts')
        .select('full_name, primary_email')
        .ilike('full_name', `%${fullName}%`).not('primary_email', 'is', null).limit(3);
      const hits = (data || []).filter((c) => c.primary_email && EMAIL_RE.test(c.primary_email));
      if (hits.length === 1) return { email: hits[0].primary_email.toLowerCase(), name: hits[0].full_name };
    } catch (_) { /* best-effort */ }
  }
  return null;
}

// Draft a short note to the party, grounded ONLY in what the sent reply says.
async function draftFollowupBody({ personaFirst, toName, sentBody, subject }) {
  const first = String(toName || '').trim().split(/\s+/)[0] || 'there';
  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 300,
      messages: [{ role: 'user', content: `You are ${personaFirst}, a warm, concise assistant at Bedrock Association Management. We just told a colleague we would follow up with ${toName || 'this person'}. Write a SHORT friendly email directly to ${first} conveying the relevant update — draw ONLY on the message below; do NOT invent any specifics (amounts, dates, decisions) not stated in it. No subject line, no signature, just the body. Start with "Hi ${first},".\n\n--- what we said we'd relay ---\n${String(sentBody || '').slice(0, 2000)}` }],
    });
    const t = (r.content?.[0]?.text || '').trim();
    if (t) return t;
  } catch (_) { /* fall through to template */ }
  return `Hi ${first},\n\nQuick follow-up from our team — I wanted to make sure you were in the loop on your recent request. We'll be in touch with any next steps.\n\nThanks!`;
}

// Main entry — called after a reply is sent. Best-effort; never throws into the
// send path. Returns a summary { queued:[{name,email,draftId}], unresolved:[names] }.
async function queuePromisedFollowups({ inbound, sentBody, persona, fromMailbox, communityName }) {
  const names = detectPromisedContacts(sentBody);
  const result = { queued: [], unresolved: [] };
  if (!names.length) return result;
  // The party's address usually rides in on the FORWARDED CHAIN, which often
  // isn't in our stored body (it's fetched live from Graph in the UI). If the
  // stored body is thin, pull the full message text from Graph so we can read
  // the chain the trail actually lives in.
  let threadText = `${inbound.body_full || inbound.body_preview || ''}`;
  if (threadText.replace(/\s+/g, '').length < 400 && inbound.graph_id && inbound.mailbox) {
    try { const g = await fetchMessageText(inbound.mailbox, inbound.graph_id); if (g) threadText += '\n' + g; } catch (_) { /* Graph unavailable — fall back to stored body */ }
  }
  const personaFirst = (persona || 'Claire').charAt(0).toUpperCase() + (persona || 'Claire').slice(1);
  const recipientOfSend = String(inbound.sender_email || '').toLowerCase();

  for (const name of names) {
    let party = null;
    try {
      party = await resolvePartyEmail({ name, threadText, conversationId: inbound.conversation_id, propertyId: inbound.resolved_property_id });
    } catch (_) { party = null; }
    // Don't draft to the person we just replied to, or to an internal address.
    if (!party || !party.email || party.email === recipientOfSend || isInternal(party.email)) {
      result.unresolved.push(name);
      continue;
    }
    const subject = /^re:/i.test(inbound.subject || '') ? inbound.subject : `Re: ${inbound.subject || 'your request'}`;
    const bodyText = await draftFollowupBody({ personaFirst, toName: party.name || name, sentBody, subject });
    const q = await queueDraft({
      communityId: inbound.community_id || null, communityName: communityName || null,
      persona: persona || 'claire', fromMailbox: fromMailbox || null,
      toEmail: party.email, toName: party.name || name,
      subject, bodyText,
      relatedType: 'promised_followup', relatedId: inbound.id,
      sourceEmailRef: `followup:${inbound.id}:${firstTok(name)}`,
      draftKind: 'promised_followup', aiDrafted: true,
      draftReason: `Claire's reply promised to follow up with ${party.name || name} — drafted for review`,
      createdBy: persona || 'claire',
    });
    if (q.status === 'queued' || q.status === 'exists') result.queued.push({ name: party.name || name, email: party.email, draftId: q.id || null });
    else result.unresolved.push(name);
  }
  return result;
}

module.exports = { detectPromisedContacts, resolvePartyEmail, queuePromisedFollowups };
