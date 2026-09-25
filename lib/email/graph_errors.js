// ============================================================================
// lib/email/graph_errors.js — normalize Microsoft Graph MAIL send/reply failures.
// ----------------------------------------------------------------------------
// Graph returns {"error":{"code":"...","message":"..."}}. The raw blob belongs
// in the server log, never in front of staff. Known codes that describe a
// temporary MAILBOX STATE (not a bug, not a permission problem) carry a plain
// userMessage, which safeErrorMessage() returns as-is.
//
// First known code (2026-09-24, miranda@bedrocktx.com): ErrorMailboxMoveInProgress
// ("Mailbox move in progress. Try again later. Cross Server access is not
// allowed for mailbox ..."). Microsoft is migrating the mailbox between servers;
// nothing was sent, and the right action is to try again later. We do NOT retry
// automatically (a retry could double-send once the move finishes).
// ============================================================================

const KNOWN = {
  ErrorMailboxMoveInProgress: {
    code: 'mailbox_move_in_progress',
    temporary: true,
    userMessage: 'Microsoft is temporarily moving this mailbox. Your message was not sent. Please try again later.',
  },
};

// step: 'sendMail' | 'createReply' | 'patch reply' | 'send reply'
function graphSendError(step, status, bodyText) {
  const raw = String(bodyText || '');
  let graphCode = null; let graphMsg = raw;
  try {
    const j = JSON.parse(raw);
    if (j && j.error) { graphCode = j.error.code || null; graphMsg = j.error.message || raw; }
  } catch (_) { /* not JSON: keep the text */ }
  const known = graphCode ? KNOWN[graphCode] : null;
  const err = new Error(`Graph ${step} failed (${status})${graphCode ? ' ' + graphCode : ''}: ${String(graphMsg).slice(0, 200)}`);
  err.status = status;
  err.step = step;
  err.graphCode = graphCode;
  err.code = known ? known.code : 'graph_send_failed';
  err.temporary = !!(known && known.temporary);
  err.userMessage = known ? known.userMessage : null;
  return err;
}

module.exports = { graphSendError, KNOWN_GRAPH_MAIL_ERRORS: KNOWN };
