# PR #35 Cherry-Pick Plan

## Goal

Pass through all meaningful work from PR `#35` (`f95c50d2bcac0d817270ebadc28690923f38ef97`) into `feat/e2e-quality-posture`, in small verified chunks.

## Current Branch State

- Branch: `feat/e2e-quality-posture`
- Worktree: `D:\Jira-HotLinker\.worktrees\e2e-quality-posture`
- Current uncommitted work overlaps PR-touched test areas:
  - `jira-plugin/src/content.jsx`
  - `tests/e2e/mock-jira-flows.spec.js`

These must be protected before any cherry-pick or manual merge work.

## Key Finding From Re-Review

PR #35 is not a clean linear predecessor of the current branch.

- The core live-Jira assignee intent from the PR is already present in the current branch.
- Most of the remaining PR changes are branch-state collateral from an older snapshot:
  - CI/workflow restructuring
  - Playwright report/dashboard simplification
  - widespread `configureExtension(..., true)` callsite changes that do not match the current helper API
  - older variants of `options.spec.js` and other E2E specs that now conflict with the newer hook/page-model work in this branch

Because of that, the safe approach is **not** to cherry-pick the whole commit. We will process the PR in chunks and classify each as one of:

- `manual-apply`
- `already-present`
- `skip-obsolete`

## Safety Plan

Before merging PR #35 chunks:

1. Protect the current custom-field WIP using a temporary stash or scratch commit.
2. Process PR #35 from lowest-risk to highest-risk.
3. After each chunk:
   - rebuild
   - run targeted tests
   - review
   - commit if the chunk produced a real change and passes verification

## Chunk Order

### Chunk 1 - Live Jira assignee intent

Files:

- `tests/e2e/live-jira.spec.js`

Classification:

- `already-present`

Reason:

- The PR's main bugfix intent (unassign before assign-to-me when already assigned) is already implemented in the current branch.
- Verbatim cherry-pick is risky because the PR version also carries older helper structure.

Verification:

```bash
npm exec -- playwright test tests/e2e/live-jira.spec.js --grep "assignee"
```

Expected outcome:

- No code change, no commit unless an actual missing detail is discovered.

### Chunk 2 - Small test assertion/callsite churn in E2E specs

Files:

- `tests/e2e/advanced-mock-flows.spec.js`
- `tests/e2e/error-states.spec.js`
- `tests/e2e/hover-and-popup.spec.js`
- `tests/e2e/mock-jira-flows.spec.js`
- `tests/e2e/options.spec.js`
- `tests/e2e/partial-failures.spec.js`
- `tests/e2e/helpers/test-targets.js`

Classification:

- mostly `skip-obsolete`
- possibly tiny `manual-apply` fragments only

Reason:

- The PR's `configureExtension(..., true)` churn does not match the current helper API.
- This branch already has deeper refactors in these files.
- `tests/e2e/helpers/test-targets.js` from PR #35 would likely regress current behavior.

Verification:

```bash
npm exec -- playwright test tests/e2e/advanced-mock-flows.spec.js
npm exec -- playwright test tests/e2e/error-states.spec.js tests/e2e/hover-and-popup.spec.js tests/e2e/partial-failures.spec.js
npm exec -- playwright test tests/e2e/options.spec.js
npm exec -- playwright test tests/e2e/mock-jira-flows.spec.js
```

Expected outcome:

- Apply only clearly beneficial assertions that still fit the current branch.
- Skip obsolete test churn.

### Chunk 3 - Workflow and reporting files

Files:

- `.github/workflows/playwright-extension.yml`
- `scripts/playwright/merge-reports.js`
- `scripts/playwright/run-all-suites.js`
- `scripts/playwright/run-with-blob.js`

Classification:

- mostly `skip-obsolete`
- partially `already-present`

Reason:

- PR #35 simplifies the report pipeline by removing the richer dashboard/history behavior that exists in the current branch.
- The `run-with-blob.js` / `run-all-suites.js` diff appears internally inconsistent in the PR snapshot.
- These files are not aligned with the branch's newer test/reporting direction.

Verification:

```bash
npm run build
node scripts/playwright/run-all-suites.js --help
node scripts/playwright/merge-reports.js
```

Expected outcome:

- Keep current branch behavior unless there is a small isolated improvement worth transplanting.

## Working Rules During Merge

- Do not cherry-pick PR #35 wholesale.
- Prefer manual application over conflict-heavy cherry-picks.
- Treat `already-present` and `skip-obsolete` as valid outcomes for PR chunks.
- Review before every commit.
- Only commit chunks that introduce a real, verified improvement.

## Success Criteria

- Every changed area from PR #35 is explicitly processed.
- Low-risk useful pieces are integrated.
- Already-present intent is confirmed.
- Obsolete/regressive PR changes are consciously skipped, not accidentally merged.
- Each applied chunk is rebuilt, tested, reviewed, and committed before moving on.
