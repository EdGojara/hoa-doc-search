#!/usr/bin/env node
// ===========================================================================
// scripts/seed_nda.js  (Ed 2026-09-03)
// ---------------------------------------------------------------------------
// Seed/refresh the Bedrock Mutual NDA into the Legal Disclosures store
// (legal_documents, slug 'mutual-nda', category 'agreement'). Idempotent:
// updates the body if the slug already exists, else inserts. The master text
// lives in lib/legal/nda_render.js so the generator and the stored doc match.
//
//   node -r dotenv/config scripts/seed_nda.js
// ===========================================================================
const { createClient } = require('@supabase/supabase-js');
const { NDA_SLUG, NDA_TITLE, NDA_TEMPLATE_MD } = require('../lib/legal/nda_render');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

(async () => {
  const { data: existing, error: exErr } = await sb.from('legal_documents')
    .select('id, version, body_markdown').eq('slug', NDA_SLUG).maybeSingle();
  if (exErr) { console.error('lookup failed (is migration 324 applied?):', exErr.message); process.exit(1); }

  if (existing) {
    const changed = existing.body_markdown !== NDA_TEMPLATE_MD;
    const { error } = await sb.from('legal_documents').update({
      title: NDA_TITLE, category: 'agreement', body_markdown: NDA_TEMPLATE_MD,
      status: 'published', updated_by: 'seed', version: changed ? (existing.version || 1) + 1 : existing.version,
    }).eq('id', existing.id);
    if (error) { console.error('update failed:', error.message); process.exit(1); }
    console.log(changed ? `updated ${NDA_SLUG} -> v${(existing.version || 1) + 1}` : `${NDA_SLUG} already current`);
  } else {
    const { error } = await sb.from('legal_documents').insert({
      slug: NDA_SLUG, title: NDA_TITLE, category: 'agreement',
      body_markdown: NDA_TEMPLATE_MD, status: 'published', updated_by: 'seed',
    });
    if (error) { console.error('insert failed:', error.message); process.exit(1); }
    console.log(`inserted ${NDA_SLUG}`);
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
