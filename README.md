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

## Configuration

- Set the Jira instance URL and allowed pages
- Tune hover activation behavior
- Reorder popup rows and content blocks
- Add Jira custom fields such as `customfield_12345`
- Show custom fields in the layout and edit supported field types inline

## Install

Chrome Web Store listing: coming soon

Until then:

1. [Download the latest build](https://github.com/dgebaei/Jira-QuickView/releases/latest/download/jira-plugin-build.zip)
2. Open `chrome://extensions`
3. Enable `Developer mode`
4. Click `Load unpacked`
5. Select the unzipped `jira-plugin/` folder

## Privacy

- Uses your existing Jira browser session
- Stores no separate Jira password
- Sends requests from the browser to your Jira instance
- Honors Jira permissions, validation rules, and workflow restrictions

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
