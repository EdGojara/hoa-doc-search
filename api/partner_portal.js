// ============================================================================
// api/partner_portal.js  (Ed 2026-09-20)
// ----------------------------------------------------------------------------
// The Partner Association experience: one operating system, a different audience
// and entitlement than the board. A Partner Association (e.g. Cinco Residential
// Property Association) is an organizational client of a parent service org
// (e.g. CLMA). Every route resolves the partner viewer server-side via
// lib/portal/member_scope (staff View-As for now) and returns ONLY entitled
// information. Nothing here trusts the browser's member id as authorization.
//
// Routes:
//   GET  /context           -> who the partner is, its parent(s), entitled docs
//   POST /ask               -> "Ask CLMA", grounded ONLY in entitled documents
//   GET  /document/:id/url  -> a signed URL, but ONLY for an entitled document
// ============================================================================
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const {
  resolveMemberViewer, memberEntitledDocs, memberEntitledDocContext,
} = require('../lib/portal/member_scope');

// Ask CLMA speaks only from the documents the partner is entitled to. It cannot
// see other partner associations or CLMA's internal matters, by construction:
// the context it is handed already excludes them. The prompt reinforces, never
// substitutes for, that boundary.
const ASK_CLMA_SYSTEM = `You are the CLMA assistant, an AI helper for an authorized representative of a Partner Association served by Cinco Landscape Maintenance Association (CLMA).

WHAT YOU CAN SEE:
- Only the documents this Partner Association is entitled to, provided below. You have NO visibility into other partner associations, into CLMA's internal board matters, or into anything not in the excerpts you are given.

HOW TO ANSWER:
- Answer only from the provided document excerpts. Quote or paraphrase what they actually say.
- If the answer is not in the excerpts, say plainly that you do not have it in the documents available to this association, and offer to have the team follow up. Do NOT guess, and do NOT invent terms, dates, dollar amounts, or responsibilities.
- Never mention or imply information about any other association. Never assert a legal position or a binding interpretation of an agreement; point to the document and to the team for anything consequential.
- Be warm, plain, brief, and clear. Commas, not em-dashes. Write in English.
- You are AI, part of the CLMA service team. If asked, say so plainly. Never claim to have "confirmed with the team" or invent a source.`;

// GET /api/partner-portal/context?member=<communityId>
router.get('/context', async (req, res) => {
  try {
    const viewer = await resolveMemberViewer(req);
    if (!viewer) return res.status(403).json({ error: 'not_authorized' });
    const docs = await memberEntitledDocs(viewer);
    res.json({
      member: { id: viewer.memberCommunityId, name: viewer.memberName, organization_type: viewer.memberOrgType },
      parents: viewer.parents.map((p) => ({ name: p.parentName, type: p.type })),
      entitled_documents: docs.map((d) => ({ id: d.id, title: d.title, category: d.category })),
      acting_as: viewer.acting_as || null,
    });
  } catch (err) {
    console.error('[partner_portal] context failed:', err.message);
    res.status(500).json({ error: 'context_unavailable' });
  }
});

// POST /api/partner-portal/ask  { member, question }
router.post('/ask', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const viewer = await resolveMemberViewer(req);
    if (!viewer) return res.status(403).json({ error: 'not_authorized' });
    const question = String((req.body && req.body.question) || '').trim();
    if (!question) return res.status(400).json({ error: 'question_required' });
    if (question.length > 2000) return res.status(400).json({ error: 'question_too_long' });

    // Entitled documents ONLY, then context from ONLY those documents. The model
    // never receives an unentitled chunk — this is the security boundary.
    const docs = await memberEntitledDocs(viewer);
    const entitledIds = docs.map((d) => d.id);
    const { context, sources } = await memberEntitledDocContext(entitledIds);

    const parentName = (viewer.parents[0] && viewer.parents[0].parentName) || 'CLMA';
    const userContent = `You are answering for a representative of ${viewer.memberName}, a Partner Association served by ${parentName}.

They ask:
"${question}"

DOCUMENT EXCERPTS this association is entitled to (this is everything you may use; it may be empty):
${context || '(no entitled document content is available for this association yet)'}

Answer following your rules. If the excerpts do not contain the answer, say so plainly and offer to have the team follow up.`;

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const completion = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      system: ASK_CLMA_SYSTEM,
      messages: [{ role: 'user', content: userContent }],
    });
    const answer = (completion.content && completion.content[0] && completion.content[0].text) || '';

    // Log who asked what (no cross-partner data by construction).
    console.log('[partner_portal] ask', JSON.stringify({
      member: viewer.memberName, acted_by: viewer.acting_as && viewer.acting_as.staff,
      entitled_docs: entitledIds.length, q: question.slice(0, 200),
    }));

    res.json({
      answer,
      sources,
      grounded: !!context,
      disclaimer: 'This is CLMA’s AI assistant. Answers are drawn from the documents your association is entitled to. It is not legal advice and no substitute for your attorney.',
    });
  } catch (err) {
    console.error('[partner_portal] ask failed:', err.message);
    res.status(500).json({ error: 'ask_unavailable' });
  }
});

// GET /api/partner-portal/document/:id/url?member=<communityId>
// A signed URL, but ONLY when the document is in this partner's entitled set.
router.get('/document/:id/url', async (req, res) => {
  try {
    const viewer = await resolveMemberViewer(req);
    if (!viewer) return res.status(403).json({ error: 'not_authorized' });
    const docId = String(req.params.id || '').trim();
    const docs = await memberEntitledDocs(viewer);
    const doc = docs.find((d) => d.id === docId);
    if (!doc) return res.status(403).json({ error: 'not_entitled' }); // not entitled OR not found — same answer
    if (!doc.file_path) return res.status(404).json({ error: 'no_file' });
    const { data: signed, error } = await supabase.storage.from('documents')
      .createSignedUrl(doc.file_path, 60 * 60); // 1 hour
    if (error || !signed || !signed.signedUrl) return res.status(404).json({ error: 'no_file' });
    res.json({ url: signed.signedUrl, title: doc.title });
  } catch (err) {
    console.error('[partner_portal] document url failed:', err.message);
    res.status(500).json({ error: 'document_unavailable' });
  }
});

module.exports = router;
