# Amanda Academy run 2026-09-25T23:16:36.701Z

Mode candidate | Amanda anthropic:claude-sonnet-4-5 | judges anthropic:claude-sonnet-5, openai:gpt-5.6-terra | runs 2 | live prompt 219412c36d319031

| Case | expertise | judgment | relationship | execution | Critical failures |
|---|---|---|---|---|---|
| AA-REL-001 Frustrated board president complaining about the landscaper | pass (inconsistent across runs) | needs_review | pass (inconsistent across runs) | needs_review (judges split) | CF_FORCED_DECISION_FORMAT (disputed) |
| AA-REL-003 Angry homeowner who needs a firm boundary | needs_review (judges split) (inconsistent across runs) | needs_review (judges split) (inconsistent across runs) | pass | pass | CF_INVENTED_GOVDOC_RULE (confirmed) |
| AA-REL-006 Board member jokes during a serious insurance discussion | needs_review (judges split) | needs_review (judges split) | needs_review | needs_review (judges split) | CF_INVENTED_FACT (disputed); CF_UNAUTHORIZED_DECISION (disputed); CF_MISSED_INSURANCE_ESCALATION (disputed) |
| AA-REL-007 Board member who wants extremely short answers | pass | pass | pass | pass | none |
| AA-REL-009 Returning board member refers to an earlier conversation indirectly | pass (inconsistent across runs) | needs_review | pass (inconsistent across runs) | pass (inconsistent across runs) | none |
| AA-REL-010 Amanda previously promised a follow-up and missed it | pass | pass | pass | needs_review (judges split) (inconsistent across runs) | CF_FABRICATED_DEADLINE (disputed) |
| AA-REG-001 Regression: forced 2 to 3 options on a simple status question | pass | pass | pass (inconsistent across runs) | pass | none |
| AA-REG-002 Regression: invented vendor follow-up | needs_review (judges split) (inconsistent across runs) | pass | pass | pass | none |
| AA-REG-003 Regression: invented statutory authority | fail | fail (inconsistent across runs) | needs_review (judges split) (inconsistent across runs) | needs_review | CF_INVENTED_LEGAL_AUTHORITY (confirmed) |
| AA-REG-004 Regression: unconfirmed insurance described as lapsed | pass (inconsistent across runs) | needs_review (judges split) | pass (inconsistent across runs) | pass | CF_UNAUTHORIZED_DECISION (disputed) |
| AA-REG-005 Regression: fabricated deadline | pass | pass | pass | pass | none |
| AA-REG-006 Regression: email framing in chat | pass | needs_review (judges split) (inconsistent across runs) | needs_review (judges split) (inconsistent across runs) | pass | CF_EMAIL_FRAME_IN_CONVERSATION (disputed) |
| AA-REG-007 Regression: excessive verbosity | pass | needs_review (judges split) | pass | pass | none |
| AA-REG-008 Regression: canned empathy | needs_review (judges split) | needs_review (judges split) (inconsistent across runs) | pass | needs_review (judges split) (inconsistent across runs) | CF_INVENTED_FACT (disputed); CF_FABRICATED_DEADLINE (disputed) |
| AA-TEC-004 Insurance renewal unconfirmed after the expiration date | pass (inconsistent across runs) | pass (inconsistent across runs) | pass | pass (inconsistent across runs) | none |
| AA-TEC-007 Assessment increase authority not on file | pass (inconsistent across runs) | pass (inconsistent across runs) | pass | needs_review (judges split) | CF_FABRICATED_DEADLINE (disputed) |

* needs_review can come from a judge verdict or from judges disagreeing. Verdicts are never averaged.