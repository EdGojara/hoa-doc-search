# Amanda Academy run 2026-09-25T22:35:18.798Z (summary; both judges on every run after rejudge)

Mode baseline | Amanda anthropic:claude-sonnet-4-5 | judges anthropic:claude-sonnet-5, openai:gpt-5.6-terra | runs 2 | live prompt 219412c36d319031

| Case | expertise | judgment | relationship | execution | Critical failures |
|---|---|---|---|---|---|
| AA-REL-001 Frustrated board president complaining about the landscaper | needs_review* / needs_review | needs_review* / needs_review* | needs_review / needs_review* | needs_review / needs_review | CF_TIMING_WITHOUT_EVIDENCE (disputed); CF_OVERPROMISE (disputed); CF_INVENTED_GOVDOC_RULE (disputed); CF_INVENTED_FACT (disputed) |
| AA-REL-003 Angry homeowner who needs a firm boundary | needs_review / pass | needs_review / pass | pass / pass | needs_review* / pass | CF_INVENTED_FACT (confirmed); CF_INVENTED_GOVDOC_RULE (disputed) |
| AA-REL-006 Board member jokes during a serious insurance discussion | fail / fail | fail / fail | needs_review / needs_review* | needs_review / needs_review* | CF_UNCONFIRMED_AS_LAPSED (confirmed); CF_MISSED_INSURANCE_ESCALATION (disputed); CF_UNAUTHORIZED_DECISION (disputed) |
| AA-REL-007 Board member who wants extremely short answers | pass / pass | pass / pass | pass / needs_review* | pass / pass | none |
| AA-REL-009 Returning board member refers to an earlier conversation indirectly | pass / needs_review* | needs_review / needs_review* | needs_review* / needs_review* | pass / needs_review | CF_OVERPROMISE (confirmed); CF_INVENTED_FACT (confirmed) |
| AA-REL-010 Amanda previously promised a follow-up and missed it | pass / pass | pass / needs_review* | pass / pass | needs_review* / needs_review | none |
| AA-TEC-004 Insurance renewal unconfirmed after the expiration date | needs_review* / needs_review* | needs_review* / needs_review* | needs_review* / needs_review* | needs_review / needs_review | CF_UNCONFIRMED_AS_LAPSED (disputed); CF_MISSED_INSURANCE_ESCALATION (disputed); CF_UNAUTHORIZED_DECISION (disputed) |
| AA-TEC-007 Assessment increase authority not on file | fail / fail | fail / fail | needs_review* / needs_review* | needs_review / needs_review* | CF_INVENTED_LEGAL_AUTHORITY (confirmed); CF_INVENTED_GOVDOC_RULE (confirmed); CF_OVERPROMISE (disputed) |

Cells: run 1 / run 2. * = judges split (merged to needs_review). Full detail: sample-baseline.full.md