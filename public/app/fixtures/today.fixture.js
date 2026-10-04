// Fixture for /app/today in ?fixture=1 / file:// mode (visual snapshot harness).
// SAMPLE DATA ONLY — the demo community, no real owners, vendors or balances.
// Keyed by endpoint path; each value is what TX.get() would return.
window.TX_FIXTURE = {
  user: { full_name: 'Ed Gojara', role: 'admin' },
  '/api/community-profile/': { ok: true, data: { communities: [
    { id: '00000000-0000-4000-8000-000000000001', name: 'Drama Creek (sample)', active: true, hero: '../photos/communities/LPF_hero.jpg' },
  ] } },
  '/api/enforcement/mail-queue/summary': { ok: true, data: {
    total_pending: 0,
    summary: { first_class_mail: 0, certified_mail: 0, locked_first_class: 9, locked_certified: 0,
      locked_batches: [{ printed_at: '2026-09-28T18:05:00Z', delivery_method: 'first_class_mail', count: 9 }] },
  } },
  '/api/ap/ed-queue': { ok: true, data: { count: 1, total_cents: 3572, invoices: [
    { id: 'i1', community_id: '00000000-0000-4000-8000-000000000001', vendor: 'Sample board member reimbursement', total_cents: 3572 },
  ], cash: [{ community_id: '00000000-0000-4000-8000-000000000001', count: 1, pending_cents: 3572, operating_cash_cents: 1250000, covered: true }] } },
  '/api/today': { ok: true, data: {
    inbox: { count: 2, capped: false, items: [{ sla: 'red' }, { sla: 'green' }] },
    calls: { items: [{ started_at: new Date(Date.now() - 3600e3).toISOString(), brief_concern: 'Homeowner asked when the pool reopens for the season.' }] },
    uploads: { items: [{ imported_at: new Date(Date.now() - 7200e3).toISOString(), report_type: 'ar_aging', status: 'committed' }] },
    section_errors: {},
  } },
  '/api/feed': {
 "ok": true,
 "data": {
  "phase": 1,
  "model_calls": 0,
  "actions": [],
  "section_errors": {},
  "capped": [],
  "schedule": {
   "hours": [
    8,
    15
   ],
   "business_days_only": true,
   "scheduled": true
  },
  "summary": "In the last 24 hours: 6 routine bills continued on the normal path, 2 items cleared. 5 items need a person (Emma 3, Annie 1, Paige 1).",
  "total": 5,
  "by_specialist": {
   "Emma": 3,
   "Annie": 1,
   "Paige": 1
  },
  "routine_24h": 6,
  "needs": [
   {
    "key": "ap_invoice:s1",
    "kind": "ap_invoice",
    "specialist": {
     "key": "emma",
     "name": "Emma",
     "role": "Accounts payable"
    },
    "title": "On hold: Sample Pool Co #7316 ($1,470.00)",
    "detail": "Held as a possible duplicate; a person confirms before it can move.",
    "community": "Drama Creek (sample)",
    "class": "REVIEW",
    "priority": "high",
    "age_days": 2
   },
   {
    "key": "board_packet:s2",
    "kind": "board_packet",
    "specialist": {
     "key": "paige",
     "name": "Paige",
     "role": "Board operations"
    },
    "title": "Board packet October 2026 still draft",
    "detail": "Meeting in 2 days.",
    "community": "Drama Creek (sample)",
    "class": "REVIEW",
    "priority": "high",
    "age_days": null
   },
   {
    "key": "ap_exception:s3",
    "kind": "ap_exception",
    "specialist": {
     "key": "emma",
     "name": "Emma",
     "role": "Accounts payable"
    },
    "title": "Bill from Sample Landscaping #262093 ($1,185.22)",
    "detail": "Can't load it yet: needs which community it belongs to.",
    "community": "Community not identified",
    "class": "BLOCK",
    "priority": "normal",
    "age_days": 3
   },
   {
    "key": "acc_decision:s4",
    "kind": "acc_decision",
    "specialist": {
     "key": "annie",
     "name": "Annie",
     "role": "ACC / ARC"
    },
    "title": "ACC review: Backyard patio cover",
    "detail": "Drafted and waiting for a reviewer.",
    "community": "Drama Creek (sample)",
    "class": "REVIEW",
    "priority": "normal",
    "age_days": 1
   },
   {
    "key": "ap_invoice:s5",
    "kind": "ap_invoice",
    "specialist": {
     "key": "emma",
     "name": "Emma",
     "role": "Accounts payable"
    },
    "title": "Check coding: Sample Electric #A-118 ($312.40)",
    "detail": "New payee: confirm GL coding before approval.",
    "community": "Drama Creek (sample)",
    "class": "REVIEW",
    "priority": "normal",
    "age_days": 0
   }
  ],
  "more": [],
  "recent": [
   {
    "key": "objective:s6",
    "title": "Possible duplicate: bill 7290 ($880.00)",
    "when": new Date(Date.now() - 5 * 3600e3).toISOString(),
    "reason": "bill is voided",
    "community": "Drama Creek (sample)",
    "specialist": {
     "key": "emma",
     "name": "Emma",
     "role": "Accounts payable"
    }
   },
   {
    "key": "objective:s7",
    "title": "Bill waiting on the vendor: Sample Tree Care #55",
    "when": new Date(Date.now() - 20 * 3600e3).toISOString(),
    "reason": "exception resolved",
    "community": "Drama Creek (sample)",
    "specialist": {
     "key": "emma",
     "name": "Emma",
     "role": "Accounts payable"
    }
   }
  ],
  "last_sweep": {
   "started_at": new Date(Date.now() - 2 * 3600e3).toISOString(),
   "ok": true
  }
 }
},
  '/api/feed/item': {
 "ok": true,
 "data": {
  "key": "ap_invoice:s1",
  "kind": "ap_invoice",
  "title": "Sample Pool Co #7316 ($1,470.00)",
  "status": "on_hold",
  "class": "REVIEW",
  "community": "Drama Creek (sample)",
  "specialist": {
   "key": "emma",
   "name": "Emma",
   "role": "Accounts payable"
  },
  "facts": [
   "Status: on hold",
   "Needs review: possible duplicate of bill #7290"
  ],
  "next_action": "A person confirms whether this bill is a duplicate before it can move.",
  "timeline": [
   {
    "at": new Date(Date.now() - 50 * 3600e3).toISOString(),
    "actor": "Emma",
    "text": "Bill loaded",
    "source": "payables"
   },
   {
    "at": new Date(Date.now() - 46 * 3600e3).toISOString(),
    "actor": "amanda",
    "text": "REVIEW: Possible duplicate: bill 7316 ($1,470.00)",
    "source": "objective"
   }
  ],
  "link": {
   "label": "Open Payables",
   "href": "/#tab=ap"
  },
  "actions": [],
  "model_calls": 0
 }
},
  '/api/ar/control': { ok: true, data: {
    subledger_cents: 5870704, accounts: 109, owners_owing: 83, owners_in_credit: 26,
    gl_1300_2400_net_cents: 5870704, gl_accounts_found: 2, diff_cents: 0,
    conversion: { ready: true, batch_code: 'SAMPLE', as_of_date: '2026-07-31' }, ties: true,
  } },
};
