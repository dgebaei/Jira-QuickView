# Comment Edit/Delete Plan

## Goal
- Allow users to edit and delete their own comments from the popup.

## Jira API
- Edit comment:
  - `PUT /rest/api/2/issue/{issueKey}/comment/{commentId}`
- Delete comment:
  - `DELETE /rest/api/2/issue/{issueKey}/comment/{commentId}`

Edit payload:

```json
{
  "body": "updated comment text"
}
```

## Ownership Detection
- Use comment author from `issueData.fields.comment.comments`.
- Compare against current user using existing Jira user comparison logic.
- Extend comment display models to retain:
  - `id`
  - raw `body`
  - author identity
  - `isOwnedByCurrentUser`

## UX
- Show `Edit` and `Delete` actions only on owned comments.
- Allow only one comment edit session at a time.
- Replace comment body with an inline textarea while editing.
- Use inline delete confirmation, not `window.confirm()`.

## Refresh Strategy
- After successful edit or delete, invalidate cached issue data and rerender via existing popup refresh flow.

## Code Areas
- `jira-plugin/src/content.jsx`
  - enrich comment view model
  - add comment edit/delete state
  - add save/cancel/delete handlers
- `jira-plugin/resources/annotation.html`
  - add action buttons and inline editor/confirm states
- `jira-plugin/src/content.scss`
  - style comment action controls and editor

## Risks
- Current comment composer is partly DOM/global-state driven; edit/delete should use popup state for stability.
- Jira permissions may still reject updates even for apparently owned comments.
- Need to avoid collisions with the existing new-comment composer.

## Tests
- owned comments show actions
- non-owned comments do not
- edit success updates rendered body after refresh
- delete success removes comment
- failure preserves draft and shows error
