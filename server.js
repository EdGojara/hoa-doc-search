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

app.post('/acc-review', upload.fields([
  { name: 'pdf', maxCount: 1 }
]), async (req, res) => {
  try {
    const { community, details } = req.body;
    const imageCount = parseInt(req.body.image_count) || 0;

    if (!details && !req.files?.pdf) {
      return res.status(400).json({ error: 'Please provide application details or upload a PDF.' });
    }

    // Build content blocks for Claude
    const contentBlocks = [];

    // Add PDF if provided
    if (req.files?.pdf) {
      const pdfBase64 = req.files.pdf[0].buffer.toString('base64');
      contentBlocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: pdfBase64
        }
      });
    }

    // Add images if provided
    for (let i = 0; i < imageCount; i++) {
      const imgBase64 = req.body[`image_${i}`];
      const imgType = req.body[`image_type_${i}`];
      if (imgBase64) {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: imgType || 'image/jpeg',
            data: imgBase64
          }
        });
      }
    }

    // Get relevant governing document chunks
    const searchText = details || 'ACC application exterior modification improvement';
    const context = await getRelevantChunks(searchText, community);

    // Build the review prompt
    const promptText = `Community: ${community}

${details ? `Application Details Provided by Staff:\n${details}\n` : ''}

Relevant governing documents and design guidelines:
${context}

Please provide a complete ACC review with:
1. SUMMARY - What the homeowner is requesting (use details provided and/or extract from any uploaded documents/images)
2. APPLICATION COMPLETENESS - Is the application complete? What's missing?
3. DOCUMENT REVIEW - Cite specific sections that apply to this request
4. VISUAL REVIEW - If photos or color samples were provided, describe what you see and assess compliance with design guidelines
5. RECOMMENDATION - Approve, Approve with Conditions, or Deny with clear reasoning
6. CONDITIONS - Any conditions that must be met for approval
7. DRAFT RESPONSE LETTER - Professional letter to the homeowner`;

    contentBlocks.push({ type: 'text', text: promptText });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: `You are an HOA Architectural Control Committee (ACC) reviewer for Bedrock Association Management. Review ACC applications against the community's governing documents and design guidelines. Be thorough, cite specific document sections, and provide clear recommendations. When photos or color samples are provided, assess them against the community's design standards.`,
      messages: [{ role: 'user', content: contentBlocks }]
    });

    res.json({ review: response.content[0].text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error processing ACC application: ' + err.message });
  }
});

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});