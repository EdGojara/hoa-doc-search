const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getRelevantChunks(text, community) {
  const embeddingResponse = await openai.embeddings.create({
    model: 'text-embedding-ada-002',
    input: text.replace(/\n/g, ' ').slice(0, 8000)
  });
  const queryEmbedding = embeddingResponse.data[0].embedding;
  const communities = ['Law', 'General'];
  if (community) communities.push(community);
  const { data: chunks, error } = await supabase.rpc('match_documents', {
    query_embedding: queryEmbedding,
    match_count: 15,
    filter_communities: communities
  });
  if (error) throw new Error('Search error: ' + error.message);
  return (chunks || []).map(row =>
    `[From: ${row.metadata?.filename} - ${row.metadata?.community}]\n${row.content}`
  ).join('\n\n---\n\n');
}

app.post('/ask', async (req, res) => {
  try {
    const { question, community, history = [] } = req.body;
    const context = await getRelevantChunks(question, community);
    const messages = [
      ...history.slice(-6),
      {
        role: 'user',
        content: `Here are relevant sections from HOA governing documents, law, and general resources:\n\n${context}\n\nQuestion: ${question}\n\nAnswer based on the documents. Be specific and cite which document the answer comes from. If not in the documents, say so clearly.`
      }
    ];
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: `You are a helpful assistant for Bedrock Association Management. You are currently answering questions about ${community || 'an HOA community'}. Be conversational, clear, and helpful. Cite the specific document when you find information. Law and General documents apply to all communities.`,
      messages
    });
    res.json({ answer: response.content[0].text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ answer: 'Search error. Please try again.' });
  }
});

app.post('/draft', async (req, res) => {
  try {
    const { email, community } = req.body;
    const context = await getRelevantChunks(email, community);
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: `You are a professional HOA property manager working for Bedrock Association Management. Draft courteous, professional email responses to homeowner inquiries. Always ground your response in the governing documents provided. Be empathetic but clear. Sign off as "Bedrock Association Management."`,
      messages: [{
        role: 'user',
        content: `You are responding on behalf of ${community || 'the HOA'}.\n\nRelevant governing documents:\n\n${context}\n\nHomeowner email to respond to:\n\n${email}\n\nDraft a professional response email.`
      }]
    });
    res.json({ draft: response.content[0].text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ draft: 'Error generating draft. Please try again.' });
  }
});

app.post('/acc-review', upload.single('pdf'), async (req, res) => {
  try {
    const { community } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded.' });

    // Extract text from PDF
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(req.file.buffer);
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    let accText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      accText += content.items.map(item => item.str).join(' ') + '\n';
    }

    const context = await getRelevantChunks(accText, community);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: `You are an HOA Architectural Control Committee (ACC) reviewer for Bedrock Association Management. Review ACC applications against the community's governing documents and design guidelines. Be thorough, cite specific document sections, and provide clear recommendations.`,
      messages: [{
        role: 'user',
        content: `Community: ${community}\n\nRelevant governing documents and design guidelines:\n\n${context}\n\nACC Application content:\n\n${accText}\n\nPlease provide:\n1. SUMMARY of what the homeowner is requesting\n2. DOCUMENT REVIEW - cite specific sections that apply\n3. RECOMMENDATION - Approve, Approve with Conditions, or Deny\n4. CONDITIONS or REASONS (if applicable)\n5. DRAFT RESPONSE LETTER to the homeowner`
      }]
    });

    res.json({ review: response.content[0].text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error processing ACC application. Please try again.' });
  }
});

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});