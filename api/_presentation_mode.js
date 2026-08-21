// ============================================================================
// api/_presentation_mode.js — show a REAL community without showing real people.
// ----------------------------------------------------------------------------
// Ed 2026-08-21: "i need to be able to maintain privacy for the homeowners if
// we go that route."
//
// The route being: demo the banker on Waterview, not on the fictional community.
// Drama Creek cannot produce a convincing map (its coordinates point at real
// houses near Austin belonging to strangers), and its clubhouse, amenities and
// documents are all invented. Waterview is genuinely impressive and most of what
// makes it impressive is public information anyway: streets, the clubhouse, the
// pool. Anyone can pull that up on a map.
//
// What is NOT public is a named person and their money. So the risk was never
// "real community" — it is identifiable private data, and that is what this
// masks.
//
// FOUR DESIGN RULES, all of them chosen because Ed said "let's be careful not to
// break anything":
//
//  1. OFF UNLESS ASKED. No flag, no work — the middleware returns at the first
//     line and the request is byte-for-byte what it is today. Nothing about
//     normal traffic changes.
//
//  2. SERVER SIDE. Hiding fields in the browser still ships the real values
//     down the wire, where a devtools panel on a shared screen exposes them.
//     The values never leave the server.
//
//  3. FAIL CLOSED. Presentation mode is staff-only, and a non-staff caller who
//     passes the flag is REFUSED rather than quietly served real data. Silently
//     ignoring the flag is the dangerous direction: the operator believes the
//     screen is masked and it is not.
//
//  4. SUPPRESS, NEVER FABRICATE. A masked balance reads "—", not a realistic
//     invented number. Ed could quote a fabricated figure to a banker in good
//     faith, and a plausible fake is worse than a visible blank. Same reason the
//     platform refuses to invent an email address.
// ============================================================================

// Identity fields. Explicit list, not a guess at anything called "name" —
// communities, vendors, amenities and documents all have names that MUST stay
// readable or the demo shows nothing at all.
const IDENTITY_KEYS = new Set([
  'full_name', 'owner_name', 'homeowner_name', 'resident_name',
  'first_name', 'last_name', 'contact_name', 'submitted_by', 'reported_by',
  'primary_email', 'primary_phone', 'mailing_address', 'sender_name',
]);

// Per-homeowner money. Every one of these is an individual's account in the
// homeowner portal — association-level financials live in the admin and board
// surfaces, not behind this router.
const MONEY_KEYS = new Set([
  'balance', 'balance_cents', 'balance_total', 'open_balance',
  'running_balance_cents', 'amount_cents', 'past_due', 'amount_due',
]);

// Never touch these, whatever they contain. Masking an id or a slug breaks
// navigation, and a broken demo is the thing we are trying to avoid.
const NEVER_TOUCH = new Set([
  'id', 'slug', 'url', 'href', 'community_id', 'property_id', 'contact_id',
  'vantaca_account_id', 'conversation_id', 'thread_id', 'token',
]);

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\+?[\d][\d\s().-]{8,}$/;

const HIDDEN = '—';
const HIDDEN_NAME = 'Name hidden';
// The homeowner's own name reads better as their role than as a blank, and this
// is the one place we know whose name it is. A vendor's rep is NOT a homeowner,
// so only these keys get the friendlier label.
const OWNER_KEYS = new Set(['full_name', 'owner_name', 'homeowner_name', 'resident_name']);

function maskValue(key, value) {
  if (MONEY_KEYS.has(key)) return null;
  if (typeof value !== 'string') return HIDDEN;
  if (EMAIL_RE.test(value)) return 'hidden@privacy';
  if (OWNER_KEYS.has(key)) return 'Homeowner';
  if (/name/.test(key)) return HIDDEN_NAME;
  return HIDDEN;
}

// Walk the response and mask in place on a copy.
//
// Depth-capped and cycle-guarded: this runs on every response while the mode is
// on, and an unbounded walk over an unexpected shape is how a "safe" helper
// takes the page down.
function redact(node, depth = 0, seen = new WeakSet()) {
  if (depth > 12 || node === null || node === undefined) return node;

  if (Array.isArray(node)) {
    return node.map((x) => redact(x, depth + 1, seen));
  }

  if (typeof node === 'object') {
    if (seen.has(node)) return node;
    seen.add(node);
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (NEVER_TOUCH.has(k)) { out[k] = v; continue; }
      if (IDENTITY_KEYS.has(k) || MONEY_KEYS.has(k)) { out[k] = maskValue(k, v); continue; }
      if (typeof v === 'string') {
        // An address stored under a generic key still identifies nobody by
        // itself, but an EMAIL always identifies someone. Catch it wherever it
        // is nested, including the places that emit `name: user.email`.
        if (EMAIL_RE.test(v)) { out[k] = 'hidden@privacy'; continue; }
        if (PHONE_RE.test(v) && /phone|mobile|tel/.test(k)) { out[k] = HIDDEN; continue; }
        out[k] = v;
        continue;
      }
      out[k] = redact(v, depth + 1, seen);
    }
    return out;
  }

  return node;
}

const COOKIE_NAME = 'bedrock_presentation';

function cookieValue(req, name) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// Two ways in, and they are NOT treated the same.
//
//   explicit — ?present=1 or the header. Somebody asked for this request, right
//              now. If they turn out not to be staff, refuse: serving real data
//              to an operator who believes the screen is masked is the one
//              outcome worth breaking the request over.
//
//   cookie   — set once so every page and every fetch carries it without any
//              client changes across 29 portal pages. But a cookie OUTLIVES the
//              intent. Ed hands the laptop back, or a homeowner signs in on the
//              same browser. Refusing them because of a leftover cookie would
//              lock a real owner out of their own portal, so a cookie held by a
//              non-staff user is ignored rather than enforced.
//
// Ignoring it is safe: a homeowner only ever sees their own data, so there is no
// cross-homeowner exposure to protect against. The refusal exists to protect the
// OPERATOR from a false sense of masking, and an operator is staff by definition.
function requestedMode(req) {
  if (req.query.present === '1' || req.get('X-Bedrock-Presentation') === '1') return 'explicit';
  if (cookieValue(req, COOKIE_NAME) === '1') return 'cookie';
  return null;
}

function isOn(req) {
  return requestedMode(req) !== null;
}

// Factory. Takes the router's own user resolver so this file has no opinion
// about how the portal authenticates.
//
// resolveUserWithRole(req, null) deliberately gets a null `res`: it then returns
// null instead of writing a 401, which matters because this middleware sits in
// front of the pre-auth endpoints (sign-in, magic-link consume) too.
function presentationMode(resolveUserWithRole, { allowRoles = ['manager'] } = {}) {
  const allowed = new Set(allowRoles);
  return async function presentationModeMiddleware(req, res, next) {
    const mode = requestedMode(req);
    if (!mode) return next();               // the common path: nothing happens

    let role = null;
    try {
      const resolved = await resolveUserWithRole(req, null);
      role = resolved && resolved.user ? resolved.user.role : null;
    } catch (e) {
      console.warn('[presentation] role lookup failed:', e.message);
      role = null;
    }

    if (!allowed.has(role)) {
      // A stale cookie held by a homeowner is ignored so they keep their own
      // portal. An EXPLICIT ask is refused. See requestedMode above.
      if (mode === 'cookie') return next();
      return res.status(403).json({
        error: 'presentation_mode_staff_only',
        message: 'Presentation mode is for Bedrock staff. Sign in with your Bedrock account first.',
      });
    }

    const orig = res.json.bind(res);
    res.json = function (body) {
      let masked;
      try {
        masked = redact(body);
      } catch (e) {
        // If masking itself fails, send nothing rather than the real thing.
        console.error('[presentation] redaction failed, refusing to send:', e.message);
        return orig({ error: 'presentation_redaction_failed' });
      }
      if (masked && typeof masked === 'object' && !Array.isArray(masked)) {
        masked._presentation = true;   // the page shows its banner off this
      }
      return orig(masked);
    };
    res.set('X-Bedrock-Presentation', 'on');
    return next();
  };
}

module.exports = { presentationMode, redact, isOn, requestedMode, COOKIE_NAME, IDENTITY_KEYS, MONEY_KEYS, NEVER_TOUCH };
