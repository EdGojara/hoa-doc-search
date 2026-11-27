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
const { buildStagedMeetingRow, parseMonthDay, centralTodayUTC } = require('../lib/ea/tessa_calendar_intent');
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

// opts (Amanda's email console reuses this search, Ed 2026-10-06):
//   addressBook  include Ed's private ea_contacts book. Default true (Tessa, owner-only).
//                Amanda's console is admin-gated, so it passes false.
//   staff        include active Bedrock staff from user_profiles. Default false.
async function searchContacts(q, { addressBook = true, staff = false } = {}) {
  q = String(q || '').trim();
  const like = `%${q.replace(/[%,]/g, ' ')}%`;
  const out = []; const seen = new Set();
  const add = (c) => { if (!c.email) return; const k = c.email.toLowerCase(); if (seen.has(k)) return; seen.add(k); out.push(c); };
  if (staff && q) {
    const { data: st } = await supabase.from('user_profiles').select('full_name, email, role').neq('is_active', false).or(`full_name.ilike.${like},email.ilike.${like}`).limit(20);
    for (const u of (st || [])) add({ name: u.full_name || u.email, org: 'Bedrock staff', email: u.email, role: 'staff', source: 'staff' });
  }
  if (addressBook) {
    let eaQ = supabase.from('ea_contacts').select('id, name, organization, email, phone, role, category, title, responsibilities, superseded_by_contact_id').limit(40);
    if (q) eaQ = eaQ.or(`name.ilike.${like},organization.ilike.${like},email.ilike.${like},title.ilike.${like}`);
    let { data: ea, error: eaErr } = await eaQ;
    if (eaErr && /superseded_by_contact_id/.test(eaErr.message || '')) {
      // Before migration 499: the same lookup without the new column.
      let q2 = supabase.from('ea_contacts').select('id, name, organization, email, phone, role, category, title, responsibilities').limit(40);
      if (q) q2 = q2.or(`name.ilike.${like},organization.ilike.${like},email.ilike.${like},title.ilike.${like}`);
      ({ data: ea, error: eaErr } = await q2);
    }
    if (eaErr) console.warn('[tessa] address book search failed:', eaErr.message);
    for (const c of (ea || [])) add({ name: c.name, org: c.organization, email: c.email, phone: c.phone, role: c.title || c.role || c.category, source: 'address_book' });
    // A row whose address bounced and was superseded by an address another row
    // already holds points at that row (migration 499). "Nicole Hill" then
    // resolves to the address Nicole actually replied from.
    const merged = [...new Set((ea || []).filter((c) => !c.email && c.superseded_by_contact_id).map((c) => c.superseded_by_contact_id))];
    if (merged.length) {
      const { data: tgt, error: tErr } = await supabase.from('ea_contacts').select('id, name, organization, email, phone, role, category, title').in('id', merged);
      if (tErr) console.warn('[tessa] superseded contact lookup failed:', tErr.message);
      for (const c of (tgt || [])) add({ name: c.name, org: c.organization, email: c.email, phone: c.phone, role: c.title || c.role || c.category, source: 'address_book' });
    }
  }
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
async function resolveRecipient(hint, opts) {
  hint = String(hint || '').trim(); if (!hint) return null;
  const m = hint.match(/^(.+?)\s+(?:at|from|with|@)\s+(.+)$/i);
  const norm = (s) => String(s || '').toLowerCase();
  let cands = [];
  if (m) {
    const name = m[1].trim(), org = m[2].trim();
    const byName = await searchContacts(name, opts);
    const byOrg = await searchContacts(org, opts);
    const pool = [...byName, ...byOrg];
    const seen = new Set();
    for (const c of pool) { const k = norm(c.email); if (k && !seen.has(k)) { seen.add(k); cands.push(c); } }
    cands = cands.map((c) => ({ c, s: (c.org && norm(c.org).includes(norm(org)) ? 2 : 0) + (norm(c.name).includes(norm(name)) ? 1 : 0) }))
      .sort((a, b) => b.s - a.s).map((x) => x.c);
  } else {
    cands = await searchContacts(hint, opts);
  }
  // Delivery evidence (Ed 2026-10-07, Nicole Hill): a bounced address is swapped
  // for the verified one that replaced it, or dropped; recent two-way
  // correspondence ranks first. Unknown addresses keep their order.
  let bounced = [];
  try {
    const AS = require('../lib/ea/address_status');
    const store = AS.supabaseStore(supabase);
    const emails = cands.map((c) => c.email).filter(Boolean);
    const evs = await store.events(emails);
    const sup = [...new Set(evs.filter((e) => e.kind === 'supersede').map((e) => e.related_email))];
    const all = [...emails, ...sup];
    const { kept, dropped } = AS.applyStatus(cands, AS.statusMap(all, sup.length ? await store.events(all) : evs));
    cands = kept; bounced = dropped;
  } catch (e) { console.warn('[tessa] address status unavailable:', e.message); }
  // Only auto-fill To when there's exactly one strong match; otherwise let Ed pick.
  const best = cands.length === 1 ? cands[0] : (cands.length && m ? cands[0] : null);
  return { best, matches: cands.slice(0, 5), hint, bounced };
}

// Our own mailboxes are never a person's address.
function ownAddresses() {
  return Object.entries(graphSend).filter(([k, v]) => /_MAILBOX$/.test(k) && typeof v === 'string').map(([, v]) => v);
}

// Refuse to send to a bounced address (Ed 2026-10-07). Returns true when it
// answered the request. Only a human restore un-bounces an address.
async function refuseBounced(res, emails) {
  try {
    const AS = require('../lib/ea/address_status');
    const { searchMailbox } = require('../lib/email/graph_search');
    const live = graphSend.isConfigured();
    const list = await AS.bouncedAmong(emails, {
      store: AS.supabaseStore(supabase),
      searchMailbox: live ? searchMailbox : null,
      mailboxes: live ? [graphSend.TESSA_MAILBOX, graphSend.ED_MAILBOX].filter(Boolean) : [],
      ownAddresses: ownAddresses(),
    });
    if (!list.length) return false;
    res.status(409).json({ error: AS.bouncedMessage(list), code: 'bounced_recipient', bounced: list });
    return true;
  } catch (e) {
    // Delivery evidence unavailable (e.g. before migration 499): logged, and the
    // send proceeds exactly as it did before this check existed.
    console.warn('[tessa] bounce check unavailable:', e.message);
    return false;
  }
}

// Saving a bounced address into the book needs restore_bounced: true, which
// records the owner's restore. Returns true when it answered the request.
async function bouncedGate(res, email, body, owner) {
  try {
    const AS = require('../lib/ea/address_status');
    const store = AS.supabaseStore(supabase);
    const list = await AS.bouncedAmong([email], { store });
    if (!list.length) return false;
    if (body && body.restore_bounced === true) { await store.restore(email, owner.email || owner.full_name || 'owner'); return false; }
    res.status(409).json({ error: AS.bouncedMessage(list).replace('Nothing was sent.', 'Not saved.'), code: 'bounced_recipient', bounced: list });
    return true;
  } catch (e) { console.warn('[tessa] bounce check unavailable:', e.message); return false; }
}

// POST /addresses/restore { email } — a human says a bounced address works
// again. The only way a bounced address is ever used again. Owner only.
router.post('/addresses/restore', express.json(), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'bad_email' });
    const AS = require('../lib/ea/address_status');
    await AS.supabaseStore(supabase).restore(email, owner.email || owner.full_name || 'owner');
    res.json({ ok: true, email, restored_by: owner.email || owner.full_name });
  } catch (err) { console.error('[tessa] restore address failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

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
    if (email && await bouncedGate(res, email, b, owner)) return;
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
    if (upd.email && await bouncedGate(res, upd.email, b, owner)) return;
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
// Resolve a parsed meeting ("tomorrow", "3:00 PM"..) into local WALL times
// 'YYYY-MM-DDTHH:mm:ss' + the Central zone, the exact shape createTeamsMeeting
// wants. Day math is done on UTC-anchored dates (DST doesn't move a calendar
// day), and the time is a bare wall time Graph applies in the zone — same
// discipline as the CLAUDE.md date-boundary scar. Returns null if unusable.
function resolveMeetingWallTimes(meeting) {
  if (!meeting || !meeting.start_time) return null;
  let DEFAULT_TZ = 'Central Standard Time';
  try { DEFAULT_TZ = require('../lib/ea/tessa_meeting').DEFAULT_TZ || DEFAULT_TZ; } catch (_) {}
  const baseUTC = centralTodayUTC();
  const WD = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const raw = String(meeting.date || '').trim().toLowerCase();
  let target = new Date(baseUTC);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) { const [y, m, d] = raw.split('-').map(Number); target = new Date(Date.UTC(y, m - 1, d)); }
  else if (raw === 'tomorrow') target = new Date(baseUTC + 86400000);
  else if (raw === 'today' || !raw) target = new Date(baseUTC);
  else if (WD.includes(raw)) { let delta = (WD.indexOf(raw) - new Date(baseUTC).getUTCDay() + 7) % 7; if (delta === 0) delta = 7; target = new Date(baseUTC + delta * 86400000); }
  else if (parseMonthDay(raw, baseUTC)) target = parseMonthDay(raw, baseUTC);
  else return null;   // an unreadable date never silently becomes today
  // A date in the past is never booked (scar 2026-10-06: the model wrote 2025).
  if (target.getTime() < baseUTC) return null;
  const dateStr = `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-${String(target.getUTCDate()).padStart(2, '0')}`;
  const toHHMM = (s) => {
    const m = String(s || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/i);
    if (!m) return null;
    let h = +m[1]; const min = m[2] ? +m[2] : 0; const ap = (m[3] || '').replace(/\./g, '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`;
  };
  const start = toHHMM(meeting.start_time); if (!start) return null;
  let end = toHHMM(meeting.end_time);
  if (meeting.duration_minutes > 0) {
    const [h, mi] = start.split(':').map(Number); const t = h * 60 + mi + Number(meeting.duration_minutes);
    end = t < 24 * 60 ? `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}:00` : end;
  }
  if (!end) { const [h, mi] = start.split(':').map(Number); end = `${String((h + 1) % 24).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00`; }
  const dateLabel = new Date(target).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return { start: `${dateStr}T${start}`, end: `${dateStr}T${end}`, tz: DEFAULT_TZ, date_label: dateLabel };
}

router.post('/request', express.json({ limit: '16kb' }), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const text = String((req.body || {}).request || '').trim();
    if (!text) return res.status(400).json({ error: 'request_required', detail: 'Tell Tessa what you need.' });

    const { runRequest, draftMeetingInvite, draftIntroEmail } = require('../lib/ea/tessa_request');
    const { searchMailbox } = require('../lib/email/graph_search');
    // Ed's own mailbox first (his inbox AND sent items — Graph /messages spans
    // both), then Tessa's, which holds anything he forwarded her.
    const mailboxes = graphSend.isConfigured()
      ? [graphSend.ED_MAILBOX, graphSend.TESSA_MAILBOX].filter(Boolean)
      : [];

    // Availability (Ed 2026-10-07): the slot comes from Ed's calendar + Tessa's held
    // slots before anything is drafted or staged. No Graph = no blind booking: the
    // request still parses, but nothing is staged without a calendar read.
    const { chooseSlot, settleHold } = require('../lib/ea/tessa_availability');
    let graphToken = null;
    const schedule = graphSend.isConfigured()
      ? async (args) => { graphToken = graphToken || await graphSend.getToken(); return chooseSlot(args, { token: graphToken, supabase, edMailbox: graphSend.ED_MAILBOX }); }
      : null;
    let out;
    try {
      out = await runRequest(text, {
        resolveRecipient, searchMailbox, mailboxes, schedule,
        addressStore: require('../lib/ea/address_status').supabaseStore(supabase), ownAddresses: ownAddresses(),
      });
    } catch (e) {
      if (e && (e.code === 'calendar_read_failed' || e.code === 'holds_read_failed')) return res.status(503).json({ error: e.message });
      throw e;
    }
    if (out.degraded) return res.status(503).json({ error: 'Tessa could not work that one out. Try saying it a different way.' });

    // Create any contacts Ed asked her to add — into ea_contacts, the book she
    // resolves from, so they're findable next time too. Dedupe by email. This is
    // Ed's own directory (not outward), so she does it rather than staging it.
    const created_contacts = [];
    for (const c of (out.create_contacts || [])) {
      try {
        const { data: ex } = await supabase.from('ea_contacts').select('id, name, email').ilike('email', c.email).limit(1);
        if (ex && ex.length) { created_contacts.push({ ...ex[0], existed: true }); continue; }
        const { data, error } = await supabase.from('ea_contacts')
          .insert({ name: c.name, email: c.email, category: null, created_by: owner.email || 'Ed' })
          .select('id, name, email').single();
        if (!error && data) created_contacts.push({ ...data, existed: false });
      } catch (e) { console.warn('[tessa] contact create skipped:', e.message); }
    }

    // Stage the calendar entry Ed asked for. NOTHING is booked here; it waits in
    // her outbox for Ed to release. The KIND comes from his words by rule
    // (lib/ea/tessa_calendar_intent.js, Ed 2026-10-06):
    //   calendar_only  his own calendar, no attendees, no invitation, no Teams
    //   invite         Tessa organizes, Ed + the named people, no Teams link
    //   online         Tessa organizes a Teams meeting (the legacy default)
    // Tessa is the ORGANIZER on meetings she sets up (Ed 2026-09-10), and Ed is
    // always in the room; never invite Tessa herself.
    let staged_meeting = null; let staged_meeting_error = null;
    const mode = (out.meeting && out.meeting.mode) || 'online';
    const sched = out.meeting && out.meeting.schedule;
    const fmtAlt = (a) => require('../lib/ea/tessa_slots').labelOf(a.start);
    if (sched && sched.status !== 'ok') {
      // Never a double-booking and never a guess: say why and offer the best 2-3 openings.
      staged_meeting_error = (sched.status === 'conflict' ? 'That time is not open on your calendar: ' : 'No open slot in that window: ')
        + (sched.reasons || []).join('; ') + '.'
        + (sched.alternatives && sched.alternatives.length ? ' Open alternatives: ' + sched.alternatives.map(fmtAlt).join('; ') + '.' : ' No nearby opening found.');
    }
    if (out.meeting && out.meeting.direct_invite && !schedule) {
      staged_meeting_error = 'Tessa cannot read your calendar right now, so nothing was booked (she never books a time blind).';
    }
    const canStage = !staged_meeting_error && out.meeting && out.meeting.direct_invite
      && (mode === 'calendar_only' ? (out.to.length || (out.parsed.to_hints || []).length || out.meeting.topic) : out.to.length);
    if (canStage) {
      const wt = resolveMeetingWallTimes(out.meeting);
      if (wt) {
        let inviteBody = '';
        if (mode !== 'calendar_only') {
          // A REAL invitation body, in Tessa's voice on Ed's behalf — never the
          // raw parsed instruction, which reads as meta-noise in the invite.
          inviteBody = await draftMeetingInvite({
            title: out.meeting.title, message: out.meeting.message,
            attendeeNames: out.to.map((p) => p.name).filter(Boolean),
          });
          if (!inviteBody) {
            const who = out.to.map((p) => (p.name || '').split(/s+/)[0]).filter(Boolean).join(' and ') || 'there';
            inviteBody = `Hi ${who}, I'm setting up this meeting on Ed's behalf${out.meeting.message ? ', ' + out.meeting.message : (out.meeting.title ? ' to ' + out.meeting.title.toLowerCase() : '')}.${mode === 'online' ? ' The Teams join link is on this invite.' : ''}`;
          }
        }
        const row = buildStagedMeetingRow({
          mode, method: out.meeting.method, meeting: out.meeting, people: out.to,
          names: out.to.length ? [] : (out.parsed.to_hints || []),
          phones: out.meeting.phones || [], wt,
          edMailbox: graphSend.ED_MAILBOX, tessaMailbox: graphSend.TESSA_MAILBOX, inviteBody,
        });
        try {
          const SEL = 'id, subject, meeting_mode, meeting_start, meeting_end, meeting_time_zone, meeting_location, meeting_attendees, organizer, body_text';
          // Same request twice = one queued row (Ed 2026-10-06: "no duplicate row on
          // rerun"). Match on what makes it the same entry, still waiting for release.
          const { data: same, error: se } = await supabase.from('tessa_outbox').select(SEL)
            .eq('kind', 'meeting').eq('status', 'queued').eq('meeting_mode', row.meeting_mode)
            .eq('organizer', row.organizer).eq('meeting_start', row.meeting_start).eq('meeting_end', row.meeting_end)
            .eq('subject', row.subject).limit(1);
          if (se) throw se;
          const { data, error } = (same && same.length)
            ? { data: { ...same[0], already_queued: true }, error: null }
            : await supabase.from('tessa_outbox').insert({ ...row, created_by: owner.email || 'Ed' }).select(SEL).single();
          if (!error && data && !data.already_queued) {
            // Two requests raced for one slot: the hold written first keeps it.
            const held = await settleHold(supabase, { id: data.id, meeting_start: data.meeting_start, meeting_end: data.meeting_end });
            if (!held.kept) { staged_meeting_error = held.reason + ' Ask Tessa again for the next opening.'; out.draft = null; }
          }
          if (!error && data && !staged_meeting_error) {
            const hm = (w) => { const [h, m] = String(w).slice(11, 16).split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
            staged_meeting = { ...data, when_label: `${wt.date_label}, ${hm(wt.start)} to ${hm(wt.end)} Central` };
          } else if (error) {
            console.warn('[tessa] meeting stage failed:', error.message);
            staged_meeting_error = 'Tessa could not stage the calendar entry: ' + safeErrorMessage(error);
          }
        } catch (e) { console.warn('[tessa] meeting stage skipped:', e.message); staged_meeting_error = 'Tessa could not stage the calendar entry.'; }
      } else {
        // Never a silent skip: say which part she could not read.
        staged_meeting_error = `Tessa could not read the date/time ("${[out.meeting.date, out.meeting.start_time].filter(Boolean).join(' ') || 'none given'}"). Nothing was staged; say the date like "Wednesday, October 7 at 4 PM".`;
      }
    }

    // Intro email — ONLY when Ed asked for one (out.meeting.wants_intro), never
    // by default (Ed 2026-09-10). When requested, Tessa introduces herself to the
    // external guest(s) and says an invite is coming. Only to the people Ed named
    // (never Ed himself). Staged AFTER the meeting so it sorts on top (release
    // first).
    let staged_email = null;
    // HARD RULE: a calendar-only entry never stages an email to the other person.
    if (mode !== 'calendar_only' && out.meeting && out.meeting.direct_invite && out.meeting.wants_intro && out.to.length) {
      const introTo = out.to.map((p) => p.email).filter(Boolean);
      if (introTo.length) {
        const intro = await draftIntroEmail({
          attendeeNames: out.to.map((p) => p.name).filter(Boolean),
          title: out.meeting.title, message: out.meeting.message,
          whenLabel: staged_meeting ? staged_meeting.when_label : null,
        });
        if (intro && intro.body) {
          try {
            const { data, error } = await supabase.from('tessa_outbox').insert({
              kind: 'email', status: 'queued',
              title: intro.subject || 'Introduction from Bedrock',
              subject: intro.subject || 'Introduction from Bedrock',
              to_emails: introTo.join(', '), body_text: intro.body,
              note: 'Intro to send before the invite, on Ed’s behalf',
            }).select('id, subject, to_emails, body_text').single();
            if (!error && data) staged_email = { ...data };
            else if (error) console.warn('[tessa] intro email stage failed:', error.message);
          } catch (e) { console.warn('[tessa] intro email stage skipped:', e.message); }
        }
      }
    }

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
      meeting: out.meeting,
      created_contacts,
      staged_email,
      staged_meeting,
      staged_meeting_error,
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
    if (await refuseBounced(res, [...to, ...cc])) return;

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
    if (await refuseBounced(res, attendees)) return;

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
      conflictMailboxes: [graphSend.ED_MAILBOX, b.organizer || graphSend.ED_MAILBOX],
      allowConflict: b.allow_conflict === true,
    });

    // A booking with no join link is a calendar block whose invitation says
    // Teams and links nowhere. Say so instead of reporting a clean success.
    if (meeting.warning) console.warn('[tessa] meeting booked without a join link:', meeting.warning);
    console.log('[tessa] booked "' + meeting.subject + '" for ' + attendees.length + ' attendee(s)');
    res.json({ booked: true, ...meeting });
  } catch (err) {
    if (err.code === 'calendar_conflict') return res.status(409).json({ error: 'conflict', message: err.message, conflicts: err.conflicts });
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
    // Stamp a nudge: sent a follow-up just now, so record it and push the next
    // chase date out a few days (default 3) so it doesn't re-fire immediately.
    if (b.nudged) {
      patch.last_nudged_at = new Date().toISOString();
      const d = new Date(); d.setDate(d.getDate() + (parseInt(b.next_in_days, 10) || 3));
      patch.due_date = d.toISOString().slice(0, 10);
      if (patch.status === undefined) patch.status = 'waiting';
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'no_fields' });
    patch.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('ea_followups').update(patch).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json({ followup: data });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /followups/:id/nudge-draft — draft the actual follow-up email to the
// person we're waiting on, so a follow-up card becomes a one-click send instead
// of a passive reminder. Sent as Tessa (the scheduler). Returns the draft; the
// send goes through /send, then the card is stamped nudged. (Ed 2026-09-11.)
router.post('/followups/:id/nudge-draft', express.json(), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    const { data: fu, error } = await supabase.from('ea_followups').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    if (!fu) return res.status(404).json({ error: 'not_found' });
    const to = String(fu.waiting_on || '').trim();
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      return res.status(400).json({ error: 'no_recipient', detail: 'This follow-up has no email to nudge. Add one in "Waiting on".' });
    }
    // Recipient name: from the EA book, else a first name parsed out of the title
    // ("...with Melody", "Melody's availability"), else the address local-part.
    let name = null;
    try { const { data: c } = await supabase.from('ea_contacts').select('name').ilike('email', to).limit(1); if (c && c[0]) name = c[0].name; } catch (_) {}
    if (!name) { const m = String(fu.title || '').match(/\bwith\s+([A-Z][a-z]+)|\b([A-Z][a-z]+)'s\b/); name = (m && (m[1] || m[2])) || to.split('@')[0]; }
    const first = String(name).trim().split(/\s+/)[0];
    // Topic: the title with the tracking verbs and the person stripped off.
    let topic = String(fu.title || 'this')
      .replace(/^\s*(schedule|set up|wait for|follow ?up on|confirm)\s+/i, '')
      .replace(/\b([A-Z][a-z]+)'s\s+availability\s+for\s+/i, '')
      .replace(/\s+with\s+[A-Z][a-z]+\s*$/i, '')
      .trim() || 'this';
    // Thread on the original email's subject when we have it.
    let subject = `Following up on ${topic}`;
    if (fu.related_email_id) {
      try { const { data: e } = await supabase.from('email_messages').select('subject').eq('id', fu.related_email_id).maybeSingle(); if (e && e.subject) subject = /^re:/i.test(e.subject) ? e.subject : `Re: ${e.subject}`; } catch (_) {}
    }
    const topicPhrase = /^(the|a|an|our|your)\s/i.test(topic) ? topic : `the ${topic}`;
    let body = `Hi ${first},\n\nJust circling back on ${topicPhrase}. Whenever you have a moment, let me know what works for your schedule and I'll get it on the calendar. No rush at all.\n\nThank you!`;

    // Thread it on the original conversation: quote the history and Cc everyone
    // who was on it, so the nudge continues the thread with the same people
    // looped in rather than arriving as a cold new email (Ed 2026-09-11).
    let cc = '';
    if (fu.related_email_id) {
      try {
        const { data: src } = await supabase.from('email_messages').select('conversation_id').eq('id', fu.related_email_id).maybeSingle();
        if (src && src.conversation_id) {
          const { data: thread } = await supabase.from('email_messages')
            .select('direction, sender_email, sender_name, recipients, body_full, body_preview, received_at')
            .eq('conversation_id', src.conversation_id).order('received_at', { ascending: false }).limit(10);
          const SYS = /noreply|no-reply|do-not-reply|notification|@bedrocktxai\.com/i;
          const tessa = String(graphSend.TESSA_MAILBOX || '').toLowerCase();
          const parts = new Set();
          const addAddr = (a) => { const e = String((typeof a === 'string' ? a : (a && ((a.emailAddress && a.emailAddress.address) || a.address))) || '').trim().toLowerCase(); if (e && e.includes('@')) parts.add(e); };
          for (const m of (thread || [])) { addAddr(m.sender_email); (Array.isArray(m.recipients) ? m.recipients : []).forEach(addAddr); }
          // Cc everyone on the thread except the To recipient and Tessa (the sender).
          cc = [...parts].filter((e) => e !== to.toLowerCase() && e !== tessa && !SYS.test(e)).join(', ');
          // Quoted history, newest first, our own sends attributed to Bedrock.
          const { stripQuoted } = require('../lib/email/forward_hygiene');
          const fmtWhen = (d) => { try { return new Date(d).toLocaleString('en-US', { timeZone: 'America/Chicago' }); } catch (_) { return ''; } };
          const hist = (thread || []).map((m) => {
            const who = m.direction === 'outbound' ? 'Bedrock' : (m.sender_name || m.sender_email || '');
            const bt = stripQuoted(String(m.body_full || m.body_preview || '')).trim().slice(0, 1500);
            return `On ${fmtWhen(m.received_at)}, ${who} wrote:\n${bt}`;
          }).filter(Boolean).join('\n\n');
          if (hist) body = `${body}\n\n----- Original conversation -----\n${hist}`;
        }
      } catch (e) { console.warn('[tessa] nudge thread build skipped:', e.message); }
    }
    res.json({ ok: true, to, cc, subject, body, followup_id: fu.id });
  } catch (err) { console.error('[tessa] nudge-draft failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /test-sms — owner-only. Fire a test text to OWNER_MOBILE so Ed can
// verify SMS the moment it's provisioned, without waiting for a real trigger.
router.post('/test-sms', express.json(), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  const { textOwner } = require('../lib/notifications/notify_owner');
  const msg = String((req.body && req.body.message) || '').trim() || 'Test from Tessa via trustEd. If you got this, SMS is live.';
  const r = await textOwner(msg, { force: true });
  if (r.ok) return res.json({ sent: true, to: r.to });
  const detail = r.error === 'not_configured'
    ? 'SMS is not configured yet. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER on Render.'
    : r.error === 'no_owner_number' ? 'Set OWNER_MOBILE on Render (your mobile number).'
    : (r.error || 'Could not send.');
  return res.status(400).json({ error: detail });
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
    const { isCopiedFyi } = require('../lib/ea/tessa_inbox');
    const inbox = (data || []).map((item) => {
      const opts = replyOptions(item, graphSend);
      return {
        ...item,
        // Copied (FYI): she was Cc'd/Bcc'd, filed without a draft. One server-side
        // answer so the label and the actions agree. (Ed 2026-10-19.)
        copied_fyi: isCopiedFyi(item),
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
    if (await refuseBounced(res, [...to, ...cc])) return;

    const from = asEd ? graphSend.ED_MAILBOX : graphSend.TESSA_MAILBOX;
    // Her signature block already carries her name, title and the company: drop a
    // typed sign-off that repeats them, keep the closing. (Ed 2026-10-19.)
    const { stripDuplicateSignOff } = require('../lib/ea/tessa_reply_body');
    const sendBody = asEd ? body : stripDuplicateSignOff(body, require('../lib/email/persona_signature').identity('tessa')).body;
    if (!sendBody) return res.status(400).json({ error: 'The reply body is empty.' });
    // A REAL reply in the existing conversation (threading headers + Outlook's own
    // quoted history) whenever the original is in Tessa's mailbox, which is every
    // message she polled. Never silently degraded to a new message: if the original
    // is gone, say so and let Ed choose. (Ed 2026-10-19: "reply in the existing
    // email conversation".)
    const threaded = !asEd && !!item.graph_id;
    let html, attachments, sentInThread = false;
    if (asEd) {
      html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a2230;">${sendBody.split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px;">${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
    } else if (threaded) {
      ({ html, attachments } = require('../lib/email/tessa_signature').buildTessaEmail(sendBody, null, ''));   // Outlook supplies the quoted history
    } else {
      // No original to reply to: a fresh message, with the thread quoted so the
      // recipient has context.
      const quoted = quotedOriginal({
        fromName: item.from_name, fromEmail: item.from_email,
        sentAt: item.received_at, to: 'Tessa McCall',
        subject: item.subject,
        bodyText: item.body_full || item.body_preview,
      });
      ({ html, attachments } = require('../lib/email/tessa_signature').buildTessaEmail(sendBody, null, quoted));
    }
    if (threaded) {
      try {
        await graphSend.sendReplyAs({ from, sourceMailbox: from, sourceGraphId: item.graph_id, to, cc, html, attachments });
        sentInThread = true;
      } catch (e) {
        const gone = e.step === 'createReply' && (e.status === 404 || e.graphCode === 'ErrorItemNotFound');
        if (!(b.allow_new_thread === true && gone)) {
          console.error('[tessa] threaded reply failed:', e.message);
          return res.status(gone ? 409 : 502).json({ error: gone ? 'thread_unavailable' : 'send_failed',
            detail: gone ? 'The original email is no longer in Tessa’s mailbox, so this cannot go as a reply in that conversation. Nothing was sent.' : (e.userMessage || 'The reply could not be sent. Nothing was sent.') });
        }
        const quoted = quotedOriginal({ fromName: item.from_name, fromEmail: item.from_email, sentAt: item.received_at, to: 'Tessa McCall', subject: item.subject, bodyText: item.body_full || item.body_preview });
        ({ html, attachments } = require('../lib/email/tessa_signature').buildTessaEmail(sendBody, null, quoted));
        await graphSend.sendAs({ from, to, cc, subject, html, attachments });
      }
    } else {
      await graphSend.sendAs({ from, to, cc, subject, html, attachments });
    }

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
    res.json({ sent: true, from, to, cc, in_thread: sentInThread });
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
    const d = await handleForwarded({ incomingSubject: item.subject, incomingBody: item.body_full || item.body_preview, fromName: item.from_name || item.from_email, instruction, mode, receivedAt: item.received_at, attachmentNames: Array.isArray(item.attachment_names) ? item.attachment_names : [] });
    if (!d || d.degraded) return res.status(502).json({ error: 'draft_failed', detail: 'Tessa couldn’t draft that one. Try rephrasing the instruction.' });

    // A follow-up task, not an email: return the proposal for Ed to add. Nothing
    // is saved and nothing is sent here; the inbox item is unchanged.
    if (d.action === 'followup') {
      return res.json({ ok: true, action: 'followup', followup: d.followup, source: followupSource(item) });
    }
    // A delegation: return the PLAN (association, who sends it back, by when) for
    // Ed to confirm. Nothing is saved until he does.
    if (d.action === 'delegate') {
      const { planFromInbox } = require('../lib/ea/delegation_store');
      const { communityForThread } = require('../lib/ea/tessa_thread_community');
      const plan = await planFromInbox(item, { proposal: d.delegate || {}, edMailbox: graphSend.ED_MAILBOX, communityForThread });
      plan.form = (d.delegate && d.delegate.form) || null;
      return res.json({ ok: true, action: 'delegate', plan });
    }

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

    // Ed asked her to act on a Copied (FYI) message, so it is now a draft awaiting
    // his review (Needs review). Still nothing sends until he presses Send.
    const { isCopiedFyi } = require('../lib/ea/tessa_inbox');
    const patch = { draft_subject: d.subject, draft_body: d.body, draft_mode: d.mode, updated_at: new Date().toISOString() };
    if (isCopiedFyi(item)) patch.status = 'needs_review';
    const { error: upErr } = await supabase.from('ea_inbox').update(patch).eq('id', item.id);
    if (upErr) { console.error('[tessa] inbox handle save failed:', upErr.message); return res.status(500).json({ error: safeErrorMessage(upErr) }); }
    res.json({ ok: true, action: d.action, status: patch.status || item.status, subject: d.subject, body: d.body, mode: d.mode, to: toEmail, recipient_hint: d.recipient_hint || null, recipient, group });
  } catch (err) { console.error('[tessa] inbox handle failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// Where a follow-up came from, so the task carries the original email's context.
function followupSource(item) {
  const when = item.received_at ? new Date(item.received_at).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' }) : null;
  return `From ${item.from_name || item.from_email || 'unknown'}${item.from_email && item.from_name ? ` <${item.from_email}>` : ''}: "${item.subject || '(no subject)'}"${when ? `, ${when}` : ''}${item.addressed_as && item.addressed_as !== 'to' ? ' (Tessa was copied)' : ''}. Tessa inbox item ${item.id}.`;
}

// POST /inbox/:id/followup — Ed adds the follow-up Tessa proposed (or his own
// edit of it). Owner-only. Creates an ea_followups task whose detail names the
// source email; the email itself is not changed and nothing is sent.
router.post('/inbox/:id/followup', express.json(), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const { data: item, error: e0 } = await supabase.from('ea_inbox').select('id, from_email, from_name, subject, received_at, addressed_as').eq('id', req.params.id).maybeSingle();
    if (e0) throw e0;
    if (!item) return res.status(404).json({ error: 'not_found' });
    const { normalizeFollowup } = require('../lib/ea/tessa');
    const b = req.body || {};
    // Ed typed or confirmed this date himself, so it is his date: validate it, never drop it.
    const f = normalizeFollowup({ ...b, due_date: b.due_date }, { instruction: b.due_date ? String(b.due_date) : '' });
    if (!f) return res.status(400).json({ error: 'title_required' });
    if (b.due_date && !f.due_date) return res.status(400).json({ error: 'bad_due_date', detail: 'Use a real date (YYYY-MM-DD).' });
    const detail = [f.detail, followupSource(item)].filter(Boolean).join('\n\n');
    const { data, error } = await supabase.from('ea_followups').insert({
      title: f.title, detail, category: f.category, status: 'open', waiting_on: f.waiting_on, due_date: f.due_date,
      created_by: owner.full_name || owner.email || 'Ed',
    }).select('*').single();
    if (error) throw error;
    res.json({ ok: true, followup: data });
  } catch (err) { console.error('[tessa] inbox followup failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ---- Delegated follow-through (Ed 2026-10-19) --------------------------------
// A copied email becomes a delegation only when Ed confirms the plan. Every route
// is owner-only; each step's rules live in lib/ea/delegation.js and every step is
// written to the append-only audit (ea_followup_events). Nothing here sends an
// email, distributes a document or mails anything.
const DSTORE = () => require('../lib/ea/delegation_store');
const DFLOW = () => require('../lib/ea/delegation');
const ownerName = (u) => u.full_name || u.email || 'Ed';
const delegationErr = (res, e) => {
  const known = { not_found: 404, community_required: 400, expected_from_required: 400, already_delegated: 409, nothing_received: 409, no_hash: 409,
    not_checked: 409, hash_mismatch: 409, needs_person: 400, bad_verdict: 400, not_verified: 409, already_filed: 409, not_filed: 409, audit_write_failed: 500,
    association_unconfirmed: 409, document_unavailable: 502, filing_failed: 502 };
  if (e && known[e.code]) return res.status(known[e.code]).json({ error: e.code, detail: e.message, ...(e.id ? { id: e.id } : {}) });
  if (e && /ea_followup_events|column ea_followups.(kind|steps|community_id)|kind|schema cache/i.test(e.message || '') && /does not exist|schema cache|could not find/i.test(e.message || '')) {
    return res.status(409).json({ error: 'migration_537_required', detail: 'Delegations need migration 537. Nothing was changed.' });
  }
  console.error('[tessa] delegation failed:', e && e.message);
  return res.status(500).json({ error: safeErrorMessage(e) });
};
const delegationView = (d) => ({ ...d, current_step: DFLOW().currentStep(d.steps || {}), next_action: DFLOW().nextAction(d.steps || {}) });

// POST /inbox/:id/delegate — Ed confirms the plan Tessa proposed (association, who
// sends it back, due date, filing deadline). Creates the tracked delegation and
// picks up a reply that already arrived. The email itself is not changed.
router.post('/inbox/:id/delegate', express.json(), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const { data: item, error } = await supabase.from('ea_inbox').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!item) return res.status(404).json({ error: 'not_found' });
    const b = req.body || {};
    const { normalizeDelegate } = require('../lib/ea/tessa');
    // Ed typed or confirmed these dates himself, so they are his dates.
    const dates = normalizeDelegate({ due_date: b.due_date, deadline: b.deadline, tax_year: b.tax_year, document_label: b.document_label, form: b.form }, { context: `${b.due_date || ''} ${b.deadline || ''}` });
    if ((b.due_date && !dates.due_date) || (b.deadline && !dates.deadline)) return res.status(400).json({ error: 'bad_date', detail: 'Use real dates (YYYY-MM-DD).' });
    const { data: comm, error: ce } = b.community_id ? await supabase.from('communities').select('id, name').eq('id', b.community_id).maybeSingle() : { data: null, error: null };
    if (ce) throw ce;
    if (!comm) return res.status(400).json({ error: 'community_required', detail: 'Choose the association this belongs to.' });
    const expected = String(b.expected_from || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(expected)) return res.status(400).json({ error: 'expected_from_required', detail: 'Say who is sending it back (their email).' });
    const label = dates.document_label || 'signed document';
    const d = await DSTORE().createDelegation(supabase, { item, by: ownerName(owner), plan: {
      community_id: comm.id, expected_from: expected, document_label: label, tax_year: dates.tax_year, due_date: dates.due_date, deadline: dates.deadline,
      title: `${comm.name}: signed ${label} from ${expected}` } });
    res.json({ ok: true, delegation: delegationView(d) });
  } catch (e) { delegationErr(res, e); }
});

// GET /delegations — what Tessa is tracking, with each step and the next action.
router.get('/delegations', async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    let q = supabase.from('ea_followups').select('*, community:community_id(name)').eq('kind', DFLOW().KIND).order('created_at', { ascending: false }).limit(100);
    if (req.query.status !== 'all') q = q.in('status', DSTORE().OPEN);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ delegations: (data || []).map(delegationView) });
  } catch (e) { delegationErr(res, e); }
});

// GET /delegations/:id/events — the audit trail.
router.get('/delegations/:id/events', async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const { data, error } = await supabase.from('ea_followup_events').select('event, actor, detail, created_at').eq('followup_id', req.params.id).order('created_at', { ascending: true }).limit(500);
    if (error) throw error;
    res.json({ events: data || [] });
  } catch (e) { delegationErr(res, e); }
});

// The returned PDF, read from Tessa's mailbox (it is never copied out until filed).
async function returnedPdf(d) {
  const inboxId = d.steps.received && d.steps.received.inbox_id;
  const { data: msg, error } = await supabase.from('ea_inbox').select('id, graph_id').eq('id', inboxId).maybeSingle();
  if (error) throw error;
  if (!msg || !msg.graph_id) throw Object.assign(new Error('The email that brought the document is no longer on file.'), { code: 'not_found' });
  const { fetchAllAttachmentBuffers } = require('../lib/email/graph_attachments');
  const all = await fetchAllAttachmentBuffers(graphSend.TESSA_MAILBOX, msg.graph_id);
  if (all && all.listError) throw Object.assign(new Error(`Tessa's mailbox could not be read (${all.listError}). Nothing changed.`), { code: 'document_unavailable' });
  const files = (all || []).filter((f) => f.isPdf);
  const want = (req) => files.find((f) => f.filename === req) || null;
  return { files, want };
}

// POST /delegations/:id/check — Tessa reads the returned PDF and reports what she
// sees. ADVISORY: appears_signed / not_signed / uncertain. Verifies nothing.
router.post('/delegations/:id/check', express.json(), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const d = await DSTORE().loadDelegation(supabase, req.params.id);
    if (d.steps.received.state !== 'received_unverified') return res.status(409).json({ error: 'nothing_received', detail: 'Nothing has come back to check yet.' });
    const { files, want } = await returnedPdf(d);
    const file = (req.body && req.body.filename && want(req.body.filename)) || (files.length === 1 ? files[0] : null);
    if (!file) return res.status(409).json({ error: files.length ? 'choose_file' : 'no_pdf', detail: files.length ? 'More than one PDF came back. Choose which one to check.' : 'The PDF could not be read from Tessa\'s mailbox.', files: files.map((f) => f.filename) });
    const { data: comm, error: cErr } = await supabase.from('communities').select('name, legal_name, ein').eq('id', d.community_id).maybeSingle();
    if (cErr) throw cErr;
    const m = d.steps.meta || {};
    const { checkReturnedDocument } = require('../lib/ea/document_check');
    const r = await checkReturnedDocument({ buffer: file.buffer, filename: file.filename, expect: { form: (m.document_label || '').match(/1120-?H|1120|990|941|W-?9/i)?.[0] || null, tax_year: m.tax_year, entity: comm && (comm.legal_name || comm.name), ein: (comm && comm.ein) || null } });
    const steps = DFLOW().applyCheck(d.steps, { advisory: r.advisory, sha256: r.sha256, filename: file.filename });
    await DSTORE().recordEvent(supabase, d.id, 'document_checked', 'tessa', { filename: file.filename, sha256: r.sha256, advisory: r.advisory, requested_by: ownerName(owner) });
    const saved = await DSTORE().saveSteps(supabase, d, steps);
    res.json({ ok: true, advisory: r.advisory, sha256: r.sha256, filename: file.filename, delegation: delegationView(saved) });
  } catch (e) { delegationErr(res, e); }
});

// POST /delegations/:id/verify { verdict: 'signed'|'not_signed', sha256 } — Ed's
// decision on the exact file Tessa checked.
router.post('/delegations/:id/verify', express.json(), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const d = await DSTORE().loadDelegation(supabase, req.params.id);
    const b = req.body || {};
    const steps = DFLOW().applyOwnerVerify(d.steps, { verdict: b.verdict, sha256: b.sha256, by: ownerName(owner), associationConfirmed: b.association_confirmed === true });
    const adv = d.steps.signature.advisory || {};
    await DSTORE().recordEvent(supabase, d.id, b.verdict === 'signed' ? 'signature_verified' : 'signature_rejected', ownerName(owner), {
      sha256: b.sha256, filename: d.steps.signature.filename, community_id: d.community_id,
      advisory_verdict: adv.verdict || null, advisory_association_match: adv.association_match === undefined ? null : adv.association_match,
      association_confirmed_by: b.verdict === 'signed' ? (adv.association_match === true ? 'document' : ownerName(owner)) : null,
      note: b.note ? String(b.note).slice(0, 500) : null });
    const saved = await DSTORE().saveSteps(supabase, d, steps);
    res.json({ ok: true, delegation: delegationView(saved) });
  } catch (e) { delegationErr(res, e); }
});

// POST /delegations/:id/file — the verified return goes into that association's
// tax records (library_documents, category tax_return, internal only), from the
// exact file Ed verified. Re-fetched and re-hashed: a different file is refused.
router.post('/delegations/:id/file', express.json(), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const d = await DSTORE().loadDelegation(supabase, req.params.id);
    DFLOW().assertCanFile(d.steps);
    const { want } = await returnedPdf(d);
    const file = want(d.steps.signature.filename);
    const { sha256 } = require('../lib/ea/document_check');
    if (!file || sha256(file.buffer) !== d.steps.signature.sha256) return res.status(409).json({ error: 'hash_mismatch', detail: 'The file in the mailbox is not the one you verified. Nothing was filed.' });
    const m = d.steps.meta || {};
    const { data: comm, error: ce } = await supabase.from('communities').select('name').eq('id', d.community_id).maybeSingle();
    if (ce) throw ce;
    const title = `${m.tax_year ? m.tax_year + ' ' : ''}${(m.document_label || 'Tax Return').replace(/^\d{4}\s+/, '')} (signed)`;
    const { fileContractDocument } = require('../lib/contracts/intake');
    let filed;
    try { filed = await fileContractDocument(supabase, { community_id: d.community_id, buffer: file.buffer, filename: file.filename, mimetype: 'application/pdf', category: 'tax_return', title,
      notes: `Signed copy returned by ${m.expected_from || 'the signer'}; signature confirmed by ${d.steps.signature.verified_by} on ${String(d.steps.signature.verified_at).slice(0, 10)}. Filed from Tessa (delegation ${d.id}).` }); }
    catch (fe) { console.error('[tessa] filing failed:', fe.message); throw Object.assign(new Error(`The return could not be saved to the association's records (${fe.code || 'storage'}). Nothing was filed; try again.`), { code: 'filing_failed' }); }
    const { error: ue } = await supabase.from('library_documents').update({ approval_status: 'signed', member_scope: 'internal_only', period_label: m.tax_year || null }).eq('id', filed.library_document_id);
    if (ue) { console.error('[tessa] filed document could not be marked signed/internal:', ue.message); throw Object.assign(new Error('The return was saved but could not be marked signed and internal-only. It is not counted as filed; try again.'), { code: 'filing_failed' }); }
    const steps = DFLOW().applyFiled(d.steps, { libraryDocumentId: filed.library_document_id, by: ownerName(owner) });
    await DSTORE().recordEvent(supabase, d.id, 'filed', ownerName(owner), { library_document_id: filed.library_document_id, file_hash: filed.file_hash, reused: filed.reused, community: comm && comm.name, category: 'tax_return' });
    const saved = await DSTORE().saveSteps(supabase, d, steps);
    res.json({ ok: true, library_document_id: filed.library_document_id, delegation: delegationView(saved) });
  } catch (e) { delegationErr(res, e); }
});

// POST /delegations/:id/assign-mailing { assigned_to } — Ed hands printing and
// mailing to a named staff member as a Mission Control task. Tessa preparing this
// is NOT mailing: the step completes only when that person closes the task.
router.post('/delegations/:id/assign-mailing', express.json(), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const d = await DSTORE().loadDelegation(supabase, req.params.id);
    DFLOW().assertCanAssign(d.steps);
    // Assign a USER by stable id; the name is display only. The person must be an
    // active staff account. (Ed 2026-10-19: names are not identities.)
    const assignedUserId = String((req.body && req.body.assigned_user_id) || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(assignedUserId)) return res.status(400).json({ error: 'needs_person', detail: 'Choose a staff member from the list.' });
    const { data: who, error: we } = await supabase.from('user_profiles').select('id, full_name, email, role, is_active').eq('id', assignedUserId).maybeSingle();
    if (we) throw we;
    if (!who || who.is_active === false || !who.role) return res.status(400).json({ error: 'needs_person', detail: 'That person is not an active staff account.' });
    const assignee = { id: who.id, name: who.full_name || who.email, email: who.email || null };
    const assignedTo = assignee.name;
    const m = d.steps.meta || {};
    const { data: comm, error: ce } = await supabase.from('communities').select('name').eq('id', d.community_id).maybeSingle();
    if (ce) throw ce;
    const label = m.document_label || 'tax return';
    DFLOW().applyAssigned(d.steps, { workItemId: 'pending', assignee, by: ownerName(owner) });   // validate before creating the task
    const { upsertAgentTask } = require('./mission_control');
    const task = await upsertAgentTask({
      source_ref: `tessa:delegation:${d.id}:mail`, title: `Print and mail ${comm ? comm.name + ' ' : ''}${label} to the IRS`,
      community_id: d.community_id, assigned_to: assignedTo, requested_by: ownerName(owner), item_type: 'task', urgency: m.deadline ? 'high' : 'normal',
      library_document_id: d.steps.filed.library_document_id,
      why: `The signed ${label} is filed in ${comm ? comm.name + "'s" : 'the association\'s'} tax records and needs to be mailed to the IRS.`,
      next_step: 'Click Open: print the return, mail it to the IRS address for this form, then record the mailed date, method and tracking / certified number there. Closing this task without that record does not count as mailed.',
      evidence_required: 'Mailed date, mailing method, certified tracking number if certified, and who mailed it. Keep the mailing receipt.',
      sla_due_at: new Date(Date.now() + DFLOW().MAIL_DAYS * 864e5).toISOString(),
    });
    if (!task || !task.id) return res.status(502).json({ error: 'task_not_created', detail: 'The Mission Control task could not be created. Nothing was assigned.' });
    // The assignee's "Open" link: the return, the instructions and the mailing form, nothing else.
    const { error: linkErr } = await supabase.from('work_items').update({ action_url: `/app/irs-mailing?task=${task.id}` }).eq('id', task.id);
    if (linkErr) return res.status(502).json({ error: 'task_not_created', detail: 'The task was created but its link could not be saved. Nothing was assigned; try again.' });
    const steps = DFLOW().applyAssigned(d.steps, { workItemId: task.id, assignee, by: ownerName(owner) });
    await DSTORE().recordEvent(supabase, d.id, 'mailing_assigned', ownerName(owner), { work_item_id: task.id, assigned_user_id: assignee.id, assigned_to: assignedTo, library_document_id: d.steps.filed.library_document_id });
    const saved = await DSTORE().saveSteps(supabase, d, steps);
    res.json({ ok: true, work_item_id: task.id, delegation: delegationView(saved) });
  } catch (e) { delegationErr(res, e); }
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
const OUTBOX_COLS = 'id, kind, status, meeting_mode, title, note, to_emails, cc_emails, subject, body_text, attachment_name, attachment_mime, attachment_path, attachment_bucket, organizer, meeting_start, meeting_end, meeting_time_zone, meeting_location, meeting_attendees, result, send_error, created_at, sent_at';

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
      if (await refuseBounced(res, [...to, ...cc])) return;

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
    // Mode: null on rows staged before 2026-10-06 = the legacy Teams invite.
    const mmode = item.meeting_mode || 'online';
    const attendees = mmode === 'calendar_only' ? [] : parseAddrs(item.meeting_attendees);
    if (mmode !== 'calendar_only' && !attendees.length) return res.status(400).json({ error: 'no valid attendees on this meeting' });
    if (attendees.length && await refuseBounced(res, attendees)) return;
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
        online: mmode === 'online',
        // Ed's calendar is always checked (he is in every meeting Tessa sets up),
        // plus the organizer's.
        conflictMailboxes: [graphSend.ED_MAILBOX, item.organizer || graphSend.TESSA_MAILBOX],
        allowConflict: (req.body || {}).allow_conflict === true,
      });
    } catch (e) {
      // A conflict is Ed's call, not an error: the item stays queued, nothing written.
      if (e.code === 'calendar_conflict') return res.status(409).json({ error: 'conflict', message: e.message, conflicts: e.conflicts });
      // Could not re-read the calendar: refuse, and leave the item queued to retry.
      if (e.code === 'calendar_read_failed') return res.status(502).json({ error: e.message });
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

// ---------------------------------------------------------------------------
// LUNCH — Tessa collects the team/guest lunch order, then assembles it for Ed.
// Owner-only. She emails + captures replies; the actual placement on Lunchdrop
// is a supervised browser step on Ed's own session (never here). See
// lib/ea/lunch*.js and migration 407.
// ---------------------------------------------------------------------------
// Start a round: create it + email each recipient as Tessa.
router.post('/lunch/round', express.json({ limit: '32kb' }), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const { createRound, sendInvites } = require('../lib/ea/lunch');
    const b = req.body || {};
    const { round, invited } = await createRound({
      title: b.title, restaurant: b.restaurant, lunch_date: b.lunch_date,
      order_url: b.order_url, deadline: b.deadline, recipients: b.recipients,
      created_by: owner.email || undefined,
    });
    let sends = [];
    if (b.send !== false) sends = await sendInvites(round, { menuText: b.menuText });
    res.json({ ok: true, round, invited: invited.length, sends });
  } catch (err) { console.error('[tessa] lunch round failed:', err.message); res.status(err.code === 'invalid_input' ? 400 : 500).json({ error: safeErrorMessage(err) }); }
});

// A round's current state (who's in, who's waiting, the assembled summary).
router.get('/lunch/round/:id', async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const { assembleOrder } = require('../lib/ea/lunch');
    res.json({ ok: true, ...(await assembleOrder(req.params.id)) });
  } catch (err) { res.status(err.code === 'invalid_input' ? 404 : 500).json({ error: safeErrorMessage(err) }); }
});

// Recent rounds (for the Tessa page).
router.get('/lunch/rounds', async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const { data, error } = await supabase.from('lunch_order_rounds').select('*').order('created_at', { ascending: false }).limit(25);
    if (error) throw error;
    res.json({ ok: true, rounds: data || [] });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// Poll Tessa's mailbox for replies to lunch rounds and record each order.
router.post('/lunch/poll-inbox', express.json({ limit: '4kb' }), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const { pollLunchInbox } = require('../lib/ea/lunch_inbox');
    res.json({ ok: true, stats: await pollLunchInbox({ max: (req.body && req.body.max) || 40 }) });
  } catch (err) { console.error('[tessa] lunch poll failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// Assemble the responses and email the order to Ed for approve-to-place.
router.post('/lunch/round/:id/assemble', express.json({ limit: '4kb' }), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const { sendAssemblyToEd } = require('../lib/ea/lunch');
    res.json({ ok: true, ...(await sendAssemblyToEd(req.params.id)) });
  } catch (err) { console.error('[tessa] lunch assemble failed:', err.message); res.status(err.code === 'invalid_input' ? 404 : 500).json({ error: safeErrorMessage(err) }); }
});

// Capture scraped Lunchdrop menus into the cache Tessa answers from. A browser
// (scheduled job on Ed's signed-in session, or an on-demand run) posts the
// week's days/restaurants/items here — the server can't read Lunchdrop itself.
router.post('/lunch/menu-capture', express.json({ limit: '512kb' }), async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const b = req.body || {};
    const office = String(b.office || 'boxer');
    const days = Array.isArray(b.days) ? b.days : [];
    const rows = [];
    for (const d of days) {
      const date = String(d.date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      for (const r of (Array.isArray(d.restaurants) ? d.restaurants : [])) {
        if (!r || !r.slug) continue;
        rows.push({
          office, lunch_date: date,
          restaurant_name: r.name || null, restaurant_slug: String(r.slug),
          order_url: r.url || null, cutoff_text: r.cutoff || null,
          items: Array.isArray(r.items) ? r.items.slice(0, 200) : [],
          captured_at: new Date().toISOString(),
        });
      }
    }
    if (!rows.length) return res.status(400).json({ error: 'no_menu_rows' });
    const { error } = await supabase.from('lunch_menu_cache').upsert(rows, { onConflict: 'office,lunch_date,restaurant_slug' });
    if (error) throw error;
    res.json({ ok: true, captured: rows.length, dates: [...new Set(rows.map((r) => r.lunch_date))] });
  } catch (err) { console.error('[tessa] menu capture failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

module.exports = { router, searchContacts, resolveRecipient, resolveMeetingWallTimes, parseMonthDay };
