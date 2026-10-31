// ============================================================================
// Owner approval package: RECOMMENDED treatments already established with the
// owner (Ed 2026-10-31), shown pre-selected on the package screen. A
// recommendation is never a decision: nothing here is approved until the owner
// approves it in the app, and every approval still goes through decideObject /
// decide (owner-only, in-app channel, one audit record per decision).
//
// objects: proposed conversion adjustments / policies by id -> approve.
// bridge:  bridge questions matched by a record they carry ("table:id") -> choice.
// Any item without a recommendation is shown unselected (an exception the
// owner decides or leaves out). Repo is public: ids, amounts and reasons only.
// ============================================================================

const REVIEWED = 'reviewed with Ed 2026-10-31';

const PACKAGE = {
  'CONV-SCR-20260731': {
    objects: {
      '2b716a20-': 'Prior-owner balances shown in control accounts (15 former-owner accounts, $2,429.89)',
      '50fa2440-': 'Bills dated within 31 days before the cutoff that Vantaca never booked are recorded on the cutover date',
      '6efaaf28-': '$2.00 in 2205 from the 4/30/2025 opening import, carried as a reconciling item',
      'a7fd25de-': 'The $90.18 Lennar balance on the 5450 lot is carried unchanged; the ownership question stays a separate exception',
      'e5d89803-': 'Prepared Publications 10263 ($100) paid 12/9/2025, bill never entered in Vantaca',
      '1eb93fdb-': 'GL 3000 $101,925.03 (4/30/2025 opening fund balance) normalized to 3050',
      'd403902a-': 'Strike Electrical 4654 ($720.00) unpaid at 7/31, restored to opening AP',
    },
    bridge: {},
  },
  'CONV-WE-20260731': {
    objects: {
      '1ae18f95-': 'Prior-owner balances shown in control accounts',
      'ffa804a1-': 'Bills dated within 31 days before the cutoff that Vantaca never booked are recorded on the cutover date',
      'dbafe9c7-': 'Vantaca TB out by $700 from its 2025 roll: 3050 opens at the balance-sheet figure (decision 6/27/2026)',
      '572c8c34-': 'Account 1250 split by Vantaca fund columns',
      '6aec44ad-': 'Account 3000 split by Vantaca fund columns',
      'e609958a-': 'Account 3050 split by Vantaca fund columns (includes the $700)',
      '0e35609b-': 'Account 4120 split by Vantaca fund columns',
      'ff25fe4a-': 'Account 4050 follows the source Operating fund',
      '3b4872e6-': '21 bills dated on/before 7/31 ($28,482.98) unpaid at 7/31 and never entered in Vantaca, restored to opening AP',
      '8a1cf368-': 'Two MUD 143 bills ($1,921.90 at full invoice) unpaid at 7/31, restored to opening AP',
    },
    bridge: {
      'ap_payments:537cb624-7e19-43e3-9d80-6c0206932c5c': ['already_in_legacy_books', '2025 history-import payment ($1,750) with no journal entry: do not carry'],
      'ap_payments:af851153-2611-4e8e-b0b7-18c4e6f1e5ea': ['already_in_legacy_books', '2025 history-import payment ($1,750) with no journal entry: do not carry'],
      'ap_invoices:66926e39-fdbe-4760-a262-6c7ea3902f85': ['keep_as_trusted_activity', 'Kona Ice 700500 ($875): not in Vantaca, not opening AP; event 10/6, paid by card 10/1, marked DO NOT PAY; kept as post-cutover Trusted activity (its October treatment is decided separately)'],
      'ap_invoices:2b3b29c6-b0a8-4681-97c0-866829d78f57': ['already_in_legacy_books', 'Swim Houston 7316 nets $11,064.87 ($12,534.87 less a $1,470 June credit) = Vantaca invoice 7271 line for line, paid in Vantaca 7/31; not one of the 21 opening-AP bills'],
      'ap_payments:4b814452-1870-45f8-8dd7-8ef30087fc7b': ['already_in_legacy_books', 'Check 1000 ($11,064.87, cleared 7/17) is Vantaca ledger 9030, its 7/31 payment of invoice 7271'],
      'journal_entries:36a04fbc-f7ef-4160-8bd3-ef8faf34e91e': ['already_in_legacy_books', 'JE-2026-00169 "REPRO-TEST" $5,005 is a test entry: do not carry'],
      'ap_payments:faee090b-6480-4547-badc-abe49ccdaf6b': ['keep_as_trusted_activity', 'Check 1004 ($100, 8/14) cleared the bank: keep'],
      'ap_payments:be35db98-e427-4938-9295-ce1644c1824f': ['keep_as_trusted_activity', 'Check 1002 ($200, 8/14) cleared the bank: keep'],
      'ap_payments:b7b383f6-d08a-4e68-8e4e-df451410b7ec': ['keep_as_trusted_activity', 'Check 1014 ($200, 9/16) cleared the bank: keep'],
      'ap_invoices:134b69b2-8891-402e-bc8c-a15fe4525265': ['keep_as_trusted_activity', 'August-dated bill ($3,735.38) posted into July: post-cutover activity, kept'],
      'ap_invoices:d73554a9-02a6-46df-8723-b9ca2984eaab': ['keep_as_trusted_activity', 'August-dated bill ($2,889.76) posted into July: post-cutover activity, kept'],
      'ap_invoices:d3526d80-61c8-44f9-a8ec-1b3aa91ac299': ['keep_as_trusted_activity', 'September-dated bill ($270.63) posted into July: post-cutover activity, kept'],
      'homeowner_transactions:cd62c4c7-9db8-43f5-9664-05f981e9a40f': ['already_in_legacy_books', 'Owner bill-back $42 (8/31) duplicates the 6/26 Vantaca charge: do not carry'],
      'homeowner_transactions:5fce468b-9bc0-4109-8cf8-158ae5be7733': ['already_in_legacy_books', 'Owner bill-back $557.35 (10/11) duplicates the 7/30 Vantaca charge: do not carry'],
    },
  },
};

// Recommendation for a proposed adjustment / policy (matched by id prefix).
function forObject(batchCode, id) {
  const p = PACKAGE[batchCode]; if (!p) return null;
  const k = Object.keys(p.objects).find((pre) => String(id).startsWith(pre));
  return k ? { decision: 'approved', reason: p.objects[k], basis: REVIEWED } : null;
}
// Recommendation for a bridge question: by a record it carries; the choice must be one it offers.
function forBridge(batchCode, q) {
  const p = PACKAGE[batchCode]; if (!p) return null;
  for (const r of q.records || []) {
    const hit = p.bridge[r];
    if (hit && (q.choices || []).some((c) => c.key === hit[0])) return { choice: hit[0], reason: hit[1], basis: REVIEWED };
  }
  return null;
}

module.exports = { forObject, forBridge, PACKAGE };
