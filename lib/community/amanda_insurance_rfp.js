// ============================================================================
// lib/community/amanda_insurance_rfp.js  (Ed 2026-09-03)
// ----------------------------------------------------------------------------
// Amanda PRODUCES an insurance RFP on request.
//
// Ed: "create that capability for amanda to be able to do this and prepare an
// insurance RFP to anyone if asked — for example if i email Amanda to prepare
// one for any community she will send one back to me."
//
// A staffer (or Ed, or a board member) emails amanda@ — no attachment — saying
// "prepare the insurance RFP for <community>." Amanda resolves the community,
// builds the RFP from its filed policy-of-record (lib/insurance_rfp_build), and
// replies with the PDF attached. The completeness guard is in front: if the
// program is missing a carried line, she does NOT send half an RFP — she replies
// saying exactly which policy is needed.
//
// This is DISTINCT from lib/insurance_renewal_review.js: that reviews an incoming
// broker PROPOSAL (an attachment); this PREPARES an outbound RFP (no attachment).
// The dispatch in graph_ingest checks the renewal/attachment paths first, so a
// proposal PDF never lands here.
//
// The RFP withholds premium and carrier by default (renderer defaults), which
// keeps it inside Amanda's hard no-financials rule — she may share coverage
// SCOPE, never the association's premium or books.
// ============================================================================

const { buildCommunityRfp } = require('../insurance_rfp_build');

// Intent: an email that ASKS Amanda to prepare/produce/send an insurance RFP.
function isInsuranceRfpRequest(email) {
  const t = [email && email.subject, email && email.body_preview, email && email.body_full]
    .filter(Boolean).join('\n').toLowerCase();
  if (!t) return false;
  const insurance = /\binsurance\b|\bp\s*&\s*c\b|property\s*&?\s*casualty/.test(t);
  const rfp = /\brfp\b|request\s*(?:-|for)?\s*proposal|request for proposal/.test(t);
  const verb = /\b(prepare|produce|create|generate|put together|pull together|draft|build|send|make|run|need|want|get)\b/.test(t);
  // "insurance rfp" together is a strong-enough signal on its own.
  const together = /insurance\s+(?:rfp|request\s*(?:-|for)?\s*proposal)|(?:rfp|request\s*(?:-|for)?\s*proposal)\s+(?:for\s+)?(?:the\s+)?insurance/.test(t);
  return together || (insurance && rfp && verb);
}

// Resolve which community the request is about. Prefer an explicit name in the
// text; fall back to the community the thread already resolved to.
async function resolveRfpCommunity(supabase, email, fallbackCommunityId) {
  const t = [email && email.subject, email && email.body_preview, email && email.body_full]
    .filter(Boolean).join('\n').toLowerCase();
  try {
    const { data: comms } = await supabase.from('communities').select('id, name').limit(500);
    const list = (comms || []).slice().sort((a, b) => (b.name || '').length - (a.name || '').length);
    for (const c of list) {
      const name = String(c.name || '').toLowerCase().trim();
      if (!name) continue;
      if (t.includes(name)) return { id: c.id, name: c.name };
      const first = name.split(/\s+/)[0];
      if (first && first.length >= 5 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) {
        return { id: c.id, name: c.name };
      }
    }
  } catch (_) { /* fall through to the resolved community */ }
  if (fallbackCommunityId) {
    const { data: c } = await supabase.from('communities').select('id, name').eq('id', fallbackCommunityId).maybeSingle();
    if (c) return { id: c.id, name: c.name };
  }
  return null;
}

function firstName(email) {
  const n = String((email && email.sender_name) || '').trim();
  return n ? n.split(/\s+/)[0] : null;
}

// Produce Amanda's reply. Returns { draftable, subject, body, attachments?, careful, review_hint }.
async function draftAmandaInsuranceRfp({ email, supabase, communityId, communityName }) {
  if (!isInsuranceRfpRequest(email)) return { draftable: false };

  const hi = firstName(email) ? `Hi ${firstName(email)},` : 'Hi,';
  const resolved = await resolveRfpCommunity(supabase, email, communityId);

  if (!resolved) {
    return {
      draftable: true, careful: true, persona: 'amanda',
      subject: `Re: ${email.subject || 'Insurance RFP'}`,
      body: `${hi}\n\nHappy to put the insurance RFP together — which community is it for? Once you tell me, I'll generate it from that community's policy of record and send it right back.`,
      review_hint: 'insurance RFP request — community not identified',
    };
  }

  let result;
  try {
    result = await buildCommunityRfp({ supabase, communityId: resolved.id });
  } catch (e) {
    return {
      draftable: true, careful: true, persona: 'amanda',
      subject: `Re: ${email.subject || 'Insurance RFP'}`,
      body: `${hi}\n\nI tried to generate the insurance RFP for ${resolved.name} but hit a snag building the document. I've flagged it so we can sort it out and get it to you.`,
      review_hint: `insurance RFP build error: ${e.message}`,
    };
  }

  if (result.no_program) {
    return {
      draftable: true, careful: true, persona: 'amanda',
      subject: `Re: ${email.subject || 'Insurance RFP'}`,
      body: `${hi}\n\nI don't have an insurance program of record on file for ${resolved.name} yet, so I can't generate the RFP. If the current policy declarations (property, general liability, D&O, umbrella, crime, cyber, workers comp) are uploaded to the community's insurance file, I can produce the complete RFP and send it over.`,
      review_hint: `insurance RFP request — no program of record for ${resolved.name}`,
    };
  }

  if (!result.ok) {
    const missing = (result.completeness && result.completeness.blockers || []).map((b) => `  • ${b}`).join('\n');
    return {
      draftable: true, careful: true, persona: 'amanda',
      subject: `Re: ${email.subject || 'Insurance RFP'}`,
      body: `${hi}\n\nI started the insurance RFP for ${resolved.name}, but I'm holding it because our program of record is missing coverage the association carries — sending it now would ask agents to quote an incomplete program:\n\n${missing}\n\nOnce the missing declarations page(s) are uploaded to the community's insurance file, I'll generate the complete RFP and send it right over.`,
      review_hint: `insurance RFP blocked — incomplete program for ${resolved.name}`,
    };
  }

  const nLines = (result.program.coverages || []).length;
  return {
    draftable: true, careful: false, persona: 'amanda',
    subject: `Insurance RFP — ${resolved.name}`,
    body: `${hi}\n\nAttached is the insurance RFP for ${resolved.name}. It sets out the coverage scope we need each agency to quote — ${nLines} lines, with the limits, deductibles, and key terms to match — and deliberately withholds our current carrier and premium so the quotes come back on the merits rather than just under what we pay now.\n\nIt's ready to send to the agents as-is; let me know if you'd like anything adjusted first.`,
    attachments: [{ filename: result.filename, buffer: result.pdfBuffer, contentType: 'application/pdf' }],
    review_hint: `insurance RFP generated for ${resolved.name} (${nLines} lines)`,
  };
}

module.exports = { isInsuranceRfpRequest, resolveRfpCommunity, draftAmandaInsuranceRfp };
