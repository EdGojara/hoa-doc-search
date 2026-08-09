// ============================================================================
// lib/board/vote_reply.js  (Ed 2026-08-09)
// ----------------------------------------------------------------------------
// Reply-to-vote — the Annie/ACC pattern for board votes. A director just replies
// to the "vote needed" email with "yes" / "approve" / "I vote against", and this
// resolves the sender to a board member, the reply to the right open motion, and
// the words to a vote — then records it through the SAME recordMotionVote() path
// the portal and one-click ballot use.
//
// Safety first: votes are high-stakes, so intent is parsed with an explicit
// UNCLEAR escape hatch. If the sender isn't a board member, no open motion needs
// their vote, the target is ambiguous, or the words aren't a clear vote, this
// records NOTHING and returns a status so the caller can reply with the
// one-click buttons instead. It never guesses a vote.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const { recordMotionVote, activeRoster } = require('../../api/board_motions');

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// Strip quoted history / signatures so we read only what the member just wrote.
function topOfReply(body) {
  let t = String(body || '');
  // Cut at common reply markers.
  const cuts = [/\nOn .*wrote:/i, /\n-----Original Message-----/i, /\n________________________________/, /\nFrom: /i, /\n>/];
  for (const re of cuts) { const m = t.search(re); if (m > 0) t = t.slice(0, m); }
  return t.trim().slice(0, 1200);
}

// Deterministic keyword read — a cheap first pass / cross-check.
function keywordVote(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const has = (w) => t.includes(' ' + w + ' ');
  if (has('abstain') || has('abstaining') || has('abstention')) return 'abstain';
  const forHit = ['approve', 'approved', 'aye', 'yes', 'yea', 'support', 'agree', 'agreed', 'favor'].some(has) || t.includes(' in favor ') || t.includes(' i vote for ') || t.includes(' vote for ');
  const againstHit = ['against', 'oppose', 'opposed', 'nay', 'deny', 'denied', 'reject', 'rejected', 'disagree', 'decline', 'declined'].some(has) || t.includes(' vote against ') || t.includes(' i vote against ') || t.includes(' opposed to ');
  if (forHit && !againstHit) return 'for';
  if (againstHit && !forHit) return 'against';
  return 'unclear';
}

// AI intent with an explicit unclear escape. Falls back to keyword if no key.
async function parseVoteIntent(replyText, motionTitle) {
  const kw = keywordVote(replyText);
  if (!anthropic) return kw;
  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 8,
      messages: [{ role: 'user', content:
        `A board member replied to an email asking them to vote on this motion:\n"${String(motionTitle || '').slice(0, 200)}"\n\nTheir reply:\n"${String(replyText || '').slice(0, 1000)}"\n\nHow are they voting? Answer with EXACTLY one token: for, against, abstain, or unclear. If you cannot tell with high confidence, answer unclear.` }],
    });
    const t = (r.content?.[0]?.text || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    const ai = ['for', 'against', 'abstain', 'unclear'].includes(t) ? t : 'unclear';
    // Cross-check: if AI and a confident keyword read disagree, don't guess.
    if (ai !== 'unclear' && kw !== 'unclear' && ai !== kw) return 'unclear';
    return ai;
  } catch (_) { return kw; }
}

// Pick which open motion this reply is about, when the member has more than one.
async function resolveTargetMotion(candidates, subject, replyText) {
  if (candidates.length === 1) return candidates[0];
  // String match: title tokens present in the subject (replies keep "Re: <subj>").
  const subj = String(subject || '').toLowerCase();
  const scored = candidates.map((m) => {
    const toks = String(m.title || '').toLowerCase().split(/\W+/).filter((w) => w.length >= 4);
    const hit = toks.filter((w) => subj.includes(w)).length;
    return { m, hit };
  }).sort((a, b) => b.hit - a.hit);
  if (scored[0].hit >= 2 && (scored.length < 2 || scored[0].hit > scored[1].hit)) return scored[0].m;
  // AI disambiguation as a last resort.
  if (anthropic) {
    try {
      const list = candidates.map((m, i) => `${i}: ${m.title}`).join('\n');
      const r = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 6,
        messages: [{ role: 'user', content: `Open board motions:\n${list}\n\nEmail subject: "${subject}"\nEmail body: "${String(replyText || '').slice(0, 600)}"\n\nWhich motion number is this reply about? Answer with just the number, or "none" if unclear.` }],
      });
      const t = (r.content?.[0]?.text || '').trim().replace(/[^0-9]/g, '');
      const idx = parseInt(t, 10);
      if (Number.isInteger(idx) && candidates[idx]) return candidates[idx];
    } catch (_) { /* fall through to ambiguous */ }
  }
  return null;
}

// Main entry. supabase is passed in (trusted caller). Returns a status object;
// only 'recorded' has written anything.
async function resolveVoteReply(supabase, { from, subject, body }) {
  const email = String(from || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return { status: 'no_member', reason: 'no sender' };

  // Sender must be an active board member somewhere.
  const { data: seats, error: se } = await supabase.from('board_members')
    .select('community_id, name, email').eq('is_active', true).ilike('email', email);
  if (se) throw se;
  if (!seats || !seats.length) return { status: 'no_member', email };
  const name = seats.find((s) => s.name)?.name || email;
  const communityIds = [...new Set(seats.map((s) => s.community_id).filter(Boolean))];

  // Open motions in their communities that they have NOT yet voted on.
  const { data: openMotions, error: me } = await supabase.from('board_motions')
    .select('*').in('community_id', communityIds).eq('status', 'open');
  if (me) throw me;
  if (!openMotions || !openMotions.length) return { status: 'no_open_motion', name };
  const { data: myVotes } = await supabase.from('board_motion_votes')
    .select('motion_id').in('motion_id', openMotions.map((m) => m.id)).ilike('voter_email', email);
  const voted = new Set((myVotes || []).map((v) => v.motion_id));
  const candidates = openMotions.filter((m) => !voted.has(m.id));
  if (!candidates.length) return { status: 'already_voted', name };

  const reply = topOfReply(body);
  // Deterministic first: a "[WAT-3F9A]" ref in the subject pins the exact motion
  // (validated here against the sender's OWN open, unvoted candidates).
  let motion = null;
  const refMatch = String(subject || '').match(/\[([A-Z0-9]{2,4}-[A-Z0-9]{3,6})\]/i);
  if (refMatch) {
    const wanted = refMatch[1].toUpperCase();
    motion = candidates.find((m) => String(m.ref_code || '').toUpperCase() === wanted) || null;
  }
  // Otherwise fall back to single-open / subject-title / AI resolution.
  if (!motion) motion = await resolveTargetMotion(candidates, subject, reply);
  if (!motion) return { status: 'ambiguous', name, candidates: candidates.map((m) => ({ id: m.id, title: m.title })) };

  const vote = await parseVoteIntent(reply, motion.title);
  if (!['for', 'against', 'abstain'].includes(vote)) return { status: 'unclear', name, motion: { id: motion.id, title: motion.title } };

  const { tally, motion: updated } = await recordMotionVote({
    motion, voterEmail: email, voterName: name, vote,
    comment: reply.length <= 300 ? reply : null, source: 'email',
  });
  return { status: 'recorded', name, vote, motion: { id: updated.id, title: updated.title, status: updated.status }, tally };
}

module.exports = { resolveVoteReply, keywordVote, topOfReply, parseVoteIntent };
