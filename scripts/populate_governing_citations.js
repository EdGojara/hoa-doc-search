#!/usr/bin/env node
// ===========================================================================
// populate_governing_citations.js  (Ed 2026-07-02)
// ---------------------------------------------------------------------------
// Populate the per-category governing-doc citation (community_enforcement_
// priorities.governing_doc_*) — the DETERMINISTIC section a §209 letter cites,
// which the letter renderer checks BEFORE any fuzzy auto-lookup. For each
// (community, category) it uses the FIXED askEd retrieval (getRelevantChunks
// over the deduped `documents` store) to find the governing section, then
// Claude extracts the exact reference + section title + verbatim quote + page.
//
// §209 accuracy: DRY-RUN by default — prints every proposed citation for human
// verification. --apply writes only entries the model returned with found=true
// AND a non-empty verbatim quote. Never invents a citation.
//
//   node -r dotenv/config scripts/populate_governing_citations.js "<community>" [--apply]
// ===========================================================================

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { getRelevantChunks } = require('../lib/hybrid_retrieval');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const APPLY = process.argv.includes('--apply');
const commQuery = process.argv[2];

// Category slug -> the real-world phrasing used to search the CC&Rs.
const CATEGORY_SEARCH = {
  trash_visible: 'trash cans and refuse storage, keeping the lot free of debris and rubbish, sanitary containers',
  trash_cans_recycling_containers: 'trash cans and recycling containers storage and screening from view',
  lawn_height: 'lawn and grass kept mowed and cut, weeds, sanitary and attractive manner',
  lawn_dead_patches: 'lawn maintained, landscaping kept in good condition, dead grass',
  weeds: 'weeds and grass cut, lot kept in a sanitary and attractive manner',
  property_maintenance: 'maintain improvements in good condition and repair, walks and driveways kept clean, nuisance',
  fence_damage: 'fences maintained in good repair and condition, rotting or falling fences',
  driveway_repair: 'driveways and walks kept clean and in good repair, concrete',
  tree_dead_dying: 'trees and landscaping maintained, dead or dying trees removed',
  vehicle_parking: 'vehicle parking and storage, inoperable vehicles, boats trailers RVs prohibited',
  exterior_maintenance: 'exterior of the residence maintained, paint, siding, roof kept in good repair',
};

const EXTRACT_PROMPT = (categoryLabel, concepts, context) => `You are extracting the governing provision an HOA would cite in a Texas §209 violation notice for the category "${categoryLabel}" (${concepts}).

From ONLY the governing-document excerpts below, find the single most on-point section that establishes the owner's obligation for this category. Return STRICT JSON:
{"found": true|false, "reference": "e.g. Section 3.12 | Article VII, Section 7.2", "section_title": "e.g. Lot and Building Maintenance", "quote": "the VERBATIM sentence(s) from the document that state the obligation — copy exactly, do not paraphrase", "page": <number or null>, "confidence": 0-100}

Rules: quote MUST be copied verbatim from the excerpts (this goes in a legal notice). If no excerpt clearly governs this category, return {"found": false}. Do NOT invent a reference or quote. Prefer the section that most directly names the obligation.

EXCERPTS:
${context.slice(0, 14000)}`;

(async () => {
  if (!commQuery) { console.error('usage: "<community>" [--apply]'); process.exit(1); }
  const { data: comm } = await sb.from('communities').select('id, name').ilike('name', `%${commQuery}%`).limit(1).maybeSingle();
  if (!comm) { console.error('community not found:', commQuery); process.exit(1); }
  console.log('community:', comm.name, '\n');

  const { data: cats } = await sb.from('enforcement_categories').select('id, slug, label');
  const bySlug = Object.fromEntries((cats || []).map((c) => [c.slug, c]));

  for (const [slug, concepts] of Object.entries(CATEGORY_SEARCH)) {
    const cat = bySlug[slug];
    if (!cat) continue;
    let cite = null;
    try {
      const ctx = await getRelevantChunks(concepts + ' ' + cat.label, comm.name);
      const r = await anthropic.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 900,
        messages: [{ role: 'user', content: EXTRACT_PROMPT(cat.label, concepts, ctx) }],
      });
      const raw = r.content.map((c) => c.text || '').join('').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      cite = JSON.parse(raw);
    } catch (e) { console.log(`  ${slug.padEnd(32)} ERROR ${e.message}`); continue; }

    if (!cite || !cite.found || !cite.quote || cite.quote.length < 20) {
      console.log(`  ${slug.padEnd(32)} — not found`);
      continue;
    }
    console.log(`  ${slug.padEnd(32)} ${cite.reference || '?'} — ${cite.section_title || ''} (conf ${cite.confidence || '?'}, p${cite.page || '?'})`);
    console.log(`      "${(cite.quote || '').slice(0, 150).replace(/\s+/g, ' ')}${cite.quote.length > 150 ? '…' : ''}"`);

    if (APPLY && (cite.confidence == null || cite.confidence >= 70)) {
      const { data: row } = await sb.from('community_enforcement_priorities')
        .select('id').eq('community_id', comm.id).eq('category_id', cat.id).is('end_date', null).maybeSingle();
      const fields = {
        governing_doc_reference: cite.reference || null,
        governing_doc_section_title: cite.section_title || null,
        governing_doc_quote: cite.quote,
        governing_doc_page: Number.isFinite(Number(cite.page)) ? Number(cite.page) : null,
      };
      if (row) await sb.from('community_enforcement_priorities').update(fields).eq('id', row.id);
      else await sb.from('community_enforcement_priorities').insert({ community_id: comm.id, category_id: cat.id, priority_weight: 'standard', ...fields });
      console.log('      ✓ saved');
    }
  }
  if (!APPLY) console.log('\n(dry-run — verify the sections above, then re-run with --apply)');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
