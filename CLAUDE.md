# Jira HotLinker

## Repository

- **GitHub repo**: https://github.com/dgebaei/Jira-Hot-Linker
- **Upstream**: https://github.com/helmus/Jira-Hot-Linker
- PRs and issues go to `dgebaei/Jira-Hot-Linker`, not upstream

## Git workflow

- Always `git pull origin master --rebase` before starting work to stay in sync with remote
- PRs target `master` on `dgebaei/Jira-Hot-Linker`

## Build

```
npx webpack --mode=development
```

## Jira API docs

- Official Jira Server/Data Center REST API docs: https://developer.atlassian.com/server/jira/platform/rest/v10003/intro
- The docs are very large, so only fetch/read them when repo inspection is not enough or when endpoint details need confirmation.

## Release process

1. Ensure master is up to date: `git checkout master && git pull origin master --rebase`
2. Build: `npx webpack --mode=development`
3. Package: `powershell -Command "Remove-Item -Force jira-plugin-build.zip -ErrorAction SilentlyContinue; Compress-Archive -Path jira-plugin/build, jira-plugin/resources, jira-plugin/options, jira-plugin/manifest.json -DestinationPath jira-plugin-build.zip"`
4. Create release: `gh release create <version> jira-plugin-build.zip --repo dgebaei/Jira-Hot-Linker --title "<version> - <title>" --notes "<release notes>"`
