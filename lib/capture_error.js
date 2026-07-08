// ============================================================================
// lib/capture_error.js  (Ed 2026-07-08)
// ----------------------------------------------------------------------------
// Log a server error (5xx) so broken features surface to Ed on an admin screen
// instead of vanishing into a cryptic client message. Fire-and-forget and
// fully swallowed — error logging must NEVER break the request it's logging.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function captureServerError({ method, path, statusCode, message, userAgent }) {
  try {
    await supabase.from('system_errors').insert({
      method: method || null,
      path: path || null,
      status_code: statusCode || null,
      error_message: String(message == null ? '' : message).slice(0, 2000),
      user_agent: (userAgent || '').slice(0, 300),
    });
  } catch (_) { /* table may not exist yet, or DB blip — never propagate */ }
}

module.exports = { captureServerError };
