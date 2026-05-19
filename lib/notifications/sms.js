// ============================================================================
// notifications/sms.js — Twilio integration
// ----------------------------------------------------------------------------
// Sends transactional SMS (violation notice nudges, fine confirmations) via
// Twilio. Safe-fallback when Twilio credentials aren't configured: returns
// { ok:false, skipped:true } and logs — does NOT throw. Once Ed provisions
// a Twilio number + sets env vars in Render, SMS starts firing automatically.
//
// TCPA discipline:
//   - SMS only goes to contacts where contacts.sms_opt_in = TRUE (callers
//     must check this before invoking — this module trusts the caller).
//   - Each message ends with "Reply STOP to unsubscribe" per FCC rules.
//   - Inbound STOP/HELP handling lives in a future webhook endpoint
//     (status webhook handler).
//
// Why Twilio over alternatives:
//   - Industry standard, predictable deliverability, mature webhook flow
//   - ~$0.0075/SMS, trivial at Bedrock's scale
//   - We can add MMS later for richer notices if needed
//
// Env vars expected:
//   TWILIO_ACCOUNT_SID    — starts with AC...
//   TWILIO_AUTH_TOKEN     — bearer-style secret
//   TWILIO_FROM_NUMBER    — verified send-from, e.g. "+15551234567"
//   TWILIO_STATUS_CALLBACK_URL — optional, hooks for delivery receipts
// ============================================================================

function isConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID
         && process.env.TWILIO_AUTH_TOKEN
         && process.env.TWILIO_FROM_NUMBER);
}

// Normalize a phone number to E.164 (Twilio requires +1XXXYYYZZZZ).
// Accepts: "+1 (832) 588-2485", "832-588-2485", "8325882485" → "+18325882485"
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return '+1' + digits;          // US default
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

function ensureStopFooter(body) {
  if (!body) return 'Reply STOP to unsubscribe.';
  if (/STOP/i.test(body)) return body;
  return body.trimEnd() + '\n\nReply STOP to unsubscribe.';
}

/**
 * Send an SMS.
 *
 * @param {Object} opts
 * @param {string} opts.to          — recipient phone (any format; normalized to E.164)
 * @param {string} opts.body        — message body; STOP footer appended automatically
 * @param {string} [opts.from]      — override the global FROM number
 * @returns {Promise<{ok, vendor, vendor_message_id?, skipped?, error?, raw?, to?}>}
 */
async function sendSms(opts) {
  if (!isConfigured()) {
    console.warn('[sms] Twilio not configured — SMS skipped (to: ' + (opts && opts.to) + ')');
    return { ok: false, vendor: 'twilio', skipped: true, error: 'not_configured' };
  }
  if (!opts || !opts.to || !opts.body) {
    return { ok: false, vendor: 'twilio', error: 'missing_required_fields' };
  }
  const to = normalizePhone(opts.to);
  if (!to) {
    return { ok: false, vendor: 'twilio', error: 'invalid_phone:' + opts.to };
  }
  const from = opts.from || process.env.TWILIO_FROM_NUMBER;
  const body = ensureStopFooter(opts.body);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  if (process.env.TWILIO_STATUS_CALLBACK_URL) {
    params.set('StatusCallback', process.env.TWILIO_STATUS_CALLBACK_URL);
  }

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, vendor: 'twilio', error: data.message || `HTTP ${r.status}`, raw: data, to };
    }
    return { ok: true, vendor: 'twilio', vendor_message_id: data.sid, raw: data, to };
  } catch (e) {
    return { ok: false, vendor: 'twilio', error: e.message };
  }
}

module.exports = { sendSms, isConfigured, normalizePhone };
