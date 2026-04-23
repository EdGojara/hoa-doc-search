require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.post('/ask', async (req, res) => {
  const { question, history = [] } = req.body;

  const stopWords = ['how', 'what', 'when', 'where', 'who', 'why', 'is', 'are', 'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'do', 'does', 'can', 'many', 'much', 'long'];
  const keywords = question.toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.includes(w));

  let chunks = [];
  for (const keyword of keywords.slice(0, 5)) {
    const { data } = await supabase
      .from('documents')
      .select('content, metadata')
      .ilike('content', `%${keyword}%`)
      .limit(10);
    if (data) chunks.push(...data);
  }

  const seen = new Set();
  chunks = chunks.filter(chunk => {
    if (seen.has(chunk.content)) return false;
    seen.add(chunk.content);
    return true;
  });

  if (chunks.length === 0) {
    const { data } = await supabase.from('documents').select('content, metadata').limit(20);
    chunks = data || [];
  }

  const context = chunks.map(row => `[From: ${row.metadata?.filename}]\n${row.content}`).join('\n\n---\n\n');

  const messages = [
    ...history.slice(-6),
    {
      role: 'user',
      content: `Here are relevant sections from the HOA governing documents:\n\n${context}\n\nQuestion: ${question}\n\nAnswer based on the documents. Be specific and cite which document the answer comes from. If not in the documents, say so clearly and suggest who to contact.`
    }
  ];

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: 'You are a helpful assistant for Bedrock Association Management. You answer questions about HOA governing documents for communities including Lakes of Pine Forest. Be conversational, clear, and helpful. When you find information, cite the specific document. When you cannot find something, acknowledge it and suggest the homeowner contact the management company.',
    messages
  });

  res.json({ answer: response.content[0].text });
});

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});