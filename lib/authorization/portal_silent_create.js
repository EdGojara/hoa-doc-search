// ============================================================================
// lib/authorization/portal_silent_create.js  (Ed 2026-11-27, migration 586)
// ----------------------------------------------------------------------------
// The Owner Authorization Service for creating homeowner portal accounts
// silently (no invitation) before the 2027 assessment mailing. Homeowners
// cannot self-register: "enter your email" sign-in works only when an account
// exists. Creating accounts for every eligible owner is a broader launch, which
// the owner-only bulk-invite endpoint refuses without broader_launch_approved.
// This adapter is how the owner approves it by email instead of in the app:
//
//   Tessa sends ONE request: per association, the accounts to create, the
//   multi-lot accounts, existing silent accounts that get missing lots, every
//   skipped count by reason, and the roster hash. Ed replies "approved" (or
//   "approved except Canyon Gate"). Amanda executes each association through
//   the SAME create path the endpoint uses (lib/portal/silent_create), only if
//   the recomputed roster (lib/portal/invite_roster loadInviteRoster) is exactly
//   what he approved and its lot cross-check passes, and only while the portal
//   is still off.
//
// Never: an invitation, a magic link, an email to a homeowner, a change to
// communities.portal_active, balances or payments. Shared, management and
// multi-address inboxes stay skipped (staff resolve them separately).
//
// Idempotent: a re-run of the same authorization (after an interruption) sees
// the accounts already made as existing silent accounts; it accepts that roster
// only when the owners, inboxes and lots are unchanged (membership hash), creates
// whatever is still missing and duplicates nothing. Once every association is
// done the authorization is marked executed and cannot run again.
// ============================================================================
'use strict';

const crypto = require('crypto');

const AGENT_ID = 'ai-team:amanda';
const SCOPE = 'portal_silent_creates';
const ACTION_TYPE = 'portal_silent_create';
const HASH_RE = /^[0-9a-f]{24}$/;
// PUBLIC LAUNCH HOLD (Ed 2026-11-28, CLAUDE.md): silent creation is allowed only where it grants no
// unintended access. Where the portal is already on, a new account lets a real owner sign in, so
// such an association is refused by the request AND by execution. Lifting this is a code change made
// with Ed's explicit launch approval for that association, never a flag set from a reply or a file.
const PORTAL_ON_REFUSED = true;
const HOLD_REFUSAL = 'the portal is already on, so a new account would let the owner sign in; refused under the public launch hold (Ed 2026-11-28) until Ed approves the launch for this association';
const must = async (q, w) => { const { data, error } = await q; if (error) throw new Error(`${w}: ${error.message}`); return data; };
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n || 0).toLocaleString('en-US');
const plural = (n, one, many) => `${num(n)} ${Number(n) === 1 ? one : (many || one + 's')}`;

const REASON_LABEL = {
  no_email: 'no email on file',
  multiple_emails: 'several addresses in one email field',
  invalid_email: 'email is not a valid address',
  shared_email: 'inbox shared by two or more different owners',
  management_inbox: 'management company or role inbox',
  already_has_account: 'already has a portal account',
  portal_access_revoked: 'portal access was revoked',
  email_has_other_portal_account: 'inbox already signs in to another account',
  portal_account_other_email: 'owner already has an account under another email',
  not_a_current_owner: 'not a current owner',
};

// The owners, inboxes and lots, without whether each account exists yet: a roster
// that only moved from "create" to "existing silent account" (because this
// authorization already ran) has the same membership hash.
function membershipHash(communityId, invite) {
  const IR = require('../portal/invite_roster');
  const canon = (invite || []).map((r) => [r.contact_id, IR.normalizeEmail(r.email), (r.properties || []).map((p) => p.property_id).sort()]);
  canon.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return crypto.createHash('sha256').update(JSON.stringify(['membership', String(communityId), canon])).digest('hex').slice(0, 24);
}

// PURE: what the owner sees for one association's loaded roster.
function summarizeRoster(loaded) {
  const { community, roster, cross_check, hash } = loaded;
  const creates = roster.invite.filter((r) => r.action === 'create');
  const existing = roster.invite.filter((r) => r.action === 'email_existing');
  // Distinct lots that have an owner contact; a lot whose owner of record has no contact is in the
  // cross-check count but on nobody's roster row, so it is named instead of silently missing.
  const contactLots = new Set([...roster.invite, ...roster.skipped].flatMap((r) => (r.properties || []).map((p) => p.property_id))).size;
  return {
    community_id: community.id, name: community.name, slug: community.slug, portal_active: community.portal_active === true,
    accounts_to_create: creates.length,
    lots_on_new_accounts: creates.reduce((n, r) => n + r.properties.length, 0),
    multi_lot_accounts: creates.filter((r) => r.properties.length > 1).length,
    existing_silent_accounts: existing.length,
    owners: roster.counts.owners, lots: cross_check.owner_lots, lots_without_owner_contact: Math.max(0, Number(cross_check.owner_lots || 0) - contactLots),
    skipped: { ...roster.counts.by_reason },
    skipped_total: roster.counts.skipped,
    cross_check, roster_hash: hash, membership_hash: membershipHash(community.id, roster.invite),
  };
}

// Every association verified exactly as the request would show it. `loader` is injectable for tests.
async function buildPackage(supabase, slugs, { loader } = {}) {
  const IR = require('../portal/invite_roster');
  const { BEDROCK_MGMT_CO_ID } = require('../company');
  const load = loader || ((id) => IR.loadInviteRoster(supabase, id, { managementCompanyId: BEDROCK_MGMT_CO_ID }));
  const associations = []; const problems = []; const nothing = [];
  const seen = new Set();
  for (const slug of slugs || []) {
    if (seen.has(slug)) { problems.push({ slug, problems: ['listed twice'] }); continue; }
    seen.add(slug);
    const c = await must(supabase.from('communities').select('id, name, slug, portal_active, is_demo').eq('slug', slug).maybeSingle(), 'community');
    if (!c) { problems.push({ slug, problems: ['no association with this slug'] }); continue; }
    const pr = [];
    if (c.is_demo === true) pr.push('a demo association');
    if (PORTAL_ON_REFUSED && c.portal_active === true) pr.push(HOLD_REFUSAL);
    const loaded = await load(c.id);
    if (!loaded || !loaded.community) { problems.push({ slug, problems: ['the roster could not be loaded'] }); continue; }
    const s = summarizeRoster(loaded);
    if (!s.cross_check.ok) pr.push(`the lot cross-check failed (${s.cross_check.owner_lots} owner lots vs ${s.cross_check.live_lots} live lots)`);
    if (pr.length) { problems.push({ slug, name: c.name, problems: pr }); continue; }
    if (!s.accounts_to_create && !s.existing_silent_accounts) { nothing.push(s); continue; }
    associations.push({ ...s, loaded });
  }
  if (!(slugs || []).length) problems.push({ slug: null, problems: ['list at least one association'] });
  return { ok: !problems.length && associations.length > 0, problems, associations, nothing };
}

function requestSubject(code, associations) {
  const total = associations.reduce((n, a) => n + a.accounts_to_create, 0);
  return `Owner authorization ${code}: create ${num(total)} homeowner portal accounts silently (${associations.length} association${associations.length === 1 ? '' : 's'})`;
}

// PURE: Tessa's request email. Plain language, no em dashes.
function renderRequest({ subject, associations, nothing = [], expiresAt }) {
  const total = associations.reduce((n, a) => n + a.accounts_to_create, 0);
  const blocks = associations.map((a, i) => {
    const skipped = Object.entries(a.skipped).sort((x, y) => y[1] - x[1]).map(([r, n]) => `      ${REASON_LABEL[r] || r}: ${num(n)}`);
    return [
      `${i + 1}. ${a.name}`,
      `   Accounts to create: ${num(a.accounts_to_create)} (covering ${plural(a.lots_on_new_accounts, 'lot')})`,
      `   Of those, owners of more than one lot: ${num(a.multi_lot_accounts)} (one account each, with every lot)`,
      ...(a.existing_silent_accounts ? [`   Accounts already created silently that get any missing lots: ${num(a.existing_silent_accounts)}`] : []),
      `   Owners of record: ${num(a.owners)} across ${plural(a.lots, 'lot')}; lot count matches the live lot count (${num(a.cross_check.live_lots)})`,
      ...(a.lots_without_owner_contact ? [`   Lots whose owner of record has no contact on file (no account possible): ${num(a.lots_without_owner_contact)}`] : []),
      `   Not created (left for staff, unchanged): ${num(a.skipped_total)}`,
      ...skipped,
      ...(a.portal_active ? [`   Portal: ALREADY ON for this association. An owner who goes to the sign-in page and enters their email can sign in once the account exists. Nobody is told. Balances and payments are off here.`] : ['   Portal: off. Nothing is visible to these owners until you switch it on.']),
    `   Roster hash: ${a.roster_hash}`,
    ].join('\n');
  });
  const none = nothing.length ? [`Nothing to create in ${nothing.map((a) => a.name).join(', ')}, so ${nothing.length === 1 ? 'it is' : 'they are'} not in this request.`] : [];
  const intro = `Amanda is ready to create ${plural(total, 'homeowner portal account')} so owners can sign in with their email when the 2027 assessment letter arrives. Homeowners cannot register themselves, so each account has to exist first.`;
  const on = associations.filter((a) => a.portal_active).map((a) => a.name);
  const safe = 'No invitation or email goes to any homeowner. ' + (on.length
    ? `Where the portal is off, nothing is visible until you switch it on. The portal is already on for ${on.join(' and ')}, so those owners could sign in by entering their email, though no one is told the account exists. `
    : 'Nothing is visible to homeowners until you switch the portal on for their association. ') + 'Balances and online payments stay off, and no portal setting changes. Shared inboxes, management inboxes, owners with several addresses in one field and owners with no email are not created; staff resolve those separately.';
  const how = `Reply "approved" to authorize exactly these accounts, or "approved except" and the association name or number to leave one out. Amanda creates each association's accounts through the same path as the portal admin silent create, attributed to you, and only if that association's owner list still matches its roster hash and lot count. If anything changed, including whether its portal is on, that association is not created and you get a new request. Reply anything else (or nothing) and nothing happens. This request expires ${expiresAt}.`;
  const text = ['Ed,', '', intro, '', safe, '', how, '', ...blocks.flatMap((b) => [b, '']), ...none, ...(none.length ? [''] : []), 'Tessa'].join('\n');
  const html = `<p>Ed,</p><p>${esc(intro)}</p><p><strong>${esc(safe)}</strong></p><p>${esc(how)}</p><pre style="font-family:Consolas,monospace;font-size:12px;white-space:pre-wrap">${esc(blocks.join('\n\n'))}</pre>${none.length ? `<p>${esc(none[0])}</p>` : ''}<p>Tessa</p>`;
  return { subject, text, html };
}

// PURE: "approved except Canyon Gate" -> the association's item number, then the shared reply reader.
function aliasesOf(item) {
  const name = String(item.name || '');
  const words = name.replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const names = new Set([name, String(item.slug || '').replace(/-/g, ' ')]);
  const sig = words.filter((w) => !/^(of|the|at|and|hoa|association|community|homeowners|owners|inc)$/i.test(w));
  if (sig.length >= 2) names.add(sig.slice(0, 2).join(' '));            // "Canyon Gate", "Lakes Pine"
  if (sig.length >= 1 && sig[0].length >= 5) names.add(sig[0]);          // "Waterview"
  // Acronyms (LOPF, LPF, CGCR, SCR, QR is too short): matched in capitals only, 3+ letters.
  const acr = new Set([words.map((w) => w[0]).join(''), sig.map((w) => w[0]).join('')].map((x) => x.toUpperCase()).filter((x) => x.length >= 3));
  return { names: [...names].map((x) => x.trim()).filter((x) => x.length >= 3), acronyms: [...acr] };
}
function parseReply(replyText, items = []) {
  let t = String(replyText || '');
  const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const pairs = items.flatMap((i) => { const a = aliasesOf(i); return [...a.names.map((x) => [x, i.n, 'gi']), ...a.acronyms.map((x) => [x, i.n, 'g'])]; })
    .sort((a, b) => b[0].length - a[0].length);
  for (const [alias, n, flags] of pairs) t = t.replace(new RegExp(`\\b${escRe(alias)}\\b`, flags), ` ${n} `);
  // "approved except Eaglewood" (not in the request) must never read as approving everything.
  const unresolved = t.match(/\b(?:except(?:\s+for)?|excluding|exclude|but\s+not|other\s+than|without|leave\s+out|leaving\s+out|skip|minus)\b\s*(?!(?:for\s+)?(?:items?\s*|nos?\.?\s*|#\s*)?\d)(\S+)/i);
  if (unresolved) return { kind: 'unclear', why: `could not tell which association "${unresolved[1].replace(/[^\w-]/g, '')}" means` };
  return require('./arc_acc').parseReply(t, items.map((i) => ({ n: i.n, title: '' })));
}

// Which open request still covers one of these associations. An AUTHORIZED request stops covering an
// association once it has executed it, refused it (its owner list changed, so it can never run under
// that approval) or the owner left it out: the refusal itself promises a new request (scar 1E9EEA2C,
// 2026-11-27: two associations refused on a changed roster blocked their own re-request).
function coveringRequest(open, settledEvents, ids) {
  const settled = new Set((settledEvents || []).map((e) => `${e.authorization_id}:${e.target_id}`));
  return (open || []).find((a) => (a.items || []).some((i) => ids.includes(i.community_id)
    && !(a.status === 'authorized' && settled.has(`${a.id}:${i.community_id}`))));
}

async function requestAuthorization({ supabase, rpc, send, slugs, ownerEmail, fromMailbox, summary, hours = 72, loader }) {
  const pkg = await buildPackage(supabase, slugs, { loader });
  if (!pkg.ok) throw Object.assign(new Error('not requested; fix first: ' + (pkg.problems.length ? pkg.problems.map((p) => `${p.name || p.slug} ${p.problems.join('; ')}`).join(' | ') : 'nothing to create')), { code: 'verification_failed', problems: pkg.problems });
  const ids = pkg.associations.map((a) => a.community_id);
  const open = await must(supabase.from('owner_authorizations').select('id, subject, status, items').eq('scope', SCOPE).in('status', ['requested', 'authorized']).limit(50), 'open requests');
  const authorizedIds = (open || []).filter((a) => a.status === 'authorized').map((a) => a.id);
  const settled = authorizedIds.length ? await must(supabase.from('authorization_events').select('authorization_id, target_id, event')
    .in('authorization_id', authorizedIds).in('event', ['executed', 'execution_failed', 'declined']).limit(1000), 'settled associations') : [];
  const dup = coveringRequest(open, settled, ids);
  if (dup) throw Object.assign(new Error(`an open request already covers these associations: ${dup.subject}`), { code: 'duplicate_request' });
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  const subject = requestSubject(code, pkg.associations);
  const r = await rpc('owner_authorization_request_portal_silent_creates', { p_subject: subject, p_summary: summary,
    p_associations: pkg.associations.map((a) => ({ community_id: a.community_id, roster_hash: a.roster_hash, membership_hash: a.membership_hash,
      accounts_to_create: a.accounts_to_create, multi_lot_accounts: a.multi_lot_accounts, existing_silent_accounts: a.existing_silent_accounts,
      lots: a.lots, skipped: a.skipped, portal_active: a.portal_active })),
    p_owner_email: ownerEmail, p_requested_by: AGENT_ID, p_hours: hours });
  const expiresAt = new Date(Date.now() + hours * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const mail = renderRequest({ subject, associations: pkg.associations, nothing: pkg.nothing, expiresAt });
  const sent = await send({ from: fromMailbox, to: ownerEmail, subject: mail.subject, text: mail.text, html: mail.html });
  if (!sent || !sent.internetMessageId || !sent.conversationId) throw new Error('the request email was not sent with a message identity; nothing can authorize it');
  await rpc('owner_authorization_sent', { p_id: r.id, p_message_id: sent.internetMessageId, p_conversation_id: sent.conversationId });
  const E = require('./events');
  await E.recordEvents(supabase, (r.items || []).flatMap((i) => ['requested', 'sent'].map((event) => ({ community_id: i.community_id, authority_kind: 'request', authorization_id: r.id,
    action_type: ACTION_TYPE, target_id: i.community_id, fingerprint: i.fingerprint, event, channel: 'email', requested_by: AGENT_ID,
    evidence: event === 'sent' ? { subject, request_message_id: sent.internetMessageId, conversation_id: sent.conversationId } : { summary, accounts_to_create: i.accounts_to_create } }))));
  return { id: r.id, subject, associations: pkg.associations.length, accounts: pkg.associations.reduce((n, a) => n + a.accounts_to_create, 0), items_sha256: r.items_sha256 };
}

// Execute an AUTHORIZED request: each association through the shared silent-create path,
// only if its roster is what the owner approved. ctx: { supabase, rpc, loader?, silentCreate? }.
async function executeAuthorized(ctx, authorization) {
  const { supabase } = ctx;
  if (!authorization || authorization.status !== 'authorized' || authorization.scope !== SCOPE || !authorization.authorized_by_email) {
    throw Object.assign(new Error('no authorized portal silent create'), { code: 'approval_required' });
  }
  const IR = require('../portal/invite_roster');
  const { BEDROCK_MGMT_CO_ID } = require('../company');
  const load = ctx.loader || ((id) => IR.loadInviteRoster(supabase, id, { managementCompanyId: BEDROCK_MGMT_CO_ID }));
  const create = ctx.silentCreate || require('../portal/silent_create').silentCreateRoster;
  const excluded = new Set(((authorization.evidence || {}).excluded_items || []).map(Number));
  const performedBy = String(authorization.authorized_by_email);
  const results = [];
  for (const item of authorization.items || []) {
    const res = { community_id: item.community_id, n: item.n, name: item.name };
    if (excluded.has(Number(item.n))) { results.push({ ...res, ok: true, status: 'excluded', detail: 'left out by you' }); continue; }
    try {
      const loaded = await load(item.community_id);
      if (!loaded || !loaded.community) throw new Error('the association was not found');
      const { community, roster, cross_check, hash } = loaded;
      if (PORTAL_ON_REFUSED && community.portal_active === true) throw new Error(`${HOLD_REFUSAL}; not created`);
      if ((community.portal_active === true) !== (item.portal_active === true)) throw new Error(`the portal was switched ${community.portal_active === true ? 'on' : 'off'} after you approved; not created`);
      if (!cross_check || !cross_check.ok) throw new Error(`the lot cross-check failed (${cross_check && cross_check.owner_lots} owner lots vs ${cross_check && cross_check.live_lots} live lots); not created`);
      const exact = hash === item.fingerprint;
      const resumed = !exact && item.membership_hash && membershipHash(community.id, roster.invite) === item.membership_hash;
      if (!exact && !resumed) throw new Error('the owner list changed after you approved (roster hash differs); not created');
      const out = await create(supabase, roster, { performedBy, slug: community.slug, via: 'owner_authorization' });
      // The same audit record the endpoint writes, with the owner's authorization as the approval.
      const { error: aErr } = await supabase.from('portal_audit_log').insert({ action: 'bulk_silent_create', resource_type: 'community', resource_id: community.id, performed_by: performedBy,
        notes: `hash=${hash} broader_launch_approved=true owner_authorization=${authorization.id} executed_by=${AGENT_ID}${resumed ? ' resumed=true' : ''} accounts_created=${out.accounts_created} failures=${out.failures.length} to_email=0` });
      if (aErr) console.error('[portal_silent_create] audit row not written:', aErr.message);
      Object.assign(res, { accounts_created: out.accounts_created, existing_accounts_checked: out.existing_accounts_checked, failures: out.failures.length,
        failure_reasons: [...new Set(out.failures.map((f) => f.reason))], resumed: !!resumed });
      res.ok = out.failures.length === 0;
      res.status = res.ok ? 'done' : 'failed';
      if (!res.ok) res.detail = `${out.failures.length} account${out.failures.length === 1 ? '' : 's'} not created (${res.failure_reasons.join(', ')}); run again to retry them`;
    } catch (e) { res.ok = false; res.status = 'failed'; res.detail = e.message; }
    results.push(res);
  }
  const E = require('./events');
  const base = (r) => ({ community_id: r.community_id, authority_kind: 'request', authorization_id: authorization.id, action_type: ACTION_TYPE, target_id: r.community_id,
    fingerprint: ((authorization.items || []).find((i) => i.community_id === r.community_id) || {}).fingerprint || null, channel: 'email', requested_by: authorization.requested_by || AGENT_ID,
    coordinator: authorization.coordinator || AGENT_ID, authorized_by_user_id: authorization.authorized_by_user_id || null, authorized_by_email: authorization.authorized_by_email || null });
  if (supabase) {
    await E.recordEvents(supabase, results.map((r) => (r.status === 'excluded'
      ? { ...base(r), event: 'declined', note: `${r.name} left out by the owner` }
      : { ...base(r), event: r.ok ? 'executed' : 'execution_failed', executed_by: AGENT_ID, result: { ok: r.ok, accounts_created: r.accounts_created || 0, failures: r.failures || 0, detail: r.detail || null } })));
  }
  const failed = results.filter((r) => !r.ok).length;
  if (!failed && ctx.rpc) await ctx.rpc('owner_authorization_mark_executed', { p_id: authorization.id, p_execution: { results, executed_by: AGENT_ID } });
  return { ok: !failed, created: results.reduce((n, r) => n + (r.accounts_created || 0), 0), done: results.filter((r) => r.status === 'done').length, failed, results };
}

function renderCompletion(authorization, out) {
  const lines = out.results.map((r) => `- ${r.name}: ${r.status === 'excluded' ? 'left out, as you asked' : r.ok ? `${plural(r.accounts_created, 'account')} created${r.existing_accounts_checked ? `; ${num(r.existing_accounts_checked)} earlier silent accounts checked for missing lots` : ''}` : 'NOT done: ' + r.detail}`);
  const text = ['Ed,', '', `Amanda carried out your authorization ${String(authorization.id).slice(0, 8)}: ${plural(out.created, 'homeowner portal account')} created.`, '', ...lines, '',
    'No invitation or email went to any homeowner. No portal setting changed, and balances and payments are unchanged (off). Shared and management inboxes were left for staff.', '', 'Tessa'].join('\n');
  return { subject: `Done: ${authorization.subject}`, text, html: `<pre style="font-family:Consolas,monospace;font-size:12px;white-space:pre-wrap">${esc(text)}</pre>` };
}

// Staff-only: the shared-inbox exceptions, masked (never in the repo or an email).
function maskEmail(e) {
  const [local, domain] = String(e || '').split('@');
  if (!domain) return '';
  return `${local.slice(0, 1)}***@${domain}`;
}
function sharedEmailExceptions(name, roster) {
  const IR = require('../portal/invite_roster');
  const rows = roster.skipped.filter((s) => s.reason === 'shared_email');
  const size = new Map(); const group = new Map();
  for (const s of rows) { const e = IR.normalizeEmail(s.email); size.set(e, (size.get(e) || 0) + 1); if (!group.has(e)) group.set(e, group.size + 1); }
  // group = a number per shared inbox within the association, so staff see who shares with whom without the address.
  return rows.map((s) => { const e = IR.normalizeEmail(s.email);
    return { association: name, shared_inbox_group: group.get(e), contact_name: s.name || '', lot_address: (s.properties || []).map((p) => p.street_address).join('; '),
      masked_email: maskEmail(e), group_size: size.get(e) || 1 }; }).sort((a, b) => a.shared_inbox_group - b.shared_inbox_group);
}

module.exports = { PORTAL_ON_REFUSED, AGENT_ID, SCOPE, ACTION_TYPE, REASON_LABEL, membershipHash, summarizeRoster, buildPackage, requestSubject, renderRequest, aliasesOf, parseReply,
  requestAuthorization, coveringRequest, executeAuthorized, renderCompletion, maskEmail, sharedEmailExceptions, HASH_RE };
