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
   "scheduled": false
  },
  "lanes": {
   "now": [
    {
     "key": "ap_invoice:00000000-0000-4000-8000-000000000001",
     "kind": "ap_invoice",
     "lane": "now",
     "specialist": {
      "key": "emma",
      "name": "Emma",
      "role": "Accounts payable"
     },
     "title": "Past due: Sample Pool Co #7316 ($1,470.00)",
     "why": "Past due since Sep 30 and not approved.",
     "community": "Drama Creek (sample)",
     "priority": "high",
     "age_days": 6,
     "action": {
      "label": "Take action",
      "href": "/#tab=ap&invoice=00000000-0000-4000-8000-000000000001",
      "where": "Payables · this bill"
     }
    },
    {
     "key": "ap_invoice:00000000-0000-4000-8000-000000000002",
     "kind": "ap_invoice",
     "lane": "now",
     "specialist": {
      "key": "emma",
      "name": "Emma",
      "role": "Accounts payable"
     },
     "title": "Pre-cutover bill: Sample Ice Co #700500 ($84.00)",
     "why": "Dated before this community's GL cutover; a person decides how it posts.",
     "community": "Drama Creek (sample)",
     "priority": "high",
     "age_days": 1,
     "action": {
      "label": "Take action",
      "href": "/#tab=ap&invoice=00000000-0000-4000-8000-000000000002",
      "where": "Payables · this bill"
     }
    },
    {
     "key": "acc_decision:00000000-0000-4000-8000-000000000003",
     "kind": "acc_decision",
     "lane": "now",
     "specialist": {
      "key": "annie",
      "name": "Annie",
      "role": "ACC / ARC"
     },
     "title": "ACC: Driveway extension",
     "why": "New documents arrived Aug 27 and haven't been reviewed.",
     "community": "Drama Creek (sample)",
     "priority": "normal",
     "age_days": 38,
     "action": {
      "label": "Take action",
      "href": "/#tab=acc&decision=00000000-0000-4000-8000-000000000003",
      "where": "ACC review · this application"
     }
    },
    {
     "key": "acc_decision:00000000-0000-4000-8000-000000000004",
     "kind": "acc_decision",
     "lane": "now",
     "specialist": {
      "key": "annie",
      "name": "Annie",
      "role": "ACC / ARC"
     },
     "title": "ACC: Fence replacement",
     "why": "No decision has been sent yet (recommendation: request more info).",
     "community": "Drama Creek (sample)",
     "priority": "normal",
     "age_days": 37,
     "action": {
      "label": "Take action",
      "href": "/#tab=acc&decision=00000000-0000-4000-8000-000000000004",
      "where": "ACC review · this application"
     }
    },
    {
     "key": "ap_exception:00000000-0000-4000-8000-000000000005",
     "kind": "ap_exception",
     "lane": "now",
     "specialist": {
      "key": "emma",
      "name": "Emma",
      "role": "Accounts payable"
     },
     "title": "Bill couldn't load: Sample Insurance ($6,125.68)",
     "why": "Payment requested, but the attachment is not an invoice: review in Payables",
     "community": "Drama Creek (sample)",
     "priority": "normal",
     "age_days": 3,
     "action": {
      "label": "Take action",
      "href": "/admin/ap?exception=00000000-0000-4000-8000-000000000005",
      "where": "Payables exceptions · this bill"
     }
    },
    {
     "key": "ap_invoice:00000000-0000-4000-8000-000000000006",
     "kind": "ap_invoice",
     "lane": "now",
     "specialist": {
      "key": "emma",
      "name": "Emma",
      "role": "Accounts payable"
     },
     "title": "New payee: Sample Party Rentals ($96.00)",
     "why": "First bill from this vendor for this community.",
     "community": "Drama Creek (sample)",
     "priority": "normal",
     "age_days": 10,
     "action": {
      "label": "Take action",
      "href": "/#tab=ap&invoice=00000000-0000-4000-8000-000000000006",
      "where": "Payables · this bill"
     }
    }
   ],
   "waiting": [
    {
     "key": "ap_invoice:00000000-0000-4000-8000-000000000007",
     "kind": "ap_invoice",
     "lane": "waiting",
     "specialist": {
      "key": "emma",
      "name": "Emma",
      "role": "Accounts payable"
     },
     "title": "On hold: Sample Access Works #03-072 ($9,513.03)",
     "why": "On hold 2026-08-18: check voided because the invoiced amount is incorrect. Release once the corrected invoice is in hand.",
     "community": "Drama Creek (sample)",
     "priority": "normal",
     "age_days": 67,
     "action": {
      "label": "Take action",
      "href": "/#tab=ap&invoice=00000000-0000-4000-8000-000000000007",
      "where": "Payables · this bill"
     }
    },
    {
     "key": "ap_exception:00000000-0000-4000-8000-000000000008",
     "kind": "ap_exception",
     "lane": "waiting",
     "specialist": {
      "key": "emma",
      "name": "Emma",
      "role": "Accounts payable"
     },
     "title": "Bill couldn't load: Sample Law PC #4068652 ($270.00)",
     "why": "Waiting on which community it belongs to.",
     "community": "Community not identified",
     "priority": "normal",
     "age_days": 51,
     "action": {
      "label": "Take action",
      "href": "/admin/ap?exception=00000000-0000-4000-8000-000000000008",
      "where": "Payables exceptions · this bill"
     }
    }
   ],
   "policy": [
    {
     "key": "ap_invoice:00000000-0000-4000-8000-000000000009",
     "kind": "ap_invoice",
     "lane": "policy",
     "specialist": {
      "key": "emma",
      "name": "Emma",
      "role": "Accounts payable"
     },
     "title": "On hold: Sample DJ #1010 ($300.00)",
     "why": "ON HOLD: W-9 required before payment.",
     "community": "Drama Creek (sample)",
     "priority": "high",
     "age_days": 2,
     "action": {
      "label": "Take action",
      "href": "/#tab=ap&invoice=00000000-0000-4000-8000-000000000009",
      "where": "Payables · this bill"
     },
     "policy_note": "Held for a W-9; the standing rule says a W-9 is informational and never blocks payment. Ed decides."
    }
   ]
  },
  "counts": {
   "now": 6,
   "waiting": 2,
   "policy": 1
  },
  "total": 9,
  "by_specialist": {
   "Emma": 4,
   "Annie": 2
  },
  "summary": "6 need you now (Emma 4, Annie 2) · 2 waiting on something · 1 for your decision.",
  "elsewhere": {
   "ap_routine_in_payables": 37,
   "ap_approved_awaiting_release": 20,
   "inactive_community": 18,
   "acc_possible_duplicates": 3,
   "acc_legacy_or_incomplete": 3
  },
  "recent": [],
  "routine_24h": 0,
  "last_sweep": null
 }
},
  '/api/feed/item': {
 "ok": true,
 "data": {
  "key": "ap_invoice:00000000-0000-4000-8000-000000000001",
  "kind": "ap_invoice",
  "title": "Sample Pool Co #7316 ($1,470.00)",
  "status": "awaiting_approval",
  "community": "Drama Creek (sample)",
  "specialist": {
   "key": "emma",
   "name": "Emma",
   "role": "Accounts payable"
  },
  "facts": [
   "Status: awaiting approval",
   "Due: 2026-09-30"
  ],
  "timeline": [
   {
    "at": new Date(Date.now() - 6 * 86400e3).toISOString(),
    "actor": "Emma",
    "text": "Bill loaded",
    "source": "payables"
   }
  ],
  "action": {
   "label": "Take action",
   "href": "/#tab=ap&invoice=00000000-0000-4000-8000-000000000001",
   "where": "Payables · this bill"
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
  // Amanda's email desk (sample addresses only).
  '/api/amanda/email': { ok: true, data: { ok: true, exceptions: 1, source_errors: {}, since: '2026-09-22T00:00:00Z',
    outbox: [
      { id: 'o1', status: 'prepared', reason: null, to_email: 'manager@example.com, assistant@example.com', cc: null,
        subject: 'Drama Creek: lawn enforcement path', created_at: '2026-10-06T20:40:00Z',
        body_text: 'Hi both,\n\nPlease use the regular courtesy notice for lawn violations at Drama Creek.\n\nThank you,\nAmanda' },
      { id: 'o2', status: 'blocked', reason: 'blocked: outbound guard suppressed this send (demo community)', to_email: 'board@example.com', cc: 'manager@example.com',
        subject: 'Does Tuesday work for the board meeting?', created_at: '2026-10-06T18:10:00Z', body_text: 'Hi everyone,\n\nDoes Tuesday work?\n\nThank you,\nAmanda' },
    ],
    activity: [
      { source: 'outbox', id: 'o1', status: 'prepared', at: '2026-10-06T20:40:00Z', to: 'manager@example.com, assistant@example.com', subject: 'Drama Creek: lawn enforcement path' },
      { source: 'outbox', id: 'o2', status: 'blocked', at: '2026-10-06T18:10:00Z', to: 'board@example.com', cc: 'manager@example.com', subject: 'Does Tuesday work for the board meeting?', reason: 'blocked: outbound guard suppressed this send (demo community)' },
      { source: 'sent_items', id: 's1', status: 'unrecorded', at: '2026-10-05T16:00:00Z', to: 'owner@example.com', subject: 'Photo check', unrecorded: true, reason: 'Unrecorded send: found in Amanda’s Sent Items with no trustEd record. Needs investigation (sent outside the normal path).' },
      { source: 'auto_reply', id: 'a1', status: 'sent', at: '2026-10-05T12:31:00Z', to: 'owner@example.com', subject: 'Re: Drama Creek' },
      { source: 'auto_reply', id: 'a2', status: 'failed', at: '2026-10-05T00:21:00Z', to: 'owner@example.com', subject: 'Re: Drama Creek', reason: 'Graph list attachments failed (400)' },
    ],
  } },
};
