// ============================================================================
// tests/test_public_upload_limits.js
// ----------------------------------------------------------------------------
// The no-login upload routes parse multipart bodies into memory BEFORE any
// handler check runs. This locks, against the REAL routers:
//   - a normal upload still reaches the handler with its fields + files
//   - oversize / too many files / over the total cap / nested or huge-index
//     field names / malformed bodies are refused with a clean JSON 400/413,
//     never a 500, a hang, a crash or an unhandled rejection
//   - an aborted upload releases its memory and the server keeps serving
//   - every multer route on server.js's public allowlist goes through
//     lib/uploads/public_upload.js (a new raw multer() public route fails here)
// It never reaches a database: every request is rejected by the upload layer
// or by the handler's own required-field check, and Supabase points at a dead
// local port. Run: node tests/test_public_upload_limits.js
// ============================================================================

// Aborted-upload leak check needs a real GC.
if (typeof global.gc !== 'function') {
  const r = require('child_process').spawnSync(process.execPath, ['--expose-gc', __filename], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}

// Before any api/ module loads (dotenv never overrides what is already set).
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_KEY = 'test-not-a-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-not-a-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-not-a-key';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
const ok = (cond, msg, extra) => {
  const t = ok.timed && ok.lastMs != null ? `  [${ok.lastMs} ms]` : '';
  ok.lastMs = null;
  if (cond) { passed++; console.log(`  ✓ ${msg}${t}`); }
  else { failed++; console.log(`  ✗ ${msg}${extra ? `  — ${extra}` : ''}`); }
};

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(`unhandledRejection: ${e && e.message}`));
process.on('uncaughtException', (e) => unhandled.push(`uncaughtException: ${e && e.message}`));
const quietWarn = console.warn;
console.warn = (...a) => { if (!String(a[0]).startsWith('[public-upload]')) quietWarn(...a); };

// ---------------------------------------------------------------------------
// multipart builder + raw HTTP client (full control: chunked, abort)
// ---------------------------------------------------------------------------
const BOUNDARY = '----trustedTestBoundary7MA4YWxk';
function multipart(parts) {
  const chunks = [];
  for (const p of parts) {
    let head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) head += `; filename="${p.filename}"\r\nContent-Type: ${p.type || 'application/pdf'}`;
    chunks.push(Buffer.from(head + '\r\n\r\n'));
    chunks.push(p.data !== undefined ? Buffer.from(p.data) : Buffer.alloc(p.size || 0, 0x41));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return chunks;
}
const file = (name, size, filename = 'doc.pdf') => ({ name, filename, size });
const field = (name, data) => ({ name, data });

function send(port, urlPath, chunks, { chunked = false, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const length = chunks.reduce((n, c) => n + c.length, 0);
    const headers = { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` };
    if (!chunked) headers['Content-Length'] = length;
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers });
    const timer = setTimeout(() => { req.destroy(); resolve({ status: 0, error: 'TIMEOUT', ms: Date.now() - t0 }); }, timeoutMs);
    req.on('response', (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        clearTimeout(timer);
        let json = null; try { json = JSON.parse(body); } catch (_) {}
        ok.lastMs = Date.now() - t0;
        resolve({ status: res.statusCode, json, body, type: res.headers['content-type'] || '', ms: Date.now() - t0 });
      });
    });
    req.on('error', (e) => { clearTimeout(timer); resolve({ status: 0, error: e.code || e.message, ms: Date.now() - t0 }); });
    (async () => {
      for (const c of chunks) { if (!req.write(c)) await new Promise((r) => req.once('drain', r)); }
      req.end();
    })().catch(() => {});
  });
}

// Writes part of a body, then kills the socket mid-file.
function sendAndAbort(port, urlPath, sendBytes) {
  return new Promise((resolve) => {
    const headers = { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`, 'Content-Length': sendBytes * 4 };
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers });
    req.on('error', () => resolve());
    req.on('response', () => resolve());
    req.write(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="documents"; filename="big.pdf"\r\nContent-Type: application/pdf\r\n\r\n`));
    req.write(Buffer.alloc(sendBytes, 0x42), () => setTimeout(() => { req.destroy(); resolve(); }, 20));
  });
}

const isCleanRejection = (r, status) => r.status === status && r.type.includes('application/json') && r.json && typeof r.json.error === 'string' && r.json.error.length > 0;
const show = (r) => `status=${r.status} ${r.error || ''} ${(r.body || '').slice(0, 120)}`;

// ---------------------------------------------------------------------------
// Mount the REAL routers (no staff gate here: we're testing the upload layer)
// ---------------------------------------------------------------------------
const { router: applicationsRouter } = require('../api/applications');
const masterPlanRouter = require('../api/master_plan_submissions');
const app = express();
app.use('/api/applications', applicationsRouter);
app.use('/api/master-plan-submissions', masterPlanRouter);

const ARC = '/api/applications/public/test-community/submit';
const MPS = '/api/master-plan-submissions/public';
const MB = 1024 * 1024;

(async () => {
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = server.address().port;

  // ---- installed version ---------------------------------------------------
  console.log('\nmulter version');
  const mv = require(path.join(ROOT, 'node_modules/multer/package.json')).version;
  const [maj, min] = mv.split('.').map(Number);
  ok(maj > 2 || (maj === 2 && min >= 3), `installed multer ${mv} >= 2.3.0 (GHSA-wc9g / -535w / -qvfw fixed)`);
  ok(/^\^?2\.4\./.test(require(path.join(ROOT, 'package.json')).dependencies.multer), 'package.json pins multer ^2.4.x so a lockfile regen cannot fall back');

  for (const [label, url, fileField, cfg] of [
    ['ARC submit  POST /api/applications/public/:slug/submit', ARC, 'documents', { fileSize: 20 * MB, files: 30, total: 100 * MB, missing: 'property_address' }],
    ['Master plan POST /api/master-plan-submissions/public', MPS, 'files', { fileSize: 40 * MB, files: 6, total: 150 * MB, missing: 'community_slug' }],
  ]) {
    console.log(`\n${label}`);
    ok.timed = true;

    // Normal upload: passes the upload layer and reaches the handler, which
    // answers with ITS OWN required-field 400 (so no DB is touched).
    const normalParts = url === ARC
      ? [field('submitter_name', 'Jane Owner'), field('submitter_email', 'jane@example.com'), field('signed_by_name', 'Jane Owner'), field('agreed_to_indemnification', 'true'), file('documents', 200 * 1024, 'survey.pdf'), file('photos', 300 * 1024, 'front.jpg')]
      : [field('builder_company_name', 'Lennar'), field('submitter_email', 'b@example.com'), field('submission_title', 'Plan set'), file('files', 300 * 1024, 'plan.pdf'), file('files', 300 * 1024, 'elev.pdf')];
    let r = await send(port, url, multipart(normalParts));
    ok(r.status === 400 && r.json && new RegExp(cfg.missing).test(r.json.error), `normal upload (2 files + fields) reaches the handler: its own "${cfg.missing} required" answer`, show(r));

    r = await send(port, url, multipart([...normalParts.slice(0, 2), file(fileField, cfg.fileSize, 'exact-limit.pdf')]));
    ok(r.status === 400 && r.json && new RegExp(cfg.missing).test(r.json.error), `a file of exactly the ${cfg.fileSize / MB} MB limit is accepted`, show(r));

    r = await send(port, url, multipart([file(fileField, cfg.fileSize + 1, 'too-big.pdf')]));
    ok(isCleanRejection(r, 413) && r.json.code === 'LIMIT_FILE_SIZE' && /too-big\.pdf/.test(r.json.error), `oversize file (+1 byte) → 413 LIMIT_FILE_SIZE naming the file`, show(r));

    r = await send(port, url, multipart(Array.from({ length: cfg.files + 1 }, (_, i) => file(fileField, 10, `f${i}.pdf`))));
    ok(isCleanRejection(r, 413) && /^LIMIT_(FILE_COUNT|UNEXPECTED_FILE)$/.test(r.json.code), `${cfg.files + 1} files → 413 too many files`, show(r));

    // Spread just over the total cap across no more files than allowed, each under the per-file cap.
    const perFile = Math.min(cfg.fileSize, Math.ceil((cfg.total + 1) / cfg.files) + 1024);
    const overTotal = Array.from({ length: Math.ceil((cfg.total + 1) / perFile) }, (_, i) => file(fileField, perFile, `p${i}.pdf`));
    {
      r = await send(port, url, multipart(overTotal));
      ok(isCleanRejection(r, 413) && r.json.code === 'UPLOAD_TOO_LARGE', `declared body over the ${cfg.total / MB} MB total cap → 413 before parsing`, show(r));
      r = await send(port, url, multipart(overTotal), { chunked: true });
      ok(isCleanRejection(r, 413) && r.json.code === 'UPLOAD_TOO_LARGE', `same body sent chunked (no Content-Length) → 413 once the counter passes the cap`, show(r));
    }

    r = await send(port, url, multipart([field('a[b][c][d]', 'x')]));
    ok(isCleanRejection(r, 400) && r.json.code === 'LIMIT_FIELD_NESTING', 'nested field name a[b][c][d] → 400 LIMIT_FIELD_NESTING', show(r));

    r = await send(port, url, multipart([field('a[4294967294]', 'x'), field('a[b]', 'y')]), { timeoutMs: 10000 });
    ok(isCleanRejection(r, 400) && r.json.code === 'LIMIT_FIELD_ARRAY_INDEX' && r.ms < 2000, `GHSA-535w payload a[4294967294] + a[b] → 400 in ${r.ms} ms (pinned the CPU > 60 s before)`, show(r));

    r = await send(port, url, multipart([field('a[4294967294]', 'x'), field('a[]', 'y')]), { timeoutMs: 10000 });
    ok(isCleanRejection(r, 400), 'GHSA-wc9g-style payload a[4294967294] + a[] → clean 400', show(r));

    r = await send(port, url, multipart(Array.from({ length: 51 }, (_, i) => field(`f${i}`, 'x'))));
    ok(isCleanRejection(r, 400) && r.json.code === 'LIMIT_FIELD_COUNT', '51 text fields → 400 too many fields', show(r));

    r = await send(port, url, [Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="x"\r\n\r\nunterminated`)]);
    ok(isCleanRejection(r, 400) && r.json.code === 'MALFORMED_UPLOAD', 'truncated multipart body → 400 MALFORMED_UPLOAD (was an Express 500 HTML page)', show(r));

    r = await send(port, url, multipart([{ name: fileField, filename: 'evil%0D%0AX-Injected: 1.pdf', size: 10 }, ...normalParts.slice(0, 1)]));
    ok(r.status === 400 && r.json && new RegExp(cfg.missing).test(r.json.error), 'a %0D%0A filename still parses (control chars are stripped before the handler)', show(r));
  }

  ok.timed = false;
  // ---- control characters never reach the handler -----------------------
  console.log('\nfilename hygiene (helper, as wired into the routes)');
  {
    const { publicUpload } = require('../lib/uploads/public_upload');
    const probe = express();
    probe.post('/p', publicUpload({ route: 'test', fileSize: MB, files: 2, maxTotalBytes: 3 * MB }).any(), (req, res) => res.json({ names: req.files.map((f) => f.originalname), body: req.body }));
    const ps = await new Promise((r) => { const s = probe.listen(0, '127.0.0.1', () => r(s)); });
    const r = await send(ps.address().port, '/p', multipart([field('note', 'hi'), { name: 'documents', filename: 'evil%0D%0AX-Injected: 1.pdf', size: 10 }]));
    ok(r.status === 200 && r.json.names[0] === 'evilX-Injected: 1.pdf' && r.json.body.note === 'hi', `CR/LF stripped from originalname: ${JSON.stringify(r.json && r.json.names)}`, show(r));
    ps.close();
  }

  // ---- aborted uploads ---------------------------------------------------
  console.log('\naborted uploads (ARC route)');
  global.gc(); await new Promise((r) => setTimeout(r, 200)); global.gc();
  const mem = () => { const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };
  const before = mem();
  for (let i = 0; i < 40; i++) await sendAndAbort(port, ARC, 4 * MB);
  await new Promise((r) => setTimeout(r, 500));
  global.gc(); await new Promise((r) => setTimeout(r, 200)); global.gc();
  const grewMb = (mem() - before) / MB;
  ok(grewMb < 20, `40 uploads aborted mid-file (160 MB sent) → memory back within ${grewMb.toFixed(1)} MB of baseline`);
  const r = await send(port, ARC, multipart([field('submitter_name', 'x'), file('documents', 1000, 'a.pdf')]));
  ok(r.status === 400 && r.json, 'server still answers normally after the aborts', show(r));

  // ---- every public multer route uses the helper ------------------------
  console.log('\npublic allowlist guard');
  const found = publicMulterRoutes();
  ok(found.unmapped.length === 0, `all ${found.uses} upload middleware uses in server.js + api/ map to a mounted route`, found.unmapped.join(', '));
  ok(found.routes.length >= 6, `found ${found.routes.length} upload routes reachable without login (expected ≥ 6)`);
  for (const rt of found.routes) ok(rt.usesHelper, `${rt.method} ${rt.path} → ${rt.instance} is a publicUpload()${rt.beforeGate ? ' (before the staff gate)' : ''}`, `${rt.file} uses a raw multer() instance`);

  ok(unhandled.length === 0, 'no unhandled rejection or uncaught exception during the run', unhandled.join('; '));

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });


// Every multer / publicUpload middleware use in server.js and api/*.js, mapped
// to its mounted path. A route is "no login" when its path is on server.js's
// _STAFF_GATE_PUBLIC allowlist or it is registered before the staff gate.
function publicMulterRoutes() {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = server.indexOf('const _STAFF_GATE_PUBLIC = [');
  const allowSrc = server.slice(start, server.indexOf('\n];', start));
  const allow = [...allowSrc.matchAll(/^\s*(\/\^.*?\/)\s*,/gm)].map((m) => new Function(`return ${m[1]}`)());
  const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
  const gateLine = lineOf(server, server.indexOf('if (_gateIsPublicPath(req.path)) return next();'));
  const routerFile = {};
  for (const m of server.matchAll(/const\s+(?:\{\s*router:\s*)?(\w+)\s*\}?\s*=\s*require\('\.\/api\/([\w_]+)'\)/g)) routerFile[m[1]] = m[2] + '.js';
  for (const m of server.matchAll(/const\s+\{[^}]*router:\s*(\w+)[^}]*\}\s*=\s*require\('\.\/api\/([\w_]+)'\)/g)) routerFile[m[1]] = m[2] + '.js';
  const mounts = [];
  for (const m of server.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*([^)]*)\)/g)) {
    for (const a of m[2].split(',').map((x) => x.trim())) {
      const inline = a.match(/^require\('\.\/api\/([\w_]+)'/);
      const file = routerFile[a] || (inline && inline[1] + '.js');
      if (file) mounts.push({ mount: m[1], file: 'api/' + file, line: lineOf(server, m.index) });
    }
  }
  const files = ['server.js', ...fs.readdirSync(path.join(ROOT, 'api')).filter((x) => x.endsWith('.js')).map((x) => 'api/' + x)];
  const routes = [], unmapped = [];
  let uses = 0;
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const kinds = {};
    for (const m of src.matchAll(/const\s+(\w+)\s*=\s*(multer|publicUpload)\(/g)) kinds[m[1]] = m[2];
    const names = Object.keys(kinds);
    if (!names.length) continue;
    for (const m of src.matchAll(new RegExp(`\\b(${names.join('|')})\\.(single|array|fields|any)\\(`, 'g'))) {
      uses++;
      const line = lineOf(src, m.index);
      const r = [...src.slice(Math.max(0, m.index - 400), m.index).matchAll(/\b(router|app)\.(post|put|patch|get|delete|use)\(\s*'([^']+)'/g)].pop();
      if (!r) { unmapped.push(`${rel}:${line}`); continue; }
      const targets = r[1] === 'app'
        ? [{ full: r[3], mountLine: line }]
        : mounts.filter((x) => x.file === rel).map((x) => ({ full: x.mount + r[3], mountLine: x.line }));
      if (!targets.length) unmapped.push(`${rel}:${line} (router not mounted)`);
      for (const t of targets) {
        const sample = t.full.replace(/:slug/g, 'canyon-gate').replace(/:\w+/g, '0d3c5a8e-0000-4000-8000-000000000000');
        const beforeGate = t.mountLine < gateLine;
        if (beforeGate || allow.some((a) => a.test(sample))) {
          routes.push({ method: r[2].toUpperCase(), path: t.full, instance: m[1], file: rel, beforeGate, usesHelper: kinds[m[1]] === 'publicUpload' });
        }
      }
    }
  }
  return { routes, unmapped, uses };
}
