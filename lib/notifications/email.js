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
    console.warn('[email] RESEND_API_KEY / RESEND_FROM_EMAIL not set — email skipped (to: ' + (opts && opts.to) + ')');
    return { ok: false, vendor: 'resend', skipped: true, error: 'not_configured' };
  }
  if (!opts || !opts.to || !opts.subject || !opts.html) {
    return { ok: false, vendor: 'resend', error: 'missing_required_fields' };
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
      return { ok: false, vendor: 'resend', error: data.message || `HTTP ${r.status}`, raw: data };
    }
    return { ok: true, vendor: 'resend', vendor_message_id: data.id, raw: data };
  } catch (e) {
    return { ok: false, vendor: 'resend', error: e.message };
  }
}

module.exports = { sendEmail, isConfigured };
