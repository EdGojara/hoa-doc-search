const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/ask', async (req, res) => {
  const { question, community, history = [] } = req.body;

  const embeddingResponse = await openai.embeddings.create({
    model: 'text-embedding-ada-002',
    input: question.replace(/\n/g, ' ')
  });
  const queryEmbedding = embeddingResponse.data[0].embedding;

  const communities = ['Law', 'General'];
  if (community) communities.push(community);

  const { data: chunks, error } = await supabase.rpc('match_documents', {
    query_embedding: queryEmbedding,
    match_count: 15,
    filter_communities: communities
  });

  if (error) {
    console.error('Search error:', error);
    return res.status(500).json({ answer: 'Search error. Please try again.' });
  }

  const context = (chunks || []).map(row =>
    `[From: ${row.metadata?.filename} - ${row.metadata?.community}]\n${row.content}`
  ).join('\n\n---\n\n');

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
});

app.post('/draft', async (req, res) => {
  const { email, community } = req.body;

  const embeddingResponse = await openai.embeddings.create({
    model: 'text-embedding-ada-002',
    input: email.replace(/\n/g, ' ')
  });
  const queryEmbedding = embeddingResponse.data[0].embedding;

  const communities = ['Law', 'General'];
  if (community) communities.push(community);

  const { data: chunks } = await supabase.rpc('match_documents', {
    query_embedding: queryEmbedding,
    match_count: 15,
    filter_communities: communities
  });

  const context = (chunks || []).map(row =>
    `[From: ${row.metadata?.filename} - ${row.metadata?.community}]\n${row.content}`
  ).join('\n\n---\n\n');

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
});

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});
});