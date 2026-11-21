// scripts/check_live_selects.js  (Ed 2026-11-21)
// Runs every literal .from('table').select('columns') in the given files against
// the live database (limit 1, read-only) and reports any that fail. A select
// naming a column or table that does not exist fails the WHOLE query, which
// code without an error check renders as "no data" (CLAUDE.md scar). Portal
// testing found nine of these at once. Needs SUPABASE_URL / SUPABASE_KEY.
//   node scripts/check_live_selects.js [files...]   (default: homeowner portal surface)
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const DEFAULT = ['api/portal.js', 'api/messaging.js', 'api/portal_admin.js', 'lib/claire/scope.js',
  'lib/portal/financial_access.js', 'lib/portal/portal_open.js', 'lib/ar/resolve_current_ar.js', 'lib/ar/current_owner_ledger.js'];

(async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) { console.error('SUPABASE_URL / SUPABASE_KEY required'); process.exit(2); }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
  let checked = 0, failing = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const re = /\.from\(\s*'([a-z_]+)'\s*\)\s*\.select\(\s*(['`])([\s\S]*?)\2/g;
    let m;
    while ((m = re.exec(src))) {
      const [, table, quote, cols] = m;
      if (quote === '`' && cols.includes('${')) continue;
      const { error } = await sb.from(table).select(cols.replace(/\s+/g, ' ').trim()).limit(1);
      checked++;
      if (error) { failing++; console.log(`${f}:${src.slice(0, m.index).split('\n').length}  ${table}  ${error.message}`); }
    }
  }
  console.log(`checked ${checked} selects, ${failing} failing`);
  process.exit(failing ? 1 : 0);
})();
