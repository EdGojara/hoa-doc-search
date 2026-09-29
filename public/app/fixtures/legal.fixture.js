// Fixture for /app/financial/legal in fixture mode (visual snapshot harness).
// SAMPLE DATA ONLY, generated from lib/legal/review_data.js detailPayload() on synthetic rows.
window.TX_FIXTURE = {
  "user": {
    "full_name": "Preview User",
    "role": "admin"
  },
  "/api/legal-review/invoices": {
    "ok": true,
    "data": {
      "generated_at": "2026-09-29T15:00:00.000Z",
      "schema_ready": true,
      "truncated": false,
      "invoices": [
        {
          "id": "00000000-0000-4000-8000-0000000000e1",
          "vendor": "Sample Law Firm, P.C.",
          "invoice_number": "100245",
          "invoice_date": "2026-08-31",
          "total_cents": 87640,
          "ap_status": "awaiting_approval",
          "accrued": true,
          "community": {
            "id": "00000000-0000-4000-8000-0000000000c1",
            "name": "Sample Meadows HOA"
          },
          "read_only": null,
          "review": null
        },
        {
          "id": "00000000-0000-4000-8000-0000000000e2",
          "vendor": "Example Legal Group",
          "invoice_number": "PS-2001",
          "invoice_date": "2026-08-28",
          "total_cents": 46000,
          "ap_status": "awaiting_approval",
          "accrued": true,
          "community": {
            "id": "00000000-0000-4000-8000-0000000000c1",
            "name": "Sample Meadows HOA"
          },
          "read_only": null,
          "review": {
            "revision": 2,
            "updated_at": "2026-09-28T20:10:00Z",
            "updated_by": "staff@example.test"
          }
        },
        {
          "id": "00000000-0000-4000-8000-0000000000e3",
          "vendor": "Fixture & Partners PC",
          "invoice_number": "5001",
          "invoice_date": "2026-08-12",
          "total_cents": 67500,
          "ap_status": "awaiting_approval",
          "accrued": true,
          "community": {
            "id": "c2",
            "name": "Demo Lakes HOA"
          },
          "read_only": null,
          "review": null
        },
        {
          "id": "00000000-0000-4000-8000-0000000000e4",
          "vendor": "Fixture & Partners PC",
          "invoice_number": "5002",
          "invoice_date": "2026-08-12",
          "total_cents": 225656,
          "ap_status": "awaiting_approval",
          "accrued": true,
          "community": {
            "id": "c3",
            "name": "Departing Village HOA"
          },
          "read_only": "Leaving Bedrock (last day 2026-10-31): view only.",
          "review": null
        }
      ]
    }
  },
  "/api/legal-review/invoices/00000000-0000-4000-8000-0000000000e1": {
    "ok": true,
    "data": {
      "invoice": {
        "id": "00000000-0000-4000-8000-0000000000e1",
        "vendor": "Sample Law Firm, P.C.",
        "invoice_number": "100245",
        "invoice_date": "2026-08-31",
        "due_date": "2026-09-30",
        "total_cents": 87640,
        "ap_status": "awaiting_approval",
        "voided": false,
        "accrued": true,
        "has_file": true,
        "service_period_start": null,
        "service_period_end": null,
        "community_id": "00000000-0000-4000-8000-0000000000c1"
      },
      "community": {
        "id": "00000000-0000-4000-8000-0000000000c1",
        "name": "Sample Meadows HOA"
      },
      "lines": [
        {
          "id": "00000000-0000-4000-8000-000000000201",
          "line_number": 1,
          "description": "Testerly, Marigold - 4101 Sample Meadow Dr. - Fees - collection demand letter",
          "amount_cents": 32400,
          "account": "5870 Collections"
        },
        {
          "id": "00000000-0000-4000-8000-000000000202",
          "line_number": 2,
          "description": "Testerly, Marigold - 4101 Sample Meadow Dr. - Expenses",
          "amount_cents": 900,
          "account": "5870 Collections"
        },
        {
          "id": "00000000-0000-4000-8000-000000000203",
          "line_number": 3,
          "description": "Pemberton, Quill O. - 4202 Example Hollow Ct. - Fees",
          "amount_cents": 19440,
          "account": "5870 Collections"
        },
        {
          "id": "00000000-0000-4000-8000-000000000204",
          "line_number": 4,
          "description": "Farrow, Juniper - 9903 Fixture Bend Ct. - reviewed Chapter 13 plan and filed proof of claim",
          "amount_cents": 6750,
          "account": "5870 Collections"
        },
        {
          "id": "00000000-0000-4000-8000-000000000205",
          "line_number": 5,
          "description": "General matters: reviewed proposed management agreement and advised the Board",
          "amount_cents": 16650,
          "account": "5860 Corporate"
        },
        {
          "id": "00000000-0000-4000-8000-000000000206",
          "line_number": 6,
          "description": "Prepared release of lien.",
          "amount_cents": 11500,
          "account": "5870 Collections"
        }
      ],
      "read_only": null,
      "schema_ready": true,
      "suggestion": {
        "items": [
          {
            "sort_order": 0,
            "source_line_ids": [
              "00000000-0000-4000-8000-000000000201",
              "00000000-0000-4000-8000-000000000202"
            ],
            "source_text": "Testerly, Marigold - 4101 Sample Meadow Dr. - Fees - collection demand letter | Testerly, Marigold - 4101 Sample Meadow Dr. - Expenses",
            "matter_ref": null,
            "amount_cents": 33300,
            "service_date": null,
            "service_date_source": "none",
            "allocations": [
              {
                "property_id": "00000000-0000-4000-8000-000000000101",
                "tenure_id": "t1",
                "tenure_match": "current",
                "confidence": "high",
                "bankruptcy_stop": false,
                "charge_category": "attorney_fee",
                "classification": "homeowner_recoverable",
                "evidence": [
                  {
                    "kind": "address",
                    "value": "4101 Sample Meadow Dr",
                    "matched": 1
                  },
                  {
                    "kind": "name",
                    "value": "Testerly, Marigold"
                  },
                  {
                    "kind": "tenure",
                    "value": "no service date on the invoice; no ownership change within 180 days, so the current owner"
                  },
                  {
                    "kind": "name_check",
                    "value": "the printed name matches the owner on file"
                  },
                  {
                    "kind": "legal_status",
                    "value": "at legal"
                  }
                ],
                "review_reasons": [],
                "amount_cents": 33300,
                "suggested": true,
                "property_label": "4101 Sample Meadow Dr",
                "owner_names": [
                  "Marigold Testerly"
                ]
              }
            ]
          },
          {
            "sort_order": 1,
            "source_line_ids": [
              "00000000-0000-4000-8000-000000000203"
            ],
            "source_text": "Pemberton, Quill O. - 4202 Example Hollow Ct. - Fees",
            "matter_ref": null,
            "amount_cents": 19440,
            "service_date": null,
            "service_date_source": "none",
            "allocations": [
              {
                "property_id": "00000000-0000-4000-8000-000000000102",
                "tenure_id": "t2",
                "tenure_match": "current",
                "confidence": "high",
                "bankruptcy_stop": false,
                "charge_category": null,
                "classification": "needs_review",
                "evidence": [
                  {
                    "kind": "address",
                    "value": "4202 Example Hollow Ct",
                    "matched": 1
                  },
                  {
                    "kind": "name",
                    "value": "Pemberton, Quill O."
                  },
                  {
                    "kind": "tenure",
                    "value": "no service date on the invoice; no ownership change within 180 days, so the current owner"
                  },
                  {
                    "kind": "name_check",
                    "value": "the printed name matches the owner on file"
                  }
                ],
                "review_reasons": [
                  "the work type (collection vs deed restriction) is not clear from the text"
                ],
                "amount_cents": 19440,
                "suggested": true,
                "property_label": "4202 Example Hollow Ct",
                "owner_names": [
                  "Quill O. Pemberton"
                ]
              }
            ]
          },
          {
            "sort_order": 2,
            "source_line_ids": [
              "00000000-0000-4000-8000-000000000204"
            ],
            "source_text": "Farrow, Juniper - 9903 Fixture Bend Ct. - reviewed Chapter 13 plan and filed proof of claim",
            "matter_ref": null,
            "amount_cents": 6750,
            "service_date": null,
            "service_date_source": "none",
            "allocations": [
              {
                "property_id": "00000000-0000-4000-8000-000000000103",
                "tenure_id": "t3",
                "tenure_match": "current",
                "confidence": "high",
                "bankruptcy_stop": true,
                "charge_category": null,
                "classification": "needs_review",
                "evidence": [
                  {
                    "kind": "address",
                    "value": "9903 Fixture Bend Ct",
                    "matched": 1
                  },
                  {
                    "kind": "name",
                    "value": "Farrow, Juniper"
                  },
                  {
                    "kind": "tenure",
                    "value": "no service date on the invoice; no ownership change within 180 days, so the current owner"
                  },
                  {
                    "kind": "name_check",
                    "value": "the printed name matches the owner on file"
                  }
                ],
                "review_reasons": [
                  "bankruptcy: hard stop for legal review",
                  "the work type (collection vs deed restriction) is not clear from the text"
                ],
                "amount_cents": 6750,
                "suggested": true,
                "property_label": "9903 Fixture Bend Ct",
                "owner_names": [
                  "Juniper Farrow"
                ]
              }
            ]
          },
          {
            "sort_order": 3,
            "source_line_ids": [
              "00000000-0000-4000-8000-000000000205"
            ],
            "source_text": "General matters: reviewed proposed management agreement and advised the Board",
            "matter_ref": null,
            "amount_cents": 16650,
            "service_date": null,
            "service_date_source": "none",
            "allocations": [
              {
                "property_id": null,
                "tenure_id": null,
                "tenure_match": "not_applicable",
                "confidence": "medium",
                "bankruptcy_stop": false,
                "charge_category": null,
                "classification": "association_legal_expense",
                "evidence": [
                  {
                    "kind": "work_type",
                    "value": "association / corporate work, no property named"
                  }
                ],
                "review_reasons": [],
                "amount_cents": 16650,
                "suggested": true,
                "property_label": null,
                "owner_names": []
              }
            ]
          },
          {
            "sort_order": 4,
            "source_line_ids": [
              "00000000-0000-4000-8000-000000000206"
            ],
            "source_text": "Prepared release of lien.",
            "matter_ref": null,
            "amount_cents": 11500,
            "service_date": null,
            "service_date_source": "none",
            "allocations": [
              {
                "property_id": null,
                "tenure_id": null,
                "tenure_match": "not_applicable",
                "confidence": "none",
                "bankruptcy_stop": false,
                "charge_category": null,
                "classification": "needs_review",
                "evidence": [],
                "review_reasons": [
                  "no property or account named on this line; check the invoice PDF for the matter"
                ],
                "amount_cents": 11500,
                "suggested": true,
                "property_label": null,
                "owner_names": []
              }
            ]
          }
        ],
        "reconciliation": {
          "invoice_total_cents": 87640,
          "allocated_cents": 87640,
          "difference_cents": 0,
          "items_balanced": true,
          "reconciled": true,
          "ready_for_approval": false,
          "blocking": [
            "item 2 has an allocation that needs review",
            "item 3 has an allocation that needs review",
            "item 3 has a bankruptcy stop",
            "item 5 has an allocation that needs review"
          ]
        }
      },
      "draft": null,
      "revision": 0,
      "review": null,
      "events": []
    }
  }
};
