// ============================================================================
// lib/email/recipient_search.js  (Ed 2026-10-16)
// ----------------------------------------------------------------------------
// To / Cc autocomplete for the New Email window. One search over the contact
// records trustEd already keeps; no new contact store:
//   board_members        board members (with position)
//   contacts             homeowners, via their ACTIVE property ownership
//   vendors              active vendors (email / account-manager email)
//   user_profiles        active staff
//   lib/team/roster      the AI team (not sign-in accounts)
//   community_contacts   per-community directory entries with an email
//   email_messages       people who have written in (correspondents)
//   lists                "<Community> Board" and "Everyone (all staff)"
//
// Scope: every community-bound row (board, homeowner, directory, correspondent)
// must belong to a community this staff user can work in: not a demo community
// and not one Bedrock no longer manages (lib/community/lifecycle isEnded). There
// is no per-user community grant table today, so an authenticated staff user's
// scope is that set. The route that calls this is admin-gated; this module never
// runs for an unauthenticated caller.
//
// Every query is bounded (.limit) and runs in parallel. A source that errors is
// reported in `problems`, never read as "no matches" (CLAUDE.md: a broken query
// must not look like an empty result).
// ============================================================================
'use strict';

const { createClient } = require('@supabase/supabase-js');
const roster = require('../team/roster');
const lifecycle = require('../community/lifecycle');
const demo = require('../demo/demo_guard');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const STAFF_DOMAIN_RE = /@bedrocktx(ai)?\.com$/i;
const NOREPLY_RE = /^(no-?reply|donotreply|mailer-daemon|postmaster|notifications?)@/i;
const SOURCE_WEIGHT = { list: 70, board: 60, homeowner: 50, staff: 40, vendor: 35, agent: 30, directory: 30, correspondent: 10 };

// PostgREST .or() treats , ( ) as syntax; strip them (and wildcards) so a typed
// query can never change the filter. Bounded length.
function cleanQuery(q) {
  return String(q || '').replace(/[,()*%\\:"'`;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

let _comms = { at: 0, rows: null };
async function accessibleCommunities(client = supabase) {
  if (_comms.rows && Date.now() - _comms.at < 60 * 1000) return _comms.rows;
  const { data, error } = await client.from('communities')
    .select('id, name, management_status, management_end_date, is_demo').order('name').limit(500);
  if (error) throw Object.assign(new Error(`community list unavailable: ${error.message}`), { code: error.code });
  let demoIds = [];
  try { demoIds = await demo.demoCommunityIds(); } catch (_) { demoIds = []; }
  const rows = (data || []).filter((c) => !c.is_demo && !demoIds.includes(c.id) && !lifecycle.isEnded(c));
  _comms = { at: Date.now(), rows };
  return rows;
}

function matchScore(q, ...fields) {
  const s = q.toLowerCase(); let best = 0;
  for (const f of fields) {
    const v = String(f || '').toLowerCase(); if (!v) continue;
    if (v === s) best = Math.max(best, 400);
    else if (v.startsWith(s)) best = Math.max(best, 300);
    else if (v.split(/[\s@._-]+/).some((w) => w.startsWith(s))) best = Math.max(best, 200);
    else if (v.includes(s)) best = Math.max(best, 100);
    else if (s.includes(' ') && s.split(' ').every((w) => v.includes(w))) best = Math.max(best, 90);
  }
  return best;
}

/**
 * search({ q, communityId }) -> { results, problems, community_ignored }
 * results: [{ kind:'person', email, name, role, community_id, community_name, source }
 *          | { kind:'list', label, emails:[...], role, community_id, community_name, source:'list' }]
 */
async function searchRecipients({ q, communityId = null, limit = 20 } = {}, client = supabase) {
  const query = cleanQuery(q);
  if (query.length < 2) return { results: [], problems: [] };
  const comms = await accessibleCommunities(client);
  const byId = new Map(comms.map((c) => [c.id, c]));
  const byName = new Map(comms.map((c) => [c.name.toLowerCase(), c]));
  const community_ignored = !!(communityId && !byId.has(communityId));
  const selected = community_ignored ? null : communityId;
  const like = `%${query}%`;
  const problems = [];
  const people = [];
  const lists = [];
  const commOf = (id, name) => (id && byId.get(id)) || (name && byName.get(String(name).toLowerCase())) || null;
  const run = async (label, fn) => { try { await fn(); } catch (e) { problems.push(label); console.warn('[recipient_search] source failed', JSON.stringify({ source: label, error: e.message })); } };
  const must = async (p) => { const { data, error } = await p; if (error) throw new Error(error.message); return data || []; };

  await Promise.all([
    run('AI team', async () => {
      for (const m of roster.people()) {
        if (m.owner_only || !m.self_mailbox) continue;
        if (!matchScore(query, m.name, m.persona, m.title)) continue;
        people.push({ email: `${m.self_mailbox}bedrocktx.com`, name: m.name, role: `${m.title} (AI team)`, source: 'agent' });
      }
    }),
    run('staff', async () => {
      const rows = await must(client.from('user_profiles').select('full_name, email, role, is_active')
        .or(`full_name.ilike.${like},email.ilike.${like}`).limit(15));
      for (const u of rows) if (u.email && u.is_active !== false) people.push({ email: u.email, name: u.full_name || null, role: 'Staff', source: 'staff' });
    }),
    run('board members', async () => {
      const rows = await must(client.from('board_members').select('name, email, position, community_id, community_name')
        .eq('is_active', true).not('email', 'is', null).or(`name.ilike.${like},email.ilike.${like}`).limit(30));
      for (const b of rows) {
        const c = commOf(b.community_id, b.community_name); if (!c) continue;
        people.push({ email: b.email, name: b.name, role: b.position ? `Board ${b.position}` : 'Board member', community_id: c.id, community_name: c.name, source: 'board' });
      }
    }),
    run('homeowners', async () => {
      const cs = await must(client.from('contacts').select('id, full_name, primary_email, secondary_email')
        .or(`full_name.ilike.${like},primary_email.ilike.${like},secondary_email.ilike.${like}`).limit(25));
      const withEmail = cs.filter((c) => c.primary_email || c.secondary_email);
      if (!withEmail.length) return;
      const owns = await must(client.from('property_ownerships').select('contact_id, properties:property_id(street_address, community_id)')
        .in('contact_id', withEmail.map((c) => c.id)).is('end_date', null).limit(200));
      const home = new Map();
      for (const o of owns) {
        const c = o.properties && byId.get(o.properties.community_id); if (!c) continue;
        const cur = home.get(o.contact_id);
        if (!cur || c.id === selected) home.set(o.contact_id, { c, address: o.properties.street_address });
      }
      for (const ct of withEmail) {
        const h = home.get(ct.id); if (!h) continue;   // no active home in an accessible community: out of scope
        for (const em of [ct.primary_email, ct.secondary_email]) {
          if (em) people.push({ email: em, name: ct.full_name, role: h.address ? `Homeowner, ${h.address}` : 'Homeowner', community_id: h.c.id, community_name: h.c.name, source: 'homeowner' });
        }
      }
    }),
    run('vendors', async () => {
      const rows = await must(client.from('vendors').select('name, dba, email, account_manager_email, category, status')
        .eq('status', 'active').or(`name.ilike.${like},dba.ilike.${like},email.ilike.${like},account_manager_email.ilike.${like}`).limit(15));
      for (const v of rows) {
        for (const em of [v.email, v.account_manager_email]) {
          // A staff address on a vendor record is a data error (memory: no staff email on vendors).
          if (em && !STAFF_DOMAIN_RE.test(em)) people.push({ email: em, name: v.dba || v.name, role: v.category ? `Vendor, ${v.category}` : 'Vendor', source: 'vendor' });
        }
      }
    }),
    run('community directory', async () => {
      const rows = await must(client.from('community_contacts').select('name, email, category, community_id')
        .not('email', 'is', null).or(`name.ilike.${like},email.ilike.${like}`).limit(15));
      for (const r of rows) { const c = byId.get(r.community_id); if (c) people.push({ email: r.email, name: r.name, role: `Directory, ${r.category}`, community_id: c.id, community_name: c.name, source: 'directory' }); }
    }),
    run('correspondents', async () => {
      const rows = await must(client.from('email_messages').select('sender_name, sender_email, community_id')
        .eq('direction', 'inbound').or(`sender_name.ilike.${like},sender_email.ilike.${like}`).order('received_at', { ascending: false }).limit(40));
      for (const m of rows) {
        if (!m.sender_email || STAFF_DOMAIN_RE.test(m.sender_email) || NOREPLY_RE.test(m.sender_email)) continue;
        const c = m.community_id ? byId.get(m.community_id) : null;
        if (m.community_id && !c) continue;   // written about a community outside scope
        people.push({ email: m.sender_email, name: m.sender_name || null, role: 'Has emailed us', community_id: c ? c.id : null, community_name: c ? c.name : null, source: 'correspondent' });
      }
    }),
    run('lists', async () => {
      const ql = query.toLowerCase();
      const wantsBoard = /\bboard/.test(ql);
      const named = comms.filter((c) => matchScore(query.replace(/\bboard\b/i, '').trim() || '~', c.name) >= 100);
      let boardComms = named.length ? named : (wantsBoard ? (selected ? comms.filter((c) => c.id === selected) : comms) : []);
      boardComms = boardComms.slice(0, 8);
      if (boardComms.length) {
        const rows = await must(client.from('board_members').select('email, community_id, community_name')
          .eq('is_active', true).not('email', 'is', null).in('community_id', boardComms.map((c) => c.id)).limit(300));
        for (const c of boardComms) {
          const emails = [...new Set(rows.filter((r) => r.community_id === c.id && EMAIL_RE.test(String(r.email).trim())).map((r) => r.email.trim()))];
          if (emails.length) lists.push({ kind: 'list', label: `${c.name} Board`, emails, role: `Board list (${emails.length})`, community_id: c.id, community_name: c.name, source: 'list' });
        }
      }
      if (/^(every|all|staff|team)/.test(ql)) {
        const rows = await must(client.from('user_profiles').select('email, is_active').limit(300));
        const emails = [...new Set(rows.filter((u) => u.email && u.is_active !== false).map((u) => u.email))];
        if (emails.length) lists.push({ kind: 'list', label: 'Everyone (all staff)', emails, role: `Staff list (${emails.length})`, source: 'list' });
      }
    }),
  ]);

  // One result per address: the highest-priority source wins; other roles fold in.
  const merged = new Map();
  for (const p of people) {
    if (!p.email || !EMAIL_RE.test(String(p.email).trim())) continue;
    const k = p.email.trim().toLowerCase();
    const cur = merged.get(k);
    const row = { kind: 'person', ...p, email: p.email.trim() };
    if (!cur) { merged.set(k, row); continue; }
    const [hi, lo] = SOURCE_WEIGHT[row.source] > SOURCE_WEIGHT[cur.source] ? [row, cur] : [cur, row];
    if (lo.role && !String(hi.role || '').includes(lo.role)) hi.role = [hi.role, lo.role].filter(Boolean).join(' · ');
    hi.name = hi.name || lo.name; hi.community_id = hi.community_id || lo.community_id; hi.community_name = hi.community_name || lo.community_name;
    merged.set(k, hi);
  }
  const score = (r) => (selected && r.community_id === selected ? 1000 : 0)
    + (r.kind === 'list' ? matchScore(query, r.label, r.community_name) + 50 : matchScore(query, r.name, r.email))
    + (SOURCE_WEIGHT[r.source] || 0);
  const results = [...lists, ...merged.values()]
    .map((r) => ({ r, s: score(r) })).sort((a, b) => b.s - a.s || String(a.r.name || a.r.label).localeCompare(String(b.r.name || b.r.label)))
    .slice(0, Math.min(limit, 50)).map((x) => x.r);
  return { results, problems, community_ignored };
}

module.exports = { searchRecipients, accessibleCommunities, cleanQuery, matchScore, _resetCache: () => { _comms = { at: 0, rows: null }; } };
