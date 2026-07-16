require('dotenv').config({ override: true });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const die=(e,w)=>{ if(e){console.error('FAILED ('+w+'): '+e.message); process.exit(1);} };
(async()=>{
  const { data: a, error } = await s.from('builder_applications')
    .select('reference_number, street_address, application_data, plan_number, plan_name')
    .in('reference_number',['AM-BLD-2026-0024','AM-BLD-2026-0025']);
  die(error,'apps');
  for (const x of a) {
    console.log('=== ' + x.reference_number + '  ' + x.street_address + ' ===');
    console.log('  application_data keys: ' + Object.keys(x.application_data||{}).join(', '));
    console.log('  ' + JSON.stringify(x.application_data, null, 2).slice(0, 900).split('\n').join('\n  '));
    console.log('');
  }
})();
