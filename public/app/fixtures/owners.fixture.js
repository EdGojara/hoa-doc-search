// Fixture for /app/owners in fixture mode (visual snapshot harness).
// SAMPLE DATA ONLY, generated from lib/owners/overview.js on synthetic rows. No real owners.
window.TX_FIXTURE = {
  "user": {
    "full_name": "Ed Gojara",
    "role": "admin"
  },
  "/api/owners/overview": {
    "ok": true,
    "data": {
      "generated_at": "2026-09-29T15:00:00Z",
      "managed": [
        {
          "community": {
            "id": "00000000-0000-4000-8000-00000000000f",
            "name": "Sample Meadows",
            "management_status": "active",
            "management_end_date": null
          },
          "group": "managed",
          "properties": 42,
          "no_owner": 42,
          "at_legal": 0,
          "in_collections": 0,
          "collections": [],
          "proposals": 0,
          "needs_action": 42
        },
        {
          "community": {
            "id": "00000000-0000-4000-8000-00000000000a",
            "name": "Drama Creek (sample)",
            "management_status": "active",
            "management_end_date": null
          },
          "group": "managed",
          "properties": 543,
          "no_owner": 0,
          "at_legal": 0,
          "in_collections": 1,
          "collections": [],
          "proposals": 2,
          "needs_action": 2
        },
        {
          "community": {
            "id": "00000000-0000-4000-8000-00000000000b",
            "name": "Sample Ridge",
            "management_status": "active",
            "management_end_date": null
          },
          "group": "managed",
          "properties": 101,
          "no_owner": 0,
          "at_legal": 1,
          "in_collections": 0,
          "collections": [
            {
              "status": "bankruptcy",
              "count": 1
            },
            {
              "status": "with_attorney",
              "count": 3
            },
            {
              "status": "late_notice",
              "count": 4
            }
          ],
          "proposals": 0,
          "needs_action": 0
        }
      ],
      "other": [
        {
          "community": {
            "id": "00000000-0000-4000-8000-00000000000d",
            "name": "Sample Leaving HOA",
            "management_status": "terminating",
            "management_end_date": "2026-09-30"
          },
          "group": "leaving",
          "properties": 868,
          "no_owner": 0,
          "at_legal": 1,
          "in_collections": 0,
          "collections": [],
          "proposals": 0,
          "needs_action": 0
        }
      ],
      "totals": {
        "properties": 686,
        "no_owner": 42,
        "at_legal": 1,
        "in_collections": 1,
        "proposals": 2
      },
      "collapse": [
        {
          "contact_id": "jane",
          "name": "Jane Sample",
          "properties": 9,
          "communities": [
            "Sample Ridge"
          ]
        }
      ],
      "collapse_threshold": 8,
      "problems": []
    }
  },
  "/api/owners/search": {
    "ok": true,
    "data": {
      "query": "sample",
      "results": [
        {
          "property_id": "p1",
          "community_id": "00000000-0000-4000-8000-00000000000a",
          "community": "Drama Creek (sample)",
          "street_address": "4719 Sample Canyon Ln",
          "unit": null,
          "owner_name": "Alex Sample",
          "trusted_account_number": "TR-100231",
          "vantaca_account_id": "LPF1023"
        },
        {
          "property_id": "p3",
          "community_id": "00000000-0000-4000-8000-00000000000b",
          "community": "Sample Ridge",
          "street_address": "12 Example Ridge Dr",
          "unit": "2",
          "owner_name": "Casey Placeholder",
          "trusted_account_number": null,
          "vantaca_account_id": null
        },
        {
          "property_id": "p2",
          "community_id": "00000000-0000-4000-8000-00000000000a",
          "community": "Drama Creek (sample)",
          "street_address": "4723 Sample Canyon Ln",
          "unit": null,
          "owner_name": "Jordan Example",
          "trusted_account_number": "TR-100232",
          "vantaca_account_id": null
        }
      ],
      "capped": false
    }
  }
};
