#!/usr/bin/env node
// ===========================================================================
// file_insurance_program.js  (Ed 2026-07-01)
// ---------------------------------------------------------------------------
// File a community's insurance policy of record into the system (SSOT) from an
// already-extracted program JSON + the source policy PDFs. Mirrors the API
// endpoint POST /api/insurance/program/upload, but reuses a prior extraction
// (no re-extract cost). Uploads each PDF to the library bucket + library_
// documents (category insurance_policy), then inserts insurance_programs +
// insurance_policies (superseding any current active program).
//
//   node -r dotenv/config scripts/file_insurance_program.js "<community substr>" "<program.json>" "<pdf1>" ["<pdf2>" ...]
// ===========================================================================

const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { normalizeInsuranceProgram } = require('../lib/insurance_rfp');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function dollarsToCents(input) {
  if (input == null || input === '') return null;
  const s = String(input).replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

(async () => {
  const [commQuery, jsonPath, ...pdfPaths] = process.argv.slice(2);
  if (!commQuery || !jsonPath || !pdfPaths.length) { console.error('usage: "<community>" "<program.json>" "<pdf1>" [...]'); process.exit(1); }

  const { data: comm } = await sb.from('communities').select('id, name').ilike('name', `%${commQuery}%`).limit(1).maybeSingle();
  if (!comm) { console.error('community not found:', commQuery); process.exit(1); }
  console.log('community:', comm.name, comm.id);

  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const program = normalizeInsuranceProgram(raw);
  console.log('coverage lines (deduped):', program.coverages.map((c) => c.line).join(', '));

  const { data: commFull } = await sb.from('communities').select('management_company_id').eq('id', comm.id).maybeSingle();
  const mgmtCoId = commFull ? commFull.management_company_id : null;

  // 1) file each PDF into storage + library_documents (canonical schema)
  const docIds = [];
  for (const p of pdfPaths) {
    const buf = fs.readFileSync(p);
    const name = p.split(/[\\/]/).pop();
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `insurance/${comm.id}/policy/${sha.slice(0, 12)}-${safe}`;
    // Idempotent: these PDFs may already be in library_documents (prior ingest).
    const { data: existing } = await sb.from('library_documents').select('id, category').eq('file_hash', sha).maybeSingle();
    if (existing) {
      // make sure it's tagged as an insurance policy so it groups with the program
      if (existing.category !== 'insurance_policy') await sb.from('library_documents').update({ category: 'insurance_policy' }).eq('id', existing.id);
      docIds.push(existing.id);
      console.log('  reused existing doc:', name);
      continue;
    }
    const { error: upErr } = await sb.storage.from('documents').upload(storagePath, buf, { contentType: 'application/pdf', upsert: true });
    if (upErr && !/already exists/i.test(upErr.message)) { console.error('storage upload failed:', upErr.message); process.exit(1); }
    const { data: doc, error: dErr } = await sb.from('library_documents').insert({
      management_company_id: mgmtCoId, community_id: comm.id, category: 'insurance_policy',
      title: `Insurance policy — ${name}`, file_name_original: name, file_path: storagePath,
      file_hash: sha, file_size_bytes: buf.length, created_by_mgmt_company: 'Bedrock',
    }).select('id').single();
    if (dErr) { console.error('library_documents insert failed:', dErr.message); process.exit(1); }
    docIds.push(doc.id);
    console.log('  filed:', name);
  }

  // 2) derive program-level fields
  const effs = program.coverages.map((c) => c.effective_date).filter(Boolean).sort();
  const exps = program.coverages.map((c) => c.expiration_date).filter(Boolean).sort();
  const premiums = program.coverages.map((c) => dollarsToCents(c.annual_premium)).filter((v) => v != null);
  const totalPremium = premiums.length ? premiums.reduce((a, b) => a + b, 0) : null;

  // 3) supersede current active + insert program
  await sb.from('insurance_programs').update({ status: 'superseded' }).eq('community_id', comm.id).eq('status', 'active');
  const { data: prog, error: pErr } = await sb.from('insurance_programs').insert({
    community_id: comm.id, status: 'active',
    policy_period_start: effs[0] || null, policy_period_end: exps[exps.length - 1] || null,
    named_insured: program.entity.named_insured || null, association_type: program.entity.association_type || null,
    units_or_lots: Number.isFinite(Number(program.entity.units_or_lots)) ? Number(program.entity.units_or_lots) : null,
    property_location: program.entity.property_location || null, mailing_address: program.entity.mailing_address || null,
    total_premium_cents: totalPremium, entity: program.entity || {},
    statement_of_values: program.statement_of_values || [], notes: program.notes || [],
    source_document_ids: docIds, source: 'extracted',
  }).select('*').single();
  if (pErr) { console.error('program insert failed:', pErr.message); process.exit(1); }

  const rows = program.coverages.map((c, i) => ({
    program_id: prog.id, community_id: comm.id, coverage_line: c.line, carrier: c.carrier || null,
    policy_number: c.policy_number || null, effective_date: c.effective_date || null, expiration_date: c.expiration_date || null,
    annual_premium_cents: dollarsToCents(c.annual_premium), limits: c.limits || [], deductibles: c.deductibles || [],
    key_terms: c.key_terms || [], source_document_id: null, sort_order: i,
  }));
  const { error: rErr } = await sb.from('insurance_policies').insert(rows);
  if (rErr) { console.error('policies insert failed:', rErr.message); process.exit(1); }

  console.log(`\nFILED: program ${prog.id} — ${rows.length} coverage lines, ${docIds.length} source PDFs, period ${prog.policy_period_start}→${prog.policy_period_end}`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
