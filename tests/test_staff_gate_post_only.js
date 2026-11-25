// The builder intake path is public for the builder's POST only; reading the
// same path (the review queue) requires staff sign-in. (Ed 2026-11-25)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = src.indexOf('const _STAFF_GATE_POST_ONLY');
const end = src.indexOf('}', src.indexOf('function _gateIsPublicPath')) + 1;
const body = src.slice(start, end);
// eslint-disable-next-line no-new-func
const make = new Function('_STAFF_GATE_PUBLIC', `${body}; return _gateIsPublicPath;`);
const isPublic = make([/^\/api\/builder-applications\/public\b/, /^\/api\/builder-applications$/, /^\/api\/builder-applications\/[0-9a-f-]+\/attachments$/]);
assert.strictEqual(isPublic('/api/builder-applications', 'POST'), true, 'builder intake POST stays public');
assert.strictEqual(isPublic('/api/builder-applications', 'GET'), false, 'the review queue needs staff sign-in');
assert.strictEqual(isPublic('/api/builder-applications/6657baf5-f44e-43cc-9372-49a6fc491443/attachments', 'POST'), true);
assert.strictEqual(isPublic('/api/builder-applications/6657baf5-f44e-43cc-9372-49a6fc491443/attachments', 'GET'), false);
assert.strictEqual(isPublic('/api/builder-applications/public/status/SCR-BLD-2026-0081', 'GET'), true, 'public status lookup unchanged');
assert.ok(/_gateIsPublicPath\(req\.path, req\.method\)/.test(src), 'the gate passes the method');
console.log('test_staff_gate_post_only: 6 passed');
