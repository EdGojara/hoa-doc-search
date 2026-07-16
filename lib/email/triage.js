// ============================================================================
// lib/email/triage.js  (Ed 2026-07-05)
// ----------------------------------------------------------------------------
// Communications hub Phase 1 — turn a raw email into a classified, entity-linked
// triage row. Two stages, mirroring the extract->validate->render discipline:
//   1) classifyAndExtract(email)  — Claude reads it: what kind, who, what,
//      addresses, amounts, ticket #, community, requested action, is-it-spam.
//   2) resolveEntities(extracted, email, sb) — TRIANGULATE against real records
//      (sender email -> contact -> ownership -> property/community; address ->
//      property; name+community -> candidate contacts; sender -> vendor).
//
// Resolution never guesses silently: it returns a confidence and, when it's not
// certain, the ranked candidates for a human to confirm on the triage board.
// Confirming writes back (a human's one click becomes the system's next
// auto-match) — that loop is the encode-Ed payoff (project_institutional_memory_thesis).
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { firstNamesMatch } = require('../entity_resolution');

const MODEL = 'claude-sonnet-4-5';

const CLASSIFY_PROMPT = `You are triaging an email sent to an HOA management company's shared inbox (Bedrock Association Management). Read it and return ONLY valid JSON (no preamble, no markdown fences):

{
  "classification": "homeowner_request | violation_report | acc_request | vendor_financial | vendor_general | legal_privileged | internal | spam | other",
  "classification_confidence": "high | medium | low",
  "is_spam": true|false,
  "priority": "high | normal | low",
  "summary": "one plain sentence: who wants what",
  "requested_action": "short phrase of what the sender wants done, or empty",
  "community_hint": "the HOA/community name mentioned (e.g. 'Waterview Estates', 'Eaglewood', 'Quail Ridge'), or empty",
  "person_names": ["full names of homeowners/people mentioned as the subject of the matter"],
  "addresses": ["any street addresses mentioned in the body"],
  "amounts": ["any dollar amounts mentioned"],
  "ticket_ref": "any ticket/case number like [#XN110826], or empty",
  "vendor_name": "if from or about a vendor/company, its name, else empty",
  "account_number": "the service/account/policy number this bill or notice references (e.g. 'account ending 3031', a utility account #), digits only if shown, else empty",
  "sender_phone": "the SENDER'S OWN phone number from their signature (e.g. 'Cell 832-247-1512'), NOT a number mentioned in the body about someone else; digits and dashes only, or empty"
}

CLASSIFICATION GUIDE:
- homeowner_request: a resident asking for something (pool tag, gate remote, statement, general question).
- violation_report: someone reporting a deed-restriction/nuisance issue (uncut yard, parked vehicle, trash) — often names another property's address.
- acc_request: architectural/ACC application, contractor notice, request to make an exterior change.
- vendor_financial: invoice, auto-pay notice, billing statement, payment confirmation from a vendor/utility.
- vendor_general: non-financial vendor/company correspondence (scheduling, service updates).
- legal_privileged: from/about an attorney, or marked privileged. NEVER eligible for automation.
- internal: staff-to-staff or system notifications (quarantine reports, dashboards).
- spam: unsolicited sales/marketing/phishing (loan offers, SEO pitches, "improve your website"). Contact-form submissions whose body is a sales pitch ARE spam even if the subject says "contact form".
- other: anything that doesn't fit.

Be strict about spam — the inbox is full of fake "contact form" and "proposal form" submissions that are actually loan/SEO/AI-marketing pitches.

EMAIL:
`;

// Heuristic fallback used when the AI is unavailable (API down / out of credits)
// so ingest never fully stalls — emails still land + link by sender. Low
// confidence; a re-run once the AI is back upgrades them.
function heuristicClassify(email) {
  const s = ((email.subject || '') + ' ' + (email.body_full || email.body_preview || '')).toLowerCase();
  const from = (email.sender_email || '').toLowerCase();
  const isSpam = /loan offer|\bseo\b|improve your (online|website)|ready.to.buy|chatgpt|gemini|quick chat|limited.?time (loan|offer)/.test(s) || (/proposal form|contact form/.test(s) && /loan|market|sales|client|visibility/.test(s));
  const isVendorFin = /donotreply|no-?reply|billing|firstbilling/.test(from) || /auto-?pay|invoice|statement|payment (is|will|of)/.test(s);
  const isInternal = /appriver|comcast|quarantine|alerts?\.|notice@/.test(from) || /quarantined message|dashboard report|monthly report/.test(s);
  const classification = isSpam ? 'spam' : isVendorFin ? 'vendor_financial' : isInternal ? 'internal' : 'other';
  return { classification, classification_confidence: 'low', is_spam: isSpam, priority: 'normal', summary: (email.subject || '(email)'), requested_action: '', community_hint: '', person_names: [], addresses: [], amounts: [], ticket_ref: '', vendor_name: '', _fallback: true };
}

async function classifyAndExtract(email) {
  const text = `From: ${email.sender_name || ''} <${email.sender_email || ''}>
Subject: ${email.subject || ''}
Body:
${(email.body_full || email.body_preview || '').slice(0, 6000)}`;
  let raw;
  try {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 900,
      messages: [{ role: 'user', content: [{ type: 'text', text: CLASSIFY_PROMPT + text }] }],
    });
    raw = (resp.content[0] && resp.content[0].text) || '{}';
  } catch (e) {
    console.warn('[email triage] AI classify unavailable, using heuristic fallback:', e.message.slice(0, 80));
    return heuristicClassify(email);
  }
  try { return JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim()); }
  catch (e) { return { classification: 'other', classification_confidence: 'low', is_spam: false, summary: '(could not parse classification)', _raw: raw.slice(0, 300) }; }
}

// ---- Resolution helpers -----------------------------------------------------
async function communityMap(sb) {
  const { data } = await sb.from('communities').select('id, name');
  return (data || []);
}
function matchCommunity(hint, comms) {
  if (!hint) return null;
  const h = String(hint).toLowerCase();
  // exact-ish contains either direction on the distinctive word
  let best = null;
  for (const c of comms) {
    const n = String(c.name || '').toLowerCase();
    if (!n) continue;
    if (n === h || n.includes(h) || h.includes(n.split(' ')[0])) { best = c; break; }
  }
  return best;
}

async function ownershipFor(sb, contactId) {
  const { data } = await sb.from('property_ownerships')
    .select('property_id, is_primary, end_date, properties(street_address, community_id)')
    .eq('contact_id', contactId).is('end_date', null).limit(5);
  return (data || []);
}

// Triangulate. Returns { community_id, contact_id, property_id, vendor_id,
// confidence, candidates:[{type,id,label,score,why}] }.
// True if any extracted person name's tokens ALL appear in the owner's full
// name — e.g. "Fred Jones" corroborates "Fred & Shelby Jones". Used to confirm
// a sender against the owner of an exactly-matched address.
function nameCorroborates(personNames, fullName) {
  const fn = String(fullName || '').toLowerCase();
  if (!fn) return false;
  for (const nm of (personNames || [])) {
    const toks = String(nm).toLowerCase().split(/\s+/).map((t) => t.replace(/[^a-z0-9]/g, '')).filter((t) => t.length >= 3);
    if (toks.length && toks.every((t) => fn.includes(t))) return true;
  }
  return false;
}

async function resolveEntities(ex, email, sb) {
  const comms = await communityMap(sb);
  let community = matchCommunity(ex.community_hint, comms);
  // Name didn't match — try the alias registry (MUD / billing entity / DBA), so
  // a "North Mission Glen MUD" auto-pay routes to Eaglewood. (Ed 2026-07-16.)
  if (!community && ex.community_hint) {
    try {
      const { resolveCommunityByAlias } = require('./community_alias');
      const a = await resolveCommunityByAlias(ex.community_hint);
      if (a && a.community_id) community = (comms || []).find((c) => c.id === a.community_id) || { id: a.community_id };
    } catch (_) { /* alias table may not be applied yet */ }
  }
  const out = { community_id: community ? community.id : null, contact_id: null, property_id: null, vendor_id: null, confidence: 'none', candidates: [] };

  // 1) SENDER EMAIL -> contact (strongest signal for identity).
  //    Match across BOTH flat columns AND the contact_methods N-email store,
  //    using a SUBSTRING match — a contact's primary_email often holds several
  //    addresses joined by ';' or ',' (e.g. "a@x.com; b@y.com"), and extra
  //    realtor/work emails live only in contact_methods. An exact match on one
  //    address can't equal a multi-address field, which is why a known email
  //    was falling through to noisy name guesses. One distinct contact = a
  //    confident auto-link; more than one = surface them, don't guess.
  const from = (email.sender_email || '').toLowerCase().trim();
  if (from && /^[^@\s,()]+@[^@\s,()]+\.[^@\s,()]+$/.test(from)) {
    const byId = new Map();
    const { data: cflat } = await sb.from('contacts')
      .select('id, full_name')
      .or(`primary_email.ilike.%${from}%,secondary_email.ilike.%${from}%`).limit(5);
    for (const ct of (cflat || [])) byId.set(ct.id, ct);
    try {
      const { data: cm } = await sb.from('contact_methods')
        .select('contact_id, contacts(id, full_name)')
        .eq('method_type', 'email').ilike('value', `%${from}%`).limit(5);
      for (const r of (cm || [])) if (r.contacts) byId.set(r.contacts.id, { id: r.contacts.id, full_name: r.contacts.full_name });
    } catch (_) { /* contact_methods optional — never break resolution */ }
    const emailHits = [...byId.values()];
    for (const ct of emailHits) {
      const owns = await ownershipFor(sb, ct.id);
      const own = owns[0];
      out.candidates.push({ type: 'contact', id: ct.id, label: ct.full_name, score: 0.95, why: 'sender email on file', property_id: own ? own.property_id : null, community_id: own && own.properties ? own.properties.community_id : null });
    }
    if (emailHits.length === 1) {
      out.contact_id = emailHits[0].id; out.confidence = 'high';
      const owns = await ownershipFor(sb, emailHits[0].id);
      if (owns[0]) { out.property_id = owns[0].property_id; if (owns[0].properties) out.community_id = owns[0].properties.community_id; }
    }
  }

  // 2) ADDRESS -> property (for violation reports especially — the SUBJECT
  //    property, which may differ from the sender). Scope by community if known.
  for (const addr of (ex.addresses || [])) {
    const num = (String(addr).match(/^\s*(\d{3,6})/) || [])[1];
    const street = String(addr).replace(/^\s*\d+\s*/, '').replace(/,.*$/, '').trim().split(/\s+/).slice(0, 2).join(' ');
    if (!street) continue;
    // Exact number+street lookup FIRST — a broad "%street%" with a small limit
    // can miss THE property on a long street (28 homes on Ivory Meadows), so
    // target the number directly. Then a broader street query for suggestions.
    let exactProp = null;
    if (num) {
      let eq = sb.from('properties').select('id, street_address, community_id').ilike('street_address', `${num}%${street}%`);
      if (out.community_id) eq = eq.eq('community_id', out.community_id);
      const { data: ep } = await eq.limit(4);
      exactProp = (ep || []).find((p) => p.street_address.trim().startsWith(num)) || null;
    }
    let q = sb.from('properties').select('id, street_address, community_id').ilike('street_address', `%${street}%`);
    if (out.community_id) q = q.eq('community_id', out.community_id);
    const { data: props } = await q.limit(12);
    const seenP = new Set();
    for (const p of [...(exactProp ? [exactProp] : []), ...(props || [])]) {
      if (seenP.has(p.id)) continue; seenP.add(p.id);
      const exact = num && p.street_address.trim().startsWith(num);
      out.candidates.push({ type: 'property', id: p.id, label: p.street_address, score: exact ? 0.9 : 0.5, why: exact ? 'address matches (number+street)' : 'street matches, number differs', community_id: p.community_id });
    }
    // Adopt the exact property AND pull its owner(s). A unique street address is
    // a strong identity signal: when an extracted person name corroborates the
    // owner ("Fred Jones" about 4935 Ivory Meadows, owned by "Fred & Shelby
    // Jones"), the sender IS that owner — link with high confidence. Without a
    // name match the address may be a neighbor's (a report about someone else),
    // so surface the owner as a candidate but don't auto-link.
    const prop = exactProp || (props || []).find((p) => num && p.street_address.trim().startsWith(num));
    if (prop) {
      if (!out.property_id) { out.property_id = prop.id; if (!out.community_id) out.community_id = prop.community_id; if (out.confidence === 'none') out.confidence = 'medium'; }
      try {
        const { data: owns } = await sb.from('property_ownerships').select('contact_id, contacts(id, full_name)').eq('property_id', prop.id).is('end_date', null).limit(4);
        for (const o of (owns || [])) {
          if (!o.contacts) continue;
          const corrob = nameCorroborates(ex.person_names, o.contacts.full_name);
          out.candidates.push({ type: 'contact', id: o.contacts.id, label: o.contacts.full_name, score: corrob ? 0.92 : 0.6, why: corrob ? `name matches the owner of ${prop.street_address}` : `owner of ${prop.street_address}`, property_id: prop.id, community_id: prop.community_id });
          if (corrob && !out.contact_id) { out.contact_id = o.contacts.id; out.confidence = 'high'; }
        }
      } catch (_) { /* ownership lookup best-effort */ }
    }
  }

  // 3a) SENDER NAME -> contact (the strongest name signal). The From display
  //     name ("Jim Storm") identifies WHO sent it, unlike names merely mentioned
  //     in the thread. Nickname-aware (Jim=James, Bob=Robert). A single
  //     in-community contact whose surname AND first name (or nickname) match the
  //     sender is a confident link — beats the pile of thread-name guesses.
  if (!out.contact_id && email.sender_name) {
    const parts = String(email.sender_name).trim().split(/\s+/).filter(Boolean);
    const sLast = parts[parts.length - 1];
    const sFirst = parts.length > 1 ? parts[0] : null;
    if (sLast && sLast.length >= 3 && sFirst) {
      const { data: cs } = await sb.from('contacts').select('id, full_name').ilike('full_name', `%${sLast}%`).limit(10);
      const matches = [];
      for (const ct of (cs || [])) {
        const toks = String(ct.full_name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        if (!toks.includes(sLast.toLowerCase())) continue;
        if (!toks.some((t) => firstNamesMatch(sFirst, t))) continue;
        let inComm = false, pid = null;
        if (out.community_id) { const owns = await ownershipFor(sb, ct.id); const m = owns.find((o) => o.properties && o.properties.community_id === out.community_id); if (m) { inComm = true; pid = m.property_id; } }
        matches.push({ id: ct.id, label: ct.full_name, inComm, pid });
      }
      const inCommMatches = matches.filter((m) => m.inComm);
      // Unique in-community match (surname + first-name/nickname) = confident.
      // A single match with no community corroboration is weaker (medium).
      const inCommPick = inCommMatches.length === 1 ? inCommMatches[0] : null;
      const pick = inCommPick || (matches.length === 1 ? matches[0] : null);
      if (pick) {
        out.candidates.push({ type: 'contact', id: pick.id, label: pick.label, score: inCommPick ? 0.9 : 0.75, why: 'sender name matches', property_id: pick.pid, community_id: out.community_id });
        out.contact_id = pick.id; if (pick.pid) out.property_id = out.property_id || pick.pid;
        if (inCommPick) out.confidence = 'high'; else if (out.confidence === 'none') out.confidence = 'medium';
      }
    }
  }

  // 3) NAME (+community) -> contact candidates (only when email didn't resolve).
  //    Only surface CORROBORATED matches — in the hinted community, or a name
  //    specific enough (full first+last, or the only contact with that surname).
  //    A bare last-name substring that hits many people is NOT surfaced: that's
  //    the "pile of suggestions that make no sense." Better to show nothing and
  //    say so than to guess.
  if (!out.contact_id) {
    for (const nm of (ex.person_names || []).slice(0, 4)) {
      const parts = String(nm).trim().split(/\s+/).filter(Boolean);
      const last = parts[parts.length - 1];
      const first = parts.length > 1 ? parts[0] : null;
      if (!last || last.length < 3) continue;
      const { data: cs } = await sb.from('contacts').select('id, full_name').ilike('full_name', `%${last}%`).limit(8);
      const rows = cs || [];
      const uniqueSurname = rows.length === 1;
      for (const ct of rows) {
        let inComm = false, pid = null;
        if (out.community_id) { const owns = await ownershipFor(sb, ct.id); const m = owns.find((o) => o.properties && o.properties.community_id === out.community_id); if (m) { inComm = true; pid = m.property_id; } }
        // Specific = both the first and last name appear in the record.
        const fullMatch = !!first && new RegExp(`\\b${first.replace(/[^a-z0-9]/gi, '')}`, 'i').test(ct.full_name || '') && new RegExp(`${last.replace(/[^a-z0-9]/gi, '')}`, 'i').test(ct.full_name || '');
        if (inComm) out.candidates.push({ type: 'contact', id: ct.id, label: ct.full_name, score: 0.7, why: 'name + community match', property_id: pid });
        else if (fullMatch || uniqueSurname) out.candidates.push({ type: 'contact', id: ct.id, label: ct.full_name, score: 0.55, why: 'name match', property_id: pid });
        // else: bare surname among many, no corroboration — dropped as noise.
      }
    }
    const strong = out.candidates.filter((c) => c.type === 'contact' && c.score >= 0.7);
    if (strong.length === 1) { out.contact_id = strong[0].id; if (strong[0].property_id) out.property_id = out.property_id || strong[0].property_id; if (out.confidence === 'none') out.confidence = 'medium'; }
    else if (out.candidates.some((c) => c.type === 'contact')) { if (out.confidence === 'none') out.confidence = 'low'; }
  }

  // 4) SENDER -> vendor (email or domain or name)
  const domain = from.split('@')[1] || '';
  if (from) {
    const { data: v } = await sb.from('vendors').select('id, name, email, contact_email').or(`email.ilike.${from},contact_email.ilike.${from}`).limit(3);
    if (v && v.length) { out.vendor_id = v[0].id; out.candidates.push({ type: 'vendor', id: v[0].id, label: v[0].name, score: 0.9, why: 'vendor email on file' }); if (out.confidence === 'none') out.confidence = 'high'; }
    else if (ex.vendor_name) {
      // Vendor mail does not come FROM vendors. It comes from BILLING PLATFORMS —
      // firstbilling.com (13), quickbooks@notification.intuit.com (6),
      // alerts.comcast.net (6) — or from a colleague forwarding it
      // (mbravo@bedrocktx.com, "Re: Eaglewood", vendor_name "Swim Houston Pool
      // Management"). Matching the SENDER's address can never resolve those, and
      // only 15 of 27 vendors even have an email on file. So 47 of Emma's 54
      // emails carried an extracted vendor_name and exactly ONE resolved — she
      // was answering vendors with no ledger under her. (Ed 2026-07-15: "we need
      // emma to know who the vendors are".)
      //
      // The name IS the signal. Use the SAME progressive matching the GL
      // classifier and the recurrence profiler use — a third private copy of
      // "is this the same vendor?" is the drift that makes one of them silently
      // wrong. Resolve ONLY on a unique hit: binding the wrong vendor is worse
      // than binding none, because it grounds Emma's reply in another company's
      // ledger. Two hits means our own vendor list has duplicates
      // ("Superior LawnCare" vs "Superior LawnCare, LLC") — that's a human call,
      // so offer both as candidates and resolve neither.
      const { vendorSearchTerms } = require('../accounting/gl_classifier');
      for (const term of vendorSearchTerms(ex.vendor_name)) {
        if (term.length < 4) continue;              // "SW", "ACE" — too loose to bet a ledger on
        const { data: vn } = await sb.from('vendors').select('id, name').ilike('name', `%${term}%`).limit(5);
        if (!vn || !vn.length) continue;
        if (vn.length === 1) {
          out.vendor_id = vn[0].id;
          out.candidates.push({ type: 'vendor', id: vn[0].id, label: vn[0].name, score: 0.8, why: `vendor named in the email ("${term}")` });
          if (out.confidence === 'none') out.confidence = 'medium';
        } else {
          for (const vv of vn) out.candidates.push({ type: 'vendor', id: vv.id, label: vv.name, score: 0.5, why: 'vendor name match (ambiguous — more than one vendor matches)' });
        }
        break;                                       // stop at the first term that finds anything
      }
    }
  }

  // Dedup candidates by type+id keeping the highest score
  const seen = {};
  out.candidates = out.candidates.filter((c) => { const k = c.type + ':' + c.id; if (seen[k] && seen[k] >= c.score) return false; seen[k] = c.score; return true; }).sort((a, b) => b.score - a.score).slice(0, 8);

  // Downgrade confidence for spam/no-signal
  if (ex.is_spam) out.confidence = 'none';
  return out;
}

module.exports = { classifyAndExtract, resolveEntities, MODEL };
