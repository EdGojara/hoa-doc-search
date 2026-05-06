// ============================================================================
// Bedrock Intelligence — Playbook Embedding Backfill
//
// Run once after the migration to embed all existing playbook entries.
// Safe to re-run: only embeds rows where embedding IS NULL by default.
// Pass --force to re-embed everything (use after schema changes).
//
// Usage:
//   node backfill_playbook_embeddings.js
//   node backfill_playbook_embeddings.js --force
//
// Reads SUPABASE_URL, SUPABASE_KEY, OPENAI_API_KEY from your .env / Render env.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

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

  // Pull entries that need embedding
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
      console.log(`  [${entry.id}] SKIP — empty text`);
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
        console.log(`  [${entry.id}] FAIL — ${updateError.message}`);
        failed++;
      } else {
        const preview = (entry.situation || '').slice(0, 60).replace(/\n/g, ' ');
        console.log(`  [${entry.id}] OK    — ${entry.category || 'no category'}: ${preview}...`);
        success++;
      }
    } catch (err) {
      console.log(`  [${entry.id}] FAIL — ${err.message}`);
      failed++;
    }

    // Gentle rate limit cushion (OpenAI ada-002 allows plenty, but be polite)
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

  // Final verification
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
    console.log(`\n✓ All entries embedded. Ready to wire up retrieval.\n`);
  } else {
    console.log(`\n⚠ ${stillNull} entries still have null embedding. Investigate before proceeding.\n`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});