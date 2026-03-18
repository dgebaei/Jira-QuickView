# Comment Reactions Plan

## Goal
- Add emoji reactions to comments in the popup.

## Current Discovery
- The target Jira instance appears to expose a private endpoint:
  - `POST /rest/internal/2/reactions`
- Observed payload:

```json
{
  "commentId": "545039",
  "emojiId": "1f44d"
}
```

## Implementation Status
- Feasible in principle.
- Experimental because this is a Jira internal API, not a stable public API.

## Required Verification Before Full Build
- confirm read/list endpoint for existing reactions
- confirm whether the same endpoint toggles, adds only, or needs a delete endpoint
- confirm response shape for optimistic UI updates
- confirm whether extension requests need extra CSRF handling or page-context fetch

## Expected UI
- Show a compact reaction bar under each comment.
- Support a small initial emoji set, e.g. thumbs up, eyes, laugh.
- Highlight the current user's selected reactions.

## Code Areas
- `jira-plugin/src/content.jsx`
  - preserve `comment.id`
  - load reaction metadata per comment
  - add reaction click handlers and local state
- `jira-plugin/resources/annotation.html`
  - reaction bar markup per comment
- `jira-plugin/src/content.scss`
  - reaction pill/button styles
- `jira-plugin/src/background.js`
  - possibly extend request transport for private/internal endpoints and CSRF headers

## Risks
- Private API may break across Jira upgrades.
- Background fetch may not match browser page behavior for internal endpoints.
- Read endpoint is still unknown.
- Toggle/remove semantics are still unknown.

## Recommended Build Order
- Start with endpoint verification and read-path discovery.
- Only proceed to UI once create/read/toggle behavior is confirmed from extension context.

## Tests
- render existing reactions
- add reaction
- toggle/remove reaction
- handle request failures without corrupting UI state
- hide reaction UI if endpoint verification fails
