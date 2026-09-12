# Chrome Web Store Listing — Jira QuickView

> Last Updated: 2026-09-12

## Store Listing

**Extension Name**

Jira QuickView

**Short Description**

Open Jira issue details from links and ticket numbers, then review, edit, comment, and triage without leaving the page.

**Detailed Description**

Jira QuickView opens Jira issue details directly from links and recognized ticket numbers on the pages you choose.

Review status, priority, people, versions, sprint, labels, linked issues, descriptions, comments, attachments, history, time tracking, watchers, and linked pull requests. Update supported fields, transition workflows, manage linked issues, add or edit comments, upload images, and copy rich issue links while keeping your current page open.

To get started, enter your Jira instance URL, add the pages where Jira QuickView should run, and save. Plain-clicking a genuine Jira issue link opens and pins QuickView by default. Automatic hover preview also works for recognized Jira IDs that are not links. Both behaviors can be configured in Options.

Jira QuickView uses your existing signed-in Jira browser session and follows your Jira permissions and workflow rules. It does not operate a developer-run backend or send your data to developer analytics services. You control which pages the extension can access.

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
| Screenshot 1 | 1280×800 PNG | ✅ Ready | `docs/chrome-web-store-assets/screenshot-01-overview-1280x800.png` |
| Screenshot 2 | 1280×800 PNG | ✅ Ready | `docs/chrome-web-store-assets/screenshot-02-inline-editing-1280x800.png` |
| Screenshot 3 | 1280×800 PNG | ✅ Ready | `docs/chrome-web-store-assets/screenshot-03-pull-requests-1280x800.png` |
| Screenshot 4 | 1280×800 PNG | ✅ Ready | `docs/chrome-web-store-assets/screenshot-04-comment-compose-1280x800.png` |
| Screenshot 5 | 1280×800 PNG | 🟡 Refresh after 2.8.0 | `docs/chrome-web-store-assets/screenshot-05-options-1280x800.png` |
| Small Promo Tile | 440×280 PNG | ✅ Ready | `docs/chrome-web-store-assets/promo-tile-440x280.png` |

### Screenshot Notes

The first four screenshots cover the main QuickView, inline editing, related pull requests, and comment composition. The Options screenshot should be refreshed after release to show the final click activation, global copy controls, and Hover Preview layout introduced in 2.8.0.

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `activeTab` | permissions | Lets the user enable Jira QuickView for the current page through the extension toolbar action. |
| `alarms` | permissions | Schedules periodic Settings Sync checks only when the user configures a shared settings source. |
| `declarativeContent` | permissions | Activates Jira QuickView only on the Jira instance and pages the user configured. |
| `scripting` | permissions | Loads Jira QuickView into a page after the user grants access or changes allowed-page settings. |
| `storage` | permissions | Stores the Jira URL, allowed pages, popup layout, activation preferences, and optional Settings Sync configuration. |
| `webNavigation` | permissions | Reapplies configured activation when supported pages navigate without a full browser reload. |
| User-selected website access | optional_host_permissions | Access is requested only for the Jira instance and additional pages the user explicitly saves, so Jira references can be detected and QuickView can communicate with the configured Jira instance. |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** Yes, only to provide requested Jira functionality and settings synchronization; the developer does not receive it.

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|------------|-------------------------|---------|----------------------------|
| Personally identifiable info | Yes | To the configured Jira instance | Display Jira users, assignees, reporters, watchers, mentions, and authors | No; only the user's configured Jira system processes it |
| Health info | No | No | Not used | No |
| Financial info | No | No | Not used | No |
| Authentication info | No | No | The existing browser Jira session is used; credentials are not read or stored | No |
| Personal communications | Yes | To the configured Jira instance when requested | Display and perform user-initiated comment, description, attachment, and worklog actions | No; only the user's configured Jira system processes it |
| Location | No | No | Not used | No |
| Web history | No | No | Not collected | No |
| User activity | Yes | To the configured Jira instance when an action is requested | Perform user-initiated field, workflow, watcher, link, reaction, and time-tracking changes | No; only the user's configured Jira system processes it |
| Website content | Yes | Jira issue keys are sent to the configured Jira instance; shared settings are fetched from the configured source | Detect issue references locally and retrieve the requested issue or team configuration | No developer-run recipient; only user-configured systems |

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
| 2.8.0 | 2026-09-12 | Click and hover activation, deeper and more resilient Jira editing and popup flows, linked-issue management, global copy controls, attachment improvements, and UI reliability fixes | Ready to submit |
| 2.7.0 | 2026-08-16 | Linked issues, settings synchronization, time tracking, watchers, and popup improvements | Published |

## Review Notes

### Known Issues / Limitations

- Jira capabilities vary by Jira Cloud/Data Center version, installed applications, workflow configuration, and user permissions; unavailable operations remain read-only or hidden.
- Live Jira verification requires an authorized Jira account and is separate from the deterministic mocked extension suite.
- The Options screenshot should be refreshed to reflect the 2.8.0 activation controls; the packaged extension behavior and public user guide are current.

### Rejection History

No known rejections are recorded in this repository.
