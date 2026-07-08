// Two follow-up emails to Outlook .eml on Ed's Desktop:
//   1. Richelle — fresh sign-in link
//   2. Teresa — master plan submission URL
//
// Voice: no mechanism exposure. Each email presents the path as the
// established flow, not "we just fixed this." Per feedback memory
// feedback_fix_root_cause_no_workarounds.

const fs = require('fs');
const path = require('path');

const FROM = 'Ed Gojara <egojara@bedrocktx.com>';
const DESKTOP = path.join(process.env.USERPROFILE || 'C:\\Users\\edget', 'Desktop');

const RICHELLE_URL = 'https://my.bedrocktxai.com/portal-login.html?token=opz08BPI2pmMoF0AclM1mHhWYnoyT0NCiTdgaxfMI0U';
const TERESA_MASTER_PLAN_URL = 'https://my.bedrocktxai.com/builders/still-creek-lennar/master-plan';

function rfc2822Date() {
  const d = new Date();
  return d.toUTCString().replace('GMT', '+0000');
}

function eml({ to, cc, subject, body, inReplyToHint }) {
  const lines = [];
  lines.push(`From: ${FROM}`);
  lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
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

const richelleEml = eml({
  to: 'Richelle Hearitige <richelle.hearitige@lennar.com>',
  subject: 'Re: Bedrock builder portal access',
  body: `Hi Richelle,

Here's a fresh sign-in link. When you click, you'll see a brief Welcome page with a Sign In button. One tap and you're in for 30 days in your browser.

${RICHELLE_URL}

Let me know if anything looks off.

Ed Gojara`,
});

const teresaEml = eml({
  to: 'Teresa Contreras <teresa.contreras@lennar.com>',
  subject: 'Re: Bedrock builder portal access',
  body: `Hi Teresa,

For adding a new master plan to the Still Creek Ranch catalog, the master plan submission page is below. Drop the full plan PDF set, list the plan numbers being submitted, and the ARC committee will review.

${TERESA_MASTER_PLAN_URL}

Once approved, those plans will appear in the dropdown the next time you start a per-lot construction submission, so you can fast-track future lots against them.

Let me know if anything looks off.

Ed Gojara`,
});

const files = [
  { name: '1 - Fresh sign-in link for Richelle.eml', body: richelleEml },
  { name: '2 - Master plan link for Teresa.eml',     body: teresaEml },
];

if (!fs.existsSync(DESKTOP)) fs.mkdirSync(DESKTOP, { recursive: true });
for (const f of files) {
  const p = path.join(DESKTOP, f.name);
  fs.writeFileSync(p, f.body, { encoding: 'utf8' });
  console.log('Wrote: ' + p);
}
