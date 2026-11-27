// ============================================================================
// lib/authorization/arc_acc.js  (Ed 2026-11-26: ARC/ACC in the Owner Authorization Service)
// ----------------------------------------------------------------------------
// The ARC/ACC adapter of the ONE Owner Authorization Service (lib/authorization,
// migrations 554-556, 566, 577, 582). Not a separate approval system: the same
// owner_authorizations request, Tessa's request email, the verified reply from the
// owner's own mailbox, the permanent evidence and the authorization_events ledger.
//
//   request   One numbered package: builder lot decisions, resident ACC decisions,
//             requests for information and the correspondence that carries them.
//             Every item names its target, action, executing teammate and a
//             fingerprint of exactly what the owner reviewed (decision, conditions,
//             letter or message text, recipients).
//   authorize The owner replies "approved", or "approved except 3, 7". A change
//             ("change 4: ...") authorizes nothing: Annie revises and Tessa sends a
//             new request.
//   execute   Each item through its module's own path, never around it:
//               builder_decision  api/builder_applications finalizeApplicationCore
//               acc_decision /    server.js _accFinalizeHandler (the ACC send path:
//               acc_info_request  decision authority, sealed letter, finalization)
//               correspondence    api/email_drafts sendHandler (reviewed-version
//                                 fingerprint, one-reply guard, delivery window)
//             The decision is the owner's, "authorized by email reply, owner
//             authorization X; executed by <teammate>"; never an in-app approval.
//   recheck   Immediately before any email: the target is unchanged (fingerprint),
//             nothing was sent to that recipient since the request (trustEd's record
//             and the shared mailboxes' Sent Items), and the recipient has not
//             written again. Otherwise it is not sent and Amanda follows up.
//   verify    Amanda checks every item against the records, opens a follow-up for
//             anything outstanding, and reports once to the owner.
//
// The modules register their executors at boot (registerExecutor); nothing here
// reaches a module any other way. Chat messages and API calls never authorize.
// ============================================================================

const crypto = require('crypto');
const P = require('./policy');

const SCOPE = 'arc_acc_decisions';
const ACTIONS = ['builder_decision', 'acc_decision', 'acc_info_request', 'correspondence'];
const PHASE = { builder_decision: 1, acc_decision: 2, acc_info_request: 2, correspondence: 3 };
const EXECUTORS = {};
function registerExecutor(name, impl) { EXECUTORS[name] = impl; }
function executor(name) {
  const e = EXECUTORS[name];
  if (!e) throw Object.assign(new Error(`the ${name} executor is not registered in this process`), { code: 'executor_missing' });
  return e;
}

// Raw bytes for a Buffer (a file's fingerprint), JSON for a structure.
const sha = (v) => crypto.createHash('sha256').update(Buffer.isBuffer(v) || typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const pick = (row, keys) => Object.fromEntries(keys.filter((k) => row && row[k] !== undefined).map((k) => [k, row[k]]));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lower = (s) => String(s || '').trim().toLowerCase();

// ---- fingerprints: exactly what the owner reviewed --------------------------------------
const BUILDER_KEYS = ['id', 'status', 'reference_number', 'street_address', 'lot_number', 'block_number', 'section_number', 'plan_number', 'plan_name',
  'elevation', 'elevation_orientation', 'application_data', 'master_plan_id', 'decided_at'];
function builderFingerprint(app, item) {
  return sha({ app: pick(app, BUILDER_KEYS), decision: item.decision, conditions: item.conditions || [] });
}
const ACC_KEYS = ['id', 'status', 'letter_body', 'submitter_email', 'last_document_added_at', 'acknowledged_at', 'decision_record'];
function accFingerprint(dec, item) {
  return sha({ dec: pick(dec, ACC_KEYS), decision_type: item.decision_type, deliver: item.deliver, to: lower(item.to_email), decision_record: item.decision_record || null });
}
// The message as reviewed, without the decision letters the execution attaches.
function draftBase(d) { return { ...d, attachments: (Array.isArray(d.attachments) ? d.attachments : []).filter((a) => a && !a.authorization_letter) }; }
function draftFingerprint(d, item) {
  const RG = require('../email/reply_guard');
  return sha({ package: RG.packageHash(draftBase(d)), attach_letters_of: item.attach_letters_of || [], depends_on: item.depends_on || [] });
}

// ---- targets -----------------------------------------------------------------------------
const TABLE = { builder_decision: 'builder_applications', acc_decision: 'acc_decisions', acc_info_request: 'acc_decisions', correspondence: 'outbound_email_drafts' };
const TARGET_TYPE = { builder_decision: 'builder_application', acc_decision: 'acc_decision', acc_info_request: 'acc_decision', correspondence: 'outbound_email_draft' };
async function loadTarget(supabase, item) {
  const { data, error } = await supabase.from(TABLE[item.action]).select('*').eq('id', item.target_id).maybeSingle();
  if (error) throw new Error(`${item.action} ${item.target_id}: ${error.message}`);
  return data;
}
function fingerprintOf(item, target) {
  if (item.action === 'builder_decision') return builderFingerprint(target, item);
  if (item.action === 'correspondence') return draftFingerprint(target, item);
  return accFingerprint(target, item);
}

// ---- the package ---------------------------------------------------------------------------
// spec item: { action, target_id, executor ('annie' | 'miranda'), title, basis, recommendation?,
//   builder_decision: decision ('approve' | 'approve_with_conditions'), conditions[]
//   acc_*:            decision_type, deliver ('email' | 'mail'), to_email, decision_record?, withdraw_drafts[], mail_to?
//   correspondence:   attach_letters_of[], depends_on[], info_request_for[], letters_close_for[], withdraw_drafts[] }
// Items are numbered in the order given. Problems stop the request (nothing is sent).
async function buildPackage(supabase, spec, { preflight = true } = {}) {
  const items = []; const problems = []; const shown = [];
  for (let k = 0; k < spec.length; k++) {
    const s = spec[k]; const n = k + 1;
    if (!ACTIONS.includes(s.action)) { problems.push(`${n}: unknown action ${s.action}`); continue; }
    const t = await loadTarget(supabase, s);
    if (!t) { problems.push(`${n}: ${s.title || s.target_id} not found`); continue; }
    const teammate = P.TEAMMATES[s.executor];
    if (!teammate) { problems.push(`${n}: unknown teammate ${s.executor}`); continue; }
    const item = {
      n, action: s.action, target_type: TARGET_TYPE[s.action], target_id: s.target_id, executor: teammate.id,
      community_id: t.community_id || null, reference: t.reference_number || null, title: s.title, basis: s.basis || null,
      ...(s.action === 'builder_decision' ? { decision: s.decision, conditions: s.conditions || [] } : {}),
      ...(s.action === 'acc_decision' || s.action === 'acc_info_request' ? { decision_type: s.decision_type, deliver: s.deliver, to_email: s.deliver === 'email' ? lower(s.to_email || t.submitter_email) : null,
        decision_record: s.decision_record || null, withdraw_drafts: s.withdraw_drafts || [], mail_to: s.mail_to || null, associate_with: s.associate_with || null } : {}),
      ...(s.action === 'correspondence' ? { to_email: lower(t.to_email), attach_letters_of: s.attach_letters_of || [], depends_on: s.depends_on || [],
        info_request_for: s.info_request_for || [], letters_close_for: s.letters_close_for || [], withdraw_drafts: s.withdraw_drafts || [] } : {}),
    };
    // Shape and state checks (the module's own checks run again at execution).
    if (s.action === 'builder_decision') {
      if (!['approve', 'approve_with_conditions'].includes(item.decision)) problems.push(`${n}: builder decision must be approve or approve with conditions`);
      if (item.decision === 'approve_with_conditions' && !item.conditions.length) problems.push(`${n}: conditions are required`);
      if (String(t.status || '').startsWith('approved') || t.status === 'denied') problems.push(`${n}: ${t.reference_number} is already ${t.status}`);
      if (preflight && EXECUTORS.builder && EXECUTORS.builder.validate) {
        const v = await EXECUTORS.builder.validate(t.id);
        if (!v.ok) problems.push(`${n}: ${t.reference_number} cannot carry an approval letter: ${(v.errors || []).join('; ')}`);
      }
    } else if (s.action === 'correspondence') {
      if (t.status !== 'draft') problems.push(`${n}: message is ${t.status}, not an unsent draft`);
      if (!t.to_email) problems.push(`${n}: message has no recipient`);
      for (const d of [...item.attach_letters_of, ...item.depends_on]) if (!(d >= 1 && d < n)) problems.push(`${n}: depends on item ${d}, which must come before it`);
    } else {
      if (!['pending_review', 'awaiting_info'].includes(t.status)) problems.push(`${n}: ${t.reference_number} is ${t.status}`);
      if (!String(t.letter_body || '').trim()) problems.push(`${n}: ${t.reference_number} has no letter`);
      if (item.deliver === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(item.to_email || '')) problems.push(`${n}: ${t.reference_number} has no valid email; deliver by mail`);
      if (!['email', 'mail'].includes(item.deliver)) problems.push(`${n}: deliver must be email or mail`);
      if (s.action === 'acc_info_request' && item.decision_type !== 'request_more_info') problems.push(`${n}: an information request has decision type request_more_info`);
      if (s.action === 'acc_decision' && !['approved', 'approved_with_conditions'].includes(item.decision_type)) problems.push(`${n}: only approvals are carried by this package; a denial is decided in the app`);
      if (preflight && EXECUTORS.acc && EXECUTORS.acc.preflight) {
        const pf = await EXECUTORS.acc.preflight(t.id, accBody(item, t), preflightActor());
        if (!pf.ok) problems.push(`${n}: ${t.reference_number}: ${pf.error}`);
        else if (pf.final) item.decided_by = pf.decided_by || (item.decision_record && item.decision_record.decided_by) || null;
      }
    }
    item.fingerprint = fingerprintOf(item, t);
    items.push(item);
    shown.push({ item, target: t, spec: s });
  }
  // One email per recipient: two items emailing the same person would cross (and the second would
  // see the first as prior contact). Combine them into one message first.
  const byTo = {};
  for (const i of items) if (i.to_email && (i.action === 'correspondence' || i.deliver === 'email')) (byTo[i.to_email] = byTo[i.to_email] || []).push(i.n);
  for (const [to, ns] of Object.entries(byTo)) if (ns.length > 1) problems.push(`items ${ns.join(', ')} all email ${to.replace(/^[^@]+/, '…')}; combine them into one message`);
  const tier = items.some((i) => /den/.test(i.decision_type || '')) ? 2 : 1;
  return { ok: !problems.length, problems, items, shown, tier };
}

// The ACC finalize body for an item (the same body a person's Send would carry).
function accBody(item, dec) {
  return {
    decision_type: item.decision_type, body_text: dec.letter_body, send: item.deliver === 'email',
    to_email: item.deliver === 'email' ? item.to_email : undefined,
    // The owner reviewed this exact letter (fingerprinted), so it is the reviewed letter.
    acknowledge_stale: true,
    ...(item.decision_record ? { decision_record: item.decision_record } : {}),
  };
}

// ---- the request email ----------------------------------------------------------------------
const GROUP = { builder_decision: 'Builder lot decisions', acc_decision: 'Resident application decisions', acc_info_request: 'Requests for information', correspondence: 'Correspondence' };
const DECIDED_BY = { ed: 'your decision', annie: "Annie's decision under the association's written delegation, released by your authorization", committee: "the Architectural Committee's decision", board: "the Board's decision" };
function decisionLabel(i) {
  if (i.action === 'builder_decision') return i.decision === 'approve' ? 'Approve' : 'Approve with conditions';
  if (i.action === 'acc_decision') return `${i.decision_type === 'approved' ? 'Approve' : 'Approve with conditions'}; ${DECIDED_BY[i.decided_by] || 'decision'}; ${i.deliver === 'email' ? 'emailed by Annie' : 'mailed'}`;
  if (i.action === 'acc_info_request') return `Request for information; ${i.deliver === 'email' ? 'emailed by Annie' : 'mailed'}`;
  return 'Send';
}
function teammateName(id) { const t = Object.values(P.TEAMMATES).find((x) => x.id === id); return t ? t.label.split(' (')[0] : id; }

function renderRequest({ subject, shown, expiresAt }) {
  const blocks = []; let last = null;
  const text = []; let lastT = null;
  for (const { item: i, target: t, spec: s } of shown) {
    const g = GROUP[i.action];
    if (g !== last) { blocks.push(`<h3 style="margin:22px 0 6px;font-size:15px;border-bottom:2px solid #D4AF37">${esc(g)}</h3>`); last = g; }
    if (g !== lastT) { text.push('', g.toUpperCase()); lastT = g; }
    const letter = i.action === 'correspondence' ? t.body_text : (i.action === 'builder_decision' ? null : t.letter_body);
    const conds = (i.conditions || []).length ? i.conditions : null;
    const after = [];
    if (i.action === 'correspondence') {
      if ((i.attach_letters_of || []).length) after.push(`Attaches the decision letters of items ${i.attach_letters_of.join(', ')}.`);
      if ((i.depends_on || []).length) after.push(`Goes only if items ${i.depends_on.join(', ')} are carried out as listed; otherwise Annie revises it for you.`);
    }
    if ((i.withdraw_drafts || []).length) after.push(`Withdraws ${i.withdraw_drafts.length} earlier unsent draft${i.withdraw_drafts.length === 1 ? '' : 's'} it replaces.`);
    if (i.associate_with) after.push(`Files the documents on this case as supporting documents of ${i.associate_with.label}; that sealed decision is not changed.`);
    if (i.deliver === 'mail') after.push(`Letter filed on the case; staff print and mail it${i.mail_to ? ' to ' + i.mail_to : ''}; Amanda confirms it was mailed.`);
    blocks.push(`<div style="border:1px solid #d9dee7;border-radius:6px;padding:10px 12px;margin:8px 0">
      <div style="font-weight:bold">${i.n}. ${esc(i.title)}</div>
      <div style="font-size:13px;color:#475569">${esc(decisionLabel(i))} · executed by ${esc(teammateName(i.executor))}${i.to_email ? ' · to ' + esc(i.to_email.replace(/^[^@]+/, (m) => m.slice(0, 2) + '…')) : ''}</div>
      ${i.basis ? `<div style="font-size:13px;margin-top:4px"><b>Basis:</b> ${esc(i.basis)}</div>` : ''}
      ${s.recommendation ? `<div style="font-size:13px;margin-top:4px"><b>Recommendation:</b> ${esc(s.recommendation)}</div>` : ''}
      ${conds ? `<div style="font-size:13px;margin-top:4px;background:#fff7e6;padding:6px"><b>Condition${conds.length === 1 ? '' : 's'}:</b> ${conds.map(esc).join('<br>')}</div>` : ''}
      ${after.length ? `<div style="font-size:12px;color:#475569;margin-top:4px">${after.map(esc).join(' ')}</div>` : ''}
      ${letter ? `<div style="font-family:Georgia,serif;font-size:13px;white-space:pre-wrap;background:#fafafa;border-left:3px solid #1E2761;padding:8px;margin-top:6px">${esc(letter)}</div>` : ''}
    </div>`);
    text.push(`${i.n}. ${i.title}`, `   ${decisionLabel(i)}; executed by ${teammateName(i.executor)}`, ...(i.basis ? [`   Basis: ${i.basis}`] : []), ...(conds ? conds.map((c) => `   Condition: ${c}`) : []), ...after.map((a) => `   ${a}`), ...(letter ? ['   ---', ...String(letter).split('\n').map((l) => '   ' + l), '   ---'] : []));
  }
  const how = [
    'Reply "approved" to authorize every item below exactly as written.',
    'To leave items out, reply for example "approved except 3 and 7". Those items are not carried out; anything that depends on them is held and revised for you.',
    'To change an item, reply with the change (for example "change 4: ..."). Nothing is carried out; Annie revises the package and Tessa sends you a new request.',
    'Annie and Miranda carry out the items. Immediately before each email, they check it has not already been sent or superseded and that the recipient has not written again; if so it is not sent. Amanda verifies every item, follows up on anything outstanding and reports back to you once.',
    `Reply anything else, or nothing, and nothing happens. This request expires ${expiresAt}.`,
  ];
  const html = `<p>Ed,</p><p>Annie and Amanda have prepared <b>${shown.length}</b> architectural items for your decision. Each was rechecked today against the full correspondence history, earlier decisions and duplicates; only what genuinely needs action is listed.</p>`
    + `<ul style="font-size:14px">${how.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>${blocks.join('')}<p>Tessa</p>`;
  return { subject, html, text: ['Ed,', '', ...how, ...text, '', 'Tessa'].join('\n') };
}

function requestSubject(code, items) {
  const by = {}; for (const i of items) by[i.action] = (by[i.action] || 0) + 1;
  const parts = [by.builder_decision && `${by.builder_decision} builder`, (by.acc_decision || by.acc_info_request) && `${(by.acc_decision || 0) + (by.acc_info_request || 0)} resident`, by.correspondence && `${by.correspondence} correspondence`].filter(Boolean);
  return `Owner authorization ${code}: ${items.length} architectural items (${parts.join(', ')})`;
}

// Create the request (database checks every target is open), email it from Tessa, record its identity.
async function requestPackage({ supabase, rpc, send, spec, ownerEmail, fromMailbox, summary, hours = 168, requestedBy = P.TEAMMATES.annie.id }) {
  const pkg = await buildPackage(supabase, spec);
  if (!pkg.ok) throw Object.assign(new Error('not requested; fix first: ' + pkg.problems.join(' | ')), { code: 'verification_failed', problems: pkg.problems });
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  const subject = requestSubject(code, pkg.items);
  const r = await rpc('owner_authorization_request_arc_acc', { p_subject: subject, p_summary: summary, p_items: pkg.items, p_owner_email: ownerEmail, p_requested_by: requestedBy, p_coordinator: P.COORDINATOR, p_tier: pkg.tier, p_hours: hours });
  const expiresAt = new Date(Date.now() + hours * 3600e3).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' Central';
  const mail = renderRequest({ subject, shown: pkg.shown, expiresAt });
  const sent = await send({ from: fromMailbox, to: ownerEmail, subject: mail.subject, text: mail.text, html: mail.html });
  if (!sent || !sent.internetMessageId || !sent.conversationId) throw new Error('the request email was not sent with a message identity; nothing can authorize it');
  await rpc('owner_authorization_sent', { p_id: r.id, p_message_id: sent.internetMessageId, p_conversation_id: sent.conversationId });
  const AZ = require('./events');
  await AZ.recordEvents(supabase, pkg.items.flatMap((i) => ['requested', 'sent'].map((event) => ({ community_id: i.community_id, authority_kind: 'request', authorization_id: r.id,
    action_type: 'arc_acc_decision', target_id: i.target_id, fingerprint: i.fingerprint, event, channel: 'email', requested_by: requestedBy,
    evidence: event === 'sent' ? { subject, n: i.n, request_message_id: sent.internetMessageId } : { n: i.n, action: i.action, title: i.title } }))));
  await caseEvents(supabase, pkg.items, 'updated', (i) => ({ owner_authorization: r.id, n: i.n, requested: true, subject }));
  return { id: r.id, subject, items: pkg.items.length, items_sha256: r.items_sha256 };
}

// ---- the owner's reply -------------------------------------------------------------------------
// PURE. { kind: 'approve', excluded: [n] } | { kind: 'changes', note } | { kind: 'decline' } | { kind: 'unclear', why }
const EXCLUDE_RE = /\b(?:except(?:\s+for)?|excluding|exclude|but\s+not|other\s+than|without|leave\s+out|leaving\s+out|hold(?:\s+back)?|skip|minus)\b\s*((?:(?:items?|numbers?|nos?\.?|#)\s*)?#?\d{1,5}(?:\s*(?:,|&|and|or|\+|\/)?\s*(?:(?:items?|nos?\.?|#)\s*)?#?\d{1,5})*)/gi;
const CHANGE_RE = /\b(change|modify|revise|reword|edit|update|instead|replace|correct|amend|fix)\b/i;
const DECLINE_RE = /\b(not|don'?t|do\s+not|no)\s+approv|\breject|\bdeclin|\bdo\s+not\s+(send|proceed)|\bdon'?t\s+(send|proceed)/i;
function parseReply(replyText, items = []) {
  const t = String(replyText || '').replace(/\r/g, '').trim();
  if (DECLINE_RE.test(t)) return { kind: 'decline' };
  const approves = /\bapprov(e|ed|al)\b/i.test(t);
  const excluded = new Set(); const unresolved = [];
  let stripped = t;
  for (const m of t.matchAll(EXCLUDE_RE)) {
    stripped = stripped.replace(m[0], ' ');
    for (const numStr of m[1].match(/\d{1,5}/g) || []) {
      const v = Number(numStr);
      if (v >= 1 && v <= items.length) { excluded.add(v); continue; }
      // A street number ("except 8011"): the one item whose title starts with it.
      const hits = items.filter((i) => new RegExp(`(^|\\D)${v}(\\D|$)`).test(String(i.title || '').split(/[·(]/)[0]));
      if (hits.length === 1) excluded.add(hits[0].n); else unresolved.push(numStr);
    }
  }
  if (CHANGE_RE.test(stripped)) return { kind: 'changes', note: t.slice(0, 2000) };
  if (!approves) return /\b(wait|stop|hold)\b/i.test(t) ? { kind: 'decline' } : { kind: 'unclear', why: 'the reply does not say approved' };
  if (unresolved.length) return { kind: 'unclear', why: `could not tell which item ${unresolved.join(', ')} means` };
  if (/\b(wait|stop)\b/i.test(stripped)) return { kind: 'unclear', why: 'the reply says approved but also wait or stop' };
  const list = [...excluded].sort((a, b) => a - b);
  if (items.length && list.length >= items.length) return { kind: 'decline' };
  return { kind: 'approve', excluded: list };
}

// ---- execution -------------------------------------------------------------------------------
// The owner, as authorized by the verified reply; set only here, in-process, from the database.
async function ownerActor(supabase, authorization, executedBy) {
  const DA = require('../acc/decision_authority');
  // 'executed' = reported, with any outstanding item on Amanda's follow-up; finishing that item is
  // still the owner's authorized work (Ed 2026-11-27), never a new decision.
  if (!authorization || authorization.scope !== SCOPE || !['authorized', 'executed'].includes(authorization.status)) throw new Error('not an authorized ARC/ACC owner authorization');
  if (Date.now() > Date.parse(authorization.expires_at)) throw new Error('the owner authorization expired');
  if (lower(authorization.authorized_by_email) !== DA.OWNER_EMAIL) throw new Error('the authorization is not the owner\'s');
  const { data: prof, error } = await supabase.from('user_profiles').select('id, email, full_name, role, is_active').eq('id', authorization.authorized_by_user_id).maybeSingle();
  if (error) throw new Error(`owner profile: ${error.message}`);
  if (!prof || lower(prof.email) !== DA.OWNER_EMAIL) throw new Error('the owner profile does not match the authorization');
  const actor = { ...prof, via: { channel: 'owner_authorization', authorization_id: authorization.id, authorized_at: authorization.authorized_at,
    evidence_message_id: authorization.evidence && authorization.evidence.internet_message_id, executed_by: executedBy } };
  if (!DA.isOwnerActor(actor)) throw new Error('the owner profile is not an active owner account');
  return actor;
}
// For checks only (no write): the owner's identity shape, with no authorization.
function preflightActor() {
  const DA = require('../acc/decision_authority');
  return { id: 'preflight', email: DA.OWNER_EMAIL, full_name: 'Ed Gojara', role: 'admin', is_active: true, via: { channel: 'preflight' } };
}
function approverLabel(actor) {
  return `${actor.full_name || actor.email} (authorized by email reply, owner authorization ${String(actor.via.authorization_id).slice(0, 8)}; executed by ${teammateName(actor.via.executed_by)})`;
}

// Was anything sent to this recipient (or about this case) since the request, or did they write again?
async function priorContact(supabase, { to, since, caseRef = null, sentItems = null }) {
  const found = [];
  if (to) {
    const { data: out, error } = await supabase.from('email_messages').select('id, received_at, mailbox, subject, recipients').eq('direction', 'outbound').gte('received_at', since).limit(1000);
    // Fail closed: a capped read cannot prove nothing was sent.
    if (!error && (out || []).length >= 1000) throw new Error('too much outbound mail since the request to check it completely; not sent');
    if (error) throw new Error(`sent-mail check: ${error.message}`);
    for (const m of out || []) if ((m.recipients || []).some((r) => lower(r) === to)) found.push(`emailed ${String(m.received_at).slice(0, 16)} from ${m.mailbox}: "${String(m.subject || '').slice(0, 80)}"`);
    const { data: dq, error: dErr } = await supabase.from('outbound_email_drafts').select('id, sent_at, subject, to_email').eq('status', 'sent').gte('sent_at', since).ilike('to_email', `%${to}%`).limit(50);
    if (dErr) throw new Error(`draft-queue check: ${dErr.message}`);
    for (const d of dq || []) found.push(`sent from the Draft Queue ${String(d.sent_at).slice(0, 16)}: "${String(d.subject || '').slice(0, 80)}"`);
    const { data: inb, error: iErr } = await supabase.from('email_messages').select('received_at, subject').eq('direction', 'inbound').ilike('sender_email', to).gte('received_at', since).limit(20);
    if (iErr) throw new Error(`new-mail check: ${iErr.message}`);
    for (const m of inb || []) found.push(`the recipient wrote again ${String(m.received_at).slice(0, 16)}: "${String(m.subject || '').slice(0, 80)}"; answer both together`);
    if (sentItems) for (const s of await sentItems(to, since)) found.push(`in ${s.mailbox} Sent Items ${String(s.sent_at).slice(0, 16)}: "${String(s.subject || '').slice(0, 80)}"`);
  }
  if (caseRef) {
    const { data: fins, error: fErr } = await supabase.from('acc_finalizations').select('finalized_at, decision_type').eq('acc_decision_id', caseRef).gte('finalized_at', since).limit(5);
    if (fErr && !/does not exist/i.test(fErr.message)) throw new Error(`finalization check: ${fErr.message}`);
    for (const f of fins || []) found.push(`a ${f.decision_type} was already finalized ${String(f.finalized_at).slice(0, 16)}`);
  }
  return [...new Set(found)];
}

// Microsoft 365 Sent Items of the shared mailboxes (read-only), for the recheck.
const SENT_MAILBOXES = () => { const g = require('../email/graph_send'); return [g.INFO_MAILBOX || 'info@bedrocktx.com', g.ANNIE_MAILBOX, g.MIRANDA_MAILBOX, g.CLAIRE_MAILBOX, g.AMANDA_MAILBOX, 'violations@bedrocktx.com'].filter(Boolean); };
async function graphSentItems(to, since) {
  const g = require('../email/graph_send');
  if (!g.isConfigured()) return [];
  const tok = await g.getToken(); const out = [];
  for (const box of [...new Set(SENT_MAILBOXES().map(lower))]) {
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(box)}/mailFolders/SentItems/messages?$search=${encodeURIComponent(`"to:${to}"`)}&$select=subject,sentDateTime,toRecipients&$top=25`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, ConsistencyLevel: 'eventual' } });
    if (!r.ok) throw new Error(`Sent Items of ${box} could not be checked (${r.status})`);
    const j = await r.json();
    for (const m of j.value || []) if (m.sentDateTime >= since && (m.toRecipients || []).some((x) => lower(x.emailAddress && x.emailAddress.address) === to)) out.push({ mailbox: box, sent_at: m.sentDateTime, subject: m.subject });
  }
  return out;
}

async function withdrawDrafts(supabase, ids, reason) {
  if (!ids || !ids.length) return 0;
  const { data, error } = await supabase.from('outbound_email_drafts').update({ status: 'discarded', disposition_reason: reason }).in('id', ids).eq('status', 'draft').select('id');
  if (error) throw new Error(`withdrawing superseded drafts: ${error.message}`);
  return (data || []).length;
}

// Work-item ledger on the case (acc:<id> / builder_arc:<id>), best effort but loud.
function caseRef(i) { return i.action === 'builder_decision' ? `builder_arc:${i.target_id}` : (i.action === 'correspondence' ? null : `acc:${i.target_id}`); }
async function caseEvents(supabase, items, ev, detailOf) {
  for (const i of items) {
    const refs = [caseRef(i), ...((i.letters_close_for || []).map((id) => `builder_arc:${id}`))].filter(Boolean);
    for (const ref of refs) {
      const { data, error } = await supabase.from('work_items').select('id').eq('source_ref', ref).not('status', 'in', '(done,dismissed)').limit(1);
      if (error) { console.warn(`[arc_acc] work item lookup ${ref}: ${error.message}`); continue; }
      if (!data || !data.length) continue;
      const { error: e2 } = await supabase.from('work_item_events').insert({ work_item_id: data[0].id, event: ev, actor: 'ai-team:amanda', detail: detailOf(i) });
      if (e2) console.warn(`[arc_acc] work item event ${ref}: ${e2.message}`);
    }
  }
}
// A follow-up for Amanda (or staff) on its own work item, once per authorization item.
async function followUp(supabase, authorization, item, { title, next_step, assigned_to = 'Amanda', why }) {
  const ref = `owner_authorization:${authorization.id}:${item.n}`;
  const { data: open, error } = await supabase.from('work_items').select('id').eq('source_ref', ref).limit(1);
  if (error) { console.error(`[arc_acc] follow-up lookup ${ref}: ${error.message}`); return null; }
  if (open && open.length) return open[0].id;
  const { data, error: e2 } = await supabase.from('work_items').insert({
    community_id: item.community_id || null, source_type: 'acc', item_type: 'owner_authorization_follow_up', workspace: 'operations', module_key: 'acc', horizon: 'now',
    title, summary: `Owner authorization ${String(authorization.id).slice(0, 8)}, item ${item.n}: ${item.title}`, assigned_to, urgency: 'high', status: 'new',
    source_ref: ref, requested_by: 'Owner authorization', why, next_step, record_ownership: 'workpaper', created_by: 'ai-team:amanda',
  }).select('id').single();
  if (e2) { console.error(`[arc_acc] follow-up not opened for ${ref}: ${e2.message}`); return null; }
  return data.id;
}

const HANDLERS = {
  async builder_decision(ctx, a, item, actor) {
    const t = await loadTarget(ctx.supabase, item);
    if (!t) return { status: 'failed', detail: 'application not found' };
    if (builderFingerprint(t, item) !== item.fingerprint) return { status: 'failed', detail: 'the application changed after you reviewed it; not decided' };
    const out = await executor('builder').finalize({ applicationId: t.id, action: item.decision, conditions: item.decision === 'approve_with_conditions' ? item.conditions : null, decided_by: approverLabel(actor), promote_to_precedent: true });
    return { status: 'done', detail: `${t.reference_number} ${item.decision === 'approve' ? 'approved' : 'approved with conditions'}; letter dated today`, response_id: out && out.response && out.response.id, application_id: t.id };
  },
  async acc_decision(ctx, a, item, actor) { return accItem(ctx, a, item, actor); },
  async acc_info_request(ctx, a, item, actor) { return accItem(ctx, a, item, actor); },
  async correspondence(ctx, a, item, actor, state) {
    const blocked = (item.depends_on || []).filter((d) => !state[d] || state[d].status !== 'done');
    if (blocked.length) return { status: 'held', detail: `not sent: item${blocked.length === 1 ? '' : 's'} ${blocked.join(', ')} ${blocked.length === 1 ? 'was' : 'were'} not carried out as listed, so this message would not match what was issued; Annie revises it for you` };
    const d = await loadTarget(ctx.supabase, item);
    if (!d || d.status !== 'draft') return { status: 'failed', detail: `the message is ${d ? d.status : 'gone'}; not sent` };
    if (draftFingerprint(d, item) !== item.fingerprint) return { status: 'failed', detail: 'the message changed after you reviewed it; not sent', retryable: false };
    const prior = await priorContact(ctx.supabase, { to: item.to_email, since: a.requested_at, sentItems: ctx.sentItems });
    if (prior.length) return { status: 'superseded', detail: `not sent: ${prior.join('; ')}` };
    // The decision letters of the items it carries, as issued today.
    const letters = [];
    for (const k of item.attach_letters_of || []) {
      const s = state[k];
      const env = await executor('builder').envelope(s.application_id, s.response_id);
      const path = `email_outbound_attachments/${d.id}/${env.filename}`;
      const up = await ctx.supabase.storage.from('documents').upload(path, env.pdfBuffer, { contentType: 'application/pdf', upsert: true });
      if (up && up.error) return { status: 'failed', detail: `the letter for item ${k} could not be attached (${up.error.message}); not sent` };
      letters.push({ storage_path: path, name: env.filename, mime: 'application/pdf', sha256: sha(env.pdfBuffer), size: env.pdfBuffer.length, authorization_letter: true, item: k });
    }
    const policy = { ...(d.policy || {}), owner_authorization: { authorization_id: a.id, n: item.n, letters_close_for: item.letters_close_for || [], info_request_for: item.info_request_for || [], withdraw_drafts: item.withdraw_drafts || [],
      letter_responses: letters.map((l) => ({ item: l.item, application_id: state[l.item].application_id, response_id: state[l.item].response_id })) } };
    const next = { ...d, attachments: [...draftBase(d).attachments, ...letters], policy };
    const { error } = await ctx.supabase.from('outbound_email_drafts').update({ attachments: next.attachments, policy }).eq('id', d.id).eq('status', 'draft');
    if (error) return { status: 'failed', detail: `could not attach the letters: ${error.message}; not sent` };
    const RG = require('../email/reply_guard');
    const r = await executor('draft').send(d.id, { id: actor.id, email: actor.email, full_name: actor.full_name, is_active: true, via: actor.via }, RG.packageHash(next));
    if (r.status === 202) return { status: 'scheduled', detail: `approved; goes out at ${r.json && r.json.send_at ? new Date(r.json.send_at).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }) + ' Central' : 'the end of the delivery window'} unless the recipient writes again first` };
    // Sent now: the Draft Queue send already recorded it (afterDraftSent).
    if (r.status === 200) return { status: 'done', recorded: true, detail: `sent to ${r.json && r.json.to}` };
    return { status: 'failed', detail: `not sent: ${(r.json && (r.json.message || r.json.error)) || 'status ' + r.status}` };
  },
};

async function accItem(ctx, a, item, actor) {
  const t = await loadTarget(ctx.supabase, item);
  if (!t) return { status: 'failed', detail: 'case not found' };
  // A retry after a failed attempt under THIS authorization: that attempt may already have written
  // its decision record (issued_by.via names this authorization). That is our own write, not a change
  // to what the owner reviewed; anything else that changed still stops the item.
  const ownRecord = t.decision_record && t.decision_record.issued_by && t.decision_record.issued_by.via && t.decision_record.issued_by.via.authorization_id === a.id;
  const same = accFingerprint(t, item) === item.fingerprint || (ownRecord && accFingerprint({ ...t, decision_record: null }, item) === item.fingerprint);
  if (!same) return { status: 'failed', detail: 'the case or its letter changed after you reviewed it; nothing was sent', retryable: false };
  if (item.deliver === 'email') {
    const prior = await priorContact(ctx.supabase, { to: item.to_email, since: a.requested_at, caseRef: t.id, sentItems: ctx.sentItems });
    if (prior.length) return { status: 'superseded', detail: `not sent: ${prior.join('; ')}` };
  }
  const r = await executor('acc').finalize(t.id, accBody(item, t), actor);
  if (r.status !== 200) return { status: 'failed', detail: `not issued: ${(r.json && r.json.error) || 'status ' + r.status}`, retryable: r.status >= 500 || RETRYABLE.test(String((r.json && r.json.error) || '')) };
  if (item.associate_with) await caseEvents(ctx.supabase, [item], 'updated', () => ({ supporting_documents_for: item.associate_with.decision_id, label: item.associate_with.label, owner_authorization: a.id }));
  const withdrawn = await withdrawDrafts(ctx.supabase, item.withdraw_drafts, `Replaced by ${t.reference_number} issued under owner authorization ${String(a.id).slice(0, 8)}`);
  if (item.deliver === 'mail') {
    await followUp(ctx.supabase, a, item, { assigned_to: 'Staff (print and mail)', title: `Print and mail: ${t.reference_number}`,
      why: `Ed authorized this letter (owner authorization ${String(a.id).slice(0, 8)}). There is no email on file, so it goes by mail.`,
      next_step: `Print the letter filed on ${t.reference_number} (ACC > Requests > ${t.reference_number} > Download letter PDF) and mail it${item.mail_to ? ' to ' + item.mail_to : ''}; mark this done when mailed. Amanda confirms.` });
  }
  const sent = r.json && r.json.email && r.json.email.sent;
  return { status: 'done', detail: `${t.reference_number}: ${item.action === 'acc_info_request' ? 'request for information' : 'decision'} ${item.deliver === 'email' ? (sent ? 'emailed' : 'recorded') : 'filed for mailing'}${withdrawn ? `; ${withdrawn} replaced draft${withdrawn === 1 ? '' : 's'} withdrawn` : ''}` };
}

// ---- durable execution --------------------------------------------------------------------
// An authorized package is carried out by ONE runner at a time, holds a lease on the work-item
// ledger (the open-source_ref unique index makes the lease atomic across workers), skips every
// item the ledger or the records already show done, and retries only system failures (at most
// MAX_ATTEMPTS). It resumes at every boot and in Amanda's scheduled oversight, so a restart or
// deployment never strands authorized work and never repeats it.
const MAX_ATTEMPTS = 3;
const LEASE_MS = 10 * 60000;
const RETRYABLE = /could not be (?:filed|sealed|attached|loaded|emailed)|upload failed|no longer matches the version|send failed|not_configured|executor is not registered|status 5\d\d|fetch failed|timeout|ECONN|socket|could not be checked/i;
function isRetryable(r) { return r.retryable === true || (r.retryable !== false && ['failed', 'held'].includes(r.status) && RETRYABLE.test(String(r.detail || ''))); }

async function takeLease(supabase, a, runner) {
  const ref = `owner_authorization_run:${a.id}`;
  const row = { source_type: 'acc', item_type: 'owner_authorization_run', workspace: 'operations', module_key: 'acc', horizon: 'now', status: 'in_progress', urgency: 'normal',
    title: `Carrying out owner authorization ${String(a.id).slice(0, 8)}`, summary: a.subject, assigned_to: 'Amanda', source_ref: ref, requested_by: 'Owner authorization',
    why: 'Ed authorized this package; Annie, Miranda and Amanda are carrying it out.', next_step: 'Amanda verifies every item and sends Ed the completion report.', record_ownership: 'workpaper', created_by: runner };
  const ins = await supabase.from('work_items').insert(row).select('id, updated_at').single();
  if (!ins.error) return { id: ins.data.id, retry: [] };
  if (!/23505|duplicate|unique/i.test(`${ins.error.code || ''} ${ins.error.message || ''}`)) throw new Error(`run lease: ${ins.error.message}`);
  const { data: cur, error } = await supabase.from('work_items').select('id, updated_at, status, notes').eq('source_ref', ref).in('status', ['in_progress', 'waiting', 'new']).maybeSingle();
  if (error) throw new Error(`run lease: ${error.message}`);
  if (!cur) return null;
  // A waiting lease (a scheduled message pending) or a runner that died mid-run: take it over, atomically.
  if (cur.status === 'in_progress' && Date.now() - Date.parse(cur.updated_at) < LEASE_MS) return null;   // another runner is working
  const { data: took, error: tErr } = await supabase.from('work_items').update({ status: 'in_progress', updated_at: new Date().toISOString(), created_by: runner }).eq('id', cur.id).eq('updated_at', cur.updated_at).select('id');
  if (tErr) throw new Error(`run lease: ${tErr.message}`);
  // Amanda's retry list (notes: {"retry": [n, ...]}): items to carry out again because the owner said to
  // complete them under this authorization after a failure that needed a fix. Consumed by this run.
  let retry = [];
  try { retry = (JSON.parse(cur.notes || '{}').retry || []).map(Number).filter((x) => x > 0); } catch (_) { retry = []; }
  return took && took.length ? { id: cur.id, retry } : null;
}
async function renewLease(supabase, lease) { if (lease) await supabase.from('work_items').update({ updated_at: new Date().toISOString() }).eq('id', lease.id); }
async function releaseLease(supabase, lease, done) {
  if (!lease) return;
  const { error } = await supabase.from('work_items').update(done ? { status: 'done', completed_at: new Date().toISOString() } : { status: 'waiting', next_step: 'Waiting for a scheduled message to go out, or for Amanda\'s follow-up.' }).eq('id', lease.id);
  if (error) console.error(`[arc_acc] run lease not released: ${error.message}`);
}

// The ledger's view of each item: last outcome, attempts.
async function ledgerState(supabase, a) {
  const { data: evs, error } = await supabase.from('authorization_events').select('event, target_id, result, occurred_at').eq('authorization_id', a.id).in('event', ['executed', 'execution_failed', 'declined']).order('occurred_at', { ascending: true });
  if (error) throw new Error(`ledger: ${error.message}`);
  const st = new Map();
  for (const e of evs || []) { const s = st.get(e.target_id) || { attempts: 0 }; s.last = e; if (e.event === 'execution_failed') s.attempts += 1; st.set(e.target_id, s); }
  return st;
}

// Carried out already (by an earlier run that stopped before recording it)? Never repeat it.
async function alreadyDone(supabase, a, item) {
  const since = a.authorized_at;
  if (item.action === 'builder_decision') {
    const { data: app } = await supabase.from('builder_applications').select('status').eq('id', item.target_id).maybeSingle();
    if (!app || !String(app.status).startsWith('approved')) return null;
    const { data: resp } = await supabase.from('builder_application_responses').select('id, decided_at').eq('application_id', item.target_id).gte('decided_at', since).order('decided_at', { ascending: false }).limit(1);
    return resp && resp.length ? { status: 'done', application_id: item.target_id, response_id: resp[0].id, detail: 'decided under this authorization' } : null;
  }
  if (item.action === 'correspondence') {
    const { data: d } = await supabase.from('outbound_email_drafts').select('status, sent_at, policy').eq('id', item.target_id).maybeSingle();
    if (d && d.status === 'sent') return { status: 'done', detail: `sent ${d.sent_at}` };
    if (d && d.status === 'draft' && d.policy && d.policy.scheduled_send && d.policy.owner_authorization) return { status: 'scheduled', detail: 'scheduled; goes out at the end of the delivery window' };
    return null;
  }
  const { data: dec } = await supabase.from('acc_decisions').select('status, decided_at').eq('id', item.target_id).maybeSingle();
  if (item.action === 'acc_decision' && dec && dec.status === 'decided' && dec.decided_at && dec.decided_at >= since) return { status: 'done', detail: 'decided under this authorization' };
  return null;
}

async function executePackage(ctx, authorization, { retry = [] } = {}) {
  const supabase = ctx.supabase;
  const runner = ctx.runner || `ai-team:amanda@${process.pid}`;
  const lease = await takeLease(supabase, authorization, runner);
  if (!lease) return { results: [], ok: true, summary: 'already being carried out by another worker', skipped: true };
  try {
    try { if (EXECUTORS.draft && EXECUTORS.draft.rearm) await EXECUTORS.draft.rearm(); } catch (e) { console.warn(`[arc_acc] re-arm of scheduled sends failed: ${e.message}`); }
    const excluded = new Set(((authorization.evidence || {}).excluded_items || []).map(Number));
    const forced = new Set([...retry, ...(lease.retry || [])].map(Number));
    if ((lease.retry || []).length) await supabase.from('work_items').update({ notes: null }).eq('id', lease.id);
    const ledger = await ledgerState(supabase, authorization);
    const items = [...(authorization.items || [])].sort((x, y) => (PHASE[x.action] - PHASE[y.action]) || (x.n - y.n));
    const state = {}; const results = [];
    for (const item of items) {
      await renewLease(supabase, lease);
      const L = ledger.get(item.target_id);
      let r;
      if (excluded.has(Number(item.n))) r = L ? { status: 'excluded', skip: true } : { status: 'excluded', detail: 'left out by you' };
      else if (L && L.last.event === 'executed') r = { ...((await alreadyDone(supabase, authorization, item)) || {}), status: 'done', skip: true };
      else if (L && L.last.event === 'execution_failed' && !forced.has(Number(item.n)) && !(isRetryable({ ...(L.last.result || {}) }) && L.attempts < MAX_ATTEMPTS)) r = { status: (L.last.result && L.last.result.status) || 'failed', skip: true };
      else {
        const done = await alreadyDone(supabase, authorization, item);
        if (done) r = { ...done, recorded: done.status === 'scheduled' };
        else {
          try { r = await HANDLERS[item.action](ctx, authorization, item, await ownerActor(supabase, authorization, item.executor), state); }
          catch (e) { r = { status: 'failed', detail: e.message, retryable: true }; }
        }
      }
      state[item.n] = r; results.push({ n: item.n, target_id: item.target_id, ok: ['done', 'scheduled', 'excluded'].includes(r.status), ...r });
    }
    results.sort((x, y) => x.n - y.n);
    await recordResults(supabase, authorization, results.filter((r) => !r.skip));
    if (authorization.status === 'executed') await reportUpdate(supabase, authorization, { send: ctx.sendReport || null });
    const pendingSends = results.some((r) => r.status === 'scheduled');
    await releaseLease(supabase, lease, !pendingSends);
    let report = null;
    try { report = await verifyAndReport(supabase, authorization.id, { send: ctx.sendReport || null }); } catch (e) { console.error(`[arc_acc] verification of ${authorization.id} failed: ${e.message}`); }
    return { results, ok: !results.some((r) => !r.ok), summary: summarize(results), report };
  } catch (e) { await releaseLease(supabase, lease, false); throw e; }
}
const summarize = (rs) => ['done', 'scheduled', 'excluded', 'held', 'superseded', 'failed'].map((s) => [s, rs.filter((r) => r.status === s).length]).filter(([, c]) => c).map(([s, c]) => `${c} ${s}`).join(', ');

// Every authorized ARC/ACC package with work left: resume it (boot, and Amanda's scheduled pass).
async function resumePending(supabase, { sentItems = null, now = new Date() } = {}) {
  const { data, error } = await supabase.from('owner_authorizations').select('*').eq('scope', SCOPE).eq('status', 'authorized').gte('expires_at', now.toISOString()).limit(50);
  if (error) throw new Error(`resume: ${error.message}`);
  // Reported packages with an outstanding item Amanda put on a retry list.
  const { data: lists, error: lErr } = await supabase.from('work_items').select('source_ref, notes').like('source_ref', 'owner_authorization_run:%').eq('status', 'waiting').not('notes', 'is', null).limit(50);
  if (lErr) throw new Error(`resume: ${lErr.message}`);
  const extra = (lists || []).map((w) => w.source_ref.split(':')[1]).filter((id) => !(data || []).some((a) => a.id === id));
  let more = [];
  if (extra.length) { const r2 = await supabase.from('owner_authorizations').select('*').in('id', extra).eq('scope', SCOPE).eq('status', 'executed').gte('expires_at', now.toISOString()); if (r2.error) throw new Error(`resume: ${r2.error.message}`); more = r2.data || []; }
  const out = [];
  for (const a of [...(data || []), ...more]) {
    try { const r = await executePackage({ supabase, sentItems: sentItems || graphSentItems, runner: `ai-team:amanda@resume:${process.pid}` }, a); out.push({ id: a.id, summary: r.summary }); }
    catch (e) { console.error(`[arc_acc] resume of ${a.id} failed: ${e.message}`); out.push({ id: a.id, error: e.message }); }
  }
  if (out.length) console.log('[arc_acc] resumed', JSON.stringify(out));
  return out;
}

// Ledger + case events + follow-ups for terminal results (scheduled messages record when they go).
async function recordResults(supabase, authorization, results) {
  const E = require('./events');
  const byN = new Map((authorization.items || []).map((i) => [Number(i.n), i]));
  const base = (i) => ({ community_id: i.community_id || null, authority_kind: 'request', authorization_id: authorization.id, action_type: 'arc_acc_decision', target_id: i.target_id, fingerprint: i.fingerprint,
    channel: 'email', requested_by: authorization.requested_by || null, coordinator: authorization.coordinator || P.COORDINATOR, authorized_by_user_id: authorization.authorized_by_user_id, authorized_by_email: authorization.authorized_by_email });
  const rows = [];
  for (const r of results) {
    const i = byN.get(Number(r.n)); if (!i || r.recorded) continue;
    if (r.status === 'excluded') rows.push({ ...base(i), event: 'declined', note: `item ${r.n} left out by the owner` });
    else if (r.status === 'done') rows.push({ ...base(i), event: 'executed', executed_by: i.executor, result: { ok: true, n: r.n, detail: r.detail || null } });
    else if (r.status !== 'scheduled') rows.push({ ...base(i), event: 'execution_failed', executed_by: i.executor, result: { ok: false, n: r.n, status: r.status, detail: r.detail, retryable: isRetryable(r) } });
  }
  await E.recordEvents(supabase, rows);
  for (const r of results) {
    const i = byN.get(Number(r.n)); if (!i || r.recorded) continue;
    await caseEvents(supabase, [i], 'updated', () => ({ owner_authorization: authorization.id, n: r.n, outcome: r.status, detail: r.detail || null }));
    // A system failure is retried automatically; only what needs a person gets a follow-up.
    if (['held', 'superseded', 'failed'].includes(r.status) && !isRetryable(r)) {
      await followUp(supabase, authorization, i, { title: `Follow up: ${i.title}`, why: `Item ${r.n} of owner authorization ${String(authorization.id).slice(0, 8)} was not carried out: ${r.detail}`,
        next_step: r.status === 'held' ? 'Annie revises the message to match what was issued; Tessa sends Ed a new request for it.' : 'Amanda reviews what happened, then brings Ed a corrected item if one is still needed. Nothing is sent meanwhile.' });
    }
  }
}

// A Draft Queue message carried by an authorization was sent (called by the Draft Queue send).
async function afterDraftSent(supabase, d, { sent_at, message_id }) {
  const oa = d.policy && d.policy.owner_authorization; if (!oa) return null;
  const { data: a, error } = await supabase.from('owner_authorizations').select('*').eq('id', oa.authorization_id).maybeSingle();
  if (error || !a) { console.error(`[arc_acc] sent ${d.id} but its authorization ${oa.authorization_id} was not found: ${error && error.message}`); return null; }
  const item = (a.items || []).find((i) => Number(i.n) === Number(oa.n));
  const T = require('../builder_arc/tracking');
  const notes = [];
  for (const lr of oa.letter_responses || []) {
    const { error: e1 } = await supabase.from('builder_application_responses').update({ email_sent_at: sent_at, email_message_id: message_id || null }).eq('id', lr.response_id);
    if (e1) notes.push(`letter sent but response ${lr.response_id} not stamped: ${e1.message}`);
    try { await T.closeWorkItem(supabase, lr.application_id, { status_label: 'decision emailed to the builder', decided_by: 'Ed (owner authorization)' }); } catch (e) { notes.push(`work item not closed: ${e.message}`); }
  }
  if ((oa.info_request_for || []).length) {
    try { await T.recordInfoRequestSent(supabase, oa.info_request_for, { sent_at, via: 'the consolidated reply', message_ref: message_id || d.id, sent_by: 'Annie' }); } catch (e) { notes.push(`information requests not recorded: ${e.message}`); }
  }
  try { await withdrawDrafts(supabase, oa.withdraw_drafts, `Covered by the reply sent ${sent_at} under owner authorization ${String(a.id).slice(0, 8)}`); } catch (e) { notes.push(e.message); }
  if (notes.length) console.error('[arc_acc] after-send steps incomplete', JSON.stringify({ draft: d.id, notes }));
  if (item) await recordResults(supabase, a, [{ n: item.n, target_id: item.target_id, status: 'done', detail: `sent ${sent_at}${notes.length ? '; ' + notes.join('; ') : ''}` }]);
  if (a.status === 'executed') return reportUpdate(supabase, a);
  return verifyAndReport(supabase, a.id);
}
async function afterDraftHeld(supabase, d, reason) {
  const oa = d.policy && d.policy.owner_authorization; if (!oa) return null;
  const { data: a, error } = await supabase.from('owner_authorizations').select('*').eq('id', oa.authorization_id).maybeSingle();
  if (error || !a) return null;
  const item = (a.items || []).find((i) => Number(i.n) === Number(oa.n));
  if (!item) return null;
  // Two workers can race on one release: if the message went out, the hold of the loser is not a failure.
  const { data: now } = await supabase.from('outbound_email_drafts').select('status').eq('id', d.id).maybeSingle();
  if (now && now.status === 'sent') return null;
  const r = { n: item.n, target_id: item.target_id, status: 'held', detail: `not sent: ${reason}` };
  await recordResults(supabase, a, [r]);
  // A system hold (a stored file, a send error) is retried by the durable runner; a judgment hold waits for Amanda.
  if (isRetryable(r)) { try { await executePackage({ supabase, sentItems: graphSentItems, runner: `ai-team:amanda@retry:${process.pid}` }, a); } catch (e) { console.error(`[arc_acc] retry of ${a.id} failed: ${e.message}`); } return null; }
  return verifyAndReport(supabase, a.id);
}

// Amanda: once every item is settled, check each against the records and report ONCE to the owner.
// "Once" is the database's: owner_authorization_mark_executed moves the authorization from
// authorized to executed exactly one time (row lock + WHERE status = 'authorized'); only the worker
// whose call succeeds sends the report. A concurrent or later caller gets an error and sends nothing.
async function verifyAndReport(supabase, authorizationId, { send = null } = {}) {
  const { data: a, error } = await supabase.from('owner_authorizations').select('*').eq('id', authorizationId).single();
  if (error) throw new Error(error.message);
  if (a.status !== 'authorized') return { complete: true, already_reported: true };
  const ledger = await ledgerState(supabase, a);
  const unsettled = (a.items || []).filter((i) => { const L = ledger.get(i.target_id); return !L || (L.last.event === 'execution_failed' && isRetryable({ ...(L.last.result || {}) }) && L.attempts < MAX_ATTEMPTS); });
  if (unsettled.length) return { complete: false, pending: unsettled.map((i) => i.n) };
  const lines = []; const outstanding = [];
  for (const i of [...a.items].sort((x, y) => x.n - y.n)) {
    const e = ledger.get(i.target_id).last;
    if (e.event === 'declined') { lines.push(`${i.n}. ${i.title}: left out, as you asked.`); continue; }
    if (e.event === 'execution_failed') { outstanding.push(`${i.n}. ${i.title}: ${(e.result && e.result.detail) || 'not carried out'}. Amanda is following up.`); continue; }
    const v = await verifyItem(supabase, i);
    (v.ok ? lines : outstanding).push(`${i.n}. ${i.title}: ${v.text}`);
  }
  const { error: mErr } = await supabase.rpc('owner_authorization_mark_executed', { p_id: a.id, p_execution: { verified_by: P.COORDINATOR, verified_at: new Date().toISOString(), lines, outstanding } });
  if (mErr) return { complete: true, already_reported: true, detail: mErr.message };   // another worker closed and reported it
  const text = ['Ed,', '', `Amanda verified owner authorization ${String(a.id).slice(0, 8)} against the records.`, '', ...lines, ...(outstanding.length ? ['', 'Still outstanding (Amanda has a follow-up open on each):', ...outstanding] : ['', 'Nothing is outstanding.']), '', 'Tessa'].join('\n');
  const g = require('../email/graph_send');
  const sender = send || ((m) => require('../onboarding/owner_authorization').graphSendTracked(g, m));
  let sent = false; let lastErr = null;
  for (let k = 0; k < 3 && !sent; k++) {
    try { await sender({ from: g.TESSA_MAILBOX, to: a.owner_email, subject: `Done: ${a.subject}`, text, html: `<div style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap">${esc(text)}</div>` }); sent = true; }
    catch (e) { lastErr = e; if (/not_configured|suppressed|supabaseUrl/i.test(e.message)) break; }
  }
  const E = require('./events');
  if (!sent) {
    console.error(`[arc_acc] completion report for ${a.id} not sent: ${lastErr && lastErr.message}`);
    await followUp(supabase, a, { n: 'report', title: 'completion report', community_id: null }, { title: `Send Ed the completion report for ${a.subject}`, why: `The report could not be sent (${lastErr && lastErr.message}). It is never resent automatically, so it cannot arrive twice.`, next_step: 'Amanda sends Ed the completion report once, from the authorization record.' });
    return { complete: true, reported: false, lines, outstanding };
  }
  const { data: evs } = await supabase.from('authorization_events').select('*').eq('authorization_id', a.id).in('event', ['executed', 'execution_failed']);
  const { data: reps } = await supabase.from('authorization_events').select('related_event_id').eq('authorization_id', a.id).eq('event', 'reported');
  const seen = new Set((reps || []).map((x) => x.related_event_id));
  for (const e of (evs || []).filter((x) => !seen.has(x.id))) await E.recordReport(supabase, { event: e, note: 'verified and reported to the owner' });
  return { complete: true, reported: true, lines, outstanding };
}

// After the one completion report: an item that was outstanding and is now done gets one short
// update from Amanda (never a second report). Each executed event is reported once ('reported').
async function reportUpdate(supabase, a, { send = null } = {}) {
  const { data: evs, error } = await supabase.from('authorization_events').select('*').eq('authorization_id', a.id).eq('event', 'executed');
  if (error) throw new Error(error.message);
  const { data: reps } = await supabase.from('authorization_events').select('related_event_id').eq('authorization_id', a.id).eq('event', 'reported');
  const seen = new Set((reps || []).map((x) => x.related_event_id));
  const fresh = (evs || []).filter((e) => !seen.has(e.id));
  if (!fresh.length) return { updated: false };
  const lines = [];
  for (const e of fresh) {
    const i = (a.items || []).find((x) => x.target_id === e.target_id); if (!i) continue;
    const v = await verifyItem(supabase, i); lines.push(`${i.n}. ${i.title}: ${v.text}`);
    // The letters a reply carried are now with the builder: say so for each of those items.
    for (const k of i.attach_letters_of || []) { const li = (a.items || []).find((x) => Number(x.n) === Number(k)); if (li) { const lv = await verifyItem(supabase, li); lines.push(`${li.n}. ${li.title}: ${lv.text}`); } }
  }
  const E = require('./events');
  // Claim first: record the reports, then send; a concurrent caller finds nothing fresh.
  for (const e of fresh) await E.recordReport(supabase, { event: e, note: 'completed after the completion report; Amanda updated the owner' });
  const text = ['Ed,', '', `Update on owner authorization ${String(a.id).slice(0, 8)}: the item that was outstanding in Amanda's report is now done.`, '', ...lines, '', 'Tessa'].join('\n');
  try {
    const g = require('../email/graph_send');
    const sender = send || ((m) => require('../onboarding/owner_authorization').graphSendTracked(g, m));
    await sender({ from: g.TESSA_MAILBOX, to: a.owner_email, subject: `Update: ${a.subject}`, text, html: `<div style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap">${esc(text)}</div>` });
  } catch (e) { console.error(`[arc_acc] update for ${a.id} not sent: ${e.message}`); }
  return { updated: true, lines };
}

// What the records actually show for an executed item.
async function verifyItem(supabase, i) {
  if (i.action === 'builder_decision') {
    const { data: app, error } = await supabase.from('builder_applications').select('status, reference_number').eq('id', i.target_id).single();
    if (error) return { ok: false, text: `could not be checked (${error.message})` };
    const { data: resp } = await supabase.from('builder_application_responses').select('email_sent_at').eq('application_id', i.target_id).order('decided_at', { ascending: false }).limit(1);
    const emailed = resp && resp[0] && resp[0].email_sent_at;
    if (!String(app.status).startsWith('approved')) return { ok: false, text: `the application shows ${app.status}, not approved` };
    return emailed ? { ok: true, text: `${app.status.replace(/_/g, ' ')}; letter emailed to the builder ${String(emailed).slice(0, 10)}.` } : { ok: false, text: `${app.status.replace(/_/g, ' ')}, but the letter has not reached the builder yet; it goes with the builder reply.` };
  }
  if (i.action === 'correspondence') {
    const { data: d, error } = await supabase.from('outbound_email_drafts').select('status, sent_at').eq('id', i.target_id).single();
    if (error) return { ok: false, text: `could not be checked (${error.message})` };
    return d.status === 'sent' ? { ok: true, text: `sent ${String(d.sent_at).slice(0, 16).replace('T', ' ')} UTC.` } : { ok: false, text: `the message is ${d.status}, not sent.` };
  }
  const { data: dec, error } = await supabase.from('acc_decisions').select('status, reference_number, decision_type, letter_pdf_storage_path, acknowledged_at').eq('id', i.target_id).single();
  if (error) return { ok: false, text: `could not be checked (${error.message})` };
  if (i.action === 'acc_decision' && dec.status !== 'decided') return { ok: false, text: `the case shows ${dec.status}, not decided` };
  if (i.deliver === 'mail') return { ok: false, text: `${i.action === 'acc_decision' ? 'decision recorded' : 'letter recorded'}; staff print and mail it (a follow-up is open until it is mailed).` };
  return { ok: true, text: i.action === 'acc_decision' ? `decided and emailed (${String(dec.decision_type || i.decision_type || 'decision').replace(/_/g, ' ')}).` : 'request emailed; the case waits on the homeowner.' };
}

module.exports = { reportUpdate, resumePending, isRetryable, MAX_ATTEMPTS, SCOPE, ACTIONS, registerExecutor, buildPackage, requestPackage, renderRequest, requestSubject, parseReply, executePackage, ownerActor, preflightActor,
  priorContact, graphSentItems, afterDraftSent, afterDraftHeld, verifyAndReport, verifyItem, builderFingerprint, accFingerprint, draftFingerprint, accBody, approverLabel, _EXECUTORS: EXECUTORS };
