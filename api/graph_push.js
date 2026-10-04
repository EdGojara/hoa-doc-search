// api/graph_push.js  (Issue #29, TrustEd Push Email)
// Public Microsoft Graph callbacks. No staff session: Graph never carries one.
// Security is the per-mailbox clientState (HMAC of GRAPH_NOTIFY_CLIENT_STATE),
// checked in lib/email/graph_push before any work; the path key only selects the
// mailbox. Every response is fast: the validation handshake echoes the token, and
// notifications are acknowledged 202 BEFORE any ingest runs (Graph retries and
// eventually drops slow endpoints). Invalid or unknown input gets the same 202 and
// does nothing, so the endpoint is not an oracle and costs nothing to probe.
const express = require('express');
const router = express.Router();

// Graph's handshake: POST ...?validationToken=<token>; answer 200 text/plain with the
// token, decoded, within 10 seconds. Only on our two route shapes.
function validation(req, res) {
  const token = req.query && req.query.validationToken;
  if (token === undefined) return false;
  res.status(200).type('text/plain').send(String(token));
  return true;
}

function handle(kind) {
  return (req, res) => {
    if (validation(req, res)) return;
    res.status(202).end();
    const push = require('../lib/email/graph_push').getGraphPush();
    if (!push) return;                                  // push off: a no-op
    const body = req.body; const key = req.params.key;
    setImmediate(() => {
      try { if (kind === 'lifecycle') push.handleLifecycle(key, body); else push.handleNotifications(key, body); }
      catch (e) { console.error(`[graph_push] ${kind} handler threw:`, e.message); }
    });
  };
}

router.post('/mail/notify/:key', handle('notify'));
router.post('/mail/lifecycle/:key', handle('lifecycle'));

module.exports = router;
module.exports.makeHandler = handle;   // NOT .handle: that is the Router's own dispatch method
