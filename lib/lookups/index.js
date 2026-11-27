// ============================================================================
// lib/lookups/index.js  (Ed 2026-11-27: shared intelligence, access at the data layer)
// ----------------------------------------------------------------------------
// The ONE set of read lookups every trustEd persona uses in conversation
// (Amanda first; Claire and board Amanda later, each with its own principal).
// Nothing here is a second data system: every lookup calls the existing source
// of truth and only shapes the answer for a conversation.
//
//   homeowner search / record  api/homeowner_360.js searchHomeowners + assemble
//                              (balance + ledger from v_current_owner_*, ACC from
//                              acc_decisions with the effective decision +
//                              community_applications, violations, correspondence)
//   transactions               lib/ar/current_owner_ledger.currentOwnerActivity
//   association AR             lib/ar/current_owner_ledger (v_current_owner_balance)
//   governing documents        lib/hybrid_retrieval.getRelevantChunks
//   financial statements       lib/statements/model (the statements board packets print)
//   vendors / contracts / AP   lib/askEdTools.lookupCommunityVendor, vendor_contracts,
//                              lib/accounting/ap_as_of.loadOpenApAsOf
//
// ACCESS: every lookup names its capability and checks the principal
// (lib/lookups/principal.js) for it AND for the community / property it reads,
// before reading anything. A refused lookup returns { ok:false, error:'forbidden' }
// and is logged; it never returns partial data.
// ============================================================================

const P = require('./principal');

let _sb = null;
function sb() {
  if (_sb) return _sb;
  const { createClient } = require('@supabase/supabase-js');
  _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  return _sb;
}
function _setClientForTests(c) { _sb = c; }

const H360 = () => require('../../api/homeowner_360');
const money = (cents) => (cents == null || !Number.isFinite(Number(cents))) ? null : Math.round(Number(cents)) / 100;
const day = (s) => (s ? String(s).slice(0, 10) : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function monthEndBefore(d = new Date()) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
  return x.toISOString().slice(0, 10);
}

// ---- communities -------------------------------------------------------------------
let _communities = null; let _communitiesAt = 0;
async function communities() {
  if (_communities && Date.now() - _communitiesAt < 10 * 60 * 1000) return _communities;
  const { data, error } = await sb().from('communities').select('id, name').order('name').limit(500);
  if (error) throw error;
  _communities = data || []; _communitiesAt = Date.now();
  return _communities;
}
/** Resolve a community name or id within the principal's scope. { community } or { error, options }. */
async function resolveCommunity(principal, nameOrId) {
  const all = (await communities()).filter((c) => P.canCommunity(principal, c.id));
  const raw = String(nameOrId || '').trim();
  if (!raw) return { error: 'community_required', options: all.map((c) => c.name) };
  if (UUID.test(raw)) {
    const hit = all.find((c) => c.id === raw);
    return hit ? { community: hit } : { error: 'community_not_found_or_outside_access' };
  }
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const q = norm(raw);
  const exact = all.filter((c) => norm(c.name) === q);
  const hits = exact.length ? exact : all.filter((c) => norm(c.name).includes(q) || q.split(' ').every((w) => norm(c.name).includes(w)));
  if (hits.length === 1) return { community: hits[0] };
  if (!hits.length) return { error: 'community_not_found_or_outside_access', options: all.map((c) => c.name) };
  return { error: 'community_ambiguous', options: hits.map((c) => c.name) };
}

// ---- homeowners --------------------------------------------------------------------
async function findHomeowner(principal, { query, community } = {}) {
  P.require(principal, 'homeowner_search');
  const q = String(query || '').trim();
  if (q.length < 2) return { ok: false, error: 'query_too_short' };
  let cid = null;
  if (community) { const r = await resolveCommunity(principal, community); if (r.error) return { ok: false, ...r }; cid = r.community.id; }
  const { results } = await H360().searchHomeowners(q);
  const visible = results.filter((r) => (r.community_ids || []).some((c) => P.canCommunity(principal, c) && (!cid || c === cid)));
  return {
    ok: true, query: q, count: visible.length,
    matches: visible.slice(0, 10).map((r) => ({ contact_id: r.contact_id, name: r.name, properties: r.properties, community: r.community })),
    note: visible.length > 10 ? `${visible.length} matches; ask for a fuller name or the address to narrow it.` : undefined,
  };
}

/** Which contact, from contact_id or property_id (current primary owner). */
async function contactFor({ contact_id, property_id }) {
  if (contact_id) return UUID.test(String(contact_id)) ? String(contact_id) : null;
  if (!property_id || !UUID.test(String(property_id))) return null;
  const { data, error } = await sb().from('property_ownerships').select('contact_id, is_primary')
    .eq('property_id', property_id).is('end_date', null).order('is_primary', { ascending: false }).limit(1);
  if (error) throw error;
  return (data && data[0] && data[0].contact_id) || null;
}

function assertAllProperties(principal, properties) {
  if (!properties.length) throw new P.AccessError('no current property for this homeowner', null);
  for (const p of properties) P.assertProperty(principal, { property_id: p.property_id, community_id: p.community_id });
}

/** One homeowner, summarized for a conversation. The 360 is the source; this only shapes it. */
async function homeownerRecord(principal, { contact_id, property_id } = {}) {
  P.require(principal, 'homeowner_record');
  const cid = await contactFor({ contact_id, property_id });
  if (!cid) return { ok: false, error: 'homeowner_not_found' };
  // Scope check BEFORE the record is assembled: the contact's current lots must all be visible.
  const props = await H360().ownedProperties(cid);
  assertAllProperties(principal, props);
  const r = await H360().assemble(cid);
  if (!r) return { ok: false, error: 'homeowner_not_found' };
  const ledger = principal.capabilities.has('homeowner_ledger');
  const openViolations = (r.violations || []).filter((v) => v.open);
  const plan = (r.paymentPlans || []).find((p) => p.status === 'active') || null;
  const out = {
    ok: true,
    homeowner: {
      contact_id: r.contact.id, name: r.contact.full_name, preferred_name: r.contact.preferred_name || null,
      email: r.contact.primary_email || r.contact.secondary_email || null, phone: r.contact.primary_phone || null,
      mailing_address: r.contact.mailing_address || null, language: r.contact.preferred_language || null,
    },
    properties: r.properties.map((p) => ({ property_id: p.property_id, address: p.address, community: p.community })),
    violations: {
      open: openViolations.slice(0, 10).map((v) => ({ category: v.category, stage: v.current_stage, opened: day(v.opened_at), detail: v.detail || null, at_attorney: !!v.sent_to_attorney_at })),
      open_count: openViolations.length,
      recently_resolved: (r.violations || []).filter((v) => !v.open && v.resolved_at).slice(0, 3).map((v) => ({ category: v.category, resolved: day(v.resolved_at), how: v.resolved_via || v.status_label })),
    },
    acc_applications: (r.arc || []).slice(0, 8).map((a) => ({ reference: a.reference, project: a.project, status: a.status, decision: a.decision, submitted: day(a.submitted_at), decided: day(a.decided_at), has_conditions: !!a.conditions })),
    correspondence: [
      ...(r.interactions || []).slice(0, 8).map((i) => ({ when: day(i.sent_at || i.created_at), kind: i.type, direction: i.direction, subject: i.subject || null, status: i.status || null })),
      ...(r.emails || []).slice(0, 8).map((e) => ({ when: day(e.received_at), kind: 'email', direction: e.direction, subject: e.subject || null, summary: e.ai_summary || null })),
    ].sort((a, b) => String(b.when || '').localeCompare(String(a.when || ''))).slice(0, 10),
    calls: (r.calls || []).slice(0, 3).map((c) => ({ when: day(c.started_at), summary: c.brief || null })),
  };
  if (ledger) {
    out.balance = { amount: money(r.ar.balance_cents), source: 'current owner ledger', recent_transactions: (r.ar.transactions || []).slice(0, 8).map((t) => ({ date: day(t.transaction_date), description: t.description, amount: money(t.amount_cents) })) };
    out.payment_plan = plan ? { status: plan.status, installment: money(plan.installment_amount_cents), frequency: plan.frequency, next_due: day(plan.next_due_date), remaining: money(plan.balance_remaining_cents) } : null;
    if (r.amenity) out.amenity_access = { allowed: r.amenity.allowed !== false, reason: r.amenity.reason || null };
  }
  // Decisions pending on this account (owner authorizations whose items name one of its lots).
  if (principal.kind === 'owner') {
    try {
      const { data: pend, error: pErr } = await sb().from('owner_authorizations').select('subject, summary, items, expires_at').eq('status', 'requested').order('requested_at', { ascending: false }).limit(50);
      if (pErr) throw pErr;
      const ids = r.properties.map((p) => p.property_id);
      out.pending_decisions = (pend || []).filter((a) => ids.some((id) => JSON.stringify(a.items || []).includes(id))).map((a) => {
        const item = (a.items || []).find((i) => ids.some((id) => JSON.stringify(i).includes(id))) || {};
        return { request: a.subject, about: item.reason || item.title || item.description || null, expires: a.expires_at ? day(a.expires_at) : null };
      });
    } catch (e) { console.warn('[lookups] pending decisions read failed', e.message); }
  }
  if (principal.capabilities.has('collections')) {
    out.collections = (r.collections || []).map((c) => ({ status: c.collection_status, since: day(c.status_since), bankruptcy_chapter: c.bankruptcy_chapter || null }));
    out.at_attorney = !!r.at_attorney;
  }
  return out;
}

async function homeownerTransactions(principal, { property_id: requested, from, to, limit } = {}) {
  P.require(principal, 'homeowner_ledger');
  const property_id = requested || (Array.isArray(principal.properties) && principal.properties.length === 1 ? principal.properties[0] : null);
  if (!property_id || !UUID.test(String(property_id))) return { ok: false, error: 'property_id_required' };
  const { data: prop, error } = await sb().from('properties').select('id, street_address, community_id').eq('id', property_id).maybeSingle();
  if (error) throw error;
  if (!prop) return { ok: false, error: 'property_not_found' };
  P.assertProperty(principal, { property_id: prop.id, community_id: prop.community_id });
  const { currentOwnerActivity, currentOwnerBalance } = require('../ar/current_owner_ledger');
  const n = Math.min(100, Math.max(1, Number(limit) || 25));
  const rows = await currentOwnerActivity(sb(), prop.id, { ascending: false, limit: n, from: from || undefined, to: to || undefined });
  const bal = await currentOwnerBalance(sb(), prop.id);
  return {
    ok: true, address: prop.street_address, balance: bal ? money(bal.balance_cents) : null, balance_as_of: bal ? day(bal.most_recent_txn_date) : null,
    transactions: rows.map((t) => ({ date: day(t.transaction_date), description: t.description, type: t.txn_type, category: t.charge_category || null, amount: money(t.amount_cents), running_balance: money(t.running_balance_cents) })),
    showing: rows.length,
  };
}

/**
 * The signed-in homeowner's OWN lot, homeowner-facing fields only (Claire in the portal).
 * Built from lib/claire/caller_context (property, balance under the community's
 * financial-access rule, open violations, open ACC) plus their payment plan, recent
 * ACC decisions and correspondence that was actually exchanged with them. Never
 * internal notes, staff summaries, collection or legal status.
 */
async function myAccount(principal, { property_id } = {}) {
  P.require(principal, 'my_account');
  const pid = property_id || (Array.isArray(principal.properties) && principal.properties.length === 1 ? principal.properties[0] : null);
  if (!pid || !UUID.test(String(pid))) return { ok: false, error: 'property_id_required' };
  const { data: prop, error } = await sb().from('properties').select('id, street_address, community_id').eq('id', pid).maybeSingle();
  if (error) throw error;
  if (!prop) return { ok: false, error: 'property_not_found' };
  P.assertProperty(principal, { property_id: prop.id, community_id: prop.community_id });
  const ledger = principal.capabilities.has('homeowner_ledger');
  const CC = require('../claire/caller_context');
  const ctx = await CC.loadCallerContext(prop.id, { includeBalance: ledger });
  if (!ctx) return { ok: false, error: 'account_unavailable' };
  const out = { ok: true, property: ctx.address, community: ctx.community, open_violations: ctx.open_violations || [], open_acc_applications: ctx.open_acc || [] };
  if (ledger) {
    out.balance = ctx.balance ? { amount: ctx.balance.amount, as_of: day(ctx.balance.as_of) } : { amount: null, note: 'No balance is on file for this account yet.' };
    const { data: plans, error: pErr } = await sb().from('payment_plans').select('status, installment_amount_cents, frequency, next_due_date, balance_remaining_cents')
      .eq('property_id', prop.id).eq('status', 'active').limit(1);
    if (pErr) console.warn('[lookups] payment plan read failed', pErr.message);
    const plan = (plans || [])[0];
    out.payment_plan = plan ? { installment: money(plan.installment_amount_cents), frequency: plan.frequency, next_due: day(plan.next_due_date), remaining: money(plan.balance_remaining_cents) } : null;
  } else {
    out.balance_note = 'Account balances are not available in this portal for this account yet. Do not point them to a tile or screen for it; offer to have the team confirm it.';
  }
  try {
    const cases = await require('../acc/address_cases').accCasesForAddress(sb(), { communityId: prop.community_id, address: prop.street_address });
    out.recent_acc_decisions = cases.filter((c) => c.status === 'decided').slice(0, 3).map((c) => ({ project: c.project_summary || null, decision: (c.effective && c.effective.decision_type) || c.decision_type || null, decided: day((c.effective && c.effective.finalized_at) || c.decided_at) }));
  } catch (e) { console.warn('[lookups] acc read failed', e.message); }
  try {
    const rows = await require('../interactions/history').fetchInteractionsForProperty(prop.id, { caller_facing: true });
    out.correspondence = rows.filter((r) => ['inbound', 'outbound'].includes(r.direction) && !/note/i.test(String(r.type || '')))
      .slice(0, 8).map((r) => ({ when: day(r.sent_at), kind: String(r.type || '').replace(/_/g, ' '), direction: r.direction === 'inbound' ? 'from you' : 'to you', subject: r.subject || null }));
  } catch (e) { console.warn('[lookups] correspondence read failed', e.message); }
  return out;
}

/**
 * Upcoming meetings, events and amenity bookings (dates only, never who) for one community,
 * plus the portal tiles that are live there with their exact on-screen titles. The same
 * calendar the portal's Calendar tile shows (lib/portal/community_calendar).
 */
async function communityCalendar(principal, { community, days } = {}) {
  P.require(principal, 'community_info');
  const cid = community ? null : (Array.isArray(principal.communities) && principal.communities.length === 1 ? principal.communities[0] : null);
  let target;
  if (cid) { P.assertCommunity(principal, cid); target = (await communities()).find((c) => c.id === cid) || { id: cid, name: null }; }
  else { const r = await resolveCommunity(principal, community); if (r.error) return { ok: false, ...r }; target = r.community; }
  const horizon = Math.min(365, Math.max(7, Number(days) || 120));
  const items = await require('../portal/community_calendar').communityCalendarItems(sb(), target.id, { fromMs: Date.now() - 864e5, toMs: Date.now() + horizon * 864e5 });
  const when = (s) => (s ? String(s).slice(0, 16).replace('T', ' ') : null);
  let tiles = [];
  try { tiles = await require('../portal/live_tiles').liveTiles(sb(), target.id); } catch (e) { console.warn('[lookups] live tiles failed', e.message); }
  return {
    ok: true, community: target.name, horizon_days: horizon,
    meetings: items.filter((i) => i.kind === 'meeting').slice(0, 8).map((i) => ({ title: i.title, when: when(i.starts_at), location: i.location, description: i.description })),
    events: items.filter((i) => i.kind === 'event').slice(0, 10).map((i) => ({ title: i.title, when: when(i.starts_at), location: i.location })),
    amenity_reserved_dates: items.filter((i) => i.kind === 'amenity_booking').slice(0, 40).map((i) => ({ amenity: i.location, date: String(i.starts_at).slice(0, 10) })),
    portal_tiles_live: tiles.map((t) => t.title),
    note: 'Name only tiles in portal_tiles_live, exactly as written. If something is not there, it is not in the portal for this community yet.',
  };
}

// ---- association -------------------------------------------------------------------
async function associationAr(principal, { community, top } = {}) {
  P.require(principal, 'association_ar');
  const r = await resolveCommunity(principal, community); if (r.error) return { ok: false, ...r };
  const { fetchAllQuery } = require('../db/fetch_all');
  const rows = await fetchAllQuery(() => sb().from('v_current_owner_balance').select('property_id, balance_cents, most_recent_txn_date').eq('community_id', r.community.id).order('property_id'), { orderBy: 'property_id' });
  const owing = rows.filter((x) => Number(x.balance_cents) > 0).sort((a, b) => Number(b.balance_cents) - Number(a.balance_cents));
  const credits = rows.filter((x) => Number(x.balance_cents) < 0);
  const n = Math.min(25, Math.max(0, Number(top) || 10));
  let largest = [];
  if (n && owing.length) {
    const ids = owing.slice(0, n).map((x) => x.property_id);
    const { data: props, error } = await sb().from('properties').select('id, street_address').in('id', ids);
    if (error) throw error;
    const addr = Object.fromEntries((props || []).map((p) => [p.id, p.street_address]));
    largest = owing.slice(0, n).map((x) => ({ property_id: x.property_id, address: addr[x.property_id] || null, balance: money(x.balance_cents) }));
  }
  return {
    ok: true, community: r.community.name, source: 'current owner ledger',
    accounts: rows.length, owing_count: owing.length, total_owed: money(owing.reduce((s, x) => s + Number(x.balance_cents), 0)),
    credit_count: credits.length, total_credits: money(credits.reduce((s, x) => s + Number(x.balance_cents), 0)), largest_balances: largest,
  };
}

async function governingDocuments(principal, { community, question } = {}) {
  P.require(principal, 'governing_documents');
  const r = await resolveCommunity(principal, community); if (r.error) return { ok: false, ...r };
  const q = String(question || '').trim();
  if (!q) return { ok: false, error: 'question_required' };
  const { getRelevantChunks } = require('../hybrid_retrieval');
  // The whole ranked result: the retriever self-limits (CLAUDE.md: never truncate it).
  const text = await getRelevantChunks(q, r.community.name);
  return { ok: true, community: r.community.name, excerpts: text || '', note: text ? 'Quote the provision; say which document it comes from.' : 'Nothing relevant found in this association\'s documents.' };
}

function summarizeSections(sections, cols) {
  const val = (v) => (v == null ? null : money(v));
  return (sections || []).map((s) => ({
    section: s.label,
    groups: (s.groups || []).map((g) => {
      const tot = g.total || g.values || null;
      const sum = tot ? Object.fromEntries(cols.filter((k) => k in tot).map((k) => [k, val(tot[k])])) : null;
      const lines = (g.lines || []).filter((l) => l.kind === 'account').slice(0, 12).map((l) => ({ account: `${l.account_number} ${l.account_name}`, ...Object.fromEntries(cols.filter((k) => l.values && k in l.values).map((k) => [k, val(l.values[k])])) }));
      return { group: g.label, ...(sum ? { total: sum } : {}), lines };
    }),
    ...(s.total ? { total: Object.fromEntries(cols.filter((k) => k in s.total).map((k) => [k, val(s.total[k])])) } : {}),
  }));
}

async function associationFinancials(principal, { community, report, as_of, fund } = {}) {
  P.require(principal, 'association_financials');
  const r = await resolveCommunity(principal, community); if (r.error) return { ok: false, ...r };
  const M = require('../statements/model');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(as_of || '')) ? String(as_of) : monthEndBefore();
  const kind = report === 'income_budget' ? 'income_budget' : 'balance_sheet';
  if (kind === 'balance_sheet') {
    const m = await M.buildBalanceSheetModel(sb(), { community_id: r.community.id, as_of: date });
    return {
      ok: true, community: r.community.name, report: 'balance sheet', as_of: date, status: m.lifecycle && m.lifecycle.label,
      totals: Object.fromEntries(Object.entries(m.totals || {}).filter(([k]) => k !== 'balanced').map(([k, v]) => [k, typeof v === 'object' && v ? money(v.current) : money(v)])),
      sections: summarizeSections(m.sections, ['current', 'prior_month']), warnings: m.warnings || [],
    };
  }
  const m = await M.buildIncomeBudgetModel(sb(), { community_id: r.community.id, period_end: date, fund: fund || 'OPR' });
  const cols = (m.columns || []).map((c) => c.key || c).filter((k) => typeof k === 'string');
  return {
    ok: true, community: r.community.name, report: 'income vs budget', fund: m.fund, period_end: date, status: m.lifecycle && m.lifecycle.label, has_budget: m.has_budget,
    columns: (m.columns || []).map((c) => (c && c.key ? `${c.key}: ${c.label || ''}` : String(c))),
    sections: summarizeSections(m.sections, cols),
    net: m.net && m.net.values ? Object.fromEntries(Object.entries(m.net.values).map(([k, v]) => [k, money(v)])) : null,
    warnings: m.warnings || [],
  };
}

async function vendors(principal, { community, query } = {}) {
  P.require(principal, 'vendors');
  const r = await resolveCommunity(principal, community); if (r.error) return { ok: false, ...r };
  const out = { ok: true, community: r.community.name };
  if (query) {
    const { lookupCommunityVendor } = require('../askEdTools');
    out.vendor_lookup = await lookupCommunityVendor({ community: r.community.name, category: String(query) });
  }
  const { data: contracts, error } = await sb().from('vendor_contracts')
    .select('vendor_name, service_category, start_date, end_date, auto_renew, annual_cost_cents, monthly_cost_cents, status')
    .eq('community_id', r.community.id).order('vendor_name').limit(60);
  if (error) out.contracts_error = error.message;
  else out.contracts = (contracts || []).filter((c) => !query || JSON.stringify(c).toLowerCase().includes(String(query).toLowerCase()) || (contracts || []).length <= 25)
    .map((c) => ({ vendor: c.vendor_name, service: c.service_category, start: day(c.start_date), end: day(c.end_date), auto_renew: c.auto_renew, annual: money(c.annual_cost_cents), monthly: money(c.monthly_cost_cents), status: c.status }));
  return out;
}

async function openPayables(principal, { community, as_of } = {}) {
  P.require(principal, 'vendors');
  const r = await resolveCommunity(principal, community); if (r.error) return { ok: false, ...r };
  const { loadOpenApAsOf } = require('../accounting/ap_as_of');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(as_of || '')) ? String(as_of) : new Date().toISOString().slice(0, 10);
  const res = await loadOpenApAsOf(sb(), r.community.id, date);
  const open = (res && (res.open || res.invoices || res)) || [];
  const list = Array.isArray(open) ? open : [];
  return {
    ok: true, community: r.community.name, as_of: date, open_count: list.length,
    total_open: money(list.reduce((s, i) => s + Number(i.open_cents != null ? i.open_cents : (i.total_cents || 0) - (i.amount_paid_cents || 0)), 0)),
    invoices: list.slice(0, 20).map((i) => ({ vendor: (i.vendors && i.vendors.name) || i.vendor_name || null, invoice: i.vendor_invoice_number || null, date: day(i.invoice_date), due: day(i.due_date), open: money(i.open_cents != null ? i.open_cents : (i.total_cents || 0) - (i.amount_paid_cents || 0)), status: i.status || null })),
  };
}

// ---- tools -------------------------------------------------------------------------
// One definition per lookup, shared by every conversational surface. A surface gets
// only the tools its principal holds a capability for (toolsFor).
const TOOLS = [
  { name: 'find_homeowner', capability: 'homeowner_search', fn: findHomeowner,
    description: 'Find a homeowner by name, street address, email or phone. Returns matches with contact_id. Use before homeowner_record when you do not have an id.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, community: { type: 'string', description: 'association name, optional' } }, required: ['query'] } },
  { name: 'homeowner_record', capability: 'homeowner_record', fn: homeownerRecord,
    description: 'One homeowner\'s current record: contact details, properties, balance and recent transactions, open violations, ACC applications and decisions, correspondence, calls, payment plan, collection status.',
    input_schema: { type: 'object', properties: { contact_id: { type: 'string' }, property_id: { type: 'string' } } } },
  { name: 'my_account', capability: 'my_account', fn: myAccount,
    description: 'The signed-in homeowner own account: their property, balance and as-of date, payment plan, open violations and their stage, ACC applications and recent decisions, and recent letters and emails with them.',
    input_schema: { type: 'object', properties: { property_id: { type: 'string', description: 'omit: their own property' } } } },
  { name: 'community_calendar', capability: 'community_info', fn: communityCalendar,
    description: 'Upcoming board and annual meetings, community events, the dates the clubhouse or other amenities are already reserved, and the portal tiles that are live for this community (exact titles). Use for when is the next meeting, is the clubhouse free, where do I find something in the portal.',
    input_schema: { type: 'object', properties: { community: { type: 'string', description: 'omit for the homeowner own community' }, days: { type: 'number' } } } },
  { name: 'homeowner_transactions', capability: 'homeowner_ledger', fn: homeownerTransactions,
    description: 'A property\'s current-owner transaction history (newest first) and balance. Optional from/to dates (YYYY-MM-DD).',
    input_schema: { type: 'object', properties: { property_id: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'number' } }, required: ['property_id'] } },
  { name: 'association_receivables', capability: 'association_ar', fn: associationAr,
    description: 'An association\'s homeowner receivables: how many owe, total owed, credits, and the largest balances with addresses.',
    input_schema: { type: 'object', properties: { community: { type: 'string' }, top: { type: 'number' } }, required: ['community'] } },
  { name: 'governing_documents', capability: 'governing_documents', fn: governingDocuments,
    description: 'Search an association\'s governing documents (declaration, bylaws, rules, policies) and Texas law for a question. Returns the relevant provisions.',
    input_schema: { type: 'object', properties: { community: { type: 'string' }, question: { type: 'string' } }, required: ['community', 'question'] } },
  { name: 'association_financials', capability: 'association_financials', fn: associationFinancials,
    description: 'An association\'s financial statements from the books: report "balance_sheet" (cash, reserves, fund balances) or "income_budget" (actual vs budget, month and year to date). Defaults to the last month end.',
    input_schema: { type: 'object', properties: { community: { type: 'string' }, report: { type: 'string', enum: ['balance_sheet', 'income_budget'] }, as_of: { type: 'string' }, fund: { type: 'string' } }, required: ['community'] } },
  { name: 'vendors_and_contracts', capability: 'vendors', fn: vendors,
    description: 'An association\'s vendors and contracts (service, term, cost, renewal). Optional query for a service or vendor name.',
    input_schema: { type: 'object', properties: { community: { type: 'string' }, query: { type: 'string' } }, required: ['community'] } },
  { name: 'open_payables', capability: 'vendors', fn: openPayables,
    description: 'An association\'s open vendor invoices (accounts payable) as of today or a date.',
    input_schema: { type: 'object', properties: { community: { type: 'string' }, as_of: { type: 'string' } }, required: ['community'] } },
];
const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/** The tool definitions this principal may use (model-facing shape). */
function toolsFor(principal) {
  return TOOLS.filter((t) => principal.capabilities.has(t.capability)).map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}
function isLookup(name) { return Object.prototype.hasOwnProperty.call(BY_NAME, name); }

/** Run one lookup for a principal. Never throws: { ok:false, error } on refusal or failure. */
async function runLookup(name, principal, args = {}) {
  const t = Object.prototype.hasOwnProperty.call(BY_NAME, name) ? BY_NAME[name] : null;
  if (!t) return { ok: false, error: 'unknown_lookup' };
  try {
    if (!principal || !principal.capabilities || !principal.capabilities.has(t.capability)) throw new P.AccessError(`not authorized for ${t.capability}`);
    return await t.fn(principal, args || {});
  } catch (e) {
    if (e.code === 'forbidden') {
      console.warn('[lookups] refused', JSON.stringify({ lookup: name, kind: principal && principal.kind, user: principal && principal.user_id, reason: e.message }));
      return { ok: false, error: 'forbidden', detail: e.message };
    }
    console.error('[lookups] failed', JSON.stringify({ lookup: name, error: e.message }));
    return { ok: false, error: 'lookup_failed', detail: String(e.message || e).slice(0, 200) };
  }
}

module.exports = { TOOLS, toolsFor, isLookup, runLookup, resolveCommunity, findHomeowner, homeownerRecord, myAccount, communityCalendar, homeownerTransactions, associationAr, governingDocuments, associationFinancials, vendors, openPayables, _setClientForTests };
