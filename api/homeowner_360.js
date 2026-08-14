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

// GET /by-property/:propertyId — resolve a property to its CURRENT owner
// contact, so any list that carries a property_id can deep-link straight into
// the 360 (?property=<id>). Keys off trustEd's OWN properties.id (the Vantaca
// property id is a migration match-key only, never the identifier). Prefers the
// primary owner. (Ed 2026-08-08.)
router.get('/by-property/:propertyId', async (req, res) => {
  try {
    const propertyId = req.params.propertyId;
    if (!propertyId) return res.status(400).json({ error: 'property_id required' });
    const { data, error } = await supabase.from('property_ownerships')
      .select('contact_id, is_primary')
      .eq('property_id', propertyId).is('end_date', null)
      .order('is_primary', { ascending: false }).limit(1);
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });
    const contactId = (data && data[0] && data[0].contact_id) || null;
    if (!contactId) return res.status(404).json({ error: 'no_current_owner' });
    res.json({ contact_id: contactId });
  } catch (err) {
    console.error('[homeowner-360/by-property] failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

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

    // SAME-NAME CONFLICT DETECTION (Ed 2026-07-25). Two owners can share a name
    // but be different people (different email/phone). Group results by normalized
    // name; for any group of 2+, report whether contact details match and whether
    // staff already verified the pair — so the UI can force a "same person /
    // different people" decision before the two are ever treated as one.
    const _norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const _digits = (s) => String(s || '').replace(/\D+/g, '');
    const nameGroups = {};
    results.forEach((r) => { const k = _norm(r.name); if (k) (nameGroups[k] = nameGroups[k] || []).push(r); });
    const nameConflicts = [];
    for (const [k, members] of Object.entries(nameGroups)) {
      if (members.length < 2) continue;
      const emails = members.map((m) => _norm(m.email)).filter(Boolean);
      const phones = members.map((m) => _digits(m.phone)).filter(Boolean);
      const emailMatch = emails.length >= 2 && new Set(emails).size === 1;
      const phoneMatch = phones.length >= 2 && new Set(phones).size === 1;
      const matchCount = 1 /* name */ + (emailMatch ? 1 : 0) + (phoneMatch ? 1 : 0);
      // Already-verified pair? (degrades to none if the table isn't there yet.)
      let verification = null;
      try {
        const ids = members.map((m) => m.contact_id);
        const { data: vs } = await supabase.from('identity_verifications')
          .select('contact_id_1, contact_id_2, result')
          .or(`contact_id_1.in.(${ids.join(',')}),contact_id_2.in.(${ids.join(',')})`);
        verification = (vs || []).find((v) => ids.includes(v.contact_id_1) && ids.includes(v.contact_id_2)) || null;
      } catch (_) { /* pre-migration: no verification table */ }
      const action = verification
        ? (verification.result === 'same_person' ? 'verified_same' : 'verified_different')
        : (matchCount >= 2 ? 'warn' : 'block'); // name-only match (email+phone both differ) => block
      nameConflicts.push({
        normalized_name: k,
        contacts: members.map((m) => ({ contact_id: m.contact_id, name: m.name, email: m.email, phone: m.phone, properties: m.properties, community: m.community })),
        match_count: matchCount, email_match: emailMatch, phone_match: phoneMatch,
        verified: !!verification, verification_result: verification ? verification.result : null, action,
      });
    }

    res.json({ results, name_conflicts: nameConflicts });
  } catch (err) {
    console.error('[homeowner360] search failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /verify-identity — staff records that two same-name contacts are the SAME
// person or DIFFERENT people (Prompt 2/3). Staff-gated; verified_by = the acting
// user. Idempotent on the unordered pair. Once recorded, the search-time conflict
// check short-circuits to this result. (Ed 2026-07-25.)
router.post('/verify-identity', express.json(), async (req, res) => {
  try {
    // The 360 is a staff-cookie-gated surface (like /note). Capture WHO verified
    // when a Supabase token is present; otherwise record the decision without a
    // name rather than 403 a legitimate staff action.
    const { getAuthedUser } = require('./_require_admin');
    const actor = await getAuthedUser(req);
    const { contact_id_1, contact_id_2, result, notes } = req.body || {};
    if (!contact_id_1 || !contact_id_2 || contact_id_1 === contact_id_2) {
      return res.status(400).json({ error: 'two distinct contact ids required' });
    }
    if (!['same_person', 'different_people'].includes(result)) {
      return res.status(400).json({ error: 'result must be same_person or different_people' });
    }
    const { data: existing } = await supabase.from('identity_verifications')
      .select('id')
      .or(`and(contact_id_1.eq.${contact_id_1},contact_id_2.eq.${contact_id_2}),and(contact_id_1.eq.${contact_id_2},contact_id_2.eq.${contact_id_1})`)
      .maybeSingle();
    let row;
    if (existing) {
      const { data, error } = await supabase.from('identity_verifications')
        .update({ result, verified_by: actor?.id || null, verified_at: new Date().toISOString(), notes: notes || null })
        .eq('id', existing.id).select().single();
      if (error) throw error; row = data;
    } else {
      const { data, error } = await supabase.from('identity_verifications')
        .insert({ contact_id_1, contact_id_2, result, verified_by: actor?.id || null, notes: notes || null })
        .select().single();
      if (error) throw error; row = data;
    }
    res.json({ ok: true, verification: row, verified_by_name: (actor && (actor.full_name || actor.email)) || 'Staff' });
  } catch (err) {
    console.error('[homeowner360] verify-identity failed:', err.message);
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
    .select('id, current_stage, opened_at, resolved_at, resolved_via, resolved_notes, quality_status, primary_category_id, property_id, opened_from_observation_id, sent_to_attorney_at, attorney_firm')
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
    // A superseded record (deduped) or a terminal stage is NOT open — it just
    // never got a resolved_at stamp. Counting it as open made a caught duplicate
    // show as a second live "certified 209" case. (Ed 2026-07-23, 4710 Lakes of
    // Pine Forest — the double RV/trailer.)
    const terminal = ['cured', 'closed', 'voided'].includes(v.current_stage);
    const superseded = v.quality_status === 'superseded';
    const open = !v.resolved_at && !terminal && !superseded;
    const status_label = open ? null
      : superseded ? 'duplicate'
      : v.current_stage === 'voided' ? 'voided'
      : 'resolved';
    return {
      ...v,
      category: catLabel[v.primary_category_id] || 'Violation',
      open,
      status_label,
      detail: o ? o.ai_description : null,
      photo_path: ph ? ph.storage_path : null,
      photo_captured_at: ph ? ph.captured_at : null,
    };
  });

  // ARC / ACC decisions for THIS owner's properties. The old code queried a
  // NON-EXISTENT `arc_applications` table, so this panel was always empty and
  // ACC history/conditions never surfaced at the property (Ed 2026-07-25). Real
  // sources: acc_decisions (Annie's queue, matched by community + address key)
  // and community_applications (portal, linked by property_address_id). Conditions
  // ride along so enforcement can check compliance against what was approved.
  const _arcAddrKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 3).join(' ');
  const _propKeys = new Set(properties.map((p) => _arcAddrKey(p.address)).filter(Boolean));
  const _arcCommIds = [...new Set(properties.map((p) => p.community_id).filter(Boolean))];
  let arc = [];
  if (_arcCommIds.length) {
    const accRows = await safe(() => supabase.from('acc_decisions')
      .select('id, reference_number, project_summary, decision_type, status, letter_body, homeowner_address, created_at, decided_at')
      .in('community_id', _arcCommIds).order('created_at', { ascending: false }).limit(60));
    accRows.filter((d) => _propKeys.has(_arcAddrKey(d.homeowner_address))).forEach((d) => {
      const decided = d.status === 'decided';
      arc.push({
        source: 'acc', id: d.id, reference: d.reference_number, project: d.project_summary || null,
        status: decided ? 'decided' : 'pending', decision: d.decision_type || null,
        submitted_at: d.created_at, decided_at: d.decided_at || (decided ? d.created_at : null),
        // For a conditional approval the conditions live in the sent letter body —
        // carry it so enforcement can see exactly what was approved.
        conditions: (decided && /condition/i.test(String(d.decision_type || ''))) ? (d.letter_body || null) : null,
      });
    });
  }
  if (propIds.length) {
    const portalRows = await safe(() => supabase.from('community_applications')
      .select('id, reference_number, service_type, final_status, final_decided_at, submitted_at, final_decision_reasoning, property_address_id')
      .in('property_address_id', propIds).order('submitted_at', { ascending: false }).limit(25));
    portalRows.forEach((d) => {
      const decided = !!d.final_decided_at;
      arc.push({
        source: 'portal', id: d.id, reference: d.reference_number, project: d.service_type || null,
        status: decided ? 'decided' : 'pending', decision: d.final_status || null,
        submitted_at: d.submitted_at, decided_at: d.final_decided_at,
        conditions: (decided && /condition/i.test(String(d.final_status || ''))) ? (d.final_decision_reasoning || null) : null,
      });
    });
  }
  arc.sort((a, b) => String(b.submitted_at || '').localeCompare(String(a.submitted_at || '')));

  // Correspondence: interactions (letters/calls/notes) + emails from the hub
  const interactions = await safe(() => supabase.from('interactions')
    .select('id, type, direction, subject, content, delivery_method, status, sent_at, mailed_at, printed_at, created_at, updated_at, violation_id, sent_by_user_id')
    .or(`contact_id.eq.${contactId}${propIds.length ? ',property_id.in.(' + propIds.join(',') + ')' : ''}`)
    .order('created_at', { ascending: false }).limit(60));
  // Match emails by resolved contact OR by any owned property — mirrors the
  // interactions query above so property-linked correspondence (unknown sender,
  // or an email about this property) surfaces on the owner's history, not just
  // mail from a known contact. (Was contact-only, which dropped property-linked
  // emails onto nobody's 360.)
  const emails = await safe(() => supabase.from('email_messages')
    .select('direction, sender_email, subject, ai_summary, classification, received_at')
    .or(`resolved_contact_id.eq.${contactId}${propIds.length ? ',resolved_property_id.in.(' + propIds.join(',') + ')' : ''}`)
    .order('received_at', { ascending: false }).limit(40));

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

  // Staff-captured photos + PDFs filed against the account (e.g. an attorney-
  // requested current photo of a property at legal). Date-stamped, with who + note.
  const attachments = propIds.length ? await safe(() => supabase.from('account_attachments')
    .select('id, kind, file_path, mime_type, original_name, caption, captured_by, captured_at, property_id')
    .in('property_id', propIds).order('captured_at', { ascending: false }).limit(100)) : [];

  // What the homeowner has SENT US by email — the photos, sketches, PDFs they
  // attached (migration 328). Matched by resolved contact OR any owned property
  // (mirrors the emails query), so a boundary photo emailed in shows on their
  // 360 even when the email resolved by property. Signed URLs (1h) so the
  // browser can render them. Degrades to [] before migration 328.
  const emailAttachments = (await safe(() => supabase.from('email_attachments')
    .select('id, filename, mime, size_bytes, storage_path, is_image, sender_email, created_at, email_message_id')
    .or(`resolved_contact_id.eq.${contactId}${propIds.length ? ',resolved_property_id.in.(' + propIds.join(',') + ')' : ''}`)
    .order('created_at', { ascending: false }).limit(60))) || [];
  await Promise.all(emailAttachments.map(async (a) => {
    try { const { data: su } = await supabase.storage.from('documents').createSignedUrl(a.storage_path, 3600); a.url = su ? su.signedUrl : null; }
    catch (_) { a.url = null; }
  }));

  // Map each violation to the letter PDF that was actually sent for it (from the
  // interactions ledger), so the 360 can link the real letter right on the
  // violation row — next to the photo. ONLY letters that actually went out: a
  // rejected/draft/never-sent letter has no stored PDF, so linking it 404s
  // (file_not_found) — Ed hit exactly that on 5506 Hickory Harvest's RV letter,
  // which was status=rejected, sent_at=null. Require a dispatched state.
  const BAD_LETTER_STATUS = new Set(['rejected', 'failed', 'draft', 'pending', 'cancelled', 'error', 'superseded', 'unreviewed']);
  const letterWentOut = (it) => {
    if (it.status && BAD_LETTER_STATUS.has(String(it.status))) return false;
    return !!(it.sent_at || it.mailed_at || it.printed_at);
  };
  const lettersByViolation = {};
  for (const it of (interactions || [])) {
    if (it.violation_id && it.content && /\.pdf$/i.test(it.content) && /letter/i.test(it.type || '') && letterWentOut(it)) {
      (lettersByViolation[it.violation_id] || (lettersByViolation[it.violation_id] = [])).push({
        path: it.content,
        sent_at: it.sent_at || it.mailed_at || it.printed_at || it.created_at || null,
      });
    }
  }
  // Newest sent first, so the most recent letter reads first on the violation row.
  for (const vid of Object.keys(lettersByViolation)) {
    lettersByViolation[vid].sort((a, b) => String(b.sent_at || '').localeCompare(String(a.sent_at || '')));
  }
  violations = violations.map((v) => ({
    ...v,
    letters: lettersByViolation[v.id] || [],
    letter_path: (lettersByViolation[v.id] && lettersByViolation[v.id][0] && lettersByViolation[v.id][0].path) || null, // back-compat
  }));

  // Assessment-delinquency / amenity-access status — the SAME engine the pool
  // gate uses, so 360 shows exactly what would block a fob. Assessments only
  // (not fines/late/interest), never in bankruptcy or on a plan.
  let amenity = null;
  const primaryProp = properties.find((p) => p.is_primary) || properties[0];
  if (primaryProp) {
    try { amenity = await evaluateAmenityAccess(supabase, { propertyId: primaryProp.property_id, communityId: primaryProp.community_id }); } catch (_) {}
  }

  // Stamp whether each interaction is a REAL, retrievable letter — it actually
  // went out (not a rejected/failed/draft) AND has a PDF path. The 360 timeline
  // offers View / Download / Email only when this is true, so a caught letter
  // whose PDF was never written no longer shows a dead "View letter" link.
  // (Ed 2026-08-01 — the rejected wrong-homeowner courtesy_1 at 4731 Autumn Pine.)
  // Resolve note authors → names (so the 360 shows WHO wrote each staff note).
  const noteAuthorIds = [...new Set((interactions || []).filter((it) => it.sent_by_user_id).map((it) => it.sent_by_user_id))];
  const authorNames = {};
  if (noteAuthorIds.length) {
    const us = await safe(() => supabase.from('user_profiles').select('id, full_name, email').in('id', noteAuthorIds));
    (us || []).forEach((u) => { authorNames[u.id] = u.full_name || u.email || null; });
  }
  const interactionsOut = (interactions || []).map((it) => ({
    ...it,
    author_name: it.sent_by_user_id ? (authorNames[it.sent_by_user_id] || null) : null,
    letter_available: !!(it.content && /\.pdf$/i.test(it.content) && /letter/i.test(it.type || '') && letterWentOut(it)),
  }));

  // At-attorney summary — spans BOTH tracks so no surface misses one:
  //   • account/collections at legal → property_enforcement_states + ar_account_collections
  //   • deed-restriction (DRV) at attorney → an open violation with sent_to_attorney_at
  const drvAtAttorney = (violations || []).filter((v) => v.sent_to_attorney_at && !v.resolved_at && !['cured', 'closed', 'voided'].includes(v.current_stage));
  const accountAtLegal = (flags || []).some((f) => ['at_legal', 'lien_filed', 'judgment'].includes(f.state))
    || (collections || []).some((c) => ['with_attorney', 'lien_filed', 'foreclosure', 'bankruptcy'].includes(c.collection_status));
  const at_attorney = {
    any: drvAtAttorney.length > 0 || accountAtLegal,
    collections: accountAtLegal,
    drv: drvAtAttorney.length > 0,
    drv_count: drvAtAttorney.length,
    firm: (drvAtAttorney.find((v) => v.attorney_firm) || {}).attorney_firm
      || ((collections || []).find((c) => c.collection_status === 'with_attorney') ? null : null),
    drv_categories: drvAtAttorney.map((v) => catLabel[v.primary_category_id] || 'violation'),
  };

  return { contact, properties, ar: { balance_cents, transactions: txns }, amenity, flags, collections, violations, arc, interactions: interactionsOut, emails, calls, poolAccess, paymentPlans, attachments, emailAttachments, at_attorney };
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
    // download=1 forces a "Save As" (Content-Disposition: attachment) with a
    // friendly filename, so staff can grab the letter to send to a homeowner
    // instead of it opening inline. name= sets the filename; sanitized here.
    let opts;
    if (req.query.download) {
      let fname = String(req.query.name || String(path).split('/').pop() || 'document')
        .replace(/[^\w.\-() ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!fname) fname = 'document';
      if (!/\.pdf$/i.test(fname)) fname += '.pdf';
      opts = { download: fname };
    }
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(String(path), 60 * 60, opts);
    if (error || !data || !data.signedUrl) {
      // Opened in a browser tab — show a readable message, not raw JSON. Happens
      // when a letter row points at a PDF that was never written (a failed/caught
      // letter). (Ed 2026-08-01.)
      if (/text\/html/.test(req.headers.accept || '')) {
        return res.status(404).type('html').send('<div style="font-family:system-ui,Arial,sans-serif;max-width:520px;margin:60px auto;padding:24px;text-align:center;color:#334155;"><h2 style="color:#0B1D34;">This letter isn’t available</h2><p>The PDF for this letter couldn’t be found — it was likely a draft that never completed or a letter that was cancelled before it was produced. Nothing was sent.</p></div>');
      }
      return res.status(404).json({ error: 'file_not_found' });
    }
    res.redirect(data.signedUrl);
  } catch (err) {
    console.error('[homeowner360] file failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /email-letter — drop a letter that's already on file into an email DRAFT
// to the homeowner (from Claire, the letter PDF attached), queued in the Draft
// Queue for review. NOTHING sends from here — a human releases it. Turns "send
// this letter to the owner" into one click from the 360 instead of download →
// compose → attach by hand. (Ed 2026-08-01.)
router.post('/email-letter', express.json(), async (req, res) => {
  try {
    const { requireStaff, getAuthedUser } = require('./_require_admin');
    const staff = await requireStaff(req, res); if (!staff) return; // 403 already sent
    const b = req.body || {};
    const letterPath = b.letter_path;
    const toEmail = String(b.to_email || '').trim();
    if (!letterPath) return res.status(400).json({ error: 'letter_path_required', detail: 'No letter to send.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toEmail)) return res.status(400).json({ error: 'no_recipient', detail: 'Add or type a valid email for this homeowner first.' });

    let contact = null;
    if (b.contact_id) { const { data } = await supabase.from('contacts').select('id, full_name, preferred_name').eq('id', b.contact_id).maybeSingle(); contact = data; }
    let community = null, propAddr = null;
    if (b.property_id) { const { data } = await supabase.from('properties').select('street_address, community:community_id(id, name)').eq('id', b.property_id).maybeSingle(); if (data) { propAddr = data.street_address; community = data.community; } }

    const first = (contact && (contact.preferred_name || String(contact.full_name || '').trim().split(/\s+/)[0])) || 'there';
    const commName = community && community.name ? community.name : null;
    const bodyText = (b.note && String(b.note).trim())
      || `Hi ${first},\n\nPlease see the attached letter${propAddr ? ` regarding ${propAddr}` : ''}. If you have any questions or would like to discuss it, just reply to this email and we'll be glad to help.`;
    const subject = `Letter regarding ${propAddr || 'your property'}${commName ? ` — ${commName}` : ''}`.slice(0, 160);
    const fname = (`${String(b.letter_label || 'Letter')} ${new Date().toISOString().slice(0, 10)}`
      .replace(/[^\w.\-() ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 110)) + '.pdf';

    const graphSend = require('../lib/email/graph_send');
    const { queueDraft } = require('../lib/email/outbound_drafts');
    const actor = await getAuthedUser(req).catch(() => null);
    const q = await queueDraft({
      communityId: community && community.id ? community.id : null, communityName: commName,
      persona: 'claire', fromMailbox: graphSend.CLAIRE_MAILBOX,
      toEmail, toName: contact && contact.full_name ? contact.full_name : null,
      subject, bodyText,
      // The letter lives in the violation-letters bucket, not documents — the
      // release path honors a.bucket (email_drafts.js). (Ed 2026-08-01.)
      attachments: [{ name: fname, storage_path: letterPath, mime: 'application/pdf', bucket: 'violation-letters' }],
      relatedType: 'homeowner_letter', relatedId: b.contact_id || null,
      sourceEmailRef: `homeowner_letter:${letterPath}`, // idempotent: one draft per letter
      draftKind: 'homeowner_letter', draftReason: 'Letter to homeowner — review before sending',
      createdBy: (actor && (actor.full_name || actor.email)) || 'Staff',
    });
    if (q.status === 'skipped' && q.reason === 'no_table') return res.status(400).json({ error: 'draft_queue_unavailable', detail: 'The Draft Queue isn’t set up yet.' });
    if (q.status !== 'queued' && q.status !== 'exists') return res.status(500).json({ error: 'queue_failed', detail: q.error || 'Could not draft the email.' });
    res.json({ ok: true, to: toEmail, already: q.status === 'exists' });
  } catch (err) {
    console.error('[homeowner360] email-letter failed:', err.message);
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
Deed-restriction cases at attorney (STAFF-ONLY): ${d.at_attorney && d.at_attorney.drv ? `${d.at_attorney.drv_count} case(s) with counsel — ${d.at_attorney.drv_categories.join(', ')}. Do NOT contact the homeowner directly on these; route through the attorney.` : 'none'}
Payment plan: ${(d.paymentPlans || []).filter((p) => p.status === 'active').map((p) => `ACTIVE — ${p.installment_amount_cents ? money(p.installment_amount_cents) + '/' + (p.frequency || 'monthly') : 'installments'}${p.num_installments ? ' x' + p.num_installments : ''}${p.next_due_date ? ', next due ' + String(p.next_due_date).slice(0, 10) : ''}${p.terms_summary ? ' — ' + String(p.terms_summary).slice(0, 140) : ''}`).join(' | ') || 'none on file'}
Open violations (${openV.length}): ${openV.map((v) => `${v.category} @ ${v.current_stage}, opened ${(v.opened_at || '').slice(0, 10)}`).join('; ') || 'none'}
Violation history (${d.violations.length} total): ${d.violations.slice(0, 12).map((v) => `${v.category} [${v.open ? 'open ' + v.current_stage : 'resolved'}]`).join('; ')}
Recent payments/charges: ${d.ar.transactions.slice(0, 8).map((t) => `${(t.transaction_date || '').slice(0, 10)} ${t.txn_type || ''} ${money(Number(t.amount_cents) || 0)}`).join('; ') || 'none'}
ARC/ACC (${d.arc.length} on file): ${(() => {
  const pend = (d.arc || []).filter((a) => a.status === 'pending');
  const cond = (d.arc || []).filter((a) => a.status === 'decided' && a.conditions);
  const parts = [];
  if (pend.length) parts.push('PENDING — ' + pend.map((a) => `${a.project || 'application'} submitted ${(a.submitted_at || '').slice(0, 10)} (${Math.max(0, Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(String(a.submitted_at || '').slice(0, 10))) / 864e5))} days, no decision yet)`).join('; '));
  if (cond.length) parts.push('APPROVED WITH CONDITIONS on file (check compliance if a violation relates to it) — ' + cond.map((a) => a.project || a.reference || 'application').join(', '));
  return parts.join(' | ') || 'none';
})()}
Phone calls (${d.calls.length}): ${d.calls.slice(0, 6).map((c) => `${(c.started_at || '').slice(0, 10)} ${c.status || ''}${c.brief ? ' — ' + String(c.brief).slice(0, 80) : ''}`).join('; ') || 'none'}
Recent correspondence: ${[...d.interactions.slice(0, 10).map((i) => `${(i.created_at || '').slice(0, 10)} ${i.type} ${i.direction}${i.subject ? ' — ' + i.subject : ''}`), ...d.emails.slice(0, 8).map((e) => `${(e.received_at || '').slice(0, 10)} email ${e.direction} — ${e.ai_summary || e.subject || ''}`)].join(' | ') || 'none'}`;

    const sys = `IDENTITY SAFETY — READ FIRST (Ed 2026-07-25):
- This briefing is for ONE homeowner record. If the "Properties" line below lists MORE THAN ONE property, do NOT assume they belong to the same person — same-name records are sometimes two different owners merged in error. Do not combine their balances, violations, or correspondence as one owner's history unless the facts explicitly state the identity was STAFF-VERIFIED as the same person.
- Never attribute a contact detail (email or phone) or any history from one property to another as if it were confirmed the same owner.
- If the record spans multiple properties and nothing below states the identity was staff-verified as the same person, END the briefing with exactly this line: "⚠️ Multiple properties on this record — ownership not staff-verified as the same person. Do not assume combined history."
- If you cannot confirm the record is a single person, scope the briefing to the primary/first property only.

You are briefing a Bedrock Association Management team member who is about to talk to this homeowner (they just called or emailed). Write a SHORT internal briefing — direct, factual, no fluff. Ground EVERYTHING strictly in the facts provided; never invent history, amounts, or temperament that isn't in the data. If something isn't in the data, don't mention it.

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
    const { getAuthedUser } = require('./_require_admin');
    const actor = await getAuthedUser(req).catch(() => null); // who's writing it — for attribution
    const { data, error } = await supabase.from('interactions').insert({
      type: 'internal_note', direction: 'internal',
      contact_id: req.params.contactId,
      property_id: primary ? primary.property_id : null,
      community_id: primary ? primary.community_id : null,
      subject: (req.body && req.body.subject) ? String(req.body.subject).slice(0, 200) : 'Note',
      content: body,
      source: 'manual',
      sent_by_user_id: actor && actor.id ? actor.id : null,
      notes: 'via Homeowner 360',
    }).select('id, created_at').single();
    if (error) throw error;
    // Diagnostic: report exactly what the endpoint saw for auth, so we can tell
    // whether the header arrived and whether the token validated. (Ed 2026-08-14.)
    res.json({ ok: true, note: data, _auth: { header: !!(req.headers && req.headers.authorization), actor: actor ? (actor.email || actor.id) : null } });
  } catch (err) {
    console.error('[homeowner360] note failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /:contactId/attachment — file a photo or PDF against the account. Camera
// capture on mobile, file upload on desktop. Stores in the 'documents' bucket +
// indexes in account_attachments, date-stamped with who + an optional caption,
// so an attorney-requested "current photo of the property at legal" is a
// defensible record on the account (not an email lost in a thread). (Ed 2026-07-14.)
router.post('/:contactId/attachment', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    const mime = req.file.mimetype || '';
    const isImg = /^image\//.test(mime);
    const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(req.file.originalname || '');
    if (!isImg && !isPdf) return res.status(400).json({ error: 'unsupported_type', detail: 'Only photos (JPG/PNG/HEIC) or PDFs.' });
    const props = await ownedProperties(req.params.contactId);
    const primary = props.find((p) => p.is_primary) || props[0] || null;
    if (!primary) return res.status(400).json({ error: 'no_property', detail: 'This homeowner has no linked property to file the photo/PDF to.' });
    const b = req.body || {};
    const chosen = props.find((p) => p.property_id === b.property_id) || primary;
    const safeName = String(req.file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = `account-attachments/${chosen.community_id}/${chosen.property_id}/${stamp}-${safeName}`;
    const { error: upErr } = await supabase.storage.from('documents').upload(path, req.file.buffer, { contentType: mime || (isPdf ? 'application/pdf' : 'image/jpeg'), upsert: true });
    if (upErr) throw upErr;
    const num = (v) => (v != null && v !== '' && !isNaN(parseFloat(v))) ? parseFloat(v) : null;
    const { data, error } = await supabase.from('account_attachments').insert({
      property_id: chosen.property_id, community_id: chosen.community_id, contact_id: req.params.contactId,
      kind: isImg ? 'photo' : 'document', file_path: path, mime_type: mime, original_name: req.file.originalname || null,
      caption: b.caption ? String(b.caption).slice(0, 300) : null,
      captured_by: b.captured_by ? String(b.captured_by).slice(0, 120) : 'staff',
      gps_lat: num(b.gps_lat), gps_lng: num(b.gps_lng),
    }).select('id, kind, file_path, caption, captured_at, captured_by, original_name').single();
    if (error) throw error;
    res.json({ ok: true, attachment: data });
  } catch (err) {
    console.error('[homeowner360] attachment failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// DELETE /attachment/:id — remove a wrongly-added file (mistake correction).
router.delete('/attachment/:id', async (req, res) => {
  try {
    const { data: row } = await supabase.from('account_attachments').select('file_path').eq('id', req.params.id).maybeSingle();
    const { error } = await supabase.from('account_attachments').delete().eq('id', req.params.id);
    if (error) throw error;
    if (row && row.file_path) { try { await supabase.storage.from('documents').remove([row.file_path]); } catch (_) { /* index gone is enough */ } }
    res.json({ ok: true });
  } catch (err) {
    console.error('[homeowner360] attachment delete failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// PATCH /note/:id — edit a staff note's text. Only internal_note type; keeps the
// original author (edit changes the words, not who logged it). (Ed 2026-08-14.)
router.patch('/note/:id', express.json(), async (req, res) => {
  try {
    const content = (req.body && req.body.content ? String(req.body.content) : '').trim();
    if (!content) return res.status(400).json({ error: 'content_required' });
    const { data: row } = await supabase.from('interactions').select('id, type').eq('id', req.params.id).maybeSingle();
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.type !== 'internal_note') return res.status(403).json({ error: 'only_notes_editable', detail: 'Only staff notes can be edited here; correspondence records cannot.' });
    const { error } = await supabase.from('interactions').update({ content, updated_at: new Date().toISOString() }).eq('id', req.params.id).eq('type', 'internal_note');
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[homeowner360] note edit failed:', err.message);
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

// POST /violations/:id/resolve — mark a violation cured from Homeowner 360, e.g.
// when the owner sends in completion photos. Sets resolved_at (the universal
// "open" flag every surface keys on — board portal, community map, email intake,
// enforcement, packets — so the cure flows through everywhere), resolved_via, a
// note, and current_stage='cured'. Idempotent on an already-resolved row.
// (Ed 2026-08-10 — "resolve button next to the violations for when pictures are
// sent in, with a drop down of notes".)
router.post('/violations/:id/resolve', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    // resolved_via CHECK is ('cured','fine','withdrawn','voided'); a photo-proof
    // resolution is 'cured' — the only via reachable from this button.
    const via = ['cured', 'withdrawn', 'voided'].includes(b.resolved_via) ? b.resolved_via : 'cured';
    const note = (b.note == null ? '' : String(b.note)).slice(0, 1000).trim() || null;
    const { data: v, error: ve } = await supabase.from('violations')
      .select('id, resolved_at, current_stage').eq('id', id).maybeSingle();
    if (ve) throw ve;
    if (!v) return res.status(404).json({ error: 'not_found' });
    if (v.resolved_at) return res.json({ ok: true, already_resolved: true });
    const { error: ue } = await supabase.from('violations').update({
      resolved_at: new Date().toISOString(), resolved_via: via, resolved_notes: note, current_stage: 'cured',
    }).eq('id', id);
    if (ue) throw ue;
    res.json({ ok: true, resolved_via: via, note });
  } catch (err) {
    console.error('[homeowner360] resolve violation failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
