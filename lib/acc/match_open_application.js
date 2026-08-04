// ============================================================================
// lib/acc/match_open_application.js  (Ed 2026-08-03)
// ----------------------------------------------------------------------------
// "Link the names + emails on an inbound ACC email to the RIGHT open
// application" — the fix for the fragmentation that stranded the Lopez patio
// (EAG-ARC-2026-0001) across three separate acc_decisions rows.
//
// The old matcher (lib/applications/email_intake.js) matched an open case by
// EXACT submitter_email or RAW ilike address. Both are too brittle:
//   - A homeowner emails from a different address than the one on the form
//     (Maria's form said LPZMAR555@yahoo; she wrote from lpzmartaxes@gmail).
//   - Address punctuation/case differs between the form and the reply
//     ("9202 Floral Crest Dr, ..." vs "9202 FLORAL CREST DR. ..."), so exact
//     ilike misses.
// Every miss spawned a NEW decision instead of attaching, so the returned
// documents (and the homeowner's real name + email) never joined the case.
//
// This module scores each OPEN decision in the community against the inbound
// email using layered signals — strongest first:
//   1. THREAD   — the email shares a conversation with a message already on the
//                 case (source_email_refs). Bulletproof for follow-ups.
//   2. REFERENCE— the case's reference number appears in the subject/body.
//   3. EMAIL    — the sender/applicant email is any address KNOWN for the case
//                 (submitter_email OR the accumulated correspondent_emails).
//   4. ADDRESS  — NORMALIZED property address matches (punctuation-insensitive).
//   5. NAME     — homeowner name matches (weak; never crosses the bar alone).
//
// Pure scoring (scoreCandidate / pickBestOpenApp) is DB-free and unit-tested.
// findOpenAccApplication is the thin DB wrapper. captureCorrespondent is the
// "link it" half: every external address that writes about a case is recorded
// on the case (correspondent_emails) so the NEXT email from that address
// matches on signal #3 even without the thread — the link compounds.
//
// Record ownership: acc_decisions is workpaper (the SENT letter is sealed
// separately as association_record). No new table; columns added by mig 351.
// Degrades gracefully if mig 351 (correspondent_emails / conversation_id)
// isn't applied yet — matching still works on the pre-existing signals.
// ============================================================================

const OPEN_STATUSES = ['pending_review', 'awaiting_info'];
const GENERIC_NAMES = new Set(['', 'homeowner', 'not listed', 'resident', 'owner', 'applicant', 'n a', 'na']);

function normAddr(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function normName(s) { return String(s || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().replace(/\s+/g, ' '); }
function normEmail(s) { return String(s || '').toLowerCase().trim(); }

// Surnames overlap? "simon and maria lopez" vs "maria lopez" -> shared token.
function sharesNameToken(a, b) {
  const ta = new Set(normName(a).split(' ').filter((t) => t.length > 2));
  const tb = normName(b).split(' ').filter((t) => t.length > 2);
  return tb.some((t) => ta.has(t));
}

// candidate: an open acc_decisions row (needs id, submitter_email,
//   homeowner_address, homeowner_name, reference_number, source_email_refs,
//   correspondent_emails?, created_at).
// signals: { referenceText, emails:[], name, address, siblingRefs:Set<'email:<gid>'> }
function scoreCandidate(cand, sig) {
  let score = 0;
  const reasons = [];

  const refs = Array.isArray(cand.source_email_refs) ? cand.source_email_refs : [];
  if (sig.siblingRefs && sig.siblingRefs.size && refs.some((r) => sig.siblingRefs.has(r))) {
    score += 100; reasons.push('thread');
  }

  if (cand.reference_number && sig.referenceText) {
    const rx = new RegExp('\\b' + String(cand.reference_number).replace(/[.*+?^${}()|[\]\\-]/g, '\\$&') + '\\b', 'i');
    if (rx.test(sig.referenceText)) { score += 90; reasons.push('reference'); }
  }

  const known = new Set(
    [normEmail(cand.submitter_email), ...((cand.correspondent_emails || []).map(normEmail))].filter(Boolean)
  );
  if (Array.isArray(sig.emails) && sig.emails.map(normEmail).some((e) => e && known.has(e))) {
    score += 80; reasons.push('email');
  }

  if (cand.homeowner_address && sig.address) {
    const a = normAddr(cand.homeowner_address);
    const b = normAddr(sig.address);
    if (a && b && (a === b || a.includes(b) || b.includes(a))) { score += 70; reasons.push('address'); }
  }

  // Name is a WEAK corroborator — a shared surname alone must not attach a
  // stranger's email to someone's case. It adds confidence to a match already
  // above the bar, or combines with another mid-signal.
  if (cand.homeowner_name && sig.name) {
    const a = normName(cand.homeowner_name);
    const b = normName(sig.name);
    if (a && b && !GENERIC_NAMES.has(a) && !GENERIC_NAMES.has(b) && (a === b || a.includes(b) || b.includes(a) || sharesNameToken(a, b))) {
      score += 25; reasons.push('name');
    }
  }

  return { score, reasons };
}

// Attach only on a confident match: any ONE strong signal (thread/reference/
// email/address all >= 70) clears the bar; name alone (25) never does.
function pickBestOpenApp(candidates, sig, { threshold = 70 } = {}) {
  let best = null;
  for (const c of (candidates || [])) {
    const { score, reasons } = scoreCandidate(c, sig);
    if (score < threshold) continue;
    const better = !best || score > best.score ||
      (score === best.score && new Date(c.created_at || 0) > new Date(best.cand.created_at || 0));
    if (better) best = { cand: c, score, reasons };
  }
  return best;
}

// Fetch open decisions for the community, degrading if mig 351 columns are
// missing. Returns { rows, hasCorrespondent }.
async function fetchOpenDecisions(supabase, communityId) {
  const base = 'id, submitter_email, homeowner_address, homeowner_name, reference_number, source_email_refs, created_at';
  let { data, error } = await supabase.from('acc_decisions')
    .select(base + ', correspondent_emails')
    .eq('community_id', communityId).in('status', OPEN_STATUSES)
    .order('created_at', { ascending: false }).limit(200);
  if (error && /correspondent_emails/.test(error.message || '')) {
    ({ data, error } = await supabase.from('acc_decisions')
      .select(base)
      .eq('community_id', communityId).in('status', OPEN_STATUSES)
      .order('created_at', { ascending: false }).limit(200));
    return { rows: error ? [] : (data || []), hasCorrespondent: false };
  }
  return { rows: error ? [] : (data || []), hasCorrespondent: !error };
}

// Collect 'email:<graphId>' refs for every message in the inbound email's
// Graph conversation, so a follow-up matches the case a sibling message opened.
async function conversationSiblingRefs(supabase, conversationId) {
  const set = new Set();
  if (!conversationId) return set;
  const { data, error } = await supabase.from('email_messages')
    .select('graph_id').eq('conversation_id', conversationId).limit(500);
  if (error) return set;
  for (const m of (data || [])) if (m.graph_id) set.add('email:' + m.graph_id);
  return set;
}

async function findOpenAccApplication({ supabase, communityId, inboundEmail = {}, applicantEmail = null, applicantName = null, propertyAddress = null, referenceText = null }) {
  if (!communityId) return null;
  const { rows } = await fetchOpenDecisions(supabase, communityId);
  if (!rows.length) return null;

  // Resolve conversation_id — off the passed email, else look it up by id.
  let conversationId = inboundEmail && inboundEmail.conversation_id;
  if (!conversationId && inboundEmail && inboundEmail.id) {
    try {
      const { data } = await supabase.from('email_messages').select('conversation_id').eq('id', inboundEmail.id).maybeSingle();
      conversationId = data && data.conversation_id;
    } catch (_) { /* best-effort */ }
  }
  const siblingRefs = await conversationSiblingRefs(supabase, conversationId);

  const sig = {
    referenceText: [referenceText, inboundEmail && inboundEmail.subject].filter(Boolean).join(' \n '),
    emails: [applicantEmail, inboundEmail && inboundEmail.sender_email].filter(Boolean),
    name: applicantName || (inboundEmail && inboundEmail.sender_name) || null,
    address: propertyAddress,
    siblingRefs,
  };

  const best = pickBestOpenApp(rows, sig);
  if (!best) return null;
  return { ...best.cand, _match_score: best.score, _match_reasons: best.reasons, _conversation_id: conversationId || null };
}

// The "link it" half: record the correspondent's email(s) + name + conversation
// on the case so future mail from that address self-matches, and the operator
// sees WHO has written about this application. Best-effort + column-tolerant:
// a missing mig-351 column never breaks intake (the decision still attaches).
async function captureCorrespondent(supabase, { decisionId, emails = [], name = null, conversationId = null, isInternalAddr = () => false }) {
  if (!decisionId) return { ok: false };
  const clean = [...new Set(emails.map(normEmail).filter((e) => e && /.+@.+\..+/.test(e) && !isInternalAddr(e)))];
  try {
    const { data: row, error } = await supabase.from('acc_decisions')
      .select('correspondent_emails, homeowner_name, conversation_id')
      .eq('id', decisionId).maybeSingle();
    if (error) {
      // Columns not there yet — nothing to link; not fatal.
      if (/correspondent_emails|conversation_id/.test(error.message || '')) return { ok: false, reason: 'columns_absent' };
      return { ok: false, reason: error.message };
    }
    const patch = {};
    const existing = Array.isArray(row.correspondent_emails) ? row.correspondent_emails.map(normEmail) : [];
    const merged = [...new Set([...existing, ...clean])];
    if (merged.length !== existing.length) patch.correspondent_emails = merged;
    if (conversationId && !row.conversation_id) patch.conversation_id = conversationId;
    // Backfill a real homeowner name over a generic placeholder.
    if (name && GENERIC_NAMES.has(normName(row.homeowner_name)) && !GENERIC_NAMES.has(normName(name))) {
      patch.homeowner_name = name;
    }
    if (!Object.keys(patch).length) return { ok: true, unchanged: true };
    patch.updated_at = new Date().toISOString();
    const { error: uErr } = await supabase.from('acc_decisions').update(patch).eq('id', decisionId);
    if (uErr) {
      if (/correspondent_emails|conversation_id/.test(uErr.message || '')) return { ok: false, reason: 'columns_absent' };
      return { ok: false, reason: uErr.message };
    }
    return { ok: true, linked: patch.correspondent_emails ? patch.correspondent_emails.length : existing.length };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

module.exports = {
  findOpenAccApplication,
  captureCorrespondent,
  // exported for unit tests:
  scoreCandidate,
  pickBestOpenApp,
  normAddr,
  normName,
  normEmail,
  OPEN_STATUSES,
};
