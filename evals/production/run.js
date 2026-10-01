#!/usr/bin/env node
// ============================================================================
// evals/production/run.js  (Issue #12): side-by-side model evals on the REAL
// production code paths, against known-good historical outcomes.
// ----------------------------------------------------------------------------
// Each suite calls the actual production function (not a copy of its prompt)
// under each model via router.withRouteOverrides (no code edits), on real
// historical inputs, and scores against what humans already verified:
//   drv_citation   lookupGoverningDoc vs the board's manual citation on file
//   drv_vision     categorizePhoto vs the reviewer-confirmed category
//   ap_invoice     extractInvoice vs the posted/approved AP invoice
//   legal_invoice  extractLegalInvoice total vs the approved legal payable
//   acc_master_plan extractPlansFromPdf vs the approved master plan
//   email_triage   classifyAndExtract agreement + JSON health
//   email_draft    draftReply honesty/voice rules + draft produced
// READ-ONLY against production (it reads rows and files, writes nothing but
// the local report). Reports carry homeowner data, so they are written OUTSIDE
// the repo (EVAL_OUT, default the OS temp dir); only aggregates are shared.
//
//   node evals/production/run.js --suites drv_citation,ap_invoice --n 6 --models sonnet-4-5,sonnet-5
// ============================================================================
require('dotenv').config({ quiet: true });
process.env.AI_TELEMETRY = process.env.AI_TELEMETRY || 'off';
const fs = require('fs');
const os = require('os');
const path = require('path');
const router = require('../../lib/ai/router');
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const MODELS = arg('models', 'sonnet-4-5,sonnet-5').split(',');
const N = Number(arg('n', 6));
const SUITES = arg('suites', 'drv_citation,drv_vision,ap_invoice,legal_invoice,acc_master_plan,email_triage,email_draft').split(',');
const OUT = process.env.EVAL_OUT || os.tmpdir();
const must = async (q, w) => { const { data, error } = await q; if (error) throw new Error(w + ': ' + error.message); return data; };
const download = async (bucket, p) => { const { data } = await sb.storage.from(bucket).download(p); return data ? Buffer.from(await data.arrayBuffer()) : null; };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();
const sectionKey = (s) => { const m = String(s || '').match(/(article|section|§)\s*([0-9]+(?:\.[0-9a-z]+)*|\([a-z0-9]+\))/i); return m ? m[2].toLowerCase() : norm(s).slice(0, 24); };
const sample = (arr, n) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = (i * 7919 + 13) % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); }; // deterministic shuffle

// Run fn once per model. Records model executed, latency, thrown errors.
async function perModel(fn) {
  const out = {};
  for (const m of MODELS) {
    const t0 = Date.now();
    try { out[m] = { ok: true, value: await router.withRouteOverrides({ '*': m }, fn), ms: Date.now() - t0 }; }
    catch (e) { out[m] = { ok: false, error: String(e.message || e).slice(0, 300), ms: Date.now() - t0 }; }
  }
  return out;
}

const suites = {
  async drv_citation() {
    const pr = await must(sb.from('community_enforcement_priorities').select('community_id, category_id, governing_doc_reference, governing_doc_section_title').not('governing_doc_reference', 'is', null).is('end_date', null).limit(500), 'priorities');
    const cats = await must(sb.from('enforcement_categories').select('id, slug, label, description'), 'cats');
    const { lookupGoverningDoc } = require('../../lib/enforcement/governing_doc_lookup');
    const cases = [];
    for (const p of sample(pr, N)) {
      const c = cats.find((x) => x.id === p.category_id); if (!c) continue;
      const r = await perModel(() => lookupGoverningDoc({ communityId: p.community_id, categorySlug: c.slug, categoryLabel: c.label, categoryDescription: c.description }));
      const score = {};
      for (const [m, v] of Object.entries(r)) {
        const g = v.ok && v.value;
        score[m] = !v.ok ? 'error' : !g || g.found === false || !g.reference ? 'no_citation (generic fallback)' : sectionKey(g.reference) === sectionKey(p.governing_doc_reference) ? 'MATCH' : 'DIFFERENT_CITATION';
      }
      cases.push({ category: c.slug, expected: p.governing_doc_reference, got: Object.fromEntries(Object.entries(r).map(([m, v]) => [m, v.ok ? (v.value && v.value.reference) || null : 'ERR ' + v.error])), score });
    }
    return cases;
  },

  async drv_vision() {
    const obs = await must(sb.from('property_observations').select('id, category_id, inspection_photo_id, ai_description, community_id').eq('reviewer_status', 'confirmed').not('category_id', 'is', null).not('inspection_photo_id', 'is', null).order('created_at', { ascending: false }).limit(400), 'obs');
    const cats = await must(sb.from('enforcement_categories').select('id, slug, label, description').order('display_order'), 'cats');
    const { categorizePhoto } = require('../../lib/enforcement/ai_vision');
    const { expandCategoryToAliases } = require('../../lib/enforcement/category_aliases');
    const cases = [];
    for (const o of sample(obs, N * 2)) {
      if (cases.length >= N) break;
      const ph = await must(sb.from('inspection_photos').select('storage_path').eq('id', o.inspection_photo_id).maybeSingle(), 'photo');
      if (!ph || !ph.storage_path) continue;
      const img = await download('documents', ph.storage_path); if (!img) continue;
      const okIds = new Set(await expandCategoryToAliases(o.category_id).catch(() => [o.category_id]));
      okIds.add(o.category_id);
      const r = await perModel(() => categorizePhoto({ image_buffer: img, image_media_type: /\.png$/i.test(ph.storage_path) ? 'image/png' : 'image/jpeg', categories: cats }));
      const expected = (cats.find((c) => c.id === o.category_id) || {}).slug;
      const score = {}, got = {};
      for (const [m, v] of Object.entries(r)) {
        const f = v.ok && v.value && (v.value.findings || [])[0];
        const slug = f && (f.category_slug || f.slug);
        const id = slug && (cats.find((c) => c.slug === slug) || {}).id;
        got[m] = !v.ok ? 'ERR ' + v.error : v.value === null ? 'null (no result)' : v.value.is_clean ? 'clean' : slug || '(unmapped)';
        score[m] = !v.ok || v.value === null ? 'error' : id && okIds.has(id) ? 'MATCH' : v.value.is_clean ? 'missed (said clean)' : 'DIFFERENT_CATEGORY';
      }
      cases.push({ expected, got, score });
    }
    return cases;
  },

  async ap_invoice() {
    const inv = await must(sb.from('ap_invoices').select('id, vendor_invoice_number, invoice_date, total_cents, source_storage_path, status, vendor_id').in('status', ['approved', 'paid', 'posted']).not('source_storage_path', 'is', null).ilike('source_storage_path', '%.pdf').order('created_at', { ascending: false }).limit(300), 'invoices');
    const { extractInvoice, toCents } = require('../../lib/ap/invoice_extract');
    const cases = [];
    for (const i of sample(inv, N * 2)) {
      if (cases.length >= N) break;
      const pdf = await download('documents', i.source_storage_path); if (!pdf) continue;
      const r = await perModel(() => extractInvoice(pdf));
      const score = {}, got = {};
      for (const [m, v] of Object.entries(r)) {
        const e = v.ok ? v.value : null; const x = e && (e.parsed || e);
        const total = x && (x.total_cents ?? (x.total != null ? toCents(x.total) : null));
        const num = x && (x.vendor_invoice_number || x.invoice_number);
        const date = x && x.invoice_date;
        got[m] = !v.ok ? 'ERR ' + v.error : { total_cents: total, invoice_number: num, invoice_date: date };
        score[m] = !v.ok ? 'error' : [Number(total) === Number(i.total_cents) ? 'total✓' : 'TOTAL✗', norm(num) === norm(i.vendor_invoice_number) ? 'number✓' : 'NUMBER✗', String(date || '').slice(0, 10) === String(i.invoice_date || '').slice(0, 10) ? 'date✓' : 'DATE✗'].join(' ');
      }
      cases.push({ expected: { total_cents: i.total_cents, invoice_number: i.vendor_invoice_number, invoice_date: i.invoice_date }, got, score });
    }
    return cases;
  },

  async legal_invoice() {
    const { LEGAL_VENDOR_IDS } = require('../../lib/legal/review_data');
    const inv = await must(sb.from('ap_invoices').select('id, total_cents, source_storage_path, status, vendor_id').in('vendor_id', LEGAL_VENDOR_IDS).not('source_storage_path', 'is', null).order('created_at', { ascending: false }).limit(100), 'legal invoices');
    const { extractLegalInvoice } = require('../../lib/legal/pdf_extract');
    const M = require('../../lib/legal/pdf_matters');
    const cases = [];
    for (const i of sample(inv, N)) {
      const pdf = await download('documents', i.source_storage_path); if (!pdf) continue;
      const r = await perModel(() => extractLegalInvoice(pdf));
      const score = {}, got = {};
      for (const [m, v] of Object.entries(r)) {
        let norm1 = null; try { norm1 = v.ok ? M.normalize(v.value.raw) : null; } catch (_) {}
        const total = norm1 && (norm1.total_cents ?? null);
        const matters = norm1 && Array.isArray(norm1.matters) ? norm1.matters.length : null;
        got[m] = !v.ok ? 'ERR ' + v.error : { total_cents: total, matters };
        score[m] = !v.ok ? 'error' : Number(total) === Number(i.total_cents) ? 'total✓' : 'TOTAL✗';
      }
      cases.push({ expected_total_cents: i.total_cents, got, score });
    }
    return cases;
  },

  async acc_master_plan() {
    const plans = await must(sb.from('master_plans').select('id, plan_number, plan_name, elevation, status, library_document_id').eq('status', 'approved').not('library_document_id', 'is', null).limit(300), 'plans');
    const { extractPlansFromPdf } = require('../../lib/master_plan_extract');
    const cases = [];
    for (const p of sample(plans, N * 2)) {
      if (cases.length >= N) break;
      const doc = await must(sb.from('library_documents').select('file_path, file_name_original').eq('id', p.library_document_id).maybeSingle(), 'doc');
      if (!doc || !doc.file_path || !/\.pdf$/i.test(doc.file_path)) continue;
      const pdf = await download('documents', doc.file_path); if (!pdf) continue;
      const r = await perModel(() => extractPlansFromPdf(pdf, doc.file_name_original || 'plan.pdf'));
      const score = {}, got = {};
      for (const [m, v] of Object.entries(r)) {
        const list = v.ok ? (v.value.plans || v.value || []) : [];
        const same = Array.isArray(list) ? list.filter((x) => norm(x.plan_number) === norm(p.plan_number)) : [];
        const hit = same.find((x) => norm(x.elevation) === norm(p.elevation)) || same[0];
        got[m] = !v.ok ? 'ERR ' + v.error : (Array.isArray(list) ? list : []).slice(0, 3).map((x) => `${x.plan_number}/${x.elevation || ''}`);
        score[m] = !v.ok ? 'error' : !hit ? 'PLAN_NOT_FOUND' : norm(hit.elevation) === norm(p.elevation) || !p.elevation ? 'MATCH' : 'ELEVATION_DIFFERS';
      }
      cases.push({ expected: `${p.plan_number}/${p.elevation || ''}`, got, score });
    }
    return cases;
  },

  async email_triage() {
    const emails = await must(sb.from('email_messages').select('id, sender_email, sender_name, subject, body_full, body_preview, classification').in('classification', ['acc_request', 'homeowner_request', 'internal', 'other', 'spam', 'legal_privileged']).order('received_at', { ascending: false }).limit(200), 'emails');
    const { classifyAndExtract } = require('../../lib/email/triage');
    const cases = [];
    for (const e of sample(emails.filter((x) => (x.body_full || x.body_preview || '').length > 80), N)) {
      const r = await perModel(() => classifyAndExtract({ sender_email: e.sender_email, sender_name: e.sender_name, subject: e.subject, body_full: e.body_full, body_preview: e.body_preview }));
      const score = {}, got = {};
      for (const [m, v] of Object.entries(r)) {
        const c = v.ok && v.value;
        got[m] = !v.ok ? 'ERR ' + v.error : c.classification;
        score[m] = !v.ok ? 'error' : /could not parse/.test(c.summary || '') ? 'JSON_PARSE_FAIL' : c.classification === e.classification ? 'agrees_with_stored' : 'differs_from_stored';
      }
      cases.push({ stored: e.classification, got, score });
    }
    return cases;
  },

  async email_draft() {
    const emails = await must(sb.from('email_messages').select('id, sender_email, sender_name, subject, body_full, body_preview, classification, community_id').eq('direction', 'inbound').in('classification', ['homeowner_request', 'acc_request']).order('received_at', { ascending: false }).limit(200), 'emails');
    const { draftReply, scrubFabricatedConfirmation } = require('../../lib/email/draft_reply');
    const cases = [];
    for (const e of sample(emails.filter((x) => (x.body_full || x.body_preview || '').length > 60), N)) {
      const r = await perModel(() => draftReply({ email: e, classification: { classification: e.classification }, communityId: e.community_id, contactName: e.sender_name }));
      const score = {}, got = {};
      for (const [m, v] of Object.entries(r)) {
        const d = v.ok && v.value; const body = (d && (d.body || d.draft_body || '')) || '';
        const issues = [];
        if (!body) issues.push('NO_DRAFT');
        if (/—/.test(body)) issues.push('EM_DASH');
        if (body && scrubFabricatedConfirmation(body).hit) issues.push('FABRICATED_CONFIRMATION');
        if (/\n\s*(best|thanks|regards|sincerely)[,!]?\s*\n?\s*[A-Z][a-z]+\s*$/i.test(body)) issues.push('TYPED_SIGNOFF');
        got[m] = !v.ok ? 'ERR ' + v.error : body.slice(0, 400);
        score[m] = !v.ok ? 'error' : issues.length ? issues.join(',') : 'clean';
      }
      cases.push({ classification: e.classification, got, score });
    }
    return cases;
  },
};

(async () => {
  const report = { at: new Date().toISOString(), models: MODELS, n: N, suites: {} };
  for (const s of SUITES) {
    if (!suites[s]) { console.log('unknown suite', s); continue; }
    process.stdout.write(`\n== ${s} `);
    let cases = [];
    try { cases = await suites[s](); } catch (e) { report.suites[s] = { error: e.message }; console.log('SUITE ERROR', e.message); continue; }
    const tally = {};
    for (const c of cases) for (const [m, sc] of Object.entries(c.score)) { tally[m] = tally[m] || {}; tally[m][sc] = (tally[m][sc] || 0) + 1; }
    report.suites[s] = { cases, tally };
    console.log(`(${cases.length} cases)`);
    for (const [m, t] of Object.entries(tally)) console.log(`   ${m.padEnd(11)} ${Object.entries(t).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  }
  const file = path.join(OUT, `production-eval-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('\nreport (contains homeowner data, kept outside the repo):', file);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
