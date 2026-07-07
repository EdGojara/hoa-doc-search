// ============================================================================
// /api/agent-training — admin-only console for training Claire (voice) + askEd
// ----------------------------------------------------------------------------
// Two surfaces backed by one unified playbook:
//   Claire = homeowner-facing voice agent (lib/voice/reason.js)
//   askEd  = staff-facing chat (server.js /api/ask*)
//
// Both call getRelevantPlaybook() at inference time, so any entry saved via
// THIS console immediately affects the next real call/chat (no redeploy).
//
// Endpoints:
//   POST /api/agent-training/turn
//     Runs one conversation turn for the selected agent + community context.
//     Returns the AI response PLUS the playbook entries used + retrieval
//     chunks pulled, so the operator can see the reasoning.
//
//   POST /api/agent-training/playbook-entry
//     Saves a correction as a new playbook entry. Embeds it via the same
//     ada-002 model the rest of the playbook uses; sets applies_to so the
//     entry only affects the persona Ed was training.
//
//   GET /api/agent-training/playbook-entries
//     Lists recent playbook entries (paginated). Lets the operator audit
//     what they've taught the system.
//
// Record ownership (CLAUDE.md): workpaper. The playbook + training history
// is Bedrock's institutional intelligence, not transferable on termination.
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { safeErrorMessage } = require('./_safe_error');
const { getRelevantPlaybook, formatPlaybookContext } = require('../playbook');
const { requireAdmin } = require('./_require_admin');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const VALID_AGENTS = new Set(['claire', 'asked']);

const router = express.Router();

// ----------------------------------------------------------------------------
// System-prompt builders per agent. The training console runs THE SAME
// reasoning logic the production surfaces use — only the system prompt
// differs by agent. Keep these in lockstep with lib/voice/reason.js (Claire)
// and the askEd handler in server.js (asked) so training reflects reality.
// ----------------------------------------------------------------------------

function claireSystemPrompt({ communityName, communityContext, playbookContext, docsContext }) {
  return `You are Claire — Bedrock Association Management's AI voice assistant for ${communityName || 'this community'}.

VOICE-AGENT IDENTITY RULES (CLAUDE.md > Bedrock voice persona):
  - First sentence MUST identify you as Bedrock's AI assistant (honest-AI rule).
  - Never pretend to be a specific human Bedrock employee.
  - Tone: warm, conversational, brief. Specificity + brevity + honesty are the human signal.
  - Hard refusals: NEVER grant a waiver, decide a violation, or assert a legal position.
    Anything touching enforcement / §209 / fines / fee disputes → offer human handoff.
  - Handoff phrasing: never "press 1." Always conversational ("want me to put you through to the team?").
  - This is the TRAINING CONSOLE — your response will be reviewed by an operator
    who may save corrections to the playbook. Be your best self.

COMMUNITY CONTEXT:
${communityContext || '(no community selected — answer generically)'}

PLAYBOOK GUIDANCE (apply these patterns/rules):
${playbookContext || '(no relevant playbook entries)'}

RETRIEVED COMMUNITY KNOWLEDGE:
${docsContext || '(no documents matched)'}

Respond in plain text (no markdown). One concise paragraph unless the caller asked something that genuinely needs more. End with an offer to help further or a handoff offer when appropriate.`;
}

function askedSystemPrompt({ communityName, communityContext, playbookContext, docsContext }) {
  return `You are askEd — Bedrock Association Management's internal AI assistant for staff (NOT homeowners).

STAFF-AGENT IDENTITY RULES:
  - You're talking to a Bedrock manager. Direct, technical, terse is fine.
  - Always cite the source document or migration when stating a fact (lets staff verify).
  - Always include statutory citations (Texas §209.xxxx) when relevant — staff is the decision-maker.
  - Don't refuse compliance questions; staff needs the answer to make the call.
  - This is the TRAINING CONSOLE — your response will be reviewed by an operator
    who may save corrections to the playbook. Be your most useful self.

COMMUNITY CONTEXT:
${communityContext || '(no community selected — answer generically)'}

PLAYBOOK GUIDANCE (apply these patterns/rules):
${playbookContext || '(no relevant playbook entries)'}

RETRIEVED COMMUNITY KNOWLEDGE:
${docsContext || '(no documents matched)'}

Respond in markdown. Use bullets when listing multiple items. Cite sources inline.`;
}

// ----------------------------------------------------------------------------
// POST /api/agent-training/turn
// Runs one turn of conversation through the selected agent's pipeline.
//
// Body:
//   { agent: 'claire'|'asked',
//     community_id: uuid (optional — null = generic),
//     history: [{ role: 'user'|'assistant', content: string }, ...],
//     message: string (the new caller/staff message) }
//
// Returns:
//   { ok, response, agent, reasoning: {
//       playbook_entries: [{id, situation, similarity, ...}],
//       community_facts_count, docs_retrieved_count,
//       system_prompt: string (truncated, for transparency)
//     }
//   }
// ----------------------------------------------------------------------------
router.post('/turn', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    // Admin-only console (owner trains the agents). Enforced server-side.
    const admin = await requireAdmin(req, res);
    if (!admin) return; // 403 already sent
    const body = req.body || {};
    const agent = String(body.agent || 'claire').toLowerCase();
    if (!VALID_AGENTS.has(agent)) {
      return res.status(400).json({ error: `invalid agent: ${agent}. Must be one of: ${[...VALID_AGENTS].join(', ')}` });
    }
    const message = String(body.message || '').trim();
    if (!message) return res.status(400).json({ error: 'message required' });
    const history = Array.isArray(body.history) ? body.history.slice(-20) : [];  // cap at last 20 turns

    // Resolve community context if requested
    let communityName = null;
    let communityContext = '';
    if (body.community_id) {
      try {
        const { data: c } = await supabase.from('communities')
          .select('id, name, slug')
          .eq('id', body.community_id)
          .maybeSingle();
        if (c) {
          communityName = c.name;
          communityContext = `Community: ${c.name} (${c.slug})`;
          // Pull community facts as additional context
          try {
            const { data: facts } = await supabase.from('community_facts')
              .select('fact_text')
              .eq('community_id', c.id)
              .eq('is_active', true)
              .limit(15);
            if (facts && facts.length > 0) {
              communityContext += '\n\nKey facts:\n' + facts.map((f) => `- ${f.fact_text}`).join('\n');
            }
          } catch (_) { /* fact retrieval is best-effort */ }
        }
      } catch (cErr) {
        console.warn('[agent-training] community lookup failed:', cErr.message);
      }
    }

    // Build a query string for retrieval — last few turns + new message
    const recentTurns = history.slice(-4).map((t) => `${t.role}: ${t.content}`).join('\n');
    const retrievalQuery = (recentTurns + '\n' + message).slice(-2000);

    // Retrieve relevant playbook entries (scoped to this agent)
    const playbookEntries = await getRelevantPlaybook(retrievalQuery, {
      matchCount: 6,
      agent,
    });
    const playbookContext = formatPlaybookContext(playbookEntries);

    // Doc retrieval — only if we have a community (otherwise context-free)
    let docsContext = '';
    let docsRetrievedCount = 0;
    if (body.community_id) {
      try {
        const { getRelevantChunks } = require('../lib/hybrid_retrieval');
        const chunks = await getRelevantChunks({
          query: retrievalQuery,
          communityId: body.community_id,
          topK: 6,
        });
        if (chunks && chunks.length > 0) {
          docsRetrievedCount = chunks.length;
          docsContext = chunks.map((c, i) => `[Source ${i + 1}: ${c.title || c.document_title || 'doc'}]\n${c.content || c.chunk_text || ''}`).join('\n\n');
        }
      } catch (rErr) {
        console.warn('[agent-training] doc retrieval failed:', rErr.message);
      }
    }

    // Build system prompt
    const systemPrompt = agent === 'claire'
      ? claireSystemPrompt({ communityName, communityContext, playbookContext, docsContext })
      : askedSystemPrompt({ communityName, communityContext, playbookContext, docsContext });

    // Build messages array for Claude
    const messages = [...history, { role: 'user', content: message }];

    // Call Claude
    const completion = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });
    const aiResponse = (completion.content || []).map((c) => c.text || '').join('').trim();

    res.json({
      ok: true,
      agent,
      response: aiResponse,
      reasoning: {
        playbook_entries: playbookEntries.map((e) => ({
          id: e.id,
          situation: e.situation,
          response: e.response,
          reasoning: e.reasoning,
          category: e.category,
          similarity: e.similarity,
          applies_to: e.applies_to,
        })),
        community_facts_loaded: !!communityContext,
        docs_retrieved_count: docsRetrievedCount,
        system_prompt_preview: systemPrompt.slice(0, 1500),
      },
    });
  } catch (err) {
    console.error('[agent-training] turn failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /api/agent-training/playbook-entry
// Save a correction as a new playbook entry. Embeds it via ada-002 so
// future getRelevantPlaybook() semantic search finds it.
//
// Body:
//   { applies_to: ['claire'|'asked', ...]  (default ['claire','asked']),
//     category, situation, response, reasoning,
//     training_dialogue, training_correction_target, training_correction_expected,
//     training_notes }
// ----------------------------------------------------------------------------
router.post('/playbook-entry', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    // Single-teacher learning: only the account owner's corrections encode into
    // the playbook. The system encodes ED's judgment, not the average of staff
    // edits. Enforced server-side, not just hidden in the admin-only UI.
    const admin = await requireAdmin(req, res);
    if (!admin) return; // 403 already sent
    const b = req.body || {};
    const situation = String(b.situation || '').trim();
    const response = String(b.response || '').trim();
    if (!situation) return res.status(400).json({ error: 'situation required' });
    if (!response)  return res.status(400).json({ error: 'response required' });

    // Sanitize applies_to
    const rawAppliesTo = Array.isArray(b.applies_to) ? b.applies_to : ['claire', 'asked'];
    const appliesTo = rawAppliesTo.filter((a) => VALID_AGENTS.has(String(a).toLowerCase()));
    if (appliesTo.length === 0) {
      return res.status(400).json({ error: 'applies_to must include at least one of: claire, asked' });
    }

    // Embed the situation text so semantic retrieval can find it
    let embedding = null;
    try {
      const cleaned = situation.replace(/\n+/g, ' ').slice(0, 8000);
      const emb = await openai.embeddings.create({
        model: 'text-embedding-ada-002',
        input: cleaned,
      });
      embedding = emb.data[0].embedding;
    } catch (embErr) {
      console.warn('[agent-training] embedding failed, saving without:', embErr.message);
    }

    const row = {
      situation,
      response,
      reasoning: b.reasoning || null,
      category: b.category || 'training_correction',
      tags: Array.isArray(b.tags) ? b.tags : [],
      applies_to: appliesTo,
      training_dialogue: b.training_dialogue || null,
      training_correction_target: b.training_correction_target || null,
      training_correction_expected: b.training_correction_expected || null,
      training_notes: b.training_notes || null,
      embedding,
    };

    const { data, error } = await supabase
      .from('playbook')
      .insert(row)
      .select('id, situation, response, reasoning, category, applies_to, created_at')
      .single();
    if (error) throw error;

    res.json({ ok: true, entry: data });
  } catch (err) {
    console.error('[agent-training] save entry failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /api/agent-training/playbook-entries?agent=&limit=&offset=
// List recent entries for the audit view. Filtered by agent when provided.
// ----------------------------------------------------------------------------
router.get('/playbook-entries', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    let q = supabase.from('playbook')
      .select('id, situation, response, reasoning, category, applies_to, training_correction_target, training_correction_expected, training_notes, created_at')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (req.query.agent && VALID_AGENTS.has(String(req.query.agent).toLowerCase())) {
      q = q.contains('applies_to', [String(req.query.agent).toLowerCase()]);
    }
    const { data, error } = await q;
    if (error) throw error;
    res.json({ entries: data || [] });
  } catch (err) {
    console.error('[agent-training] list entries failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
