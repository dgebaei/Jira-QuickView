# Jira HotLinker

## Repository

- **GitHub repo**: https://github.com/dgebaei/Jira-Hot-Linker
- **Upstream**: https://github.com/helmus/Jira-Hot-Linker
- PRs and issues go to `dgebaei/Jira-Hot-Linker`, not upstream

## Git workflow

- Always `git pull origin master --rebase` before starting work to stay in sync with remote
- PRs target `master` on `dgebaei/Jira-Hot-Linker`
- For `gh` commands, always target `dgebaei/Jira-Hot-Linker` explicitly with `-R dgebaei/Jira-Hot-Linker`, or verify first that `gh repo view --json nameWithOwner` resolves to `dgebaei/Jira-Hot-Linker`. Never rely on upstream inference when creating or closing PRs/releases.
- By default, do feature work in a dedicated git worktree under `.worktrees/` inside the repo, unless the user explicitly asks to work in the main checkout.
- Name each worktree folder after the task or branch and keep `.worktrees/` ignored.
- For manual extension testing, use the stable unpacked path `.worktrees/_active-extension_/jira-plugin` and refresh it with `npm run build:active-extension`.
- Before handing work over for manual testing, always run `npm run build:active-extension` and say explicitly whether you ran it.
- Shared agent workflow docs live under `.agents/skills/`; prefer those local project skills when available so different agents and harnesses reuse the same repo conventions.
- The repo-root `CLAUDE.md` defines repo-wide workflow. Area-specific `CLAUDE.md` files may still contain local context when they are populated, so consult them when working in those areas instead of assuming they are irrelevant.

## Build

```
npm run build
```

## Repo tools

- Bootstrap the repo-local code-analysis TLDR tool with `npm run tldr:setup`.
- Run the repo-local analyzer with `npm run tldr:code -- <command>`.
- Do not rely on the system `tldr` binary for code analysis; on some machines it is `tealdeer`, a different tool with the same name.

## Testing and CI

- For bugs that span optimistic UI state and persisted Jira data, verify all three states before calling the fix done:
  immediate interaction, same-page close/reopen, and full page reload.
- Prefer durable E2E assertions over transient snackbars, toasts, or status text. Assert on persisted UI state, disabled/enabled transitions, or refreshed values whenever possible.
- When many Playwright suites fail while waiting for the extension service worker, treat it as an extension boot problem first. Inspect `jira-plugin/manifest.json`, extension build output, and the extension load path before changing product logic.
- Before fixing CI, compare the last passing run and the first failing run so the suspected regression window is explicit.
- Use `npm run validate:manifest` for fast manifest/version checks and `npm run test:e2e:startup-smoke` to confirm the Chromium extension boots before spending time on longer suites.

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
5. Build: `npm run build`
6. Package: `powershell -Command "Remove-Item -Force jira-plugin-build.zip -ErrorAction SilentlyContinue; Compress-Archive -Path jira-plugin/build, jira-plugin/resources, jira-plugin/options, jira-plugin/manifest.json -DestinationPath jira-plugin-build.zip"`
7. Create release: `gh release create <version> jira-plugin-build.zip --repo dgebaei/Jira-Hot-Linker --title "<version> - <title>" --notes "<release notes>"`
