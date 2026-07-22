require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const { findContact } = require('../lib/entity_resolution');

(async () => {
  // 1) Who owns 9215 Floral Crest (Cooper's neighbor)?  And 9211 (Cooper)?
  for (const addr of ['9215 Floral Crest', '9211 Floral Crest']) {
    const { data: props, error } = await s.from('properties')
      .select('id, street_address, community_id').ilike('street_address', `%${addr}%`);
    if (error) { console.log(addr, 'ERR', error.message); continue; }
    console.log(`\n${addr}: ${props.length} property(ies)`);
    for (const p of props) {
      const { data: own, error: oe } = await s.from('property_ownerships')
        .select('contacts:contact_id(full_name, primary_email, secondary_email)')
        .eq('property_id', p.id).is('end_date', null);
      if (oe) { console.log('  own ERR', oe.message); continue; }
      console.log(`  ${p.street_address} (${p.community_id.slice(0,8)}) owners:`);
      (own||[]).forEach(o => console.log(`     - ${o.contacts?.full_name} <${o.contacts?.primary_email||''}>`));
    }
  }

  // 2) Is Rocio Munoz / juanmedina57 on ANY roster?
  console.log('\n--- Rocio / Munoz / Medina search ---');
  for (const term of ['Munoz', 'Rocio', 'Medina']) {
    const { data, error } = await s.from('contacts')
      .select('full_name, primary_email, secondary_email').ilike('full_name', `%${term}%`).limit(10);
    if (error) { console.log(term, 'ERR', error.message); continue; }
    console.log(`"${term}": ${data.length}`);
    data.forEach(c => console.log(`   - ${c.full_name} <${c.primary_email||''}> / <${c.secondary_email||''}>`));
  }
  const byEmail = await findContact(s, { email: 'juanmedina57@gmail.com' });
  console.log('findContact(juanmedina57@gmail.com):', byEmail ? byEmail.full_name : 'null');
  const cooperC = await findContact(s, { email: 'cooperandrea1@icloud.com' });
  console.log('findContact(cooperandrea1@icloud.com):', cooperC ? `${cooperC.full_name} (${cooperC.match_method})` : 'null');
})();
