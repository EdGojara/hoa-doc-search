// ============================================================================
// ai_vision.js — categorize an inspection photo with the AI vision
// ----------------------------------------------------------------------------
// Ed 2026-06-09 — MULTI-VIOLATION MODE (high-recall). Operator preference:
// "If you see 5 violations put them all in and list them — it's easier for
// me to remove than to add." So the AI now lists every potential violation
// visible in the photo, not just the most prominent one. The operator's
// job is to prune false positives via per-observation reject.
//
// RETURN SHAPE (new):
//   {
//     is_clean: boolean,           // true when no violations visible
//     findings: [                  // 0 or more — one per visible violation
//       {
//         category_slug: string|null,
//         severity: 'minor'|'moderate'|'severe',
//         description: string,
//         recommended_action: 'no_action'|'courtesy'|'escalate',
//         confidence: 'low'|'medium'|'high',
//         notes: string|null,
//       },
//       ...
//     ],
//     raw_ai_response: string,
//   }
//
// Returns null only when AI is unconfigured or the call/parse fails — caller
// leaves the seed observation in 'pending' for full manual review.
//
// Critical guardrails preserved from the original implementation:
//   - Bedrock voice (descriptive, no legal claims, observation-only).
//   - Strict JSON output.
//   - Per-finding confidence; low-confidence findings still get listed so the
//     operator sees them and can reject if false positive.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');

const SYSTEM_PROMPT = `You are an experienced HOA property inspector reviewing a single photograph taken during a community drive-by inspection. Your job is to identify EVERY covenant violation visible in the photo, characterize each one, and return them as a list for a Bedrock Association Management compliance review.

HIGH-RECALL MANDATE (critical):
- If you see 5 violations, list all 5. If you see 1, list 1. If you see 0, return an empty findings array with is_clean=true.
- Bedrock's operator will review and prune false positives. It is FAR easier for them to dismiss a borderline finding than to discover one you missed.
- Bias toward listing borderline cases at confidence='low'. Don't omit them.
- One photo can contain multiple distinct violations (e.g., trash bins at curb + dead lawn + peeling paint). Each is its own entry in findings.
- DO NOT merge two distinct violations into one finding. Trash and lawn = two findings, not one.

Voice & tone guidelines (each finding's description):
- Plain, descriptive language for a homeowner who will read it in a mailed letter.
- Never make legal claims ("violation of CC&Rs §4.3") — describe the visible condition only.
- Never editorialize ("the homeowner is being lazy"). Just describe what's there.
- Be specific: "lawn appears to exceed 8 inches in height across the front yard" not "lawn looks long".
- One sentence for the description. Two clauses maximum.

OBSERVATION-ONLY rule (critical — defensibility):
- Describe ONLY what is visible in the photograph. Never speculate on cause.
- BAD: "Brown patches indicate irrigation or weed-control gaps" (cause-attribution)
- BAD: "Trash bins suggest the owner forgot pickup day" (intent-attribution)
- BAD: "Peeling paint shows neglect" (judgment-attribution)
- GOOD: "Portions of the lawn contain brown or discolored areas."
- GOOD: "Trash bins remain at the curb."
- GOOD: "Front-facing exterior paint shows visible peeling and chipping in multiple areas."
- The homeowner may have a reason you can't see (medical, weather, vendor failure). Describing the condition gives them dignity to explain; speculating reads as presumptuous and undermines the letter's credibility.

Confidence rules (per finding):
- 'high' = you can clearly see the issue and you're certain what it is
- 'medium' = you can see something that looks like an issue but lighting/angle leaves doubt
- 'low' = the photo is unclear, partial, or ambiguous; a human should look — but LIST IT ANYWAY

Severity rules (per finding):
- 'minor' = trivial / first-courtesy worthy (trash can left out, small lawn issue)
- 'moderate' = noticeable, would normally get a courtesy notice
- 'severe' = obvious + significant (boat in driveway for weeks, structural visible from street)
(Note: 'clean' is NOT a per-finding severity. Use is_clean=true at the top level if NOTHING is wrong with the photo.)

Always respond with valid JSON in this exact shape, no extra prose:
{
  "is_clean": true|false,
  "findings": [
    {
      "category_slug": "lawn_overgrowth" | (one of the provided slugs) | null,
      "severity": "minor" | "moderate" | "severe",
      "description": "one-sentence description for the letter",
      "recommended_action": "no_action" | "courtesy" | "escalate",
      "confidence": "low" | "medium" | "high",
      "notes": "optional internal note for the reviewer; not shown to homeowner"
    }
  ]
}

If is_clean is true, findings MUST be an empty array.
If is_clean is false, findings MUST have at least one entry.`;

/**
 * Categorize a single inspection photo. High-recall: returns ALL violations
 * visible, not just the top one.
 *
 * @param {Object} input
 * @param {Buffer} input.image_buffer
 * @param {string} input.image_media_type
 * @param {Array}  input.categories
 * @param {Object} [input.context]
 * @returns {Promise<{is_clean:boolean, findings:Array, raw_ai_response:string}|null>}
 */
async function categorizePhoto(input) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[ai_vision] ANTHROPIC_API_KEY not set — skipping categorization');
    return null;
  }
  if (!input.image_buffer || input.image_buffer.length === 0) return null;

  const client = new Anthropic({ apiKey });

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
    'For each violation you see, pick the best-matching category_slug. If a finding does not match any category but is clearly a violation, set category_slug = null and put the condition in description + notes.',
    'Remember: list EVERY violation visible. Easier for the operator to remove a false positive than to add a missed one.',
  ].filter(Boolean).join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
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

    // Normalize + validate the new shape
    const validSeverities = new Set(['minor', 'moderate', 'severe']);
    const validConfidence = new Set(['low', 'medium', 'high']);
    const validActions    = new Set(['no_action', 'courtesy', 'escalate']);

    const is_clean = !!parsed.is_clean;
    const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const findings = rawFindings
      .filter(f => f && typeof f === 'object')
      .map(f => ({
        category_slug:      f.category_slug || null,
        severity:           validSeverities.has(f.severity) ? f.severity : 'minor',
        description:        String(f.description || '').trim() || null,
        recommended_action: validActions.has(f.recommended_action) ? f.recommended_action : 'courtesy',
        confidence:         validConfidence.has(f.confidence) ? f.confidence : 'low',
        notes:              f.notes || null,
      }))
      // Drop empty descriptions — those are useless
      .filter(f => f.description);

    // Self-correct: if AI says is_clean but listed findings, trust the findings
    const inferredClean = findings.length === 0;
    return {
      is_clean: inferredClean || is_clean,
      findings,
      raw_ai_response: rawText,
    };
  } catch (err) {
    console.error('[ai_vision] the AI call failed:', err.message);
    return null;
  }
}

module.exports = { categorizePhoto };
