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
// allowed for mailbox ..."). Read at the time as a mailbox migration. Correction
// (Issue #29, 2026-10-04): WITH "Cross Server access is not allowed" it is Exchange
// refusing a message id from ANOTHER mailbox (TrustEd replied from the persona
// mailbox to a message stored in info@ etc.), reproduced on demand. That variant is
// deterministic and non-retryable. A genuine move (without that phrase) stays
// temporary. We do NOT retry automatically either way (a retry could double-send).
// ============================================================================

const KNOWN = {
  ErrorMailboxMoveInProgress: {
    code: 'mailbox_move_in_progress',
    temporary: true,
    userMessage: 'Microsoft is temporarily moving this mailbox. Your message was not sent. Please try again later.',
  },
};

const CROSS_MAILBOX = {
  code: 'cross_mailbox_access',
  temporary: false,
  userMessage: 'This email is stored in a different mailbox than the one replying, so Microsoft refused the reply. Nothing was sent. Retrying will not help; this needs a fix in TrustEd, not a wait.',
};

// step: 'sendMail' | 'createReply' | 'patch reply' | 'send reply'
function graphSendError(step, status, bodyText) {
  const raw = String(bodyText || '');
  let graphCode = null; let graphMsg = raw;
  try {
    const j = JSON.parse(raw);
    if (j && j.error) { graphCode = j.error.code || null; graphMsg = j.error.message || raw; }
  } catch (_) { /* not JSON: keep the text */ }
  // The same Exchange code also covers a CROSS-MAILBOX request (a message id from one
  // mailbox used under another). That is a deterministic routing error, not a move:
  // retrying later never helps. (Issue #29, 2026-10-04.)
  const crossMailbox = graphCode === 'ErrorMailboxMoveInProgress' && /Cross Server access is not allowed/i.test(String(graphMsg));
  const known = crossMailbox ? CROSS_MAILBOX : (graphCode ? KNOWN[graphCode] : null);
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
