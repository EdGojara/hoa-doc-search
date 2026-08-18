// ============================================================================
// api/system.js  (Ed 2026-08-18)
// ----------------------------------------------------------------------------
// GET /api/system/env-status — which configuration the RUNNING instance
// actually has, grouped by the capability it switches on.
//
// WHY THIS EXISTS. On 2026-08-18 Ed asked what he needed to add to Render, and
// neither of us could answer it: the local .env is visible, the deployed
// environment is not, so the honest answer was a guess. That is a bad way to
// run configuration whose failure mode is silence. Missing config here does
// not throw. Resend returns { skipped: true } and logs. HeyGen renders nothing.
// The scheduler's mail ingest returns manual_only. Twilio returns
// { ok:false, skipped:true }. Every one of those looks like "quiet day."
//
// So the deployed app reports on itself. NEVER returns a value, only whether a
// name is set, plus the length so a truncated or double-pasted paste is
// visible — that exact bug (STRIPE_WEBHOOK_SECRET pasted twice, 76 chars
// instead of ~38) cost a day in June and would have been obvious here.
//
// Admin-gated: the shape of your configuration is not staff-visible.
// ============================================================================
const express = require('express');
const router = express.Router();
const { requireAdmin } = require('./_require_admin');

// Grouped by what breaks when it is absent, because a bare list of variable
// names does not tell an operator what stops working.
const GROUPS = [
  {
    capability: 'Core',
    breaks: 'Nothing runs at all.',
    vars: ['SUPABASE_URL', 'SUPABASE_KEY', 'ANTHROPIC_API_KEY', 'TRUSTED_URL'],
  },
  {
    capability: 'Retrieval',
    breaks: 'Document search and askEd degrade or return nothing.',
    vars: ['OPENAI_API_KEY'],
  },
  {
    capability: 'Email in',
    breaks: 'No mailbox is ever read. Emma never sees a vendor invoice.',
    vars: ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET'],
  },
  {
    capability: 'Email in, automatically',
    breaks: 'Ingest only runs when a human clicks Pull inbox.',
    vars: ['EMAIL_INGEST_AUTO'],
    optional: true,
  },
  {
    capability: 'Email out (notices)',
    breaks: 'Every notice the platform "sent" goes nowhere. Fails silently by design.',
    vars: ['RESEND_API_KEY', 'RESEND_FROM_EMAIL'],
  },
  {
    capability: 'Payments',
    breaks: 'Homeowners cannot pay. Without the webhook secret money moves and nothing posts to the books.',
    vars: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
  },
  {
    capability: 'Video',
    breaks: 'No teammate has a face. Explainers and the visit door go dark.',
    vars: ['HEYGEN_API_KEY', 'CLAIRE_AVATAR_ID', 'CLAIRE_VOICE_ID',
           'ISABELLA_AVATAR_ID', 'ISABELLA_VOICE_ID', 'PAIGE_AVATAR_ID', 'PAIGE_VOICE_ID'],
  },
  {
    capability: 'SMS',
    breaks: 'Violation nudges and Claire texting a caller a link do nothing.',
    vars: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'],
    optional: true,
  },
  {
    capability: 'Staff auth',
    breaks: 'Staff cannot sign in.',
    vars: ['STAFF_PASSWORD'],
  },
];

// Names that must never have their length reported either — length alone can
// narrow a short secret. Everything here is a credential, not an identifier.
const LENGTH_SAFE = /_(ID|URL|EMAIL|NUMBER|SID)$|^EMAIL_INGEST_AUTO$|^TRUSTED_URL$/;

router.get('/env-status', async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const groups = GROUPS.map((g) => {
      const vars = g.vars.map((name) => {
        const raw = process.env[name];
        const set = !!(raw && String(raw).trim());
        return {
          name,
          set,
          // Length only for identifiers, never for secrets. Enough to catch a
          // double-paste or a truncated copy without disclosing anything.
          length: set && LENGTH_SAFE.test(name) ? String(raw).trim().length : undefined,
        };
      });
      const missing = vars.filter((v) => !v.set).map((v) => v.name);
      return {
        capability: g.capability,
        optional: !!g.optional,
        status: missing.length === 0 ? 'ok' : (missing.length === g.vars.length ? 'off' : 'partial'),
        breaks_when_missing: g.breaks,
        missing,
        vars,
      };
    });
    const blocking = groups.filter((g) => !g.optional && g.status !== 'ok');
    res.json({
      ok: true,
      checked_at: new Date().toISOString(),
      // 'partial' is the dangerous one: half-configured capabilities are what
      // move money and then fail to record it.
      summary: {
        ok: groups.filter((g) => g.status === 'ok').length,
        partial: groups.filter((g) => g.status === 'partial').length,
        off: groups.filter((g) => g.status === 'off').length,
        blocking: blocking.map((g) => g.capability),
      },
      groups,
    });
  } catch (err) {
    console.error('[system] env-status failed:', err.message);
    res.status(500).json({ error: 'env_status_failed' });
  }
});

module.exports = router;
