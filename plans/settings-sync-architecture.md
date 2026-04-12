# Settings Synchronization Architecture

## At A Glance

**Core recommendation**

- Build organization sync as a backend-backed control plane.
- Do not use a shared settings key as the security boundary.
- Use authenticated organization membership for access.
- Publish immutable, versioned settings revisions.
- Let the extension poll for changes and apply them automatically where Chrome permissions allow.
- Preserve local user changes through a layered settings model.

**Configuration layers**

1. Built-in defaults from `jira-plugin/options/config.js`.
2. Organization baseline published by an administrator.
3. Local user overrides where policy allows.
4. Local-only state such as auth, sync metadata, UI tips, caches, and permission prompts.

**Admin publish behavior**

- Admin publishes settings revision `N`.
- Extension fetches revision `N`.
- Extension validates schema and version compatibility.
- Extension stores the new organization baseline.
- Extension recomputes effective settings.
- Locked settings are overwritten.
- Defaulted settings are merged with local overrides.
- Unmanaged settings stay local.

**Most important product decision**

- Do not blindly overwrite every local setting.
- Use per-setting policy:
  - `locked`
  - `default`
  - `unmanaged`

**Simpler MVP option**

- Let users paste a URL to a versioned settings JSON file.
- Extension polls that file.
- Access control is delegated to the file host.
- Best low-complexity variant:
  - store the settings JSON as a Jira attachment
  - rely on Jira project/issue permissions
  - fetch it with the user's existing Jira browser session

---

## Goals

- Let admins publish one settings profile for an organization.
- Let users join an organization.
- Let joined users automatically receive new settings versions.
- Prevent access by guessing an organization key or settings key.
- Keep local customization where it is safe.
- Keep the extension usable offline with the last applied settings.
- Support:
  - version history
  - rollback
  - revocation
  - audit logs
  - schema migrations
- Avoid sending Jira issue data to the sync service.

## Non-Goals

- Do not sync Jira issue data.
- Do not sync comments, attachments, descriptions, or worklogs.
- Do not sync Jira credentials or Jira cookies.
- Do not run remote code in the extension.
- Do not replace Jira authorization.
- Do not promise silent domain activation when Chrome requires a host permission prompt.

---

## Current State

**Current storage**

- Settings are stored in `chrome.storage.sync`.
- Manual JSON export/import exists.
- Team Sync currently shows a placeholder in the Options page.

**Relevant files**

- `jira-plugin/options/config.js`
  - default settings shape
- `jira-plugin/src/chrome.js`
  - wrappers for `chrome.storage.sync.get` and `chrome.storage.sync.set`
- `jira-plugin/options/options.jsx`
  - reads settings
  - saves settings
  - imports and exports JSON
  - refreshes declarative content rules
- `jira-plugin/src/background.js`
  - reads current config for page matching and Jira request checks
- `jira-plugin/src/content.jsx`
  - reads current config for popup behavior
- `docs/privacy-policy.md`
  - currently states there is no developer-run backend

**Privacy impact**

- Team Sync introduces a backend.
- Privacy policy and Chrome Web Store disclosures must be updated before release.

## Sync-Aware Settings

These settings should be eligible for organization sync:

- `instanceUrl`
- `domains`
- `themeMode`
- `hoverDepth`
- `hoverModifierKey`
- `displayFields`
- `tooltipLayout`
- `customFields`

## Local-Only State

These must not be organization-synced:

- `ui_tips_shown`
- sync backend auth tokens
- sync backend refresh tokens
- device IDs
- last sync timestamps
- sync error state
- pending permission state
- field catalogs and other caches
- Jira issue data
- Jira user data
- page contents
- Jira cookies or credentials

---

## Simple File-Based Sync MVP

This is the smallest useful Team Sync design.

Instead of building accounts, organizations, admin UI, SSO, and a sync backend:

- Admin creates a settings JSON file.
- Admin hosts it somewhere users can access.
- User clicks Team Sync.
- User pastes the settings file URL.
- Extension polls the URL.
- Extension applies new versions when the file changes.

This can support real teams if the security model is explicit:

- The extension does not control membership.
- The file host controls access.
- Revocation happens by removing access to the file or replacing the URL.
- Audit history depends on the file host.

### Option A: HTTPS Settings File URL

User flow:

1. Admin exports or creates `jira-quickview-settings.json`.
2. Admin stores it at an HTTPS URL.
3. User opens Team Sync.
4. User pastes the URL.
5. Extension fetches the JSON.
6. Extension stores:
   - sync URL
   - last fetched version
   - last fetched hash
   - last checked timestamp
7. Extension polls periodically.
8. Extension applies new versions.

Good fit:

- public or internal static hosting
- GitHub raw file
- GitLab raw file
- company intranet endpoint
- CDN URL protected by existing company auth

Constraints:

- The URL must return raw JSON.
- The extension needs permission to fetch the URL.
- Some file sharing services make this awkward:
  - Google Drive preview pages are not raw JSON
  - SharePoint links may require cookies or redirects
  - SSO-protected downloads may fail if cookies are not available to extension fetch
- A secret URL is not strong access control by itself.
- Anyone who can fetch the URL can read the settings.

Security model:

- Acceptable when the URL is behind real access control.
- Weak when the URL is only "unguessable".
- No per-user revocation unless the host supports it.
- No central visibility into who has synced.

### Option B: Jira Attachment Settings File

This is likely the better simple version for Jira QuickView.

User flow:

1. Admin creates a Jira issue, for example `OPS-123`.
2. Admin attaches `jira-quickview-settings.json`.
3. Admin grants access through normal Jira project/issue permissions.
4. User clicks Team Sync.
5. User pastes either:
   - Jira issue key plus attachment filename
   - direct Jira attachment URL
6. Extension fetches the attachment using the user's existing Jira browser session.
7. Extension polls for changes.
8. When the attachment changes, extension applies the new settings version.

Why this is attractive:

- No new backend.
- No new account system.
- No SSO integration.
- Uses permissions the organization already manages in Jira.
- Users already need Jira access for the extension to be useful.
- Revocation mostly follows Jira access revocation.
- Admin workflow is understandable:
  - update attachment
  - publish new JSON version

Recommended input format:

```json
{
  "mode": "jiraAttachment",
  "issueKey": "OPS-123",
  "fileName": "jira-quickview-settings.json"
}
```

Better than storing only a raw attachment URL because:

- Jira attachment IDs can change when the file is replaced.
- The extension can look up the latest matching attachment on the issue.
- Admins can replace the file without telling every user a new URL.

Polling flow:

1. Fetch issue metadata for `OPS-123`.
2. Find attachment named `jira-quickview-settings.json`.
3. Compare:
   - attachment ID
   - size
   - created timestamp
   - JSON `settingsRevision`
   - JSON `hash`
4. Download attachment content only when changed.
5. Validate JSON.
6. Apply settings.

Versioning rule:

- The sync source must have a stable lookup target.
- If the admin changes the filename, clients will not discover it automatically.
- The simplest contract is:
  - always upload using the same filename
  - example: `jira-quickview-settings.json`
  - extension selects the newest attachment with that exact filename
  - JSON `settingsRevision` decides whether to apply it

Recommended admin workflow:

1. Download or generate the new settings JSON.
2. Increment `settingsRevision`.
3. Keep the filename exactly `jira-quickview-settings.json`.
4. Attach it to the configured Jira issue.
5. Optionally delete older attachments with the same filename to reduce clutter.

Extension selection logic:

- Fetch the configured issue.
- Filter attachments by exact filename.
- Sort candidates newest first by Jira attachment `created` timestamp.
- Download the newest candidate.
- Apply only if:
  - JSON validates
  - `settingsRevision` is greater than the last applied revision
  - optional hash check passes
- If the newest candidate is invalid:
  - do not fall back silently unless explicitly designed
  - show "latest settings file is invalid"
  - keep the last applied settings

Alternative immutable-file workflow:

- Keep one stable pointer file:
  - `jira-quickview-sync.json`
- Pointer file contains:
  - current settings attachment filename
  - expected `settingsRevision`
  - expected hash
- Admin uploads immutable versioned files:
  - `jira-quickview-settings-v7.json`
  - `jira-quickview-settings-v8.json`
- Admin then uploads a new `jira-quickview-sync.json` pointer.

This preserves history more cleanly, but it is more complex. For MVP, prefer the stable settings filename and select the newest matching attachment.

Jira permission model:

- If user can see the issue and attachment, they can sync.
- If user loses Jira access, future sync fetches fail.
- Last applied config can remain locally available offline.

Trade-off:

- This is not true organization membership.
- It is "whoever can read this Jira issue can read these settings".
- For many teams, that is good enough.

### Suggested JSON Shape

Keep the file self-describing and versioned:

```json
{
  "schemaVersion": 1,
  "settingsRevision": 7,
  "publishedAt": "2026-04-10T12:00:00Z",
  "publishedBy": "admin@example.com",
  "minimumExtensionVersion": "2.3.1",
  "settings": {
    "instanceUrl": "https://example.atlassian.net/",
    "domains": ["github.com", "mail.google.com"],
    "displayFields": {},
    "tooltipLayout": {},
    "customFields": []
  },
  "policy": {
    "instanceUrl": "locked",
    "domains": "default",
    "displayFields": "default",
    "tooltipLayout": "default",
    "customFields": "default",
    "themeMode": "unmanaged"
  }
}
```

Required validation:

- `schemaVersion` is supported.
- `settingsRevision` is greater than last applied revision.
- `minimumExtensionVersion` is compatible.
- `instanceUrl` is a valid URL.
- `domains` are valid match patterns or normalizable host patterns.
- `tooltipLayout` only references known fields or configured custom fields.
- `customFields` are normalized and deduplicated.
- Unknown keys are ignored or rejected.

### Local Storage For Simple Sync

Use `chrome.storage.local`:

```json
{
  "jqv.simpleSync": {
    "enabled": true,
    "sourceType": "jiraAttachment",
    "source": {
      "issueKey": "OPS-123",
      "fileName": "jira-quickview-settings.json"
    },
    "lastRevision": 7,
    "lastHash": "sha256:...",
    "lastCheckedAt": "2026-04-10T12:00:00Z",
    "lastAppliedAt": "2026-04-10T12:00:01Z",
    "status": "synced"
  }
}
```

Do not store the fetched JSON as a secret.

It is configuration, not credentials.

### Applying Local Overrides

Use the same policy model as the backend design:

- `locked`
- `default`
- `unmanaged`

This keeps the simple MVP compatible with the heavier backend later.

It also answers the overwrite question:

- locked fields are overwritten
- default fields merge with local overrides
- unmanaged fields remain local

### Advantages

- Very fast to build.
- No new backend.
- No new billing or account model.
- No SSO complexity.
- Lower operational burden.
- Easier to explain to small teams.
- Jira attachment variant fits the product naturally.
- Can evolve into backend sync later.

### Limitations

- No true organization membership model.
- No central device list.
- No central "who has synced" visibility.
- No reliable per-user revocation beyond host/Jira permissions.
- No built-in admin audit unless the host provides it.
- No staged rollout.
- No server-side validation unless admin uses a separate validator.
- Shared file mistakes affect everyone.
- Public or weakly protected URLs can leak settings.

### Recommended Simple MVP Scope

Ship this before the full backend:

- Team Sync accepts:
  - direct HTTPS JSON URL
  - Jira attachment source
- Jira attachment source supports:
  - issue key
  - attachment filename
- Polling sync through `chrome.alarms`.
- Manual "Sync now".
- Versioned JSON with `schemaVersion` and `settingsRevision`.
- Same policy model:
  - `locked`
  - `default`
  - `unmanaged`
- Same merge behavior as the backend plan.
- Permission-pending handling for new domains.
- Clear warning:
  - access is controlled by the file host or Jira issue permissions

### When To Move Beyond Simple Sync

Move to backend sync when customers need:

- central member management
- device inventory
- per-user revocation independent of Jira/file hosting
- admin audit logs
- policy enforcement reports
- domain self-join
- SSO
- staged rollout
- managed billing
- support visibility into sync health

---

## Configuration Model

### Policy Types

`locked`

- Organization value always wins.
- Local edits are not applied.
- UI should disable or clearly mark the setting.

`default`

- Organization value acts as the team default.
- User can keep a local override.
- User can reset back to organization default.

`unmanaged`

- Organization does not control this setting.
- Setting remains fully local.

### Recommended Default Policy

`instanceUrl`

- Policy: `locked`
- Reason:
  - Members should use the organization's Jira instance.
  - Wrong Jira instance can break data access and confuse users.

`domains`

- Policy: `default`
- Merge style:
  - organization domains plus user-added domains
- Reason:
  - Admins can publish common pages.
  - Users can still enable personal tools.
  - Strict organizations can lock this later.

`displayFields`

- Policy: `default`
- Reason:
  - Teams benefit from shared defaults.
  - Users may still hide fields they do not need.

`tooltipLayout`

- Policy: `default`
- Reason:
  - Team layout is useful.
  - Users may prefer a different order.

`customFields`

- Policy: `default`
- Reason:
  - Admins can publish known Jira custom fields.
  - Users may add fields for their own role.

`themeMode`

- Policy: `unmanaged`
- Reason:
  - Appearance is personal.

`hoverDepth`

- Policy: `default`
- Reason:
  - Admins can reduce noisy behavior.
  - Local ergonomics still matter.

`hoverModifierKey`

- Policy: `default`
- Reason:
  - Keyboard preference is personal enough to preserve.

### Strict Preset

For higher-control organizations, expose a strict admin preset:

- Lock:
  - `instanceUrl`
  - `domains`
  - `displayFields`
  - `tooltipLayout`
  - `customFields`
- Keep local:
  - `themeMode`
  - `hoverDepth`
  - `hoverModifierKey`

---

## Merge Behavior

### Rule

Do not overwrite all local settings on every admin publish.

Use deterministic layering:

```text
effective = defaults
effective = merge(effective, orgBaseline where policy != unmanaged)
effective = merge(effective, localOverrides where policy == default or unmanaged)
effective = merge(effective, locked orgBaseline)
```

### Setting-Specific Merge Rules

Scalars

- Examples:
  - `instanceUrl`
  - `themeMode`
  - `hoverDepth`
  - `hoverModifierKey`
- Merge behavior:
  - assignment

Objects

- Example:
  - `displayFields`
- Merge behavior:
  - merge by key

Ordered layout arrays

- Examples:
  - `tooltipLayout.row1`
  - `tooltipLayout.row2`
  - `tooltipLayout.row3`
  - `tooltipLayout.contentBlocks`
  - `tooltipLayout.people`
- Merge behavior:
  - a local override owns the whole ordered list for that zone

Custom fields

- Example:
  - `customFields`
- Merge behavior:
  - merge by `fieldId`
  - preserve local additions unless the setting is locked

### New Revision Apply Flow

1. Fetch latest organization revision.
2. Validate schema.
3. Check `minimumExtensionVersion`.
4. Compare revision and hash with current baseline.
5. Store the new immutable organization baseline locally.
6. Drop local overrides for newly locked keys.
7. Keep local overrides for defaulted and unmanaged keys.
8. Recompute effective config.
9. Calculate missing host permissions.
10. Apply safe settings immediately.
11. Mark URL/domain changes as pending if Chrome requires permission.
12. Refresh declarative content rules after applicable changes.
13. Show sync status in the Options page.

### Permission-Pending State

Background sync cannot rely on a user gesture.

So:

- It should not try to silently complete host permission prompts.
- It can fetch and store new settings.
- It can apply settings that do not need new permissions.
- It should mark new origins as pending.
- Options or extension action UI should show:
  - "Permissions required"
  - "Grant permissions"

---

## Architecture

### 1. Extension Settings Repository

Purpose:

- Centralize settings reads and writes.
- Replace direct `storageGet(defaultConfig)` calls.

Responsibilities:

- Load defaults.
- Load organization baseline.
- Load local overrides.
- Compose effective config.
- Save local edits as overrides where allowed.
- Save unmanaged settings locally.
- Validate settings.
- Run migrations.
- Support import/export without secrets.

Used by:

- Options page
- background service worker
- content scripts
- sync client

### 2. Extension Sync Client

Runs in:

- service worker
- Options page for manual actions and status

Triggers:

- extension startup
- browser startup
- Options page open
- manual "Sync now"
- `chrome.alarms` interval

Responsibilities:

- Refresh auth tokens.
- Fetch latest organization settings.
- Use `If-None-Match` or `sinceRevision`.
- Validate revision payloads.
- Apply new baselines.
- Track status.
- Report permission-pending state.

### 3. Admin Web App

Responsibilities:

- Create organization.
- Configure work identity self-join.
- Verify domain or provider tenant.
- Create invite links for fallback cases.
- Import current extension JSON.
- Edit settings.
- Choose policy preset.
- Publish immutable revision.
- View audit history.
- Roll back by publishing a copy of an older revision.
- Monitor adoption and sync health.

### 4. Sync API

Responsibilities:

- Authenticate users and extension devices.
- Authorize by organization membership.
- Enforce roles.
- Serve latest settings.
- Store immutable revisions.
- Store audit events.
- Revoke devices and tokens.

Must not handle:

- Jira issue data
- Jira cookies
- page contents
- extension popup data

### 5. Database

Responsibilities:

- Isolate tenants by `org_id`.
- Store users, memberships, devices, invitations, revisions, and audit logs.
- Enforce unique latest revision per organization.
- Support revocation and token rotation.

---

## Extension Storage Layout

Use `chrome.storage.local` for sync state and auth material.

Why:

- Auth should stay local to one browser installation.
- Organization enrollment should not silently follow the user through Chrome profile sync.
- Revocation is easier to reason about.

Suggested keys:

```json
{
  "jqv.sync": {
    "enabled": true,
    "orgId": "org_...",
    "membershipId": "mem_...",
    "deviceId": "dev_...",
    "appliedRevision": 42,
    "appliedHash": "sha256:...",
    "lastCheckedAt": "2026-04-10T12:00:00Z",
    "lastAppliedAt": "2026-04-10T12:00:01Z",
    "status": "synced"
  },
  "jqv.orgBaseline": {
    "schemaVersion": 1,
    "settingsRevision": 42,
    "settings": {},
    "policy": {}
  },
  "jqv.localOverrides": {
    "settings": {},
    "baseRevisionByKey": {}
  },
  "jqv.auth": {
    "accessTokenExpiresAt": "2026-04-10T12:15:00Z"
  }
}
```

Rules:

- Do not export auth tokens.
- Do not export refresh tokens.
- Do not store sync auth in `chrome.storage.sync`.
- Keep existing `chrome.storage.sync` settings as a migration compatibility layer.
- New code should read through the settings repository.

---

## Versioning

Use two version concepts:

`schemaVersion`

- Version of the settings payload shape.
- Drives migrations.

`settingsRevision`

- Organization-specific revision number.
- Monotonically increases.
- Immutable once published.

Example published revision:

```json
{
  "schemaVersion": 1,
  "settingsRevision": 42,
  "orgId": "org_...",
  "createdBy": "user_...",
  "createdAt": "2026-04-10T12:00:00Z",
  "minimumExtensionVersion": "2.3.1",
  "settings": {
    "instanceUrl": "https://example.atlassian.net/",
    "domains": ["github.com", "mail.google.com"],
    "displayFields": {},
    "tooltipLayout": {},
    "customFields": []
  },
  "policy": {
    "instanceUrl": "locked",
    "domains": "default",
    "displayFields": "default",
    "tooltipLayout": "default",
    "customFields": "default"
  },
  "hash": "sha256:..."
}
```

Revision rules:

- Revisions are immutable.
- Rollback creates a new revision.
- The server returns an `ETag` or hash.
- The extension applies only supported schema versions.
- The extension checks `minimumExtensionVersion`.
- Migrations live beside the settings repository.

---

## Join And Access Control

### Principle

Organization IDs are identifiers, not secrets.

Access must require:

- authenticated user
- active organization membership
- active enrolled device
- valid token

Knowing any of these must not be enough:

- `orgId`
- `settingsRevision`
- old settings hash
- expired invite link
- guessed organization slug

### Low-Touch Membership Model

The admin should not have to manage every user manually.

Preferred model:

- Admin creates the organization once.
- Admin proves control of a work identity boundary.
- Users self-join by signing in with that work identity.
- The extension enrolls the user's browser after membership is confirmed.

Good identity boundaries:

- verified email domain
  - example: `company.com`
- Google Workspace hosted domain
- Microsoft Entra tenant
- Atlassian organization or Atlassian account domain
- generic OIDC tenant later

This keeps the workflow simple:

- no shared settings key
- no per-user setup for every employee
- no extension-managed passwords
- no separate Jira credentials
- no manual member list maintenance for normal employees

Invites still matter, but as a fallback:

- bootstrap first owner
- contractors
- external consultants
- teams without a verified domain
- small teams that prefer explicit invites

### Join Options

Work identity self-join

- Recommended default.
- Admin configures one or more allowed identity rules.
- User clicks Team Sync.
- User signs in with Google, Microsoft, Atlassian, or email magic link.
- Backend verifies the user's email domain or provider tenant.
- Backend creates member role automatically when the rule matches.
- Admin sees the user after they join.

Domain verification

- Admin proves control of a domain.
- Verification options:
  - DNS TXT record
  - verified Google Workspace domain
  - verified Microsoft tenant domain
  - admin email challenge for smaller teams
- Strongest option:
  - DNS TXT or provider tenant verification
- Simplest acceptable option for small teams:
  - email magic link to an admin address on the domain
  - lower assurance than DNS or tenant verification

Provider tenant self-join

- Admin connects an identity provider tenant.
- Backend stores provider and tenant ID.
- Users join automatically only if their login belongs to that tenant.
- This is easier than managing users one by one.
- Enterprise SAML can come later if needed.

Invitation link

- Fallback path.
- Admin creates invite.
- Backend generates high-entropy opaque token.
- Store only token hash server-side.
- Invite expires.
- Invite can be revoked.
- Invite can be domain-restricted.
- Invite can be single-use or limited-use.
- User signs in before membership is created.

Manual allowlist

- Optional fallback.
- Admin preloads emails or groups.
- User still signs in.
- Backend checks allowlist before joining.
- Not recommended as the primary workflow.

### Device Enrollment

1. User clicks Team Sync in Options.
2. Extension starts hosted sign-in.
3. Backend authenticates the user.
4. Backend confirms organization membership.
5. Backend creates or reuses device enrollment.
6. Backend returns:
   - short-lived access token
   - rotating refresh token
   - organization metadata
7. Extension stores auth locally.
8. Extension fetches latest settings.

### Manifest Additions

Add only what the feature needs:

- `identity`
  - only if using `chrome.identity.launchWebAuthFlow`
- `alarms`
  - for periodic background sync
- fixed sync API host permission
  - example: `https://sync.jiraquickview.example/*`
  - avoid arbitrary sync endpoint configuration

---

## API Shape

Minimal API:

```text
POST   /v1/auth/device/start
POST   /v1/auth/device/complete
POST   /v1/auth/refresh

GET    /v1/orgs/discover
POST   /v1/orgs/:orgId/join-rules
POST   /v1/orgs/:orgId/invitations
POST   /v1/invitations/:token/accept

GET    /v1/orgs/:orgId/settings/latest
GET    /v1/orgs/:orgId/settings/revisions
POST   /v1/orgs/:orgId/settings/revisions
POST   /v1/orgs/:orgId/settings/validate

GET    /v1/orgs/:orgId/members
PATCH  /v1/orgs/:orgId/members/:memberId
DELETE /v1/orgs/:orgId/devices/:deviceId
```

Authorization rules:

- Member:
  - read latest settings for their organization
- Admin:
  - publish settings revisions
  - manage invitations
  - manage join rules
  - manage members
- Owner:
  - manage billing
  - delete organization
  - manage admin roles
- Device token:
  - fetch settings only for the bound user, org, membership, and device

Operational protections:

- Rate-limit:
  - auth attempts
  - invite acceptance
  - settings fetches
- Log:
  - publish
  - rollback
  - invite created
  - invite accepted
  - role changed
  - device revoked
  - member removed
- Reject:
  - unknown setting keys
  - invalid URLs
  - invalid match patterns
  - huge arrays
  - unsupported schema versions
- Use CORS for browser hygiene.
- Do not rely on CORS for authorization.

---

## Database Model

Suggested relational model:

```text
organizations
  id
  name
  slug
  verified_domain
  status
  created_at

org_join_rules
  id
  org_id
  rule_type
  email_domain
  identity_provider
  provider_tenant_id
  status
  created_by
  created_at
  revoked_at

users
  id
  email
  name
  identity_provider
  provider_subject
  created_at

memberships
  id
  org_id
  user_id
  role
  status
  created_at
  removed_at

devices
  id
  org_id
  user_id
  membership_id
  extension_id
  name
  created_at
  last_seen_at
  revoked_at

invitations
  id
  org_id
  token_hash
  created_by
  role
  expires_at
  max_uses
  use_count
  revoked_at

settings_revisions
  id
  org_id
  revision
  schema_version
  payload_json
  policy_json
  hash
  created_by
  created_at
  minimum_extension_version

settings_latest
  org_id
  revision
  hash
  updated_at

audit_events
  id
  org_id
  actor_user_id
  actor_device_id
  event_type
  target_id
  metadata_json
  created_at

refresh_tokens
  id
  device_id
  token_hash
  expires_at
  rotated_at
  revoked_at
```

Database safeguards:

- Scope all records by `org_id`.
- Enforce one latest revision per organization.
- Enforce unique revision numbers per organization.
- Store invitation tokens and refresh tokens as hashes.
- Use row-level security if using Postgres.
- Add authorization tests for cross-tenant access.

---

## Admin UX

Admin flow:

1. Create organization.
2. Configure self-join:
   - verified email domain
   - Google Workspace domain
   - Microsoft Entra tenant
   - Atlassian organization/domain
3. Keep invite links as fallback for contractors or small teams.
4. Import settings JSON or start from defaults.
5. Choose policy preset:
   - Balanced
   - Strict
6. Validate settings.
7. Preview diff.
8. Publish revision.
9. Share "connect Team Sync" instructions.
10. Monitor rollout.

Admin should see:

- current latest revision
- publish history
- rollback action
- self-join rules
- members
- enrolled devices
- devices behind latest revision
- devices with permission-pending state
- sync failures

## Member UX

Member flow:

1. Click Team Sync in Options.
2. Sign in with work identity.
3. Backend discovers matching organizations.
4. Select organization if more than one matches.
5. Review managed settings.
6. Grant host permissions if Chrome asks.
7. See current sync status.
8. Edit allowed local preferences.
9. Reset local overrides when needed.
10. Disconnect organization sync when needed.

Invite fallback:

- User opens invite link.
- User signs in.
- Backend accepts invite only if:
  - invite is active
  - invite is not expired
  - invite has remaining uses
  - optional domain restriction matches

Member-facing statuses:

- `Synced`
- `Update available`
- `Permissions required`
- `Offline`
- `Disconnected`
- `Sync failed`

Managed UI indicators:

- locked field
- managed default
- local override active
- reset to organization default
- pending permission

---

## Chrome Permission Constraints

Automatic pickup is possible for pure configuration values.

Automatic activation is not always possible for new origins.

Why:

- `instanceUrl` and `domains` can require optional host permissions.
- Chrome may require a user gesture for permission prompts.
- Background polling may not be allowed to show the prompt.

Design response:

- Fetch new settings automatically.
- Store the new baseline automatically.
- Apply safe settings automatically.
- Mark new URL/domain permissions as pending.
- Prompt through Options or extension action.
- Warn admins when a revision adds new origins.
- If enterprise policy pre-approves origins, apply without member action.

---

## Security And Privacy

### Data The Sync Service Should Handle

- organization metadata
- membership metadata
- device metadata
- settings payloads
- settings policies
- revision metadata
- audit events
- sync status metadata

### Data The Sync Service Should Not Handle

- Jira issue keys from pages
- full page contents
- Jira cookies
- Jira API tokens
- Jira API responses
- comments
- descriptions
- attachments
- worklogs
- popup cache
- user edits performed in Jira

### Threats And Mitigations

User guesses organization key

- Mitigation:
  - org IDs are not secrets
  - require authenticated active membership

Invite token brute force

- Mitigation:
  - high-entropy tokens
  - hashed at rest
  - expiry
  - use limits
  - rate limits

Former employee keeps access

- Mitigation:
  - revoke membership
  - revoke refresh tokens
  - revoke enrolled devices
  - clear baseline on next online revocation response

Local user tampers with settings

- Mitigation:
  - tampering affects only that browser
  - locked settings are restored on next sync

Cross-tenant data leak

- Mitigation:
  - scope every query by `org_id`
  - use database constraints
  - use row-level security where available
  - test cross-tenant access

Malicious settings payload

- Mitigation:
  - server-side schema validation
  - extension-side schema validation
  - no remote code
  - strict URL and match-pattern validation

Token leakage through Chrome sync

- Mitigation:
  - store auth in `chrome.storage.local`
  - never export tokens

Compromised admin account

- Mitigation:
  - audit logs
  - optional SSO/MFA
  - role separation
  - rollback

Network tampering

- Mitigation:
  - HTTPS
  - short-lived access tokens
  - response hash
  - optional signed settings payload later

---

## Trade-Offs

### Backend Control Plane Vs Shared Settings Key

Backend benefits:

- real membership checks
- revocation
- audit history
- version history
- device tracking
- non-guessable access

Backend costs:

- hosting
- auth
- database
- operations
- privacy disclosure changes

Recommendation:

- Use a backend.
- A shared key is not acceptable as the security boundary.

### Layered Merge Vs Always Overwrite

Layered merge benefits:

- preserves useful local preferences
- avoids surprise overwrites
- supports both strict and flexible organizations

Layered merge costs:

- more implementation complexity
- more UI states
- more tests

Recommendation:

- Use layered merge.
- Keep policies coarse:
  - `locked`
  - `default`
  - `unmanaged`

### Admin Locks Vs User Freedom

Locks benefit:

- enforce critical settings
- reduce drift
- support stricter organizations

Locks cost:

- can frustrate users
- requires clear UI explanation

Recommendation:

- Lock only org-critical settings by default.
- Let admins opt into stricter presets.

### Polling Vs Push

Polling benefits:

- simple
- reliable in Manifest V3
- works with `chrome.alarms`
- no persistent connection

Polling costs:

- settings are not instant
- service worker lifetime can delay checks

Recommendation:

- Use polling for MVP.
- Add manual "Sync now".

### Local Storage Vs Chrome Sync Storage

Local storage benefits:

- auth stays on one browser installation
- safer revocation model
- avoids accidental Chrome account propagation

Local storage costs:

- user enrolls each browser/profile separately

Recommendation:

- Store sync auth and org baseline in `chrome.storage.local`.

### Full Snapshots Vs Patches

Full snapshot benefits:

- simple validation
- simple rollback
- easy audit
- small enough for extension settings

Full snapshot costs:

- larger payloads than patches
- less granular diff history

Recommendation:

- Use full snapshots for MVP.

### Self-Join Work Identity Vs Manual Invites

Self-join benefits:

- low-touch administration
- no per-user invite management for normal employees
- familiar user flow
- better fit for a convenience extension

Self-join costs:

- requires identity provider integration
- requires domain or tenant verification
- needs careful org discovery logic

Recommendation:

- Make work identity self-join the primary flow.
- Keep invite links as a fallback.
- Start with Google/Microsoft/email domain verification before enterprise SAML.

### HTTPS/Auth/Hash Vs Signed Payloads

HTTPS/auth/hash benefits:

- simpler MVP
- enough when schema forbids executable content

HTTPS/auth/hash costs:

- compromised backend could still serve bad settings within schema limits

Recommendation:

- Use HTTPS, auth, and hashes for MVP.
- Add signed payloads if customers need stronger assurance.

---

## Risk Register

### Privacy Posture Changes

Impact:

- Chrome Web Store review risk
- user trust risk

Likelihood:

- High

Mitigation:

- Update privacy policy before release.
- Update user guide.
- Update Web Store disclosures.
- Keep synced data limited to settings and metadata.

### Host Permissions Cannot Apply Silently

Impact:

- users may think sync is broken
- new domains may not activate immediately

Likelihood:

- High

Mitigation:

- Track permission-pending state.
- Prompt from Options or extension action.
- Warn admins before publishing new origins.

### Merge Behavior Confuses Users

Impact:

- users may not understand why settings changed or did not change

Likelihood:

- Medium

Mitigation:

- Show managed badges.
- Show locked badges.
- Show local override indicators.
- Add reset controls.

### Local Override Model Becomes Too Complex

Impact:

- more bugs
- harder support
- confusing settings behavior

Likelihood:

- Medium

Mitigation:

- Keep policies coarse.
- Avoid nested per-field policies in MVP.
- Test effective config composition heavily.

### Revocation Is Delayed On Offline Devices

Impact:

- removed member keeps last applied settings while offline

Likelihood:

- Medium

Mitigation:

- Do not sync secrets.
- Do not sync Jira credentials.
- Block future fetches immediately after revocation.
- Clear org baseline on next online revocation response.
- Document offline behavior.

### Token Theft From Local Browser Profile

Impact:

- attacker with local profile access could fetch settings until expiry or revocation

Likelihood:

- Low to Medium

Mitigation:

- Short-lived access tokens.
- Rotating refresh tokens.
- Device revocation.
- Local-only auth storage.

### Cross-Tenant Authorization Bug

Impact:

- organization settings could leak

Likelihood:

- Low, but severe

Mitigation:

- Scope every query by `org_id`.
- Add database constraints.
- Use row-level security where available.
- Add cross-tenant authorization tests.

### Admin Publishes Bad Settings

Impact:

- many users receive broken config

Likelihood:

- Medium

Mitigation:

- Validate before publish.
- Show diff before publish.
- Support rollback.
- Add staged rollout later if needed.

### Migration Breaks Existing Local Setup

Impact:

- users may perceive data loss on first org join

Likelihood:

- Medium

Mitigation:

- Preview differences before applying org baseline.
- Preserve current local settings as overrides where policy allows.

### Backend Availability Affects Sync

Impact:

- users cannot receive new versions during outage

Likelihood:

- Medium

Mitigation:

- Use last applied settings offline.
- Make sync failure non-blocking for popup usage.

### Billing Or Entitlement Complexity

Impact:

- access rules may become tangled with sync logic

Likelihood:

- Medium

Mitigation:

- Keep entitlement checks server-side.
- Keep billing state out of settings merge logic.

### Self-Join Rule Is Too Broad

Impact:

- wrong users may join an organization
- organization settings may be exposed to unintended users

Likelihood:

- Medium

Mitigation:

- Prefer provider tenant verification over plain email-domain matching.
- Let admins review active join rules.
- Log every auto-join event.
- Allow admins to disable self-join immediately.
- Use invite-only fallback for organizations that cannot prove a domain or tenant.

### Extension Version Skew

Impact:

- older extensions may not understand new settings schema

Likelihood:

- Medium

Mitigation:

- Include `minimumExtensionVersion`.
- Add schema migrations.
- Add server compatibility checks.

---

## Implementation Plan

### Phase 1: Local Settings Foundation

Build the local foundation first.

Tasks:

- Add settings schema module.
- Add normalization and validation.
- Add settings repository.
- Replace direct config reads in:
  - Options page
  - background worker
  - content script
- Keep current behavior unchanged.
- Add unit tests for:
  - normalization
  - import validation
  - effective config composition
- Keep existing import/export E2E coverage passing.

### Phase 2: Layered Local Overrides

Add organization-ready local behavior before adding the backend.

Tasks:

- Add local structures:
  - `orgBaseline`
  - `localOverrides`
  - `policy`
- Implement merge algorithm.
- Add per-setting reset.
- Update Options UI to show:
  - managed setting
  - locked setting
  - local override
  - unmanaged setting
- Disable locked controls.
- Keep import/export secret-free.
- Add tests for:
  - locked overwrite
  - default merge
  - local override preservation
  - custom field merging
  - layout merging

### Phase 3: Backend MVP

Build the minimum server path.

Tasks:

- Create Sync API.
- Create admin web app.
- Create database schema.
- Implement:
  - organization creation
  - invitations
  - membership
  - auth
  - settings publish
  - latest settings fetch
  - audit events
- Add server-side settings validation.
- Add immutable revision history.
- Add local API fixtures for extension E2E tests.

### Phase 4: Extension Enrollment And Polling

Connect the extension to the server.

Tasks:

- Replace Team Sync placeholder.
- Add connect flow.
- Use either:
  - `chrome.identity.launchWebAuthFlow`
  - device-code flow
- Store device auth locally.
- Add `chrome.alarms` polling.
- Fetch latest settings on:
  - startup
  - Options page open
  - manual "Sync now"
  - alarm interval
- Apply revisions.
- Track permission-pending state.
- Refresh declarative mapping.
- Expose status in Options.
- Use last applied config offline.

### Phase 5: Admin Management

Make it manageable for real teams.

Tasks:

- Add publish notes.
- Add rollback.
- Add member list.
- Add device list.
- Add device revocation.
- Add policy presets.
- Add per-setting policy editing.
- Add adoption reporting:
  - device last seen
  - applied revision
  - pending permissions
  - sync failures
- Add stronger SSO options if Google, Microsoft, Atlassian, and email-domain rules are not enough.

### Phase 6: Hardening And Release

Prepare for production release.

Tasks:

- Add rate limits.
- Add abuse monitoring.
- Add audit log export.
- Add token rotation tests.
- Add revocation tests.
- Update:
  - privacy policy
  - user guide
  - Chrome Web Store disclosures
  - onboarding copy
- Add E2E tests for:
  - join
  - sync
  - permission pending
  - local overrides
  - revocation
  - rollback
- Add migration flow for existing users:
  - preview differences
  - preserve current local settings as overrides where allowed

---

## Testing Strategy

### Unit Tests

- Settings schema validation.
- Current config migration to schema version 1.
- Merge behavior:
  - locked
  - default
  - unmanaged
- Permission diff calculation for `domains`.
- `customFields` merge by `fieldId`.
- `tooltipLayout` ordered-list behavior.
- Import/export secret exclusion.

### Extension E2E Tests

- User connects to organization.
- User receives latest revision.
- Admin publishes new revision.
- Extension picks up new revision.
- Local default override survives admin publish.
- Locked setting overwrites local change.
- Added domain creates permission-pending state.
- Revoked user no longer fetches updates.
- Offline startup uses last applied config.
- Import/export does not include secrets.

### Backend Tests

- Non-member cannot fetch settings with guessed `orgId`.
- Expired invite token fails.
- Reused single-use invite token fails.
- Matching verified-domain user can self-join.
- Non-matching domain user cannot self-join.
- Matching provider tenant user can self-join.
- Non-matching provider tenant user cannot self-join.
- Member can read latest settings only for their organization.
- Admin-only publish is enforced.
- Revision numbers are immutable.
- Revision numbers are monotonic per organization.
- Refresh token rotation works.
- Device revocation works.
- Cross-tenant access is blocked.

---

## Open Product Decisions

- Is Team Sync paid-only?
- Should there be a free organization limit?
- Which identity provider ships first?
  - email magic link
  - Google
  - Microsoft
  - Atlassian
  - SAML/OIDC
- What verification level is acceptable for the first release?
  - DNS TXT
  - Google Workspace hosted domain
  - Microsoft tenant domain
  - admin email challenge
- Should `customFields` be defaulted or locked in the default admin preset?
- Should `tooltipLayout` be defaulted or locked in the default admin preset?
- Should organization enrollment sync across a user's Chrome profile?
  - safer default: no
- Should signed settings payloads be part of MVP?
  - recommended default: no
  - add later if needed
- Should admins get staged rollout?
  - recommended default: no for MVP
  - add if bad-publish risk becomes material

---

## Recommended MVP Scope

Ship this first:

- Low-touch organizations based on work identity self-join.
- Email, Google, or Microsoft sign-in.
- Verified domain or provider tenant join rule.
- Invite links only as fallback.
- One organization profile per member.
- Immutable full-snapshot revisions.
- Polling sync.
- Manual "Sync now".
- Local-only device enrollment.
- Manual rollback by publishing an older revision as a new revision.

Default policy preset:

- `instanceUrl`
  - locked
- `domains`
  - default
- `displayFields`
  - default
- `tooltipLayout`
  - default
- `customFields`
  - default
- `hoverDepth`
  - default
- `hoverModifierKey`
  - default
- `themeMode`
  - unmanaged

This MVP gives:

- centralized management
- automatic pickup of new settings
- version history
- access control
- revocation
- rollback
- local flexibility

It avoids overbuilding:

- SSO
- push delivery
- signed payloads
- complex per-field conflict resolution
- staged rollout
