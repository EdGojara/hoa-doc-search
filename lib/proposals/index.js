// ============================================================================
// lib/proposals/index.js  (2026-09-20)
// ----------------------------------------------------------------------------
// The Proposal domain registry. A management proposal is a prospect/community-
// specific commercial document (scope, management fee, onboarding fee, term) —
// a DIFFERENT business object from a demo presentation. It lived under
// lib/presentations/board.js by historical accident; it now lives here so its
// identity matches its purpose. See project_presentation_dual_source_tech_debt
// and the presentation/proposal domain split (Ed 2026-09-20).
// ============================================================================
const management_proposal = require('./management_proposal');

const TEMPLATES = { management_proposal };

function listTemplates() {
  return Object.values(TEMPLATES).map((t) => ({
    slug: t.slug,
    title: t.title,
    description: t.description,
    variables: t.variables || [],
    imageSlots: t.imageSlots || [],
  }));
}

function getTemplate(slug) {
  return TEMPLATES[slug] || null;
}

module.exports = { listTemplates, getTemplate };
