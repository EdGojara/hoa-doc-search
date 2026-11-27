// ============================================================================
// lib/amanda/email_ask.js  (extracted 2026-11-27 from api/amanda_email.js POST /ask)
// ----------------------------------------------------------------------------
// "Email Martha and Alisha about ..." -> one parse (lib/ea/tessa_request.runRequest),
// people resolved from the directory, anything unclear returned as a question, never
// a guess. When every recipient resolves the draft is STAGED in Amanda's outbox for
// review; nothing is ever sent from here. Shared by the email desk route and by
// conversational assignments (lib/amanda/dispatch.js), so both stage exactly the same way.
// ============================================================================
const desk = require('./email_console');

const AMANDA_LOOKUP = { addressBook: false, staff: true };

async function stageEmailRequest(supabase, text, { createdBy, createdByName } = {}) {
  const { runRequest } = require('../ea/tessa_request');
  const { searchMailbox } = require('../email/graph_search');
  const { resolveRecipient } = require('../../api/tessa');
  const graphSend = require('../email/graph_send');
  const out = await runRequest(text, {
    resolveRecipient: (h) => resolveRecipient(h, AMANDA_LOOKUP),
    searchMailbox,
    mailboxes: graphSend.isConfigured() ? [graphSend.AMANDA_MAILBOX] : [],
    drafter: desk.draftAmandaEmail,
    onEdsBehalf: false,
    addressStore: require('../ea/address_status').supabaseStore(supabase),
  });
  const people = (list) => (list || []).map((p) => ({ name: p.name || null, email: p.email || null }));
  const base = { to: people(out.to), cc: people(out.cc), questions: out.questions || [] };
  if (out.degraded) return { ok: false, staged: false, ...base, error: 'not_understood', reply: 'Amanda could not work that one out. Try saying it a different way.' };
  if (out.questions && out.questions.length) return { ok: true, staged: false, ...base, reply: 'Amanda needs a little more before she can prepare this.' };
  if (!out.to.length) return { ok: true, staged: false, ...base, reply: 'Amanda could not tell who this should go to. Name the people or paste their addresses.' };
  if (!out.draft) return { ok: false, staged: false, ...base, error: 'draft_failed', reply: 'Amanda found the recipients but could not draft the email. Nothing was staged.' };
  const row = await desk.stageDraft(supabase, {
    to: out.to.map((p) => p.email), cc: out.cc.map((p) => p.email),
    toName: out.to.length === 1 ? out.to[0].name : null,
    subject: out.draft.subject, body: out.draft.body, createdBy,
    reason: `Asked by ${createdByName || createdBy}: "${String(text).slice(0, 300)}"`,
  });
  return { ok: true, staged: true, ...base, draft: { ...row, body_text: out.draft.body }, reply: 'Prepared and waiting in Amanda’s outbox for review. Nothing was sent.' };
}

module.exports = { stageEmailRequest, AMANDA_LOOKUP };
