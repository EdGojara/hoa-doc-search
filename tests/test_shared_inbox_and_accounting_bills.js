#!/usr/bin/env node
// Ed 2026-11-15: info@ on push without disturbing the shared Outlook inbox; accounting@ vendor bills
// reach Emma while accounting correspondence stays with Kat.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:1';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'x';
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };
const G = require('../lib/email/graph_ingest');
const { personaForMessage } = require('../lib/email/persona');
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'graph_ingest.js'), 'utf8').split(String.fromCharCode(13)).join('');

console.log('shared inbox');
check('info@ is a shared inbox (any case); the AI mailboxes are not', G.isSharedInbox('Info@BedrockTX.com') && !G.isSharedInbox('emma@bedrocktx.com') && !G.isSharedInbox('kat@bedrocktx.com'));
check('ingest never files (moves or marks read) a shared inbox', src.includes("const fileProcessed = !light && process.env.FILE_PROCESSED_MAIL !== 'false' && !isSharedInbox(mailbox);"));
{ const at = []; let i = -1; while ((i = src.indexOf('fileMessage(mailbox', i + 1)) >= 0) at.push(i);
  check('every move in ingest sits inside an if (fileProcessed ...) block', at.length >= 3 && at.every((p) => src.slice(Math.max(0, p - 500), p).includes('if (fileProcessed'))); }

console.log('accounting@ routing');
const acct = (o) => personaForMessage({ mailbox: 'accounting@bedrocktx.com', direction: 'inbound', sender_email: 'billing@lakepro.com', subject: 'Invoice 263724 from Lake Pro, Inc.', classification: 'vendor_financial', has_attachments: true, body_preview: 'Your invoice is attached. Amount due $1,200.00. Due date 11/30/2026.', extracted: {}, ...o });
check('a vendor invoice with a file goes to Emma', acct({}) === 'emma');
check('the same mail with no attachment stays Kat\'s', acct({ has_attachments: false }) === 'kat');
check('a bank\'s mail stays Kat\'s', acct({ sender_email: 'treasury@newfirst.com' }) === 'kat');
check('accounting correspondence (not vendor mail) stays Kat\'s', acct({ classification: 'internal', sender_email: 'cdeleon@bedrocktx.com', subject: 'October close question' }) === 'kat');
check('accounting@ sends vendor mail to Emma exactly when info@ would (one bill rule, not a second copy)', ['Invoice 263724 from Lake Pro, Inc.', 'Past due notice', 'Thank you for your payment'].every((subject) => (acct({ subject }) === 'emma') === (personaForMessage({ mailbox: 'info@bedrocktx.com', direction: 'inbound', sender_email: 'billing@lakepro.com', subject, classification: 'vendor_financial', has_attachments: true, body_preview: 'Attached.', extracted: {} }) === 'emma')));
check('info@ vendor bills still go to Emma', personaForMessage({ mailbox: 'info@bedrocktx.com', direction: 'inbound', sender_email: 'billing@lakepro.com', subject: 'Invoice 263724 from Lake Pro, Inc.', classification: 'vendor_financial', has_attachments: true, body_preview: 'Invoice attached. Amount due $1,200.00.', extracted: {} }) === 'emma');

console.log(`\nshared inbox + accounting bills: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
