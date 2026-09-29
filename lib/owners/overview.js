// ============================================================================
// lib/owners/overview.js — owner search + owner exceptions per community
// (Issue #6, Owners slice)
// ----------------------------------------------------------------------------
// Read-only. Two jobs:
//   searchOwners()   find an owner/property across Bedrock communities by
//                    owner name, physical property address or account number.
//                    Returns NO email / phone / mailing address (PII kept to
//                    what's needed to pick the right record). Separate bounded
//                    queries per field, so user text never lands inside a
//                    PostgREST or() filter; errors throw (never "no results").
//   fetchOwnerFacts() + evaluateOwners()   per-community exceptions:
//                    properties with no current owner, accounts at legal / in
//                    collections (property_enforcement_states, the SSOT for
//                    legal status), collection statuses (ar_account_collections),
//                    pending ownership proposals, and possible owner collapse
//                    (lib/owners/concentration.js, the npm-test guard's rule).
// No balances here: AR and the GL tie-out live in ar_control / Financial, so
// this page never shows a second, differently-built AR number.
// ============================================================================
const { fetchAllQuery } = require('../db/fetch_all');
const { THRESHOLD, isCorporateName } = require('./concentration');

// ---- search -----------------------------------------------------------------
function escapeLike(q) { return String(q).replace(/[\\%_]/g, (c) => '\\' + c); }
function normalizeQuery(q) {
  const s = String(q || '').trim().replace(/\s+/g, ' ');
  return s.length >= 2 && s.length <= 80 ? s : null;
}
function mergeResults(lists, names, limit) {
  const byProp = new Map();
  for (const list of lists) for (const r of list || []) {
    if (!r || !r.property_id || byProp.has(r.property_id)) continue;
    byProp.set(r.property_id, {
      property_id: r.property_id,
      community_id: r.community_id,
      community: names.get(r.community_id) || null,
      street_address: r.street_address || null,
      unit: r.unit || null,
      owner_name: r.owner_name || null,
      trusted_account_number: r.trusted_account_number || null,
      vantaca_account_id: r.vantaca_account_id || null,
    });
  }
  return [...byProp.values()]
    .sort((a, b) => String(a.owner_name || '~').localeCompare(String(b.owner_name || '~')) || String(a.street_address || '').localeCompare(String(b.street_address || '')))
    .slice(0, limit);
}

const SEARCH_COLS = 'property_id, community_id, street_address, unit, owner_name, trusted_account_number, vantaca_account_id';

async function searchOwners(supabase, rawQ, communities) {
  const q = normalizeQuery(rawQ);
  if (!q) return { query: null, results: [], note: 'Type at least 2 characters.' };
  const ids = communities.map((c) => c.id);
  const names = new Map(communities.map((c) => [c.id, c.name]));
  const like = `%${escapeLike(q)}%`;
  const run = async (build) => { const { data, error } = await build(); if (error) throw error; return data || []; };
  const base = () => supabase.from('v_current_property_owners').select(SEARCH_COLS).in('community_id', ids);
  const lists = await Promise.all([
    run(() => base().ilike('owner_name', like).order('property_id').limit(25)),
    run(() => base().ilike('street_address', like).order('property_id').limit(25)),
    run(() => base().ilike('trusted_account_number', like).order('property_id').limit(10)),
    run(() => base().ilike('vantaca_account_id', like).order('property_id').limit(10)),
  ]);
  const results = mergeResults(lists, names, 40);
  const capped = lists[0].length === 25 || lists[1].length === 25;
  return { query: q, results, capped };
}

// ---- exceptions -------------------------------------------------------------
function lifecycleGroup(c) {
  const ms = c && c.management_status;
  if (ms === 'terminating' || ms === 'terminated') return 'leaving';
  if (ms === 'prospect') return 'prospect';
  return 'managed';
}

async function attempt(fn) {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

async function fetchOwnerFacts(supabase, communities) {
  const ids = communities.map((c) => c.id);
  const [propertyCounts, owners, legal, collections, proposals] = await Promise.all([
    attempt(async () => {
      const out = {};
      await Promise.all(ids.map(async (id) => {
        const { count, error } = await supabase.from('properties').select('id', { count: 'exact', head: true }).eq('community_id', id);
        if (error) throw error;
        out[id] = count || 0;
      }));
      return out;
    }),
    attempt(() => fetchAllQuery(() => supabase.from('v_current_property_owners').select('property_id, community_id, owner_contact_id, owner_name').in('community_id', ids), { orderBy: 'property_id' })),
    attempt(() => fetchAllQuery(() => supabase.from('property_enforcement_states').select('id, community_id, property_id, state').in('community_id', ids).is('ended_at', null), { orderBy: 'id' })),
    attempt(() => fetchAllQuery(() => supabase.from('ar_account_collections').select('id, community_id, property_id, collection_status').in('community_id', ids), { orderBy: 'id' })),
    attempt(() => fetchAllQuery(() => supabase.from('v_ownership_proposals_queue').select('id, community_id, age_days').in('community_id', ids).eq('status', 'pending'), { orderBy: 'id' })),
  ]);
  return { propertyCounts, owners, legal, collections, proposals };
}

const COLLECTION_ORDER = ['bankruptcy', 'foreclosure', 'lien_filed', 'with_attorney', 'board_review', 'payment_plan', 'late_notice', 'delinquent_reminder'];

function evaluateOwners(communities, facts) {
  const problems = [];
  const label = { propertyCounts: 'properties', owners: 'current owners', legal: 'legal status', collections: 'collection statuses', proposals: 'ownership proposals' };
  for (const k of Object.keys(label)) if (!facts[k] || !facts[k].ok) problems.push({ key: k, message: `Couldn’t load ${label[k]}. Those counts are unknown, not zero.`, error: (facts[k] && facts[k].error) || 'not loaded' });
  const ok = (k) => facts[k] && facts[k].ok;

  const rows = communities.map((c) => {
    const r = { community: { id: c.id, name: c.name, management_status: c.management_status, management_end_date: c.management_end_date || null }, group: lifecycleGroup(c),
      properties: null, no_owner: null, at_legal: null, in_collections: null, collections: null, proposals: null };
    if (ok('propertyCounts')) r.properties = facts.propertyCounts.value[c.id] || 0;
    if (ok('owners')) {
      const owned = new Set(facts.owners.value.filter((o) => o.community_id === c.id && o.owner_contact_id).map((o) => o.property_id));
      if (r.properties != null) r.no_owner = Math.max(0, r.properties - owned.size);
    }
    if (ok('legal')) {
      const mine = facts.legal.value.filter((s) => s.community_id === c.id);
      r.at_legal = mine.filter((s) => s.state === 'at_legal').length;
      r.in_collections = mine.filter((s) => s.state === 'in_collections').length;
    }
    if (ok('collections')) {
      const byStatus = {};
      for (const x of facts.collections.value) if (x.community_id === c.id) byStatus[x.collection_status] = (byStatus[x.collection_status] || 0) + 1;
      r.collections = COLLECTION_ORDER.filter((s) => byStatus[s]).map((s) => ({ status: s, count: byStatus[s] }))
        .concat(Object.keys(byStatus).filter((s) => !COLLECTION_ORDER.includes(s)).map((s) => ({ status: s, count: byStatus[s] })));
    }
    if (ok('proposals')) r.proposals = facts.proposals.value.filter((p) => p.community_id === c.id).length;
    r.needs_action = (r.no_owner || 0) + (r.proposals || 0);
    return r;
  });

  // Possible owner collapse: the npm-test guard's rule, portfolio-wide.
  let collapse = null;
  if (ok('owners')) {
    const byContact = new Map();
    for (const o of facts.owners.value) {
      if (!o.owner_contact_id) continue;
      const e = byContact.get(o.owner_contact_id) || { contact_id: o.owner_contact_id, name: o.owner_name, properties: new Set(), communities: new Set() };
      e.properties.add(o.property_id); e.communities.add(o.community_id);
      byContact.set(o.owner_contact_id, e);
    }
    const names = new Map(communities.map((c) => [c.id, c.name]));
    collapse = [...byContact.values()]
      .filter((e) => e.properties.size >= THRESHOLD && !isCorporateName(e.name))
      .map((e) => ({ contact_id: e.contact_id, name: e.name, properties: e.properties.size, communities: [...e.communities].map((id) => names.get(id)).filter(Boolean) }))
      .sort((a, b) => b.properties - a.properties);
  }

  const managed = rows.filter((r) => r.group === 'managed').sort((a, b) => b.needs_action - a.needs_action || String(a.community.name).localeCompare(String(b.community.name)));
  const sum = (k) => (managed.every((r) => r[k] != null) ? managed.reduce((s, r) => s + r[k], 0) : null);
  return {
    managed,
    other: rows.filter((r) => r.group !== 'managed').sort((a, b) => String(a.community.name).localeCompare(String(b.community.name))),
    totals: { properties: sum('properties'), no_owner: sum('no_owner'), at_legal: sum('at_legal'), in_collections: sum('in_collections'), proposals: sum('proposals') },
    collapse,
    collapse_threshold: THRESHOLD,
    problems,
  };
}

const COMMUNITY_SELECT = 'id, name, active, is_demo, management_company_id, management_status, management_end_date';

module.exports = { searchOwners, fetchOwnerFacts, evaluateOwners, escapeLike, normalizeQuery, mergeResults, COMMUNITY_SELECT };
