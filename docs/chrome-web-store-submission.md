# Chrome Web Store Submission Checklist

This checklist is tailored to the current `jira-plugin/manifest.json` and current behavior in the repository as of 2026-04-12.

## 1. Account And Publisher Setup

- [ ] Create or sign in to the Chrome Web Store developer account.
- [ ] Pay the one-time developer registration fee.
- [ ] Enable 2-step verification on the Google account used for publishing.
- [ ] Verify the Chrome Web Store contact email.
- [ ] Decide the publisher name that should appear in the store listing.
- [ ] Decide whether to verify an official publisher site for the listing.

## 2. Packaging

- [ ] Run `npm run release:zip`.
- [ ] Confirm the artifact was created at `jira-quickview-<version>-chrome-web-store.zip`.
- [ ] Confirm the ZIP root contains `manifest.json`, not a top-level enclosing folder.
- [ ] Confirm the ZIP contains only the runtime files Chrome needs:
- `manifest.json`
- `build/background.js`
- `build/main.js`
- `options/options.html`
- `options/build/options.js`
- `resources/*`

## 3. Graphic Assets

- [ ] Export at least one store screenshot at exactly `1280x800` or `640x400`.
- [ ] Create the required small promo tile at exactly `440x280`.
- [ ] Use the existing repo screenshots as source material, then resize/crop store copies.

Recommended screenshot order for the first five store screenshots:

1. `docs/screenshots/marketing-hidpi-light/popup-overview.png`
2. `docs/screenshots/marketing-hidpi-light/popup-inline-editor.png`
3. `docs/screenshots/marketing-hidpi-light/popup-comment-compose.png`
4. `docs/screenshots/marketing-hidpi-light/popup-pull-requests.png`
5. `docs/screenshots/marketing-hidpi-light/options-basic-overview.png`

## 4. Store Listing Fields

Suggested values:

- Name: `Jira QuickView`
- Summary: `Act on Jira issues from Gmail, Outlook, GitHub, and other enabled pages without opening a new Jira tab.`
- Category: `Productivity`
- Language: `English`
- Homepage URL: `https://dgebaei.github.io/Jira-QuickView/`
- Support URL: `https://github.com/dgebaei/Jira-QuickView/issues`
- Content rating: `Not mature`

Suggested detailed description:

> Jira QuickView turns Jira issue keys in notification emails, pull requests, release notes, docs, and other enabled pages into actionable issue popups. Open a Jira email in Gmail or Outlook, hover the issue key in the message, and inspect or triage the ticket directly from your inbox. The same workflow applies on GitHub and any other page you enable.
>
> The popup shows Jira issue details such as status, priority, labels, sprint, fix versions, custom fields, comments, attachments, history, reporter and assignee details, and linked pull request information already available through Jira. It also supports in-context Jira actions such as field updates, workflow transitions, comments, attachment handling, and related quick actions when your Jira permissions allow them.
>
> Jira QuickView uses your existing Jira browser session and does not require a separate Jira password inside the extension. You choose which pages can run the extension, set your Jira instance URL, and customize which Jira fields and layout appear in the popup.

## 5. Privacy Tab Copy

### Single Purpose Description

Use this for the Chrome Web Store single-purpose field:

> Detect Jira issue keys on pages the user enables, show Jira issue details in a hover popup, and let the user perform Jira actions without leaving the current page.

### Permission Justifications

Use wording close to the following for each permission shown in the dashboard.

`activeTab`

> Lets the user click the extension action to enable Jira QuickView on the current page and grant site access for that page.

`declarativeContent`

> Limits content script activation to pages the user has enabled instead of injecting on every page automatically.

`scripting`

> Injects the extension content script into user-enabled pages so Jira keys can be detected locally and the popup can be rendered.

`storage`

> Saves the Jira instance URL, enabled page patterns, popup layout, custom field settings, theme, Team Sync source details, and other extension preferences.

`webNavigation`

> Detects matching frame navigations on supported sites so the content script can be injected into dynamic pages and embedded frames when needed.

`*://*/*` optional host access

> Optional site access is requested only when the user explicitly enables Jira QuickView for a page, saves allowed pages in settings, or configures Settings Sync with a shared settings URL. Suggested starting points in the UI include github.com, mail.google.com, and outlook.office.com, but none are enabled automatically on install. The extension does not automatically activate on every site or fetch shared settings from arbitrary sites without user configuration.

### Remote Code Declaration

Use:

> No. This extension does not use remote code.

### Privacy Policy URL

- [ ] Publish the Pages-hosted privacy policy URL before submission.
- [ ] Paste the public URL `https://dgebaei.github.io/Jira-QuickView/privacy-policy.html` into the Chrome Web Store privacy policy field after Pages is live.

### Data Use Disclosure Guidance

The Chrome Web Store UI can change, so verify the exact checkbox labels at submission time. Based on the current implementation, be prepared to disclose only the data categories your final build actually handles:

- Extension settings stored in Chrome storage
- Team Sync source details and shared settings metadata stored in Chrome storage
- Page text/content on user-enabled pages for Jira-key detection
- Jira account/session-connected data shown in the popup
- Shared Team Sync configuration data loaded from a user-configured URL or Jira attachment
- User-generated Jira content such as comments, edits, and attachments when the user initiates those actions

Do not claim analytics, advertising, sale of data, or remote-code behavior unless the implementation changes.

## 6. Distribution And Review Settings

- [ ] Choose `Public` for launch, or `Unlisted`/`Private` if you want a prelaunch review first.
- [ ] Add supported regions if you want to narrow availability.
- [ ] If you have a Jira review environment, add reviewer instructions and test credentials in the optional Test Instructions tab.

Suggested reviewer note if you can provide a Jira test account:

> Jira QuickView requires a Jira instance URL and a logged-in Jira browser session to demonstrate its full feature set. Reviewer steps:
> 1. Open the extension options page.
> 2. Set the Jira instance URL to `[replace-with-review-instance-url]`.
> 3. Save the settings.
> 4. Open a page containing Jira keys such as `[replace-with-sample-keys]`.
> 5. Hover a key to open the popup.
> 6. Use the provided review account to test read and edit flows described below.
>
> Review credentials:
> Username: `[replace]`
> Password or SSO notes: `[replace]`

## 7. Current Review Risks In This Manifest

- [ ] Broad optional host access is present as `*://*/*`. Keep the justification clear and user-triggered.
- [ ] A public privacy policy URL is still required before submission.
- [ ] Store screenshots still need exact Chrome Web Store dimensions even though the repo already contains high-resolution marketing images.
- [ ] If you can narrow optional host access before launch, review risk will likely be lower.

## 8. Generated Asset Locations

Generated store-ready assets live in `docs/chrome-web-store-assets/`:

- `promo-tile-440x280.png`
- `screenshot-01-overview-1280x800.png`
- `screenshot-02-inline-editing-1280x800.png`
- `screenshot-03-pull-requests-1280x800.png`
- `screenshot-04-comment-compose-1280x800.png`
- `screenshot-05-options-1280x800.png`
