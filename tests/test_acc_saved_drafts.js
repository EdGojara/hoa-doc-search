// ============================================================================
// tests/test_acc_saved_drafts.js  (Ed 2026-10-29)
// ----------------------------------------------------------------------------
// THE SCAR. Ed clicked "📂 Open" on a saved ACC draft (Lakes of Pine Forest,
// Waterview Estates) and "nothing happened." The drafts and their files were
// intact. Opening re-downloads every attachment (2-5s for these drafts) with
// no visible change: the button did nothing, the confirmation landed below the
// fold, the list never marked the draft as open, and the community was never
// restored, so the next Review stopped at "Please select a community first."
// Re-saving an opened draft also deleted its application PDF (replace_files
// with the PDF held only in a side variable), and opening a draft after
// another application left that application's homeowner name and letter on
// screen (the letter auto-fill only fills BLANK fields).
//
// This test loads the REAL public/index.html in headless Chrome against an
// in-memory stand-in for the /api/drafts contract in server.js, clicks the
// real Open button, and asserts what Ed would see and what Review would send.
//
// Run: node tests/test_acc_saved_drafts.js
// ============================================================================
process.env.PUPPETEER_CACHE_DIR = process.env.PUPPETEER_CACHE_DIR || require('path').join(__dirname, '..', '.cache', 'puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const PUBLIC = path.join(__dirname, '..', 'public');
let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); }
}

// Sanitized shapes of the two real drafts (no homeowner names).
const PDF_BYTES = Buffer.from('%PDF-1.4 application-form-lopf');
const JPG_BYTES = Buffer.from('JPEG-front-door-photo');
const PDF2_BYTES = Buffer.from('%PDF-1.4 application-form-page-2');
const WV_PDF = Buffer.from('%PDF-1.4 tree-removal-scan');
const now = new Date().toISOString();
const DRAFTS = {
  'aaaaaaaa-0000-4000-8000-000000000001': {
    id: 'aaaaaaaa-0000-4000-8000-000000000001', draft_type: 'acc_review', community_name: 'Lakes of Pine Forest',
    label: 'Requesting to paint my front door black', created_at: now, updated_at: now,
    state: { details: 'Requesting to paint my front door black. Contractor will take one day.', decision: '', conditions: 'Black, satin finish', additionalContext: 'Photos attached' },
    file_refs: [
      { field: 'pdf', path: 'drafts/a/form1.pdf', name: 'House request form pg 1.pdf', type: 'application/pdf', size: PDF_BYTES.length, bytes: PDF_BYTES },
      { field: 'photos', path: 'drafts/a/door.jpg', name: 'door.jpg', type: 'image/jpeg', size: JPG_BYTES.length, bytes: JPG_BYTES },
      { field: 'photos', path: 'drafts/a/form2.pdf', name: 'House request form pg 2.pdf', type: 'application/pdf', size: PDF2_BYTES.length, bytes: PDF2_BYTES },
    ],
  },
  'aaaaaaaa-0000-4000-8000-000000000002': {
    id: 'aaaaaaaa-0000-4000-8000-000000000002', draft_type: 'acc_review', community_name: 'Waterview Estates',
    label: 'A new red maple tree will be planted after the removal', created_at: now, updated_at: now,
    state: { details: 'A new red maple tree will be planted after the removal, six inch caliper.', decision: 'incomplete', conditions: '', additionalContext: '' },
    file_refs: [{ field: 'pdf', path: 'drafts/b/scan.pdf', name: 'scan.pdf', type: 'application/pdf', size: WV_PDF.length, bytes: WV_PDF }],
  },
  'aaaaaaaa-0000-4000-8000-000000000003': {
    id: 'aaaaaaaa-0000-4000-8000-000000000003', draft_type: 'acc_review', community_name: 'Waterview Estates',
    label: 'Fence stain, one file missing', created_at: now, updated_at: now,
    state: { details: 'Fence stain request.', decision: '', conditions: '', additionalContext: '' },
    file_refs: [{ field: 'photos', path: 'drafts/c/gone.jpg', name: 'gone.jpg', type: 'image/jpeg', size: 4, bytes: null }],
  },
};
const LOPF = 'aaaaaaaa-0000-4000-8000-000000000001';
const WV = 'aaaaaaaa-0000-4000-8000-000000000002';
const BROKEN = 'aaaaaaaa-0000-4000-8000-000000000003';

const captured = { saves: [], reviews: [] };
let fileDelayMs = 0;
const publicRef = (r, i, id) => { const { bytes, ...rest } = r; return { ...rest, url: `/api/drafts/${id}/files/${i}` }; };

function readBody(req) {
  return new Promise((resolve) => { const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => resolve(Buffer.concat(parts))); });
}
// Multipart is parsed just enough to see field names, filenames and bytes.
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || '');
  if (!m) return [];
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const out = [];
  let start = buf.indexOf(boundary);
  while (start !== -1) {
    const next = buf.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    const part = buf.slice(start + boundary.length + 2, next - 2);
    const sep = part.indexOf('\r\n\r\n');
    const head = part.slice(0, sep).toString();
    const name = (/name="([^"]*)"/.exec(head) || [])[1];
    const filename = (/filename="([^"]*)"/.exec(head) || [])[1];
    out.push({ name, filename, data: part.slice(sep + 4) });
    start = next;
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (code, body) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
  let m;
  if (u.pathname === '/api/drafts' && req.method === 'GET') {
    const type = u.searchParams.get('type');
    const community = u.searchParams.get('community');
    const list = Object.values(DRAFTS)
      .filter((d) => d.draft_type === type)
      .filter((d) => !community || (d.community_name || '').toLowerCase().includes(community.split(' at ')[0].toLowerCase()))
      .map((d) => ({ ...d, file_refs: d.file_refs.map(({ bytes, ...r }) => r) }));
    return json(200, { drafts: list });
  }
  if (u.pathname === '/api/drafts' && req.method === 'POST') {
    const parts = parseMultipart(await readBody(req), req.headers['content-type']);
    captured.saves.push(parts);
    const id = (parts.find((p) => p.name === 'id') || {}).data;
    const d = DRAFTS[id && id.toString()];
    return json(200, { draft: d ? { ...d, file_refs: d.file_refs.map(({ bytes, ...r }) => r) } : { id: 'new' } });
  }
  if ((m = u.pathname.match(/^\/api\/drafts\/([0-9a-f-]+)$/)) && req.method === 'GET') {
    const d = DRAFTS[m[1]];
    if (!d) return json(404, { error: 'draft not found' });
    return json(200, { draft: { ...d, file_refs: d.file_refs.map((r, i) => publicRef(r, i, d.id)) } });
  }
  if ((m = u.pathname.match(/^\/api\/drafts\/([0-9a-f-]+)\/files\/(\d+)$/))) {
    const d = DRAFTS[m[1]];
    const ref = d && d.file_refs[Number(m[2])];
    if (fileDelayMs) await new Promise((r) => setTimeout(r, fileDelayMs));
    if (!ref || !ref.bytes) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', ref.type);
    return res.end(ref.bytes);
  }
  if (u.pathname === '/acc-review' && req.method === 'POST') {
    captured.reviews.push(parseMultipart(await readBody(req), req.headers['content-type']));
    return json(200, { error: 'test stub: no review performed' });
  }
  if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/acc-review')) return json(200, {});
  const rel = u.pathname === '/' ? '/index.html' : u.pathname;
  const file = path.join(PUBLIC, path.normalize(rel));
  if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) return res.end(fs.readFileSync(file));
  res.statusCode = 404; res.end('');
});

(async () => {
  console.log('\nACC saved drafts: reopen, attachments, community, stale state\n');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('dialog', async (d) => { pageErrors.push('dialog: ' + d.message()); await d.dismiss(); });
    // Block third-party scripts/fonts so the test is hermetic and fast.
    await page.setRequestInterception(true);
    page.on('request', (r) => (r.url().startsWith(`http://127.0.0.1:${port}`) ? r.continue() : r.abort()));
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.Drafts && typeof setAccMode === 'function', { timeout: 30000 });
    await page.evaluate(() => setAccMode('review'));
    await page.waitForFunction(() => document.querySelectorAll('[data-drafts-list="acc_review"] button').length >= 6, { timeout: 15000 });

    const openBtn = (id) => page.evaluateHandle((id) => [...document.querySelectorAll('[data-drafts-list="acc_review"] button')]
      .find((b) => /Open/.test(b.textContent) && (b.getAttribute('onclick') || '').includes(id)), id);
    const form = () => page.evaluate(() => ({
      details: document.getElementById('accDetails').value,
      decision: document.getElementById('accDecision').value,
      conditions: document.getElementById('accConditions').value,
      context: document.getElementById('accContext').value,
      community: document.getElementById('communitySelect').value,
      currentCommunity: typeof currentCommunity !== 'undefined' ? currentCommunity : null,
      inputPdf: (document.getElementById('accPdf').files[0] || {}).name || null,
      sidePdf: window._accDraftPdf ? window._accDraftPdf.name : null,
      photos: accSelectedFiles.map((f) => f.name + ':' + f.size),
      status: document.getElementById('accDraftStatus').textContent,
      letterName: document.getElementById('accLetterName').value,
      letterBody: document.getElementById('accLetterBody').value,
      decisionId: accLastReview.decision_id,
      panel: document.querySelector('[data-drafts-list="acc_review"]').textContent,
    }));

    // ── 1. Reopen a draft: visible progress, then every field restored ──────
    // Simulate a previous application on screen first.
    await page.evaluate(() => {
      document.getElementById('accLetterName').value = 'PREVIOUS HOMEOWNER';
      document.getElementById('accLetterBody').value = 'Letter for a different application';
      accLastReview = { extracted: { homeowner_name: 'PREVIOUS HOMEOWNER' }, decision_id: 'stale-decision-id' };
    });
    fileDelayMs = 400;
    const b1 = await openBtn(LOPF);
    await b1.click();
    await new Promise((r) => setTimeout(r, 150));
    const busy = await b1.evaluate((b) => ({ text: b.textContent, disabled: b.disabled }));
    check('Open button shows progress while attachments download', /Opening/.test(busy.text) && busy.disabled, JSON.stringify(busy));
    await page.waitForFunction(() => /Opened draft/.test(document.getElementById('accDraftStatus').textContent), { timeout: 15000 });
    fileDelayMs = 0;
    await page.waitForFunction(() => /currently open/.test(document.querySelector('[data-drafts-list="acc_review"]').textContent), { timeout: 5000 }).catch(() => {});
    let f = await form();
    const d1 = DRAFTS[LOPF];
    check('details restored', f.details === d1.state.details, f.details);
    check('notes + context restored', f.conditions === d1.state.conditions && f.context === d1.state.additionalContext);
    check('community restored to the draft\'s community', f.community === 'Lakes of Pine Forest' && f.currentCommunity === 'Lakes of Pine Forest', `${f.community} / ${f.currentCommunity}`);
    check('confirmation says how many files came back', /3 of 3 files restored/.test(f.status), f.status);
    check('drafts list marks this draft as currently open', /currently open/.test(f.panel));
    check('previous application\'s homeowner name cleared', f.letterName === '' && f.letterBody === '', `${f.letterName} | ${f.letterBody}`);
    check('previous application\'s decision id cleared', f.decisionId === null, String(f.decisionId));

    // ── 2. Attachments preserved: right files, right bytes, every path ──────
    check('application PDF restored into the file input', f.inputPdf === 'House request form pg 1.pdf', String(f.inputPdf));
    check('photos + extra PDFs restored with original sizes',
      JSON.stringify(f.photos) === JSON.stringify([`door.jpg:${JPG_BYTES.length}`, `House request form pg 2.pdf:${PDF2_BYTES.length}`]), JSON.stringify(f.photos));

    // Re-save the opened draft: replace_files must carry EVERY file back.
    await page.evaluate(() => accSaveDraft());
    await page.waitForFunction(() => /Saved/.test(document.getElementById('accDraftStatus').textContent), { timeout: 10000 });
    const save = captured.saves[captured.saves.length - 1] || [];
    const field = (n) => save.filter((p) => p.name === n);
    check('re-save updates the same draft (no duplicate)', (field('id')[0] || {}).data?.toString() === LOPF);
    check('re-save keeps the application PDF (was being deleted)',
      field('file_pdf').length === 1 && field('file_pdf')[0].data.equals(PDF_BYTES), `pdf parts: ${field('file_pdf').length}`);
    check('re-save keeps both photo/brochure files byte-for-byte',
      field('file_photos').length === 2 && field('file_photos')[0].data.equals(JPG_BYTES) && field('file_photos')[1].data.equals(PDF2_BYTES));

    // Review after reopening sends the draft's community and files.
    await page.evaluate(() => reviewACC());
    for (let i = 0; i < 50 && captured.reviews.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    const rv = captured.reviews[0] || [];
    const rf = (n) => rv.filter((p) => p.name === n);
    check('Review is not blocked by "select a community"', !pageErrors.some((e) => /select a community/i.test(e)), pageErrors.join(' | '));
    check('Review sends the draft\'s community', (rf('community')[0] || {}).data?.toString() === 'Lakes of Pine Forest');
    check('Review sends the draft\'s application PDF', rf('pdf').length === 1 && rf('pdf')[0].data.equals(PDF_BYTES));
    check('Review sends the draft\'s photos', rf('images').length === 2);

    // ── 3. Opening a second draft replaces, never mixes ─────────────────────
    // The list is scoped to the selected community (now Lakes of Pine Forest),
    // so go back to all communities the way Ed would to reach the other draft.
    const showAll = async () => {
      await page.evaluate(() => { const s = document.getElementById('communitySelect'); s.value = ''; s.dispatchEvent(new Event('change')); });
      await page.waitForFunction(() => document.querySelectorAll('[data-drafts-list="acc_review"] button').length >= 6, { timeout: 10000 });
    };
    await showAll();
    const b2 = await openBtn(WV);
    await b2.click();
    await page.waitForFunction(() => /1 of 1 file restored/.test(document.getElementById('accDraftStatus').textContent), { timeout: 15000 });
    f = await form();
    check('second draft: its own details', f.details === DRAFTS[WV].state.details);
    check('second draft: its own decision override', f.decision === 'incomplete', f.decision);
    check('second draft: its own community', f.community === 'Waterview Estates' && f.currentCommunity === 'Waterview Estates');
    check('second draft: its own PDF, not the first draft\'s', f.inputPdf === 'scan.pdf' && f.sidePdf === 'scan.pdf', `${f.inputPdf}/${f.sidePdf}`);
    check('second draft: first draft\'s photos are gone', f.photos.length === 0, JSON.stringify(f.photos));

    // ── 4. A missing attachment is named, never silent ──────────────────────
    await showAll();
    const b3 = await openBtn(BROKEN);
    await b3.click();
    await page.waitForFunction(() => /Opened draft/.test(document.getElementById('accDraftStatus').textContent)
      && /Could not load/.test(document.getElementById('accDraftStatus').textContent), { timeout: 15000 });
    f = await form();
    check('missing file is named on screen', /Could not load: gone\.jpg/.test(f.status), f.status);
    check('the previous draft\'s PDF does not carry over', f.inputPdf === null && f.sidePdf === null, `${f.inputPdf}/${f.sidePdf}`);

    // ── 5. A draft that no longer exists says so ────────────────────────────
    const msg = await page.evaluate(() => Drafts.load('acc_review', 'aaaaaaaa-0000-4000-8000-00000000dead').then(() => 'loaded', (e) => e.message));
    check('deleted draft reports an error instead of doing nothing', /not found/i.test(msg), msg);

    check('no page errors', pageErrors.filter((e) => !/^dialog:/.test(e)).length === 0, pageErrors.join(' | '));
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mall ACC saved-draft checks passed\x1b[0m');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
