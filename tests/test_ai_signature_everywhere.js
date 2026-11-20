// ============================================================================
// tests/test_ai_signature_everywhere.js  (Ed 2026-11-20)
// Every email from an AI teammate's mailbox carries that teammate's approved
// signature exactly once, however it was sent: sendAs, sendReplyAs, and paths
// that post to Microsoft Graph directly. Ed's own mailbox is never signed.
// Run: node tests/test_ai_signature_everywhere.js
// ============================================================================
const fs = require('fs');
const path = require('path');
const g = require('../lib/email/graph_send');
const P = require('../lib/email/persona_signature');

let failures = 0;
const check = (name, cond, detail) => { if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`); else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); } };
const sigs = (h) => (String(h || '').match(/Powered by Bedrock Intelligence/g) || []).length;

console.log('\nThe send chokepoint signs AI-team mail exactly once');
for (const mb of ['tessa@bedrocktx.com', 'kat@bedrocktx.com', 'emma@bedrocktx.com', 'annie@bedrocktx.com', 'amandaalbright@bedrocktx.com', 'claire@bedrocktx.com']) {
  const r = g._ensureSignature(mb, '<p>Body</p>', null, []);
  check(`${mb}: unsigned body gets one signature with portrait and logo`, sigs(r.html) === 1 && r.attachments.some((a) => a.contentId === 'headshot') && r.attachments.some((a) => a.contentId === 'bedrocklogo'));
}
const built = P.buildPersonaEmail('annie', 'Hello.', 'Waterview Estates');
const again = g._ensureSignature('annie@bedrocktx.com', built.html, null, built.attachments);
check('an already-signed body is not signed twice, images not attached twice', again.html === built.html && again.attachments.length === built.attachments.length);
check('Ed\'s own mailbox is never signed', sigs(g._ensureSignature('egojara@bedrocktx.com', '<p>x</p>', null, []).html) === 0);
check('a plain-text send becomes a signed HTML body', sigs(g._ensureSignature('kat@bedrocktx.com', null, 'line 1\nline 2', []).html) === 1);

console.log('\nNo path posts to Graph without signing');
const root = path.join(__dirname, '..');
const src = (f) => fs.readFileSync(path.join(root, f), 'utf8');
check('sendAs signs before building the message', /_ensureSignature\(from, html, text, attachments\)\);\s*\n\s*const message = \{/.test(src('lib/email/graph_send.js')));
check('sendReplyAs signs our part of the reply', /_ensureSignature\(from, html, text, attachments\)\);\s*\n\s*let ourBody/.test(src('lib/email/graph_send.js')));
check('owner-authorization notices (direct Graph draft+send) are signed', /signForMailbox\(from,/.test(src('lib/onboarding/owner_authorization.js')));
check('Amanda auto-reply (direct createReply) builds her signature', /buildAmandaEmail/.test(src('lib/amanda/auto_reply.js')));
// Any other file that posts a draft/send to Graph itself must be listed above.
const KNOWN = new Set(['lib/email/graph_send.js', 'lib/onboarding/owner_authorization.js', 'lib/amanda/auto_reply.js']);
const direct = [];
for (const dir of ['api', 'lib']) {
  const walk = (d) => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const rel = path.join(d, e.name).replace(/\\/g, '/'); if (e.isDirectory()) walk(rel); else if (/\.js$/.test(e.name)) { const s = src(rel); if (/\/sendMail[`'"]|\/send[`'"],\s*\{\s*method:\s*'POST'|\/send`,\s*\{\s*method/.test(s) && !KNOWN.has(rel)) direct.push(rel); } } };
  walk(dir);
}
check('no other file sends through Graph directly (would bypass the signature)', direct.length === 0, direct.join(', '));

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall AI signature checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
