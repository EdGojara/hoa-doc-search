// ============================================================================
// tests/test_portal_gate_coverage.js — can a homeowner / Board member actually
// reach every endpoint their pages call?
// ----------------------------------------------------------------------------
// THE SCAR (2026-10-16, pre-launch review). The server's staff gate
// (server.js _STAFF_GATE_PUBLIC) 401s every path not on its allowlist unless the
// request carries the STAFF cookie. Homeowners and Board members carry only the
// PORTAL cookie. Messages, ARC, Statement, ACC reviews, Events, Vendor directory,
// Share news, Chamber, Contacts and the tutorial dismissal, plus the Board's Ask
// Amanda, Listen and Learning, all shipped off the allowlist. Every staffer who
// tested them also had the staff cookie, so every test passed and every real
// homeowner would have hit "authentication required".
//
// This check reads the pages the way a browser would: every /api/... URL that
// public/portal*.html and the board pages call must be on the allowlist, every
// portal page link must resolve without the staff cookie, and every allowlisted
// portal/board API handler must authenticate the caller itself (the gate being
// open is only safe because the handler checks the portal cookie + scope).
// Offline: reads source only.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const server = read('server.js');

// ---- the allowlist, evaluated from server.js itself ------------------------
function loadGate() {
  const start = server.indexOf('const _STAFF_GATE_PUBLIC = [');
  assert.ok(start >= 0, 'server.js no longer defines _STAFF_GATE_PUBLIC');
  const open = server.indexOf('[', start);
  const end = server.indexOf('\n];', open);
  // An array of regex literals and comments: safe to evaluate.
  return new Function('return ' + server.slice(open, end + 2))();
}
const GATE = loadGate();
const isPublic = (p) => GATE.some((re) => re.test(p));

// Staff-only pages that happen to be named portal-*: they run with the staff
// cookie on purpose and are NOT homeowner surfaces.
const STAFF_PAGES = new Set([
  'portal-adoption.html', 'portal-arc-admin.html', 'portal-tiles-admin.html',
  'portal-staff-enter.html', 'portal-staff-enter-builder.html',
]);
const PAGES = fs.readdirSync(path.join(ROOT, 'public'))
  .filter((f) => /^portal.*\.html$/.test(f) && !STAFF_PAGES.has(f))
  .concat(['board-portal.html', 'board-vote.html', 'community-map.html', 'builder-dashboard.html', 'claire.html'])
  .filter((f) => fs.existsSync(path.join(ROOT, 'public', f)));

// Endpoints a portal page calls that are deliberately STAFF-only (the page
// itself is shared by staff and homeowners and only staff reach these calls).
// Each needs a reason; an empty list is the goal.
const STAFF_ONLY_CALLS = {
  // claire.html keeps its API base in a constant (const A='/api/claire') and
  // calls A + '/me' etc.; the real calls are covered by the /api/claire/... entries.
  '/api/claire': 'base-path constant, not a call',
  // WebSocket upgrades never pass through the Express gate (server.js 'upgrade'
  // handler). Its auth is the handler's job; see the PR follow-ups.
  '/api/claire/stt-stream': 'WebSocket, outside the HTTP gate',
};

// ---- extract the API paths a page calls ------------------------------------
const SAMPLE_ID = '00000000-0000-4000-8000-000000000000';
function apiPathsIn(src) {
  const out = [];
  const lit = /(['"`])(\/api\/(?:(?!\1)[^\\\n])*)\1/g;
  let m;
  while ((m = lit.exec(src))) {
    const before = src.slice(Math.max(0, m.index - 12), m.index);
    if (/indexOf\(\s*$|startsWith\(\s*$/.test(before)) continue; // a prefix test, not a call
    let url = m[2]
      .replace(/\$\{\s*(qs|query|params|search|suffix)\s*\}/gi, '') // a query string, not a path segment
      .replace(/\$\{[^}]*\}/g, SAMPLE_ID);
    // Follow `'...' + expr + '...'` concatenation for path segments.
    let rest = src.slice(lit.lastIndex);
    for (;;) {
      if (url.includes('?')) break;
      const dyn = rest.match(/^\s*\+\s*(encodeURIComponent\([^()]*\)|[A-Za-z_$][\w$.]*)/);
      if (!dyn) break;
      if (/^(qs|query|params|search|suffix)$/i.test(dyn[1])) break; // a query string, not a path segment
      url += SAMPLE_ID;
      rest = rest.slice(dyn[0].length);
      const tail = rest.match(/^\s*\+\s*(['"`])((?:(?!\1)[^\\\n])*)\1/);
      if (!tail) break;
      url += tail[2].replace(/\$\{[^}]*\}/g, SAMPLE_ID);
      rest = rest.slice(tail[0].length);
    }
    url = url.split('?')[0].replace(/\/+$/, (s) => (s ? '/' + SAMPLE_ID : s));
    out.push({ raw: m[2], path: url });
  }
  return out;
}

check('the extractor follows concatenated path segments', () => {
  const got = apiPathsIn("fetch('/api/portal/messages/' + encodeURIComponent(id) + '/reply', {}); if (u.indexOf('/api/board-') === 0) x();")
    .map((x) => x.path);
  assert.deepStrictEqual(got, ['/api/portal/messages/' + SAMPLE_ID + '/reply']);
});

for (const page of PAGES) {
  const src = read('public/' + page);
  const calls = apiPathsIn(src);
  check(`${page}: every API it calls is reachable with only a portal cookie`, () => {
    const missing = calls.filter((c) => !isPublic(c.path) && !STAFF_ONLY_CALLS[c.path]).map((c) => c.path);
    assert.deepStrictEqual([...new Set(missing)], [],
      'add each endpoint to _STAFF_GATE_PUBLIC (one regex per endpoint, after confirming the handler checks the portal cookie + scope)');
  });
  check(`${page}: every portal page it links to opens without the staff cookie`, () => {
    const links = [...src.matchAll(/(?:href=|location\.href\s*=\s*|window\.location\s*=\s*|`)\s*['"`]?(\/(?:portal|board-portal|board-vote|claire)[^'"`\s?#$]*)/g)].map((m) => m[1]);
    // A staff-only page linked from a shared page (shown to staff previewing) is fine.
    const bad = [...new Set(links)].filter((l) => !isPublic(l) && !STAFF_PAGES.has(l.slice(1)));
    assert.deepStrictEqual(bad, [], 'link through the /portal/... route (served by server.js) instead of the static .html path');
  });
}

check('every /portal/<page> link resolves to a real server route', () => {
  const routes = new Set([...server.matchAll(/app\.get\('(\/portal\/[a-z/-]+)'/g)].map((m) => m[1]));
  const linked = new Set();
  for (const page of PAGES) {
    for (const m of read('public/' + page).matchAll(/['"`](\/portal\/[a-z-]+(?:\/[a-z-]+)?)(?=[?'"`$])/g)) linked.add(m[1]);
  }
  const dead = [...linked].filter((l) => !routes.has(l));
  assert.deepStrictEqual(dead, [], 'a /portal/... link with no app.get route 404s');
});

// ---- the allowlist stays narrow --------------------------------------------
check('no blanket prefix opens staff routes', () => {
  for (const p of [
    '/api/portal/some-new-route', '/api/board-portal/some-new-route', '/api/portal-admin/communities',
    '/api/community-contacts/by-slug/waterview', '/api/portal/demo-sign-in', '/api/portal/staff-enter',
    '/api/portal/mimic/start', '/api/board-portal/community/x/some-new-panel', '/portal-messages.html',
    '/api/contacts', '/api/payments/assessment/create-checkout',
  ]) assert.ok(!isPublic(p), `${p} must stay behind the staff gate`);
});

// ---- every open portal/board handler authenticates the caller itself -------
const GUARDS = /resolveUserWithRole|assertOwnerLikeRole|resolvePortalUser|resolveHomeownerScope|_portalChamberScope|requireBoardViewer/;
// Open on purpose, each for a stated reason.
const NO_GUARD_OK = {
  'post /request-link': 'sends a magic link (anti-enumeration inside)',
  'post /consume': 'trades a single-use token for a cookie',
  'post /logout': 'clears the cookie',
  'get /map/:slug': 'public community map data by design',
  'post /mimic/stop': 'clears the mimic cookie only',
};
function handlers(file, mount) {
  const src = read(file);
  const out = [];
  const re = /router\.(get|post|put|patch|delete)\('([^']+)'/g;
  let m;
  while ((m = re.exec(src))) {
    const body = src.slice(m.index, m.index + 900);
    const sample = mount + m[2].replace(/:[A-Za-z]+/g, (p) => (p === ':slug' ? 'what-a-board-does' : SAMPLE_ID));
    out.push({ key: `${m[1]} ${m[2]}`, sample, body });
  }
  return out;
}
for (const [file, mount] of [['api/portal.js', '/api/portal'], ['api/board_portal.js', '/api/board-portal']]) {
  check(`${file}: every handler the staff gate lets through checks the caller`, () => {
    const open = handlers(file, mount).filter((h) => isPublic(h.sample));
    assert.ok(open.length > 10, 'expected the portal handlers to be found');
    const unguarded = open.filter((h) => !GUARDS.test(h.body) && !NO_GUARD_OK[h.key]).map((h) => h.key);
    assert.deepStrictEqual(unguarded, [], 'an allowlisted handler must resolve the portal/board caller before reading data');
  });
}

console.log(`\nportal_gate_coverage: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
