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

const SYSTEM_PROMPT = `You are an experienced HOA property inspector reviewing a single photograph taken during a community inspection for Bedrock Association Management. Each photo is taken to document ONE specific violation. Your job is to identify the SINGLE violation that photo is about and return just that one.

ONE VIOLATION PER PHOTO (critical):
- Return AT MOST ONE finding — the single clearest, most significant violation that is the subject of this photo.
- If the photo shows more than one issue, choose the ONE that is the primary subject (the most prominent, most clearly a violation, what the photo was framed to capture) and report only that. Do NOT list several findings for one photo. A separate photo will document any other violation.
- If the property looks compliant and nothing is clearly wrong, return is_clean=true with an EMPTY findings array. Do not invent a borderline violation to avoid returning empty.
- Pick the ONE category that best fits what you actually see. The category MUST match the photo:
    · A car or SUV is NOT a Commercial vehicle or an RV/boat/trailer, even with a roof rack or cargo carrier.
    · NEVER pick a tree/shrub category (e.g. Prune Trees, Dead shrubs) when there are no trees or shrubs in view.
    · A bare or dead lawn is Sod Yard or Lawn dead patches — not a pile of overlapping lawn categories.
    · Grass or weeds growing up through the expansion joints, seams, or cracks of the driveway, sidewalk, or curb is an EDGING problem — classify it as "Mow and Edge" (mow_and_edge) and word the description as needing mowing/edging along the walk and drive. Do NOT lead the description with "expansion joints," and do NOT use the standalone "Grass in the expansion joints" category — the mow/edge category is its correct home. Tall, shaggy, or overgrown grass anywhere across the lawn, yard, or curb strip is likewise a lawn-maintenance violation — "Mow and Edge" (mow_and_edge) or "Lawn height" (lawn_height). Never let grass in the joints or cracks be the pick when mowing or edging the lawn is the real issue.
    · A vehicle parked in a driveway or garage is NORMAL and is NOT a Parking violation. Do NOT pick "Parking violation" just because one or more cars are visible — driveway parking is compliant. A real parking violation requires a specific prohibited condition you can actually SEE: a vehicle parked ON the grass/lawn, blocking the public sidewalk, parked in the street where the community prohibits it, or vehicles spilling off the driveway onto the yard. If all you see is cars sitting on a driveway, that is NOT a violation — keep looking for the real issue (or return is_clean if there is none).
- Do NOT let the most VISUALLY PROMINENT object decide the category. Cars, the house, and the mailbox are large and centered but are almost always compliant. Inspection photos are framed to document a maintenance/appearance condition — most often overgrown or dead turf, weeds, trash cans, peeling paint, or fence disrepair. Look PAST the prominent object to that condition. In particular, if the lawn is tall/overgrown along the curb strip and bed edges, THAT is the violation (an overgrown-lawn category), even when a car dominates the frame.
- If two categories seem to compete, choose the one the visible evidence supports best. If you genuinely can't decide, pick the closest and set confidence='low'.

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

Confidence rules (for the one finding):
- 'high' = you can clearly see the issue and you're certain what it is
- 'medium' = you can see something that looks like an issue but lighting/angle leaves doubt
- 'low' = the photo is unclear, partial, or ambiguous, but there does appear to be a violation — a human should confirm

Severity rules (per finding):
- 'minor' = trivial / first-courtesy worthy (trash can left out, small lawn issue)
- 'moderate' = noticeable, would normally get a courtesy notice
- 'severe' = obvious + significant (boat in driveway for weeks, structural visible from street)
(Note: 'clean' is NOT a per-finding severity. Use is_clean=true at the top level if NOTHING is wrong with the photo.)

Always respond with valid JSON in this exact shape, no extra prose. "findings" holds ZERO entries (is_clean=true) or exactly ONE:
{
  "is_clean": true|false,
  "findings": [
    {
      "category_slug": "(one of the provided slugs)" | null,
      "severity": "minor" | "moderate" | "severe",
      "description": "one-sentence description for the letter",
      "recommended_action": "no_action" | "courtesy" | "escalate",
      "confidence": "low" | "medium" | "high",
      "notes": "optional internal note for the reviewer; not shown to homeowner"
    }
  ]
}

If is_clean is true, findings MUST be an empty array.
If is_clean is false, findings MUST contain EXACTLY ONE entry — the single violation this photo documents.`;

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
    // Learned corrections from this community's recent reviewer feedback (the
    // few-shot learning loop). Empty for fresh communities. Ed 2026-07-30.
    (input.learned_corrections && String(input.learned_corrections).trim()) ? String(input.learned_corrections).trim() : '',
    '',
    'Pick the ONE best-matching category_slug for the single violation this photo documents. If it is clearly a violation but matches no category, set category_slug = null and put the condition in description + notes.',
    'Return at most ONE finding. If the property looks compliant, return is_clean=true with no findings.',
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

    // ONE VIOLATION PER PHOTO (Ed 2026-07-30). Each photo documents a single
    // violation; the drones frame a separate shot per issue. If the model ever
    // returns more than one despite the prompt, keep only the strongest so we
    // never re-introduce the over-splitting — highest confidence, then severity.
    const CONF = { high: 3, medium: 2, low: 1 };
    const SEV = { severe: 3, moderate: 2, minor: 1 };
    const oneFinding = findings.slice().sort((a, b) =>
      (CONF[b.confidence] || 0) - (CONF[a.confidence] || 0) ||
      (SEV[b.severity] || 0) - (SEV[a.severity] || 0))
      .slice(0, 1);

    const inferredClean = oneFinding.length === 0;
    return {
      is_clean: inferredClean || is_clean,
      findings: oneFinding,
      raw_ai_response: rawText,
    };
  } catch (err) {
    console.error('[ai_vision] the AI call failed:', err.message);
    return null;
  }
}

module.exports = { categorizePhoto };
