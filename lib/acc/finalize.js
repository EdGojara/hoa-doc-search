// ============================================================================
// lib/acc/finalize.js  (Issue #14, Ed 2026-10-02)
// ----------------------------------------------------------------------------
// The decision-critical core of POST /acc-review/decisions/:id/finalize:
// claim the case, email the homeowner, and record the outcome, so a FINAL
// decision (approve / deny / incomplete) is emailed AT MOST ONCE and a failed
// email never leaves the case looking decided.
//
// Why: the old guard used acknowledged_at as "decision already emailed". But
// acknowledged_at is also stamped by the receipt acknowledgment, by staff
// replies and by request-more-info emails, so any earlier correspondence made a
// later FINAL decision silently not send (the server reported "already sent"
// and marked the case done anyway) and the screen disabled "Send to homeowner".
//
// Now, for a final decision, the case is CLAIMED with one conditional update
// (open -> decided). Only one request can win it: a double-click, a retry or a
// second tab finds the case already decided and is refused, nothing is sent
// again. If the email then fails, the claim is reverted to exactly what it was,
// so the case is back in the queue and can be retried. Prior correspondence
// (acknowledged_at) no longer blocks anything.
//
// request_more_info is not final: the case stays open and is not claimed.
// ============================================================================

const OPEN_STATUSES = ['pending_review', 'awaiting_info'];

// A drafted letter may carry "[STAFF: ...]" where a fact was missing (e.g. which
// governing provision a denial rests on). Such a letter must not go out.
const PLACEHOLDER_RE = /\[\s*STAFF\s*:/i;

async function finalizeAccDecision(supabase, { dec, decisionType, bodyText, toEmail, send, actorId, letterStoragePath, sendEmail, now = () => new Date().toISOString() }) {
  const isFinal = decisionType !== 'request_more_info';
  if (PLACEHOLDER_RE.test(String(bodyText || ''))) {
    return { ok: false, httpStatus: 400, error: 'The letter still has a [STAFF: ...] placeholder where a fact is missing. Fill it in (or remove it) before sending.' };
  }
  if (send && !String(toEmail || '').trim()) {
    return { ok: false, httpStatus: 400, error: 'Enter the homeowner\'s email, or use "Mark done without emailing".' };
  }

  // A request for more information only makes sense on an open case; never
  // rewrite a decided / closed one.
  if (!isFinal && !OPEN_STATUSES.includes(dec.status)) {
    return { ok: false, httpStatus: 409, already_decided: true, error: `This application is no longer open (${dec.status}). Nothing was sent.` };
  }

  // 1) FINAL: claim the case (open -> decided) atomically, before anything is sent.
  if (isFinal) {
    const at = now();
    const claim = await supabase.from('acc_decisions').update({
      status: 'decided', decision_type: decisionType, letter_body: bodyText,
      letter_pdf_storage_path: letterStoragePath, decided_by_user_id: actorId || null,
      decided_at: at, updated_at: at,
    }).eq('id', dec.id).in('status', OPEN_STATUSES).select('id');
    if (claim.error) return { ok: false, httpStatus: 500, error: `could not record the decision: ${claim.error.message}` };
    if (!claim.data || !claim.data.length) {
      const { data: cur } = await supabase.from('acc_decisions').select('status, decision_type, decided_at').eq('id', dec.id).maybeSingle();
      return {
        ok: false, httpStatus: 409, already_decided: true,
        error: `This application is no longer open (${(cur && cur.status) || 'unknown'}${cur && cur.decided_at ? ', decided ' + String(cur.decided_at).slice(0, 10) : ''}). Nothing was sent again.`,
        current: cur || null,
      };
    }
  }

  // 2) Email the homeowner (only when asked).
  const email = { attempted: false, sent: false };
  if (send) {
    email.attempted = true;
    try { await sendEmail(); email.sent = true; }
    catch (e) { email.error = e.message; }
  }

  if (email.attempted && !email.sent) {
    if (isFinal) {
      // Put the case back exactly as it was, so it is still in the queue and can be retried.
      const rev = await supabase.from('acc_decisions').update({
        status: dec.status, decision_type: dec.decision_type ?? null, letter_body: dec.letter_body ?? null,
        letter_pdf_storage_path: dec.letter_pdf_storage_path ?? null, decided_by_user_id: dec.decided_by_user_id ?? null,
        decided_at: dec.decided_at ?? null, updated_at: now(),
      }).eq('id', dec.id).eq('status', 'decided');
      if (rev.error) {
        return { ok: false, httpStatus: 502, email, reverted: false,
          error: `The decision email could not be sent (${email.error}) AND the case could not be put back in the queue (${rev.error.message}). It shows as decided but the homeowner was NOT emailed; fix it before retrying.` };
      }
    }
    return { ok: false, httpStatus: 502, email, reverted: isFinal,
      error: `The decision letter was generated but could not be emailed to the homeowner: ${email.error || 'unknown'}. Nothing was marked done; you can retry, or download the letter and send it manually.` };
  }

  // 3) NOT final (request_more_info): record the working letter; the case stays open.
  if (!isFinal) {
    const up = await supabase.from('acc_decisions').update({
      decision_type: decisionType, letter_body: bodyText, letter_pdf_storage_path: letterStoragePath,
      decided_by_user_id: actorId || null, updated_at: now(),
    }).eq('id', dec.id);
    if (up.error) return { ok: false, httpStatus: 500, email, error: `could not record the request: ${up.error.message}` };
  }

  return { ok: true, final: isFinal, email, new_status: isFinal ? 'decided' : dec.status };
}

module.exports = { finalizeAccDecision, OPEN_STATUSES, PLACEHOLDER_RE };
