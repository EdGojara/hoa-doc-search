// Fixture for /app/financial/legal in fixture mode (visual snapshot harness).
// SAMPLE DATA ONLY: the synthetic Daughtry & Farine-shaped invoice from
// tests/fixtures/legal-invoices, with a valid PDF read in use, run through
// lib/legal/review_data.js detailPayload().
window.TX_FIXTURE = {
  "/api/legal-review/summaries": {
    "ok": true,
    "data": {
      "generated_at": "2026-09-29T15:00:00.000Z",
      "summaries": {
        "00000000-0000-4000-8000-0000000000e1": {
          "source": "suggestion",
          "revision": 0,
          "pdf": "in_use",
          "summary": {
            "total_cents": 72006,
            "recoverable": {
              "count": 1,
              "cents": 33606
            },
            "association": {
              "count": 1,
              "cents": 6000
            },
            "exceptions": {
              "count": 1,
              "cents": 32400
            },
            "accepted": {
              "count": 2,
              "cents": 39606
            },
            "reconciled": true,
            "difference_cents": 0,
            "can_accept": false
          }
        },
        "00000000-0000-4000-8000-0000000000e2": {
          "source": "draft",
          "revision": 0,
          "pdf": "in_use",
          "summary": {
            "total_cents": 46000,
            "recoverable": {
              "count": 1,
              "cents": 46000
            },
            "association": {
              "count": 0,
              "cents": 0
            },
            "exceptions": {
              "count": 0,
              "cents": 0
            },
            "accepted": {
              "count": 1,
              "cents": 46000
            },
            "reconciled": true,
            "difference_cents": 0,
            "can_accept": true
          }
        },
        "00000000-0000-4000-8000-0000000000e3": {
          "source": "suggestion",
          "revision": 0,
          "pdf": "in_use",
          "summary": {
            "total_cents": 67500,
            "recoverable": {
              "count": 0,
              "cents": 0
            },
            "association": {
              "count": 1,
              "cents": 67500
            },
            "exceptions": {
              "count": 0,
              "cents": 0
            },
            "accepted": {
              "count": 1,
              "cents": 67500
            },
            "reconciled": true,
            "difference_cents": 0,
            "can_accept": true
          }
        }
      }
    }
  },
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
          "invoice_number": "900594",
          "invoice_date": "2026-08-31",
          "total_cents": 72006,
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
        "invoice_number": "900594",
        "invoice_date": "2026-08-31",
        "due_date": "2026-09-30",
        "total_cents": 72006,
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
          "description": "Farrow, Juniper - 9903 Fixture Bend Ct. - Fees",
          "amount_cents": 32400,
          "account": "5870 Collections/DRV"
        },
        {
          "id": "00000000-0000-4000-8000-000000000202",
          "line_number": 2,
          "description": "Farrow, Juniper - 9903 Fixture Bend Ct. - Expenses",
          "amount_cents": 1206,
          "account": "5870 Collections/DRV"
        },
        {
          "id": "00000000-0000-4000-8000-000000000203",
          "line_number": 3,
          "description": "Pemberton, Quill O. - 4202 Example Hollow Ct. - Fees",
          "amount_cents": 32400,
          "account": "5870 Collections/DRV"
        },
        {
          "id": "00000000-0000-4000-8000-000000000204",
          "line_number": 4,
          "description": "General Matters - Fees",
          "amount_cents": 6000,
          "account": "5860 Corporate"
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
            "source_text": "Farrow, Juniper - 9903 Fixture Bend Ct. - Fees | Farrow, Juniper - 9903 Fixture Bend Ct. - Expenses",
            "matter_ref": "9999.0004",
            "extraction_id": "00000000-0000-4000-8000-0000000003e1",
            "amount_cents": 33606,
            "service_date": "2026-08-03",
            "service_period_start": null,
            "service_period_end": null,
            "service_date_source": "pdf_entry",
            "service_basis": "service date 2026-08-03, from the dates of the attorney’s time and expense entries on the invoice PDF",
            "allocations": [
              {
                "property_id": "00000000-0000-4000-8000-000000000103",
                "tenure_id": "t3",
                "tenure_match": "current",
                "confidence": "high",
                "bankruptcy_stop": false,
                "charge_category": "attorney_fee_other",
                "classification": "homeowner_recoverable",
                "evidence": [
                  {
                    "kind": "pdf_matter",
                    "value": "invoice PDF matter 9999.0004: Farrow, Juniper - 9903 Fixture Bend Ct. (Deed Restriction Matters)"
                  },
                  {
                    "kind": "work_type",
                    "value": "deed-restriction work per the invoice PDF: supported by the heading / title"
                  },
                  {
                    "kind": "address",
                    "value": "9903 Fixture Bend Ct.",
                    "matched": 1
                  },
                  {
                    "kind": "name",
                    "value": "Farrow, Juniper"
                  },
                  {
                    "kind": "service_basis",
                    "value": "service date 2026-08-03, from the dates of the attorney’s time and expense entries on the invoice PDF"
                  },
                  {
                    "kind": "tenure",
                    "value": "the service date (2026-08-03) falls in the current owner’s period"
                  },
                  {
                    "kind": "name_check",
                    "value": "the printed name matches the owner on file"
                  }
                ],
                "review_reasons": [],
                "amount_cents": 33606,
                "suggested": true,
                "property_label": "9903 Fixture Bend Ct",
                "owner_names": [
                  "Juniper Farrow"
                ]
              }
            ],
            "triage": {
              "status": "accepted",
              "hard": [],
              "soft": [],
              "reasons": [],
              "confirmable": false
            }
          },
          {
            "sort_order": 1,
            "source_line_ids": [
              "00000000-0000-4000-8000-000000000203"
            ],
            "source_text": "Pemberton, Quill O. - 4202 Example Hollow Ct. - Fees",
            "matter_ref": "9999.0007",
            "extraction_id": "00000000-0000-4000-8000-0000000003e1",
            "amount_cents": 32400,
            "service_date": null,
            "service_period_start": "2026-08-10",
            "service_period_end": "2026-08-24",
            "service_date_source": "pdf_entry",
            "service_basis": "service period 2026-08-10 to 2026-08-24, from the dates of the attorney’s time and expense entries on the invoice PDF",
            "allocations": [
              {
                "property_id": "00000000-0000-4000-8000-000000000102",
                "tenure_id": "t2",
                "tenure_match": "current",
                "confidence": "high",
                "bankruptcy_stop": true,
                "charge_category": "attorney_fee",
                "classification": "needs_review",
                "evidence": [
                  {
                    "kind": "pdf_matter",
                    "value": "invoice PDF matter 9999.0007: Pemberton, Quill O. - 4202 Example Hollow Ct. (Collection Matters)"
                  },
                  {
                    "kind": "work_type",
                    "value": "collection work per the invoice PDF: supported by the heading / title"
                  },
                  {
                    "kind": "address",
                    "value": "4202 Example Hollow Ct.",
                    "matched": 1
                  },
                  {
                    "kind": "name",
                    "value": "Pemberton, Quill O."
                  },
                  {
                    "kind": "service_basis",
                    "value": "service period 2026-08-10 to 2026-08-24, from the dates of the attorney’s time and expense entries on the invoice PDF"
                  },
                  {
                    "kind": "tenure",
                    "value": "the whole service period (2026-08-10 to 2026-08-24) falls in the current owner’s period"
                  },
                  {
                    "kind": "name_check",
                    "value": "the printed name matches the owner on file"
                  },
                  {
                    "kind": "bankruptcy",
                    "value": "bankruptcy on file for this property"
                  },
                  {
                    "kind": "legal_status",
                    "value": "at legal"
                  }
                ],
                "review_reasons": [
                  "bankruptcy: hard stop for legal review"
                ],
                "amount_cents": 32400,
                "suggested": true,
                "property_label": "4202 Example Hollow Ct",
                "owner_names": [
                  "Quill O. Pemberton"
                ]
              }
            ],
            "triage": {
              "status": "exception",
              "hard": [
                "needs a decision: homeowner or association",
                "bankruptcy: hard stop for legal review"
              ],
              "soft": [],
              "reasons": [
                "needs a decision: homeowner or association",
                "bankruptcy: hard stop for legal review"
              ],
              "confirmable": false
            }
          },
          {
            "sort_order": 2,
            "source_line_ids": [
              "00000000-0000-4000-8000-000000000204"
            ],
            "source_text": "General Matters - Fees",
            "matter_ref": "9999.0001",
            "extraction_id": "00000000-0000-4000-8000-0000000003e1",
            "amount_cents": 6000,
            "service_date": "2026-08-12",
            "service_period_start": null,
            "service_period_end": null,
            "service_date_source": "pdf_entry",
            "service_basis": "service date 2026-08-12, from the dates of the attorney’s time and expense entries on the invoice PDF",
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
                    "kind": "pdf_matter",
                    "value": "invoice PDF matter 9999.0001: General Matters (General Matters)"
                  },
                  {
                    "kind": "work_type",
                    "value": "general / association matter per the invoice PDF"
                  },
                  {
                    "kind": "work_type",
                    "value": "association / corporate work, no property named"
                  }
                ],
                "review_reasons": [],
                "amount_cents": 6000,
                "suggested": true,
                "property_label": null,
                "owner_names": []
              }
            ],
            "triage": {
              "status": "accepted",
              "hard": [],
              "soft": [],
              "reasons": [],
              "confirmable": false
            }
          }
        ],
        "reconciliation": {
          "invoice_total_cents": 72006,
          "allocated_cents": 72006,
          "difference_cents": 0,
          "items_balanced": true,
          "reconciled": true,
          "ready_for_approval": false,
          "blocking": [
            "item 2 has an allocation that needs review",
            "item 2 has a bankruptcy stop"
          ]
        },
        "summary": {
          "total_cents": 72006,
          "recoverable": {
            "count": 1,
            "cents": 33606
          },
          "association": {
            "count": 1,
            "cents": 6000
          },
          "exceptions": {
            "count": 1,
            "cents": 32400
          },
          "accepted": {
            "count": 2,
            "cents": 39606
          },
          "reconciled": true,
          "difference_cents": 0,
          "can_accept": false
        }
      },
      "draft": null,
      "revision": 0,
      "review": null,
      "events": [],
      "extraction": {
        "id": "00000000-0000-4000-8000-0000000003e1",
        "status": "valid",
        "used": true,
        "note": null,
        "created_at": "2026-09-29T20:40:00Z",
        "created_by": "staff@example.test",
        "problems": [],
        "error": null,
        "matters": [
          {
            "index": 0,
            "matter_ref": "9999.0004",
            "section_heading": "Deed Restriction Matters",
            "title": "Farrow, Juniper - 9903 Fixture Bend Ct.",
            "work_type": "deed_restriction",
            "property_address": "9903 Fixture Bend Ct.",
            "total_cents": 33606,
            "entries": 5,
            "service_basis": "service date 2026-08-03, from the dates of the attorney’s time and expense entries on the invoice PDF",
            "referenced_dates": []
          },
          {
            "index": 1,
            "matter_ref": "9999.0007",
            "section_heading": "Collection Matters",
            "title": "Pemberton, Quill O. - 4202 Example Hollow Ct.",
            "work_type": "collection",
            "property_address": "4202 Example Hollow Ct.",
            "total_cents": 32400,
            "entries": 2,
            "service_basis": "service period 2026-08-10 to 2026-08-24, from the dates of the attorney’s time and expense entries on the invoice PDF",
            "referenced_dates": []
          },
          {
            "index": 2,
            "matter_ref": "9999.0001",
            "section_heading": "General Matters",
            "title": "General Matters",
            "work_type": "general",
            "property_address": null,
            "total_cents": 6000,
            "entries": 2,
            "service_basis": "service date 2026-08-12, from the dates of the attorney’s time and expense entries on the invoice PDF",
            "referenced_dates": []
          }
        ]
      },
      "extraction_note": null
    }
  }
};
