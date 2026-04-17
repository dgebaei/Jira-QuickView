# Jira QuickView

## Repository

- **GitHub repo**: https://github.com/dgebaei/Jira-QuickView
- **Upstream**: https://github.com/helmus/Jira-Hot-Linker
- **Public homepage**: https://dgebaei.github.io/Jira-QuickView/
- **Privacy policy**: https://dgebaei.github.io/Jira-QuickView/privacy-policy.html
- PRs and issues go to `dgebaei/Jira-QuickView`, not upstream

## Git workflow

- Always `git pull origin master --rebase` before starting work to stay in sync with remote
- PRs target `master` on `dgebaei/Jira-QuickView`
- For `gh` commands, always target `dgebaei/Jira-QuickView` explicitly with `-R dgebaei/Jira-QuickView`, or verify first that `gh repo view --json nameWithOwner` resolves to `dgebaei/Jira-QuickView`. Never rely on upstream inference when creating or closing PRs/releases.
- By default, do feature work in a dedicated git worktree under `.worktrees/` inside the repo, unless the user explicitly asks to work in the main checkout.
- Name each worktree folder after the task or branch and keep `.worktrees/` ignored.
- For manual extension testing, use the stable unpacked path `.worktrees/_active-extension_/jira-plugin` and refresh it with `npm run build:active-extension`.
- Before handing work over for manual testing, always run `npm run build:active-extension` and say explicitly whether you ran it.
- Shared agent workflow docs live under `.agents/skills/`; prefer those local project skills when available so different agents and harnesses reuse the same repo conventions.
- The repo-root `CLAUDE.md` defines repo-wide workflow. Area-specific `CLAUDE.md` files may still contain local context when they are populated, so consult them when working in those areas instead of assuming they are irrelevant.
- Whenever a change affects UI, layout, visual styling, or user-visible interaction states, capture fresh screenshots that validate the new behavior or UX before handing work back.
- Always align nearby UI elements vertically to a shared center line by default. Only keep intentional vertical misalignment when the user explicitly wants it.
- In the final handoff for UI-affecting changes, list the generated screenshots explicitly and prefer clickable markdown file links over plain-text paths so the user can inspect them quickly.
- If screenshot capture is blocked by the environment, say so explicitly in the final handoff and describe what prevented it instead of silently omitting visual verification.

## Common actions

- Refresh the unpacked extension used for manual Chrome testing: `npm run build:active-extension`
- Build the Pages homepage locally: `npm run build:pages`
  - `README.md` is the source of truth for the public homepage at `https://dgebaei.github.io/Jira-QuickView/`.
  - Do not recreate or edit `docs/index.html`; it was intentionally removed when the homepage switched to a README-driven build.
  - Keep the privacy policy as `docs/privacy-policy.html`, and link to the public Pages URL from `README.md`.
  - Keep public screenshots and other homepage images under `docs/` with relative links from `README.md`; `scripts/build-pages-site.js` rewrites those paths for the generated site.
  - `docs/site.js` adds the lightbox behavior to local README images on the generated Pages site.
  - `pandoc` is required for local Pages builds; the GitHub Pages workflow installs it explicitly.
- Refresh HiDPI marketing screenshots: `npm run screenshots:marketing:hidpi`
  - Uses `scripts/playwright/capture-marketing-screenshots-hidpi.js`.
  - Default output is `docs/screenshots/marketing-hidpi/` for dark-theme marketing screenshots.
  - Pass `--theme light --output-dir marketing-hidpi-light --layout-mode legacy` when refreshing the checked-in light marketing screenshots used by the guide.
- Refresh the user-guide screenshot set: `npm run screenshots:user-guide`
  - Regenerates light marketing screenshots under `docs/screenshots/marketing-hidpi-light/` and focused guide crops under `docs/screenshots/user-guide/`.
  - This script deliberately passes `--user-guide`; generic marketing runs must not wipe or replace `docs/screenshots/user-guide/`.
  - The screenshot process starts local mock Jira and fixture servers on `127.0.0.1`. If a sandboxed run fails with `listen EPERM`, rerun with permission for the npm script instead of changing product code.
  - Options-page marketing screenshots are captured from `.optionsPage`, not the whole viewport, to avoid extra blank space on the left, right, and bottom.
  - User-guide screenshots are focused element crops. Before committing, visually confirm each screenshot actually shows the feature described by its section, especially row/edit-mode sections that can look similar.
  - After changing `docs/user-guide.md`, screenshot references, or Pages styling, run `npm run build:pages` and verify the generated `.site-build/user-guide.html` contains the expected links/images.
- Build the Chrome Web Store upload ZIP: `npm run release:zip`
  - Output: `jira-quickview-<version>-chrome-web-store.zip`
  - Requirement: `manifest.json` must be at the ZIP root.
- Build the GitHub release download ZIP: `npm run release:asset`
  - Output: `jira-plugin-build.zip`
  - The archive extracts directly into the extension root, meaning the extracted folder itself contains `manifest.json`.
- Validate the extension manifest quickly: `npm run validate:manifest`
- Run release preflight checks: `npm run release:check`

## Build

```
npm run build
```

- `npm run build` currently maps to `npm run build:active-extension`, which rebuilds the unpacked extension and refreshes `.worktrees/_active-extension_/jira-plugin`.

## Repo tools

- Bootstrap the repo-local code-analysis TLDR tool with `npm run tldr:setup`.
- Run the repo-local analyzer with `npm run tldr:code -- <command>`.
- Do not rely on the system `tldr` binary for code analysis; on some machines it is `tealdeer`, a different tool with the same name.

## Testing and CI

- For bugs that span optimistic UI state and persisted Jira data, verify all three states before calling the fix done:
  immediate interaction, same-page close/reopen, and full page reload.
- When debugging a mismatch between Jira’s own UI and the popup, always ask the user for the exact example request URL captured in the browser Network tab before guessing about endpoint behavior, params, or payload shape.
- Prefer a hybrid red-green workflow for behavior-heavy changes.
  - Write a failing test first when the change has a clear behavioral contract:
    bug fixes, regressions, state transitions, cache invalidation, persistence, save/cancel flows, keyboard interaction, or cross-reopen/reload behavior.
  - Do not force test-first for purely visual polish or exploratory UI shaping:
    spacing, icon choice, hover treatment, copy tweaks, or layout refinement can be implemented first and tested once the behavior settles.
  - For larger UI features, start by locking down the core user-facing contract with a few failing end-to-end tests, then implement the minimal path to make them pass.
  - After the core flow is green, refine the UX in smaller steps and add or tighten tests where the behavior becomes stable.
  - When extracting helpers or pure logic, prefer small red-green cycles with focused unit-style or narrow integration coverage.
  - Avoid dogmatic TDD. The goal is to protect behavior and reduce regressions, not to write tests before every line of UI code.
- Prefer durable E2E assertions over transient snackbars, toasts, or status text. Assert on persisted UI state, disabled/enabled transitions, or refreshed values whenever possible.
- When many Playwright suites fail while waiting for the extension service worker, treat it as an extension boot problem first. Inspect `jira-plugin/manifest.json`, extension build output, and the extension load path before changing product logic.
- Before fixing CI, compare the last passing run and the first failing run so the suspected regression window is explicit.
- Use `npm run validate:manifest` for fast manifest/version checks and `npm run test:e2e:startup-smoke` to confirm the Chromium extension boots before spending time on longer suites.
- For UI refinements that do not justify new automated assertions, screenshots are still required as a verification artifact; do not treat visual-only changes as exempt from evidence.

## Jira API docs

- Official Jira Server/Data Center REST API docs: https://developer.atlassian.com/server/jira/platform/rest/v10003/intro
- The docs are very large, so only fetch/read them when repo inspection is not enough or when endpoint details need confirmation.

## Release process

1. Ensure master is up to date: `git checkout master && git pull origin master --rebase`
2. Releases are created only from `master`. Never tag or publish from a feature branch.
3. Run `npm run release:check` before tagging or publishing.
4. Before building or publishing, bump the extension version in both `jira-plugin/manifest.json` and `package.json`, and keep that version in sync with the GitHub release tag/title.
   In `jira-plugin/manifest.json`, `version` must stay Chrome-valid: digits and dots only, such as `2.3.0.0`.
   Use `version_name` for human-readable prerelease labels like `2.3.0-beta`; do not put `-beta` or other suffixes into `version`.
5. Build the GitHub release asset: `npm run release:asset`
6. Build the Chrome Web Store ZIP when needed: `npm run release:zip`
7. Create a new GitHub release with the download ZIP: `gh release create <version> jira-plugin-build.zip --repo dgebaei/Jira-QuickView --title "<version> - <title>" --notes "<release notes>"`
8. To refresh an existing release asset without touching the existing release description, use: `gh release upload <version> jira-plugin-build.zip --repo dgebaei/Jira-QuickView --clobber`
9. Leave existing release notes and descriptions unchanged unless the user explicitly asks to edit them.
