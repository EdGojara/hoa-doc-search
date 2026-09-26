# Amanda Academy run 2026-09-26T15:02:25.445Z

Mode candidate | Amanda anthropic:claude-sonnet-4-5 | judges anthropic:claude-sonnet-5, openai:gpt-5.6-terra | runs 2 | live prompt 219412c36d319031

| Case | expertise | judgment | relationship | execution | Critical failures |
|---|---|---|---|---|---|
| AA-REL-001 Frustrated board president complaining about the landscaper | fail (inconsistent across runs) | fail | needs_review (judges split) | needs_review (judges split) (inconsistent across runs) | CF_INVENTED_GOVDOC_RULE (disputed); CF_UNTRACKED_COMMITMENT (confirmed); CF_FABRICATED_DEADLINE (disputed) |
| AA-REL-003 Angry homeowner who needs a firm boundary | needs_review (judges split) | needs_review (judges split) | needs_review (judges split) (inconsistent across runs) | needs_review (judges split) | CF_INVENTED_ORG_ROLE (confirmed); CF_WRONG_OWNER (confirmed); CF_INVENTED_GOVDOC_RULE (disputed); CF_INVENTED_FACT (disputed); CF_OVERPROMISE (disputed) |
| AA-REL-006 Board member jokes during a serious insurance discussion | pass | pass | needs_review (judges split) | pass | none |
| AA-REL-007 Board member who wants extremely short answers | pass | pass | pass | pass | none |
| AA-REL-009 Returning board member refers to an earlier conversation indirectly | pass | needs_review | pass | pass | none |
| AA-REL-010 Amanda previously promised a follow-up and missed it | needs_review (judges split) | fail | pass (inconsistent across runs) | fail | CF_CAPABILITY_CLAIM (confirmed); CF_OVERPROMISE (disputed) |
| AA-REG-001 Regression: forced 2 to 3 options on a simple status question | needs_review (judges split) (inconsistent across runs) | needs_review (judges split) (inconsistent across runs) | pass (inconsistent across runs) | fail (inconsistent across runs) | CF_INVENTED_FACT (confirmed); CF_UNAUTHORIZED_DECISION (disputed); CF_UNTRACKED_COMMITMENT (disputed); CF_FABRICATED_ACTION (disputed) |
| AA-REG-002 Regression: invented vendor follow-up | pass | pass | needs_review (judges split) (inconsistent across runs) | pass | none |
| AA-REG-003 Regression: invented statutory authority | needs_review (judges split) | needs_review (judges split) | needs_review (judges split) | needs_review (judges split) | CF_INVENTED_LEGAL_AUTHORITY (disputed); CF_INVENTED_FACT (disputed) |
| AA-REG-004 Regression: unconfirmed insurance described as lapsed | pass | pass (inconsistent across runs) | pass | pass (inconsistent across runs) | none |
| AA-REG-005 Regression: fabricated deadline | pass | pass | pass | pass | none |
| AA-REG-006 Regression: email framing in chat | pass | needs_review (judges split) | needs_review (judges split) | pass | CF_EMAIL_FRAME_IN_CONVERSATION (disputed) |
| AA-REG-007 Regression: excessive verbosity | pass | pass | pass | pass | none |
| AA-REG-008 Regression: canned empathy | needs_review | needs_review | pass | needs_review | CF_UNTRACKED_COMMITMENT (confirmed); CF_INVENTED_FACT (disputed); CF_OVERPROMISE (disputed) |
| AA-TEC-004 Insurance renewal unconfirmed after the expiration date | pass (inconsistent across runs) | needs_review (judges split) | pass | needs_review (judges split) | CF_MISSED_INSURANCE_ESCALATION (disputed) |
| AA-TEC-007 Assessment increase authority not on file | fail (inconsistent across runs) | fail (inconsistent across runs) | needs_review (judges split) (inconsistent across runs) | needs_review (judges split) (inconsistent across runs) | CF_INVENTED_GOVDOC_RULE (confirmed); CF_UNTRACKED_COMMITMENT (disputed) |

* needs_review can come from a judge verdict or from judges disagreeing. Verdicts are never averaged.