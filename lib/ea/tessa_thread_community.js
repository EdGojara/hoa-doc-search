// ============================================================================
// lib/ea/tessa_thread_community.js — which community is this thread about?
// ----------------------------------------------------------------------------
// Ed 2026-08-21: "okay says came in before update but cant we add — i want to be
// able to give tessa command to reply to all board."
//
// He is right, and the fix is better than the thing it replaces. Reply-all
// rebuilt from a stored recipient list only works for mail that arrived after
// migration 380, and it copies whoever happened to be on that particular
// message. "Reply to the board" is a different and more useful instruction: it
// means the BOARD, resolved from the roster, whether or not every member was on
// this thread and whether or not we recorded who was.
//
// To do that she needs to know which association the thread belongs to. This
// works it out from what is in front of her, in order of how much the signal is
// worth:
//
//   1. the sender's email DOMAIN — director@canyongateatcincoranch.com is
//      unambiguous, and it is how board mail actually arrives
//   2. the sender being a BOARD MEMBER on file. This is what rescues the
//      threads that never name their community: "Contract deputy for 2027"
//      opens "Hi Board" and then says only "the MUD" and "the community" —
//      Alexis Geissler and Megan Shelledy are the only thing in it that says
//      Waterview, and both are on the roster
//   3. the subject line
//   4. the body — weakest, reported unconfident, because a community can be
//      mentioned in passing in a thread that is really about something else
//
// It returns a confidence and, when it genuinely cannot tell, nothing at all.
// Guessing which association a message belongs to is how mail lands at the
// wrong board, so an unsure answer must be a question, not a coin flip.
// (Ed's standing rule: the AI team asks for what it needs to do its job.)
// ============================================================================
const { matchCommunity, tokens } = require('./tessa_resolve');

// Domains that say nothing about which community a message concerns.
const GENERIC_DOMAINS = new Set([
  'gmail.com', 'hotmail.com', 'yahoo.com', 'outlook.com', 'aol.com', 'icloud.com',
  'live.com', 'msn.com', 'comcast.net', 'att.net', 'sbcglobal.net', 'verizon.net',
  'me.com', 'mac.com', 'protonmail.com', 'proton.me',
  'bedrocktx.com', 'bedrocktxai.com',   // ours — every community's mail comes through here
]);

function domainOf(email) {
  const at = String(email || '').lastIndexOf('@');
  return at < 0 ? '' : String(email).slice(at + 1).toLowerCase().trim();
}

// "canyongateatcincoranch.com" -> "canyon gate at cinco ranch"
//
// Community names are multi-word and domains are not, so the domain has to be
// split back into words before it can be matched. Without a dictionary the only
// honest approach is to try the whole string against each community's name with
// the spaces removed, which is exact and cheap.
function domainCandidates(domain) {
  const bare = domain.replace(/\.(com|net|org|us|co|info)$/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return bare ? [bare] : [];
}

// Match a squashed domain against a community name with its spaces removed.
async function communityByDomain(domain, listCommunities) {
  const cands = domainCandidates(domain);
  if (!cands.length) return null;
  const communities = await listCommunities();
  for (const bare of cands) {
    const hits = communities.filter((c) => {
      const squashed = String(c.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!squashed) return false;
      // Either direction: the domain may be shorter than the legal name
      // ("canyongate" vs "canyon gate at cinco ranch") or the same length.
      return squashed === bare || squashed.startsWith(bare) || bare.startsWith(squashed);
    });
    if (hits.length === 1) return hits[0];
    // More than one match is ambiguous and must not be resolved by picking one.
    if (hits.length > 1) return null;
  }
  return null;
}

// Find a community named in free text. Only counts a hit when exactly one
// community's distinctive words appear, so "the pool at Waterview and Canyon
// Gate" resolves to neither rather than to whichever is first.
async function communityInText(text, listCommunities) {
  const hay = String(text || '').toLowerCase();
  if (!hay.trim()) return null;
  const communities = await listCommunities();

  // A word that belongs to exactly one community is worth a match on its own.
  //
  // Requiring EVERY word of the legal name was too strict to be useful: mail
  // about Waterview Estates says "Waterview", never "Waterview Estates", so the
  // whole Contract-deputy thread resolved to nothing. But a shared word must
  // never match — "creek" belongs to both Drama Creek and Still Creek, and
  // picking one is how mail reaches the wrong association.
  const freq = new Map();
  for (const c of communities) {
    for (const w of new Set(tokens(c.name))) freq.set(w, (freq.get(w) || 0) + 1);
  }

  const hits = communities.filter((c) => {
    const words = tokens(c.name).filter((t) => t.length > 3);
    if (!words.length) return false;
    // (a) the full name is present
    if (words.every((w) => hay.includes(w))) return true;
    // (b) or one long word that no other community shares
    return words.some((w) => w.length >= 7 && freq.get(w) === 1 && hay.includes(w));
  });
  return hits.length === 1 ? hits[0] : null;
}

// Is this sender a board member we already know? Returns their community, or
// null when they are on none — or, deliberately, on more than one, because a
// person who sits on two boards tells us nothing about which one this thread is.
async function defaultCommunityForMember(email) {
  const addr = String(email || '').toLowerCase().trim();
  if (!addr) return null;
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { data, error } = await supabase
    .from('board_members')
    .select('name, email, community_id, community_name, is_active')
    .ilike('email', addr);
  if (error) { console.warn('[tessa] board member lookup failed:', error.message); return null; }
  const active = (data || []).filter((b) => b.is_active !== false);
  const rows = active.length ? active : (data || []);
  const communities = new Set(rows.map((r) => r.community_id).filter(Boolean));
  if (communities.size !== 1) return null;
  const r = rows[0];
  return { id: r.community_id, name: r.community_name, member: r.name };
}

// Work out the community for an ea_inbox row.
//
// Returns { community, how, confident } — community is null when she cannot
// tell, and the caller must then ASK rather than assume.
async function communityForThread(item, deps = {}) {
  const listCommunities = deps.listCommunities || (async () => {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { data, error } = await supabase.from('communities').select('id, name, slug, is_demo').order('name');
    if (error) throw error;
    return (data || []).filter((c) => !c.is_demo);
  });

  // 1. The sender's domain. Strongest signal by far: a board writing from
  //    president@theircommunity.com has told us exactly who they are.
  const dom = domainOf(item && item.from_email);
  if (dom && !GENERIC_DOMAINS.has(dom)) {
    const c = await communityByDomain(dom, listCommunities);
    if (c) return { community: c, how: `the sender's address (@${dom})`, confident: true };
  }

  // 2. The sender is a board member we have on file.
  //
  // Stronger than any mention in the text, and it is what rescues the threads
  // that never name their community at all. The "Contract deputy for 2027"
  // thread opens "Hi Board" and then says only "the MUD" and "the community" —
  // Alexis Geissler and Megan Shelledy are the only thing in it that identifies
  // Waterview, and both are on the roster. (Ed 2026-08-21.)
  const byMember = await (deps.communityForMember || defaultCommunityForMember)(item && item.from_email);
  if (byMember) return { community: byMember, how: `${byMember.member || 'the sender'} being on that board`, confident: true };

  // 3. The subject line.
  const subj = await communityInText(item && item.subject, listCommunities);
  if (subj) return { community: subj, how: 'the subject line', confident: true };

  // 3. The body. Weakest of the three — a community can be mentioned in passing
  //    in a thread that is really about something else — so it is reported as
  //    unconfident and the caller should confirm.
  const body = await communityInText((item && (item.body_full || item.body_preview)) || '', listCommunities);
  if (body) return { community: body, how: 'a mention in the message', confident: false };

  return { community: null, how: null, confident: false };
}

// Did Ed ask for a group rather than a reply to the sender?
//
// Deliberately narrow. "let the board know" is an instruction about recipients;
// "the board decided X" is him telling her a fact to put IN the reply. Matching
// the second would silently re-address his message to five people.
function wantsBoard(text) {
  const s = String(text || '').toLowerCase();
  if (!/\bboard\b/.test(s)) return false;

  // The board must be the OBJECT of the verb, so only articles, prepositions
  // and quantifiers may sit between them.
  //
  // A loose "[^.]{0,40}" gap matched "TELL him THE BOARD meets on the 15th" —
  // Ed stating a fact for the body — and would have silently re-addressed his
  // reply to five directors. An intervening pronoun or name means the board is
  // the subject of something he is SAYING, not who he is writing to. Getting
  // this wrong is worse than not having the feature.
  // Up to seven words may sit between the verb and "board" so a community can be
  // named — "send to the lakes of pine forest board" is six — but NOT an object
  // pronoun. Length is not what makes this safe; the pronoun guard is. A
  // pronoun means somebody else is being written to and the board is merely
  // being mentioned: "TELL HIM the board meets on the 15th".
  const verb = '(?:reply|respond|send|copy|cc|include|loop|forward|write|tell|let|update|notify|address)';
  const m = s.match(new RegExp(`\\b${verb}\\b((?:\\s+[a-z0-9'&-]+){0,7}?)\\s+board\\b`));
  if (m) {
    const gap = m[1] || '';
    const PRONOUN = /\b(?:him|her|them|me|us|you|himself|herself|themselves|he|she|they|it|its|his|their|our|my|your)\b/;
    if (!PRONOUN.test(gap)) return true;
  }

  // Standalone phrases that name the group on their own.
  return /\ball\s+(?:the\s+|of\s+the\s+)?board\b/.test(s)
      || /\b(?:whole|entire|full)\s+board\b/.test(s)
      || /\bboard\s+members\b/.test(s);
}

module.exports = { communityForThread, wantsBoard, domainOf, GENERIC_DOMAINS };
