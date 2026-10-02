// ============================================================================
// lib/acc/finalize.js  (Issue #14, Ed 2026-10-02)
// ----------------------------------------------------------------------------
// The decision-critical core of POST /acc-review/decisions/:id/finalize.
//
// SENT MEANS FINAL, ARCHIVED AND IMMUTABLE. One human action completes the case
// in this order, and the case is never marked complete when the homeowner was
// not told:
//
//   1. CLAIM    open -> 'finalizing' (one conditional update; a double-click,
//               retry or second tab finds it no longer open and is refused).
//   2. FILE     seal the exact final letter and the complete ACC record (letter
//               + application + every supporting document + every photo) in the
//               write-once archive, with sha256s (deps.sealRecord). Any failure
//               -> the case goes back exactly as it was; nothing was sent.
//   3. SEND     email the homeowner (deps.composeEmail + deps.sendEmail). A
//               failure -> the case goes back exactly as it was.
//   4. RECORD   append the finalization record: the exact email (from, to,
//               subject, text, html, attachment + sha256, sent time), the letter
//               text + sha256, the packet sha256, every source document + sha256,
//               reviewer, reference, homeowner (deps.recordFinalization;
//               acc_finalizations is append-only, migration 480).
//   5. COMPLETE 'finalizing' -> 'decided' with decided_at + finalization_id. From
//               then on the database refuses any change to the case (migration
//               480 guard trigger); a correction is a new acc_finalizations
//               version that references the original.
//
// Before migration 480 ('finalizing' not allowed) the claim goes straight to
// 'decided' and is reverted on failure (the pre-480 behavior), and no
// finalization record is written.
//
// request_more_info is not final: the case stays open, nothing is claimed.
// ============================================================================

const OPEN_STATUSES = ['pending_review', 'awaiting_info'];
const PLACEHOLDER_RE = /\[\s*STAFF\s*:/i;
const isMigration480Missing = (err) => !!err && /finalizing|status_check|finalizing_started_at|finalization_id|acc_finalizations|does not exist|schema cache/i.test(err.message || '');

async function finalizeAccDecision(supabase, args) {
  const { dec, decisionType, bodyText, toEmail, send, actorId, letterStoragePath, now = () => new Date().toISOString() } = args;
  const { sealRecord, composeEmail, sendEmail, recordFinalization } = args;
  const isFinal = decisionType !== 'request_more_info';
  if (PLACEHOLDER_RE.test(String(bodyText || ''))) {
    return { ok: false, httpStatus: 400, error: 'The letter still has a [STAFF: ...] placeholder where a fact is missing. Fill it in (or remove it) before sending.' };
  }
  if (send && !String(toEmail || '').trim()) {
    return { ok: false, httpStatus: 400, error: 'Enter the homeowner\'s email, or use "Mark done without emailing".' };
  }
  if (!OPEN_STATUSES.includes(dec.status)) {
    return { ok: false, httpStatus: 409, already_decided: true, error: `This application is no longer open (${dec.status}). Nothing was sent.` };
  }

  // ---------------------------------------------------------------- request for more information (not final)
  if (!isFinal) {
    const email = { attempted: false, sent: false };
    let composed = null;
    if (send) {
      email.attempted = true;
      try { composed = await composeEmail(); await sendEmail(composed); email.sent = true; }
      catch (e) { email.error = e.message; return { ok: false, httpStatus: 502, email, error: `The request could not be emailed to the homeowner: ${e.message}. Nothing was recorded; you can retry.` }; }
    }
    const up = await supabase.from('acc_decisions').update({
      decision_type: decisionType, letter_body: bodyText, letter_pdf_storage_path: letterStoragePath,
      decided_by_user_id: actorId || null, updated_at: now(),
    }).eq('id', dec.id).in('status', OPEN_STATUSES);
    if (up.error) return { ok: false, httpStatus: 500, email, error: `could not record the request: ${up.error.message}` };
    return { ok: true, final: false, email, composed, new_status: dec.status };
  }

  // ---------------------------------------------------------------- 1) CLAIM
  const claimFields = { decision_type: decisionType, letter_body: bodyText, letter_pdf_storage_path: letterStoragePath, decided_by_user_id: actorId || null, updated_at: now() };
  let mode = 'two_phase';
  let claim = await supabase.from('acc_decisions').update({ ...claimFields, status: 'finalizing', finalizing_started_at: now() })
    .eq('id', dec.id).in('status', OPEN_STATUSES).select('id');
  if (claim.error && isMigration480Missing(claim.error)) {
    mode = 'legacy';
    claim = await supabase.from('acc_decisions').update({ ...claimFields, status: 'decided', decided_at: now() })
      .eq('id', dec.id).in('status', OPEN_STATUSES).select('id');
  }
  if (claim.error) return { ok: false, httpStatus: 500, error: `could not record the decision: ${claim.error.message}` };
  if (!claim.data || !claim.data.length) {
    const { data: cur } = await supabase.from('acc_decisions').select('status, decision_type, decided_at').eq('id', dec.id).maybeSingle();
    return { ok: false, httpStatus: 409, already_decided: true, current: cur || null,
      error: `This application is no longer open (${(cur && cur.status) || 'unknown'}${cur && cur.decided_at ? ', decided ' + String(cur.decided_at).slice(0, 10) : ''}). Nothing was sent again.` };
  }
  const claimedStatus = mode === 'legacy' ? 'decided' : 'finalizing';
  const revert = async () => {
    const r = await supabase.from('acc_decisions').update({
      status: dec.status, decision_type: dec.decision_type ?? null, letter_body: dec.letter_body ?? null,
      letter_pdf_storage_path: dec.letter_pdf_storage_path ?? null, decided_by_user_id: dec.decided_by_user_id ?? null,
      ...(mode === 'legacy' ? { decided_at: dec.decided_at ?? null } : { finalizing_started_at: null }),
      updated_at: now(),
    }).eq('id', dec.id).eq('status', claimedStatus);
    return !r.error;
  };

  // ---------------------------------------------------------------- 2) FILE (before anything goes to the homeowner)
  let filing;
  try { filing = await sealRecord(); }
  catch (e) {
    const reverted = await revert();
    return { ok: false, httpStatus: 500, reverted,
      error: `The final record could not be filed (${e.message}). Nothing was sent${reverted ? ' and the case is back in the queue' : '; the case could NOT be put back automatically, so tell Ed'}.` };
  }

  // ---------------------------------------------------------------- 3) SEND
  const email = { attempted: false, sent: false };
  let composed = null;
  if (send) {
    email.attempted = true;
    try { composed = await composeEmail(); await sendEmail(composed); email.sent = true; email.sent_at = now(); }
    catch (e) {
      email.error = e.message;
      const reverted = await revert();
      return { ok: false, httpStatus: 502, email, reverted, filing,
        error: `The decision letter was filed but could not be emailed to the homeowner: ${e.message}. Nothing was marked done${reverted ? '; you can retry, or download the letter and send it manually' : ', but the case could NOT be put back automatically, so tell Ed'}.` };
    }
  }

  // ---------------------------------------------------------------- 4) RECORD (append-only)
  let finalizationId = null; let recordError = null;
  if (mode === 'two_phase' && recordFinalization) {
    try {
      const row = {
        acc_decision_id: dec.id, version: 1, community_id: dec.community_id || null, property_id: args.propertyId || null,
        reference_number: dec.reference_number || null, homeowner_name: dec.homeowner_name || null, homeowner_address: dec.homeowner_address || null,
        decision_type: decisionType, letter_text: bodyText,
        letter_sha256: filing.letter.sha256, letter_archive_path: filing.letter.archive_path,
        packet_sha256: filing.packet ? filing.packet.sha256 : null, packet_archive_path: filing.packet ? filing.packet.archive_path : null,
        documents: filing.documents || [],
        delivery: email.sent ? 'email' : 'none',
        email: email.sent ? { from: composed.from, to: composed.to, subject: composed.subject, text: composed.text, html: composed.html, attachments: composed.archive_attachments || [], sent_at: email.sent_at } : null,
        decided_by_user_id: actorId || null,
      };
      const rec = await recordFinalization(row);
      finalizationId = rec && rec.id ? rec.id : null;
      if (!finalizationId) recordError = 'finalization record not returned';
    } catch (e) { recordError = e.message; }
  }

  // ---------------------------------------------------------------- 5) COMPLETE
  if (mode === 'two_phase') {
    const done = await supabase.from('acc_decisions').update({
      status: 'decided', decided_at: now(), updated_at: now(),
      packet_pdf_storage_path: filing.packet ? filing.packet.path : null,
      ...(finalizationId ? { finalization_id: finalizationId } : {}),
    }).eq('id', dec.id).eq('status', 'finalizing');
    if (done.error) {
      return { ok: false, httpStatus: 500, email, filing, finalization_id: finalizationId,
        error: `${email.sent ? 'The homeowner WAS emailed and the record was filed' : 'The record was filed'}, but the case could not be marked decided (${done.error.message}). It shows as "finalizing"; do not resend. Tell Ed.` };
    }
  } else if (filing.packet && filing.packet.path) {
    await supabase.from('acc_decisions').update({ packet_pdf_storage_path: filing.packet.path }).eq('id', dec.id);
  }

  return { ok: true, final: true, email, composed, filing, finalization_id: finalizationId, record_error: recordError, mode, new_status: 'decided' };
}

module.exports = { finalizeAccDecision, OPEN_STATUSES, PLACEHOLDER_RE };
