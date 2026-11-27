// ============================================================================
// lib/verification/index.js  (Ed 2026-11-27, telephone decision 2)
// ----------------------------------------------------------------------------
// THE ONE identity verification service, for AI teammates AND human staff:
// a one-time code sent by Twilio Verify to a phone number ALREADY ON FILE for
// the record being opened, read back by the person. Nothing the caller says
// chooses where the code goes: the number always comes from the record.
//
//   subject                       numbers on file come from
//   property_owner {property_id}  the CURRENT owner-class residents of that lot
//                                 (property_residencies, end_date null) -> contacts
//   owner                         the owner's contact record (contacts.primary_email
//                                 = OWNER_EMAIL) and OWNER_MOBILE
//   staff {email}                 an active trustEd user (user_profiles) -> their
//                                 contact record by email
//
// Where the code goes when there are several numbers on file: the number the
// person is calling from, if it is one of them (a spoofed caller ID then only
// sends the code to the real owner's phone); otherwise the first number on file.
// The number is never spoken or shown to an unverified person.
//
// Twilio Verify holds the code (we never store or see it). Approved check ->
// the caller (lib/phone, a staff screen) mints the verification object with
// lib/voice/private_gate (createPhoneVerification / createIdentityVerification).
// This module only answers "approved or not" for one attempt.
//
// Limits: 3 codes per attempt holder (call / staff screen session), 5 checks per
// code (Twilio also limits), attempts expire after 10 minutes.
// ============================================================================
const crypto = require('crypto');

const VERIFY_API = 'https://verify.twilio.com/v2';
const FRIENDLY_NAME = 'Bedrock';
const OWNER_RESIDENCY = ['owner_occupied', 'owner_non_occupant', 'owner', 'landlord'];
const STAFF_ROLES = ['admin', 'owner', 'manager', 'staff', 'accountant', 'assistant', 'community_manager'];
const MAX_SENDS = 3;
const MAX_CHECKS = 5;
const ATTEMPT_TTL_MS = 10 * 60 * 1000;

function configured() { return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN); }

/** PURE: any stored phone format -> E.164 (US default), or null. */
function e164(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}
const PHONE_FIELDS = ['primary_phone', 'notification_phone', 'secondary_phone'];
/** PURE: unique E.164 numbers from contact rows, in field priority order. */
function numbersFromContacts(contacts) {
  const out = [];
  for (const c of contacts || []) for (const f of PHONE_FIELDS) { const n = e164(c && c[f]); if (n && !out.includes(n)) out.push(n); }
  return out;
}
/** PURE: where the code goes. The caller's own number only if it is on file. */
function chooseNumber(numbers, callerPhone) {
  const c = e164(callerPhone);
  if (c && numbers.includes(c)) return { to: c, matched_caller: true };
  return numbers.length ? { to: numbers[0], matched_caller: false } : null;
}

// ---- numbers on file per subject -------------------------------------------------
async function onFile(supabase, subject) {
  const kind = subject && subject.kind;
  if (kind === 'property_owner') {
    if (!subject.property_id) return { ok: false, error: 'property_required' };
    const { data: res, error } = await supabase.from('property_residencies').select('contact_id, residency_type, properties:property_id(id, community_id, street_address)').eq('property_id', subject.property_id).is('end_date', null).limit(20);
    if (error) return { ok: false, error: `residency lookup failed: ${error.message}` };
    const owners = (res || []).filter((r) => r.contact_id && OWNER_RESIDENCY.includes(String(r.residency_type || '').toLowerCase()));
    if (subject.community_id && owners.some((r) => r.properties && r.properties.community_id !== subject.community_id)) return { ok: false, error: 'property_outside_community' };
    if (!owners.length) return { ok: true, numbers: [], record: { property_id: subject.property_id } };
    const { data: contacts, error: cErr } = await supabase.from('contacts').select('id, full_name, preferred_name, primary_phone, secondary_phone, notification_phone').in('id', owners.map((r) => r.contact_id));
    if (cErr) return { ok: false, error: `contact lookup failed: ${cErr.message}` };
    const first = (contacts || [])[0] || null;
    return { ok: true, numbers: numbersFromContacts(contacts), record: { property_id: subject.property_id, community_id: owners[0].properties && owners[0].properties.community_id, contact_ids: (contacts || []).map((c) => c.id), name: first ? (first.preferred_name || first.full_name || null) : null } };
  }
  if (kind === 'owner') {
    const email = String(require('../auth/owner_email').OWNER_EMAIL || '').trim().toLowerCase();
    if (!email) return { ok: false, error: 'owner_not_configured' };
    const [{ data: user, error: uErr }, { data: contacts, error: cErr }] = await Promise.all([
      supabase.from('user_profiles').select('id, email, full_name, is_active').ilike('email', email).maybeSingle(),
      supabase.from('contacts').select('id, primary_phone, secondary_phone, notification_phone').ilike('primary_email', email).limit(5),
    ]);
    if (uErr || cErr) return { ok: false, error: `owner lookup failed: ${(uErr || cErr).message}` };
    if (!user || user.is_active === false) return { ok: false, error: 'owner_not_found' };
    const numbers = numbersFromContacts(contacts);
    const env = e164(process.env.OWNER_MOBILE);
    if (env && !numbers.includes(env)) numbers.push(env);
    return { ok: true, numbers, record: { kind: 'owner', user_id: user.id, email: user.email, name: user.full_name || null } };
  }
  if (kind === 'staff') {
    const email = String(subject.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) return { ok: false, error: 'email_required' };
    const { data: user, error } = await supabase.from('user_profiles').select('id, email, full_name, role, is_active').ilike('email', email).maybeSingle();
    if (error) return { ok: false, error: `staff lookup failed: ${error.message}` };
    if (!user || user.is_active === false || !STAFF_ROLES.includes(String(user.role || '').toLowerCase())) return { ok: true, numbers: [], record: null };
    const { data: contacts, error: cErr } = await supabase.from('contacts').select('id, primary_phone, secondary_phone, notification_phone').ilike('primary_email', email).limit(5);
    if (cErr) return { ok: false, error: `staff contact lookup failed: ${cErr.message}` };
    return { ok: true, numbers: numbersFromContacts(contacts), record: { kind: 'staff', user_id: user.id, email: user.email, name: user.full_name || null, role: user.role } };
  }
  return { ok: false, error: 'subject_kind_invalid' };
}

// ---- Twilio Verify ----------------------------------------------------------------
async function twilio(method, path, form, { fetchImpl = fetch } = {}) {
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const r = await fetchImpl(VERIFY_API + path, { method, headers: { Authorization: `Basic ${auth}`, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
  if (!r.ok) {
    const err = new Error(`Twilio Verify ${method} ${path.replace(/VA[0-9a-f]{32}/i, 'VA…')} failed (${r.status}): ${(json && json.message) || text.slice(0, 200)}`);
    err.status = r.status; err.twilio_code = json && json.code; throw err;
  }
  return json;
}

let _serviceSid = null;
/** The Verify service: TWILIO_VERIFY_SERVICE_SID, else the one named "Bedrock" (created once if absent). */
async function serviceSid(deps = {}) {
  if (process.env.TWILIO_VERIFY_SERVICE_SID) return process.env.TWILIO_VERIFY_SERVICE_SID;
  if (_serviceSid) return _serviceSid;
  const list = await twilio('GET', '/Services?PageSize=50', null, deps);
  const hit = ((list && list.services) || []).find((s) => s.friendly_name === FRIENDLY_NAME);
  _serviceSid = hit ? hit.sid : (await twilio('POST', '/Services', { FriendlyName: FRIENDLY_NAME, CodeLength: '6' }, deps)).sid;
  return _serviceSid;
}

// ---- attempts ---------------------------------------------------------------------
const _attempts = new Map();
function prune(now = Date.now()) { for (const [k, a] of _attempts) if (now - a.created_at > ATTEMPT_TTL_MS) _attempts.delete(k); }

/**
 * Send a code for a subject. holder = { sends } counter object owned by the call / staff screen
 * (limits sends per holder). Returns { ok, attempt_id } or { ok:false, error, say }.
 * `say` is the plain sentence an AI may speak; it never contains the number.
 */
async function start({ supabase, subject, callerPhone = null, holder = {}, channel = 'phone', actor = null, onEvent = null, deps = {} }) {
  prune();
  if (!configured()) return { ok: false, error: 'not_configured', say: 'I cannot send a verification code right now. I can have someone from the team call you back to verify you.' };
  holder.sends = holder.sends || 0;
  if (holder.sends >= MAX_SENDS) return { ok: false, error: 'too_many_codes', say: 'I have already sent the most codes I can on one call. I can have the team call you back.' };
  const f = await onFile(supabase, subject);
  if (!f.ok) { console.warn('[verification] on-file lookup failed', JSON.stringify({ kind: subject && subject.kind, error: f.error })); return { ok: false, error: f.error, say: 'I could not look that record up just now.' }; }
  const pick = chooseNumber(f.numbers, callerPhone);
  if (!pick) return { ok: false, error: 'no_number_on_file', say: 'There is no phone number on file I can send a code to, so I cannot verify you on this call. The team can verify you another way.' };
  try {
    const sid = await serviceSid(deps);
    const v = await twilio('POST', `/Services/${sid}/Verifications`, { To: pick.to, Channel: 'sms' }, deps);
    holder.sends++;
    const id = crypto.randomUUID();
    _attempts.set(id, { id, to: pick.to, subject: { ...subject }, record: f.record, checks: 0, approved: false, created_at: Date.now(), channel, actor });
    if (onEvent) onEvent({ event: 'code_sent', attempt_id: id, subject_kind: subject.kind, matched_caller: pick.matched_caller, to_last2: pick.to.slice(-2), twilio_status: v && v.status });
    return { ok: true, attempt_id: id, matched_caller: pick.matched_caller, to_last2: pick.to.slice(-2), say: 'I just texted a six digit code to the phone number on file. Read it to me when it arrives.' };
  } catch (e) {
    console.error('[verification] send failed:', e.message);
    if (onEvent) onEvent({ event: 'send_failed', subject_kind: subject.kind, error: e.message });
    return { ok: false, error: 'send_failed', say: 'The code did not go out. I can have someone from the team call you back to verify you.' };
  }
}

/** Check a code. Returns { ok, approved, record } — record is the matched record ONLY when approved. */
async function check({ attempt_id, code, onEvent = null, deps = {} }) {
  prune();
  const a = _attempts.get(String(attempt_id || ''));
  if (!a) return { ok: false, approved: false, error: 'no_active_code', say: 'That code has expired. I can send a new one.' };
  const digits = String(code || '').replace(/\D/g, '');
  if (digits.length < 4 || digits.length > 10) return { ok: false, approved: false, error: 'code_format', say: 'The code is six digits. Can you read it again?' };
  if (a.approved) return { ok: true, approved: true, record: a.record, subject: a.subject };
  if (a.checks >= MAX_CHECKS) { _attempts.delete(a.id); return { ok: false, approved: false, error: 'too_many_checks', say: 'That is too many tries for one code. I can send a new one.' }; }
  a.checks++;
  try {
    const sid = await serviceSid(deps);
    const r = await twilio('POST', `/Services/${sid}/VerificationCheck`, { To: a.to, Code: digits }, deps);
    const approved = !!(r && r.status === 'approved');
    if (onEvent) onEvent({ event: approved ? 'approved' : 'code_wrong', attempt_id: a.id, subject_kind: a.subject.kind, checks: a.checks });
    if (!approved) return { ok: true, approved: false, say: 'That code did not match. Can you read it once more?' };
    a.approved = true;
    return { ok: true, approved: true, record: a.record, subject: a.subject };
  } catch (e) {
    // Twilio answers 404 once a code is used up or expired.
    console.warn('[verification] check failed:', e.message);
    if (onEvent) onEvent({ event: 'check_failed', attempt_id: a.id, error: e.message });
    if (e.status === 404) { _attempts.delete(a.id); return { ok: false, approved: false, error: 'expired', say: 'That code has expired. I can send a new one.' }; }
    return { ok: false, approved: false, error: 'check_failed', say: 'I could not check that code just now. Want me to send a new one?' };
  }
}

/** READ ONLY readiness: credentials present, and whether the Verify service exists. Never creates it. */
async function readiness(deps = {}) {
  if (!configured()) return { ok: false, configured: false, missing: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'].filter((k) => !process.env[k]) };
  if (process.env.TWILIO_VERIFY_SERVICE_SID) return { ok: true, configured: true, service: `${process.env.TWILIO_VERIFY_SERVICE_SID.slice(0, 4)}…`, from_env: true };
  try {
    const list = await twilio('GET', '/Services?PageSize=50', null, deps);
    const hit = ((list && list.services) || []).find((x) => x.friendly_name === FRIENDLY_NAME);
    return { ok: !!hit, configured: true, service: hit ? `${hit.sid.slice(0, 4)}…` : null, exists: !!hit, from_env: false, created_at: hit ? hit.date_created || null : null };
  } catch (e) { return { ok: false, configured: true, error: e.message }; }
}

function _resetForTests() { _attempts.clear(); _serviceSid = null; }

module.exports = { start, check, onFile, readiness, configured, e164, numbersFromContacts, chooseNumber, OWNER_RESIDENCY, STAFF_ROLES, MAX_SENDS, MAX_CHECKS, _resetForTests };
