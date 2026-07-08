// Reply to Karla covering both her emails. Landmark plans are now in the
// catalog so she can start submitting Landmark ARC applications today.

const fs = require('fs');
const path = require('path');

const FROM = 'Ed Gojara <egojara@bedrocktx.com>';
const DESKTOP = path.join(process.env.USERPROFILE || 'C:\\Users\\edget', 'Desktop');

function rfc2822Date() { return new Date().toUTCString().replace('GMT', '+0000'); }

function eml({ to, subject, body }) {
  const lines = [];
  lines.push(`From: ${FROM}`);
  lines.push(`To: ${to}`);
  lines.push(`Subject: ${subject}`);
  lines.push(`Date: ${rfc2822Date()}`);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset=utf-8');
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('X-Unsent: 1');
  lines.push('');
  lines.push(body);
  return lines.join('\r\n');
}

const karlaEml = eml({
  to: 'Karla Rutan <krutan@drbgroup.com>',
  subject: 'Re: August Meadows ARC submissions',
  body: `Hi Karla,

All seven Landmark plans (Blanton 1610, Driskill 1800, Kimbell 1960, Paramount 2080, Southfork 2380, Majestic 2550, Meyerson 2740) are in the catalog at elevations A, B, C, M, O, P. You can start submitting Landmark ARC applications today.

On the dropdown, the form pulls each elevation directly from the plan you pick, so the Plan & Elevation list shows every plan-elevation combination on file. Picking a plan locks in the right elevation automatically. All of the elevations you mentioned (L, M, O, P, Q, R, S) are in there for the plans that have them.

Let me know if anything looks off when you start the next submission.

Ed Gojara`,
});

if (!fs.existsSync(DESKTOP)) fs.mkdirSync(DESKTOP, { recursive: true });
const p = path.join(DESKTOP, '3 - Reply to Karla (Landmark plans loaded).eml');
fs.writeFileSync(p, karlaEml, { encoding: 'utf8' });
console.log('Wrote: ' + p);
