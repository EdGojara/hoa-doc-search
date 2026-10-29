// ============================================================================
// tests/test_acc_attachment_guard.js  (Ed 2026-10-29)
// ----------------------------------------------------------------------------
// THE GAP. The ACC transport guard (lib/email/graph_send accDecisionGuard) read
// only the subject and body. A decision letter attached as a PDF under a
// neutral body ("Please see the attached") went to the homeowner with no
// authorized decision recorded. Staff can attach any uploaded file or filed
// library document to a Communications reply, and the Draft Queue sends stored
// attachments, so this was a working way around Ed's approval.
//
// Builds real PDFs (pdf-lib) so the text extraction actually runs. Offline:
// no database, no network. Wording is taken from real issued letters.
//
// Run: node tests/test_acc_attachment_guard.js
// ============================================================================
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { accDecisionGuard } = require('../lib/email/graph_send');
const AT = require('../lib/acc/attachment_text');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); }
}

async function pdf(lines, pages = 1) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([612, 792]);
    (p === 0 ? lines : ['Page ' + (p + 1)]).forEach((l, i) => page.drawText(l, { x: 50, y: 740 - i * 18, size: 11, font }));
  }
  return Buffer.from(await doc.save());
}
async function blankPdf() { const doc = await PDFDocument.create(); doc.addPage([612, 792]); return Buffer.from(await doc.save()); }
const att = (name, buf, contentType = 'application/pdf') => ({ '@odata.type': '#microsoft.graph.fileAttachment', name, contentType, contentBytes: buf.toString('base64') });

const HOMEOWNER = 'homeowner@example.com';
const NEUTRAL = '<p>Hello, please see the attached letter regarding your request.</p>';
async function outcome(args) {
  try { await accDecisionGuard(args); return { sent: true }; } catch (e) { return { sent: false, code: e.code, msg: e.userMessage || e.message, files: e.blockedAttachments || [] }; }
}

(async () => {
  const approval = await pdf(['Waterview Estates', 'Dear Homeowner,',
    'Your application to replace existing windows has been reviewed and approved by the',
    'Architectural Control Committee of Waterview Estates.', 'Your approval is subject to the following conditions: 1. Match existing color.']);
  const denial = await pdf(['Lakes of Pine Forest', 'Dear Homeowner,', 'The Architectural Control Committee has denied your application', 'for the storage shed as submitted.']);
  const infoRequest = await pdf(['Waterview Estates', 'Dear Homeowner,', 'To move forward with your architectural application, we need one additional',
    'document before the committee can issue an approval. Once we receive it, the committee', 'will be positioned to move quickly toward approval.']);
  const packet = await pdf(['Canyon Gate at Cinco Ranch', 'Your architectural application has been approved, subject to the conditions below.'], 6);
  const scan = await blankPdf();

  console.log('\nDecision letter attached under a neutral body');
  let r = await outcome({ to: HOMEOWNER, subject: 'Your request', html: NEUTRAL, attachments: [att('letter.pdf', approval)] });
  check('approval letter PDF, nothing recorded -> not sent', !r.sent && r.code === 'acc_decision_not_authorized', JSON.stringify(r));
  check('...and the message names the attachment', /letter\.pdf/.test(r.msg || '') && r.files.includes('letter.pdf'), r.msg);
  r = await outcome({ to: HOMEOWNER, subject: 'Your request', html: NEUTRAL, attachments: [att('Shed decision.pdf', denial)] });
  check('denial letter PDF, nothing recorded -> not sent', !r.sent, JSON.stringify(r));
  r = await outcome({ to: HOMEOWNER, subject: 'Your request', html: NEUTRAL, attachments: [att('packet.pdf', packet)] });
  check('decision packet (letter on page 1 of 6) -> not sent', !r.sent, JSON.stringify(r));
  r = await outcome({ to: HOMEOWNER, cc: 'egojara@bedrocktx.com', subject: 'Your request', html: NEUTRAL, attachments: [att('letter.pdf', approval)] });
  check('copying staff does not exempt a homeowner email', !r.sent);
  r = await outcome({ to: HOMEOWNER, subject: 'Your request', html: NEUTRAL, attachments: [att('letter.txt', Buffer.from('Your architectural application has been approved.'), 'text/plain')] });
  check('a text attachment is read too', !r.sent);

  console.log('\nUnreadable files are judged by their name');
  r = await outcome({ to: HOMEOWNER, subject: 'Your request', html: NEUTRAL, attachments: [att('ACC Approval Letter.pdf', scan)] });
  check('a scan named like an ACC decision -> not sent', !r.sent, JSON.stringify(r));
  r = await outcome({ to: HOMEOWNER, subject: 'Your request', html: NEUTRAL, attachments: [att('decision-WAT-ARC-2026-0033.pdf', scan)] });
  check('the portal\'s decision-<ref>.pdf name -> not sent', !r.sent);
  // Real names of scanned ACC decisions filed in the library (unreadable scans).
  for (const n of ['20018 Cape Clover Trail - Roof - Approved.pdf', '19623 Norfolk Ridge Way-Gazebo Denial.pdf',
    '5226 Jay Thrush appd remove tree.pdf', '19603 Sandal Grove fence apprvoal with stipulations.pdf']) {
    r = await outcome({ to: HOMEOWNER, subject: 'Your request', html: NEUTRAL, attachments: [att(n, scan)] });
    check(`filed scan "${n}" -> not sent`, !r.sent, JSON.stringify(r));
  }
  r = await outcome({ to: HOMEOWNER, subject: 'Your ACC application', html: NEUTRAL, attachments: [att('packet.pdf', scan)] });
  check('any unreadable file in an email about an ACC application -> not sent', !r.sent, JSON.stringify(r));
  r = await outcome({ to: HOMEOWNER, subject: 'Your request', html: '<p>Regarding your architectural review.</p>', attachments: [att('IMG_2041.jpg', Buffer.from('x'), 'image/jpeg')] });
  check('...an image included (a letter can be a picture)', !r.sent);
  const blankForm = await pdf(['Waterview Estates', 'Architectural Review Application', 'Owner name: ____________  Property address: ____________', 'Describe the proposed improvement: ____________']);
  r = await outcome({ to: HOMEOWNER, subject: 'Your ACC application', html: NEUTRAL, attachments: [att('Architectural Review Application - Waterview Estates.pdf', blankForm)] });
  check('the blank application form (readable, as every form on file is) still sends', r.sent, JSON.stringify(r));
  r = await outcome({ to: HOMEOWNER, subject: 'Your request', html: NEUTRAL, attachments: [att('Original Bylaws.pdf', scan), att('IMG_2041.jpg', Buffer.from('x'), 'image/jpeg')] });
  check('scans and photos in mail that is not about ACC still send', r.sent, JSON.stringify(r));

  console.log('\nOrdinary mail is not blocked');
  r = await outcome({ to: HOMEOWNER, subject: 'Your request', html: NEUTRAL, attachments: [att('Request for information.pdf', infoRequest)] });
  check('an information-request letter PDF still sends', r.sent, JSON.stringify(r));
  r = await outcome({ to: 'egojara@bedrocktx.com', subject: 'For your review', html: NEUTRAL, attachments: [att('letter.pdf', approval)] });
  check('sending the letter to Ed for review is not blocked', r.sent, JSON.stringify(r));
  r = await outcome({ to: HOMEOWNER, subject: 'Your request', html: NEUTRAL, attachments: [] });
  check('a plain email with no attachments still sends', r.sent);

  console.log('\nThe file reader');
  const read = await AT.readAttachments([att('letter.pdf', approval), att('scan.pdf', scan)]);
  check('reads the text of a real PDF', read[0].readable && /reviewed and approved/.test(read[0].text.replace(/\s+/g, ' ')), read[0].text.slice(0, 120));
  check('reports a scan as unreadable', read[1].readable === false);
  check('a damaged PDF does not throw', (await AT.readAttachments([att('broken.pdf', Buffer.from('%PDF-1.4 garbage'))]))[0].readable === false);
  check('inline images (signature logo) are skipped', (await AT.readAttachments([{ ...att('logo.png', Buffer.from('x'), 'image/png'), isInline: true }])).length === 0);

  console.log('\nWiring (static)');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'graph_send.js'), 'utf8');
  const calls = src.match(/await accDecisionGuard\(\{[^}]*\}\)/g) || [];
  check('both Graph send paths run the guard', calls.length === 2, String(calls.length));
  check('both pass their attachments to it', calls.length === 2 && calls.every((c) => /\battachments\b/.test(c)), calls.join(' | '));

  const triage = fs.readFileSync(path.join(__dirname, '..', 'api', 'email_triage.js'), 'utf8');
  check('Communications reply refuses a scanned ACC library record', /a\.category === 'arc_application'[\s\S]{0,300}!f\.readable/.test(triage));
  check('the library lookup reports the document category', /category: doc\.category/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'doc_attachment.js'), 'utf8')));

  console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mall ACC attachment-guard checks passed\x1b[0m');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
