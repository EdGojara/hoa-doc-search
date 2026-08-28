// ============================================================================
// lib/team/operator_core.js  (Ed 2026-08-28)
// ----------------------------------------------------------------------------
// The operator core, shared by the whole team. These are the persona-agnostic
// capabilities that turn a persona from a reply-writer into an operator:
//
//   propertyContext        this sender's account facts (violations, AR, ACC)
//   assembleGrounding      governing docs (§209 + CC&Rs) + community profile
//   pickAudience / resolveAudience   who is this — homeowner/board/vendor/staff
//   audienceGetsCommunityFacts       the disclosure policy, one place
//   boardDataContext       the governance dataset a fiduciary is entitled to
//   reservedAsk            the shared code gate (Claire's screen())
//   cleanModelBody         strip markdown + a model-appended signature
//   classifyDisposition / dispositionForCareful   routine vs exception
//
// Amanda composes these today. The other personas adopt them when turned on —
// nothing here is wired to a live path on its own. This exists so the capability
// is shared, not copied per teammate (the silo the roster header warns about):
// improve the core, and every persona that has adopted it improves at once.
//
// Everything here is best-effort and destructures `error` (never a bare `data`,
// the confident-zero scar). Community-wide reads paginate WITH an order.
// ============================================================================

const { screen } = require('../claire/guardrails');
const { classifyDisposition, dispositionForCareful } = require('./exception_router');

const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

// The reserved-decision gate, in code before the model. role lets a lane widen
// or narrow later; today every persona holds the same line (see guardrails.js).
function reservedAsk(email, role = 'homeowner') {
  const text = [email && email.subject, email && email.body, email && email.body_preview]
    .filter(Boolean).join('\n');
  return screen(text, role);
}

// This sender's own account facts. Never another resident's — the caller passes
// exactly one propertyId, resolved from the sender.
async function propertyContext(supabase, { propertyId }) {
  const ctx = { violations: [], ar_balance: null, acc: [], flags: [] };
  if (!propertyId) return ctx;
  try {
    const { data } = await supabase.from('violations')
      .select('current_stage, opened_at, enforcement_categories(label)')
      .eq('property_id', propertyId).not('current_stage', 'in', '(cured,closed,voided)').limit(25);
    ctx.violations = (data || []).map((v) => ({ stage: v.current_stage, category: v.enforcement_categories && v.enforcement_categories.label, opened_at: v.opened_at }));
  } catch (e) { /* defensive */ }
  try {
    const { data } = await supabase.from('v_homeowner_current_balance').select('balance_cents').eq('property_id', propertyId).maybeSingle();
    if (data) ctx.ar_balance = Number(data.balance_cents || 0) / 100;
  } catch (e) { /* defensive */ }
  try {
    const { data } = await supabase.from('acc_decisions').select('decision_type, status, project_summary, created_at').eq('property_id', propertyId).in('status', ['pending', 'in_review', 'submitted']).limit(10);
    ctx.acc = data || [];
  } catch (e) { /* defensive */ }
  return ctx;
}

// Governing docs (§209 + CC&Rs, via the shared hybrid retrieval) + the community
// profile. The same recipe the voice brain assembles. Best-effort: a miss
// degrades the answer, it never throws.
async function assembleGrounding({ email, communityName }) {
  const question = [email.subject, email.body, email.body_preview].filter(Boolean).join('\n').slice(0, 4000);
  let docContext = '';
  let profileBlock = '';
  try {
    const { getRelevantChunks } = require('../hybrid_retrieval');
    docContext = (await getRelevantChunks(question, communityName) || '').slice(0, 9000);
  } catch (e) { console.warn('[operator_core] doc retrieval failed:', e.message); }
  try {
    const { buildCommunityContextBlock } = require('../../api/communities');
    profileBlock = (await buildCommunityContextBlock(communityName) || '').slice(0, 4000);
  } catch (e) { console.warn('[operator_core] community profile failed:', e.message); }
  return { docContext, profileBlock };
}

// Audience is the confidentiality-and-authority gate, not a tone setting. Pure
// mapping from resolved signals; tested with no DB.
function pickAudience({ senderEmail, isBoardMember, isOwner, isVendor }) {
  if (/@bedrocktx\.com$/i.test(String(senderEmail || ''))) return 'staff';
  if (isBoardMember) return 'board';
  if (isOwner) return 'homeowner';
  if (isVendor) return 'vendor';
  return 'other';
}

async function resolveAudience({ email, supabase, communityId, propertyId }) {
  const senderEmail = (email && (email.sender_email || email.from_email || email.from)) || '';
  const e = String(senderEmail).trim();
  let isBoardMember = false;
  let isVendor = false;
  try {
    if (e && communityId) {
      const { data, error } = await supabase.from('board_members')
        .select('email').ilike('email', e)
        .eq('community_id', communityId).eq('is_active', true).limit(1);
      if (!error) isBoardMember = !!(data && data.length);
    }
  } catch (err) { console.warn('[operator_core] board lookup failed:', err.message); }
  try {
    if (e && !isBoardMember) {
      const { data, error } = await supabase.from('vendors')
        .select('id').eq('management_company_id', BEDROCK_MGMT_CO_ID).neq('is_active', false)
        .or(`email.ilike.${e},contact_email.ilike.${e}`).limit(1);
      if (!error) isVendor = !!(data && data.length);
    }
  } catch (err) { console.warn('[operator_core] vendor lookup failed:', err.message); }
  return pickAudience({ senderEmail, isBoardMember, isOwner: !!propertyId, isVendor });
}

// The disclosure policy, in ONE place: who may see the association's internal
// community data. Vendors and unproven senders never do.
function audienceGetsCommunityFacts(audience) {
  return audience === 'homeowner' || audience === 'board' || audience === 'staff';
}

// The governance dataset a fiduciary is entitled to, from canonical sources.
// The CALLER must gate this to audience === 'board'; this function only assembles.
async function boardDataContext(supabase, communityId) {
  if (!communityId) return '';
  const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const parts = [];

  try {
    const rows = [];
    for (let f = 0; f < 20000; f += 1000) {
      const { data, error } = await supabase.from('v_homeowner_current_balance')
        .select('balance_cents, vantaca_account_id').eq('community_id', communityId)
        .order('balance_cents', { ascending: false }).range(f, f + 999);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const del = rows.filter((r) => Number(r.balance_cents || 0) > 0);
    const total = del.reduce((a, r) => a + Number(r.balance_cents || 0), 0);
    const top = del.slice(0, 10).map((r) => money(r.balance_cents)).join(', ');
    parts.push(`DELINQUENCY: ${money(total)} outstanding across ${del.length} account(s). Largest balances: ${top || 'none'}.`);
  } catch (e) { parts.push(`DELINQUENCY: unavailable (${e.message}).`); }

  try {
    const { data, error } = await supabase.from('v_current_enforcement_state')
      .select('state').eq('community_id', communityId);
    if (!error && Array.isArray(data)) {
      const by = {}; for (const r of data) if (r.state) by[r.state] = (by[r.state] || 0) + 1;
      const flagged = Object.entries(by).filter(([s]) => /legal|collect|bankrupt/i.test(s)).map(([s, n]) => `${n} ${s}`).join(', ');
      if (flagged) parts.push(`ENFORCEMENT STATE: ${flagged}.`);
    }
  } catch (e) { /* view may not be community-scoped here; skip */ }

  try {
    const { data, error } = await supabase.from('v_trial_balance')
      .select('account_number, total_debits_cents, total_credits_cents').eq('community_id', communityId);
    if (error) throw error;
    const byNum = Object.fromEntries((data || []).map((r) => [String(r.account_number), r]));
    const net = (r) => (r ? Number(r.total_debits_cents || 0) - Number(r.total_credits_cents || 0) : 0);
    const opCash = net(byNum['1000']);
    const totalCash = Object.entries(byNum).filter(([n]) => /^10\d\d$/.test(n)).reduce((a, [, r]) => a + net(r), 0);
    const arControl = net(byNum['1300']);
    parts.push(`FINANCIALS: operating cash (1000) ${money(opCash)}; total cash on hand ${money(totalCash)}; AR control (1300) ${money(arControl)}.`);
  } catch (e) { parts.push(`FINANCIALS: unavailable (${e.message}).`); }

  try {
    const rows = [];
    for (let f = 0; f < 20000; f += 1000) {
      const { data, error } = await supabase.from('violations')
        .select('current_stage').eq('community_id', communityId)
        .not('current_stage', 'in', '(cured,closed,voided)')
        .order('id', { ascending: true }).range(f, f + 999);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const by = {}; for (const r of rows) by[r.current_stage] = (by[r.current_stage] || 0) + 1;
    parts.push(`OPEN ENFORCEMENT: ${rows.length} open (${Object.entries(by).map(([s, n]) => `${n} ${s}`).join(', ') || 'none'}).`);
  } catch (e) { parts.push(`OPEN ENFORCEMENT: unavailable (${e.message}).`); }
  try {
    const { data, error } = await supabase.from('acc_decisions')
      .select('status').eq('community_id', communityId).in('status', ['pending', 'in_review', 'submitted']).limit(1000);
    if (!error) parts.push(`OPEN ACC / ARCHITECTURAL: ${(data || []).length} pending review.`);
  } catch (e) { /* skip */ }

  try {
    const { data, error } = await supabase.from('vendor_contracts')
      .select('vendor_name_raw, service_category, service_description, end_date, annualized_amount, status')
      .eq('community_id', communityId).eq('status', 'active').order('end_date', { ascending: true }).limit(100);
    if (error) throw error;
    const active = data || [];
    const soon = active.filter((c) => c.end_date && (new Date(c.end_date) - new Date()) < 90 * 864e5 && (new Date(c.end_date) - new Date()) > -1);
    parts.push(`VENDOR CONTRACTS: ${active.length} active`
      + (soon.length ? `. Expiring within 90 days: ${soon.map((c) => `${c.vendor_name_raw || c.service_category} (ends ${c.end_date})`).join('; ')}.` : '. None expiring within 90 days.'));
  } catch (e) { parts.push(`VENDOR CONTRACTS: unavailable (${e.message}).`); }

  return parts.join('\n');
}

// The persona signature (name, title, logo, honest-AI mark) is appended at SEND
// time. The model sometimes signs its own name/title too (doubling the block) or
// reaches for markdown (rendered literally by the plain-text email pipeline).
// Strip both. sigNames are the persona's name/title lines to strip; the generic
// company/email/phone lines are always stripped.
function cleanModelBody(text, sigNames = []) {
  const t = String(text || '')
    .replace(/^\s*subject:.*(?:\r?\n)+/i, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\r\n/g, '\n');
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const extra = new Set(sigNames.map(norm).filter(Boolean));
  const isSig = (line) => {
    const l = norm(line);
    if (l === 'bedrock association management' || l === 'bedrock') return true;
    if (/@bedrocktx\.com/i.test(line)) return true;
    if (/^\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}$/.test(line.trim())) return true;
    return extra.has(l);
  };
  const lines = t.split('\n');
  while (lines.length) {
    const last = lines[lines.length - 1].trim();
    if (last === '' || isSig(last)) { lines.pop(); continue; }
    break;
  }
  return lines.join('\n').trim();
}

module.exports = {
  BEDROCK_MGMT_CO_ID,
  reservedAsk, propertyContext, assembleGrounding,
  pickAudience, resolveAudience, audienceGetsCommunityFacts,
  boardDataContext, cleanModelBody,
  classifyDisposition, dispositionForCareful,
};
