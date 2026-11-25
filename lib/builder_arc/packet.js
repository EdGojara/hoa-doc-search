// ============================================================================
// lib/builder_arc/packet.js  (Ed 2026-11-25)
// ----------------------------------------------------------------------------
// Annie reads the WHOLE builder packet (application form + plot plan), not just
// page 1. Scar: the two Rustic Pine applications (SCR-BLD-2026-0020/0021) sat
// with lot / plan / elevation "UNKNOWN" for five months because extraction read
// page 1 of a 3-page packet; Lot 8 Block 2, Plan 4700 C4 was printed on page 3.
//
// Two independent reads, compared:
//   1. text layer (pdf-parse): deterministic regexes for the surveyor's title
//      block ("LOT 35, BLOCK 1, STILL CREEK RANCH, SECTION 5", "PLAN: 4506_D-L").
//      Works on CAD-exported plot plans; returns nothing on scans.
//   2. the PDF itself sent to the model (every page up to MAX_PAGES), per
//      CLAUDE.md: never pre-extracted text for forms / drawings.
// Where both read a field and disagree, the field is reported as conflicting
// and never auto-applied.
// ============================================================================
const MAX_PAGES = 10;

const PACKET_PROMPT = `You are reviewing a home builder's architectural review packet for one lot: an application form and a plot plan (site plan), possibly scanned. Read EVERY page, including hand-written or stamped values and the plot plan's drawing, title block and quantities table.

Return ONLY a JSON object, no prose:
{
  "street_address": "house number and street exactly as printed, or null",
  "lot": "lot number or null",
  "block": "block number or null",
  "section": "section number or null",
  "plan_number": "plan number only, e.g. 4506 or 450N, or null",
  "plan_name": "plan name printed on the drawing (e.g. Wakefield II), or null",
  "elevation": "elevation letter(s) only, e.g. D or C4, or null",
  "orientation": "L or R (garage/handing) if printed, else null",
  "lot_area_sqft": number or null,
  "impervious_coverage_pct": number or null (the plot plan's lot coverage / impervious coverage percentage),
  "slab_area_sqft": number or null,
  "fence": "fence notes exactly as printed (material, height, 'per specs'), or null",
  "form": { "brick": null, "paint": null, "trim": null, "stone": null, "siding": null, "shingles": null, "living_sqft": null, "under_roof_sqft": null, "signed_date": null },
  "conflicts_on_document": ["any place the packet contradicts itself, e.g. the title block says one plan and the drawing another"],
  "pages_read": number
}
Use null when a value is not printed. Never guess. Copy plan / elevation from the drawing's house label when the title block disagrees, and list the disagreement in conflicts_on_document.`;

const str = (v) => (v == null ? null : String(v).trim() || null);

// ---------------------------------------------------------------------------
// Text layer (deterministic)
// ---------------------------------------------------------------------------
function parsePlanToken(tok) {
  // "4506_D-L", "4700_D4-R", "450N_E-R", "4777_C4-R", "4505_C-R"
  const m = /^([0-9]{3}[0-9A-Z])_?([A-Z][0-9]?)(?:-([LR]))?$/i.exec(String(tok || '').trim());
  return m ? { plan_number: m[1].toUpperCase(), elevation: m[2].toUpperCase(), orientation: m[3] ? m[3].toUpperCase() : null } : null;
}

function parseTextLayer(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const out = {};
  const lb = /LOT\s+(\d+[A-Z]?),\s*BLOCK\s+(\d+[A-Z]?)(?:,\s*[^,]{3,60}?,\s*SECTION\s+(\w+))?/i.exec(t);
  if (lb) { out.lot = lb[1]; out.block = lb[2]; if (lb[3]) out.section = lb[3]; }
  const pl = /PLAN:\s*([0-9A-Z_\-]+)/i.exec(t);
  const pp = pl && parsePlanToken(pl[1]);
  if (pp) Object.assign(out, { title_block_plan_number: pp.plan_number, title_block_elevation: pp.elevation, title_block_orientation: pp.orientation });
  // House label on the drawing, in either text order:
  //   'PLAN No. 4504 ELEV. "F" RIGHT'  or  'ELEV. "F" RIGHTPLAN No. 4504'
  let hl = /PLAN\s+No\.?\s*([0-9]{3}[0-9A-Z])(?![0-9A-Z])[^"]{0,40}?ELEV\.?\s*"?([A-Z][0-9]?)"?\s*(RIGHT|LEFT)?/i.exec(t);
  if (hl) Object.assign(out, { drawing_plan_number: hl[1].toUpperCase(), drawing_elevation: hl[2].toUpperCase(), drawing_orientation: hl[3] ? hl[3][0].toUpperCase() : null });
  else if ((hl = /ELEV\.?\s*"([A-Z][0-9]?)"\s*(RIGHT|LEFT)?\s*PLAN\s+No\.?\s*([0-9]{3}[0-9A-Z])/i.exec(t))) {
    Object.assign(out, { drawing_plan_number: hl[3].toUpperCase(), drawing_elevation: hl[1].toUpperCase(), drawing_orientation: hl[2] ? hl[2][0].toUpperCase() : null });
  }
  const la = /LOT AREA:\s*([\d,]+(?:\.\d+)?)/i.exec(t);
  if (la) out.lot_area_sqft = Number(la[1].replace(/,/g, ''));
  // The lot's own address sits right before its "LOT n, BLOCK n" line (the
  // surveyor's office address elsewhere on the sheet must not win).
  const addr = /(\d{3,6}\s+[A-Z][A-Z ]{2,40}?\s(?:LANE|LN|TRAIL|TRL|DRIVE|DR|COURT|CT|WAY|STREET|ST|ROAD|RD|BEND|CIRCLE|CIR|PLACE|PL))\s+LOT\s+\d+/.exec(t);
  if (addr) out.street_address = addr[1];
  out.fence_per_specs = /FENCE PER SPECS/i.test(t);
  return out;
}

async function readTextLayer(pdfBuffer) {
  try {
    const pdfParse = require('pdf-parse');
    const r = await pdfParse(pdfBuffer);
    return { pages: r.numpages || null, text: r.text || '' };
  } catch (e) {
    return { pages: null, text: '', error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Model read (every page)
// ---------------------------------------------------------------------------
async function firstPages(pdfBuffer, maxPages) {
  try {
    const { PDFDocument } = require('pdf-lib');
    const src = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const total = src.getPageCount();
    if (total <= maxPages) return { buffer: pdfBuffer, total, trimmed: false };
    const dst = await PDFDocument.create();
    const copied = await dst.copyPages(src, Array.from({ length: maxPages }, (_, i) => i));
    copied.forEach((p) => dst.addPage(p));
    return { buffer: Buffer.from(await dst.save()), total, trimmed: true };
  } catch (e) {
    return { buffer: pdfBuffer, total: null, trimmed: false, error: e.message };
  }
}

async function readWithModel(pdfBuffer, { client } = {}) {
  const { route: aiRoute, executedModel } = require('../ai/router');
  let anthropic = client;
  if (!anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) return { extracted: null, error: 'ANTHROPIC_API_KEY not configured' };
    const Anthropic = require('../ai/anthropic');
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  const { buffer, total, trimmed } = await firstPages(pdfBuffer, MAX_PAGES);
  const resp = await anthropic.messages.create({
    model: aiRoute('acc.builder_application_extract'),
    max_tokens: 1500,
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
      { type: 'text', text: PACKET_PROMPT + (trimmed ? `\n\n(This is the first ${MAX_PAGES} of ${total} pages.)` : '') },
    ] }],
  });
  const raw = (resp.content || []).map((c) => c.text || '').join('').trim();
  console.log('[builder_arc.packet] model returned:', raw.slice(0, 2000));
  const m = raw.match(/\{[\s\S]*\}/);
  let extracted = null;
  try { extracted = m ? JSON.parse(m[0]) : null; } catch (_) { extracted = null; }
  return { extracted, raw, model: executedModel(resp, 'acc.builder_application_extract'), total_pages: total, trimmed };
}

// ---------------------------------------------------------------------------
// Merge the two reads into one fact set with provenance.
// ---------------------------------------------------------------------------
const eq = (a, b) => String(a || '').toUpperCase().replace(/\s+/g, '') === String(b || '').toUpperCase().replace(/\s+/g, '');

function mergeReads(textFacts, modelFacts) {
  const t = textFacts || {}; const m = modelFacts || {};
  const facts = {}; const conflicts = [];
  const take = (key, tv, mv) => {
    tv = str(tv); mv = str(mv);
    if (tv && mv && !eq(tv, mv)) { conflicts.push({ field: key, text_layer: tv, model: mv }); facts[key] = null; return; }
    facts[key] = tv || mv || null;
  };
  take('lot', t.lot, m.lot);
  take('block', t.block, m.block);
  take('section', t.section, m.section);
  // The drawing's house label beats the title block (title blocks go stale on a
  // plan change: 8118 Misty Maple's title block still said 4505 C after the
  // 8/12/2026 change to 4504 F). The disagreement itself is reported.
  const textPlan = t.drawing_plan_number || t.title_block_plan_number;
  const textElev = t.drawing_elevation || t.title_block_elevation;
  take('plan_number', textPlan, m.plan_number);
  take('elevation', textElev, m.elevation);
  take('orientation', t.drawing_orientation || t.title_block_orientation, m.orientation);
  facts.plan_name = str(m.plan_name);
  facts.street_address = str(m.street_address) || str(t.street_address);
  facts.lot_area_sqft = m.lot_area_sqft != null ? Number(m.lot_area_sqft) : (t.lot_area_sqft || null);
  facts.impervious_coverage_pct = m.impervious_coverage_pct != null && Number.isFinite(Number(m.impervious_coverage_pct)) ? Number(m.impervious_coverage_pct) : null;
  facts.fence = str(m.fence) || (t.fence_per_specs ? 'FENCE PER SPECS' : null);
  facts.form = (m.form && typeof m.form === 'object') ? m.form : {};
  // Only a deterministic contradiction (title block vs the drawing's house
  // label, both read from the text layer) is treated as a real conflict. The
  // model's own "conflicts" were mostly formatting or rounding (6906.1 vs 6906
  // sq ft; "4506_D-L" vs "PLAN No. 4506 ELEV D LEFT"), so they are kept as
  // unverified observations, never as a request to the builder.
  const docConflicts = [];
  facts.model_flags = Array.isArray(m.conflicts_on_document) ? m.conflicts_on_document.filter(Boolean).map(String).slice(0, 6) : [];
  if (t.title_block_plan_number && t.drawing_plan_number && (!eq(t.title_block_plan_number, t.drawing_plan_number) || !eq(t.title_block_elevation, t.drawing_elevation))) {
    docConflicts.push(`Title block says plan ${t.title_block_plan_number} ${t.title_block_elevation}; the drawing says plan ${t.drawing_plan_number} ${t.drawing_elevation}.`);
  }
  facts.document_conflicts = [...new Set(docConflicts)];
  facts.read_conflicts = conflicts;
  return facts;
}

/**
 * Read a packet. Never throws: a failed read comes back with `error` set and
 * whatever the other read produced.
 */
async function readPacket(pdfBuffer, opts = {}) {
  const text = await readTextLayer(pdfBuffer);
  const textFacts = parseTextLayer(text.text);
  let model = { extracted: null };
  if (opts.useModel !== false) {
    try { model = await readWithModel(pdfBuffer, opts); }
    catch (e) { model = { extracted: null, error: e.message }; console.warn('[builder_arc.packet] model read failed:', e.message); }
  }
  const facts = mergeReads(textFacts, model.extracted);
  return {
    facts,
    text_layer: textFacts,
    model_extracted: model.extracted || null,
    raw_model: model.raw || null,
    model: model.model || null,
    pages: text.pages || model.total_pages || null,
    errors: [text.error, model.error].filter(Boolean),
  };
}

module.exports = { readPacket, parseTextLayer, parsePlanToken, mergeReads, PACKET_PROMPT };
