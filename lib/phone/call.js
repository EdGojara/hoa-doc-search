// ============================================================================
// lib/phone/call.js  (Ed 2026-11-27: Claire and Amanda on the telephone)
// ----------------------------------------------------------------------------
// One phone call = one claire_sessions row (surface 'conversation', channel
// 'phone', provider 'elevenlabs') shared by Claire and Amanda, so a transfer
// keeps one transcript (claire_session_turns, persona per turn) and one record.
// homeowner_calls keeps the call log row the Calls dashboard already reads.
//
// WHO the caller is lives only here, in code:
//   phone_verification     branded (lib/voice/private_gate) after a code sent to the
//                          number on file for the OWNER of a property passed
//                          -> the homeowner principal (their lot only)
//   identity_verification  branded after a code sent to the number on the person's
//                          own record passed (owner / staff)
//                          -> the owner or staff principal (lib/lookups/principal)
// Nothing the caller says, the model writes, or the voice shell sends can set
// either: both are minted in this process by verificationApproved() only.
//
// The per-call token is HMAC-signed (session id + expiry). It reaches the brain
// in the custom-LLM extra body, or (fallback, decision 1) in the agent prompt as
// PHONE_SESSION=<token>; both come from ElevenLabs behind the agent header secret.
// ============================================================================
const crypto = require('crypto');
const gate = require('../voice/private_gate');
const Verification = require('../verification');
const Principal = require('../lookups/principal');

const TOKEN_TTL_MS = 2 * 3600 * 1000;
const STATE_TTL_MS = 3 * 3600 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secret() { return process.env.STAFF_GATE_SECRET || process.env.SUPABASE_KEY || ''; }
function signToken({ sid, now = Date.now() }) {
  const body = Buffer.from(JSON.stringify({ sid, exp: now + TOKEN_TTL_MS })).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update('trusted-phone-session:' + body).digest('base64url');
  return `${body}.${mac}`;
}
function verifyToken(tok, now = Date.now()) {
  const [body, mac] = String(tok || '').trim().split('.');
  if (!body || !mac || !secret()) return null;
  const want = crypto.createHmac('sha256', secret()).update('trusted-phone-session:' + body).digest('base64url');
  const a = Buffer.from(mac); const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let j; try { j = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!j || !UUID.test(j.sid) || !j.exp || j.exp < now) return null;
  return j;
}
/** PURE: the session token from a brain request: extra body first, then the PHONE_SESSION line. */
function tokenFromRequest(body) {
  const b = body || {};
  const extra = b.elevenlabs_extra_body || b.custom_llm_extra_body || {};
  if (extra && extra.session_token) return { token: String(extra.session_token), via: 'extra_body' };
  for (const m of Array.isArray(b.messages) ? b.messages : []) {
    if (!m || m.role !== 'system') continue;
    const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((c) => (c && c.text) || '').join(' ') : '';
    const hit = /PHONE_SESSION=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(text);
    if (hit) return { token: hit[1], via: 'prompt' };
  }
  return { token: null, via: null };
}

// ---- call state ----------------------------------------------------------------------
const _calls = new Map();
function prune(now = Date.now()) { for (const [k, v] of _calls) if (now - v.touched > STATE_TTL_MS) _calls.delete(k); }
function newConv(session) {
  return require('../amanda/conversation').newState({ session, owner: null, briefing: { text: 'The caller has not been verified. You have no records for them.', memory_ids: [], errors: {}, status: null } });
}
function newCall(row) {
  const m = (row.metrics && row.metrics.phone) || {};
  return {
    sid: row.id, conversation_id: row.provider_conversation_id || null, call_sid: m.call_sid || null, caller_phone: m.caller_phone || null, called_number: m.called_number || null,
    community: row.community_id ? { id: row.community_id, name: m.community_name || null } : null, route_id: m.route_id || null,
    holder: { sends: 0 }, attempt: null, phone_verification: null, identity_verification: null, homeowner: null,
    conv: newConv({ id: row.id, staff_user_id: row.staff_user_id || null }), touched: Date.now(), via: null,
  };
}

/** Called by the initiation webhook: open the session + call log row and sign the token. */
async function openCall(supabase, { conversation_id = null, call_sid = null, caller_id = null, called_number = null, agent_persona = 'claire' }) {
  prune();
  const to = Verification.e164(called_number) || called_number || null;
  const { data: route, error: rErr } = await supabase.from('voice_phone_routes').select('id, community_id, community_display_name, enabled').eq('inbound_phone_number', to).eq('enabled', true).maybeSingle();
  if (rErr) console.warn('[phone] route lookup failed:', rErr.message);
  let community = null;
  if (route && route.community_id) {
    const { data: c, error } = await supabase.from('communities').select('id, name').eq('id', route.community_id).maybeSingle();
    if (error) console.warn('[phone] community lookup failed:', error.message);
    community = c ? { id: c.id, name: c.name } : null;
  }
  const caller = Verification.e164(caller_id) || (caller_id ? String(caller_id).slice(0, 40) : null);
  const phoneMeta = { call_sid, caller_phone: caller, called_number: to, route_id: route ? route.id : null, community_name: community ? community.name : null, opened_by: agent_persona };
  const { data: row, error } = await supabase.from('claire_sessions').insert({
    community_id: community ? community.id : null, role: 'homeowner', surface: 'conversation', channel: 'phone', provider: 'elevenlabs', provider_conversation_id: conversation_id,
    status: 'active', avatar_provider: 'none', active_persona: agent_persona, seconds_cap: 1800, metrics: { phone: phoneMeta },
  }).select('id, community_id, staff_user_id, provider_conversation_id, metrics').single();
  if (error) throw new Error(`could not open the phone session: ${error.message}`);
  if (call_sid) {
    const { error: hErr } = await supabase.from('homeowner_calls').upsert({ call_sid, community_id: community ? community.id : null, voice_route_id: route ? route.id : null, caller_phone: caller, status: 'in_progress', answered_at: new Date().toISOString(), raw_provider_metadata: { provider: 'elevenlabs', conversation_id, session_id: row.id } }, { onConflict: 'call_sid' });
    if (hErr) console.warn('[phone] call log write failed:', hErr.message);
  }
  const st = newCall(row);
  _calls.set(row.id, st);
  return { st, token: signToken({ sid: row.id }), community };
}

/** The call for a session id: from memory, else rebuilt from the session row (process restart). */
async function loadCall(supabase, sid) {
  prune();
  const hit = _calls.get(sid);
  if (hit) { hit.touched = Date.now(); return hit; }
  const { data: row, error } = await supabase.from('claire_sessions').select('id, community_id, staff_user_id, property_id, provider_conversation_id, metrics, channel, surface, finalized_at').eq('id', sid).maybeSingle();
  if (error) throw new Error(`phone session lookup failed: ${error.message}`);
  if (!row || row.channel !== 'phone' || row.surface !== 'conversation' || row.finalized_at) return null;
  const st = newCall(row);
  const v = row.metrics && row.metrics.phone && row.metrics.phone.verified;
  // Re-mint only what THIS server recorded at approval time (service-role write, never caller input).
  if (v && v.kind === 'property' && v.property_id && v.property_id === row.property_id) await applyHomeowner(supabase, st, { property_id: v.property_id, name: v.name || null, contact_ids: v.contact_ids || [] }, { persist: false });
  if (v && (v.kind === 'owner' || v.kind === 'staff') && v.user_id && v.user_id === row.staff_user_id) await applyIdentity(supabase, st, v, { persist: false });
  const { data: last } = await supabase.from('claire_session_turns').select('seq').eq('session_id', sid).order('seq', { ascending: false }).limit(1);
  st.conv.seq = last && last[0] ? last[0].seq : 0;
  _calls.set(sid, st);
  return st;
}

// ---- verification (lib/verification) ---------------------------------------------------
function systemNote(supabase, st, text) {
  st.conv.chain = st.conv.chain.then(async () => {
    const { error } = await supabase.from('claire_session_turns').insert({ session_id: st.sid, seq: ++st.conv.seq, speaker: 'system', text: String(text).slice(0, 1000) });
    if (error) console.warn('[phone] system note failed:', error.message);
  }).catch((e) => console.warn('[phone] note chain failed:', e.message));
  return st.conv.chain;
}
const auditFor = (supabase, st) => (e) => {
  const words = { code_sent: `Verification code sent to the number on file for the ${e.subject_kind === 'property_owner' ? 'owner of the property' : e.subject_kind} (${e.matched_caller ? 'the number calling' : 'not the number calling'}).`, approved: 'Verification code approved.', code_wrong: `Verification code did not match (try ${e.checks}).`, send_failed: 'Verification code could not be sent.', check_failed: 'Verification code could not be checked.' };
  systemNote(supabase, st, words[e.event] || `Verification: ${e.event}`);
  console.log('[phone] verification', JSON.stringify({ session_id: st.sid, ...e }));
};

async function applyHomeowner(supabase, st, record, { persist = true } = {}) {
  st.phone_verification = gate.createPhoneVerification({ property_id: record.property_id, method: gate.SMS_CODE_ON_FILE });
  const { data: p } = await supabase.from('properties').select('street_address, community_id').eq('id', record.property_id).maybeSingle();
  st.homeowner = { property_id: record.property_id, address: p ? p.street_address : null, name: record.name || null, contact_ids: record.contact_ids || [] };
  if (persist) {
    const meta = { ...(await phoneMeta(supabase, st.sid)), verified: { kind: 'property', property_id: record.property_id, name: record.name || null, contact_ids: record.contact_ids || [], method: gate.SMS_CODE_ON_FILE, at: new Date().toISOString() } };
    const { error } = await supabase.from('claire_sessions').update({ property_id: record.property_id, visitor_name: record.name || null, metrics: { phone: meta } }).eq('id', st.sid);
    if (error) console.warn('[phone] verified write failed:', error.message);
    if (st.call_sid && record.contact_ids && record.contact_ids[0]) {
      const { error: hErr } = await supabase.from('homeowner_calls').update({ caller_homeowner_id: record.contact_ids[0] }).eq('call_sid', st.call_sid);
      if (hErr) console.warn('[phone] call log caller write failed:', hErr.message);
    }
  }
}
async function applyIdentity(supabase, st, record, { persist = true } = {}) {
  st.identity_verification = gate.createIdentityVerification({ kind: record.kind, user_id: record.user_id, email: record.email, name: record.name, method: gate.SMS_CODE_ON_FILE });
  st.conv.owner = { user_id: record.user_id, email: record.email, name: record.name || null };
  st.conv.session.staff_user_id = record.user_id;
  try { st.conv.briefing = await require('../amanda/conversation').loadBriefing(supabase, { ownerUserId: record.user_id }); }
  catch (e) { console.warn('[phone] briefing failed:', e.message); }
  if (persist) {
    const meta = { ...(await phoneMeta(supabase, st.sid)), verified: { kind: record.kind, user_id: record.user_id, email: record.email, name: record.name || null, method: gate.SMS_CODE_ON_FILE, at: new Date().toISOString() } };
    const { error } = await supabase.from('claire_sessions').update({ role: 'staff', staff_user_id: record.user_id, visitor_name: record.name || null, visitor_email: record.email || null, record_ownership: 'workpaper', metrics: { phone: meta } }).eq('id', st.sid);
    if (error) console.warn('[phone] verified write failed:', error.message);
  }
}
async function phoneMeta(supabase, sid) {
  const { data } = await supabase.from('claire_sessions').select('metrics').eq('id', sid).maybeSingle();
  return (data && data.metrics && data.metrics.phone) || {};
}

async function verificationApproved(supabase, st, r) {
  if (r.subject.kind === 'property_owner') await applyHomeowner(supabase, st, r.record);
  else await applyIdentity(supabase, st, r.record);
}

/** The principal this call has earned, or null. */
async function principalFor(supabase, st) {
  const id = gate.verifiedIdentity(st);
  if (id && id.kind === 'owner') return Principal.ownerPrincipal({ user: { id: id.user_id }, full_name: id.name });
  if (id && id.kind === 'staff') return Principal.staffPrincipal({ user_id: id.user_id, name: id.name, verified: true });
  if (gate.phoneVerifiedPropertyId(st) && st.community) {
    let financials = false;
    try { financials = !!(await require('../portal/financial_access').financialAccessFor(supabase, st.community.id)).balance; } catch (e) { console.warn('[phone] financial access lookup failed:', e.message); }
    return Principal.phoneHomeownerPrincipal({ ctx: st, communityId: st.community.id, financials });
  }
  return null;
}

// ---- property match for "my address is ..." -----------------------------------------------
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const squash = (s) => norm(s).replace(/ /g, '');
const STREET_WORDS = { street: 'st', st: 'st', drive: 'dr', dr: 'dr', lane: 'ln', ln: 'ln', court: 'ct', ct: 'ct', road: 'rd', rd: 'rd', avenue: 'ave', ave: 'ave', boulevard: 'blvd', blvd: 'blvd', way: 'way', circle: 'cir', cir: 'cir', trail: 'trl', trl: 'trl', place: 'pl', pl: 'pl', parkway: 'pkwy', pkwy: 'pkwy' };
const canonWords = (s) => norm(s).split(' ').map((w) => STREET_WORDS[w] || w);
/** PURE: the one property an address names, from candidates, or null (ambiguous / none). */
function matchAddress(spoken, candidates) {
  const sq = squash(spoken);
  if (!sq) return null;
  const exact = candidates.filter((c) => squash(c.street_address) === sq);
  if (exact.length === 1) return exact[0];
  const words = canonWords(spoken);
  const num = words.find((w) => /^\d+$/.test(w));
  const scored = candidates.map((c) => {
    const cw = canonWords(c.street_address);
    if (num && cw[0] !== num) return { c, s: 0 };
    const overlap = cw.slice(1).filter((w) => words.includes(w)).length;
    return { c, s: overlap / Math.max(1, cw.length - 1) };
  }).filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].s === scored[1].s) return null;
  return scored[0].c;
}
async function findProperty(supabase, communityId, spoken) {
  const words = norm(spoken).split(' ');
  const anchor = words.find((w) => /\d/.test(w)) || words[0];
  if (!anchor || !communityId) return null;
  const { data, error } = await supabase.from('properties').select('id, street_address, community_id').eq('community_id', communityId).ilike('street_address', `%${anchor.replace(/[%_]/g, '')}%`).limit(200);
  if (error) { console.warn('[phone] property search failed:', error.message); return null; }
  return matchAddress(spoken, data || []);
}

// ---- tools both brains add (verification) ----------------------------------------------
const CLAIRE_VERIFY_TOOLS = [
  { name: 'verify_caller', description: 'The caller wants their OWN account (balance, payments, violations, ACC, letters). Texts a one-time code to the phone number ON FILE for the owner of the home they name. Never say which number. Then ask them to read the code and call check_code.', input_schema: { type: 'object', properties: { address: { type: 'string', description: 'The street address of their home, as they said it' } }, required: ['address'] } },
  { name: 'check_code', description: 'Check the code the caller read back after verify_caller.', input_schema: { type: 'object', properties: { code: { type: 'string', description: 'The digits they read' } }, required: ['code'] } },
];
const AMANDA_VERIFY_TOOLS = [
  { name: 'verify_caller', description: 'Verify who is calling before using any records: texts a one-time code to the phone number on THEIR OWN record. who = owner for Ed Gojara; who = staff for a Bedrock employee (give their work email). Never say which number. Then ask them to read the code and call check_code.', input_schema: { type: 'object', properties: { who: { type: 'string', enum: ['owner', 'staff'] }, email: { type: 'string', description: 'Work email, for staff' } }, required: ['who'] } },
  { name: 'check_code', description: 'Check the code the caller read back after verify_caller.', input_schema: { type: 'object', properties: { code: { type: 'string', description: 'The digits they read' } }, required: ['code'] } },
];

function verifyHandlers(supabase, st, persona) {
  return {
    async verify_caller(input = {}) {
      let subject;
      if (persona === 'claire') {
        if (gate.phoneVerifiedPropertyId(st)) return { ok: true, already_verified: true };
        if (!st.community) return { ok: false, say: 'This line is not connected to a community yet, so I cannot verify an account here.' };
        const prop = await findProperty(supabase, st.community.id, input.address);
        // Same answer whether or not the address exists (never confirm what is on file).
        if (!prop) return { ok: false, say: 'I was not able to send a code for that address. Can you say the full street address again?' };
        subject = { kind: 'property_owner', property_id: prop.id, community_id: st.community.id };
      } else {
        if (gate.verifiedIdentity(st)) return { ok: true, already_verified: true };
        subject = input.who === 'owner' ? { kind: 'owner' } : { kind: 'staff', email: input.email };
      }
      // One code per subject per 90 seconds: a repeated request (a resend, or the model asking twice)
      // never texts the owner again while the last code is still fresh.
      const subjectKey = JSON.stringify(subject);
      if (st.attempt && st.attempt.subjectKey === subjectKey && Date.now() - st.attempt.at < 90 * 1000) return { ok: true, already_sent: true, say: 'I just texted that code a moment ago. Read it to me when it arrives.' };
      const r = await Verification.start({ supabase, subject, callerPhone: st.caller_phone, holder: st.holder, channel: 'phone', actor: persona, onEvent: auditFor(supabase, st) });
      if (r.ok) st.attempt = { id: r.attempt_id, persona, subjectKey, at: Date.now() };
      // A subject with no number on file answers like an unknown address on Claire's line.
      if (!r.ok && persona === 'claire' && r.error === 'no_number_on_file') return { ok: false, say: 'I was not able to send a code for that address. The team can verify you another way, or you can sign in to your homeowner portal.' };
      return { ok: r.ok, say: r.say, error: r.ok ? undefined : r.error };
    },
    async check_code(input = {}) {
      if (!st.attempt) return { ok: false, say: 'I have not sent a code yet on this call.' };
      const r = await Verification.check({ attempt_id: st.attempt.id, code: input.code, onEvent: auditFor(supabase, st) });
      if (!r.approved) return { ok: false, verified: false, say: r.say };
      await verificationApproved(supabase, st, r);
      st.attempt = null;
      return { ok: true, verified: true, who: r.subject.kind === 'property_owner' ? 'the owner of the home' : (r.record && r.record.name) || r.subject.kind, now_available: persona === 'claire' ? 'their own account through my_account and homeowner_transactions' : 'their records and your tools' };
    },
  };
}

module.exports = { signToken, verifyToken, tokenFromRequest, openCall, loadCall, principalFor, verifyHandlers, matchAddress, findProperty, systemNote, CLAIRE_VERIFY_TOOLS, AMANDA_VERIFY_TOOLS, _calls };
