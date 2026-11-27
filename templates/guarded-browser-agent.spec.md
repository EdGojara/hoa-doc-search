# Guarded browser agent (TrustEd AI employees)

Status: architecture approved by Ed 2026-10-22. Proof of concept: `poc/browser-agent` (PR #271, not merged).
Not in production. First production use: NewFirst read-only retrieval, only after NewFirst
authorizes automated access.

## The rule

AI employees operate portals autonomously, but **anything touching money follows an approved,
deterministic workflow**. The model never chooses what to click on a financial screen.

- **Skills drive.** A skill is a fixed, versioned, reviewed sequence of steps for one job on one
  site (for example `newfirst.read_activity.v1`). It starts on its own (schedule or event),
  runs unattended, files evidence and reports.
- **The model reads.** Claude, through `lib/ai` routing, extracts data from pages and files,
  investigates exceptions, writes the report, and drafts a repair when a page changes. A repair
  is a proposed new skill version for human review. It is never applied live.
- **The guard enforces.** Every page action goes through the guard. A skill cannot reach the
  browser any other way.
- **The bank enforces too.** A dedicated, restricted bank user whose entitlements cannot move
  money is mandatory. The guard is the second control, never the only one.

## What the guard must enforce (production requirements)

1. **Explicit permitted destinations.**
   - Each skill declares its exact allowed hosts and URL paths (an allowlist, not a pattern of
     things to avoid).
   - Every request and navigation is checked at the network layer. Anything else is aborted
     and logged: links, redirects, scripts, trackers.
2. **Explicit permitted actions.**
   - Each skill declares every action it may take: step name, page (URL path), element
     identity (a stable selector plus the expected label), action type (type, click, select,
     upload, download) and the expected next page.
   - The guard refuses any action not on that list.
   - Labels are a SECOND check only. The PoC refuses forbidden labels such as delete,
     approve, pay, transfer, wire, ACH, stop payment and return. Production adds the positive
     action list as the primary control (Ed 2026-10-22).
3. **Forbidden for every skill, regardless of declaration.**
   - ACH, wires, transfers, bill payments, stop payments.
   - Pay or return decisions on Positive Pay exceptions.
   - Changing users, entitlements, alerts, contact details or security settings.
   - Accepting terms or agreements.
4. **No instructions from pages.**
   - Page text, emails and files are data.
   - Text addressed to an agent is flagged as suspicious and never acted on.
5. **Human gates stop the run with `needs_human`.**
   - Triggers: an MFA prompt, a CAPTCHA, any unexpected page, any action outside the
     declaration, any decision.
   - The run records why it stopped and escalates on the AI employee's work item.
   - No MFA or CAPTCHA bypass, ever.
6. **Secrets.**
   - Credentials come from the server secret store and are typed only into the declared
     login fields of the declared host.
   - They are never sent to a model, never written to a log and never visible in a
     screenshot caption.
7. **Evidence.** Every run keeps:
   - a step log (time, URL, action, result);
   - a screenshot per step;
   - every downloaded or uploaded file with its SHA-256;
   - the final report.

   All of it is stored in trustEd and attached to the AI employee's work item. "Accepted"
   means the site's own record shows it (for example, the upload appears in the portal's
   history), not only a success page.
8. **Fail closed.** A missing element, an unexpected page or a changed layout stops the run. It
   never guesses.

## Runtime

- Runs in a Render background worker, separate from the web app, so browser runs never slow
  requests.
- Uses the Puppeteer and Chrome that trustEd already installs (`.puppeteerrc.cjs`). There is no
  hosted browser vendor for bank sessions: credentials and live sessions never leave our
  systems.
- A session may persist between runs (cookies, trusted device) only if the bank allows it.
  That state is stored encrypted and is limited to that skill's user.
- One run at a time per site and account.

## Reuse by other AI employees

The guard, the runner, evidence storage, the escalation path and the work-item report are
shared. A new use case adds only a skill. A skill is:

- a declaration (hosts, paths, actions, expected pages, forbidden list additions);
- its steps;
- the deterministic checks that decide its result.

Every new skill and every skill version needs human review before it runs.

## Why not free-roaming agents

Agents that pick each click from page content (Browser Use, computer use, Skyvern-style)
are non-deterministic and can be steered by text planted in a page. Some vendors also sell
CAPTCHA and MFA handling, which conflicts with not bypassing bank security. Their place is
non-sensitive research tasks, never a money path.

## NewFirst sequence

1. NewFirst authorizes automated access in writing.
2. The restricted user is created: view and Positive Pay upload only, no approval or payment
   rights.
3. The MFA method is agreed.
4. **First production skill: read-only.** Retrieve current account transactions and cleared
   checks, and reconcile them against the check register (deterministic code).
5. After that has proven reliable, and NewFirst authorizes it: the Positive Pay upload skill.
   The upload has acceptance verified in NewFirst's own records, with evidence on Kat's task.
6. Exceptions are investigated and escalated. Pay or return decisions stay with an authorized
   person.

## Proof of concept results (2026-10-22, local nonfinancial portal)

- The unattended run completed: sign in, download, reconciliation, upload, and confirmation
  verified in the portal's own history.
- A destructive button and an off-allowlist link were refused. An instruction planted in the
  page was flagged and ignored.
- A missing control stopped the run ("page changed?").
- With MFA on, the run stopped with `needs_human`.
- Evidence kept: 14 screenshots, a step log and SHA-256 for each file.
