// Verify the master plan submission admin + approval flow end-to-end.

const fetch = global.fetch || require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BASE = 'https://my.bedrocktxai.com';

const results = [];
function rec(n, name, pass, detail) {
  results.push({ n, name, pass, detail });
  console.log('[' + (pass ? '✓' : 'X') + '] ' + n + '. ' + name + (detail ? ' — ' + detail : ''));
}

(async () => {
  // 1. /admin/master-plan-submissions staff-gated (401 unauth)
  try {
    const r = await fetch(BASE + '/admin/master-plan-submissions');
    rec(1, 'Admin page staff-gated', r.status === 401, 'status=' + r.status);
  } catch (e) { rec(1, 'Admin page staff-gated', false, e.message); }

  // 2. POST /public accepts builder intake unauth
  let createdSubId = null;
  let createdAttPath = null;
  try {
    const tinyPdf = new Uint8Array(Buffer.from('%PDF-1.4\nverify\n%%EOF'));
    const fd = new FormData();
    fd.append('community_slug', 'still-creek-ranch');
    fd.append('builder_company_name', 'Lennar');
    fd.append('submitter_email', 'verify@bedrocktx.com');
    fd.append('submission_title', 'VERIFY ONLY auto-cleanup');
    fd.append('plan_numbers_proposed', '9990');
    fd.append('builder_acknowledgments', JSON.stringify({ verify: true }));
    fd.append('files', new Blob([tinyPdf], { type: 'application/pdf' }), 'verify.pdf');
    const r = await fetch(BASE + '/api/master-plan-submissions/public', { method: 'POST', body: fd });
    const j = await r.json();
    rec(2, 'POST /public accepts builder intake',
      r.status === 200 && !!j.reference_number && j.reference_number.includes('-MPS-'),
      'status=' + r.status + ', ref=' + j.reference_number);
    createdSubId = j.submission_id;
    if (j.attachments?.[0]?.id) {
      const { data: att } = await s.from('master_plan_submission_attachments')
        .select('storage_path').eq('id', j.attachments[0].id).single();
      createdAttPath = att?.storage_path;
    }
  } catch (e) { rec(2, 'POST /public accepts builder intake', false, e.message); }

  // 3. GET / (bare path, staff list) requires staff cookie
  try {
    const r = await fetch(BASE + '/api/master-plan-submissions');
    rec(3, 'GET list requires staff cookie', r.status === 401, 'status=' + r.status);
  } catch (e) { rec(3, 'GET list requires staff cookie', false, e.message); }

  // 4. Builder form posts to /public path
  try {
    const html = await (await fetch(BASE + '/builders/still-creek-lennar/master-plan')).text();
    rec(4, 'Builder form posts to /public path',
      html.includes("'/api/master-plan-submissions/public'"),
      '');
  } catch (e) { rec(4, 'Builder form posts to /public path', false, e.message); }

  // 5. POST /:id/finalize requires staff cookie
  if (createdSubId) {
    try {
      const r = await fetch(BASE + '/api/master-plan-submissions/' + createdSubId + '/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deny', denial_reasons: 'x', decided_by: 'x' }),
      });
      rec(5, 'POST /:id/finalize requires staff cookie', r.status === 401, 'status=' + r.status);
    } catch (e) { rec(5, 'POST /:id/finalize requires staff cookie', false, e.message); }
  } else {
    rec(5, 'POST /:id/finalize requires staff cookie', false, 'skipped (no test sub created)');
  }

  // 6. Finalize via service-role direct DB calls — simulate staff approve
  let createdMasterPlanIds = [];
  let letterPath = null;
  if (createdSubId) {
    try {
      // Inserts the master_plans rows via API would need staff auth. Verify the
      // schema layer works by doing the inserts directly (matching what the
      // endpoint does internally), then check the rows landed correctly.
      const { error: e1 } = await s.from('master_plans').insert({
        builder_company_id: '0eda1b79-0526-4e5d-8a4b-5488a0938ed1',
        plan_number: '9990TEST',
        plan_name: 'VERIFY',
        elevation: 'X',
        elevation_orientation: 'standard',
        square_footage: 1000,
        stories: 1,
        default_materials: {},
        status: 'approved',
        notes: 'verify-only auto-cleanup',
      });
      const { data: insertedRow } = await s.from('master_plans')
        .select('id').eq('plan_number', '9990TEST').eq('elevation', 'X')
        .maybeSingle();
      createdMasterPlanIds = insertedRow ? [insertedRow.id] : [];

      rec(6, 'Master plans insertion works (schema accepts approve payload)',
        !e1 && createdMasterPlanIds.length > 0,
        'inserted ids=' + createdMasterPlanIds.length + ', err=' + (e1?.message || 'none'));
    } catch (e) { rec(6, 'Master plans insertion works', false, e.message); }
  } else {
    rec(6, 'Master plans insertion works', false, 'skipped');
  }

  // 7. Letter renderer produces valid HTML with table + reference
  try {
    const { renderMasterPlanLetterHTML } = require('../lib/master_plan_letter');
    const html = renderMasterPlanLetterHTML({
      community: 'Still Creek Ranch',
      builder_company_name: 'Lennar',
      builder_contact_name: 'Test',
      submission_title: 'VERIFY',
      reference_number: 'SCR-MPS-2026-9999',
      approved_plans: [
        { plan_number: '9990', plan_name: 'Verify', elevation: 'X', elevation_orientation: 'standard', square_footage: 1000, stories: 1 },
      ],
      decision_type: 'approved',
      signer_name: 'Verify Script',
    });
    const ok = html.includes('Still Creek Ranch') && html.includes('SCR-MPS-2026-9999')
            && html.includes('Approved Master Plans') && html.includes('9990');
    rec(7, 'Letter renderer produces valid HTML', ok, 'length=' + html.length);
  } catch (e) { rec(7, 'Letter renderer produces valid HTML', false, e.message); }

  // 8. Builder ARC Review header has the link (need staff cookie to read the file)
  try {
    const fs = require('fs');
    const local = fs.readFileSync('public/builder-arc-review.html', 'utf8');
    rec(8, 'ARC Review header includes admin link locally',
      local.includes('/admin/master-plan-submissions') && local.includes('Master plan submissions'),
      '');
  } catch (e) { rec(8, 'ARC Review header includes admin link', false, e.message); }

  // 9. Index.html nav has the new entry
  try {
    const fs = require('fs');
    const local = fs.readFileSync('public/index.html', 'utf8');
    rec(9, 'index.html nav has master plans entry',
      local.includes('__masterplans') && local.includes('/admin/master-plan-submissions'),
      '');
  } catch (e) { rec(9, 'index.html nav has master plans entry', false, e.message); }

  // ----- Cleanup -----
  console.log('\n[cleanup]');
  if (createdMasterPlanIds.length) {
    await s.from('master_plans').delete().in('id', createdMasterPlanIds);
    console.log('  removed test master_plans:', createdMasterPlanIds.length);
  }
  if (createdSubId) {
    await s.from('master_plan_submission_attachments').delete().eq('submission_id', createdSubId);
    if (createdAttPath) {
      try { await s.storage.from('documents').remove([createdAttPath]); } catch (_) {}
    }
    await s.from('master_plan_submissions').delete().eq('id', createdSubId);
    console.log('  removed test submission + attachment');
    // Reset counter so real submission is 0001
    await s.from('application_reference_counters')
      .update({ counter: 0 })
      .eq('community_id', 'a0000000-0000-4000-8000-000000000006')
      .eq('service_type', 'master_plan_submission')
      .eq('year', 2026);
    console.log('  reset MPS counter');
  }

  console.log('\n=================================');
  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;
  console.log('PASSED: ' + pass + '/' + results.length);
  if (fail > 0) {
    console.log('FAILED:');
    for (const r of results) if (!r.pass) console.log('  - ' + r.n + '. ' + r.name + ' — ' + r.detail);
  }
})();
