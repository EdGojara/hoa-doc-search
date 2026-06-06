// ============================================================================
// lob_provider.js — Lob.com integration for certified mail
// ----------------------------------------------------------------------------
// Lob handles printing + envelope + certified mail label + return receipt +
// USPS hand-off + signature capture. Bedrock never touches the physical
// letter — we just hand Lob a PDF + recipient address via API.
//
// API docs: https://docs.lob.com/
// Auth: HTTP Basic with API key as username, empty password
//   - Test mode key (test_xxx) → free, no actual mail goes out, generates
//     fake tracking events
//   - Live mode key (live_xxx) → real mail, real cost (~$9-10/piece for
//     certified + electronic return receipt)
//
// Required env var: LOB_API_KEY
//
// Endpoints used:
//   POST /v1/letters             — create a letter (Lob prints + mails)
//   GET  /v1/letters/{id}        — get current status
//   POST /v1/webhooks            — register webhook (one-time setup)
// ============================================================================

const LOB_API_BASE = 'https://api.lob.com/v1';

function _getApiKey() {
  const key = process.env.LOB_API_KEY;
  if (!key) throw new Error('LOB_API_KEY env var not set');
  return key;
}

function _isTestMode(key) {
  return String(key || '').startsWith('test_');
}

function _authHeader(apiKey) {
  // Lob uses HTTP Basic: API key as username, empty password
  const encoded = Buffer.from(`${apiKey}:`).toString('base64');
  return `Basic ${encoded}`;
}

// ---------------------------------------------------------------------------
// createCertifiedLetter — submits one letter to Lob for printing + certified
// mailing. Returns the Lob letter object (includes id, tracking_number,
// expected delivery date, cost breakdown).
//
// Args:
//   pdfBuffer            — the rendered letter PDF
//   recipient            — { name, address_line1, address_line2?, city, state, zip }
//   sender               — { name, address_line1, address_line2?, city, state, zip }
//   options              — {
//     mail_type: 'usps_certified' | 'usps_first_class',
//     return_envelope?: boolean,
//     description?: string  — internal label visible in Lob dashboard
//   }
//
// Returns: { id, tracking_number, expected_delivery_date, price, raw }
// ---------------------------------------------------------------------------
async function createCertifiedLetter({ pdfBuffer, recipient, sender, options = {} }) {
  const apiKey = _getApiKey();
  const isTest = _isTestMode(apiKey);

  if (!pdfBuffer || pdfBuffer.length === 0) throw new Error('pdfBuffer required');
  if (!recipient || !recipient.address_line1) throw new Error('recipient required');

  // Lob's API uses multipart/form-data for file uploads
  const FormData = require('form-data');
  const form = new FormData();
  form.append('description', options.description || 'Bedrock violation letter');
  form.append('to[name]', recipient.name || '');
  form.append('to[address_line1]', recipient.address_line1);
  if (recipient.address_line2) form.append('to[address_line2]', recipient.address_line2);
  form.append('to[address_city]', recipient.city || '');
  form.append('to[address_state]', recipient.state || 'TX');
  form.append('to[address_zip]', recipient.zip || '');
  form.append('to[address_country]', 'US');

  if (sender) {
    form.append('from[name]', sender.name || '');
    form.append('from[address_line1]', sender.address_line1 || '');
    if (sender.address_line2) form.append('from[address_line2]', sender.address_line2);
    form.append('from[address_city]', sender.city || '');
    form.append('from[address_state]', sender.state || 'TX');
    form.append('from[address_zip]', sender.zip || '');
    form.append('from[address_country]', 'US');
  }

  // PDF file
  form.append('file', pdfBuffer, {
    filename: 'letter.pdf',
    contentType: 'application/pdf',
  });

  // Mail type — usps_certified gives the certified mail label + return receipt
  const mailType = options.mail_type || 'usps_certified';
  form.append('mail_type', mailType);
  // Color, double-sided — keep simple defaults
  form.append('color', 'true');
  form.append('double_sided', 'true');

  // Use built-in fetch (Node 18+) or fall back to node-fetch
  const fetchFn = typeof fetch === 'function' ? fetch : require('node-fetch');

  const headers = {
    Authorization: _authHeader(apiKey),
    ...form.getHeaders(),
  };

  const resp = await fetchFn(`${LOB_API_BASE}/letters`, {
    method: 'POST',
    headers,
    body: form,
  });

  const responseText = await resp.text();
  let parsed;
  try { parsed = JSON.parse(responseText); }
  catch (_) { parsed = { raw: responseText }; }

  if (!resp.ok) {
    const errMsg = (parsed.error && parsed.error.message) || parsed.message || `HTTP ${resp.status}`;
    const err = new Error(`Lob letter creation failed: ${errMsg}`);
    err.lob_response = parsed;
    err.lob_status_code = resp.status;
    throw err;
  }

  return {
    id: parsed.id,
    tracking_number: parsed.tracking_number || null,
    expected_delivery_date: parsed.expected_delivery_date || null,
    price_cents: parsed.price ? Math.round(parseFloat(parsed.price) * 100) : null,
    is_test_mode: isTest,
    raw: parsed,
  };
}

// ---------------------------------------------------------------------------
// getLetterStatus — pulls the current status of a previously-created letter
// from Lob. Used for backfill / status reconciliation when webhooks are
// missed.
// ---------------------------------------------------------------------------
async function getLetterStatus(letterId) {
  if (!letterId) throw new Error('letterId required');
  const apiKey = _getApiKey();
  const fetchFn = typeof fetch === 'function' ? fetch : require('node-fetch');

  const resp = await fetchFn(`${LOB_API_BASE}/letters/${letterId}`, {
    method: 'GET',
    headers: { Authorization: _authHeader(apiKey) },
  });
  const text = await resp.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text }; }
  if (!resp.ok) {
    throw new Error(`Lob letter status fetch failed: ${(parsed.error && parsed.error.message) || resp.status}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Map Lob's webhook event type → our internal status enum.
// Lob fires events at every USPS scan; we collapse them into our 9-status
// state machine.
// ---------------------------------------------------------------------------
function mapLobEventToStatus(eventType) {
  switch (String(eventType || '').toLowerCase()) {
    case 'letter.created':
      return 'submitted';
    case 'letter.rendered_pdf':
    case 'letter.rendered_thumbnails':
      return 'submitted';
    case 'letter.mailed':
    case 'letter.usps.in_transit':
      return 'in_transit';
    case 'letter.usps.in_local_area':
    case 'letter.usps.processed_for_delivery':
      return 'out_for_delivery';
    case 'letter.usps.processed':
    case 'letter.usps.re-routed':
      return 'in_transit';
    case 'letter.delivered':
    case 'letter.usps.delivered':
      return 'delivered';
    case 'letter.returned_to_sender':
    case 'letter.usps.returned_to_sender':
      return 'returned_to_sender';
    case 'letter.failed_to_print':
    case 'letter.failed':
      return 'failed_to_send';
    default:
      return null;  // unknown event type — log but don't change status
  }
}

// ---------------------------------------------------------------------------
// verifyWebhookSignature — Lob signs webhooks with an HMAC-SHA256 in the
// 'lob-signature' header using a webhook secret. This protects against
// spoofed events.
//
// LOB_WEBHOOK_SECRET env var must be set to the secret shown in Lob
// dashboard when you register the webhook URL.
// ---------------------------------------------------------------------------
function verifyWebhookSignature(rawBody, signatureHeader, timestampHeader) {
  const secret = process.env.LOB_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[lob_provider] LOB_WEBHOOK_SECRET not set — accepting webhook without verification');
    return true;  // skip verification when no secret configured (dev mode)
  }
  if (!signatureHeader || !timestampHeader) {
    console.warn('[lob_provider] webhook missing signature or timestamp headers');
    return false;
  }
  // Lob's signing pattern: HMAC-SHA256 over `${timestamp}.${rawBody}`
  const crypto = require('crypto');
  const payload = `${timestampHeader}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  // Timing-safe comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signatureHeader, 'hex')
    );
  } catch (_) {
    return false;
  }
}

module.exports = {
  createCertifiedLetter,
  getLetterStatus,
  mapLobEventToStatus,
  verifyWebhookSignature,
  _LOB_API_BASE: LOB_API_BASE,  // exposed for testing
};
