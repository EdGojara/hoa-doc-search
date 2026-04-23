const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.mjs');

require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const filePath = process.argv[2];
const community = process.argv[3];

if (!filePath || !community) {
  console.log('Usage: node upload.js "path/to/file.pdf" "Community Name"');
  process.exit(1);
}

async function extractText(filePath) {
  const data = new Uint8Array(fs.readFileSync(filePath));
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(' ') + '\n';
  }
  return text;
}

function chunkText(text, chunkSize = 1000, overlap = 200) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + chunkSize));
    start += chunkSize - overlap;
  }
  return chunks;
}

async function upload() {
  console.log(`Processing: ${filePath}`);
  console.log(`Community: ${community}`);

  const text = await extractText(filePath);
  const chunks = chunkText(text);
  const filename = path.basename(filePath);

  for (let i = 0; i < chunks.length; i++) {
    console.log(`Storing chunk ${i + 1} of ${chunks.length}`);
    await supabase.from('documents').insert({
      content: chunks[i],
      metadata: { filename, community },
      embedding: null
    });
  }

  console.log(`Done! Uploaded ${chunks.length} chunks for ${community}.`);
}

upload().catch(console.error);