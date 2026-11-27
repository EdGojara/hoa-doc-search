// ============================================================================
// lib/amanda/context.js  (Ed 2026-11-28: ONE Amanda on every channel)
// ----------------------------------------------------------------------------
// What Amanda knows, the same on Talk to Amanda, the phone, email and her own
// operations. Channels differ only in delivery and in who is asking. Nothing here
// is a new store: every block is read from an existing record.
//
//   permanent  Ed's approved principles (persona_learned_guidance, the drafting
//              loop's graded lessons) and what she keeps about Bedrock, its people
//              and his preferences (amanda_memory kinds fact / preference / person)
//   working    the standing workstreams with their LIVE state from the authorization
//              records (lib/amanda/conversation loadWorkstreams), and her open
//              commitments and threads (amanda_memory commitment / open_thread)
//   history    past conversation summaries, closed objectives, executed authorizations:
//              retrieved on demand (find_anything), never bulk-loaded
//
// MEMORY WRITES go through rememberFrom(), the one extraction path, whatever the
// channel (voice, phone, text, email). Engineering checks never write memory: a
// verification session is skipped (PR #498) and no test harness calls this.
// ============================================================================

const PERMANENT_KINDS = ['fact', 'preference', 'person'];
const WORKING_KINDS = ['commitment', 'open_thread'];
const short = (s, n = 300) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim().slice(0, n));

// Which owner-authorization scopes report into which workstream (live state, never a copy). A
// workstream objective may also list its own in subject_refs.authorization_scopes.
const WORKSTREAM_SCOPES = [
  { match: /accounting|financial|assessment/i, scopes: ['accounting_runs', 'legal_posting_reversals', 'check_receipt_allocations', 'closing_packages', 'conversion_objects'] },
  { match: /portal|stripe/i, scopes: ['portal_silent_creates'] },
];
const scopesFor = (w) => [...new Set([...(((w.subject_refs || {}).authorization_scopes) || []), ...WORKSTREAM_SCOPES.filter((m) => m.match.test(w.title)).flatMap((m) => m.scopes)])];
// Live state of a workstream from the operational records themselves, so the briefing is never
// stale and nobody has to copy a report into it: owner authorizations waiting for Ed, approved but
// unfinished, and executed in the last 3 days.
async function liveWorkstreamState(supabase, items, now = Date.now()) {
  const scopes = [...new Set(items.flatMap(scopesFor))];
  if (!scopes.length) return { live: {}, errors: [] };
  const since = new Date(now - 3 * 86400e3).toISOString();
  const [auth, recent] = await Promise.all([
    supabase.from('owner_authorizations').select('scope, subject, status, requested_at, expires_at').in('scope', scopes).in('status', ['requested', 'authorized']).order('requested_at', { ascending: false }).limit(30),
    supabase.from('owner_authorizations').select('scope, subject, status, executed_at').in('scope', scopes).gte('executed_at', since).order('executed_at', { ascending: false }).limit(20),
  ]);
  const errors = [auth.error, recent.error].filter(Boolean).map((e) => e.message);
  const live = {};
  for (const w of items) {
    const sc = new Set(scopesFor(w));
    live[w.id] = {
      waiting_for_ed: (auth.data || []).filter((a) => sc.has(a.scope) && a.status === 'requested').map((a) => `${short(a.subject, 140)}${a.expires_at ? ` (expires ${String(a.expires_at).slice(0, 10)})` : ''}`),
      approved_not_finished: (auth.data || []).filter((a) => sc.has(a.scope) && a.status === 'authorized').map((a) => short(a.subject, 140)),
      done_last_3_days: (recent.data || []).filter((a) => sc.has(a.scope)).map((a) => `${short(a.subject, 120)} (${String(a.executed_at).slice(0, 10)})`),
    };
  }
  return { live, errors };
}

/** Ed's approved principles for Amanda, from the drafting loop he grades (may be ''). */
async function approvedPrinciples(supabase) {
  try { return String(await require('../team/learned_guidance').loadApprovedGuidance(supabase, 'amanda') || '').trim(); } catch (_) { return ''; }
}

/**
 * The context block every Amanda channel can add to its prompt, sized for the audience:
 *   owner  Ed himself: principles, his memory (permanent + working), workstreams with live state
 *   staff  a Bedrock colleague: principles and the workstreams (what the company is working on);
 *          never Ed's private memory
 * Returns { text, errors }.
 */
async function amandaContextBlock(supabase, { audience = 'staff', ownerUserId = null, limit = 30 } = {}) {
  const errors = {};
  const parts = [];
  const principles = await approvedPrinciples(supabase);
  if (principles) parts.push(`ED'S STANDING PRINCIPLES FOR YOU (approved by him; follow them):\n${short(principles, 4000)}`);
  if (audience === 'owner' && ownerUserId) {
    const { data, error } = await supabase.from('amanda_memory').select('kind, content, updated_at').eq('owner_user_id', ownerUserId).eq('status', 'active').order('updated_at', { ascending: false }).limit(limit);
    if (error) errors.memory = error.message;
    const perm = (data || []).filter((m) => PERMANENT_KINDS.includes(m.kind));
    const work = (data || []).filter((m) => WORKING_KINDS.includes(m.kind));
    if (perm.length) parts.push(`WHAT YOU KNOW ABOUT BEDROCK, ITS PEOPLE AND ED'S PREFERENCES:\n${perm.map((m) => `- [${m.kind}] ${m.content}`).join('\n')}`);
    if (work.length) parts.push(`YOUR OPEN COMMITMENTS AND THREADS WITH ED:\n${work.map((m) => `- [${m.kind}] ${m.content}`).join('\n')}`);
  }
  try {
    const C = require('./conversation');
    const ws = await C.loadWorkstreams(supabase);
    if (ws.error) errors.workstreams = ws.error;
    if (ws.items && ws.items.length) parts.push(C.workstreamsBlock(ws.items));
  } catch (e) { errors.workstreams = e.message; }
  return { text: parts.join('\n\n'), errors };
}

/**
 * The ONE memory-writing path for every channel. Extracts a summary and what is worth keeping
 * from a transcript, against what she already keeps (so changed circumstances mark old items
 * done instead of piling up). Each item is attributed: channel and, for a conversation, its session.
 * Returns { summary, kept, done, error }.
 */
async function rememberFrom(supabase, anthropic, { ownerUserId, transcript, sourceChannel, sourceSessionId = null, attribution = {} }) {
  const out = { summary: null, kept: 0, done: 0, error: null };
  if (!transcript || !anthropic || !ownerUserId) return out;
  const C = require('./conversation');
  const { route: aiRoute, withAttribution } = require('../ai/router');
  const { data: mem } = await supabase.from('amanda_memory').select('id, kind, content').eq('owner_user_id', ownerUserId).eq('status', 'active').order('updated_at', { ascending: false }).limit(40);
  try {
    const resp = await withAttribution({ user_id: ownerUserId, channel: sourceChannel, ...attribution }, () => anthropic.messages.create({ model: aiRoute(C.EXTRACT_WORKFLOW), max_tokens: 900, messages: [{ role: 'user', content: C.extractionPrompt({ transcript, memories: mem || [] }) }] }));
    const raw = (resp.content || []).map((c) => c.text || '').join('');
    console.log('[amanda.context] extraction returned:', raw.slice(0, 2000));
    const j = JSON.parse(raw.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim());
    out.summary = short(j.summary, 1500);
    const known = new Set((mem || []).map((m) => m.id));
    const add = (Array.isArray(j.remember) ? j.remember : []).filter((m) => m && C.MEMORY_KINDS.includes(m.kind) && short(m.content, 1000) && !/\b\d{8,}\b|password|routing number|account number/i.test(m.content)).slice(0, 8);
    for (const m of add) {
      let communityId = null;
      if (m.community) { try { communityId = ((await require('./request').resolveCommunity(supabase, { text: String(m.community) })).community || {}).id || null; } catch (_) { communityId = null; } }
      const { error } = await supabase.from('amanda_memory').insert({ owner_user_id: ownerUserId, kind: m.kind, content: short(m.content, 1000), community_id: communityId, source_session_id: sourceSessionId, source_channel: sourceChannel });
      if (error) console.warn('[amanda.context] memory insert failed', error.message); else out.kept++;
    }
    const doneIds = (Array.isArray(j.done) ? j.done : []).filter((id) => known.has(id));
    if (doneIds.length) { const { error } = await supabase.from('amanda_memory').update({ status: 'done', updated_at: new Date().toISOString() }).in('id', doneIds); if (error) console.warn('[amanda.context] memory done failed', error.message); else out.done = doneIds.length; }
  } catch (e) { out.error = e.message; console.warn('[amanda.context] extraction failed:', e.message); }
  return out;
}

/**
 * Executive coordination: what each teammate is carrying, from the objectives themselves.
 * Open, overdue (next step due before today), blocked or waiting on a person, and closed in
 * the last 7 days, per teammate; plus the owner authorizations waiting for Ed. Read only.
 */
async function teamStatus(supabase, { now = Date.now(), teammate = null } = {}) {
  const OPEN = ['open', 'waiting_human', 'waiting_third_party', 'waiting_resident'];
  const today = new Date(now).toISOString().slice(0, 10);
  const since7 = new Date(now - 7 * 86400e3).toISOString();
  const who = teammate ? String(teammate).toLowerCase().replace(/[^a-z]/g, '') : null;
  let openQ = supabase.from('objectives').select('id, title, status, owner_persona, accountable_persona, next_action, next_action_due, blocked_reason, last_activity_at, community:community_id(name)').in('status', OPEN).order('last_activity_at', { ascending: false }).limit(400);
  let doneQ = supabase.from('objectives').select('title, owner_persona, accountable_persona, closed_at, updated_at, community:community_id(name)').in('status', ['resolved', 'closed']).gte('updated_at', since7).order('updated_at', { ascending: false }).limit(100);
  if (who) { openQ = openQ.or(`owner_persona.eq.${who},accountable_persona.eq.${who}`); doneQ = doneQ.or(`owner_persona.eq.${who},accountable_persona.eq.${who}`); }
  const [open, done, waiting] = await Promise.all([openQ, doneQ,
    supabase.from('owner_authorizations').select('scope, subject, requested_at, expires_at').eq('status', 'requested').order('requested_at', { ascending: false }).limit(20)]);
  const errors = Object.fromEntries(Object.entries({ open, done, waiting }).filter(([, r]) => r.error).map(([k, r]) => [k, r.error.message]));
  const by = {};
  const slot = (p) => (by[p] = by[p] || { open: 0, overdue: [], blocked: [], waiting_on_person: 0, done_7_days: 0, oldest_activity: null });
  for (const o of open.data || []) {
    const p = o.owner_persona || o.accountable_persona || 'unassigned'; const s = slot(p); s.open++;
    if (o.status === 'waiting_human') s.waiting_on_person++;
    const due = o.next_action_due ? String(o.next_action_due).slice(0, 10) : null;
    const label = `${short(o.title, 110)}${o.community && o.community.name ? ` (${o.community.name})` : ''}`;
    if (due && due < today && s.overdue.length < 6) s.overdue.push(`${label}, due ${due}`);
    if (o.blocked_reason && s.blocked.length < 4) s.blocked.push(`${label}: ${short(o.blocked_reason, 120)}`);
    const la = o.last_activity_at ? String(o.last_activity_at).slice(0, 10) : null;
    if (la && (!s.oldest_activity || la < s.oldest_activity)) s.oldest_activity = la;
  }
  for (const d of done.data || []) slot(d.owner_persona || d.accountable_persona || 'unassigned').done_7_days++;
  return { ok: !Object.keys(errors).length, as_of: today, by_teammate: by,
    waiting_for_ed: (waiting.data || []).map((a) => `${short(a.subject, 140)}${a.expires_at ? ` (expires ${String(a.expires_at).slice(0, 10)})` : ''}`),
    recently_completed: (done.data || []).slice(0, 10).map((d) => `${short(d.title, 110)} (${d.owner_persona || d.accountable_persona}, ${String(d.closed_at || d.updated_at).slice(0, 10)})`),
    errors: Object.keys(errors).length ? errors : undefined };
}

/** The owner's user id (for an email from Ed, which carries no session). */
async function ownerUserId(supabase) {
  const { OWNER_EMAIL } = require('../auth/owner_email');
  const { data, error } = await supabase.from('user_profiles').select('id').ilike('email', OWNER_EMAIL).limit(1);
  if (error) throw new Error(`owner lookup failed: ${error.message}`);
  return (data && data[0] && data[0].id) || null;
}

module.exports = { teamStatus, liveWorkstreamState, scopesFor, WORKSTREAM_SCOPES, amandaContextBlock, rememberFrom, approvedPrinciples, ownerUserId, PERMANENT_KINDS, WORKING_KINDS };
