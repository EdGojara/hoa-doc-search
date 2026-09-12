// ============================================================================
// lib/notifications/notify_owner.js  (Ed 2026-09-12)
// ----------------------------------------------------------------------------
// Tessa (and the platform) texting ED when something needs him. This is an
// OWNER alert, not customer messaging: it goes to Ed's own mobile, skips the
// "Reply STOP" footer, and is a plain heads-up.
//
// Reuses lib/notifications/sms.js (Twilio). Safe by design: a no-op unless BOTH
//   OWNER_MOBILE          — Ed's mobile in any format
//   TESSA_SMS_ALERTS=true — the on switch
// are set, and Twilio itself is configured. So it never fires until Ed turns it
// on, and never throws. Keep messages short and rare — a text that comes too
// often gets ignored, which defeats the point.
// ============================================================================
const { sendSms } = require('./sms');

function ownerPhone() { return process.env.OWNER_MOBILE || process.env.ED_MOBILE || null; }
function alertsEnabled() { return String(process.env.TESSA_SMS_ALERTS || '').toLowerCase() === 'true'; }

/**
 * Text Ed. Returns the sendSms result (or a skipped result) — never throws.
 * @param {string} body
 * @param {object} [opts] { force } — force bypasses the TESSA_SMS_ALERTS switch
 *   (for an explicit "text me this" action), still requires OWNER_MOBILE + Twilio.
 */
async function textOwner(body, opts = {}) {
  if (!opts.force && !alertsEnabled()) return { ok: false, skipped: true, error: 'alerts_off' };
  const to = ownerPhone();
  if (!to) { console.warn('[notify-owner] OWNER_MOBILE not set — owner SMS skipped'); return { ok: false, skipped: true, error: 'no_owner_number' }; }
  if (!body || !String(body).trim()) return { ok: false, error: 'empty_body' };
  const res = await sendSms({ to, body: String(body).trim().slice(0, 600), noFooter: true });
  if (!res.ok && !res.skipped) console.warn('[notify-owner] send failed:', res.error);
  return res;
}

module.exports = { textOwner, ownerPhone, alertsEnabled };
