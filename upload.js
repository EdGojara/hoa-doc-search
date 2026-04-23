require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function chunkText(text, chunkSize = 1000, overlap = 200) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = start + chunkSize;
    chunks.push(text.slice(start, end));
    start += chunkSize - overlap;
  }
  return chunks;
}

async function extractTextFromPDF(filePath) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjsLib.getDocument({ data }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(' ') + '\n';
  }
  return text;
}

async function uploadPDF(filePath) {
  console.log(`Processing: ${filePath}`);
  const text = await extractTextFromPDF(filePath);
  console.log(`Extracted ${text.length} characters`);

  const chunks = chunkText(text);
  console.log(`Split into ${chunks.length} chunks`);

  const fileName = path.basename(filePath);

  for (let i = 0; i < chunks.length; i++) {
    console.log(`Storing chunk ${i + 1} of ${chunks.length}`);
    const { error } = await supabase.from('documents').insert({
      content: chunks[i],
      metadata: { filename: fileName, chunk: i }
    });
    if (error) console.error('Error storing chunk:', error);
  }
  console.log(`Done processing ${fileName}`);
}

const filePath = process.argv[2];
if (!filePath) {
  console.log('Usage: node upload.js <path-to-pdf>');
  process.exit(1);
}
uploadPDF(filePath).catch(console.error);