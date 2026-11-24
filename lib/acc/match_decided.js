// ============================================================================
// lib/acc/match_decided.js  (Ed 2026-11-24, migration 576)
// ----------------------------------------------------------------------------
// A reply or supplemental submission about an application that was ALREADY
// DECIDED belongs to that application. Scar (WAT-ARC-2026-0043): the open-case
// matcher (match_open_application.js) only looks at open cases, so a swatch sent
// in the same email thread, after the denial, became two new applications, one
// per mailbox the email was sent to.
//
// Signals, strongest first:
//   reference   the case's number is in the subject (or, if the subject has none,
//               exactly one number is in the message)
//   thread      same email conversation. Microsoft gives each mailbox its own
//               conversation id; the last 17 bytes are the conversation itself,
//               so info@ and annie@ copies of one thread compare equal.
//   email+address  known correspondent AND the same property, nothing attached
//               that reads as an application form, exactly one decision there in
//               the last 60 days.
// A withdrawn duplicate resolves to the application it duplicates. An OPEN case on
// the same thread or number always wins (the open-case path handles it).
// ============================================================================
const { normAddr, normEmail } = require('./match_open_application');
const OPEN = ['pending_review', 'awaiting_info', 'finalizing'];
const REF_RE = /\b[A-Z]{2,5}-ARC-\d{4}-\d{3,6}\b/gi;
const COLS = 'id, management_company_id, community_id, community_name, status, decision_type, decided_at, finalization_id, reference_number, homeowner_name, homeowner_address, submitter_email, correspondent_emails, conversation_id, duplicate_of_id, created_at';
const COLS_PRE576 = COLS.replace(', duplicate_of_id', '');

const refsIn = (t) => [...new Set((String(t || '').match(REF_RE) || []).map((x) => x.toUpperCase()))];
// Mailbox-independent conversation key: the tail of the Graph conversation id.
function threadKey(conversationId) {
  const s = String(conversationId || '').trim();
  return s.length >= 40 ? s.slice(-24) : null;
}
// The one case number a message is about, or null when there is none or it is unclear.
function referenceOf({ subject, body }) {
  const inSubject = refsIn(subject);
  if (inSubject.length === 1) return inSubject[0];
  if (inSubject.length > 1) return null;
  const inBody = refsIn(body);
  return inBody.length === 1 ? inBody[0] : null;
}

// rows: candidate cases (any status). Returns { open } | { decided, matched_by } | null.
// byId: Map for following duplicate_of_id.
function pick(rows, matchedBy, byId = new Map()) {
  const seen = new Set(); const live = [];
  for (let r of rows || []) {
    for (let hops = 0; r && ['withdrawn', 'archived'].includes(r.status) && r.duplicate_of_id && hops < 5; hops++) r = byId.get(r.duplicate_of_id) || null;
    if (!r || seen.has(r.id)) continue; seen.add(r.id);
    live.push(r);
  }
  const open = live.find((r) => OPEN.includes(r.status));
  if (open) return { open };
  const decided = live.filter((r) => r.status === 'decided');
  // Two decided cases on one thread: unclear which, so a person decides.
  return decided.length === 1 ? { decided: decided[0], matched_by: matchedBy } : null;
}

async function select(supabase, build) {
  let r = await build(supabase.from('acc_decisions').select(COLS));
  if (r.error && /duplicate_of_id/.test(r.error.message || '')) r = await build(supabase.from('acc_decisions').select(COLS_PRE576));
  if (r.error) throw new Error(`ACC case lookup failed: ${r.error.message}`);
  return r.data || [];
}
async function originals(supabase, rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  let need = rows.map((r) => r.duplicate_of_id).filter((id) => id && !byId.has(id));
  for (let i = 0; need.length && i < 5; i++) {
    const more = await select(supabase, (q) => q.in('id', [...new Set(need)]).limit(50));
    for (const m of more) byId.set(m.id, m);
    need = more.map((m) => m.duplicate_of_id).filter((id) => id && !byId.has(id));
  }
  return byId;
}

// Reference and thread. managementCompanyId scopes the search to Bedrock's cases.
// A bounce or automatic notice is not a submission.
const isSystemMail = ({ sender, subject }) => /mailer-daemon|postmaster|no-?reply|donotreply|microsoftexchange/i.test(String(sender || '')) || /^\s*(undeliverable|delivery (status|failure)|automatic reply|out of office)/i.test(String(subject || ''));
async function findCaseByReferenceOrThread(supabase, { managementCompanyId, subject, body, conversationId, sender = null }) {
  if (isSystemMail({ sender, subject })) return null;
  const ref = referenceOf({ subject, body });
  if (ref) {
    const rows = await select(supabase, (q) => q.eq('management_company_id', managementCompanyId).eq('reference_number', ref).limit(5));
    const hit = pick(rows, ['reference'], await originals(supabase, rows));
    if (hit) return hit;
  }
  const key = threadKey(conversationId);
  if (key) {
    const rows = await select(supabase, (q) => q.eq('management_company_id', managementCompanyId).like('conversation_id', `%${key.replace(/[%_\\]/g, '\\$&')}`).limit(20));
    const hit = pick(rows, ['thread'], await originals(supabase, rows));
    if (hit) return hit;
  }
  return null;
}

// Known correspondent + same property, recent, and only one such decision.
async function findDecidedByEmailAndAddress(supabase, { communityId, emails = [], address, withinDays = 60, now = Date.now() }) {
  const target = normAddr(address); const known = emails.map(normEmail).filter(Boolean);
  if (!communityId || !target || !known.length) return null;
  const since = new Date(now - withinDays * 86400000).toISOString();
  const rows = await select(supabase, (q) => q.eq('community_id', communityId).eq('status', 'decided').gte('decided_at', since).order('decided_at', { ascending: false }).limit(200));
  const hits = rows.filter((r) => {
    const a = normAddr(r.homeowner_address);
    const own = [r.submitter_email, ...(r.correspondent_emails || [])].map(normEmail).filter(Boolean);
    return a && (a === target || a.includes(target) || target.includes(a)) && known.some((e) => own.includes(e));
  });
  return hits.length === 1 ? { decided: hits[0], matched_by: ['email', 'address'] } : null;
}

module.exports = { isSystemMail, REF_RE, refsIn, referenceOf, threadKey, pick, findCaseByReferenceOrThread, findDecidedByEmailAndAddress };
