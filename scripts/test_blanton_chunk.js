// Test whether ANY chunk of the BLANTON PDF can be processed by the
// Anthropic API. If even a 5-page slice fails, the source PDF has a
// structural issue and the bulk-extract failure was inevitable.

const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PDF_PATH = 'C:\\Users\\edget\\AppData\\Local\\Temp\\1610 - BLANTON (1).pdf';

(async () => {
  const buf = fs.readFileSync(PDF_PATH);
  console.log('Source: ' + (buf.length / 1024 / 1024).toFixed(1) + ' MB');

  const src = await PDFDocument.load(buf);
  console.log('pdf-lib page count: ' + src.getPageCount());

  // Try several chunk sizes to identify where it breaks
  for (const range of [[1, 1], [1, 3], [1, 5], [1, 10], [1, 20]]) {
    const chunk = await PDFDocument.create();
    const idx = [];
    for (let i = range[0] - 1; i < range[1]; i++) idx.push(i);
    const copied = await chunk.copyPages(src, idx);
    copied.forEach((p) => chunk.addPage(p));
    const chunkBuf = Buffer.from(await chunk.save());
    console.log('\nChunk pp ' + range[0] + '-' + range[1] + ': ' + (chunkBuf.length / 1024 / 1024).toFixed(2) + ' MB');
    try {
      const r = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: chunkBuf.toString('base64') } },
          { type: 'text', text: 'In one line: what plan name and number do you see, and how many pages?' },
        ]}],
      });
      console.log('  ✓ ' + r.content[0].text.trim().slice(0, 200));
    } catch (e) {
      console.log('  ✗ ' + e.message);
      break;  // If a smaller chunk failed, larger will too
    }
  }
})();
