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
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const Anthropic = require('@anthropic-ai/sdk');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

  // Violations (+ category label), newest first
  let violations = propIds.length ? await safe(() => supabase.from('violations')
    .select('id, current_stage, opened_at, resolved_at, resolved_via, primary_category_id, property_id')
    .in('property_id', propIds).order('opened_at', { ascending: false }).limit(50)) : [];
  const catIds = [...new Set(violations.map((v) => v.primary_category_id).filter(Boolean))];
  const cats = catIds.length ? await safe(() => supabase.from('enforcement_categories').select('id, label').in('id', catIds)) : [];
  const catLabel = Object.fromEntries(cats.map((c) => [c.id, c.label]));
  violations = violations.map((v) => ({ ...v, category: catLabel[v.primary_category_id] || 'Violation', open: !v.resolved_at }));

  // ARC (defensive — table may be empty / shape unknown)
  const arc = propIds.length ? await safe(() => supabase.from('arc_applications').select('*').in('property_id', propIds).limit(25)) : [];

  // Correspondence: interactions (letters/calls/notes) + emails from the hub
  const interactions = await safe(() => supabase.from('interactions')
    .select('type, direction, subject, content, delivery_method, sent_at, created_at, violation_id')
    .or(`contact_id.eq.${contactId}${propIds.length ? ',property_id.in.(' + propIds.join(',') + ')' : ''}`)
    .order('created_at', { ascending: false }).limit(60));
  const emails = await safe(() => supabase.from('email_messages')
    .select('direction, sender_email, subject, ai_summary, classification, received_at')
    .eq('resolved_contact_id', contactId).order('received_at', { ascending: false }).limit(40));

  return { contact, properties, ar: { balance_cents, transactions: txns }, flags, violations, arc, interactions, emails };
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
Open violations (${openV.length}): ${openV.map((v) => `${v.category} @ ${v.current_stage}, opened ${(v.opened_at || '').slice(0, 10)}`).join('; ') || 'none'}
Violation history (${d.violations.length} total): ${d.violations.slice(0, 12).map((v) => `${v.category} [${v.open ? 'open ' + v.current_stage : 'resolved'}]`).join('; ')}
Recent payments/charges: ${d.ar.transactions.slice(0, 8).map((t) => `${(t.transaction_date || '').slice(0, 10)} ${t.txn_type || ''} ${money(Number(t.amount_cents) || 0)}`).join('; ') || 'none'}
ARC submissions: ${d.arc.length}
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

module.exports = { router };
