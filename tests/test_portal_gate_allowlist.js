// Every API path a homeowner portal page calls must pass the staff gate on the
// portal cookie alone. Scar (Ed 2026-11-27 launch review): transactions,
// messages, ARC, events, vendors and local contacts were missing from
// _STAFF_GATE_PUBLIC, so real homeowners got 401 while staff testing (who also
// carry the staff cookie) saw everything work. Staff-only pages and endpoints
// are listed below on purpose; anything new must be added to one list or the other.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const a = src.indexOf('const _STAFF_GATE_PUBLIC = [');
const b = src.indexOf('];', a);
// eslint-disable-next-line no-eval
const patterns = [...src.slice(a, b).matchAll(/^\s*(\/\^.*?\/[a-z]*)\s*,/gm)].map((m) => eval(m[1]));
assert.ok(patterns.length > 50, 'parsed the staff-gate allowlist');

// Pages that only staff open (manager tools, admin screens).
const STAFF_PAGES = new Set(['portal-adoption.html', 'portal-arc-admin.html', 'portal-tiles-admin.html', 'portal-staff-enter.html', 'portal-staff-enter-builder.html']);
// Endpoints a homeowner page may call that are deliberately staff-only (staff mode / demo / sandbox).
const STAFF_ONLY = [/^\/api\/portal\/(staff-enter|mimic\/(start|stop)|presentation|manager\/properties)$/, /^\/api\/payments\/test\//];

const ID = '00000000-0000-0000-0000-000000000000';
const misses = [];
for (const f of fs.readdirSync(path.join(root, 'public')).filter((n) => /^portal.*\.html$/.test(n) && !STAFF_PAGES.has(n))) {
  const html = fs.readFileSync(path.join(root, 'public', f), 'utf8');
  for (const m of html.matchAll(/['"`](\/api\/[A-Za-z0-9_\-/.${}]+)/g)) {
    // A ${...} that fills a whole path segment is an id; one glued to text (a ?query) is dropped.
    const p = m[1].replace(/\/\$\{[^}]*\}/g, '/' + ID).replace(/\$\{[^}]*\}/g, '').replace(/\/$/, '/' + ID);
    if (p.endsWith('/api/portal/pay/' + ID)) continue; // prefix used to build /pay/setup|quote|confirm
    if (STAFF_ONLY.some((r) => r.test(p))) continue;
    if (!patterns.some((r) => r.test(p))) misses.push(`${f}: ${m[1]}`);
  }
}
// Claire's visit page (portal tile): its calls are built as A + '/session/' + SESSION.id + '/x'.
{
  const html = fs.readFileSync(path.join(root, 'public', 'claire.html'), 'utf8');
  for (const m of html.matchAll(/A\+'(\/[a-z/-]+)'(?:\+SESSION\.id\+'(\/[a-z-]+)')?/g)) {
    const p = '/api/claire' + m[1] + (m[2] ? ID + m[2] : '');
    if (!patterns.some((r) => r.test(p))) misses.push(`claire.html: ${p}`);
  }
  assert.ok(html.includes("A+'/session/'+SESSION.id+'/speak'"), 'the voice call is still where this test looks for it');
}
assert.deepStrictEqual(misses, [], 'homeowner portal pages call paths the staff gate blocks:\n  ' + misses.join('\n  '));
// Staff-only endpoints must stay gated.
for (const p of ['/api/portal/mimic/start', '/api/portal/staff-enter', '/api/portal/manager/properties', '/api/portal-admin/communities']) {
  assert.ok(!patterns.some((r) => r.test(p)), `${p} must stay behind the staff gate`);
}
console.log('test_portal_gate_allowlist: passed');
