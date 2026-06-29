// ============================================================================
// lib/enforcement/ai_category_mapper.js
// ----------------------------------------------------------------------------
// Bridge a batch of messy external (Vantaca) violation category labels to
// trustEd's canonical enforcement_categories slugs using Haiku. Vantaca labels
// are usually MORE specific than our canonical set (e.g. "Trash cans/Recycle
// Bins" vs canonical "Trash Cans/Recycling Containers", or "Mow and Edge" vs
// "lawn_maintenance"). Substring fuzzy-match can't bridge that gap reliably;
// this resolves ~90% of the remainder for ~$0.001.
//
// Canonical home for the label->slug mapper. The /vantaca-violations/preview
// endpoint (api/enforcement.js) still carries an inline copy of this same
// prompt — that path should be migrated to call this helper so the two import
// surfaces can never silently diverge (the script-vs-UI divergence is exactly
// what dropped a third of Eaglewood's violations on 2026-06-29).
//
//   const { aiMapCategories } = require('./ai_category_mapper');
//   const mapping = await aiMapCategories(uniqueLabels, cats); // { "<label>": "<slug>" }
// ============================================================================

// labels: array of distinct raw category strings that failed substring match.
// cats:   array of { slug, label } canonical enforcement_categories.
// returns: plain object mapping exact-label -> canonical slug (omits no-fit
//          labels). Never throws — returns {} on any failure so the caller's
//          import proceeds with whatever substring-matched.
async function aiMapCategories(labels, cats) {
  const uniqueLabels = [...new Set((labels || []).filter(Boolean))];
  if (!uniqueLabels.length || !process.env.ANTHROPIC_API_KEY) return {};
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const canonicalList = (cats || []).map((c) => `${c.slug} — "${c.label}"`).join('\n');

    const prompt = `You are mapping Vantaca HOA violation category labels to trustEd's canonical enforcement category slugs.

Canonical trustEd categories (slug — "label"):
${canonicalList}

Unmatched Vantaca labels to map:
${uniqueLabels.map((l, i) => `${i + 1}. "${l}"`).join('\n')}

Return ONLY a JSON object — no preamble, no markdown:
{
  "mapping": {
    "<exact Vantaca label>": "<canonical slug from the list above>",
    ...
  }
}

RULES:
- Use ONLY the slugs from the canonical list above. Never invent a new slug.
- If a Vantaca label truly has no good canonical fit, OMIT it from the mapping (don't force a bad match).
- Be permissive but accurate — 'Mow and Edge' fits 'lawn_maintenance' even though it doesn't say 'lawn'.
- Vantaca labels often have suffixes/prefixes like 'Brick' or 'Landscape' that hint at the broader category.

Return ONLY the JSON object.`;

    const stream = anthropic.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });
    const completion = await stream.finalMessage();
    const text = (completion.content?.[0]?.text || '').trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : cleaned);
    return parsed.mapping || {};
  } catch (e) {
    console.warn('[ai_category_mapper] non-fatal:', e.message);
    return {};
  }
}

module.exports = { aiMapCategories };
