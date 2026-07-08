// Generate three .eml files for the Lennar / Still Creek launch:
//   1. Reply-all to Richelle's original thread (To Richelle, Cc Christy + Teresa)
//   2. Personal sign-in to Richelle (with her magic link)
//   3. Personal sign-in to Teresa (with her magic link)
//
// Files land on the Desktop so Ed can double-click to open in Outlook.
// Outlook on Windows handles .eml natively — opens as a read-only message,
// click "Reply" or copy-paste to compose mode, or use File → Save As to
// stash in Drafts.

const fs = require('fs');
const path = require('path');

const FROM = 'Ed Gojara <egojara@bedrocktx.com>';
const DESKTOP = path.join(process.env.USERPROFILE || 'C:\\Users\\edget', 'Desktop');

const RICHELLE_URL = 'https://my.bedrocktxai.com/portal-login.html?token=QN7jzi-AC5GAlU6tlPrYc9BtTWImWfhyGGWvqxECIxE';
const TERESA_URL   = 'https://my.bedrocktxai.com/portal-login.html?token=SaEbDNdoKNk3y78am7PEgGS1XZG8wKUidpKcz7gCUgQ';

function rfc2822Date() {
  const d = new Date();
  return d.toUTCString().replace('GMT', '+0000');
}

function eml({ to, cc, subject, body }) {
  const lines = [];
  lines.push(`From: ${FROM}`);
  lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  lines.push(`Subject: ${subject}`);
  lines.push(`Date: ${rfc2822Date()}`);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset=utf-8');
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('X-Unsent: 1');  // Outlook hint: open as draft, not as sent message
  lines.push('');
  lines.push(body);
  return lines.join('\r\n');
}

const replyAll = eml({
  to: 'Richelle Hearitige <richelle.hearitige@lennar.com>',
  cc: 'Christy Pina <christy.pina@lennar.com>, Teresa Contreras <teresa.contreras@lennar.com>',
  subject: 'Re: Lennar - Still Creek Ranch ARC',
  body: `Hi Richelle,

Thanks for the follow up and my apologies for the delay. I've been out of the office most of the week and I am still working on the payments here with accounting and I hope to have something to you later next week.

The submittals from last week are approved and the decision letters are available in the portal once you sign in.

Portal access: I've set up portal access for you and Teresa. I'm sending each of you a separate sign-in link shortly so the tokens stay tied to each of you. Christy, if you would like access as well, just let me know.

Once you log-in, you'll see the submission page and a link to the current submissions and prior decisions along with the letters.

I believe this will be a much smoother and more organized process going forward.

Let me know if you have any questions or have any issues logging in.


Ed Gojara`,
});

const richelleEml = eml({
  to: 'Richelle Hearitige <richelle.hearitige@lennar.com>',
  subject: 'Your Bedrock builder portal access',
  body: `Hi Richelle,

Your Bedrock builder portal sign-in is below. One click signs you in directly, no password to remember. The link is good for the next 48 hours; after that I'll send a fresh one if you haven't used it yet. I believe it should stay on your computer for 30 days and then you'll need a new link.

${RICHELLE_URL}

When you sign in, you'll land directly on the new-submission form for Still Creek Ranch, the Lennar plan dropdown is loaded with the full master library (all 36 plans across the 4500-series and 4700-series with the marketing names) so you can submit a new lot in about a minute. Your seven approved lots from last week are in "Your submissions" with the decision letters ready to download.

Let me know if anything looks off.


Ed Gojara`,
});

const teresaEml = eml({
  to: 'Teresa Contreras <teresa.contreras@lennar.com>',
  subject: 'Your Bedrock builder portal access',
  body: `Hi Teresa,

Richelle mentioned you'd be working alongside her on the Still Creek Ranch ARC submittals, your sign-in to the Bedrock builder portal is below. One click signs you in directly, no password needed. The link is good for the next 48 hours; after that I'll send a fresh one if you haven't used it yet. I believe it should stay on your computer for 30 days and then you'll need a new link.

${TERESA_URL}

You and Richelle will both see all Lennar submittals at Still Creek when you log in, same view, same access. The seven lots from last week are already approved with letters on file.

Welcome to the portal, let me know if anything looks off.


Ed Gojara`,
});

const files = [
  { name: '1 - Reply to Richelle thread (Cc Christy and Teresa).eml', body: replyAll },
  { name: '2 - Magic link for Richelle.eml',                          body: richelleEml },
  { name: '3 - Magic link for Teresa.eml',                            body: teresaEml },
];

if (!fs.existsSync(DESKTOP)) fs.mkdirSync(DESKTOP, { recursive: true });

for (const f of files) {
  const p = path.join(DESKTOP, f.name);
  fs.writeFileSync(p, f.body, { encoding: 'utf8' });
  console.log('Wrote: ' + p);
}
