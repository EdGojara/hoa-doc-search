// ============================================================================
// lib/banking/bank_correspondence.js — Kat writes to the bank (Ed 2026-10-14)
// ----------------------------------------------------------------------------
// Positive Pay PROCESSING (lib/banking/positive_pay_notice: match, deadline,
// exceptions) is separate from bank CORRESPONDENCE. A routine notice needs no
// reply, so none is drafted automatically; but Kat owns the accounting function,
// including writing to the bank when something needs resolving or when a person
// asks her to. She never refuses a user-directed draft because the email is a
// Positive Pay notice, and every draft waits for a person's approval to send.
//
// Rules for anything Kat sends a bank:
//   * a VERIFIED contact: the bank's configured correspondence contact, else an
//     individual at the bank's domain we have corresponded with BOTH ways before
//     (sent to and heard from), never the automated notice address and never an
//     address on the notice we do not recognize;
//   * a fresh message: no quoted notice (it carries account endings, check numbers,
//     amounts and the very recipient list in question); no additional account data;
//   * facts first (lib/agents/fact_basis): what our records show, what we
//     conclude, and only what remains unknown is asked.
// ============================================================================
const FB = require('../agents/fact_basis');

const AUTOMATED = /^(?:treasury\s*management|treasurymanagement|no-?reply|do-?not-?reply|notifications?|alerts?|service|support|info)@/i;
const domainOf = (a) => String(a || '').toLowerCase().split('@')[1] || '';
const addr = (r) => String((r && (r.address || r.email || (r.emailAddress && r.emailAddress.address))) || r || '').trim().toLowerCase();
const longDate = (iso) => new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });

// The bank contact Kat may write to. settings = banks.positive_pay_settings (+ contact_email).
async function verifiedBankContact(supabase, { bankDomain, settings = {}, contactEmail = null, before = null, exclude = [] }) {
  const no = new Set(exclude.map(addr));
  const configured = addr(settings.correspondence_contact || contactEmail || '');
  if (configured && !no.has(configured)) return { email: configured, name: settings.correspondence_contact_name || null, basis: 'the bank contact on file in trustEd' };
  if (!bankDomain) return null;
  const { data: inb, error: e1 } = await supabase.from('email_messages').select('sender_email, sender_name, received_at').eq('direction', 'inbound').ilike('sender_email', `%@${bankDomain}`).order('received_at', { ascending: true }).limit(1000);
  if (e1) throw new Error(`bank correspondence history: ${e1.message}`);
  // every message we sent (paged, ordered: lib/db/fetch_all), to find who we have written to
  const { fetchAllQuery } = require('../db/fetch_all');
  const outb = await fetchAllQuery(() => supabase.from('email_messages').select('id, recipients, received_at, sent_at').eq('direction', 'outbound').order('received_at', { ascending: true }), { orderBy: 'id' });
  const cut = before ? String(before) : null;
  const heardFrom = new Map();
  for (const m of inb || []) { const a = addr(m.sender_email); if (cut && String(m.received_at) >= cut) continue; if (!heardFrom.has(a)) heardFrom.set(a, { name: m.sender_name, first: m.received_at }); }
  const wroteTo = new Set();
  for (const m of outb || []) { if (cut && String(m.received_at || m.sent_at) >= cut) continue; for (const r of m.recipients || []) wroteTo.add(addr(r)); }
  const two = [...heardFrom.entries()].filter(([a]) => domainOf(a) === bankDomain && wroteTo.has(a) && !AUTOMATED.test(a) && !no.has(a)).sort((x, y) => String(x[1].first).localeCompare(String(y[1].first)));
  if (!two.length) return null;
  const [email, v] = two[0];
  const name = String(v.name || '').replace(/^([^,]+),\s*(.+)$/, '$2 $1').trim() || null;   // "Hess,Melody" -> "Melody Hess"
  return { email, name, basis: `an established two-way correspondence with ${name || email} (first message ${String(v.first).slice(0, 10)})` };
}

// The first notice from this bank on which a recipient appears, and the last one before it without them.
async function recipientHistory(supabase, { bankDomain, address }) {
  const { data, error } = await supabase.from('email_messages').select('received_at, recipients, subject').ilike('sender_email', `%@${bankDomain}`).ilike('subject', '%positive pay%').order('received_at', { ascending: true }).limit(1000);
  if (error) throw new Error(`notice history: ${error.message}`);
  const has = (m) => (m.recipients || []).map(addr).includes(addr(address));
  const all = data || []; const firstIdx = all.findIndex(has);
  if (firstIdx < 0) return { first_seen: null, last_without: null, earlier_count: all.length };
  return { first_seen: all[firstIdx].received_at, last_without: firstIdx > 0 ? all[firstIdx - 1].received_at : null, earlier_count: firstIdx, earliest_reviewed: all.length ? all[0].received_at : null };
}

// Where an address appears in our own records (vendors, contacts, community directory, mail from
// it). Each lookup that fails is reported as unchecked, never as "no match".
async function recordMatches(supabase, address) {
  const a = addr(address); const out = { checked: [], unchecked: [], found: [] };
  const look = async (label, q) => { const { data, error } = await q; if (error) { out.unchecked.push(label); return; } out.checked.push(label); if ((data || []).length) out.found.push(`${label} (${data.length})`); };
  await look('vendors', supabase.from('vendors').select('id').ilike('email', a).limit(5));
  await look('contacts', supabase.from('contacts').select('id').or(`primary_email.ilike.${a},secondary_email.ilike.${a}`).limit(5));
  await look('community directory', supabase.from('community_contacts').select('id').ilike('email', a).limit(5));
  await look('mail from it', supabase.from('email_messages').select('id').ilike('sender_email', a).limit(5));
  return out;
}

// The inquiry about an unfamiliar recipient (Ed's wording, 2026-10-14). Facts in, questions out.
function unfamiliarRecipientInquiry({ address, firstSeen, contactName = null }) {
  const first = firstSeen ? longDate(firstSeen) : null;
  const body = [
    'Good morning,',
    '',
    `While reviewing our Positive Pay notifications, we noticed that ${address} was recently added to the distribution list.`,
    '',
    first ? `Our review of prior notifications indicates that this address first appeared on ${first}. It was not included in the earlier notifications we reviewed.` : null,
    first ? '' : null,
    'We do not recognize this address as an authorized contact for our accounts.',
    '',
    'Could you please confirm:',
    '',
    `1. The exact date and time this address was added.`,
    '2. Who requested and authorized the addition.',
    '3. Whether this address has any access to our banking portal or authority to make Positive Pay decisions.',
    '4. Whether any other changes have been made to our account notification recipients or authorized users.',
    '',
    'If the address was added without authorization, please remove it immediately and confirm the removal.',
    '',
    'Thank you,',
  ].filter((x) => x !== null).join('\n');
  return { subject: 'Positive Pay notification recipient: request for confirmation', body };
}

/**
 * Kat's correspondence about a Positive Pay notice. Always produces a draft for a person to
 * approve; never sends. review = positive_pay_notice.reviewNotice output.
 * notes/currentDraft = the reviewer's direction (Rewrite with my notes).
 */
async function draftForNotice(supabase, { email, review, notes = null, currentDraft = null, draftReply = null }) {
  const bankDomain = (review && review.recipients && review.recipients.bank_domain) || domainOf(email.sender_email);
  let settings = {}; let contactEmail = null;
  try {
    const bankId = ((review && review.items) || []).map((i) => i.bank_id).find(Boolean);
    if (bankId) { const { data } = await supabase.from('banks').select('contact_email, positive_pay_settings').eq('id', bankId).limit(1); if (data && data[0]) { settings = data[0].positive_pay_settings || {}; contactEmail = data[0].contact_email || null; } }
  } catch (_) { /* settings optional */ }
  const strangers = [...new Set(((review && review.recipients && review.recipients.unexpected) || []))];
  const firstStranger = strangers[0] || null;
  const hist = firstStranger ? await recipientHistory(supabase, { bankDomain, address: firstStranger }) : null;
  const contact = await verifiedBankContact(supabase, { bankDomain, settings, contactEmail, before: hist && hist.first_seen, exclude: [...strangers, email.sender_email] });

  const observed = []; const conclusions = []; const unknown = [];
  if (firstStranger && hist) {
    if (hist.first_seen) observed.push({ fact: `${firstStranger} first appears on the ${bankDomain} Positive Pay notice of ${String(hist.first_seen).slice(0, 10)}`, source: `${hist.earlier_count} earlier notices${hist.earliest_reviewed ? ` from ${String(hist.earliest_reviewed).slice(0, 10)}` : ''} reviewed in trustEd` });
    if (hist.last_without) observed.push({ fact: `it is not on the notice of ${String(hist.last_without).slice(0, 10)} or any earlier one`, source: 'trustEd email records' });
    const rm = await recordMatches(supabase, firstStranger);
    if (rm.found.length) observed.push({ fact: `it appears in our records: ${rm.found.join(', ')}`, source: 'trustEd' });
    else if (rm.checked.length) observed.push({ fact: `it is in none of our ${rm.checked.join(', ')}`, source: 'trustEd records checked when drafting' });
    if (rm.unchecked.length) observed.push({ fact: `not checked (lookup failed): ${rm.unchecked.join(', ')}`, source: 'trustEd' });
    conclusions.push({ fact: 'we do not recognize the address as an authorized contact for our accounts' });
    unknown.push({ fact: 'the exact date and time it was added' }, { fact: 'who requested and authorized it' }, { fact: 'whether it has portal access or Positive Pay decision authority' }, { fact: 'whether any other notification recipients or authorized users changed' });
  }
  const items = (review && review.items) || [];
  if (items.length) observed.push({ fact: `${items.filter((i) => i.verdict === 'matched').length} of ${items.length} presented items match our issued-check register`, source: 'Kat\'s Positive Pay review' });
  const fb = FB.basis({ observed, conclusions, unknown });

  let subject, body, how;
  if (firstStranger && !notes && !currentDraft) {
    ({ subject, body } = unfamiliarRecipientInquiry({ address: firstStranger, firstSeen: hist && hist.first_seen, contactName: contact && contact.name }));
    how = 'unfamiliar-recipient inquiry';
  } else if (draftReply) {
    // A person asked for correspondence (or a rewrite): the shared drafter writes it as Kat,
    // grounded in the fact basis and the bank rules. Never "Ed will review/release".
    const rules = `You are Kat Reed, Bedrock's accounting manager, writing to the bank about a Positive Pay matter you own. Positive Pay decisions are made by Bedrock's accounting team; never say that Ed or anyone else "will review and release" items. Do not include account numbers, account endings, check numbers or amounts unless the reviewer's notes ask for them. Write a fresh, concise business email to ${contact ? contact.name || contact.email : 'the bank'}.`;
    const d = await draftReply({ email: { ...email, body_full: '(Positive Pay notice; its item table is withheld from this draft)', body_preview: email.subject }, classification: 'vendor_general', force: true, persona: 'kat', notes: [rules, notes].filter(Boolean).join('\n\n'), currentDraft, factBasis: fb });
    subject = d.subject || `Positive Pay: ${email.subject || 'inquiry'}`; body = d.body; how = notes || currentDraft ? 'reviewer-directed correspondence' : 'user-requested correspondence';
  } else {
    subject = 'Positive Pay inquiry'; body = 'Good morning,\n\n\n\nThank you,'; how = 'blank correspondence (no drafter available)';
  }
  return {
    draftable: true, subject, body, careful: true, persona: 'kat', bank_inquiry: true,
    to: contact ? contact.email : null, to_name: contact ? contact.name : null,
    recipient_source: contact ? `verified bank contact: ${contact.basis}` : 'no verified bank contact on file: enter an address you have verified (not the notice sender)',
    fact_basis: fb,
    review_hint: `Kat's ${how}. Sends as a fresh message (no quoted notice) only after you approve. ${FB.reviewText(fb)}`.trim(),
  };
}

// Send-time guard for a bank inquiry: refuse an unexpected recipient or the automated notice address.
function sendGuard({ to, cc = [], review, noticeSender }) {
  const bad = new Set([...(((review && review.recipients && review.recipients.unexpected) || []).map(addr)), addr(noticeSender)].filter(Boolean));
  const all = [addr(to), ...cc.map(addr)].filter(Boolean);
  const hit = all.filter((a) => bad.has(a) || AUTOMATED.test(a));
  return hit.length ? { ok: false, error: `Not sent: ${hit.join(', ')} is ${hit.some((a) => addr(a) === addr(noticeSender) || AUTOMATED.test(a)) ? 'the bank\'s automated notice address, not a verified contact' : 'an address we do not recognize on the notice'}.` } : { ok: true };
}

module.exports = { recordMatches, verifiedBankContact, recipientHistory, unfamiliarRecipientInquiry, draftForNotice, sendGuard };
