// ============================================================================
// lib/master_plan_extract.js
// ----------------------------------------------------------------------------
// Ed 2026-06-18: read a submitted master-plan PDF and return the structured
// plan/elevation rows so the approval screen pre-fills instead of making staff
// retype what's already in the document (friction + transcription-error
// removal — the encode-Ed thesis applied to ARC approval).
//
// Uses the Claude PDF-binary path (NEVER pdf-parse — these are architectural
// submittals, often Adobe forms; pdf-parse reads underscores, not the values;
// see CLAUDE.md scar). Filename is a fallback when the model returns nothing
// ("4505 - Somerset DEF.pdf" → plan 4505, name Somerset, elevation DEF).
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');

const EXTRACTION_PROMPT = `You are reading an architectural plan submittal PDF for a new home in a master-planned community. Extract every distinct PLAN + ELEVATION combination being submitted for catalog approval.

For each, return:
- plan_number: the plan/model number exactly as shown (e.g. "4505", "476N"). String.
- plan_name: the plan/model name if shown (e.g. "Somerset"). String or null.
- elevation: the elevation code as shown (e.g. "DEF", "C4", "A"). String or null.
- elevation_orientation: "standard", "left", or "right" only if explicitly indicated; otherwise "standard".
- square_footage: total heated/living square footage as an integer; null if not shown.
- stories: number of stories (1, 1.5, 2, ...); null if not shown.

A submittal usually covers ONE plan, sometimes with multiple elevations — return one entry per plan+elevation actually being submitted. Read form-field values as they appear visually, not the underlying blank lines.

Return ONLY this JSON, no prose:
{ "plans": [ { "plan_number": "...", "plan_name": "...", "elevation": "...", "elevation_orientation": "standard", "square_footage": 1922, "stories": 1 } ] }

If a value isn't in the document, use null — never guess.`;

function _num(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function _str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

// Best-effort parse of "4505 - Somerset DEF.pdf" / "4505_Somerset_DEF.pdf".
function _fromFilename(filename) {
  if (!filename) return null;
  const base = filename.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const m = base.match(/^([A-Za-z0-9]+)\s*[-–—]?\s*(.*)$/);
  if (!m) return null;
  const planNumber = m[1];
  const rest = (m[2] || '').trim().split(/\s+/).filter(Boolean);
  let elevation = null;
  let name = null;
  if (rest.length > 1 && /^[A-Za-z]{1,4}[0-9]?$/.test(rest[rest.length - 1])) {
    elevation = rest[rest.length - 1];
    name = rest.slice(0, -1).join(' ');
  } else if (rest.length) {
    name = rest.join(' ');
  }
  if (!planNumber) return null;
  return { plan_number: planNumber, plan_name: name || null, elevation: elevation || null,
           elevation_orientation: 'standard', square_footage: null, stories: null };
}

function _normalize(p) {
  const orientation = ['standard', 'left', 'right'].includes(p.elevation_orientation)
    ? p.elevation_orientation : 'standard';
  const sqft = _num(p.square_footage);
  const stories = _num(p.stories);
  return {
    plan_number: _str(p.plan_number),
    plan_name: _str(p.plan_name),
    elevation: _str(p.elevation),
    elevation_orientation: orientation,
    square_footage: sqft != null ? Math.round(sqft) : null,
    stories: stories,
  };
}

/**
 * Extract plan/elevation rows from a master-plan submittal PDF.
 * @param {Buffer} pdfBuffer
 * @param {string} [filename]
 * @returns {Promise<{ plans: Array, raw_extracted: string|null, source: 'ai'|'filename'|'none' }>}
 */
async function extractPlansFromPdf(pdfBuffer, filename) {
  let plans = [];
  let raw = null;
  let source = 'none';

  if (process.env.ANTHROPIC_API_KEY && pdfBuffer && pdfBuffer.length) {
    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
            { type: 'text', text: EXTRACTION_PROMPT },
          ],
        }],
      });
      raw = (response.content?.[0]?.text || '').trim();
      console.log('[master_plan_extract] Claude returned:', raw.slice(0, 600));
      let jsonText = raw;
      const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fenced) jsonText = fenced[1];
      const parsed = JSON.parse(jsonText);
      const arr = Array.isArray(parsed.plans) ? parsed.plans : [];
      plans = arr.map(_normalize).filter((p) => p.plan_number);
      if (plans.length) source = 'ai';
    } catch (e) {
      console.warn('[master_plan_extract] AI extraction failed:', e.message);
    }
  }

  // Fallback to the filename if the model gave us nothing usable.
  if (plans.length === 0) {
    const fb = _fromFilename(filename);
    if (fb) { plans = [_normalize(fb)]; source = 'filename'; }
  }

  return { plans, raw_extracted: raw, source };
}

module.exports = { extractPlansFromPdf, _fromFilename };
