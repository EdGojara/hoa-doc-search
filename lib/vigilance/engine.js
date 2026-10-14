// ============================================================================
// lib/vigilance/engine.js — detect -> investigate -> assess -> act -> escalate ->
// follow through, for every agent (Ed 2026-10-14)
// ----------------------------------------------------------------------------
// Scar: an unfamiliar address appeared on NewFirst's Positive Pay notices on
// 10/13/2026 and nobody on the AI team noticed; Ed did. The history needed to see
// it (31 earlier notices without it) was already in trustEd. The team must
// recognize what changed without being asked.
//
// For each incoming communication:
//   detect       generic detectors (lib/vigilance/detectors) compare it with the
//                established record;
//   investigate  gather what our records show and build a fact basis (observed,
//                concluded, still unknown: lib/agents/fact_basis);
//   assess       risk, the owning teammate (the counterparty decides: a bank is
//                Kat's, a vendor Emma's, a resident or community Amanda's), and the
//                actions that fit;
//   act          only actions the owner is permitted (lib/vigilance/permissions);
//                outbound correspondence is PREPARED for a person to approve,
//                never sent; no bank, money or vendor-banking change, ever;
//   escalate     Ed hears only when the risk is high or an action needs him;
//   record       one objective per subject on the operator spine (objectives /
//                objective_events): every step is its audit trail, and a repeat
//                sighting reattaches to the open case instead of starting over.
// Follow-through (resolution checks, replies, overdue nudges) is
// lib/vigilance/followthrough.js on the scheduler.
// ============================================================================
const D = require('./detectors');
const P = require('./permissions');
const FB = require('../agents/fact_basis');

const NAMES = { kat: 'Kat', emma: 'Emma', amanda: 'Amanda' };
const DOMAIN = { kat: 'accounting', emma: 'ap', amanda: 'communications' };
const addBusinessDays = (iso, n) => { const d = new Date(iso); let k = 0; while (k < n) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) k += 1; } return d.toISOString(); };

function normalize(m) {
  return { id: m.id || null, direction: m.direction || 'inbound', sender_email: String(m.sender_email || '').toLowerCase(), sender_domain: D.domainOf(m.sender_email), sender_name: m.sender_name || null,
    recipients: (m.recipients || []).map(D.addr).filter(Boolean), subject: m.subject || '', received_at: m.received_at || new Date().toISOString(), body_full: m.body_full || null, body_preview: m.body_preview || null,
    classification: m.classification || '', resolved_vendor_id: m.resolved_vendor_id || null, community_id: m.community_id || null, persona: m.persona || null, extracted: m.extracted || {}, conversation_id: m.conversation_id || null };
}

// ---------------------------------------------------------------- investigate
async function investigate(supabase, s, ev) {
  const BC = require('../banking/bank_correspondence');
  const observed = [...s.observed]; const conclusions = []; const unknown = [];
  if (s.detector === 'recipient_change') {
    const rm = await BC.recordMatches(supabase, s.data.address);
    if (rm.found.length) observed.push({ fact: `${s.data.address} appears in our records: ${rm.found.join(', ')}`, source: 'trustEd' });
    else if (rm.checked.length) observed.push({ fact: `${s.data.address} is in none of our ${rm.checked.join(', ')}`, source: 'trustEd records checked' });
    if (rm.unchecked.length) observed.push({ fact: `not checked (lookup failed): ${rm.unchecked.join(', ')}`, source: 'trustEd' });
    if (!rm.found.length) conclusions.push({ fact: `we do not recognize ${s.data.address} as a party to this correspondence${s.counterparty.type === 'bank' ? ' or an authorized contact for our accounts' : ''}` });
    unknown.push({ fact: 'when and why the address was added, and who requested and authorized it' });
    if (s.counterparty.type === 'bank') unknown.push({ fact: 'whether it has any access to our accounts or decision authority' }, { fact: 'whether any other notification recipients or authorized users changed' });
  } else if (s.detector === 'payment_instructions') {
    const cp = s.counterparty;
    if (cp.vendor_id) {
      const { data } = await supabase.from('vendors').select('name, email').eq('id', cp.vendor_id).limit(1);
      const v = data && data[0];
      if (v) observed.push({ fact: `vendor on file: ${v.name}${v.email ? `, email on file ${v.email}` : ', no email on file'}${v.email && D.domainOf(v.email) !== ev.sender_domain ? ` (the request came from a different domain, ${ev.sender_domain})` : ''}`, source: 'trustEd vendors' });
    } else observed.push({ fact: `${ev.sender_domain} is not a vendor or bank on file`, source: 'trustEd vendors and banks' });
    conclusions.push({ fact: 'a change of payment details requested by email is a common payment-fraud pattern and must be confirmed through a contact already on file before anything changes' });
    unknown.push({ fact: 'whether the counterparty actually changed its payment details' });
  } else if (s.detector === 'sender_lookalike') {
    const { data } = await supabase.from('email_messages').select('id').ilike('sender_email', `%@${s.data.domain}`).limit(50);
    observed.push({ fact: `${(data || []).length} message(s) on file from ${s.data.domain}`, source: 'trustEd email' });
    conclusions.push({ fact: `the message may impersonate ${s.data.resembles}` });
    unknown.push({ fact: 'whether the sender is who it appears to be' });
  } else if (s.detector === 'amount_outlier') {
    conclusions.push({ fact: 'the amount is far outside this vendor\'s normal range' });
    unknown.push({ fact: 'what the bill covers that differs from prior bills' });
  }
  return FB.basis({ observed, conclusions, unknown });
}

// ---------------------------------------------------------------- assess
function assess(s, ev) {
  const t = s.counterparty.type;
  const owner = t === 'bank' ? 'kat' : t === 'vendor' ? 'emma' : (['kat', 'emma', 'amanda'].includes(ev.persona) ? ev.persona : 'amanda');
  const plan = {
    recipient_change: t === 'bank' ? ['open_case', 'prepare_bank_inquiry'] : ['open_case', 'prepare_correspondence'],
    payment_instructions: ['open_case', 'hold_vendor_banking_change'],
    sender_lookalike: ['open_case', 'flag_do_not_act'],
    amount_outlier: ['open_case', 'hold_for_review'],
  }[s.detector] || ['open_case'];
  const risk = s.materiality;
  const headline = {
    recipient_change: `new outside recipient ${s.data.address} on ${s.counterparty.name || s.counterparty.domain} "${s.data.series_label || ev.subject}"`,
    payment_instructions: `${ev.sender_email} asks to change payment details`,
    sender_lookalike: `sender domain ${s.data.domain} imitates ${s.data.resembles}`,
    amount_outlier: `bill of $${((s.data.amount_cents || 0) / 100).toFixed(2)} vs median $${((s.data.median_cents || 0) / 100).toFixed(2)}`,
  }[s.detector] || s.detector;
  const next = {
    recipient_change: t === 'bank' ? { action: 'Get the bank\'s written answer (who added the address, when, its authority) and confirm removal; confirm the address is gone from the next notice', days: 1 } : { action: 'Confirm with the counterparty, through a contact on file, why the address was added', days: 2 },
    payment_instructions: { action: 'Do not change any payment details. Confirm by phone using the number already on file; record who confirmed', days: 0 },
    sender_lookalike: { action: 'Do not act on the message, open links or pay anything from it; confirm with the real counterparty through a contact on file', days: 0 },
    amount_outlier: { action: 'Hold for review: confirm the bill against the contract or a change order before approval', days: 2 },
  }[s.detector] || { action: 'Review', days: 1 };
  return { owner, risk, plan, headline, next_action: next.action, next_action_due: addBusinessDays(ev.received_at, Math.max(next.days, 0) || 0), escalate: risk === 'high' };
}

// Has someone (a person or a teammate) already written about this since it first appeared? Then
// that IS the action: record it and wait for the answer; never prepare a second message.
async function alreadyContacted(supabase, term, since) {
  if (!term) return null;
  const { data, error } = await supabase.from('email_messages').select('id, mailbox, sender_email, recipients, subject, received_at').eq('direction', 'outbound').ilike('body_full', `%${term}%`).gte('received_at', since).order('received_at', { ascending: true }).limit(1);
  if (error || !data || !data[0]) return null;
  const m = data[0];
  const to = (m.recipients || []).map(D.addr).find((r) => !D.isOwn(r) && r !== D.addr(term)) || null;
  return { message_id: m.id, from: m.sender_email || m.mailbox, to, subject: m.subject, at: m.received_at };
}

// ---------------------------------------------------------------- act (permission-checked; prepares, never sends)
async function act(supabase, s, a, ev, fb) {
  const done = []; const refused = [];
  const contacted = ['prepare_bank_inquiry', 'prepare_correspondence'].some((x) => a.plan.includes(x)) ? await alreadyContacted(supabase, s.data && s.data.address, (s.data && s.data.first_seen) || ev.received_at) : null;
  if (contacted) {
    done.push({ action: 'already_contacted', contacted, note: `Already raised with ${contacted.to || 'the counterparty'} by ${contacted.from} on ${String(contacted.at).slice(0, 10)} ("${contacted.subject}"). No second message; waiting for the answer.` });
    return { done, refused, contacted };
  }
  for (const action of a.plan) {
    if (action === 'open_case') continue;   // recorded by persist
    if (!P.can(a.owner, action)) { refused.push(action); continue; }
    if (action === 'prepare_bank_inquiry') {
      const BC = require('../banking/bank_correspondence');
      let settings = {}, contactEmail = null;
      if (s.counterparty.bank_id) { const { data } = await supabase.from('banks').select('contact_email, positive_pay_settings').eq('id', s.counterparty.bank_id).limit(1); if (data && data[0]) { settings = data[0].positive_pay_settings || {}; contactEmail = data[0].contact_email || null; } }
      const contact = await BC.verifiedBankContact(supabase, { bankDomain: s.counterparty.domain, settings, contactEmail, before: ev.received_at, exclude: [s.data.address, ev.sender_email] });
      const phrase = /positive pay/i.test(s.data.series_label || '') ? 'Positive Pay notifications' : `"${s.data.series_label}" notifications`;
      const { subject, body } = BC.unfamiliarRecipientInquiry({ address: s.data.address, firstSeen: s.data.first_seen || ev.received_at, seriesPhrase: phrase });
      done.push({ action, draft: { subject, body, to: contact ? contact.email : null, careful: true, status: 'pending', persona: a.owner, bank_inquiry: true, fact_basis: fb,
        review_hint: `${NAMES[a.owner] || a.owner} found this herself: ${a.headline}. Prepared for your approval; sends as a fresh message to ${contact ? `${contact.name || contact.email} (${contact.basis})` : 'a verified bank contact you enter'}. ${FB.reviewText(fb)}` } });
    } else if (action === 'prepare_correspondence') {
      done.push({ action, note: `Next: ${a.next_action}. Correspondence is prepared on request with the fact basis; nothing is sent without approval.` });
    } else done.push({ action, note: { hold_vendor_banking_change: 'Hold: no payment detail changes until confirmed through a contact on file.', flag_do_not_act: 'Flagged: do not act on this message until the sender is confirmed.', hold_for_review: 'Held for review before approval.' }[action] || action });
  }
  return { done, refused, contacted: null };
}

// ---------------------------------------------------------------- record + escalate
async function persist(supabase, s, a, ev, fb, acted) {
  const draft = acted.done.find((x) => x.draft);
  const row = { management_company_id: '00000000-0000-0000-0000-000000000001', community_id: ev.community_id, title: `${NAMES[a.owner] || a.owner} found: ${a.headline}`.slice(0, 300), goal: a.next_action,
    objective_type: s.counterparty.type === 'vendor' ? 'vendor' : 'other', owner_persona: a.owner, accountable_persona: a.owner, owner_kind: 'workflow', domain: DOMAIN[a.owner] || 'ops',
    priority: a.risk === 'high' ? 'high' : 'normal', autonomy_class: 'REVIEW', status: acted.contacted ? 'waiting_third_party' : draft ? 'waiting_human' : 'open', subject_key: s.subject_key, wake_reason: 'vigilance',
    subject_refs: { detector: s.detector, counterparty: s.counterparty, data: s.data, fact_basis: fb, correspondence_to: acted.contacted ? acted.contacted.to : draft ? draft.draft.to : null, contacted: acted.contacted || null, source_message_id: ev.id },
    next_action: acted.contacted ? `Await ${acted.contacted.to || 'the counterparty'}'s answer to the ${String(acted.contacted.at).slice(0, 10)} inquiry; then: ${a.next_action}` : a.next_action,
    next_action_due: acted.contacted ? addBusinessDays(acted.contacted.at, 1) : a.next_action_due, source_message_id: ev.id, last_activity_at: new Date().toISOString() };
  const { data: o, error } = await supabase.from('objectives').insert(row).select('id').single();
  if (error) throw new Error(`open case: ${error.message}`);
  const ev1 = async (kind, summary) => { const { error: e } = await supabase.from('objective_events').insert({ objective_id: o.id, actor: a.owner, kind, summary: String(summary).slice(0, 2000), ref_message_id: ev.id }); if (e) console.warn('[vigilance] event not recorded:', e.message); };
  await ev1('opened', `Detected (${s.detector}): ${a.headline}.`);
  await ev1('note', `Investigated. ${FB.reviewText(fb)}`);
  await ev1('note', `Assessed: risk ${a.risk}; owner ${NAMES[a.owner] || a.owner}.`);
  await ev1('next_action', [...acted.done.map((x) => (x.draft ? `Prepared correspondence to ${x.draft.to || '(verified contact to be entered)'} for approval` : x.note)), acted.refused.length ? `Not permitted for ${a.owner}, escalated: ${acted.refused.join(', ')}` : null, `Next: ${a.next_action}`].filter(Boolean).join(' | '));
  return o.id;
}

async function escalate(supabase, caseId, s, a, acted, { notify }) {
  const text = `${NAMES[a.owner] || 'The team'}: ${a.headline}. Risk ${a.risk}. ${acted.done.some((x) => x.draft) ? 'Inquiry prepared for your approval in Communications. ' : ''}${acted.refused.length ? `Needs you: ${acted.refused.join(', ')}. ` : ''}Next: ${a.next_action}`.slice(0, 590);
  let r = { ok: false, skipped: true };
  try { r = await notify(text); } catch (e) { r = { ok: false, error: e.message }; }
  if (caseId) await supabase.from('objective_events').insert({ objective_id: caseId, actor: a.owner, kind: 'escalated', summary: `Told Ed${r && r.ok ? '' : ` (text not delivered: ${(r && r.error) || 'alerts off'}; the case is on his queue)`}: ${text}` });
  return { text, delivered: !!(r && r.ok) };
}

/**
 * Evaluate one communication. store=false is a dry run (nothing written, nothing sent).
 * @returns {{ checked_at, counterparty, results:[{signal, assessment, fact_basis, acted, case_id, reattached, escalation}], draft }}
 */
async function evaluate(supabase, message, { store = true, notify = null, bankDomains = null } = {}) {
  const ev = normalize(message);
  const send = notify || ((t) => require('../notifications/notify_owner').textOwner(t, { force: true }));
  const cache = bankDomains ? { banks: bankDomains } : {}; const out = { checked_at: new Date().toISOString(), counterparty: null, results: [], errors: [], draft: null };
  if (ev.direction !== 'inbound' || D.isOwn(ev.sender_email)) return out;
  const cp = await D.counterpartyOf(supabase, ev, cache); out.counterparty = cp;
  const signals = [];
  for (const det of D.DETECTORS) {
    if (!det.applies(ev)) continue;
    try { signals.push(...await det.detect({ supabase, ev, cp, cache })); } catch (e) { out.errors.push(`${det.key}: ${e.message}`); }
  }
  for (const s of signals) {
    if (store) {
      const { data: open } = await supabase.from('objectives').select('id, status').eq('subject_key', s.subject_key).not('status', 'in', '(resolved,closed)').limit(1);
      if (open && open[0]) {
        await supabase.from('objective_events').insert({ objective_id: open[0].id, actor: 'system', kind: 'reattached', summary: `Seen again: "${ev.subject}" ${String(ev.received_at).slice(0, 10)}. ${s.observed[0].fact}`, ref_message_id: ev.id });
        out.results.push({ signal: s, case_id: open[0].id, reattached: true }); continue;
      }
    }
    const fb = await investigate(supabase, s, ev);
    const a = assess(s, ev);
    const acted = await act(supabase, s, a, ev, fb);
    let caseId = null, esc = null;
    // Escalate only when needed: high risk or an action beyond the owner's permission, and not when
    // a person or teammate is already handling it (the inquiry already went out).
    const needEd = (a.escalate && !acted.contacted) || acted.refused.length;
    if (store) { caseId = await persist(supabase, s, a, ev, fb, acted); if (needEd) esc = await escalate(supabase, caseId, s, a, acted, { notify: send }); }
    else if (needEd) esc = { text: `(dry run) ${NAMES[a.owner]}: ${a.headline}. Risk ${a.risk}.`, delivered: false };
    const d = acted.done.find((x) => x.draft);
    if (d && !out.draft) out.draft = d.draft;
    out.results.push({ signal: s, assessment: a, fact_basis: fb, acted, case_id: caseId, escalation: esc });
  }
  return out;
}

module.exports = { evaluate, investigate, assess, act, normalize, alreadyContacted };
