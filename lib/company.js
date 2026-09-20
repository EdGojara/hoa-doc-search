// ============================================================================
// lib/company.js  (2026-09-20)
// ----------------------------------------------------------------------------
// The ONE authoritative definition of the Bedrock management company's identity.
//
// trustEd runs a single management company today — Bedrock Association Management
// — and its id was re-typed as a literal in 70+ modules. This file records that
// fact in exactly one place so the value cannot drift and there is a single
// point to change.
//
// This is DELIBERATELY NOT a tenant-resolution layer. We do not resolve identity
// from request/auth context, and importing this constant is not "multi-tenant".
// When (if) the platform becomes multi-tenant, the fix is to replace imports of
// this constant with a context-derived id — this file is the seam that makes
// that future change local instead of a 70-file sweep. (Ed 2026-09-20: consolidate
// the existing value; do not implement multi-tenancy.)
// ============================================================================
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

// The dedicated DEMO management company (tenant). Demo organizations (Demo HOA,
// Demo LMA) belong here, NOT to Bedrock, so every `management_company_id = BEDROCK`
// portfolio query, job, metric and the retrieval substrate exclude demo by
// construction. Identity (portal_users) stays in the shared auth structure and is
// isolated separately by the demo-sign-in gate + is_demo (Ed 2026-09-20, Option A).
// This is an ORGANIZATION/OPERATIONAL tenant boundary, not a multi-tenant-auth layer.
const DEMO_MGMT_CO_ID = 'd0000000-0000-4000-a000-000000000000';

module.exports = { BEDROCK_MGMT_CO_ID, DEMO_MGMT_CO_ID };
