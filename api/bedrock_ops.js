// ============================================================================
// api/bedrock_ops.js  (Ed 2026-08-30)
// ----------------------------------------------------------------------------
// The INTERNAL Bedrock-ops team surface — owner-gated. These agents run the
// company (growth, HR), not communities, so this is deliberately separate from
// every community-facing team surface and is visible only to the owner.
// ============================================================================
const express = require('express');
const router = express.Router();
const ops = require('../lib/team/bedrock_ops');
const { requireAdmin } = require('./_require_admin');
function safe(err) { try { return require('./_safe_error').safeErrorMessage(err); } catch (_) { return 'Something went wrong'; } }

// The internal roster — OWNER ONLY. Never exposed on a community surface.
router.get('/team', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res); if (!admin) return; // 403 sent
    const team = ops.people().map((m) => ({
      persona: m.persona, name: m.name, title: m.title,
      lane: m.lane, domain: m.domain, emoji: m.emoji,
      mailbox: m.mailbox, voice_note: m.voice_note || null,
      photo: `/assets/presentations/team-internal/${m.persona}.jpg`,
    }));
    res.json({ ok: true, team });
  } catch (err) { console.error('[bedrock-ops] team failed:', err.message); res.status(500).json({ error: safe(err) }); }
});

module.exports = router;
