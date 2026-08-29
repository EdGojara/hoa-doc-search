#!/usr/bin/env node
// ============================================================================
// scripts/train_persona.js  (Ed 2026-08-29)
// ----------------------------------------------------------------------------
// Train any teammate in isolation. Feed a persona a real scenario and read
// exactly what it would draft — the audience it inferred, whether it grounded,
// whether the reserved gate fired, its routine-vs-exception verdict, and the
// full body. It NEVER queues, sends, or writes anything: pure read + draft, so
// you can iterate on a persona's config safely before it is ever turned on.
//
// Usage:
//   node scripts/train_persona.js <persona> "<subject>" "<body>" [community] [senderEmail]
//
// Examples:
//   node scripts/train_persona.js miranda "About my grass letter" "I got a violation notice about my lawn. What do I do and by when?" "Lakes of Pine Forest"
//   node scripts/train_persona.js annie "Fence submittal" "Is my fence application approved yet?" "Lakes of Pine Forest" builder@lennar.com
//   node scripts/train_persona.js amanda "This fine is unfair" "Waive my $250 fine, I was traveling." "Lakes of Pine Forest"
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const { CONFIGS } = require('../lib/team/persona_configs');
const { draftOperatorReply } = require('../lib/team/operator_reply');
const { draftAmandaReply } = require('../lib/community/amanda_reply');

async function resolveCommunity(name) {
  if (!name) return { id: null, name: null };
  const { data } = await supabase.from('communities').select('id, name')
    .eq('management_company_id', '00000000-0000-0000-0000-000000000001').ilike('name', name).limit(1);
  if (data && data.length) return { id: data[0].id, name: data[0].name };
  return { id: null, name };
}

(async () => {
  const [persona, subject, body, community, senderEmail] = process.argv.slice(2);
  if (!persona || !subject || !body) {
    console.log('Usage: node scripts/train_persona.js <persona> "<subject>" "<body>" [community] [senderEmail]');
    console.log('Personas: amanda (live), ' + Object.keys(CONFIGS).join(', ') + ' (dark, in training)');
    process.exit(1);
  }
  const comm = await resolveCommunity(community);
  const email = { subject, body, sender_name: 'Training Sender', sender_email: senderEmail || '' };
  const args = { email, supabase, propertyId: null, communityId: comm.id, contactName: 'Training Sender', communityName: comm.name };

  let d;
  if (persona === 'amanda') {
    d = await draftAmandaReply(args);
  } else if (CONFIGS[persona]) {
    d = await draftOperatorReply(CONFIGS[persona], args);
  } else {
    console.error(`Unknown persona "${persona}". Options: amanda, ${Object.keys(CONFIGS).join(', ')}`);
    process.exit(1);
  }

  const line = '─'.repeat(72);
  console.log('\n' + line);
  console.log(`  PERSONA:     ${persona}${persona === 'amanda' ? ' (live)' : ' (dark — training)'}`);
  console.log(`  COMMUNITY:   ${comm.name || '(none — grounding limited)'}`);
  console.log(`  VERDICT:     ${d.disposition} / ${d.confidence}  —  ${d.disposition_reason}`);
  console.log(`  REVIEW HINT: ${d.review_hint}`);
  console.log(line);
  console.log(`  SUBJECT:     ${d.subject}\n`);
  console.log(d.body);
  console.log('\n' + line);
  console.log('  (nothing was queued or sent — training only)\n');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
