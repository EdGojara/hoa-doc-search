
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.post('/ask', async (req, res) => {
  const { question } = req.body;

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

  // Deduplicate
  const seen = new Set();
  chunks = chunks.filter(chunk => {
    if (seen.has(chunk.content)) return false;
    seen.add(chunk.content);
    return true;
  });

  // Fall back to random chunks if nothing found
  if (chunks.length === 0) {
    const { data } = await supabase
      .from('documents')
      .select('content, metadata')
      .limit(20);
    chunks = data || [];
  }

  const context = chunks.map(row => `[From: ${row.metadata?.filename}]\n${row.content}`).join('\n\n---\n\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `You are an assistant that answers questions about HOA governing documents for Lakes of Pine Forest HOA.

Here are relevant sections from the documents:

${context}

Question: ${question}

Answer based only on the documents provided. Be specific and cite which document and section the answer comes from. If the answer is not in the documents, say so clearly.`
    }]
  });

  res.json({ answer: response.content[0].text });
});

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});