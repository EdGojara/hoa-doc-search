// ============================================================================
// ai_vision.js — categorize an inspection photo with the AI vision
// ----------------------------------------------------------------------------
// Given an image buffer + the community's enforcement category list, asks
// the AI to:
//   1. Identify whether a covenant violation is visible
//   2. Match to one of the canonical categories
//   3. Assign severity (clean/minor/moderate/severe)
//   4. Write a one-sentence description suitable for a Bedrock letter
//   5. Suggest a recommended action (no_action / courtesy / escalate)
//   6. Self-rate confidence (low/medium/high)
//
// Returns null if AI is unconfigured or call fails — caller leaves the
// observation in 'pending' for full manual review.
//
// Critical guardrails:
//   - System prompt instructs the AI to write in Bedrock voice (conversational,
//     describes condition without legal claims) — not "AI-generated" prose.
//   - severity='clean' returned when nothing actionable visible (e.g., photo
//     captured for documentation, not for enforcement). UI keeps the photo
//     but doesn't queue a letter.
//   - confidence='low' results bypass auto-draft — those go straight to
//     human review with no drafted letter (Phase 6c respects this flag).
//   - Output is strict JSON; failures (the AI returns prose, network error)
//     return null and the observation stays human-reviewable.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');

const SYSTEM_PROMPT = `You are an experienced HOA property inspector reviewing a single photograph taken during a community drive-by inspection. Your job is to identify whether the photo shows a covenant violation, and if so, characterize it for a Bedrock Association Management compliance letter.

Voice & tone guidelines:
- Write in plain, descriptive language. Imagine you're describing what you see to a homeowner who will read it in a mailed letter.
- Never make legal claims ("violation of CC&Rs §4.3") — describe the visible condition only.
- Never editorialize ("the homeowner is being lazy"). Just describe what's there.
- Be specific: "lawn appears to exceed 8 inches in height across the front yard" not "lawn looks long".
- One sentence for the description. Two clauses maximum.

Confidence rules:
- 'high' = you can clearly see the issue and you're certain what it is
- 'medium' = you can see something that looks like an issue but lighting/angle leaves doubt
- 'low' = the photo is unclear, partial, or ambiguous; a human should look

Severity rules:
- 'clean' = no violation visible (operator may have captured for context)
- 'minor' = trivial / first-courtesy worthy (trash can left out, small lawn issue)
- 'moderate' = noticeable, would normally get a courtesy notice
- 'severe' = obvious + significant (boat in driveway for weeks, structural visible from street)

Always respond with valid JSON in this exact shape, no extra prose:
{
  "is_violation": true|false,
  "category_slug": "lawn_overgrowth" | (one of the provided slugs) | null,
  "severity": "clean" | "minor" | "moderate" | "severe",
  "description": "one-sentence description for the letter",
  "recommended_action": "no_action" | "courtesy" | "escalate",
  "confidence": "low" | "medium" | "high",
  "notes": "optional internal note for the reviewer; not shown to homeowner"
}`;

/**
 * Categorize a single inspection photo.
 *
 * @param {Object} input
 * @param {Buffer} input.image_buffer  - jpeg/png bytes
 * @param {string} input.image_media_type - 'image/jpeg' or 'image/png'
 * @param {Array}  input.categories    - [{ slug, label, description? }, ...]
 * @param {Object} [input.context]     - { community_name, property_address }
 *                                       for richer prompting
 * @returns {Promise<Object|null>}    - { is_violation, category_slug, severity,
 *                                       description, recommended_action, confidence,
 *                                       notes, raw_ai_response } or null if AI failed
 */
async function categorizePhoto(input) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[ai_vision] ANTHROPIC_API_KEY not set — skipping categorization');
    return null;
  }
  if (!input.image_buffer || input.image_buffer.length === 0) return null;

  const client = new Anthropic({ apiKey });

  // Build the categories list as a compact bullet
  const categoryList = (input.categories || [])
    .map((c) => `- ${c.slug}: ${c.label}${c.description ? ` — ${c.description}` : ''}`)
    .join('\n');

  const contextLine = input.context && (input.context.community_name || input.context.property_address)
    ? `Context: ${input.context.community_name || ''}${input.context.property_address ? ' · ' + input.context.property_address : ''}.`
    : '';

  const userText = [
    contextLine,
    'Canonical violation categories to choose from (use the slug):',
    categoryList,
    '',
    'If the visible condition does not match any of these categories but is clearly a violation, use category_slug = null and put your description of the condition in the description + notes fields.',
    'If the photo shows no violation (clean property, context shot, blurry), return is_violation = false with severity = "clean".',
  ].filter(Boolean).join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: input.image_media_type || 'image/jpeg',
                data: input.image_buffer.toString('base64'),
              },
            },
            { type: 'text', text: userText },
          ],
        },
      ],
    });

    const textBlock = (response.content || []).find((b) => b.type === 'text');
    const rawText = textBlock && textBlock.text || '';
    // Tolerant JSON extraction — the AI sometimes wraps in ```json fences
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[ai_vision] no JSON object in response:', rawText.slice(0, 200));
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn('[ai_vision] JSON parse failed:', e.message);
      return null;
    }

    // Normalize + validate
    const validSeverities = new Set(['clean', 'minor', 'moderate', 'severe']);
    const validConfidence = new Set(['low', 'medium', 'high']);
    const validActions    = new Set(['no_action', 'courtesy', 'escalate']);

    return {
      is_violation:       !!parsed.is_violation,
      category_slug:      parsed.category_slug || null,
      severity:           validSeverities.has(parsed.severity) ? parsed.severity : 'minor',
      description:        String(parsed.description || '').trim() || null,
      recommended_action: validActions.has(parsed.recommended_action) ? parsed.recommended_action : 'courtesy',
      confidence:         validConfidence.has(parsed.confidence) ? parsed.confidence : 'low',
      notes:              parsed.notes || null,
      raw_ai_response:    rawText,
    };
  } catch (err) {
    console.error('[ai_vision] the AI call failed:', err.message);
    return null;
  }
}

module.exports = { categorizePhoto };
