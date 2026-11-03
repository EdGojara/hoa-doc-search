// tests/test_error_correction_not_waiver.js — Ed 2026-11-03: Amanda treated a certified fee processed in error
// as a fee waiver for the board. An error correction is not a waiver. Both of Amanda's paths (staff email
// replies in lib/email/draft_reply.js, in-app requests in lib/amanda/request.js) must carry the distinction,
// and the in-app floor must name the correction path, not only "board or Ed".
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let pass = 0;
const draft = read('lib/email/draft_reply.js');
assert.ok(/ERROR CORRECTION IS NOT A WAIVER/.test(draft) && /do not send it to the board/.test(draft) && /marked held, never deleted/.test(draft), 'staff email rule present'); pass++;
const req = read('lib/amanda/request.js');
assert.ok(/An ERROR CORRECTION is not a waiver/.test(req) && /never ask staff to make the accounting correction/.test(req), 'in-app rule present'); pass++;
assert.ok(/a charge made in error is corrected instead/.test(req), 'floor names the correction path'); pass++;
console.log(`  ✓ error correction rule present in both Amanda paths\n\n${pass} passed, 0 failed`);
