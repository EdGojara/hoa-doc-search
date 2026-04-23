require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function search(question) {
  // Get all document chunks
  const { data, error } = await supabase
    .from('documents')
    .select('content, metadata')
    .limit(20);

  if (error) {
    console.error('Error fetching documents:', error);
    return;
  }

  // Build context from chunks
  const context = data.map(row => row.content).join('\n\n');

  // Ask Claude
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

  console.log('\nAnswer:', response.content[0].text);
}

const question = process.argv[2];
if (!question) {
  console.log('Usage: node search.js "your question here"');
  process.exit(1);
}

search(question).catch(console.error);