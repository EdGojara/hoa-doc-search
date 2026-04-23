const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  
  const { question } = req.body;
  const stopWords = ['how', 'what', 'when', 'where', 'who', 'why', 'is', 'are', 'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'do', 'does', 'can', 'many', 'much', 'long'];
  const keywords = question.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !stopWords.includes(w));

  let chunks = [];
  for (const keyword of keywords.slice(0, 5)) {
    const { data } = await supabase.from('documents').select('content, metadata').ilike('content', `%${keyword}%`).limit(10);
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

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `You are an assistant that answers questions about HOA governing documents for Lakes of Pine Forest HOA.\n\nHere are relevant sections:\n\n${context}\n\nQuestion: ${question}\n\nAnswer based only on the documents provided.`
    }]
  });

  res.json({ answer: response.content[0].text });
};