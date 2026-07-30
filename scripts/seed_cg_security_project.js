// ============================================================================
// scripts/seed_cg_security_project.js  (Ed 2026-07-29)
// ----------------------------------------------------------------------------
// One-time, idempotent: creates the Canyon Gate at Cinco Ranch "Security
// Services Contract — Vendor Evaluation 2026" project on the Operations board,
// tagged major and linked to operating budget line 5770 (Security Services,
// $235k FY26). Timeline dated to the source docs (bids 7/20/2026).
//
// Re-runnable: skips if a project with the same title already exists at CG.
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const CG = 'a0000000-0000-4000-8000-000000000003';
const SECURITY_ACCT = 'c5f86d23-24ae-4d73-a788-c1746f519561'; // 5770 Security Services
const TITLE = 'Security Services Contract — Vendor Evaluation 2026';

(async () => {
  const { data: existing, error: exErr } = await s.from('vendor_projects')
    .select('id, title').eq('community_id', CG).eq('title', TITLE).maybeSingle();
  if (exErr) { console.error('lookup failed:', exErr.message); process.exit(1); }
  if (existing) { console.log('Already exists:', existing.id, '— nothing to do.'); return; }

  const { data: comm } = await s.from('communities').select('management_company_id').eq('id', CG).maybeSingle();

  const description = [
    'Evaluation of the 24/7 manned security post contract for Canyon Gate at Cinco Ranch.',
    '',
    'Incumbent — Star Protection Agency LLC: ~$222,400/yr run-rate (168 hrs/wk = 24/7; billed weekly, incl. a 40 hrs/wk on-site Site Supervisor at a $25.25/hr premium). Star contract is NOT in our document library, only invoices.',
    '',
    'Bids received 7/20/2026:',
    '- United Protective Services (UPS): $214,348.08/yr all-in (24/7 single unarmed officer, $22.30/hr flat, no dedicated on-site supervisor; includes Vision InSites GPS/incident-reporting tech). 3 Houston-area references.',
    '- North America Security Services (NASS): $237,350/yr (likely pre-tax); scope and coverage hours undefined; no Houston references; TrackTik tech.',
    '',
    'FY2026 operating budget line 5770 Security Services = $235,000. UPS and Star are under budget; NASS is over.',
    'Full side-by-side and recommendation: see the board memo.',
  ].join('\n');

  const statusNote = [
    'INTERNAL — recommendation: UPS is the strongest challenger (~$8k/yr under Star + bundled accountability tech), but every proposal is a marketing packet with NO contract terms, insurance, or TX DPS license #.',
    'Before switching: require a redlined MSA (term, 30-day termination-for-convenience, COI naming the HOA additional insured, indemnity, TX DPS/PSB license #, annual escalation cap) and confirm the supervision model (UPS prices no dedicated on-site supervisor vs. Star’s 40 hrs/wk). Get a Star renewal quote to leverage. Eliminate NASS (highest cost, undefined scope, non-local).',
  ].join('\n');

  const row = {
    management_company_id: comm?.management_company_id || '00000000-0000-0000-0000-000000000001',
    community_id: CG,
    title: TITLE,
    category: 'general',
    asset: '24/7 manned security post (front gate / patrol)',
    description,
    status_note: statusNote,
    stage: 'board_deciding',
    stage_since: '2026-07-20T12:00:00-05:00',
    next_action: 'follow_up_bid',
    next_action_note: 'Obtain redlined service agreement + COI/TX license from UPS; request a renewal quote from incumbent Star; then board vote.',
    next_action_owner: 'manager',
    priority: 'high',
    is_major: true,
    funding_source: 'operating',
    budget_account_id: SECURITY_ACCT,
    estimated_cost_cents: 21434808, // UPS bid — lowest defined annual, the leading option
    source: 'proposal',
    created_by: 'Ed',
  };

  const { data: proj, error } = await s.from('vendor_projects').insert(row).select('id').single();
  if (error) { console.error('insert failed:', error.message); process.exit(1); }
  console.log('Created project:', proj.id);

  const events = [
    { project_id: proj.id, community_id: CG, event_type: 'created', to_stage: 'board_deciding',
      note: 'Project opened for board evaluation of the security services contract.', by_user: 'Ed',
      created_at: '2026-07-20T12:00:00-05:00' },
    { project_id: proj.id, community_id: CG, event_type: 'note',
      note: 'Bids on file: United Protective Services ($214,348/yr all-in) and North America Security Services ($237,350/yr). Incumbent Star Protection run-rate ~$222,400/yr. FY26 Security Services budget (5770) = $235,000.', by_user: 'Ed',
      created_at: '2026-07-20T12:05:00-05:00' },
    { project_id: proj.id, community_id: CG, event_type: 'note',
      note: 'Analysis completed and board memo prepared. Next: obtain redlined terms/insurance/license from UPS and a Star renewal quote before the board vote.', by_user: 'Ed',
      created_at: '2026-07-29T12:00:00-05:00' },
  ];
  const { error: evErr } = await s.from('vendor_project_events').insert(events);
  if (evErr) { console.error('events insert failed (project still created):', evErr.message); process.exit(1); }
  console.log('Added', events.length, 'timeline events.');
})();
