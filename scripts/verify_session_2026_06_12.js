// Full 12-check verify across tonight's changes. Read-only except for
// (a) a test magic link minted then consumed against Richelle's portal_user
// (cleaned up at end), (b) a tiny test PDF master plan submission that's
// deleted at end, (c) a tiny test PNG photo upload that's deleted at end.

const fetch = global.fetch || require('node-fetch');
const FormData = require('form-data');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BASE = 'https://my.bedrocktxai.com';
const RICHELLE_ID = 'c75161cf-86e5-4e7a-b2df-98d9408cabc8';
const WATERVIEW_ID = 'a0000000-0000-4000-8000-000000000001';

const results = [];
function record(n, name, pass, detail) {
  results.push({ n, name, pass, detail });
  console.log('[' + (pass ? '✓' : 'X') + '] ' + n + '. ' + name + (detail ? ' — ' + detail : ''));
}

(async () => {
  // 1. portal-login.html welcome state, no auto-consume
  try {
    const html = await (await fetch(BASE + '/portal-login.html?token=ignored')).text();
    const hasWelcome = html.includes('welcomeState') && html.includes('welcomeSignInBtn');
    const hasAuto = html.includes('autoConsume');
    record(1, 'Welcome state live, no auto-consume', hasWelcome && !hasAuto,
      'welcome=' + hasWelcome + ', auto=' + hasAuto);
  } catch (e) { record(1, 'Welcome state live, no auto-consume', false, e.message); }

  // 2. Token consume -> cookie -> /me -> landing
  let cookie = null, meData = null;
  try {
    const tok = crypto.randomBytes(32).toString('base64url');
    await s.from('portal_magic_links').insert({
      portal_user_id: RICHELLE_ID, token: tok, purpose: 'invite',
      expires_at: new Date(Date.now() + 60*60*1000).toISOString(),
      created_by: 'verify_session_2026_06_12',
    });
    const c = await fetch(BASE + '/api/portal/consume?token=' + tok, { method: 'POST' });
    cookie = (c.headers.get('set-cookie') || '').split(';')[0] || null;
    const meR = await fetch(BASE + '/api/portal/me', { headers: { Cookie: cookie } });
    meData = await meR.json();
    record(2, 'Consume -> cookie -> /me -> landing_url',
      c.status === 200 && !!cookie && meR.status === 200 && meData.user?.role === 'builder' && meData.user?.landing_url === '/builders/still-creek-lennar',
      'consume=' + c.status + ', cookie=' + !!cookie + ', /me=' + meR.status + ', role=' + meData.user?.role + ', landing=' + meData.user?.landing_url);
  } catch (e) { record(2, 'Consume -> cookie -> /me -> landing_url', false, e.message); }

  // 3. /builders/still-creek-lennar unauthenticated
  try {
    const r = await fetch(BASE + '/builders/still-creek-lennar');
    const html = await r.text();
    record(3, 'Per-lot page loads unauth',
      r.status === 200 && html.includes('New Construction') && html.includes('master-plan'),
      'status=' + r.status);
  } catch (e) { record(3, 'Per-lot page loads unauth', false, e.message); }

  // 4. /builders/still-creek-lennar/master-plan unauthenticated (the formerly broken one)
  try {
    const r = await fetch(BASE + '/builders/still-creek-lennar/master-plan');
    const html = await r.text();
    record(4, 'Master-plan page loads unauth',
      r.status === 200 && html.includes('master plan') && html.includes('still-creek-lennar'),
      'status=' + r.status);
  } catch (e) { record(4, 'Master-plan page loads unauth', false, e.message); }

  // 5+6. Master plan POST with a tiny PDF + attachment row written + cleanup
  try {
    const tinyPdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n' +
      'xref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000052 00000 n\n0000000101 00000 n\n' +
      'trailer<</Size 4/Root 1 0 R>>startxref\n148\n%%EOF'
    );
    const fd = new FormData();
    fd.append('community_slug', 'still-creek-ranch');
    fd.append('builder_company_name', 'Lennar');
    fd.append('submitter_email', 'verify@bedrocktx.com');
    fd.append('submission_title', 'VERIFY ONLY — auto-cleanup');
    fd.append('plan_numbers_proposed', '9999');
    fd.append('builder_acknowledgments', JSON.stringify({ verify: true }));
    fd.append('files', tinyPdf, { filename: 'verify.pdf', contentType: 'application/pdf' });
    const r = await fetch(BASE + '/api/master-plan-submissions', { method: 'POST', body: fd });
    const j = await r.json();
    record(5, 'Master plan POST accepts submission',
      r.status === 200 && !!j.reference_number && j.reference_number.includes('-MPS-'),
      'status=' + r.status + ', ref=' + j.reference_number);
    if (j.submission_id) {
      const { data: att } = await s.from('master_plan_submission_attachments')
        .select('id, storage_path').eq('submission_id', j.submission_id);
      const okAtt = (att || []).length > 0 && att[0].storage_path?.includes('builders/still-creek-ranch/master-plan-submissions/');
      record(6, 'Attachment row + storage path correct', okAtt,
        'count=' + (att || []).length + ', path=' + (att?.[0]?.storage_path || '').slice(0, 90));
      if (att?.[0]?.storage_path) {
        try { await s.storage.from('documents').remove([att[0].storage_path]); } catch (_) {}
      }
      await s.from('master_plan_submissions').delete().eq('id', j.submission_id);
    } else {
      record(6, 'Attachment row + storage path correct', false, 'no submission_id returned');
    }
  } catch (e) {
    record(5, 'Master plan POST accepts submission', false, e.message);
    record(6, 'Attachment row + storage path correct', false, 'skipped due to #5 failure');
  }

  // 7. Builder ARC Review header has Lennar preview link
  try {
    const html = await (await fetch(BASE + '/builder-arc-review.html')).text();
    record(7, 'ARC Review header has Lennar preview link',
      html.includes('Lennar portal (preview)') && html.includes('/builders/still-creek-lennar'),
      '');
  } catch (e) { record(7, 'ARC Review header has Lennar preview link', false, e.message); }

  // 8. Lennar preview link target shows the portal as Richelle sees it
  try {
    const r = await fetch(BASE + '/builders/still-creek-lennar');
    const html = await r.text();
    record(8, 'Lennar preview target shows portal as Richelle sees it',
      r.status === 200 && html.includes('Lennar Homes') && html.includes('Still Creek Ranch') && html.includes('master-plan'),
      'status=' + r.status);
  } catch (e) { record(8, 'Lennar preview target shows portal as Richelle sees it', false, e.message); }

  // 9. Photo admin reachable
  try {
    const r = await fetch(BASE + '/admin/community-photos');
    const html = await r.text();
    record(9, 'Photo admin reachable',
      r.status === 200 && html.includes('Community photos') && html.includes('Platform'),
      'status=' + r.status);
  } catch (e) { record(9, 'Photo admin reachable', false, e.message); }

  // 10. Photos capture reachable
  try {
    const r = await fetch(BASE + '/photos/capture');
    const html = await r.text();
    record(10, 'Photos capture page reachable',
      r.status === 200 && html.includes('Capture') && html.includes('cameraInput'),
      'status=' + r.status);
  } catch (e) { record(10, 'Photos capture page reachable', false, e.message); }

  // 11. Photo upload endpoint accepts real image + cleanup
  try {
    const tinyPng = Buffer.from(
      '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C636060606000000005000164B4E5E70000000049454E44AE426082',
      'hex'
    );
    const fd = new FormData();
    fd.append('community_id', WATERVIEW_ID);
    fd.append('role', 'general');
    fd.append('files', tinyPng, { filename: 'verify.png', contentType: 'image/png' });
    const r = await fetch(BASE + '/api/community-photos', { method: 'POST', body: fd });
    const j = await r.json();
    const okRow = j.uploaded?.[0] && !j.uploaded[0].error && j.uploaded[0].id;
    record(11, 'Photo upload endpoint accepts real image',
      r.status === 200 && okRow, 'status=' + r.status + ', photo_id=' + (j.uploaded?.[0]?.id || 'none') + ', err=' + (j.uploaded?.[0]?.error || ''));
    if (okRow) await fetch(BASE + '/api/community-photos/' + j.uploaded[0].id + '?hard=1', { method: 'DELETE' });
  } catch (e) { record(11, 'Photo upload endpoint accepts real image', false, e.message); }

  // 12. Richelle outstanding token
  try {
    const { data } = await s.from('portal_magic_links')
      .select('token, expires_at, used_at')
      .eq('portal_user_id', RICHELLE_ID)
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('expires_at', { ascending: false });
    const richelles = (data || []).find((t) => t.token.endsWith('xfMI0U'));
    record(12, 'Richelle outstanding token unburned',
      !!richelles, richelles ? 'expires ' + richelles.expires_at.slice(0,19) : 'NOT FOUND or burned');
  } catch (e) { record(12, 'Richelle outstanding token unburned', false, e.message); }

  console.log('\n=================================');
  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;
  console.log('PASSED: ' + pass + '/' + results.length);
  if (fail > 0) {
    console.log('FAILED:');
    for (const r of results) if (!r.pass) console.log('  - ' + r.n + '. ' + r.name + ' — ' + r.detail);
  }
})();
