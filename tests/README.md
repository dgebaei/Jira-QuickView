# Test Automation Guide

This folder contains the Playwright automation setup for Jira HotLinker.

## What Lives Here

- `tests/e2e/` - Playwright specs and helpers
- `tests/.auth/` - local-only authenticated session files for private Jira testing
- `tests/output/` - generated reports, traces, screenshots, and run artifacts

Both `tests/.auth/` and `tests/output/` are ignored by git.

## Test Modes

### Mock edge tests

These deterministic tests focus on failure injection and unhappy-path coverage. They use:

- the unpacked Chromium extension
- local fixture pages
- a mocked Jira backend by default

You can switch these extension suites to a real Jira Cloud backend with `MOCK=false`.

Run them with:

```bash
npm run test:e2e:mock-edge
```

### Public Jira smoke tests

These are lightweight anonymous checks against Atlassian's public Jira pages.

Run them with:

```bash
npm run test:e2e:public-smoke
```

### Live authenticated tests

These run the extension against your Jira Cloud tenant with an authenticated storage state. They cover the main happy-path extension flows plus the guarded live mutation flows.

Run them with:

```bash
export MOCK=false
export JIRA_LIVE_INSTANCE_URL="https://dgebaei.atlassian.net/jira/software/projects/JIRA/boards/1"
export JIRA_LIVE_PROJECT_KEYS="JIRA"
export JIRA_LIVE_ISSUE_KEYS="JIRA-1,JIRA-2"
export JIRA_LIVE_STORAGE_STATE="tests/.auth/jira-live.json"
npm run test:e2e:live-authenticated
```

Backward-compatible aliases:

- `npm run test:e2e:extension` -> `npm run test:e2e:live-authenticated`
- `npm run test:e2e:public` -> `npm run test:e2e:public-smoke`
- `npm run test:e2e:live` -> `npm run test:e2e:live-authenticated`

Repo-local defaults can be stored in `.env.playwright.local`. This worktree now loads that file automatically for Playwright config and scripts, so `npm run test:e2e:all` can pick up your Jira Cloud settings without re-exporting them each time.

### Private Jira live configuration

These authenticated suites are opt-in and only run when all required environment variables are configured.

Required environment variables:

```bash
export JIRA_LIVE_INSTANCE_URL="https://yourcompany.atlassian.net"
export JIRA_LIVE_PROJECT_KEYS="E2E,QA"
export JIRA_LIVE_ISSUE_KEYS="E2E-101,E2E-102"
export JIRA_LIVE_STORAGE_STATE="tests/.auth/jira-live.json"
```

`JIRA_LIVE_INSTANCE_URL` may be either the Jira site root or a deeper Jira URL such as a board, project, or issue page. The live helpers normalize it to the site origin before opening `/browse/<issueKey>` pages.

Current live coverage includes:

- scope guard validation
- authenticated popup smoke checks
- edit-control and quick-action surface checks
- priority mutation with restoration
- assignee mutation with restoration
- temporary label mutation with cleanup
- deterministic live preparation for required attachment, label, and priority data

## Private Jira Safety Scope

The live suite intentionally refuses to run outside the allowed scope.

Rules:

- `JIRA_LIVE_ISSUE_KEYS` is the exact allowlist of issues the tests may touch
- each issue key must belong to a project listed in `JIRA_LIVE_PROJECT_KEYS`
- if that configuration is missing, the live suite skips instead of guessing

Example:

```bash
export JIRA_LIVE_INSTANCE_URL="https://yourcompany.atlassian.net"
export JIRA_LIVE_PROJECT_KEYS="E2E,QA"
export JIRA_LIVE_ISSUE_KEYS="E2E-101,E2E-102"
```

Jira Cloud example using your tenant:

```bash
export JIRA_LIVE_INSTANCE_URL="https://dgebaei.atlassian.net/jira/software/projects/JIRA/boards/1"
export JIRA_LIVE_PROJECT_KEYS="JIRA"
export JIRA_LIVE_ISSUE_KEYS="JIRA-1,JIRA-2"
export JIRA_LIVE_STORAGE_STATE="tests/.auth/jira-live.json"
```

That means live tests may target `E2E-101` and `E2E-102`, but not any other issue.

For mutation tests, use only issues that are safe to edit and safe to restore.

## Auth Storage State

Private Jira tests reuse a Playwright storage-state file so they do not need to automate login every time.

What the storage-state file contains:

- session cookies
- relevant local storage for logged-in browser state

What that means:

- it is sensitive
- it should be treated like a session secret
- it should only be created with a dedicated low-privilege Jira test account

Recommended location:

```bash
tests/.auth/jira-live.json
```

### Capture a new authenticated session

1. Set your Jira instance URL.
2. Run the auth capture script.
3. Log in in the opened browser window.
4. Return to the terminal and press Enter.

Command:

```bash
export JIRA_LIVE_INSTANCE_URL="https://yourcompany.atlassian.net"
npm run test:e2e:auth:live
```

For Jira Cloud, you can also point it at a board URL if that is the easiest place to log in first:

```bash
export JIRA_LIVE_INSTANCE_URL="https://dgebaei.atlassian.net/jira/software/projects/JIRA/boards/1"
export JIRA_LIVE_STORAGE_STATE="tests/.auth/jira-live.json"
npm run test:e2e:auth:live
```

If you want a custom path:

```bash
export JIRA_LIVE_INSTANCE_URL="https://yourcompany.atlassian.net"
export JIRA_LIVE_STORAGE_STATE="tests/.auth/jira-live.json"
npm run test:e2e:auth:live
```

## Reports And Artifacts

All generated Playwright output now lives under `tests/output/playwright/`.

Important paths:

- run explorer: `tests/output/playwright/index.html`
- merged HTML report: `tests/output/playwright/report/index.html`
- per-run HTML reports: `tests/output/playwright/runs/<run-id>/index.html`
- accumulated blob reports: `tests/output/playwright/blob-report`
- run artifacts: `tests/output/playwright/test-results`

Open the merged report with:

```bash
npm run test:e2e:show-report
```

The run explorer includes a summary view plus a sidebar of saved runs. The merged HTML report remains cumulative because each environment writes a blob report and the summary is rebuilt from all saved blobs.

If you want a clean report before the next run:

```bash
npm run test:e2e:reset-report-data
```

## Useful Commands

Run the default suite:

```bash
npm test
```

Run everything configured by Playwright:

```bash
npm run test:e2e:all
```

Project lanes in Playwright are now:

- `mock-edge`
- `public-smoke`
- `live-authenticated`

`npm run test:e2e:all` now runs those three lanes sequentially so each one gets the correct default environment.

Run the extension suite in headed mode:

```bash
npm run test:e2e:headed
```

Open Playwright UI mode:

```bash
npm run test:e2e:ui
```

Merge reports again without rerunning tests:

```bash
npm run test:e2e:merge-report
```

Reset saved reports and artifacts:

```bash
npm run test:e2e:reset-report-data
```

## CI

GitHub Actions now runs separate Playwright lanes:

Workflow:

- `.github/workflows/playwright-extension.yml`

CI behavior:

- pull requests: `mock-edge` and `public-smoke`
- scheduled runs and manual dispatch: `live-authenticated` when Jira secrets are configured
- pushes to `master`: `mock-edge`, `public-smoke`, and `live-authenticated` when Jira secrets are configured

Required GitHub Actions secrets for `live-authenticated`:

- `JIRA_LIVE_INSTANCE_URL`
- `JIRA_LIVE_PROJECT_KEYS`
- `JIRA_LIVE_ISSUE_KEYS`
- `JIRA_LIVE_STORAGE_STATE_JSON`

`JIRA_LIVE_STORAGE_STATE_JSON` should contain the full JSON contents of `tests/.auth/jira-live.json` for your dedicated Jira test account.

Uploaded CI artifacts include:

- merged HTML report data
- blob reports
- failure traces, screenshots, and videos when present

## Current Coverage Areas

The suite currently covers:

- options page validation and persistence
- activation on allowed pages only
- hover depth and modifier behavior
- popup rendering for issue data, comments, attachments, PRs, and custom fields
- quick actions and several inline editors in mocked mode
- anonymous, unauthorized, and unreachable Jira scenarios
- public Jira smoke checks
- live Jira scope-gated smoke and guarded mutation checks

## Current Known Gap

One remaining area is intentionally not in the passing suite yet:

- pasted-image upload flows in Playwright

The extension supports them, and the mocked backend supports the scenarios, but stable clipboard-image simulation inside this extension context still needs a more reliable approach before those tests should be considered trustworthy.

## Recommended Practices

- use a dedicated Jira test account for `tests/.auth/jira-live.json`
- keep live test issues restricted to explicit safe issue keys
- reset report data before producing a clean report for review
- prefer mocked tests for broad feature coverage and live tests for smoke validation
