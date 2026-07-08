// Quick read of Ed's reference PDFs to understand existing letter format
// + the ACC app variant. Output goes to stdout for Claude to interpret.
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PDFS = [
  {
    label: 'VARIANCE_APPROVAL_LETTER',
    path: 'C:\\Users\\edget\\OneDrive - Bedrock Association Management, LLC\\BEDROCK\\Client - Still Creek Ranch\\ACC\\2025 Lennar Section 5\\SCR - Lennar Homes variance approval letter 2025.09.11.pdf',
    prompt: `This is a historical Bedrock-issued ARC approval letter to Lennar for Still Creek Ranch.

Return a STRUCTURED dump of:
1. The letterhead/header text exactly as printed (community name, logo presence, return-address block).
2. The date.
3. The recipient block exactly as printed.
4. The Re: line and reference number format.
5. The body paragraphs (numbered, each one summarized in 1 sentence).
6. Any spec table / approved materials block — exact format and what fields it lists.
7. Conditions list if present.
8. Whether the $150 processing fee is mentioned, and EXACTLY how it's phrased (e.g. "fee received", "fee due", "$150 processing fee enclosed", etc).
9. Closing block (sign-off, signature line, contact info).
10. Footer language.
11. Any other distinctive elements (gold rule, watermark, etc).

Return as JSON with those 11 fields. Be FAITHFUL — quote exact phrases verbatim where useful.`,
  },
  {
    label: 'TYE_CREEK_ACC_APPLICATION',
    path: 'C:\\Users\\edget\\OneDrive - Bedrock Association Management, LLC\\BEDROCK\\Client - Still Creek Ranch\\Builders\\Builder - Architectural Applications\\Applications\\Tye Creek Lane\\7407 Tye Creek Lane - ACC app.pdf',
    prompt: `This is a builder ARC application submitted to Bedrock for Still Creek Ranch.

Return STRUCTURED:
1. Address + lot/block/section
2. Builder name + submitter contact
3. Plan / elevation / orientation / sqft
4. Materials submitted (brick, paint, shingles, etc — any other materials fields)
5. Whether the form mentions a $150 processing fee anywhere, and exact phrasing
6. Any fields on this form that don't appear on the 5503 Twilight Thicket form I've already seen
7. Date submitted / signed

Return as JSON.`,
  },
];

async function describePdf(p) {
  const buf = fs.readFileSync(p.path);
  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } },
        { type: 'text', text: p.prompt },
      ],
    }],
  });
  return r.content[0].text;
}

(async () => {
  for (const p of PDFS) {
    if (!fs.existsSync(p.path)) { console.log('MISSING ' + p.label + ': ' + p.path); continue; }
    console.log('=========================================================');
    console.log('  ' + p.label);
    console.log('=========================================================');
    try {
      console.log(await describePdf(p));
    } catch (e) {
      console.log('ERR: ' + e.message);
    }
    console.log('\n');
  }
})();
