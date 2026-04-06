# Description Editor — Implementation Plan

## Overview

Add a first-class Description editing experience to the popup.

Goals:
- always show the Description section, even when the issue has no description
- allow inline editing directly inside the Description block
- support pasted images in the description editor
- show Save / Cancel controls and inline success / failure feedback in the section title bar
- keep the saved result consistent with Jira-rendered output after refresh
- preserve a polished, low-friction user experience

This should be implemented as a **section-level editor**, not by reusing the small field-chip edit popover system.

---

## Current State

Two current behaviors drive the problem:

1. The Description section is hidden when empty.
   - In `jira-plugin/resources/annotation.html`, the actual section title and body are wrapped in `{{#description}}`.
   - If `displayData.description` is empty, the popup effectively renders no Description section at all.

2. Issue data is cached, so external Jira edits can remain invisible for a while.
   - Issue metadata is cached in memory for 60 seconds.
   - Reopening the popup on the same page can keep showing the stale “empty description” state until a real refetch happens.

So today, a description added in Jira is **not guaranteed** to appear immediately in the popup on reopen.

---

## UX Proposal

### Default Display State

- The Description section is always visible.
- The section title bar always shows `Description`.
- If the description is empty:
  - show placeholder body text such as `No description yet.`
  - show a stronger edit affordance so the action is obvious
- If the description is not empty:
  - show the rendered Jira description as today
  - show a subtler edit affordance in the title bar

### Edit Affordance

Recommended behavior:
- non-empty description: always-visible but subtle pencil icon button in the title bar
- empty description: always-visible `Edit` button in the title bar

This keeps the feature discoverable without making the section visually noisy.

### Edit Mode

When edit is activated:
- the section title bar becomes an editor header
- the body switches to a large editable area
- the header shows:
  - `Description`
  - inline status text for saving / success / error
  - `Cancel` and `Save` buttons on the right

The editor should:
- support multiline text naturally
- keep Enter as newline, not Save
- optionally support `Ctrl/Cmd+Enter` as Save

### Formatting

For V1, use a lightweight wiki-markup toolbar instead of a full rich-text editor.

Recommended buttons:
- Bold
- Italic
- Underline
- Bullet list
- Numbered list
- Link
- Code / noformat

These actions should wrap or prefix the current selection with Jira wiki markup, not attempt true WYSIWYG editing.

### Images

Support image paste in the editor:
- paste image
- upload it as a Jira attachment
- insert `!filename!` markup into the description draft
- keep a local preview-safe image mapping so the user does not lose confidence before save

Other attachment types are optional and can be skipped in V1.

---

## Why This Should Not Use The Chip Editor

The generic field edit system is built for compact popover-style editors.

Description editing needs:
- a large editable area
- inline section-level controls
- pasted image upload support
- richer keyboard behavior
- section-specific success / failure feedback
- more careful refresh semantics after save

So this should be implemented with a dedicated Description editor state and view path.

---

## Technical Direction

### 1. Always Render The Description Section

Update the Description template so the section itself is always present.

Instead of gating the section on `{{#description}}`, render:
- a section title bar always
- either:
  - rendered description content
  - or an empty-state placeholder
  - or the editor UI when editing

This will require new display flags in the popup display data such as:
- `descriptionHasContent`
- `descriptionEmptyText`
- `descriptionEditable`
- `descriptionEditing`
- `descriptionSaving`
- `descriptionStatusMessage`
- `descriptionStatusKind`

### 2. Add Dedicated Description Edit State

Do not fold this into the current `editState` used by small field editors.

Track a separate description editor state, for example:
- `open`
- `inputValue`
- `saving`
- `errorMessage`
- `statusMessage`
- `statusKind`
- `selectionStart`
- `selectionEnd`
- `hadFocus`
- `uploadState`
- `sessionAttachmentIds`

This mirrors what already works well in the comment composer but keeps Description editing independent.

### 3. Reuse The Existing Attachment Upload Path

The comment composer already has the right building blocks:
- clipboard image detection
- deterministic pasted-image filename generation
- upload via background message
- local `data:` preview mapping
- cleanup of uploaded attachments on discard

The best approach is to extract or share the reusable parts instead of re-implementing them inside the Description editor.

Description editing should reuse:
- image-file extraction from paste
- upload helper
- local preview caching
- attachment cleanup on cancel

### 4. Save Through Jira Issue Update

Saving should use:

- `PUT /rest/api/2/issue/{issueKey}`
- payload:
  - `fields.description = <draft text>`
  - or `null` when empty

The save path must:
- disable controls while saving
- preserve the draft on failure
- show inline saving/success/error status in the section header
- refetch issue data after success instead of only optimistic local mutation

### 5. Refresh Behavior Must Be Strict

This feature should not repeat the stale-description problem.

After a successful save:
- invalidate issue cache
- invalidate changelog cache if history is open
- refetch issue data
- refetch changelog if needed
- rerender from Jira-returned / Jira-rendered data

That ensures:
- rendered formatting matches Jira
- image macros resolve consistently
- the Description section stays visible even if cleared
- History updates correctly

### 6. Inline Status Messaging

Use the section title bar for feedback:
- saving: inline info message
- success: inline success message, auto-clear after 5s
- failure: inline error message, keep until next action

This matches the preferred title/status UX used elsewhere in the popup.

### 7. Cancel / Cleanup Semantics

If the user pasted images during the edit session and then clicks Cancel:
- delete the newly uploaded attachments for that editor session
- remove their local preview state
- restore the original description text

If save fails:
- keep the draft intact
- keep uploaded images available for retry

This gives the best balance of safety and user convenience.

---

## Implementation Phases

### Phase 1 — Always-Visible Description Section

Scope:
- always render the Description section
- add empty-state placeholder
- add title-bar edit affordance
- no edit mode yet

Files likely touched:
- `jira-plugin/resources/annotation.html`
- `jira-plugin/src/content-display-helpers.js`
- `jira-plugin/src/content.scss`

Validation:
- popup shows Description section for issues with and without descriptions
- empty issues show placeholder instead of omitting the block

### Phase 2 — Section-Level Description Edit State

Scope:
- add dedicated state and handlers for Description edit mode
- switch between rendered display and editor UI
- Save / Cancel controls in section header

Files likely touched:
- `jira-plugin/src/content.jsx`
- possibly a new helper module if the state/actions are large enough
- `jira-plugin/resources/annotation.html`
- `jira-plugin/src/content.scss`

Validation:
- enter edit mode
- cancel returns to original state
- save updates the description

### Phase 3 — Lightweight Formatting Toolbar

Scope:
- add selection-based markup insertion helpers
- buttons for bold / italic / underline / lists / link / code

Implementation note:
- this should be helper-driven text manipulation, not a rich-text framework

Validation:
- toolbar updates the draft predictably
- formatting renders correctly after save and refresh

### Phase 4 — Pasted Image Support

Scope:
- reuse / extract comment-composer image upload flow
- insert `!filename!` into the description draft
- show local preview-safe rendering while editing if applicable
- cleanup on cancel

Files likely touched:
- `jira-plugin/src/popup-comment-composer.js` or a new shared upload helper
- `jira-plugin/src/content.jsx`
- `jira-plugin/src/background.js` only if a shared upload wrapper needs cleanup
- `jira-plugin/src/content.scss`

Validation:
- paste image into description
- save and reopen popup
- image still renders correctly from persisted Jira data
- cancel removes draft-uploaded images

### Phase 5 — History + Refresh Integration

Scope:
- ensure description changes appear in History without manual reopen gymnastics
- ensure save path always invalidates/refetches the necessary caches

Validation:
- update description while History is open
- history reflects change after save

---

## Edge Cases

- Issue starts with no description.
  - section must still be visible
  - edit affordance must still be obvious

- User clears the description completely.
  - save should send `null`
  - section should remain visible afterward

- Save fails after pasted-image uploads.
  - keep draft intact
  - do not silently discard the uploaded image references

- User cancels after pasted-image uploads.
  - delete session-uploaded attachments to avoid orphan clutter

- User pastes multiple images.
  - preserve insertion order
  - do not break the draft text around the insertion point

- External Jira description changes while popup is open.
  - V1 likely will not solve live concurrent-edit detection
  - but save must still force a reliable post-save refresh

- Keyboard behavior.
  - Enter inserts newline
  - `Ctrl/Cmd+Enter` may save
  - Escape may cancel only if it does not conflict with multiline editing expectations

- Large descriptions.
  - editor must remain scrollable and performant
  - preview/rendered block must keep sane image sizing

- Jira formatting mismatches.
  - saved text should be treated as Jira wiki-style source
  - rendered output should come from Jira-refetched data, not only local preview transformation

---

## Risks / Pitfalls

### Jira Description Format Assumptions

The current implementation relies on string-based description values and `renderedFields.description`.

If a live Jira tenant expects a different description format on write, that will affect the save strategy.
This should be verified early against a real Jira issue before going too far into UI work.

### Cache Staleness

This feature will feel broken if save success does not invalidate and refetch issue data immediately.
That refresh behavior is mandatory, not optional.

### Attachment Orphans

Pasted-image support can easily create orphan issue attachments if cancel / discard flows are not handled carefully.

### Overbuilding The Editor

A full rich-text editor would add a lot of complexity.
The lightweight toolbar approach is intentionally chosen to keep the feature practical and maintainable.

---

## Recommended Defaults

If implementation starts before all UX questions are answered, these are the safest assumptions:

- always show the Description section
- show a subtle always-visible pencil icon for non-empty descriptions
- show a clearer `Edit` button for empty descriptions
- use a lightweight wiki-markup toolbar
- support pasted images, not general file attachments, in V1
- delete newly uploaded session attachments on explicit Cancel
- keep uploaded attachments on Save failure so retry is painless
- auto-clear success status after 5 seconds

---

## Open Questions

1. Is a lightweight wiki-format toolbar acceptable for V1 instead of a full rich-text editor?
2. On non-empty descriptions, should the edit affordance be always visible or only become prominent on hover?
3. On Cancel, should newly pasted/uploaded images be deleted from the issue immediately? The recommended answer is yes.
4. Should a manual popup `Refresh` action be included as part of this work, or kept separate?
