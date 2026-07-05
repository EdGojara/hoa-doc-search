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
  "vendor_name": "if from or about a vendor/company, its name, else empty"
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

async function classifyAndExtract(email) {
  const text = `From: ${email.sender_name || ''} <${email.sender_email || ''}>
Subject: ${email.subject || ''}
Body:
${(email.body_full || email.body_preview || '').slice(0, 6000)}`;
  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 900,
    messages: [{ role: 'user', content: [{ type: 'text', text: CLASSIFY_PROMPT + text }] }],
  });
  const raw = (resp.content[0] && resp.content[0].text) || '{}';
  let j;
  try { j = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim()); }
  catch (e) { j = { classification: 'other', classification_confidence: 'low', is_spam: false, summary: '(could not parse classification)', _raw: raw.slice(0, 300) }; }
  return j;
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
async function resolveEntities(ex, email, sb) {
  const comms = await communityMap(sb);
  const community = matchCommunity(ex.community_hint, comms);
  const out = { community_id: community ? community.id : null, contact_id: null, property_id: null, vendor_id: null, confidence: 'none', candidates: [] };

  // 1) SENDER EMAIL -> contact (strongest signal for identity)
  const from = (email.sender_email || '').toLowerCase().trim();
  if (from) {
    const { data: c } = await sb.from('contacts')
      .select('id, full_name, primary_email, secondary_email')
      .or(`primary_email.ilike.${from},secondary_email.ilike.${from}`).limit(3);
    for (const ct of (c || [])) {
      const owns = await ownershipFor(sb, ct.id);
      const own = owns[0];
      out.candidates.push({ type: 'contact', id: ct.id, label: ct.full_name, score: 0.95, why: 'sender email on file', property_id: own ? own.property_id : null, community_id: own && own.properties ? own.properties.community_id : null });
    }
    if ((c || []).length === 1) {
      out.contact_id = c[0].id; out.confidence = 'high';
      const owns = await ownershipFor(sb, c[0].id);
      if (owns[0]) { out.property_id = owns[0].property_id; if (owns[0].properties) out.community_id = owns[0].properties.community_id; }
    }
  }

  // 2) ADDRESS -> property (for violation reports especially — the SUBJECT
  //    property, which may differ from the sender). Scope by community if known.
  for (const addr of (ex.addresses || [])) {
    const num = (String(addr).match(/^\s*(\d{3,6})/) || [])[1];
    const street = String(addr).replace(/^\s*\d+\s*/, '').replace(/,.*$/, '').trim().split(/\s+/).slice(0, 2).join(' ');
    if (!street) continue;
    let q = sb.from('properties').select('id, street_address, community_id').ilike('street_address', `%${street}%`);
    if (out.community_id) q = q.eq('community_id', out.community_id);
    const { data: props } = await q.limit(6);
    for (const p of (props || [])) {
      const exact = num && p.street_address.trim().startsWith(num);
      out.candidates.push({ type: 'property', id: p.id, label: p.street_address, score: exact ? 0.9 : 0.5, why: exact ? 'address matches (number+street)' : 'street matches, number differs', community_id: p.community_id });
    }
    // if exactly one exact-number match, adopt it as the subject property
    const exacts = (props || []).filter((p) => num && p.street_address.trim().startsWith(num));
    if (exacts.length === 1 && !out.property_id) { out.property_id = exacts[0].id; if (!out.community_id) out.community_id = exacts[0].community_id; if (out.confidence === 'none') out.confidence = 'medium'; }
  }

  // 3) NAME (+community) -> contact candidates (when email didn't resolve).
  if (!out.contact_id) {
    for (const nm of (ex.person_names || [])) {
      const last = String(nm).trim().split(/\s+/).pop();
      if (!last || last.length < 3) continue;
      const { data: cs } = await sb.from('contacts').select('id, full_name, primary_email').ilike('full_name', `%${last}%`).limit(8);
      for (const ct of (cs || [])) {
        // prefer those whose ownership is in the hinted community
        let inComm = false, pid = null;
        if (out.community_id) { const owns = await ownershipFor(sb, ct.id); const m = owns.find((o) => o.properties && o.properties.community_id === out.community_id); if (m) { inComm = true; pid = m.property_id; } }
        out.candidates.push({ type: 'contact', id: ct.id, label: ct.full_name, score: inComm ? 0.7 : 0.35, why: inComm ? 'name + community match' : 'name match (multiple possible)', property_id: pid });
      }
    }
    const strong = out.candidates.filter((c) => c.type === 'contact' && c.score >= 0.7);
    if (strong.length === 1) { out.contact_id = strong[0].id; if (strong[0].property_id) out.property_id = out.property_id || strong[0].property_id; if (out.confidence === 'none') out.confidence = 'medium'; }
    else if (strong.length === 0 && out.candidates.some((c) => c.type === 'contact')) { out.confidence = out.confidence === 'none' ? 'low' : out.confidence; }
  }

  // 4) SENDER -> vendor (email or domain or name)
  const domain = from.split('@')[1] || '';
  if (from) {
    const { data: v } = await sb.from('vendors').select('id, name, email, contact_email').or(`email.ilike.${from},contact_email.ilike.${from}`).limit(3);
    if (v && v.length) { out.vendor_id = v[0].id; out.candidates.push({ type: 'vendor', id: v[0].id, label: v[0].name, score: 0.9, why: 'vendor email on file' }); if (out.confidence === 'none') out.confidence = 'high'; }
    else if (ex.vendor_name) {
      const { data: vn } = await sb.from('vendors').select('id, name').ilike('name', `%${String(ex.vendor_name).split(/\s+/)[0]}%`).limit(3);
      for (const vv of (vn || [])) out.candidates.push({ type: 'vendor', id: vv.id, label: vv.name, score: 0.5, why: 'vendor name match' });
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
