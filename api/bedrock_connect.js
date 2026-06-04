// ============================================================================
// api/bedrock_connect.js
// ----------------------------------------------------------------------------
// STUB — Bedrock Connect (community-email broadcast) lives here. Build is
// queued behind Messaging System Phase 1. All routes return 501 with a clear
// pointer to the placeholder page + spec doc so anyone hitting them knows
// where to find the design and current status.
//
// Design spec: templates/bedrock-connect.spec.md
// Placeholder UI: public/bedrock-connect.html
// Mount path: /api/bedrock-connect (registered in server.js)
//
// When build starts, replace each stub with the real implementation. The
// route shapes below are the locked-in structural plan from the design spec
// — do not rename without updating the spec.
// ============================================================================

const express = require('express');
const router = express.Router();

const NOT_BUILT = (whichRoute) => ({
  error: 'not_implemented',
  message: `Bedrock Connect is queued behind Messaging System Phase 1. This route (${whichRoute}) is a structural placeholder.`,
  spec: 'templates/bedrock-connect.spec.md',
  placeholder_ui: '/bedrock-connect.html',
  status: 'placeholder',
});

// --- Brand kits (per community)
// GET    /brand-kits                          list all configured community brand kits
// GET    /brand-kits/:communityId             get the brand kit for one community
// PUT    /brand-kits/:communityId             create or update the brand kit
// POST   /brand-kits/:communityId/extract     auto-extract colors from uploaded logo
router.get('/brand-kits', (_req, res) => res.status(501).json(NOT_BUILT('GET /brand-kits')));
router.get('/brand-kits/:communityId', (_req, res) => res.status(501).json(NOT_BUILT('GET /brand-kits/:communityId')));
router.put('/brand-kits/:communityId', (_req, res) => res.status(501).json(NOT_BUILT('PUT /brand-kits/:communityId')));
router.post('/brand-kits/:communityId/extract', (_req, res) => res.status(501).json(NOT_BUILT('POST /brand-kits/:communityId/extract')));

// --- Templates (Bedrock-provided + custom)
// GET    /templates                           list all templates (filter by register, community)
// GET    /templates/:id                       get one template
// POST   /templates                           create custom template
// PATCH  /templates/:id                       edit (creates editable copy if Bedrock-provided)
// DELETE /templates/:id                       delete (only custom templates)
router.get('/templates', (_req, res) => res.status(501).json(NOT_BUILT('GET /templates')));
router.get('/templates/:id', (_req, res) => res.status(501).json(NOT_BUILT('GET /templates/:id')));
router.post('/templates', (_req, res) => res.status(501).json(NOT_BUILT('POST /templates')));
router.patch('/templates/:id', (_req, res) => res.status(501).json(NOT_BUILT('PATCH /templates/:id')));
router.delete('/templates/:id', (_req, res) => res.status(501).json(NOT_BUILT('DELETE /templates/:id')));

// --- Campaigns (the saved-design surface)
// GET    /campaigns                           list campaigns (filter by status, community)
// GET    /campaigns/:id                       campaign detail + blast history
// POST   /campaigns                           create from scratch or from template
// PATCH  /campaigns/:id                       edit (draft only)
// DELETE /campaigns/:id                       archive
// POST   /campaigns/:id/draft-with-claire     Claire drafts the email from a plain-English goal
// POST   /campaigns/:id/preview               render preview HTML for desktop + mobile
// POST   /campaigns/:id/send-test             send test to staff's own email
// POST   /campaigns/:id/audience-preview      run the segmentation query, return recipient count + sample
// POST   /campaigns/:id/schedule              schedule a future send
// POST   /campaigns/:id/send-now              send immediately
// POST   /campaigns/:id/cancel                cancel a scheduled send
router.get('/campaigns', (_req, res) => res.status(501).json(NOT_BUILT('GET /campaigns')));
router.get('/campaigns/:id', (_req, res) => res.status(501).json(NOT_BUILT('GET /campaigns/:id')));
router.post('/campaigns', (_req, res) => res.status(501).json(NOT_BUILT('POST /campaigns')));
router.patch('/campaigns/:id', (_req, res) => res.status(501).json(NOT_BUILT('PATCH /campaigns/:id')));
router.delete('/campaigns/:id', (_req, res) => res.status(501).json(NOT_BUILT('DELETE /campaigns/:id')));
router.post('/campaigns/:id/draft-with-claire', (_req, res) => res.status(501).json(NOT_BUILT('POST /campaigns/:id/draft-with-claire')));
router.post('/campaigns/:id/preview', (_req, res) => res.status(501).json(NOT_BUILT('POST /campaigns/:id/preview')));
router.post('/campaigns/:id/send-test', (_req, res) => res.status(501).json(NOT_BUILT('POST /campaigns/:id/send-test')));
router.post('/campaigns/:id/audience-preview', (_req, res) => res.status(501).json(NOT_BUILT('POST /campaigns/:id/audience-preview')));
router.post('/campaigns/:id/schedule', (_req, res) => res.status(501).json(NOT_BUILT('POST /campaigns/:id/schedule')));
router.post('/campaigns/:id/send-now', (_req, res) => res.status(501).json(NOT_BUILT('POST /campaigns/:id/send-now')));
router.post('/campaigns/:id/cancel', (_req, res) => res.status(501).json(NOT_BUILT('POST /campaigns/:id/cancel')));

// --- Blasts (each individual send)
// GET    /blasts                              list completed sends (filter by community, register, dates)
// GET    /blasts/:id                          metrics for one blast
// GET    /blasts/:id/recipients               per-recipient delivery/open/click status
// GET    /blasts/:id/replies                  inbound replies that landed in messaging system
router.get('/blasts', (_req, res) => res.status(501).json(NOT_BUILT('GET /blasts')));
router.get('/blasts/:id', (_req, res) => res.status(501).json(NOT_BUILT('GET /blasts/:id')));
router.get('/blasts/:id/recipients', (_req, res) => res.status(501).json(NOT_BUILT('GET /blasts/:id/recipients')));
router.get('/blasts/:id/replies', (_req, res) => res.status(501).json(NOT_BUILT('GET /blasts/:id/replies')));

// --- Analytics
// GET    /analytics/community/:communityId    per-community baselines + recent performance
// GET    /analytics/template/:templateId      per-template performance over time
// GET    /analytics/portfolio                 Ed's overall view across all communities
router.get('/analytics/community/:communityId', (_req, res) => res.status(501).json(NOT_BUILT('GET /analytics/community/:communityId')));
router.get('/analytics/template/:templateId', (_req, res) => res.status(501).json(NOT_BUILT('GET /analytics/template/:templateId')));
router.get('/analytics/portfolio', (_req, res) => res.status(501).json(NOT_BUILT('GET /analytics/portfolio')));

// --- Webhooks (Resend events: opens, clicks, bounces, etc.)
// POST   /webhooks/resend                     Resend webhook receiver
router.post('/webhooks/resend', (_req, res) => res.status(501).json(NOT_BUILT('POST /webhooks/resend')));

// --- Homeowner preferences (CAN-SPAM + per-category opt-out)
// GET    /preferences/:contactId              get a homeowner's current email prefs
// PATCH  /preferences/:contactId              update (homeowner-driven via portal)
// POST   /unsubscribe                         one-click unsubscribe (token-signed link from email footer)
router.get('/preferences/:contactId', (_req, res) => res.status(501).json(NOT_BUILT('GET /preferences/:contactId')));
router.patch('/preferences/:contactId', (_req, res) => res.status(501).json(NOT_BUILT('PATCH /preferences/:contactId')));
router.post('/unsubscribe', (_req, res) => res.status(501).json(NOT_BUILT('POST /unsubscribe')));

// --- Root: redirect any unmatched route to the placeholder UI
router.get('/', (_req, res) => {
  res.redirect('/bedrock-connect.html');
});

module.exports = router;
