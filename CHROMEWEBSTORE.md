# Chrome Web Store Listing — Jira QuickView

> Last Updated: 2026-10-26

## Store Listing

**Extension Name**

Jira QuickView

**Short Description**

Open Jira issue details from links and ticket numbers, then review, edit, comment, and triage without leaving the page.

**Detailed Description**

Jira QuickView opens Jira issue details directly from links and recognized ticket numbers on the pages you choose.

Review status, priority, people, versions, sprint, labels, linked issues, descriptions, comments, attachments, history, time tracking, watchers, and linked pull requests. Update supported fields, transition workflows, manage linked issues, add or edit comments, upload images, and copy rich issue links while keeping your current page open.

Review linked pull requests in a compact table with titles, authors, source → target branches, and sortable last-update times. With site access to your GitLab host, see approval counts and approvers, unresolved review threads, current CI status, merge conflicts, and commit or merge details using your existing GitLab login.

Work faster with number shortcuts while QuickView has focus. Plan an issue into the current sprint and reassign it in one confirmed update, resolve issues with the required resolution and comment, and show the shortcut list with Alt+0. Quick-close defaults stay in your browser and always require confirmation.

To get started, enter your Jira instance URL, add the pages where Jira QuickView should run, and save. Plain-clicking a genuine Jira issue link opens and pins QuickView by default. Automatic hover preview also works for recognized Jira IDs that are not links. Both behaviors can be configured in Options.

Choose a light or dark appearance, and organize popup fields and content blocks in the advanced settings.

Optionally preview Jira image attachment links on enabled pages, including links wrapped by Gmail or Outlook. Image link previews are off by default; unsupported files and failed previews fall back to Jira.

Jira QuickView uses your existing signed-in Jira browser session and follows your Jira permissions and workflow rules. Optional GitLab details use your existing GitLab browser session and permissions. It does not operate a developer-run backend or send your data to developer analytics services. You control which sites the extension can access.

Support and documentation: https://dgebaei.github.io/Jira-QuickView/

**Category**

Productivity

**Single Purpose**

Show and update Jira issue information from issue links and ticket numbers without leaving the current page.

**Primary Language**

English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon | 128×128 PNG | ✅ Ready | `docs/chrome-web-store-assets/icon-128.png` |
| Screenshot 1 | 1280×800 PNG | 🟡 Refresh for keyboard-help control | `docs/chrome-web-store-assets/screenshot-01-overview-1280x800.png` |
| Screenshot 2 | 1280×800 PNG | ✅ Ready | `docs/chrome-web-store-assets/screenshot-02-inline-editing-1280x800.png` |
| Screenshot 3 | 1280×800 PNG | 🟡 Refresh for compact PR grid | `docs/chrome-web-store-assets/screenshot-03-pull-requests-1280x800.png` |
| Screenshot 4 | 1280×800 PNG | ✅ Ready | `docs/chrome-web-store-assets/screenshot-04-comment-compose-1280x800.png` |
| Screenshot 5 | 1280×800 PNG | 🟡 Refresh for redesigned Options page | `docs/chrome-web-store-assets/screenshot-05-options-1280x800.png` |
| Small Promo Tile | 440×280 PNG | ✅ Ready | `docs/chrome-web-store-assets/promo-tile-440x280.png` |

### Screenshot Notes

The first four screenshots cover the main QuickView, inline editing, related pull requests, and comment composition. Refresh the Pull Requests screenshot for the compact ID/target/signals/last-update grid and the Options screenshot for the redesigned settings page before store submission. The existing documentation screenshots are preserved.

For the keyboard-shortcuts release, refresh the popup screenshot to include the keyboard-help control and consider a resolve/close confirmation screenshot.

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `activeTab` | permissions | Lets the user enable Jira QuickView for the current page through the extension toolbar action. |
| `alarms` | permissions | Schedules periodic Settings Sync checks only when the user configures a shared settings source. |
| `declarativeContent` | permissions | Activates Jira QuickView only on the Jira instance and pages the user configured. |
| `scripting` | permissions | Loads Jira QuickView into a page after the user grants access or changes allowed-page settings. |
| `storage` | permissions | Stores the Jira URL, allowed pages, popup layout, activation preferences, and optional Settings Sync configuration. |
| `webNavigation` | permissions | Reapplies configured activation when supported pages navigate without a full browser reload. |
| User-selected website access | optional_host_permissions | Access is requested for the configured Jira instance, additional enabled pages, and linked GitLab hosts when the user chooses Connect. Granted GitLab access allows read-only pull request details using the existing signed-in browser session. No new mandatory host access is required. |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** Yes, only to provide requested Jira functionality and settings synchronization; the developer does not receive it.

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|------------|-------------------------|---------|----------------------------|
| Personally identifiable info | Yes | Requests to the configured Jira instance and authorized GitLab hosts | Display Jira users, assignees, reporters, watchers, mentions, authors, and GitLab commit authors and approvers | No developer-run recipient; only user-authorized systems |
| Health info | No | No | Not used | No |
| Financial info | No | No | Not used | No |
| Authentication info | No | No | Existing browser Jira and GitLab sessions are used; passwords, session-cookie values, and API tokens are not read or stored by the extension | No |
| Personal communications | Yes | Requests to the configured Jira instance and authorized GitLab hosts | Display and perform user-initiated Jira comment, description, attachment, and worklog actions; read GitLab discussions to count unresolved threads | No developer-run recipient; only user-authorized systems |
| Location | No | No | Not used | No |
| Web history | No | No | Not collected | No |
| User activity | Yes | To the configured Jira instance when an action is requested | Perform user-initiated field, workflow, watcher, link, reaction, and time-tracking changes | No; only the user's configured Jira system processes it |
| Website content | Yes | Jira issue keys are sent to the configured Jira instance; linked MR identifiers are sent to GitLab hosts with granted site access; shared settings are fetched from the configured source | Detect issue references locally and retrieve the requested issue, linked MR details, or team configuration | No developer-run recipient; only user-authorized systems |

### Data Use Certification

- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL**

https://dgebaei.github.io/Jira-QuickView/privacy-policy.html

## Distribution

**Visibility**: Public  
**Regions**: All regions

**3.0 distribution**: 3.0.0 is submitted through the release workflow from the `3.0.0` GitHub release. The 3.0.0-beta.1 prerelease was GitHub-only. Store screenshots listed above as needing a refresh are uploaded by hand in the developer dashboard.

## Developer Info

**Publisher Name**

Darko Gebaei

**Contact Email**

dgebaei@gmail.com

**Support URL**

https://github.com/dgebaei/Jira-QuickView/issues

**Homepage URL**

https://dgebaei.github.io/Jira-QuickView/

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 3.0.1 | 2026-10-26 | Copy buttons no longer shift grid/flex rows; claude.ai also enables Claude artifact frames; issue-link clicks in artifact frames open QuickView only; compact shortcut workflows with future sprints; new shortcuts 8/Alt+8 (next sprint), C (comment), Ctrl/Cmd+C (copy link) | Submit after 3.0.0 review completes |
| 3.0.0 | 2026-10-26 | Keyboard triage with a shortcut dropdown (Quick actions menu removed); pull request grid with titles, short authors, source → target branches, and optional GitLab signals; compact header and field chips (icon-only type/priority, sprint state dot, user avatars, one tooltip style); any field in any row in layout order; opt-in Jira image attachment previews; redesigned Options and docs | Submitted via release workflow |
| 3.0.0-beta.1 | 2026-10-24 | Opt-in Jira image attachment link previews; compact pull request grid with optional GitLab signals and last-update details; popup-scoped number shortcuts, staged sprint + reassignment, resolution confirmation, browser-local quick-close defaults, and documentation and Options redesign | GitHub prerelease only; not submitted to the store |
| 2.9.2 | 2026-10-15 | Children, linked issues, and external links in one links panel with a combined count, View in Jira links, removable external links, and popup titles clamped to two lines | Ready to submit |
| 2.9.1 | 2026-10-15 | Click activation on Jira board cards and current-issue keys, no copy icon on Jira dialog Cancel links, single popup frame with an all-round shadow | Ready to submit |
| 2.9.0 | 2026-10-14 | Calmer neutral popup and Options design, compact field chips, popup keyboard focus with contained Escape, outside-click editor close, real Jira versions only, and copy-icon and assignee-avatar fixes | Ready to submit |
| 2.8.0 | 2026-09-12 | Click and hover activation, deeper and more resilient Jira editing and popup flows, linked-issue management, global copy controls, attachment improvements, and UI reliability fixes | Published |
| 2.7.0 | 2026-08-16 | Linked issues, settings synchronization, time tracking, watchers, and popup improvements | Published |

## Review Notes

### Known Issues / Limitations

- Jira capabilities vary by Jira Cloud/Data Center version, installed applications, workflow configuration, and user permissions; unavailable operations remain read-only or hidden.
- Live Jira verification requires an authorized Jira account and is separate from the deterministic mocked extension suite.
- GitLab enrichment requires host access and a working GitLab browser session; unavailable or incomplete signals are shown as unknown. API-token/OAuth configuration is not included.
- Store screenshots need refreshing for the redesigned Options, compact pull request grid, and keyboard-help control before store submission.

### Rejection History

No known rejections are recorded in this repository.
