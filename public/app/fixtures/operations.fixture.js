// Fixture for /app/operations in fixture mode (visual snapshot harness).
// SAMPLE DATA ONLY, generated from lib/ops/overview.js evaluateOps() on synthetic rows.
window.TX_FIXTURE = {
  "user": {
    "full_name": "Ed Gojara",
    "role": "admin"
  },
  "/api/ops/overview": {
    "ok": true,
    "data": {
      "generated_at": "2026-09-29T15:00:00.000Z",
      "areas": [
        {
          "key": "calls_overdue",
          "title": "Callbacks past due",
          "href": "/#tab=calls",
          "humanOnly": false,
          "informational": false,
          "unknown": false
        },
        {
          "key": "builder_overdue",
          "title": "Builder ARC past review target",
          "href": "/builder-arc-review.html",
          "humanOnly": false,
          "informational": false,
          "unknown": false
        },
        {
          "key": "work_overdue",
          "title": "Mail and tasks past SLA",
          "href": "/#tab=status",
          "humanOnly": false,
          "informational": false,
          "unknown": false
        },
        {
          "key": "certified_cure_ended",
          "title": "Certified §209: cure period ended",
          "href": "/#tab=cures",
          "humanOnly": true,
          "informational": false,
          "unknown": false
        },
        {
          "key": "letters_unrecorded",
          "title": "Printed, mailing not recorded",
          "href": "/#tab=inspect",
          "humanOnly": false,
          "informational": false,
          "unknown": false
        },
        {
          "key": "letters_draft",
          "title": "Letters awaiting approval",
          "href": "/#tab=inspect",
          "humanOnly": false,
          "informational": false,
          "unknown": false
        },
        {
          "key": "acc_pending",
          "title": "ACC applications to review",
          "href": "/#tab=acc",
          "humanOnly": false,
          "informational": false,
          "unknown": false
        },
        {
          "key": "email_drafts",
          "title": "Email drafts awaiting your send",
          "href": "/admin/draft-queue",
          "humanOnly": false,
          "informational": false,
          "unknown": false
        },
        {
          "key": "letters_print",
          "title": "Approved letters ready to print",
          "href": "/#tab=inspect",
          "humanOnly": false,
          "informational": false,
          "unknown": false
        },
        {
          "key": "courtesy_cure_ended",
          "title": "Courtesy cure ended, awaiting next inspection",
          "href": "/#tab=cures",
          "humanOnly": false,
          "informational": true,
          "unknown": false
        },
        {
          "key": "calls_open",
          "title": "Open callbacks (not yet due)",
          "href": "/#tab=calls",
          "humanOnly": false,
          "informational": true,
          "unknown": false
        },
        {
          "key": "builder_open",
          "title": "Builder ARC in review",
          "href": "/builder-arc-review.html",
          "humanOnly": false,
          "informational": true,
          "unknown": false
        },
        {
          "key": "certified_open",
          "title": "Certified §209 open",
          "href": "/#tab=cures",
          "humanOnly": true,
          "informational": true,
          "unknown": false
        },
        {
          "key": "work_open",
          "title": "Mail and tasks open",
          "href": "/#tab=status",
          "humanOnly": false,
          "informational": true,
          "unknown": false
        },
        {
          "key": "rentals_payment",
          "title": "Amenity rentals awaiting payment",
          "href": "/amenity-rentals-review.html",
          "humanOnly": false,
          "informational": false,
          "unknown": false
        }
      ],
      "items": [
        {
          "key": "calls_overdue",
          "title": "Callbacks past due",
          "count": 23,
          "oldest": "2026-06-01T15:00:00Z",
          "href": "/#tab=calls",
          "humanOnly": false,
          "rank": 0,
          "communities": [
            {
              "name": "Sample Estates",
              "count": 22
            },
            {
              "name": "Bedrock / no community",
              "count": 1
            }
          ]
        },
        {
          "key": "builder_overdue",
          "title": "Builder ARC past review target",
          "count": 7,
          "oldest": "2026-09-15T15:00:00Z",
          "href": "/builder-arc-review.html",
          "humanOnly": false,
          "rank": 1,
          "communities": [
            {
              "name": "Sample Ridge",
              "count": 7
            }
          ]
        },
        {
          "key": "work_overdue",
          "title": "Mail and tasks past SLA",
          "count": 2,
          "oldest": "2026-09-15T15:00:00Z",
          "href": "/#tab=status",
          "humanOnly": false,
          "rank": 2,
          "communities": [
            {
              "name": "Sample Ridge",
              "count": 1
            },
            {
              "name": "Bedrock / no community",
              "count": 1
            }
          ]
        },
        {
          "key": "certified_cure_ended",
          "title": "Certified §209: cure period ended",
          "count": 26,
          "oldest": "2026-09-01T00:00:00Z",
          "href": "/#tab=cures",
          "humanOnly": true,
          "rank": 3,
          "communities": [
            {
              "name": "Drama Creek (sample)",
              "count": 26
            }
          ]
        },
        {
          "key": "letters_unrecorded",
          "title": "Printed, mailing not recorded",
          "count": 85,
          "oldest": "2026-09-22T18:00:00Z",
          "href": "/#tab=inspect",
          "humanOnly": false,
          "rank": 4,
          "communities": [
            {
              "name": "Drama Creek (sample)",
              "count": 80
            },
            {
              "name": "Sample Ridge",
              "count": 5
            }
          ]
        },
        {
          "key": "letters_draft",
          "title": "Letters awaiting approval",
          "count": 6,
          "oldest": "2026-09-01T15:00:00Z",
          "href": "/#tab=inspect",
          "humanOnly": false,
          "rank": 5,
          "communities": [
            {
              "name": "Sample Estates",
              "count": 6
            }
          ]
        },
        {
          "key": "acc_pending",
          "title": "ACC applications to review",
          "count": 13,
          "oldest": "2026-07-13T15:00:00Z",
          "href": "/#tab=acc",
          "humanOnly": false,
          "rank": 6,
          "communities": [
            {
              "name": "Sample Estates",
              "count": 11
            },
            {
              "name": "Drama Creek (sample)",
              "count": 2
            }
          ]
        },
        {
          "key": "email_drafts",
          "title": "Email drafts awaiting your send",
          "count": 19,
          "oldest": "2026-07-22T15:00:00Z",
          "href": "/admin/draft-queue",
          "humanOnly": false,
          "rank": 7,
          "communities": [
            {
              "name": "Sample Estates",
              "count": 15
            },
            {
              "name": "Drama Creek (sample)",
              "count": 4
            }
          ]
        },
        {
          "key": "letters_print",
          "title": "Approved letters ready to print",
          "count": 3,
          "oldest": "2026-09-21T15:00:00Z",
          "href": "/#tab=inspect",
          "humanOnly": false,
          "rank": 8,
          "communities": [
            {
              "name": "Sample Ridge",
              "count": 3
            }
          ]
        },
        {
          "key": "rentals_payment",
          "title": "Amenity rentals awaiting payment",
          "count": 1,
          "oldest": "2026-08-22T15:00:00Z",
          "href": "/amenity-rentals-review.html",
          "humanOnly": false,
          "rank": 14,
          "communities": [
            {
              "name": "Sample Estates",
              "count": 1
            }
          ]
        }
      ],
      "quiet": [],
      "problems": [],
      "managed": [
        {
          "community": {
            "id": "00000000-0000-4000-8000-00000000000a",
            "name": "Drama Creek (sample)",
            "management_status": "active",
            "management_end_date": null
          },
          "group": "managed",
          "areas": {
            "calls_overdue": {
              "count": 0,
              "oldest": null
            },
            "builder_overdue": {
              "count": 0,
              "oldest": null
            },
            "work_overdue": {
              "count": 0,
              "oldest": null
            },
            "certified_cure_ended": {
              "count": 26,
              "oldest": "2026-09-01T00:00:00Z"
            },
            "letters_unrecorded": {
              "count": 80,
              "oldest": "2026-09-28T18:00:00Z"
            },
            "letters_draft": {
              "count": 0,
              "oldest": null
            },
            "acc_pending": {
              "count": 2,
              "oldest": "2026-09-25T15:00:00Z"
            },
            "email_drafts": {
              "count": 4,
              "oldest": "2026-09-20T15:00:00Z"
            },
            "letters_print": {
              "count": 0,
              "oldest": null
            },
            "courtesy_cure_ended": {
              "count": 68,
              "oldest": "2026-09-10T00:00:00Z"
            },
            "calls_open": {
              "count": 3,
              "oldest": "2026-09-30T15:00:00Z"
            },
            "builder_open": {
              "count": 0,
              "oldest": null
            },
            "certified_open": {
              "count": 30,
              "oldest": null
            },
            "work_open": {
              "count": 1,
              "oldest": null
            },
            "rentals_payment": {
              "count": 0,
              "oldest": null
            }
          },
          "needs_action": 112
        },
        {
          "community": {
            "id": "00000000-0000-4000-8000-00000000000e",
            "name": "Sample Estates",
            "management_status": "active",
            "management_end_date": null
          },
          "group": "managed",
          "areas": {
            "calls_overdue": {
              "count": 22,
              "oldest": "2026-06-01T15:00:00Z"
            },
            "builder_overdue": {
              "count": 0,
              "oldest": null
            },
            "work_overdue": {
              "count": 0,
              "oldest": null
            },
            "certified_cure_ended": {
              "count": 0,
              "oldest": null
            },
            "letters_unrecorded": {
              "count": 0,
              "oldest": null
            },
            "letters_draft": {
              "count": 6,
              "oldest": "2026-09-01T15:00:00Z"
            },
            "acc_pending": {
              "count": 11,
              "oldest": "2026-07-13T15:00:00Z"
            },
            "email_drafts": {
              "count": 15,
              "oldest": "2026-07-22T15:00:00Z"
            },
            "letters_print": {
              "count": 0,
              "oldest": null
            },
            "courtesy_cure_ended": {
              "count": 41,
              "oldest": "2026-09-12T00:00:00Z"
            },
            "calls_open": {
              "count": 0,
              "oldest": null
            },
            "builder_open": {
              "count": 0,
              "oldest": null
            },
            "certified_open": {
              "count": 0,
              "oldest": null
            },
            "work_open": {
              "count": 0,
              "oldest": null
            },
            "rentals_payment": {
              "count": 1,
              "oldest": "2026-08-22T15:00:00Z"
            }
          },
          "needs_action": 55
        },
        {
          "community": {
            "id": "00000000-0000-4000-8000-00000000000b",
            "name": "Sample Ridge",
            "management_status": "active",
            "management_end_date": null
          },
          "group": "managed",
          "areas": {
            "calls_overdue": {
              "count": 0,
              "oldest": null
            },
            "builder_overdue": {
              "count": 7,
              "oldest": "2026-09-15T15:00:00Z"
            },
            "work_overdue": {
              "count": 1,
              "oldest": "2026-09-15T15:00:00Z"
            },
            "certified_cure_ended": {
              "count": 0,
              "oldest": null
            },
            "letters_unrecorded": {
              "count": 5,
              "oldest": "2026-09-22T18:00:00Z"
            },
            "letters_draft": {
              "count": 0,
              "oldest": null
            },
            "acc_pending": {
              "count": 0,
              "oldest": null
            },
            "email_drafts": {
              "count": 0,
              "oldest": null
            },
            "letters_print": {
              "count": 3,
              "oldest": "2026-09-21T15:00:00Z"
            },
            "courtesy_cure_ended": {
              "count": 0,
              "oldest": null
            },
            "calls_open": {
              "count": 0,
              "oldest": null
            },
            "builder_open": {
              "count": 2,
              "oldest": "2026-09-28T15:00:00Z"
            },
            "certified_open": {
              "count": 0,
              "oldest": null
            },
            "work_open": {
              "count": 0,
              "oldest": null
            },
            "rentals_payment": {
              "count": 0,
              "oldest": null
            }
          },
          "needs_action": 16
        },
        {
          "community": {
            "id": null,
            "name": "Bedrock / no community"
          },
          "group": "managed",
          "areas": {
            "calls_overdue": {
              "count": 1,
              "oldest": "2026-09-20T15:00:00Z"
            },
            "builder_overdue": {
              "count": 0,
              "oldest": null
            },
            "work_overdue": {
              "count": 1,
              "oldest": "2026-09-18T15:00:00Z"
            },
            "certified_cure_ended": {
              "count": 0,
              "oldest": null
            },
            "letters_unrecorded": {
              "count": 0,
              "oldest": null
            },
            "letters_draft": {
              "count": 0,
              "oldest": null
            },
            "acc_pending": {
              "count": 0,
              "oldest": null
            },
            "email_drafts": {
              "count": 0,
              "oldest": null
            },
            "letters_print": {
              "count": 0,
              "oldest": null
            },
            "courtesy_cure_ended": {
              "count": 0,
              "oldest": null
            },
            "calls_open": {
              "count": 0,
              "oldest": null
            },
            "builder_open": {
              "count": 0,
              "oldest": null
            },
            "certified_open": {
              "count": 0,
              "oldest": null
            },
            "work_open": {
              "count": 0,
              "oldest": null
            },
            "rentals_payment": {
              "count": 0,
              "oldest": null
            }
          },
          "needs_action": 2
        }
      ],
      "other": [
        {
          "community": {
            "id": "00000000-0000-4000-8000-00000000000c",
            "name": "Sample Landscape District",
            "management_status": "prospect",
            "management_end_date": null
          },
          "group": "prospect",
          "areas": {
            "calls_overdue": {
              "count": 0,
              "oldest": null
            },
            "builder_overdue": {
              "count": 0,
              "oldest": null
            },
            "work_overdue": {
              "count": 0,
              "oldest": null
            },
            "certified_cure_ended": {
              "count": 0,
              "oldest": null
            },
            "letters_unrecorded": {
              "count": 0,
              "oldest": null
            },
            "letters_draft": {
              "count": 0,
              "oldest": null
            },
            "acc_pending": {
              "count": 0,
              "oldest": null
            },
            "email_drafts": {
              "count": 0,
              "oldest": null
            },
            "letters_print": {
              "count": 0,
              "oldest": null
            },
            "courtesy_cure_ended": {
              "count": 0,
              "oldest": null
            },
            "calls_open": {
              "count": 0,
              "oldest": null
            },
            "builder_open": {
              "count": 0,
              "oldest": null
            },
            "certified_open": {
              "count": 0,
              "oldest": null
            },
            "work_open": {
              "count": 0,
              "oldest": null
            },
            "rentals_payment": {
              "count": 0,
              "oldest": null
            }
          },
          "needs_action": 0
        },
        {
          "community": {
            "id": "00000000-0000-4000-8000-00000000000d",
            "name": "Sample Leaving HOA",
            "management_status": "terminating",
            "management_end_date": "2026-09-30"
          },
          "group": "leaving",
          "areas": {
            "calls_overdue": {
              "count": 0,
              "oldest": null
            },
            "builder_overdue": {
              "count": 0,
              "oldest": null
            },
            "work_overdue": {
              "count": 0,
              "oldest": null
            },
            "certified_cure_ended": {
              "count": 0,
              "oldest": null
            },
            "letters_unrecorded": {
              "count": 12,
              "oldest": "2026-08-01T18:00:00Z"
            },
            "letters_draft": {
              "count": 0,
              "oldest": null
            },
            "acc_pending": {
              "count": 0,
              "oldest": null
            },
            "email_drafts": {
              "count": 0,
              "oldest": null
            },
            "letters_print": {
              "count": 0,
              "oldest": null
            },
            "courtesy_cure_ended": {
              "count": 0,
              "oldest": null
            },
            "calls_open": {
              "count": 0,
              "oldest": null
            },
            "builder_open": {
              "count": 0,
              "oldest": null
            },
            "certified_open": {
              "count": 0,
              "oldest": null
            },
            "work_open": {
              "count": 0,
              "oldest": null
            },
            "rentals_payment": {
              "count": 0,
              "oldest": null
            }
          },
          "needs_action": 12
        }
      ]
    }
  }
};
