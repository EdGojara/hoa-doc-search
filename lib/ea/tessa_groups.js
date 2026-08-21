// ============================================================================
// lib/ea/tessa_groups.js — "staff" is a group, not somebody's surname.
// ----------------------------------------------------------------------------
// Ed 2026-08-21: "this is totally wrong."
//
// He asked Tessa: "can you send email to staff to introduce them to ai team and
// what each of you does."
//
// She addressed it to STAFFORD BECK <stafford.beck@vantaca.com>.
//
// "staff" went through the ordinary contact search, ILIKE %staff% matched
// "Stafford Beck", it was the ONLY match, and a single match auto-fills the To
// field. An internal introduction to Bedrock's own team was one click from
// going to an employee of Vantaca — the software vendor we are migrating off.
//
// contactMatchesHint did not stop it either: "staff" is five characters, so it
// is past the short-hint whole-word rule and "stafford beck".includes("staff")
// is true. The rule was written to stop two-letter hints matching inside domain
// names; it was never going to stop this.
//
// THE FIX IS CATEGORICAL, not another scoring tweak. A word that names a GROUP
// must never resolve to an individual. If the group cannot be resolved she
// asks, because "I don't know who you mean by staff" costs a sentence and
// mailing the wrong company costs a great deal more.
//
// The same reasoning as project_canyon_gate_role_aliases: who a message is
// addressed to is not a fuzzy-match problem.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Words that name a group of people. None of these may ever match a person,
// however good the string similarity looks.
const GROUP_WORDS = [
  { re: /^(?:the\s+)?staff$/i, kind: 'staff' },
  { re: /^(?:our|the)?\s*team$/i, kind: 'staff' },
  { re: /^(?:the\s+)?(?:whole|entire|full)\s+(?:team|staff|office)$/i, kind: 'staff' },
  { re: /^everyone$/i, kind: 'staff' },
  { re: /^every(?:one|body)\s+(?:here|at\s+bedrock|on\s+the\s+team)$/i, kind: 'staff' },
  { re: /^all\s+staff$/i, kind: 'staff' },
  { re: /^(?:the\s+)?office$/i, kind: 'staff' },
  { re: /^(?:the\s+)?(?:managers?|management)$/i, kind: 'staff' },
  { re: /^(?:the\s+)?ai\s+team$/i, kind: 'ai_team' },
  { re: /^(?:the\s+)?(?:agents?|personas?)$/i, kind: 'ai_team' },
];

/** Does this hint name a group? Returns { kind } or null. */
function parseGroupWord(hint) {
  const h = String(hint || '').trim().replace(/\s+/g, ' ');
  if (!h) return null;
  for (const g of GROUP_WORDS) if (g.re.test(h)) return { kind: g.kind, hint: h };
  return null;
}

/**
 * The people who actually work at Bedrock.
 *
 * portal_users is the only roster of humans the platform keeps. Only ACTIVE
 * accounts, and never Tessa's own mailbox or a persona address — mailing the
 * AI team about the AI team is not what anyone means by "staff".
 */
async function resolveStaffGroup({ excludeEmails = [] } = {}) {
  const { data, error } = await supabase.from('portal_users')
    .select('email, full_name, role, status')
    .ilike('email', '%@bedrocktx.com')
    .eq('status', 'active')
    .order('email');
  if (error) {
    console.warn('[tessa_groups] staff lookup failed:', error.message);
    return { people: [], error: error.message };
  }

  // Persona mailboxes are not staff. They are where the AI team receives mail.
  let personas = [];
  try {
    const gs = require('../email/graph_send');
    personas = ['CLAIRE', 'EMMA', 'TESSA', 'ANNIE', 'MIRANDA', 'PAIGE', 'REESE', 'KAT', 'AMANDA', 'BILLING']
      .map((k) => String(gs[`${k}_MAILBOX`] || '').toLowerCase()).filter(Boolean);
  } catch (_) { /* fall through with an empty list */ }

  const skip = new Set([...personas, ...excludeEmails.map((e) => String(e || '').toLowerCase())]);
  const people = (data || [])
    .filter((p) => p.email && !skip.has(String(p.email).toLowerCase()))
    .map((p) => ({ name: p.full_name || p.email, email: p.email, role: p.role, source: 'staff_roster' }));

  return { people };
}

/**
 * The AI team, from the roster. Used when Ed asks Tessa to write ABOUT the
 * team — see teamFactsForPrompt below for why that matters.
 */
function resolveAiTeamGroup() {
  try {
    const { knownIdentities } = require('./tessa_identity');
    return { people: knownIdentities().filter((p) => p.persona) };
  } catch (e) {
    console.warn('[tessa_groups] ai team lookup failed:', e.message);
    return { people: [] };
  }
}

/**
 * Ground truth about the AI team, as text for a prompt.
 *
 * Ed 2026-08-21, same email: Tessa wrote that "Kat Reed works with board
 * members, helping them stay informed and engaged" — Kat is the ACCOUNTING
 * MANAGER — and introduced "Daniel Ibarra", who does not exist. She left out
 * Claire, Emma, Annie, Miranda, Amanda, Reese and Paige entirely.
 *
 * She invented her own colleagues because nothing put the roster in front of
 * her. lib/team/roster.js is the single source of truth for who works here and
 * what they do; this is what hands it to the model instead of letting it guess.
 *
 * Same shape as the day's other bugs: the data existed and nothing read it.
 */
function teamFactsForPrompt() {
  let roster = [];
  try { roster = require('../team/roster').ROSTER || []; } catch (_) { return ''; }
  if (!roster.length) return '';
  const lines = roster
    .filter((p) => p && p.name)
    .map((p) => {
      const title = p.signature_title || p.title || '';
      const domain = p.domain || p.lane || '';
      return `- ${p.name}${title ? ` — ${title}` : ''}${domain ? `: ${domain}` : ''}`;
    });
  return 'THE AI TEAM AT BEDROCK. This is the complete and only list. Do not add\n'
    + 'anyone to it, do not change what anyone does, and do not leave anyone out:\n'
    + `${lines.join('\n')}\n`;
}

module.exports = { parseGroupWord, resolveStaffGroup, resolveAiTeamGroup, teamFactsForPrompt, GROUP_WORDS };
