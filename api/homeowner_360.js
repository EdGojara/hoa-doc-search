// ============================================================================
// api/homeowner_360.js — the Homeowner 360 (Ed 2026-07-05)
// ----------------------------------------------------------------------------
// One searchable screen that pulls up EVERYTHING about a homeowner — identity,
// balance/payments, violations, ARC, every letter/email/call, and an AI recap
// of who they are and what to know before you talk to them. Built for the
// moment a homeowner calls or emails: search a name/address/email/phone → full
// context in one place, no digging across tabs or systems.
//
// It's pure assembly + judgment over data that already lives in trustEd (the
// interactions ledger, violations, AR, email hub). Each source is fetched
// defensively so one missing/empty source (e.g. email_messages before its
// migration) never blanks the whole profile.
//
// Mounted at /api/homeowner:
//   GET /search?q=            name / address / email / phone → candidate people
//   GET /profile/:contactId   assembled 360 (no AI — fast)
//   GET /recap/:contactId     AI briefing over the assembled 360
// ============================================================================
const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { evaluateAmenityAccess } = require('../lib/ar/amenity_access');
const Anthropic = require('@anthropic-ai/sdk');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// Run a query, return [] on any error (missing table/column) so the profile
// degrades gracefully instead of 500-ing on one weak source.
async function safe(fn) { try { const { data, error } = await fn(); if (error) return []; return data || []; } catch (_) { return []; } }

// contact -> their current properties (+ community)
async function ownedProperties(contactId) {
  const owns = await safe(() => supabase.from('property_ownerships')
    .select('property_id, is_primary, end_date, properties(id, street_address, unit, community_id, communities(name))')
    .eq('contact_id', contactId).is('end_date', null));
  return owns.filter((o) => o.properties).map((o) => ({
    property_id: o.property_id,
    address: o.properties.street_address + (o.properties.unit ? ' #' + o.properties.unit : ''),
    community_id: o.properties.community_id,
    community: o.properties.communities ? o.properties.communities.name : null,
    is_primary: o.is_primary,
  }));
}

// GET /search — name / address / email / phone → candidate homeowners
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });
    const like = `%${q}%`;
    // contacts by name/email/phone
    const contacts = await safe(() => supabase.from('contacts')
      .select('id, full_name, primary_email, primary_phone, secondary_email')
      .or(`full_name.ilike.${like},primary_email.ilike.${like},secondary_email.ilike.${like},primary_phone.ilike.${like}`).limit(25));
    // contacts by property address (via ownership)
    const props = await safe(() => supabase.from('properties').select('id').ilike('street_address', like).limit(25));
    let addrContacts = [];
    if (props.length) {
      const owns = await safe(() => supabase.from('property_ownerships')
        .select('contact_id, contacts(id, full_name, primary_email, primary_phone)')
        .in('property_id', props.map((p) => p.id)).is('end_date', null).limit(40));
      addrContacts = owns.filter((o) => o.contacts).map((o) => o.contacts);
    }
    const byId = {};
    [...contacts, ...addrContacts].forEach((c) => { if (c && c.id) byId[c.id] = c; });
    // attach one property line per contact for disambiguation
    const results = [];
    for (const c of Object.values(byId).slice(0, 30)) {
      const ps = await ownedProperties(c.id);
      results.push({
        contact_id: c.id, name: c.full_name, email: c.primary_email || c.secondary_email || null, phone: c.primary_phone || null,
        properties: ps.map((p) => p.address), community: ps[0] ? ps[0].community : null,
      });
    }
    results.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    res.json({ results });
  } catch (err) {
    console.error('[homeowner360] search failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Assemble the full 360 (shared by /profile and /recap).
async function assemble(contactId) {
  const contactRows = await safe(() => supabase.from('contacts')
    .select('id, full_name, preferred_name, primary_email, secondary_email, primary_phone, mailing_address, preferred_language, vantaca_account_id')
    .eq('id', contactId).limit(1));
  const contact = contactRows[0];
  if (!contact) return null;
  const properties = await ownedProperties(contactId);
  const propIds = properties.map((p) => p.property_id);

  // AR: current balance (sum across their properties) + recent transactions
  const balRows = propIds.length ? await safe(() => supabase.from('v_homeowner_current_balance').select('balance_cents, property_id, most_recent_txn_date').in('property_id', propIds)) : [];
  const balance_cents = balRows.reduce((s, r) => s + (Number(r.balance_cents) || 0), 0);
  const txns = propIds.length ? await safe(() => supabase.from('homeowner_transactions')
    .select('transaction_date, description, amount_cents, txn_type, charge_category, running_balance_cents')
    .in('property_id', propIds).order('transaction_date', { ascending: false }).limit(25)) : [];

  // Enforcement flags (SSOT) — open states
  const flags = propIds.length ? await safe(() => supabase.from('property_enforcement_states')
    .select('state, started_at, ended_at, property_id').in('property_id', propIds).is('ended_at', null)) : [];

  // Collection / legal status (ar_account_collections SSOT). STAFF-ONLY — this
  // is never returned by the homeowner portal (portal.js does not read this
  // table), and must not be. Surfaces where an account sits in the escalation
  // ladder (with_attorney / lien_filed / foreclosure / bankruptcy), the date
  // that status began, bankruptcy petition data, and the Winstead notes (which
  // carry the latest action + the date it was mailed).
  const collections = propIds.length ? await safe(() => supabase.from('ar_account_collections')
    .select('property_id, collection_status, status_since, bankruptcy_petition_date, bankruptcy_chapter, bankruptcy_case_number, bankruptcy_dismissed_date, bankruptcy_discharge_date, notes, updated_at')
    .in('property_id', propIds).neq('collection_status', 'none')) : [];

  // Violations (+ category label), newest first
  let violations = propIds.length ? await safe(() => supabase.from('violations')
    .select('id, current_stage, opened_at, resolved_at, resolved_via, primary_category_id, property_id, opened_from_observation_id')
    .in('property_id', propIds).order('opened_at', { ascending: false }).limit(50)) : [];
  const catIds = [...new Set(violations.map((v) => v.primary_category_id).filter(Boolean))];
  const cats = catIds.length ? await safe(() => supabase.from('enforcement_categories').select('id, label').in('id', catIds)) : [];
  const catLabel = Object.fromEntries(cats.map((c) => [c.id, c.label]));

  // Pull the observation behind each violation → the specific detail (what was
  // actually seen) + the inspection photo. This is what staff need on a call:
  // not "Lawn maintenance" but "brown/dead patches in the front & side lawn"
  // plus the photo the inspector took.
  const obsIds = [...new Set(violations.map((v) => v.opened_from_observation_id).filter(Boolean))];
  const obs = obsIds.length ? await safe(() => supabase.from('property_observations')
    .select('id, ai_description, inspection_photo_id').in('id', obsIds)) : [];
  const obsById = Object.fromEntries(obs.map((o) => [o.id, o]));
  const photoIds = [...new Set(obs.map((o) => o.inspection_photo_id).filter(Boolean))];
  const photos = photoIds.length ? await safe(() => supabase.from('inspection_photos')
    .select('id, storage_path, captured_at').in('id', photoIds)) : [];
  const photoById = Object.fromEntries(photos.map((p) => [p.id, p]));

  violations = violations.map((v) => {
    const o = obsById[v.opened_from_observation_id];
    const ph = o && o.inspection_photo_id ? photoById[o.inspection_photo_id] : null;
    return {
      ...v,
      category: catLabel[v.primary_category_id] || 'Violation',
      open: !v.resolved_at,
      detail: o ? o.ai_description : null,
      photo_path: ph ? ph.storage_path : null,
      photo_captured_at: ph ? ph.captured_at : null,
    };
  });

  // ARC (defensive — table may be empty / shape unknown)
  const arc = propIds.length ? await safe(() => supabase.from('arc_applications').select('*').in('property_id', propIds).limit(25)) : [];

  // Correspondence: interactions (letters/calls/notes) + emails from the hub
  const interactions = await safe(() => supabase.from('interactions')
    .select('id, type, direction, subject, content, delivery_method, sent_at, created_at, violation_id')
    .or(`contact_id.eq.${contactId}${propIds.length ? ',property_id.in.(' + propIds.join(',') + ')' : ''}`)
    .order('created_at', { ascending: false }).limit(60));
  const emails = await safe(() => supabase.from('email_messages')
    .select('direction, sender_email, subject, ai_summary, classification, received_at')
    .eq('resolved_contact_id', contactId).order('received_at', { ascending: false }).limit(40));

  // Phone calls Claire / the team handled (voice log), linked by caller.
  const calls = await safe(() => supabase.from('homeowner_calls')
    .select('started_at, ended_at, duration_seconds, status, brief, caller_phone')
    .eq('caller_homeowner_id', contactId).order('started_at', { ascending: false }).limit(30));

  // Pool access — fob (key-tag) registrations + extended-hours approvals
  const poolAccess = propIds.length ? await safe(() => supabase.from('pool_access')
    .select('form_type, fob_tag_number, season_year, extended_hours_detail, authorized_persons, status, form_signed_date')
    .in('property_id', propIds).order('status', { ascending: true }).limit(50)) : [];

  // Payment plans (payment_plans, mig 273) — the arrangement to pay a balance
  // down in installments. Active first so the current plan is on top.
  const paymentPlans = propIds.length ? await safe(() => supabase.from('payment_plans')
    .select('id, status, total_amount_cents, down_payment_cents, installment_amount_cents, num_installments, frequency, start_date, next_due_date, end_date, balance_remaining_cents, terms_summary, source_document_path, updated_at')
    .in('property_id', propIds).order('status', { ascending: true }).order('updated_at', { ascending: false }).limit(20)) : [];

  // Map each violation to the letter PDF that was actually sent for it (from the
  // interactions ledger), so the 360 can link the real letter right on the
  // violation row — next to the photo.
  const letterByViolation = {};
  for (const it of (interactions || [])) {
    if (it.violation_id && it.content && /\.pdf$/i.test(it.content) && /letter/i.test(it.type || '')) {
      if (!letterByViolation[it.violation_id]) letterByViolation[it.violation_id] = it.content;
    }
  }
  violations = violations.map((v) => ({ ...v, letter_path: letterByViolation[v.id] || null }));

  // Assessment-delinquency / amenity-access status — the SAME engine the pool
  // gate uses, so 360 shows exactly what would block a fob. Assessments only
  // (not fines/late/interest), never in bankruptcy or on a plan.
  let amenity = null;
  const primaryProp = properties.find((p) => p.is_primary) || properties[0];
  if (primaryProp) {
    try { amenity = await evaluateAmenityAccess(supabase, { propertyId: primaryProp.property_id, communityId: primaryProp.community_id }); } catch (_) {}
  }

  return { contact, properties, ar: { balance_cents, transactions: txns }, amenity, flags, collections, violations, arc, interactions, emails, calls, poolAccess, paymentPlans };
}

// GET /profile/:contactId — the assembled 360 (fast, no AI)
router.get('/profile/:contactId', async (req, res) => {
  try {
    const data = await assemble(req.params.contactId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json(data);
  } catch (err) {
    console.error('[homeowner360] profile failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /file?kind=letter|photo&path=<storage_path>
// Serves the actual artifact behind a 360 row: the violation-letter PDF that
// was sent (interactions.content, bucket 'violation-letters') or the inspection
// photo (inspection_photos.storage_path, bucket 'documents'). Redirects to a
// short-lived signed URL so staff can open/print/discuss it. Staff-gated by the
// global staff cookie (the 360 is a staff surface). kind→bucket is allowlisted.
const FILE_BUCKETS = { letter: 'violation-letters', photo: 'documents', document: 'documents' };
router.get('/file', async (req, res) => {
  try {
    const bucket = FILE_BUCKETS[req.query.kind];
    const path = req.query.path;
    if (!bucket || !path) return res.status(400).json({ error: 'kind (letter|photo) and path required' });
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(String(path), 60 * 60);
    if (error || !data || !data.signedUrl) return res.status(404).json({ error: 'file_not_found' });
    res.redirect(data.signedUrl);
  } catch (err) {
    console.error('[homeowner360] file failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /recap/:contactId — AI briefing: who they are + what to know before you
// talk to them. Grounded strictly in the assembled data (never invents).
router.get('/recap/:contactId', async (req, res) => {
  try {
    const d = await assemble(req.params.contactId);
    if (!d) return res.status(404).json({ error: 'not_found' });
    const money = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const openV = d.violations.filter((v) => v.open);
    const facts = `Today's date: ${new Date().toISOString().slice(0, 10)} (use for any recency judgment; do not guess relative dates)
HOMEOWNER: ${d.contact.full_name}
Properties: ${d.properties.map((p) => p.address + (p.community ? ` (${p.community})` : '')).join('; ') || 'none on file'}
Current balance: ${money(d.ar.balance_cents)} ${d.ar.balance_cents > 0 ? '(owes)' : d.ar.balance_cents < 0 ? '(credit)' : ''}
Enforcement flags: ${d.flags.map((f) => f.state).join(', ') || 'none'}
Legal / collection status (STAFF-ONLY, at attorney): ${(d.collections || []).map((c) => `${c.collection_status}${c.status_since ? ' since ' + String(c.status_since).slice(0, 10) : ''}${c.collection_status === 'bankruptcy' ? ' — AUTOMATIC STAY, do not attempt to collect or send notices' : ''}${c.notes ? ' — ' + String(c.notes).slice(0, 160) : ''}`).join(' | ') || 'none'}
Payment plan: ${(d.paymentPlans || []).filter((p) => p.status === 'active').map((p) => `ACTIVE — ${p.installment_amount_cents ? money(p.installment_amount_cents) + '/' + (p.frequency || 'monthly') : 'installments'}${p.num_installments ? ' x' + p.num_installments : ''}${p.next_due_date ? ', next due ' + String(p.next_due_date).slice(0, 10) : ''}${p.terms_summary ? ' — ' + String(p.terms_summary).slice(0, 140) : ''}`).join(' | ') || 'none on file'}
Open violations (${openV.length}): ${openV.map((v) => `${v.category} @ ${v.current_stage}, opened ${(v.opened_at || '').slice(0, 10)}`).join('; ') || 'none'}
Violation history (${d.violations.length} total): ${d.violations.slice(0, 12).map((v) => `${v.category} [${v.open ? 'open ' + v.current_stage : 'resolved'}]`).join('; ')}
Recent payments/charges: ${d.ar.transactions.slice(0, 8).map((t) => `${(t.transaction_date || '').slice(0, 10)} ${t.txn_type || ''} ${money(Number(t.amount_cents) || 0)}`).join('; ') || 'none'}
ARC submissions: ${d.arc.length}
Phone calls (${d.calls.length}): ${d.calls.slice(0, 6).map((c) => `${(c.started_at || '').slice(0, 10)} ${c.status || ''}${c.brief ? ' — ' + String(c.brief).slice(0, 80) : ''}`).join('; ') || 'none'}
Recent correspondence: ${[...d.interactions.slice(0, 10).map((i) => `${(i.created_at || '').slice(0, 10)} ${i.type} ${i.direction}${i.subject ? ' — ' + i.subject : ''}`), ...d.emails.slice(0, 8).map((e) => `${(e.received_at || '').slice(0, 10)} email ${e.direction} — ${e.ai_summary || e.subject || ''}`)].join(' | ') || 'none'}`;

    const sys = `You are briefing a Bedrock Association Management team member who is about to talk to this homeowner (they just called or emailed). Write a SHORT internal briefing — direct, factual, no fluff. Ground EVERYTHING strictly in the facts provided; never invent history, amounts, or temperament that isn't in the data. If something isn't in the data, don't mention it.

Cover, in a few tight sentences (not a list unless it helps):
- Who they are (property, community, how long if known).
- Money: do they owe, are they current, any collections/legal flag.
- Enforcement: any open violations and what they're for; whether there's a pattern (repeat categories) or they resolve quickly.
- Anything they've raised themselves (complaints/requests in the correspondence).
- The single most important thing to know before this conversation.

If the record is thin, say so plainly ("Not much history on file"). No greeting, no sign-off — just the briefing.`;

    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 500,
      system: sys,
      messages: [{ role: 'user', content: [{ type: 'text', text: facts }] }],
    });
    res.json({ recap: (resp.content[0] && resp.content[0].text || '').trim() });
  } catch (err) {
    console.error('[homeowner360] recap failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /:contactId/note — add a staff note. Writes to the canonical interactions
// ledger (type internal_note) so it shows on the 360 AND anywhere else that
// reads the ledger — one source of truth, no Vantaca-style silo. Linked to the
// homeowner's primary property + community for consistent scoping.
router.post('/:contactId/note', express.json(), async (req, res) => {
  try {
    const body = (req.body && req.body.content ? String(req.body.content) : '').trim();
    if (!body) return res.status(400).json({ error: 'content_required' });
    const props = await ownedProperties(req.params.contactId);
    const primary = props.find((p) => p.is_primary) || props[0] || null;
    const { data, error } = await supabase.from('interactions').insert({
      type: 'internal_note', direction: 'internal',
      contact_id: req.params.contactId,
      property_id: primary ? primary.property_id : null,
      community_id: primary ? primary.community_id : null,
      subject: (req.body && req.body.subject) ? String(req.body.subject).slice(0, 200) : 'Note',
      content: body,
      source: 'manual',
      notes: 'via Homeowner 360',
    }).select('id, created_at').single();
    if (error) throw error;
    res.json({ ok: true, note: data });
  } catch (err) {
    console.error('[homeowner360] note failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// DELETE /note/:id — remove a staff note (mistake / no longer needed). Guarded:
// only deletes interactions of type internal_note, so letters/emails/calls and
// other record entries can never be deleted from here.
router.delete('/note/:id', async (req, res) => {
  try {
    const { data: row } = await supabase.from('interactions').select('id, type').eq('id', req.params.id).maybeSingle();
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.type !== 'internal_note') return res.status(403).json({ error: 'only_notes_deletable', detail: 'Only staff notes can be deleted here; correspondence records cannot.' });
    const { error } = await supabase.from('interactions').delete().eq('id', req.params.id).eq('type', 'internal_note');
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[homeowner360] note delete failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Parse an uploaded email file (.msg via @kenjiuno/msgreader, .eml via
// mailparser) into a flat shape. Internal Exchange senders come as an X.500
// legacyDN, not SMTP — keep the name, drop the unusable address.
async function parseEmailFile(file) {
  const name = (file.originalname || '').toLowerCase();
  let subject = '', body = '', senderEmail = null, senderName = null, dateISO = null;
  if (name.endsWith('.eml') || /message\/rfc822/.test(file.mimetype || '')) {
    const { simpleParser } = require('mailparser');
    const p = await simpleParser(file.buffer);
    subject = p.subject || ''; body = p.text || (p.html ? String(p.html).replace(/<[^>]+>/g, ' ') : '');
    dateISO = p.date ? new Date(p.date).toISOString() : null;
    const f = p.from && p.from.value && p.from.value[0]; if (f) { senderEmail = f.address || null; senderName = f.name || null; }
  } else {
    const MsgReader = require('@kenjiuno/msgreader').default || require('@kenjiuno/msgreader');
    const d = new MsgReader(file.buffer).getFileData();
    subject = d.subject || ''; body = d.body || ''; senderName = d.senderName || null;
    senderEmail = (d.senderEmail && !/^\/o=/i.test(d.senderEmail)) ? d.senderEmail : null;
    const dt = d.messageDeliveryTime || d.clientSubmitTime || d.creationTime;
    dateISO = dt ? new Date(dt).toISOString() : null;
  }
  return { subject, body, senderEmail, senderName, dateISO };
}

// Resolve who an email is FROM (sender → contact) and who it's ABOUT (a property
// address in the body → its owner). Two distinct homeowners in the neighbor-
// complaint case. Returns { from, about } — each { contact_id, name, property_id, address } or null.
async function resolveFromAbout(parsed, addresses) {
  const out = { from: null, about: null };
  if (parsed.senderEmail && !/@bedrocktx\.com$/i.test(parsed.senderEmail)) {
    const { data } = await supabase.from('contacts').select('id, full_name')
      .or(`primary_email.ilike.${parsed.senderEmail},secondary_email.ilike.${parsed.senderEmail}`).limit(1);
    if (data && data[0]) { const owns = await ownedProperties(data[0].id); const pr = owns[0] || null; out.from = { contact_id: data[0].id, name: data[0].full_name, property_id: pr ? pr.property_id : null, address: pr ? pr.address : null }; }
  }
  for (const addr of (addresses || [])) {
    const num = (String(addr).match(/^\s*(\d{2,6})/) || [])[1];
    const street = String(addr).replace(/^\s*\d+\s*/, '').replace(/,.*$/, '').trim().split(/\s+/).slice(0, 2).join(' ');
    if (!num || !street) continue;
    const { data: props } = await supabase.from('properties').select('id, street_address, community_id').ilike('street_address', `${num} ${street}%`).limit(3);
    const p = (props || []).find((x) => x.street_address.trim().startsWith(num));
    if (p) {
      if (out.from && out.from.property_id === p.id) break; // same as sender's own property → not a separate "about"
      const { data: owns } = await supabase.from('property_ownerships').select('contact_id, contacts(full_name)').eq('property_id', p.id).is('end_date', null).limit(1);
      out.about = { property_id: p.id, address: p.street_address, contact_id: owns && owns[0] ? owns[0].contact_id : null, name: owns && owns[0] && owns[0].contacts ? owns[0].contacts.full_name : null };
      break;
    }
  }
  return out;
}

// POST /import-review — upload an email, don't file it yet: parse + classify +
// figure out who it's FROM and who it's ABOUT, and return the proposal for the
// operator to confirm (a neighbor complaint can file to both).
router.post('/import-review', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    const parsed = await parseEmailFile(req.file);
    const { classifyAndExtract } = require('../lib/email/triage');
    let ex = { classification: 'other', addresses: [] };
    try { ex = await classifyAndExtract({ subject: parsed.subject, body_full: parsed.body, sender_email: parsed.senderEmail }); } catch (_) {}
    const fa = await resolveFromAbout(parsed, ex.addresses);
    const isOut = (parsed.senderEmail && /@bedrocktx\.com$/i.test(parsed.senderEmail)) || (!parsed.senderEmail && /bedrock|violations|acc|admin|info|accounting/i.test(parsed.senderName || ''));
    res.json({
      email: { subject: parsed.subject || '(no subject)', body_preview: String(parsed.body).replace(/\s+/g, ' ').trim().slice(0, 2000), sender_email: parsed.senderEmail, sender_name: parsed.senderName, received_at: parsed.dateISO, direction: isOut ? 'outbound' : 'inbound' },
      classification: ex.classification, summary: ex.summary || parsed.subject,
      from: fa.from, about: fa.about,
    });
  } catch (err) {
    console.error('[homeowner360] import-review failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /import-file — file the reviewed email onto the confirmed homeowner(s).
// One row per link (role 'from'/'about') so it shows on each homeowner's 360.
router.post('/import-file', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const { email, classification, links } = req.body || {};
    if (!email || !Array.isArray(links) || !links.length) return res.status(400).json({ error: 'email_and_links_required' });
    let filed = 0;
    for (const l of links) {
      if (!l.contact_id && !l.property_id) continue;
      let community_id = l.community_id || null;
      if (!community_id && l.property_id) { const { data } = await supabase.from('properties').select('community_id').eq('id', l.property_id).maybeSingle(); community_id = data ? data.community_id : null; }
      const { error } = await supabase.from('email_messages').insert({
        mailbox: 'imported', direction: email.direction || 'inbound',
        sender_email: email.sender_email || null, sender_name: email.sender_name || null, recipients: [],
        subject: email.subject || '(no subject)', body_preview: (email.body_preview || '').slice(0, 2000),
        received_at: email.received_at || null, has_attachments: false,
        classification: classification || 'imported', classification_confidence: 'high',
        ai_summary: `Imported: ${(email.subject || '').slice(0, 120)}`,
        extracted: { imported: true, role: l.role || 'from' },
        community_id, resolved_contact_id: l.contact_id || null, resolved_property_id: l.property_id || null,
        resolution_confidence: 'high', triage_status: 'linked', record_ownership: 'association_record',
      });
      if (!error) filed += 1;
    }
    res.json({ ok: true, filed });
  } catch (err) {
    console.error('[homeowner360] import-file failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
