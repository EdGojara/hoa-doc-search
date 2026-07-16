// ============================================================================
// lib/email/community_alias.js  (Ed 2026-07-16)
// ----------------------------------------------------------------------------
// Resolve a community from an alternate name it's known by — its MUD, water
// district, billing entity, or DBA — so a utility bill or auto-pay confirmation
// that names "North Mission Glen MUD" routes to Eaglewood (and codes to its
// water account). Backed by the community_aliases table (migration 302).
//
// Degrades safely: if the table isn't applied yet, every call returns null and
// resolution falls back to plain name matching — no crash. And LEARNS: when a
// human links an email to a community, the hint that failed to auto-resolve is
// remembered, so the next identical bill routes itself.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Match the seed's alias_norm: lowercase, punctuation to spaces, collapsed.
const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

// Not cached: the table appears mid-life when Ed applies migration 302, and a
// cached "missing" would stay stale until a restart. The lookup is one small
// query — just try each time and return null on the "table absent" error.

/**
 * @param {string} hint  a community-ish name from an email (community_hint, subject)
 * @returns {{ community_id, gl_account_id, alias }|null}
 */
async function resolveCommunityByAlias(hint) {
  const n = norm(hint);
  if (!n) return null;
  try {
    // Exact first, then contains (the hint may carry extra words, e.g. the seed
    // "north mission glen mud" inside "auto-pay ... north mission glen mud sienv").
    const { data, error } = await supabase.from('community_aliases')
      .select('community_id, gl_account_id, alias, alias_norm');
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return null;
      throw error;
    }
    const rows = data || [];
    const exact = rows.find((r) => r.alias_norm === n);
    if (exact) return { community_id: exact.community_id, gl_account_id: exact.gl_account_id, alias: exact.alias };
    const contained = rows.find((r) => r.alias_norm && (n.includes(r.alias_norm) || r.alias_norm.includes(n)));
    return contained ? { community_id: contained.community_id, gl_account_id: contained.gl_account_id, alias: contained.alias } : null;
  } catch (e) { console.warn('[community_alias] resolve failed:', e.message); return null; }
}

/**
 * Remember that `hint` means `communityId`. Called when a human manually links
 * an email that carried a hint we couldn't auto-resolve — so the next one routes
 * itself. Never overwrites an existing alias (a human's earlier mapping wins).
 */
async function learnCommunityAlias({ hint, communityId, aliasType = 'other', createdBy = null }) {
  const alias = String(hint || '').trim();
  const n = norm(alias);
  if (!n || !communityId) return { skipped: true };
  // Don't learn a community's own name — that already resolves.
  try {
    const { data: com } = await supabase.from('communities').select('name').eq('id', communityId).maybeSingle();
    if (com && norm(com.name) === n) return { skipped: true, reason: 'alias equals the community name' };
    const { error } = await supabase.from('community_aliases').insert({
      community_id: communityId, alias, alias_norm: n, alias_type: aliasType, created_by: createdBy || 'learned from manual link',
    });
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return { skipped: true };
      if (/duplicate|unique/i.test(error.message)) return { skipped: true, reason: 'already known' };
      throw error;
    }
    return { ok: true, alias };
  } catch (e) { console.warn('[community_alias] learn failed:', e.message); return { skipped: true, error: e.message }; }
}

module.exports = { resolveCommunityByAlias, learnCommunityAlias, norm };
