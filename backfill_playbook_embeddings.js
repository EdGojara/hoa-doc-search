// ============================================================================
// Bedrock Intelligence — Playbook Embedding Backfill
//
// Run once after the migration to embed all existing playbook entries.
// Safe to re-run: only embeds rows where embedding IS NULL by default.
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

// Sanity check that env vars actually loaded
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY || !process.env.OPENAI_API_KEY) {
  console.error('\n[ERROR] Missing required env vars in .env file.');
  console.error(`   SUPABASE_URL:     ${process.env.SUPABASE_URL ? 'OK' : 'MISSING'}`);
  console.error(`   SUPABASE_KEY:     ${process.env.SUPABASE_KEY ? 'OK' : 'MISSING'}`);
  console.error(`   OPENAI_API_KEY:   ${process.env.OPENAI_API_KEY ? 'OK' : 'MISSING'}`);
  console.error('\n   Make sure .env exists in the same folder as this script and contains all three vars.\n');
  process.exit(1);
}

// Quick visual check that the OpenAI key isn't placeholder text
if (!process.env.OPENAI_API_KEY.startsWith('sk-')) {
  console.error(`\n[ERROR] OPENAI_API_KEY does not start with "sk-" — looks like placeholder text, not a real key.`);
  console.error(`   First 10 chars: "${process.env.OPENAI_API_KEY.slice(0, 10)}..."\n`);
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const FORCE = process.argv.includes('--force');

// Build the text we embed for each entry.
// Embedding situation + response + reasoning means the underlying principle
// is in the vector, not just the surface circumstances.
function buildEmbeddingText(entry) {
  const parts = [];
  if (entry.situation) parts.push(`SITUATION: ${entry.situation}`);
  if (entry.response) parts.push(`RESPONSE: ${entry.response}`);
  if (entry.reasoning) parts.push(`REASONING: ${entry.reasoning}`);
  return parts.join('\n\n');
}

async function embedText(text) {
  const cleaned = text.replace(/\n+/g, ' ').slice(0, 8000);
  const result = await openai.embeddings.create({
    model: 'text-embedding-ada-002',
    input: cleaned
  });
  return result.data[0].embedding;
}

async function main() {
  console.log(`\n=== Playbook Embedding Backfill ===`);
  console.log(`Mode: ${FORCE ? 'FORCE (re-embed everything)' : 'INCREMENTAL (only null embeddings)'}\n`);

  let query = supabase.from('playbook').select('id, situation, response, reasoning, category, embedding');
  if (!FORCE) query = query.is('embedding', null);

  const { data: entries, error } = await query;
  if (error) {
    console.error('Error loading playbook:', error.message);
    process.exit(1);
  }

  if (!entries || entries.length === 0) {
    console.log('No entries to embed. Done.');
    return;
  }

  console.log(`Found ${entries.length} entries to embed.\n`);

  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entries) {
    const text = buildEmbeddingText(entry);
    if (!text.trim()) {
      console.log(`  [${entry.id}] SKIP - empty text`);
      skipped++;
      continue;
    }

    try {
      const embedding = await embedText(text);
      const { error: updateError } = await supabase
        .from('playbook')
        .update({ embedding })
        .eq('id', entry.id);

      if (updateError) {
        console.log(`  [${entry.id}] FAIL - ${updateError.message}`);
        failed++;
      } else {
        const preview = (entry.situation || '').slice(0, 60).replace(/\n/g, ' ');
        console.log(`  [${entry.id}] OK   - ${entry.category || 'no category'}: ${preview}...`);
        success++;
      }
    } catch (err) {
      console.log(`  [${entry.id}] FAIL - ${err.message}`);
      failed++;
    }

    await new Promise(r => setTimeout(r, 50));
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Embedded:  ${success}`);
  console.log(`  Skipped:   ${skipped}`);
  console.log(`  Failed:    ${failed}`);

  if (failed > 0) {
    console.log(`\nRe-run the script to retry failures.`);
    process.exit(1);
  }

  const { count: stillNull } = await supabase
    .from('playbook')
    .select('id', { count: 'exact', head: true })
    .is('embedding', null);

  const { count: total } = await supabase
    .from('playbook')
    .select('id', { count: 'exact', head: true });

  console.log(`\n=== Verification ===`);
  console.log(`  Total entries:          ${total}`);
  console.log(`  Entries with embedding: ${total - stillNull}`);
  console.log(`  Entries still null:     ${stillNull}`);

  if (stillNull === 0) {
    console.log(`\n[OK] All entries embedded. Ready to wire up retrieval.\n`);
  } else {
    console.log(`\n[WARN] ${stillNull} entries still have null embedding. Investigate before proceeding.\n`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});