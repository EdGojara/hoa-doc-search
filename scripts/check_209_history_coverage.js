// Sanity-check: do we actually have §209 history loaded for these communities?
// If the Vantaca import skipped logging interactions for prior certified
// mailings, the flag_209_re_observations report returns false-zero. Confirm
// by counting both violations.current_stage='certified_209' AND
// interactions.type='letter_209' AND status='sent' per community.

require('dotenv').config({ override: true });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const COMMUNITIES = ['Canyon Gate at Cinco Ranch', 'Lakes of Pine Forest'];

(async () => {
  for (const name of COMMUNITIES) {
    const { data: comms } = await supabase.from('communities').select('id, name').ilike('name', name);
    if (!comms?.length) { console.log(`✗ ${name} not found`); continue; }
    const cid = comms[0].id;

    const { count: vio209 } = await supabase
      .from('violations')
      .select('id', { count: 'exact', head: true })
      .eq('community_id', cid)
      .eq('current_stage', 'certified_209');

    const { count: vioAny } = await supabase
      .from('violations')
      .select('id', { count: 'exact', head: true })
      .eq('community_id', cid);

    const { count: int209sent } = await supabase
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .eq('community_id', cid)
      .eq('type', 'letter_209')
      .eq('status', 'sent');

    const { count: int209any } = await supabase
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .eq('community_id', cid)
      .eq('type', 'letter_209');

    console.log(`\n${name}`);
    console.log(`  violations total:                 ${vioAny ?? 0}`);
    console.log(`  violations at certified_209 stage: ${vio209 ?? 0}`);
    console.log(`  interactions letter_209 (any):    ${int209any ?? 0}`);
    console.log(`  interactions letter_209 (sent):   ${int209sent ?? 0}`);
  }
  process.exit(0);
})();
