const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.post('/ask', async (req, res) => {
  const { question, community, history = [] } = req.body;

  const stopWords = ['how', 'what', 'when', 'where', 'who', 'why', 'is', 'are', 'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'do', 'does', 'can', 'many', 'much', 'long'];
  const keywords = question.toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.includes(w));

  let chunks = [];

  for (const keyword of keywords.slice(0, 5)) {
    // Search community-specific docs
    if (community) {
      const { data } = await supabase
        .from('documents')
        .select('content, metadata')
        .ilike('content', `%${keyword}%`)
        .eq('metadata->>community', community)
        .limit(8);
      if (data) chunks.push(...data);
    }

    // Always search Law docs
    const { data: lawData } = await supabase
      .from('documents')
      .select('content, metadata')
      .ilike('content', `%${keyword}%`)
      .eq('metadata->>community', 'Law')
      .limit(4);
    if (lawData) chunks.push(...lawData);

    // Always search General docs
    const { data: generalData } = await supabase
      .from('documents')
      .select('content, metadata')
      .ilike('content', `%${keyword}%`)
      .eq('metadata->>community', 'General')
      .limit(4);
    if (generalData) chunks.push(...generalData);
  }

  // Deduplicate
  const seen = new Set();
  chunks = chunks.filter(chunk => {
    if (seen.has(chunk.content)) return false;
    seen.add(chunk.content);
    return true;
  });

  // Fallback if nothing found
  if (chunks.length === 0) {
    const queries = [];
    if (community) {
      queries.push(supabase.from('documents').select('content, metadata').eq('metadata->>community', community).limit(12));
    }
    queries.push(supabase.from('documents').select('content, metadata').eq('metadata->>community', 'Law').limit(4));
    queries.push(supabase.from('documents').select('content, metadata').eq('metadata->>community', 'General').limit(4));
    const results = await Promise.all(queries);
    results.forEach(({ data }) => { if (data) chunks.push(...data); });
  }

  const context = chunks.map(row => `[From: ${row.metadata?.filename} - ${row.metadata?.community}]\n${row.content}`).join('\n\n---\n\n');

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

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});