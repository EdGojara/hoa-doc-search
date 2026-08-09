// =============================================================================
// Board Vote API — no-login email ballot (Ed 2026-08-09)
// =============================================================================
// Mounted at /api/board-vote. Public (no staff gate, no board session): the
// AUTH is the HMAC-signed token in the emailed ballot link, which encodes the
// voter's identity, so a member can only ever cast THEIR OWN vote. Records
// through the SAME recordMotionVote() path the portal uses, tagged source
// 'email', so a vote is identical however it arrives.
// =============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { verifyVoteToken } = require('../lib/board/vote_token');
const { recordMotionVote, activeRoster, evaluateMotion } = require('./board_motions');
const { sendEmail } = require('../lib/notifications/email');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();
const VOTES = ['for', 'against', 'abstain'];

function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Verify the token, load the motion, confirm the token's voter is on the active
// board. Returns { motion, member } or { error }.
async function loadMotionAndVoter(token) {
  const v = verifyVoteToken(token);
  if (!v.ok) return { error: v.reason || 'invalid_token' };
  const { data: motion, error } = await supabase.from('board_motions').select('*').eq('id', v.motion_id).maybeSingle();
  if (error) throw error;
  if (!motion) return { error: 'motion_not_found' };
  const roster = await activeRoster(motion.community_id);
  const member = roster.find((m) => m.email === v.voter_email);
  if (!member) return { error: 'not_a_board_member' };
  return { motion, member };
}

// GET /api/board-vote/context?token=... — data for the ballot page.
router.get('/context', async (req, res) => {
  try {
    const r = await loadMotionAndVoter(req.query.token);
    if (r.error) return res.status(400).json({ error: r.error });
    const { motion, member } = r;
    let communityName = '';
    try {
      const { data } = await supabase.from('communities').select('name').eq('id', motion.community_id).maybeSingle();
      communityName = data ? data.name : '';
    } catch (_) { /* non-fatal */ }
    const { data: votes } = await supabase.from('board_motion_votes')
      .select('voter_email, vote').eq('motion_id', motion.id);
    const mine = (votes || []).find((x) => String(x.voter_email).trim().toLowerCase() === member.email);
    res.json({
      ok: true,
      motion: { id: motion.id, title: motion.title, description: motion.description, status: motion.status, motion_type: motion.motion_type, threshold: motion.threshold },
      community_name: communityName,
      voter_name: member.name || member.email,
      votable: motion.status === 'open',
      my_vote: mine ? mine.vote : null,
      tally: evaluateMotion(motion, votes || []),
    });
  } catch (err) {
    console.error('[board_vote] context failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /api/board-vote/cast { token, vote, comment } — record the vote.
router.post('/cast', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const token = (req.body && req.body.token) || req.query.token;
    const r = await loadMotionAndVoter(token);
    if (r.error) return res.status(400).json({ error: r.error });
    const { motion, member } = r;
    if (motion.status !== 'open') return res.status(409).json({ error: 'motion_closed', message: 'This motion is closed to voting.' });
    const vote = String((req.body && req.body.vote) || '').trim().toLowerCase();
    if (!VOTES.includes(vote)) return res.status(400).json({ error: 'invalid_vote', message: 'Vote must be for, against, or abstain.' });

    const { tally, motion: updated } = await recordMotionVote({
      motion, voterEmail: member.email, voterName: member.name || member.email,
      vote, comment: req.body && req.body.comment, source: 'email',
    });

    // Recorded-copy confirmation — to the voter, BCC the records address so the
    // association keeps an email trail of the ballot. Kill-switched like all
    // board email (BOARD_NOTIFY_ENABLED); the vote itself always records.
    if (process.env.BOARD_NOTIFY_ENABLED === '1') {
      const label = { for: 'FOR', against: 'AGAINST', abstain: 'ABSTAIN' }[vote];
      const first = String(member.name || '').split(' ')[0] || 'there';
      sendEmail({
        to: member.email,
        replyTo: process.env.BOARD_VOTE_INBOX || 'vote@bedrocktx.com',
        bcc: process.env.BOARD_RECORDS_EMAIL || process.env.BOARD_VOTE_INBOX || 'vote@bedrocktx.com',
        subject: `Vote recorded, ${label}: ${motion.title}`,
        html: `<div style="font-family:Inter,-apple-system,sans-serif;color:#1a2230;max-width:520px;">
          <p>Hi ${escapeHtml(first)},</p>
          <p>Your board vote has been recorded:</p>
          <p style="font-size:15px;"><b>${label}</b> on "${escapeHtml(motion.title)}".</p>
          <p style="color:#64748b;font-size:12px;">If this was not you, contact your community manager. This message is a record copy.</p>
        </div>`,
        tags: [{ name: 'module', value: 'board_motion' }, { name: 'event', value: 'vote_recorded' }],
      }).catch(() => {});
    }
    res.json({ ok: true, your_vote: vote, status: updated.status, tally });
  } catch (err) {
    console.error('[board_vote] cast failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
