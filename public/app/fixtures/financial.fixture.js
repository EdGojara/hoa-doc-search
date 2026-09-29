// Fixture for /app/financial in fixture mode (visual snapshot harness).
// SAMPLE DATA ONLY: readiness rows generated from lib/community/data_readiness.js
// evaluate() on synthetic communities; queue rows are invented samples.
window.TX_FIXTURE = {
  "user": {
    "full_name": "Ed Gojara",
    "role": "admin"
  },
  "/api/readiness/communities": {
    "ok": true,
    "data": {
      "generated_at": "2026-09-29T15:00:00Z",
      "communities": [
        {
          "generated_at": "2026-09-29T15:00:00Z",
          "community": {
            "id": "00000000-0000-4000-8000-00000000000a",
            "name": "Drama Creek (sample)",
            "management_status": "active",
            "management_end_date": null
          },
          "areas": [
            {
              "key": "profile",
              "title": "Community profile",
              "status": "partial",
              "summary": "1 field missing.",
              "missing": [
                "Lot count"
              ],
              "next": "Fill them in on the community profile.",
              "source": "communities table",
              "href": "/#tab=community"
            },
            {
              "key": "properties",
              "title": "Properties and owners",
              "status": "imported_not_verified",
              "summary": "543 properties, all with a current owner.",
              "missing": [
                "Lot count not on file, so completeness can’t be checked"
              ],
              "next": "Add the lot count to the profile.",
              "source": "properties + v_current_property_owners",
              "href": "/#tab=community"
            },
            {
              "key": "ledger",
              "title": "Owner ledger conversion",
              "status": "partial",
              "summary": "Posted: CONV-SAMPLE-20260731, as of 2026-07-31; 6 conversion exceptions still open.",
              "missing": [
                "6 open conversion exceptions (decided by Ed)"
              ],
              "next": "Decide the open conversion exceptions.",
              "source": "conversion_batches / conversion_runs / conversion_exceptions",
              "href": null
            },
            {
              "key": "ar",
              "title": "Receivables vs GL",
              "status": "ready",
              "summary": "$58,707.04 ties to GL 1300 + 2400 · difference $0.00. Latest owner-ledger import as of 2026-08-27.",
              "missing": [],
              "next": null,
              "source": "lib/ar/ar_control.js (v_homeowner_current_balance vs GL 1300 + 2400)",
              "href": "/admin/accounting?community_id=00000000-0000-4000-8000-00000000000a&view=ar"
            },
            {
              "key": "gl",
              "title": "General ledger",
              "status": "imported_not_verified",
              "summary": "Cut over 2026-08-01; 301 journal entries; trial balance balances.",
              "missing": [
                "The tie-out to Vantaca’s ending balances isn’t stored"
              ],
              "next": null,
              "source": "chart_of_accounts, journal_entries, v_trial_balance",
              "href": "/admin/accounting?community_id=00000000-0000-4000-8000-00000000000a&view=trial"
            },
            {
              "key": "budget",
              "title": "Budget",
              "status": "ready",
              "summary": "2026 budget approved (37 lines).",
              "missing": [],
              "next": null,
              "source": "community_budgets + budget_line_items",
              "href": "/admin/accounting?community_id=00000000-0000-4000-8000-00000000000a&view=budget"
            },
            {
              "key": "bank",
              "title": "Bank reconciliation",
              "status": "partial",
              "summary": "0 accounts of 1 reconciled.",
              "missing": [
                "Operating Checking: in progress (latest 2026-05-29)"
              ],
              "next": "Reconcile the remaining accounts.",
              "source": "bank_accounts + latest bank_reconciliations",
              "href": "/admin/accounting?community_id=00000000-0000-4000-8000-00000000000a&view=bankrec"
            },
            {
              "key": "violations",
              "title": "Violations history",
              "status": "imported_not_verified",
              "summary": "142 violations imported from Vantaca; 831 in total.",
              "missing": [
                "Vantaca imports keep no batch record, so completeness can’t be checked"
              ],
              "next": null,
              "source": "violations (source = 'vantaca_import')",
              "href": "/#tab=inspect"
            },
            {
              "key": "vendors",
              "title": "Vendors",
              "status": "imported_not_verified",
              "summary": "10 vendor accounts linked.",
              "missing": [
                "No Vantaca vendor list to compare against"
              ],
              "next": null,
              "source": "vendor_community_accounts",
              "href": "/#tab=vendors"
            },
            {
              "key": "documents",
              "title": "Documents",
              "status": "imported_not_verified",
              "summary": "1 current document; every required resale category present and indexed.",
              "missing": [
                "No Vantaca document list to compare against"
              ],
              "next": null,
              "source": "library_documents + document_categories.required_for_resale",
              "href": "/#tab=docs"
            },
            {
              "key": "board",
              "title": "Board and contacts",
              "status": "imported_not_verified",
              "summary": "3 active board members; 11 community contacts.",
              "missing": [
                "Nothing to check the roster against"
              ],
              "next": null,
              "source": "board_members (active) + community_contacts",
              "href": "/#tab=roster"
            },
            {
              "key": "insurance",
              "title": "Insurance",
              "status": "ready",
              "summary": "1 current policy; next expiry 2027-03-01.",
              "missing": [],
              "next": null,
              "source": "insurance_policies",
              "href": "/#tab=community"
            }
          ],
          "counts": {
            "not_applicable": 0,
            "not_imported": 0,
            "in_progress": 0,
            "partial": 3,
            "imported_not_verified": 6,
            "imported_not_reconciled": 0,
            "ready": 3,
            "error": 0
          },
          "needs_action": 3,
          "worst": "partial"
        },
        {
          "generated_at": "2026-09-29T15:00:00Z",
          "community": {
            "id": "00000000-0000-4000-8000-00000000000b",
            "name": "Sample Ridge",
            "management_status": "active",
            "management_end_date": null
          },
          "areas": [
            {
              "key": "profile",
              "title": "Community profile",
              "status": "partial",
              "summary": "1 field missing.",
              "missing": [
                "Lot count"
              ],
              "next": "Fill them in on the community profile.",
              "source": "communities table",
              "href": "/#tab=community"
            },
            {
              "key": "properties",
              "title": "Properties and owners",
              "status": "imported_not_verified",
              "summary": "543 properties, all with a current owner.",
              "missing": [
                "Lot count not on file, so completeness can’t be checked"
              ],
              "next": "Add the lot count to the profile.",
              "source": "properties + v_current_property_owners",
              "href": "/#tab=community"
            },
            {
              "key": "ledger",
              "title": "Owner ledger conversion",
              "status": "not_imported",
              "summary": "No ledger conversion yet.",
              "missing": [
                "Owner ledger conversion"
              ],
              "next": "Stage and post the owner ledger conversion.",
              "source": "conversion_batches / conversion_runs / conversion_exceptions",
              "href": null
            },
            {
              "key": "ar",
              "title": "Receivables vs GL",
              "status": "imported_not_reconciled",
              "summary": "$24,058.30 owed by owners. Compared with the GL once the ledger conversion is posted. Latest owner-ledger import as of 2026-08-27.",
              "missing": [
                "Posted ledger conversion"
              ],
              "next": "Post the owner ledger conversion first.",
              "source": "lib/ar/ar_control.js (v_homeowner_current_balance vs GL 1300 + 2400)",
              "href": "/admin/accounting?community_id=00000000-0000-4000-8000-00000000000b&view=ar"
            },
            {
              "key": "gl",
              "title": "General ledger",
              "status": "imported_not_verified",
              "summary": "Cut over 2026-06-01; 301 journal entries; trial balance balances.",
              "missing": [
                "The tie-out to Vantaca’s ending balances isn’t stored"
              ],
              "next": null,
              "source": "chart_of_accounts, journal_entries, v_trial_balance",
              "href": "/admin/accounting?community_id=00000000-0000-4000-8000-00000000000b&view=trial"
            },
            {
              "key": "budget",
              "title": "Budget",
              "status": "ready",
              "summary": "2026 budget approved (37 lines).",
              "missing": [],
              "next": null,
              "source": "community_budgets + budget_line_items",
              "href": "/admin/accounting?community_id=00000000-0000-4000-8000-00000000000b&view=budget"
            },
            {
              "key": "bank",
              "title": "Bank reconciliation",
              "status": "error",
              "summary": "1 account not balancing.",
              "missing": [
                "Operating: off $428.12 (2026-04-30)"
              ],
              "next": "Resolve the reconciliation differences.",
              "source": "bank_accounts + latest bank_reconciliations",
              "href": "/admin/accounting?community_id=00000000-0000-4000-8000-00000000000b&view=bankrec"
            },
            {
              "key": "violations",
              "title": "Violations history",
              "status": "imported_not_verified",
              "summary": "142 violations imported from Vantaca; 831 in total.",
              "missing": [
                "Vantaca imports keep no batch record, so completeness can’t be checked"
              ],
              "next": null,
              "source": "violations (source = 'vantaca_import')",
              "href": "/#tab=inspect"
            },
            {
              "key": "vendors",
              "title": "Vendors",
              "status": "imported_not_verified",
              "summary": "10 vendor accounts linked.",
              "missing": [
                "No Vantaca vendor list to compare against"
              ],
              "next": null,
              "source": "vendor_community_accounts",
              "href": "/#tab=vendors"
            },
            {
              "key": "documents",
              "title": "Documents",
              "status": "imported_not_verified",
              "summary": "1 current document; every required resale category present and indexed.",
              "missing": [
                "No Vantaca document list to compare against"
              ],
              "next": null,
              "source": "library_documents + document_categories.required_for_resale",
              "href": "/#tab=docs"
            },
            {
              "key": "board",
              "title": "Board and contacts",
              "status": "imported_not_verified",
              "summary": "3 active board members; 11 community contacts.",
              "missing": [
                "Nothing to check the roster against"
              ],
              "next": null,
              "source": "board_members (active) + community_contacts",
              "href": "/#tab=roster"
            },
            {
              "key": "insurance",
              "title": "Insurance",
              "status": "ready",
              "summary": "1 current policy; next expiry 2027-03-01.",
              "missing": [],
              "next": null,
              "source": "insurance_policies",
              "href": "/#tab=community"
            }
          ],
          "counts": {
            "not_applicable": 0,
            "not_imported": 1,
            "in_progress": 0,
            "partial": 1,
            "imported_not_verified": 6,
            "imported_not_reconciled": 1,
            "ready": 2,
            "error": 1
          },
          "needs_action": 4,
          "worst": "error"
        },
        {
          "generated_at": "2026-09-29T15:00:00Z",
          "community": {
            "id": "00000000-0000-4000-8000-00000000000e",
            "name": "Sample Estates",
            "management_status": "active",
            "management_end_date": null
          },
          "areas": [
            {
              "key": "profile",
              "title": "Community profile",
              "status": "partial",
              "summary": "1 field missing.",
              "missing": [
                "Lot count"
              ],
              "next": "Fill them in on the community profile.",
              "source": "communities table",
              "href": "/#tab=community"
            },
            {
              "key": "properties",
              "title": "Properties and owners",
              "status": "imported_not_verified",
              "summary": "543 properties, all with a current owner.",
              "missing": [
                "Lot count not on file, so completeness can’t be checked"
              ],
              "next": "Add the lot count to the profile.",
              "source": "properties + v_current_property_owners",
              "href": "/#tab=community"
            },
            {
              "key": "ledger",
              "title": "Owner ledger conversion",
              "status": "not_imported",
              "summary": "No ledger conversion yet.",
              "missing": [
                "Owner ledger conversion"
              ],
              "next": "Stage and post the owner ledger conversion.",
              "source": "conversion_batches / conversion_runs / conversion_exceptions",
              "href": null
            },
            {
              "key": "ar",
              "title": "Receivables vs GL",
              "status": "imported_not_reconciled",
              "summary": "$24,058.30 owed by owners. Compared with the GL once the ledger conversion is posted. Latest owner-ledger import as of 2026-08-27.",
              "missing": [
                "Posted ledger conversion"
              ],
              "next": "Post the owner ledger conversion first.",
              "source": "lib/ar/ar_control.js (v_homeowner_current_balance vs GL 1300 + 2400)",
              "href": "/admin/accounting?community_id=00000000-0000-4000-8000-00000000000e&view=ar"
            },
            {
              "key": "gl",
              "title": "General ledger",
              "status": "imported_not_verified",
              "summary": "Cut over 2026-08-01; 301 journal entries; trial balance balances.",
              "missing": [
                "The tie-out to Vantaca’s ending balances isn’t stored"
              ],
              "next": null,
              "source": "chart_of_accounts, journal_entries, v_trial_balance",
              "href": "/admin/accounting?community_id=00000000-0000-4000-8000-00000000000e&view=trial"
            },
            {
              "key": "budget",
              "title": "Budget",
              "status": "ready",
              "summary": "2026 budget approved (37 lines).",
              "missing": [],
              "next": null,
              "source": "community_budgets + budget_line_items",
              "href": "/admin/accounting?community_id=00000000-0000-4000-8000-00000000000e&view=budget"
            },
            {
              "key": "bank",
              "title": "Bank reconciliation",
              "status": "ready",
              "summary": "All 1 account reconciled at $0.00 difference, through 2026-08-31.",
              "missing": [],
              "next": null,
              "source": "bank_accounts + latest bank_reconciliations",
              "href": "/admin/accounting?community_id=00000000-0000-4000-8000-00000000000e&view=bankrec"
            },
            {
              "key": "violations",
              "title": "Violations history",
              "status": "imported_not_verified",
              "summary": "142 violations imported from Vantaca; 831 in total.",
              "missing": [
                "Vantaca imports keep no batch record, so completeness can’t be checked"
              ],
              "next": null,
              "source": "violations (source = 'vantaca_import')",
              "href": "/#tab=inspect"
            },
            {
              "key": "vendors",
              "title": "Vendors",
              "status": "imported_not_verified",
              "summary": "10 vendor accounts linked.",
              "missing": [
                "No Vantaca vendor list to compare against"
              ],
              "next": null,
              "source": "vendor_community_accounts",
              "href": "/#tab=vendors"
            },
            {
              "key": "documents",
              "title": "Documents",
              "status": "imported_not_verified",
              "summary": "1 current document; every required resale category present and indexed.",
              "missing": [
                "No Vantaca document list to compare against"
              ],
              "next": null,
              "source": "library_documents + document_categories.required_for_resale",
              "href": "/#tab=docs"
            },
            {
              "key": "board",
              "title": "Board and contacts",
              "status": "imported_not_verified",
              "summary": "3 active board members; 11 community contacts.",
              "missing": [
                "Nothing to check the roster against"
              ],
              "next": null,
              "source": "board_members (active) + community_contacts",
              "href": "/#tab=roster"
            },
            {
              "key": "insurance",
              "title": "Insurance",
              "status": "ready",
              "summary": "1 current policy; next expiry 2027-03-01.",
              "missing": [],
              "next": null,
              "source": "insurance_policies",
              "href": "/#tab=community"
            }
          ],
          "counts": {
            "not_applicable": 0,
            "not_imported": 1,
            "in_progress": 0,
            "partial": 1,
            "imported_not_verified": 6,
            "imported_not_reconciled": 1,
            "ready": 3,
            "error": 0
          },
          "needs_action": 3,
          "worst": "partial"
        },
        {
          "generated_at": "2026-09-29T15:00:00Z",
          "community": {
            "id": "00000000-0000-4000-8000-00000000000d",
            "name": "Sample Leaving HOA",
            "management_status": "terminating",
            "management_end_date": "2026-09-30"
          },
          "areas": [
            {
              "key": "profile",
              "title": "Community profile",
              "status": "not_applicable",
              "summary": "Leaving Bedrock (last day 2026-09-30): not being imported. Existing records stay as they are.",
              "missing": [],
              "next": null,
              "source": "communities lifecycle",
              "href": null
            },
            {
              "key": "properties",
              "title": "Properties and owners",
              "status": "not_applicable",
              "summary": "Leaving Bedrock (last day 2026-09-30): not being imported. Existing records stay as they are.",
              "missing": [],
              "next": null,
              "source": "communities lifecycle",
              "href": null
            },
            {
              "key": "ledger",
              "title": "Owner ledger conversion",
              "status": "not_applicable",
              "summary": "Leaving Bedrock (last day 2026-09-30): not being imported. Existing records stay as they are.",
              "missing": [],
              "next": null,
              "source": "communities lifecycle",
              "href": null
            },
            {
              "key": "ar",
              "title": "Receivables vs GL",
              "status": "not_applicable",
              "summary": "Leaving Bedrock (last day 2026-09-30): not being imported. Existing records stay as they are.",
              "missing": [],
              "next": null,
              "source": "communities lifecycle",
              "href": null
            },
            {
              "key": "gl",
              "title": "General ledger",
              "status": "not_applicable",
              "summary": "Leaving Bedrock (last day 2026-09-30): not being imported. Existing records stay as they are.",
              "missing": [],
              "next": null,
              "source": "communities lifecycle",
              "href": null
            },
            {
              "key": "budget",
              "title": "Budget",
              "status": "not_applicable",
              "summary": "Leaving Bedrock (last day 2026-09-30): not being imported. Existing records stay as they are.",
              "missing": [],
              "next": null,
              "source": "communities lifecycle",
              "href": null
            },
            {
              "key": "bank",
              "title": "Bank reconciliation",
              "status": "not_applicable",
              "summary": "Leaving Bedrock (last day 2026-09-30): not being imported. Existing records stay as they are.",
              "missing": [],
              "next": null,
              "source": "communities lifecycle",
              "href": null
            },
            {
              "key": "violations",
              "title": "Violations history",
              "status": "not_applicable",
              "summary": "Leaving Bedrock (last day 2026-09-30): not being imported. Existing records stay as they are.",
              "missing": [],
              "next": null,
              "source": "communities lifecycle",
              "href": null
            },
            {
              "key": "vendors",
              "title": "Vendors",
              "status": "not_applicable",
              "summary": "Leaving Bedrock (last day 2026-09-30): not being imported. Existing records stay as they are.",
              "missing": [],
              "next": null,
              "source": "communities lifecycle",
              "href": null
            },
            {
              "key": "documents",
              "title": "Documents",
              "status": "not_applicable",
              "summary": "Leaving Bedrock (last day 2026-09-30): not being imported. Existing records stay as they are.",
              "missing": [],
              "next": null,
              "source": "communities lifecycle",
              "href": null
            },
            {
              "key": "board",
              "title": "Board and contacts",
              "status": "not_applicable",
              "summary": "Leaving Bedrock (last day 2026-09-30): not being imported. Existing records stay as they are.",
              "missing": [],
              "next": null,
              "source": "communities lifecycle",
              "href": null
            },
            {
              "key": "insurance",
              "title": "Insurance",
              "status": "not_applicable",
              "summary": "Leaving Bedrock (last day 2026-09-30): not being imported. Existing records stay as they are.",
              "missing": [],
              "next": null,
              "source": "communities lifecycle",
              "href": null
            }
          ],
          "counts": {
            "not_applicable": 12,
            "not_imported": 0,
            "in_progress": 0,
            "partial": 0,
            "imported_not_verified": 0,
            "imported_not_reconciled": 0,
            "ready": 0,
            "error": 0
          },
          "needs_action": 0,
          "worst": "not_applicable"
        }
      ]
    }
  },
  "/api/ap/ed-queue": {
    "ok": true,
    "data": {
      "count": 2,
      "total_cents": 486512,
      "invoices": [
        {
          "id": "i1",
          "community": "Drama Creek (sample)",
          "vendor": "Sample Pool Co",
          "total_cents": 482940
        },
        {
          "id": "i2",
          "community": "Drama Creek (sample)",
          "vendor": "Sample board member reimbursement",
          "total_cents": 3572
        }
      ],
      "cash": [
        {
          "community_id": "00000000-0000-4000-8000-00000000000a",
          "community": "Drama Creek (sample)",
          "count": 2,
          "pending_cents": 486512,
          "operating_cash_cents": 1250000,
          "covered": true
        }
      ]
    }
  },
  "/api/ap/manager-queue": {
    "ok": true,
    "data": {
      "ok": true,
      "count": 3,
      "invoices": [
        {
          "id": "m1",
          "community": "Sample Ridge",
          "total_cents": 118000
        },
        {
          "id": "m2",
          "community": "Sample Estates",
          "total_cents": 64500
        },
        {
          "id": "m3",
          "community": "Sample Ridge",
          "total_cents": 22150
        }
      ]
    }
  },
  "/api/ap-intake/exceptions": {
    "ok": true,
    "data": {
      "ok": true,
      "exceptions": [
        {
          "id": "e1",
          "created_at": "2026-09-24T14:00:00Z"
        }
      ]
    }
  }
};
