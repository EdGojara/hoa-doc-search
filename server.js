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
  const { question } = req.body;

  const { data, error } = await supabase
    .from('documents')
    .select('content, metadata')
    .limit(20);

  if (error) {
    return res.status(500).json({ error: 'Failed to fetch documents' });
  }

  const context = data.map(row => row.content).join('\n\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `You are an assistant that answers questions about HOA governing documents.

Here are relevant sections from the documents:

${context}

Question: ${question}

Answer based only on the documents provided. If the answer is not in the documents, say so.`
    }]
  });

  res.json({ answer: response.content[0].text });
});

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});