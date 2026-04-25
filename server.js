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
      system: `You are a professional HOA property manager working for Bedrock Association Management. Draft courteous, professional email responses to homeowner inquiries. Always ground your response in the governing documents provided. Be empathetic but clear. Sign off as "Bedrock Association Management." Never use a personal name in the signature.`,
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

    const extractResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 }
          },
          {
            type: 'text',
            text: 'This is an HOA Architectural Control Committee (ACC) application. Please extract: homeowner name, address, phone, email, type of improvement requested, description of the project, materials, colors, dimensions, and any other relevant details. Be thorough.'
          }
        ]
      }]
    });

    const appDetails = extractResponse.content[0].text;
    const context = await getRelevantChunks(appDetails, community);

    const reviewResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: `You are an HOA Architectural Control Committee (ACC) reviewer for Bedrock Association Management. Review ACC applications against the community's governing documents and design guidelines. Be thorough, cite specific document sections, and provide clear recommendations. Sign off as "Bedrock Association Management" — never use a personal name.`,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 }
          },
          {
            type: 'text',
            text: `Community: ${community}\n\nExtracted application details:\n${appDetails}\n\n${notes ? `Additional notes: ${notes}` : ''}\n\nRelevant governing documents:\n${context}\n\nPlease provide:\n1. SUMMARY\n2. APPLICATION COMPLETENESS\n3. DOCUMENT REVIEW\n4. RECOMMENDATION\n5. CONDITIONS\n6. DRAFT RESPONSE LETTER`
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

app.post('/ask-ed', async (req, res) => {
  try {
    const { situation, community } = req.body;

    const { data: playbook } = await supabase
      .from('playbook')
      .select('*')
      .order('created_at', { ascending: false });

    const playbookContext = playbook?.length
      ? `Here are examples of how Bedrock Association Management has handled similar situations:\n\n${playbook.map(p =>
          `SITUATION: ${p.situation}\nCATEGORY: ${p.category || 'General'}\nRESPONSE: ${p.response}\nREASONING: ${p.reasoning || 'Not specified'}`
        ).join('\n\n---\n\n')}`
      : 'No playbook examples available yet.';

    const docContext = await getRelevantChunks(situation, community);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: `You are "Ask Ed" — an AI advisor that thinks and responds like an experienced HOA property management professional at Bedrock Association Management. You are direct, professional, empathetic but firm, and skilled at negotiation and conflict resolution. When drafting any response letters or emails, always sign off as "Bedrock Association Management" — never use a personal name in the signature.`,
      messages: [{
        role: 'user',
        content: `${playbookContext}\n\nRelevant governing documents:\n${docContext}\n\nSituation to handle:\n${situation}\n\n${community ? `Community: ${community}` : ''}\n\nProvide:\n1. RECOMMENDED ACTION - What to do\n2. HOW TO RESPOND - Draft response or talking points\n3. REASONING - Why handle it this way\n4. WATCH OUTS - What to be careful about`
      }]
    });

    res.json({ guidance: response.content[0].text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ guidance: 'Error getting guidance. Please try again.' });
  }
});

app.post('/playbook', async (req, res) => {
  try {
    const { situation, context, response, reasoning, category, tags } = req.body;
    const { data, error } = await supabase.from('playbook').insert({
      situation, context, response, reasoning, category,
      tags: tags ? tags.split(',').map(t => t.trim()) : []
    }).select();
    if (error) throw error;
    res.json({ success: true, entry: data[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/playbook', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('playbook')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ entries: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});