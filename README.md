# Jira HotLinker

> Turn plain Jira issue keys into instant, rich previews and in-place actions across the tools your team already lives in.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-1f6feb?style=for-the-badge&logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-0f766e?style=for-the-badge)
![MIT License](https://img.shields.io/badge/License-MIT-f59e0b?style=for-the-badge)

## The pitch 🚀

Jira keys are everywhere, but the context usually is not. You see `PROJ-1842` in a pull request, an email, a doc, or a comment thread, and then the tab-hopping begins.

Jira HotLinker brings that context to you instantly. Hover an issue key and get the title, status, priority, description, comments, attachments, related pull requests, and more - without leaving the page.

And it does not stop at reading. The extension also lets you update issues directly from the hover card, using Jira's own available values, transitions, and rules so your edits stay aligned with the validation already configured in Jira.

It is the kind of extension that feels small until you use it for a day - then you do not want to work without it.

## Why people install it 💡

- ✨ See Jira context exactly where the issue key appears
- ⚡ Reduce tab switching and stay in flow
- ✍️ Make quick updates without opening the full Jira issue
- 🔎 Review work with more context before you click away
- 🔗 Connect Git, docs, email, Jira, and Confluence more naturally
- 🎯 Give each team the fields and workflow cues they actually need

## Where it shines 🌍

- Git platforms: GitHub, GitLab, Bitbucket, and similar review or repo tools
- Email and communication: Gmail, Outlook, and any web app where Jira keys appear in text
- Documents and knowledge tools: Google Docs, Jira, Confluence, and other configurable pages
- Team-specific workflows: any internal tool or custom domain you choose to enable

## What it can do ⚡

- ✨ Detect Jira issue keys and turn them into rich hover cards
- 🧾 Show core issue metadata like title, type, status, priority, labels, sprint, versions, epic/parent, reporter, and assignee
- 💬 Render descriptions, comments, attachments, and related pull requests in the popup
- ✍️ Support in-place editing, quick actions, and Jira-backed workflow transitions
- 📌 Let you pin the popup while you keep working on the page
- 📋 Copy issue details quickly when you need to share them
- ⚙️ Control supported pages, visible fields, and custom field placement

## Direct issue editing ✍️

Jira HotLinker is not just a viewer. It helps you act on issues right from the preview, while still respecting how Jira is configured.

- 🛠️ Edit supported fields such as sprint, versions, status, priority, assignee, labels, issue type, epic/parent, and supported custom fields
- ⚡ Run quick actions like assigning the issue to yourself or moving it into progress when Jira allows it
- 🔄 Use Jira-provided values and transitions instead of hardcoded shortcuts
- ✅ Stay aligned with workflow restrictions, field constraints, and validation behavior already defined in Jira

## Feature tour 🎬

Imagine the moment a Jira key appears on screen:

1. You hover the issue key.
2. The popup opens with the ticket summary and current status.
3. You scan the important context without leaving the page.
4. If needed, you open comments, attachments, or related pull requests.
5. If action is needed, you edit the issue or trigger a quick Jira workflow action.
6. You keep reading, reviewing, replying, or shipping without breaking focus.

## Privacy and authentication 🔐

Jira HotLinker uses your existing Jira login session in the browser. In plain terms, if you are already signed in to Jira in your browser, the extension can request issue data with that same authenticated session.

- 🔒 No separate Jira password is stored by the extension
- 🚫 No extra credential vault or external account link is required
- 🌐 Requests are made from your browser to your Jira instance using the access you already have
- ✅ What you can view or update still depends on your Jira permissions, workflow rules, and field validation

## Install 📦

### Install from the Chrome Web Store 🛍️

Chrome Web Store listing: `TBD`

### Install from GitHub for now 📥

Until the Chrome Web Store listing is ready, the simplest distribution path is a GitHub release with a packaged build.

Download the current packaged build here:

- [Download latest build](https://github.com/dgebaei/Jira-Hot-Linker/releases/latest/download/jira-plugin-build.zip)

Release page:

- [View latest release](https://github.com/dgebaei/Jira-Hot-Linker/releases/latest)

Installation steps:

- Users download and unzip it locally
- In Chrome or other Chromium browsers, open `chrome://extensions`
- Enable `Developer mode`
- Click `Load unpacked`
- Select the unzipped `jira-plugin/` folder

### Local development setup 🛠️

```bash
npm install
npx webpack-cli
```

Then load the unpacked extension from `jira-plugin/` in Chrome.

For active development:

```bash
npm run dev
```

Useful commands:

- `npm run dev` - rebuilds on file changes
- `npx webpack-cli` - creates a production build in `jira-plugin/`
- `make build` - builds and creates a zip archive

## Configuration highlights ⚙️

- `Jira instance URL` points the extension at the Jira site used for issue metadata
- `Allowed pages` controls where ticket detection is active
- `Tooltip Layout` lets you choose which built-in fields appear in the hover card
- `Custom Fields` lets you add Jira field IDs such as `customfield_12345` and place them in summary rows

## Finding custom field IDs 🔎

Want to surface a Jira custom field in the hover card? You will need the field ID, which usually looks like `customfield_12345`.

Here are the easiest ways to find it in your Jira instance:

- Use Jira issue search: when you search for a custom field in JQL, Jira often shows the field ID alongside the field name, which makes it easy to spot values like `customfield_12345`
- Open a Jira issue, inspect the page or network requests, and look for field keys named like `customfield_12345`
- Visit your Jira field metadata endpoint while signed in: `https://your-jira/rest/api/2/field`
- Search the returned list for the field name you care about, then copy its `id`
- Paste that value into the extension options page under `Custom Fields`

If the field ID is valid, the options page will try to resolve and display the field name for you.

## For developers 👩‍💻

- `jira-plugin/src/` - content script, background logic, and UI behavior
- `jira-plugin/options/` - options page UI and configuration flow
- `jira-plugin/manifest.json` - Chrome extension manifest
- `webpack.config.js` - build pipeline for the extension bundles

## In one sentence 🎉

Jira HotLinker makes every Jira key on the web feel alive, actionable, and useful.

## Thank you 🙌

Special thanks to the original extension author, Willem D'Haeseleer, for creating Jira HotLinker and laying the foundation for this project.

## License 📄

This project is released under the MIT License. See `LICENSE.md`.
