<!--
==================================================================
LAWN 10-DAY CERTIFIED FORCE-MOW NOTICE — GOLD STANDARD TEMPLATE
==================================================================
Hybrid of Eaglewood structure (cleaner legal framing) + Waterview
elements (admin fee, observation date, friendly closing).

LOCKED TEMPLATE. Do not modify without attorney review. Statutory
language (§209.006, §209.007, §209.006(b)(1), Servicemembers Civil
Relief Act) injects from GLOBAL_RULES at render time — never edited
in this file.

REMEDY MODES (renderer `remedy_mode`, default 'lawn'):
  This same letter serves two self-help remedies under the SAME
  Declaration self-help authority and the SAME §209 scaffolding. Only
  the remedy-DESCRIPTION lines change (Re: line, intent-to-enter action,
  Violation description, SERVICES line, reserve sentence) — see
  REMEDY_COPY in lib/lawn_force_mow_renderer.js. Every statutory
  paragraph is identical.
    - 'lawn'    — force-mow / yard maintenance (the body shown below).
    - 'cleanup' — general lot cleanup / abatement of trash, debris, and
      unsightly materials. Cleanup-mode descriptive wording is NEW and
      should get the same attorney glance the lawn wording received; the
      §209 scaffolding is unchanged and already reviewed.

Per CLAUDE.md catastrophic-output discipline:
  - Schema:   templates/lawn-force-mow-letter.schema.json
  - Renderer: lib/lawn_force_mow_renderer.js
  - GLOBAL_RULES tags: [tx_209_hearing_rights_conditional],
    [tx_209_admin_fee_disclosure], [tx_force_mow_civil_damages],
    [servicemembers_relief_act]

VARIABLES (validated by schema):
  {{community_legal_name}}        — e.g. "Eaglewood Homeowners' Association, Inc."
  {{community_short_name}}        — e.g. "Eaglewood"
  {{letterhead_block}}            — Bedrock contact block (rendered separately by renderer)
  {{letter_date}}                 — YYYY-MM-DD; renderer formats as "April 28, 2026"
  {{certified_mail_number}}       — USPS tracking number (operator enters before mailing)
  {{homeowner_names_block}}       — Multi-line owner names + mailing address
  {{property_address_full}}       — "12345 Bryce Canyon Drive, Richmond, TX 77407"
  {{property_address_short}}      — "12345 Bryce Canyon Drive"
  {{alt_mailing_address_block}}   — Optional, only when owner mailing ≠ property address
  {{declaration_doc_number}}      — e.g. "1999106014"
  {{declaration_county}}          — e.g. "Fort Bend"
  {{declaration_section_full}}    — e.g. "Article 6.16 of the Declaration"
  {{observation_date}}            — Date the violation was observed (from inspection)
  {{observed_condition}}          — Free-text from operator (e.g. "Lawn in need of mowing, edging, and weed control")
  {{admin_fee_amount}}            — e.g. "$25.00"
  {{include_hearing_rights}}      — Boolean — if TRUE, the §209.006-007 paragraph appears
-->

# NOTICE OF INTENT TO ENTER PROPERTY AND NOTICE OF VIOLATION

**VIA CERTIFIED MAIL, RETURN RECEIPT REQUESTED AND FIRST CLASS MAIL**
Certified Mail No.: {{certified_mail_number}}

{{letter_date_formatted}}

{{homeowner_names_block}}

{{alt_mailing_address_block}}

**Re:** Notice of Violation and Intent to Enter Property to Maintain the Yard
**Property:** {{property_address_full}} (the "Property")
**Community:** {{community_legal_name}} (the "Association")
**Declaration:** Declaration of Covenants, Conditions, and Restrictions for {{community_short_name}}, recorded as Document No. {{declaration_doc_number}}, Official Public Records of {{declaration_county}} County, Texas (the "Declaration")

Dear Homeowner:

The Association provides this letter as the formal notice of intent to enter the Property to provide mowing services and as your notice of violation of restrictive covenants. Please be advised that, on {{observation_date_formatted}}, it was observed that conditions on the Property constitute violations of the terms and provisions of the Declaration. The Property is subject to and encumbered by the Declaration.

**Violation:** {{declaration_section_full}} — Failure to keep the Lot in good condition, including the failure to mow the lawn.

**Observed condition:** {{observed_condition}}

You are entitled to a reasonable period to cure the Violation. The Association requests that you bring the Property into compliance with the Declaration and cure the Violation **within ten (10) days of the date of this letter**.

This letter is further provided as formal written notice that the Association intends to exercise its right of self-help to enter the Property under {{declaration_section_full}} and hire a contractor to bring the Property into compliance. The expense associated therewith will constitute an Assessment in accordance with the Declaration, **and the Association reserves the right to continue to provide such self-help maintenance on a regular schedule without further notice if this violation continues.**

---

**CONTRACTOR:** ________________________
**SERVICES:** Mowing and Yard Maintenance
**DATE AND TIME OF SERVICE** [No earlier than 10 days from date of letter]: _____________________________
**COST:** _____________________________

---

[GLOBAL_RULES.tx_force_mow_civil_damages]

We sincerely solicit your cooperation and thank you for your compliance so that we do not have to pursue a lawsuit against you.

[IF include_hearing_rights]
[GLOBAL_RULES.tx_209_hearing_rights_conditional]
[ENDIF]

[GLOBAL_RULES.tx_209_admin_fee_disclosure | admin_fee_amount={{admin_fee_amount}}]

If the violation has already been corrected or there are any extenuating circumstances, please contact {{community_legal_name}} c/o Bedrock Association Management, LLC at (832) 588-2485 or email us at info@bedrocktx.com.

Your immediate attention to this matter is required. This notice is not intended to advise you of your legal rights or obligations. You should consult an attorney of your choice to protect your interests. Please let us know immediately if you have or will retain the services of legal counsel in this matter.

[GLOBAL_RULES.servicemembers_relief_act]

Sincerely,

{{community_legal_name}}
Board of Directors
c/o Bedrock Association Management, LLC
