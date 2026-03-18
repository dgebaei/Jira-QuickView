# Environment Field Plan

## Goal
- Display Jira `environment` in popup row 3.
- Allow editing it from the popup with explicit `Save` / `Discard`.

## Scope
- Add built-in display-field support for `environment` in row 3.
- Fetch the field in issue metadata.
- Reuse existing field edit lifecycle where possible.
- Add a free-text editor variant for multiline values.

## Jira API
- Read from `fields.environment`.
- Check editability from `GET /rest/api/2/issue/{key}/editmeta` via `fields.environment`.
- Save with:

```json
{
  "fields": {
    "environment": "new text"
  }
}
```

to `PUT /rest/api/2/issue/{key}`.

## Code Areas
- `jira-plugin/src/content.jsx`
  - include `environment` in issue fetch
  - add row-3 chip builder
  - add `environment` editor definition
  - add free-text editor support
- `jira-plugin/resources/annotation.html`
  - support textarea editor rendering
- `jira-plugin/src/content.scss`
  - style textarea editor
- `jira-plugin/options/config.js`
  - add `displayFields.environment`
- `jira-plugin/options/options.jsx`
  - expose Environment under row 3

## UX
- Show `Environment: --` when empty.
- Truncate long display text in row 3.
- Use multiline editor in popup, not inline chip text entry.

## Risks
- Some Jira instances may hide the built-in field from edit screens.
- A custom field named Environment may exist separately; v1 should support built-in `environment` only unless fallback is explicitly required.
- Current edit architecture is optimized for select/search, not free text.

## Tests
- options page shows Environment in row 3 settings
- popup renders Environment when enabled
- edit affordance only shows when `editmeta` allows it
- save refreshes popup state
- failed save preserves draft and shows inline error
