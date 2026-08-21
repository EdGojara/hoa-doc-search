// ============================================================================
// lib/ea/tessa_resolve.js — turn spoken references into real people.
// ----------------------------------------------------------------------------
// Ed 2026-08-21: "tessa please send email to canyon gate board and ask if they
// want us to set up a follow up virtual meeting with security company the one
// with Grant as the contact."
//
// Two references in one sentence, neither of them an email address:
//   "canyon gate board"           -> a GROUP (five people at one community)
//   "security company ... Grant"  -> an INDIVIDUAL, named only by first name
//                                    and what his company does
//
// api/tessa.js already resolves individuals (resolveRecipient). This file adds
// the group half plus the community matching both need.
//
// Standing rule: NEVER invent an address. If a reference doesn't resolve to
// something on file, return it unresolved so Tessa can ask. A plausible guess
// at a board distribution list is how confidential association business ends up
// in a stranger's inbox.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Words that carry no identifying signal when matching a community name.
// "Canyon Gate at Cinco Ranch" vs "canyon gate" must match; "the estates" alone
// must not silently pick Drama Creek Estates.
const STOP = new Set(['the', 'at', 'of', 'and', 'a', 'an', 'hoa', 'association',
  'community', 'homeowners', 'inc', 'llc', 'board']);

function tokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter((t) => t && !STOP.has(t));
}

// Score a community name against a spoken hint. Every hint token must appear in
// the community name — a partial overlap ("creek" matching both Drama Creek and
// Still Creek) returns every candidate rather than picking one.
function scoreCommunity(hint, name) {
  const h = tokens(hint), n = tokens(name);
  if (!h.length) return 0;
  const nJoined = n.join(' ');
  let hit = 0;
  for (const t of h) if (n.includes(t) || nJoined.includes(t)) hit++;
  if (hit < h.length) return 0;
  // Prefer the tightest match: "canyon gate" against a 2-token name beats the
  // same hint against a 6-token one.
  return h.length / Math.max(n.length, 1);
}

// Find the community a hint refers to. Returns {community, ambiguous:[...]}.
// Ambiguity is reported, never resolved by picking the first row — resolving a
// community by guess is how mail lands at the wrong association.
async function matchCommunity(hint) {
  const { data, error } = await supabase
    .from('communities').select('id, name, is_demo').order('name');
  if (error) throw error;
  const scored = (data || [])
    .map((c) => ({ c, s: scoreCommunity(hint, c.name) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  if (!scored.length) return { community: null, ambiguous: [] };
  const top = scored[0].s;
  const tied = scored.filter((x) => x.s === top);
  if (tied.length > 1) return { community: null, ambiguous: tied.map((x) => x.c) };
  return { community: scored[0].c, ambiguous: [] };
}

// Does this hint name a group rather than one person?
// "canyon gate board", "the board at waterview", "waterview board members".
function parseGroupHint(hint) {
  const s = String(hint || '').trim();
  if (!/\bboard\b/i.test(s)) return null;
  // "the board at X" / "board for X" -> X
  let m = s.match(/\bboard\s*(?:members|of directors|member)?\s*(?:at|for|of)\s+(.+)$/i);
  if (m) return { kind: 'board', community: m[1].trim() };
  // "X board" / "X board members"
  m = s.match(/^(.*?)\s*\bboard\b\s*(?:members|of directors|member)?\s*$/i);
  if (m && m[1].trim()) return { kind: 'board', community: m[1].trim() };
  return { kind: 'board', community: '' };
}

// Resolve a board group to real addressees.
//
// ROLE ALIASES WIN, and that is deliberate.
//
// Ed 2026-08-21: "the canyon gate emails are correct, they use those instead of
// personal emails so they can keep a record of what happens in the community."
// The alias survives a board turnover, so the association keeps a continuous
// record of its own correspondence instead of losing it when a director's term
// ends and their personal mailbox walks out the door.
//
// Then, minutes later: "we will be adding canyon gate board members to board
// portal using their personal email addresses because they will have to log in
// to their homeowner accounts."
//
// Both are true, for DIFFERENT purposes, and conflating them breaks one or the
// other:
//
//   correspondence -> the role alias   (president@, secretary@ ...)
//   portal login   -> the personal address, tied to their homeowner account
//
// This function is the correspondence path. If the roster were preferred, then
// the moment Canyon Gate's board members are loaded for portal access, Tessa
// would silently start emailing personal addresses and the association would
// stop keeping its own record, with nothing on screen to show that anything had
// changed.
//
// So: a community that publishes role addresses gets those. A community that
// does not (Waterview, Lakes of Pine Forest, Drama Creek today) gets its roster.
//
// Returns {ok, community, people:[{name,email,position,source}], addressing}.
async function resolveBoardGroup(hint) {
  const parsed = parseGroupHint(hint);
  if (!parsed) return { ok: false, reason: 'not_a_group' };
  if (!parsed.community) {
    return { ok: false, reason: 'no_community', detail: 'Which community’s board?' };
  }

  const { community, ambiguous } = await matchCommunity(parsed.community);
  if (ambiguous.length) {
    return {
      ok: false, reason: 'ambiguous_community', ambiguous,
      detail: `More than one community matches “${parsed.community}”: ${ambiguous.map((c) => c.name).join(', ')}.`,
    };
  }
  if (!community) {
    return { ok: false, reason: 'unknown_community', detail: `No community on file matches “${parsed.community}”.` };
  }

  const people = []; const seen = new Set();
  const add = (p) => {
    const k = String(p.email || '').toLowerCase();
    if (!k || !EMAIL_RE.test(k) || seen.has(k)) return;
    seen.add(k); people.push(p);
  };

  // 1. The addresses the association publishes for its own seats. These are
  //    seats rather than people, so they are labelled as such and never
  //    presented as a named roster.
  const like = `%${community.name.replace(/[%,]/g, ' ')}%`;
  const { data: ea, error: eErr } = await supabase
    .from('ea_contacts')
    .select('name, email, organization, title, category')
    .eq('category', 'board')
    .ilike('organization', like)
    .limit(25);
  if (eErr) throw eErr;
  for (const c of (ea || [])) {
    add({ name: c.name, email: c.email, position: c.title || null, source: 'role_alias' });
  }

  // 2. Otherwise the roster we maintain.
  let usedRoster = false;
  if (!people.length) {
    const { data: bm, error: bErr } = await supabase
      .from('board_members')
      .select('name, email, position, is_active')
      .eq('community_id', community.id)
      .order('position');
    if (bErr) throw bErr;
    for (const b of (bm || [])) {
      if (b.is_active === false) continue;
      add({ name: b.name, email: b.email, position: b.position, source: 'board_roster' });
    }
    usedRoster = people.length > 0;
  }

  if (!people.length) {
    return {
      ok: false, reason: 'no_board_on_file', community,
      detail: `${community.name} has no board contacts on file yet.`,
    };
  }
  return { ok: true, community, people, addressing: usedRoster ? 'roster' : 'role_alias' };
}

module.exports = { resolveBoardGroup, matchCommunity, parseGroupHint, tokens };
