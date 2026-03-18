# Playwright Test Plan

## Goal

Build a reliable Playwright-based automation suite for Jira HotLinker that covers:

- extension configuration flows
- content-script activation behavior
- hover and popup interactions
- mocked Jira read and write flows
- failure modes such as unreachable Jira, unauthenticated Jira, and anonymous read-only access
- optional public Jira smoke coverage
- future private Jira coverage with real authentication

## Test Strategy

The suite uses a hybrid approach:

1. Mocked integration tests are the primary source of truth for feature coverage.
2. Public Jira tests are lightweight smoke tests only.
3. Private Jira tests remain opt-in and env-driven for later.

This keeps the suite deterministic while still allowing live verification against real Jira pages.

## Scope

### In Scope

- options page validation and persistence
- allowed-page and inactive-page behavior
- exact, shallow, and deep hover detection
- modifier-key-triggered popup behavior
- popup rendering for issue metadata, comments, attachments, pull requests, and custom fields
- popup controls such as pin, close, copy link, and image preview
- mocked edit and quick-action flows
- mocked comment and mention flows
- network/auth failure scenarios

### Out of Scope For Initial Suite

- broad cross-browser matrix beyond Chromium extension execution
- visual regression baselines
- full accessibility scanning
- true mutation tests against a private Jira instance
- every Jira field permutation in one pass

## Test Environments

### `extension`

Primary suite. Runs against:

- unpacked Chromium extension
- local fixture pages
- local mocked Jira server

### `public-jira`

Optional smoke suite. Disabled by default unless:

- `RUN_PUBLIC_JIRA_TESTS=1`

Target:

- `https://jira.atlassian.com/browse/JRACLOUD-97846`

### `live-jira`

Placeholder for future authenticated tests. Enabled later with env vars such as:

- `JIRA_LIVE_INSTANCE_URL`
- `JIRA_LIVE_PROJECT_KEYS`
- `JIRA_LIVE_ISSUE_KEYS`
- `JIRA_LIVE_STORAGE_STATE`

Current live-scope rule:

- live tests only operate on issues explicitly listed in `JIRA_LIVE_ISSUE_KEYS`
- each listed issue must also belong to a project listed in `JIRA_LIVE_PROJECT_KEYS`
- if that scope is not configured, the `live-jira` project skips entirely
- authenticated live smoke tests additionally require `JIRA_LIVE_STORAGE_STATE`

## Current Spec Inventory

### `tests/e2e/options.spec.js`

- empty Jira URL validation
- custom field ID validation and Jira metadata lookup
- persistence of hover and display settings
- optional host permission denial handling

### `tests/e2e/hover-and-popup.spec.js`

- injection only on configured domains
- exact vs shallow vs deep hover behavior
- modifier-key requirement
- pin and close behavior

### `tests/e2e/mock-jira-flows.spec.js`

- issue metadata rendering
- comments, attachments, PRs, and custom field rendering
- copy-link and image preview behavior
- mocked quick actions and inline edits
- mocked mentions and comment creation

### `tests/e2e/advanced-mock-flows.spec.js`

- assignee and parent search editor coverage
- explicit unassigned-assignee option coverage
- sprint, affects version, and fix version edit coverage
- quick-action grouping and sprint action visibility
- no-quick-actions edge case coverage
- attachment / PR display-toggle coverage

### `tests/e2e/partial-failures.spec.js`

- pull request endpoint failure tolerance
- malformed pull request payload tolerance
- label suggestion support fallback behavior
- issue-search editor failure handling
- comment save failure handling
- mention search failure handling
- comment discard flow coverage

### `tests/e2e/error-states.spec.js`

- unreachable Jira / wrong URL
- Jira 401 / not logged in
- anonymous read-only Jira behavior

### `tests/e2e/public-jira.spec.js`

- optional public Atlassian issue smoke test
- optional public Atlassian search-results smoke test

### `tests/e2e/live-jira.spec.js`

- live-scope config guard
- allowed-issue popup smoke test
- authenticated allowed-issue popup smoke test using storage state
- live edit-control and quick-action surface checks
- live priority mutation with restoration
- live assignee mutation with restoration
- live temporary-label mutation with cleanup

## Current Coverage Summary

Covered now:

- options UI core flows
- extension activation gating
- popup lifecycle basics
- key mocked read flows
- several mocked write flows
- editor search surfaces for assignee and parent link
- quick-action edge cases and unassigned editor option coverage
- comment mention failure and draft discard coverage
- partial endpoint failure tolerance for PRs, issue search, and comments
- primary negative-path connection/auth scenarios
- initial guarded live mutation coverage for priority, assignee, and labels

Not yet covered deeply enough:

- more field editor permutations: assignee search branches, sprint variants, versions/fixVersions permutations, parent/epic link branches, more custom field editors
- additional quick-action permutations
- drag interaction assertions
- malformed Jira payloads and partial endpoint failures
- upload failure paths
- more than one public Jira smoke path
- private Jira authenticated paths

## Execution Commands

Run the stable mocked suite:

```bash
npm run test:e2e:extension
```

Run the public smoke suite:

```bash
RUN_PUBLIC_JIRA_TESTS=1 npm run test:e2e:public
```

Run the private Jira suite later:

```bash
npm run test:e2e:live
```

Example live scope config:

```bash
export JIRA_LIVE_INSTANCE_URL="https://yourcompany.atlassian.net"
export JIRA_LIVE_PROJECT_KEYS="E2E,QA"
export JIRA_LIVE_ISSUE_KEYS="E2E-101,E2E-102"
export JIRA_LIVE_STORAGE_STATE="tests/.auth/jira-live.json"
```

Open the latest report:

```bash
npm run test:e2e:show-report
```

## Reporting

- merged HTML report: `tests/output/playwright/report/index.html`
- accumulated blob reports: `tests/output/playwright/blob-report`
- run artifacts: `tests/output/playwright/test-results`

The merged HTML report now lives at `tests/output/playwright/report/index.html`.

Each environment run now writes a uniquely named blob report zip into `output/playwright/blob-report` and then regenerates one merged HTML report from all stored runs. This allows separate `extension`, `public-jira`, and future `live-jira` runs to appear in one combined report instead of overwriting each other.

Useful commands:

```bash
npm run test:e2e:merge-report
npm run test:e2e:reset-report-data
```

## Risks And Stability Notes

- extension tests require Chromium because they load an unpacked extension
- live public Jira content can drift, so public tests must stay lightweight
- mocked Jira must remain aligned with extension expectations as features evolve
- brittle selectors should be reduced over time by introducing more stable test hooks where appropriate

## Recommended Next Wave

1. Add more mocked field-editor coverage for assignee, sprint, affects versions, fix versions, and parent/epic link flows.
2. Add malformed-response and partial-failure tests for comments, PRs, labels, and attachments.
3. Add drag-behavior and multi-key-page popup interaction tests.
4. Add pasted-image upload happy-path and failure-path coverage once a stable Playwright clipboard-image strategy is in place.
5. Add private Jira auth fixtures and real-instance smoke coverage once credentials/project access are available.

## CI

- GitHub Actions workflow: `.github/workflows/playwright-extension.yml`
- CI runs `npm run test:e2e:extension`
- CI uploads `tests/output/playwright` as an artifact for report and trace inspection

## Skill Guidance

The installed Playwright CLI skill is useful for browser control and debugging.

The `wshobson-agents-e2e-testing-patterns` skill is also useful, but in a different way:

- it is stronger on test-design standards than browser control
- it reinforces selector hygiene, mocking strategy, test layering, retries, and CI patterns
- it is especially helpful for expanding this suite cleanly rather than merely getting the browser to run

Recommended use here:

- use the Playwright CLI skill for interactive browser debugging
- use the E2E testing patterns skill as a standards/reference guide while expanding the suite
