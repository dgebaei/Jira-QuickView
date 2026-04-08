# Jira QuickView

> Hover Jira keys on GitHub, Gmail, Outlook, docs, and other enabled pages to inspect issues, follow linked PRs, comment, transition, and edit fields without opening a new Jira tab.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-1f6feb?style=for-the-badge&logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-0f766e?style=for-the-badge)
![MIT License](https://img.shields.io/badge/License-MIT-f59e0b?style=for-the-badge)

## One hover, much more context

Open a Jira notification email in Gmail or Outlook, hover the issue key in the message, and triage the ticket directly from your inbox. The same workflow applies on GitHub pull requests, release notes, docs, bug lists, and other enabled pages: inspect the issue, review linked PRs, add comments, transition status, and update fields without breaking context.

![Main product overview](docs/screenshots/marketing-hidpi-light/popup-overview.png)

## Feature highlights

- Action Jira email notifications directly from Gmail, Outlook, and other enabled inbox-style pages
- Rich popup for issue metadata, description, attachments, comments, and linked pull requests
- PR visibility inside the card, including title, author, branch, and status
- Inline editing for supported Jira fields and supported custom field types
- Configurable layout with Jira custom fields placed directly into the popup rows
- Comment drafting with mentions and support for comment reactions
- Jira-backed quick actions and workflow transitions

## Why it matters

- Turns Jira notification emails into actionable workflows instead of another tab-switching detour
- Less tab switching during review and triage
- Faster issue updates while staying in the current page
- Better release confidence with attachments, history, and linked PRs in one place
- More relevant popups because each team can control fields and custom field placement

## Install and configure

Chrome Web Store listing: coming soon

Until then:

1. [Download the latest build](https://github.com/dgebaei/Jira-QuickView/releases/latest/download/jira-plugin-build.zip)
2. Open `chrome://extensions`
3. Enable `Developer mode`
4. Click `Load unpacked`
5. Select the unzipped `jira-plugin/` folder

### Initial setup

1. Open the extension options page
2. Set your Jira instance URL, for example `https://your-company.atlassian.net`
3. Add the pages where Jira QuickView should run, for example:
   - `github.com`
   - `mail.google.com`
   - `outlook.office.com`
   - `docs.your-company.com`
   - `wiki.your-company.com`
4. Save the settings
5. Open one of those pages and hover a Jira issue key such as `ABC-123`

### Default behavior

By default, Jira QuickView opens the popup when you hover a Jira issue key and then hold a modifier key.

Default trigger:

- hover the Jira key
- then hold `Alt`, `Ctrl`, or `Shift`

This helps avoid unwanted popups on busy pages like inboxes, pull requests, and internal docs.

### Optional customization

You can optionally adjust the interaction model and popup layout in the options page:

- change the modifier key behavior
- make hover activation more or less sensitive
- reorder popup rows and content blocks
- add custom Jira fields to the popup layout

### Common page setups

#### GitHub

Add:

- `github.com`

Use this for pull requests, commits, issues, release notes, and code review pages that reference Jira keys.

#### Gmail

Add:

- `mail.google.com`

Use this to action Jira notification emails directly from Gmail in the browser.

#### Outlook

Add:

- `outlook.office.com`

Use this for Outlook on the web.

If you usually work from the desktop Outlook app, open Outlook on the web at `outlook.office.com` in Chrome or Edge and install it as a PWA from the browser menu.

In Chrome:

1. Open `outlook.office.com`
2. Click the install icon in the address bar, or open the browser menu and choose `Cast, save, and share` -> `Install page as app`

In Edge:

1. Open `outlook.office.com`
2. Open the browser menu and choose `Apps` -> `Install this site as an app`

Once installed, Outlook opens in its own app-like window but still runs as a browser-based web app, so Chrome extensions such as Jira QuickView can work there. The native desktop Outlook client does not support Chrome extensions.

The same idea applies to other browser-hosted apps: if they run as web pages in Chrome or Edge, including installed PWAs, Jira QuickView can work there.

#### Internal tools, docs, and other web apps

Add the domain or match pattern for pages where Jira keys appear, for example:

- `docs.your-company.com`
- `wiki.your-company.com`
- `https://*.your-company.com/*`

Jira QuickView only runs on pages you explicitly enable.

## Privacy

- Uses your existing Jira browser session
- Stores no separate Jira password
- Sends requests from the browser to your Jira instance
- Honors Jira permissions, validation rules, and workflow restrictions
- [Privacy Policy](https://dgebaei.github.io/Jira-QuickView/privacy-policy.html)

### Notes

- You can also enable the current page by clicking the extension icon
- The extension uses your existing Jira browser session
- If the popup does not appear, confirm that:
  - the page domain is enabled
  - your Jira instance URL is saved
  - the page contains Jira issue keys
  - you are holding `Alt`, `Ctrl`, or `Shift` after hovering, unless you changed that behavior in settings
  - your Jira instance is reachable from the browser, for example through VPN or your company network if required

## Gallery

| Quick actions | Inline editing |
| --- | --- |
| ![Quick actions](docs/screenshots/marketing-hidpi-light/popup-actions.png) | ![Inline editing](docs/screenshots/marketing-hidpi-light/popup-inline-editor.png) |

| Description editing | Comment drafting |
| --- | --- |
| ![Description editing](docs/screenshots/marketing-hidpi-light/popup-description-editor.png) | ![Comment drafting](docs/screenshots/marketing-hidpi-light/popup-comment-compose.png) |

| Attachments and evidence | Related pull requests |
| --- | --- |
| ![Attachments and evidence](docs/screenshots/marketing-hidpi-light/popup-attachments.png) | ![Related pull requests](docs/screenshots/marketing-hidpi-light/popup-pull-requests.png) |

| Change history | Options overview |
| --- | --- |
| ![Change history](docs/screenshots/marketing-hidpi-light/popup-history.png) | ![Options overview](docs/screenshots/marketing-hidpi-light/options-basic-overview.png) |

| Advanced layout | Custom fields |
| --- | --- |
| ![Advanced layout](docs/screenshots/marketing-hidpi-light/options-advanced-layout.png) | ![Custom fields](docs/screenshots/marketing-hidpi-light/options-custom-fields.png) |

## License

MIT. See `LICENSE.md`.
