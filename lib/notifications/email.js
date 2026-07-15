// ============================================================================
// notifications/email.js — Resend integration
// ----------------------------------------------------------------------------
// Sends transactional email (violation notices, fine notices, board comms)
// via Resend. Safe-fallback: if RESEND_API_KEY isn't configured, returns
// { ok:false, skipped:true } and logs a warning — does NOT throw. This lets
// the system ship before Ed signs up for Resend; once the env var is set
// in Render, emails start firing automatically.
//
// Why Resend over alternatives:
//   - One env var (API key); no SES IAM dance, no SendGrid domain auth maze
//   - Strong deliverability + transparent per-event tracking
//   - $0.0008/email (effectively free at Bedrock's scale)
//
// Env vars expected:
//   RESEND_API_KEY        — bearer token from resend.com dashboard
//   RESEND_FROM_EMAIL     — verified sender, e.g. "Bedrock Notices <notices@bedrocktx.com>"
//   RESEND_REPLY_TO       — optional reply-to (defaults to FROM)
// ============================================================================

const RESEND_API = 'https://api.resend.com/emails';

function isConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
}

// ---------------------------------------------------------------------------
// A failed send must never be quiet.  (Ed 2026-07-15)
//
// Karla Rutan (DRB) could not get into the builder portal: "I requested a link
// to be sent to me but it has not shown up in my email." Ten of her twelve
// magic links were never used, and on 6/12 she requested SEVEN in fifty minutes
// — someone hammering a button because nothing arrives.
//
// The token was never the problem. sendEmail RETURNS {ok:false} instead of
// throwing, so:
//   * callers that fire-and-forget (`await sendEmail(...)`) lose the failure
//     entirely — portal.js then logged 'magic_link_sent' and told her to check
//     her email;
//   * callers that wrap it in try/catch are DEAD CODE — the catch can never
//     fire, so portal_admin reported email_sent:true unconditionally.
// Both shapes report success on a send that never happened. And because the
// vendor_message_id was discarded, there was no record to check afterward —
// nobody could even tell whether the mail left the building.
//
// So the helper itself now refuses to be silent: every failure is a console.error
// carrying the recipient, the module and the vendor's own reason. Fixing the
// call sites matters (and is done), but a helper that can't fail quietly is the
// control — the next call site someone writes gets it for free.
// ---------------------------------------------------------------------------
function tagOf(opts, name) {
  const t = (opts && Array.isArray(opts.tags) ? opts.tags : []).find((x) => x && x.name === name);
  return (t && t.value) || 'unknown';
}
// Log enough to trace a specific person's missing mail, without pasting whole
// address books into the logs.
function redact(to) {
  const list = Array.isArray(to) ? to : [to];
  return list.map((a) => String(a || '')).join(',');
}
function fail(opts, error, raw) {
  console.error(`[email] SEND FAILED to=${redact(opts && opts.to)} module=${tagOf(opts, 'module')} event=${tagOf(opts, 'event')} subject="${String((opts && opts.subject) || '').slice(0, 70)}" reason=${error}`);
  return { ok: false, vendor: 'resend', error, raw };
}

/**
 * Send an email.
 *
 * @param {Object}   opts
 * @param {string}   opts.to            — recipient address
 * @param {string}   opts.subject
 * @param {string}   opts.html
 * @param {string}   [opts.text]        — plain-text fallback (recommended)
 * @param {Array}    [opts.attachments] — [{ filename, content (base64 string) }]
 * @param {string}   [opts.from]        — override the global FROM
 * @param {string}   [opts.replyTo]     — override the global REPLY-TO
 * @param {Array}    [opts.tags]        — Resend tags for filtering
 * @returns {Promise<{ok, vendor, vendor_message_id?, skipped?, error?, raw?}>}
 */
async function sendEmail(opts) {
  if (!isConfigured()) {
    // Not a warning. If this fires in production every notice the platform
    // "sent" today went nowhere.
    return { ...fail(opts, 'not_configured — RESEND_API_KEY / RESEND_FROM_EMAIL is unset'), skipped: true };
  }
  if (!opts || !opts.to || !opts.subject || !opts.html) {
    return fail(opts, 'missing_required_fields');
  }

  const body = {
    from:     opts.from    || process.env.RESEND_FROM_EMAIL,
    to:       Array.isArray(opts.to) ? opts.to : [opts.to],
    bcc:      opts.bcc ? (Array.isArray(opts.bcc) ? opts.bcc : [opts.bcc]) : undefined,
    cc:       opts.cc  ? (Array.isArray(opts.cc)  ? opts.cc  : [opts.cc])  : undefined,
    subject:  opts.subject,
    html:     opts.html,
    text:     opts.text || undefined,
    reply_to: opts.replyTo || process.env.RESEND_REPLY_TO || undefined,
    tags:     opts.tags || undefined,
    attachments: opts.attachments || undefined,
  };

  try {
    const r = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return fail(opts, data.message || `HTTP ${r.status}`, data);
    }
    console.log(`[email] SENT to=${redact(opts.to)} subject="${String(opts.subject).slice(0, 70)}" id=${data.id} module=${tagOf(opts, 'module')}`);
    return { ok: true, vendor: 'resend', vendor_message_id: data.id, raw: data };
  } catch (e) {
    return fail(opts, e.message);
  }
}

module.exports = { sendEmail, isConfigured };
