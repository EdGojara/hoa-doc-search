// ============================================================================
// lib/email/team_roster.js  (Ed 2026-07-15)
// ----------------------------------------------------------------------------
// Who works here. Every AI teammate needs this before it writes to an outsider.
//
// Ed, on Emma's draft to Superior LawnCare: "what kind of reply is this — i mean
// we don't need to reply but Martha Bravo is a team member that emma should
// know."
//
// The vendor had sent invoice 42778 to Martha Bravo, who is Bedrock staff
// (mbravo@bedrocktx.com). Emma's context is the vendor, the email, and the AP
// ledger — and NOTHING about her own colleagues. So she read "Martha Bravo" as a
// stranger, concluded the invoice had come to us by mistake, and drafted:
//
//   "I think this invoice was sent to us by mistake, we're Bedrock Association
//    Management, not Martha Bravo."
//
// The invoice was addressed correctly. Martha IS us. Emma was one approval away
// from telling a vendor we'd never heard of our own AP staffer, and asking them
// to resend an invoice that had already arrived at the right place.
//
// This is project_platform_self_knowledge applied to PEOPLE rather than screens:
// a teammate who doesn't know the team isn't a teammate, and every persona that
// writes outward hits this the moment a correspondent names a colleague.
//
// AI teammates are on the roster too — a vendor writing to "Emma" should not have
// Emma wonder who that is.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// The AI team. Not in user_profiles (they aren't sign-in accounts), but they are
// absolutely people a correspondent will name.
const AI_TEAM = [
  { full_name: 'Claire', email: 'claire@bedrocktx.com', role: 'front office / homeowner correspondence (AI)' },
  { full_name: 'Emma Brooks', email: 'emma@bedrocktx.com', role: 'accounts payable (AI)' },
  { full_name: 'Annie Reeves', email: 'annie@bedrocktx.com', role: 'architectural review, ACC/ARC (AI)' },
  { full_name: 'Miranda Pierce', email: 'miranda@bedrocktx.com', role: 'compliance / deed restrictions (AI)' },
];

let _cache = null;
let _cachedAt = 0;
const TTL_MS = 10 * 60 * 1000;

/** Active humans + the AI team. Cached — this is asked on every draft. */
async function getTeam() {
  if (_cache && Date.now() - _cachedAt < TTL_MS) return _cache;
  let humans = [];
  try {
    const { data, error } = await supabase.from('user_profiles')
      .select('full_name, email, role, is_active')
      .order('full_name');
    if (error) throw error;
    humans = (data || [])
      .filter((u) => u.is_active !== false && u.email)
      .map((u) => ({ full_name: u.full_name || String(u.email).split('@')[0], email: u.email, role: u.role || 'staff' }));
  } catch (e) {
    // Never fail a draft over this. But say so loudly — a persona writing to an
    // outsider without knowing its own team is exactly the bug this file exists
    // to prevent, and silence would let it recur invisibly.
    console.error('[team_roster] could not load the team — personas will not recognise colleagues by name:', e.message);
  }
  _cache = [...humans, ...AI_TEAM];
  _cachedAt = Date.now();
  return _cache;
}

/**
 * The roster block for a persona's system prompt, plus the rule that makes it
 * matter. Returns '' when the roster couldn't load, so the prompt degrades to
 * what it was rather than asserting an empty team.
 */
async function teamRosterBlock() {
  const team = await getTeam();
  if (!team.length) return '';
  const lines = team.map((t) => `- ${t.full_name} <${t.email}> — ${t.role}`).join('\n');
  return `

YOUR COLLEAGUES AT BEDROCK — these people work here with you:
${lines}

Rules about your own team:
- If a correspondent addresses, copies, or mentions any of the people above, that person is YOUR COLLEAGUE. Never tell an outsider we don't know them, that they have the wrong company, or that something reached us by mistake because of a name on this list.
- Mail addressed to a colleague by name reached the RIGHT place. It is not misdirected. Do not ask anyone to resend it elsewhere.
- Anyone at @bedrocktx.com is one of us, even if they aren't listed above.
- If a colleague needs to act on it, say we'll route it internally. Never make the outsider do that work for us.`;
}

/** Test/refresh hook. */
function _clearCache() { _cache = null; _cachedAt = 0; }

module.exports = { getTeam, teamRosterBlock, _clearCache, AI_TEAM };
