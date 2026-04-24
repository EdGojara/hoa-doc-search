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
    const { community, notes } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded.' });

    const pdfBase64 = req.file.buffer.toString('base64');

    // First pass: extract application details using Claude's native PDF support
    const extractResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: pdfBase64
            }
          },
          {
            type: 'text',
            text: 'This is an HOA Architectural Control Committee (ACC) application. Please extract: homeowner name, address, phone, email, type of improvement requested, description of the project, materials, colors, dimensions, and any other relevant details. Be thorough.'
          }
        ]
      }]
    });

    const appDetails = extractResponse.content[0].text;

    // Get relevant governing document chunks based on extracted details
    const context = await getRelevantChunks(appDetails, community);

    // Second pass: full review with governing docs
    const reviewResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: `You are an HOA Architectural Control Committee (ACC) reviewer for Bedrock Association Management. Review ACC applications against the community's governing documents and design guidelines. Be thorough, cite specific document sections, and provide clear recommendations.`,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: pdfBase64
            }
          },
          {
            type: 'text',
            text: `Community: ${community}

Extracted application details:
${appDetails}

${notes ? `Additional notes from staff: ${notes}` : ''}

Relevant governing documents and design guidelines:
${context}

Please provide a complete ACC review with:
1. SUMMARY - What the homeowner is requesting
2. APPLICATION COMPLETENESS - Is the application complete? What's missing?
3. DOCUMENT REVIEW - Cite specific sections that apply to this request
4. RECOMMENDATION - Approve, Approve with Conditions, or Deny with clear reasoning
5. CONDITIONS - Any conditions that must be met for approval
6. DRAFT RESPONSE LETTER - Professional letter to the homeowner`
          }
        ]
      }]
    });

    res.json({ review: reviewResponse.content[0].text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error processing ACC application: ' + err.message });
  }
});

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});
