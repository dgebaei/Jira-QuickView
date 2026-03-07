# Edit Mode POC Plan
## Branch
poc/edit-mode

## Goal
Allow users to edit selected Jira fields directly from the hover popup with field-appropriate inline controls, clear save/discard behavior, and immediate popup refresh after a successful write.

## Current Implemented State
Already implemented on this branch:
- Fix versions: bounded multi-select from project versions, explicit Save / Discard
- Affects versions: bounded multi-select from project versions, explicit Save / Discard
- Sprint: single-select from active/future sprint candidates, inline save flow
- Shared popup rerender path after save
- Inline error handling and loading state

## Requirement Review
### High-confidence next fields
These have a defensible Jira read/write path and fit the popup well:
- Priority
- Status, but only via allowed transitions
- Assignee

### Medium-confidence fields
These are feasible, but need tighter product and API decisions first:
- Parent, but split into two distinct cases:
  - true `parent` for sub-tasks / parent-linked issue types
  - `Epic Link` style linkage for standard issues on classic Jira projects

### Low-confidence or separate-spike fields
These should not be treated as straightforward next-inline edits:
- Issue Type
  - challenge: Jira issue type changes are often a move operation, not a normal field update
  - recommendation: treat as a separate spike, not part of the normal edit-mode rollout
- Labels
  - challenge: labels are usually freeform and do not have a clean bounded project-scoped option source
  - recommendation: only do this if the target Jira instance exposes reliable label suggestions that are good enough for existing-label-only selection
- Generic custom fields
  - challenge: there is no safe universal convention for arbitrary custom-field editing
  - recommendation: support only custom fields that `editmeta` marks editable and that expose a bounded allowed-values model

## Product / UX Decisions
### Editing model by field type
Use different interaction patterns by field category instead of forcing everything into one input model.

Single-select inline editor:
- Sprint
- Priority
- Status transition target

Multi-select editor with Save / Discard:
- Fix versions
- Affects versions
- Labels, only if we decide to support existing-label-only selection
- multi-select custom fields with bounded allowed values

Search-backed single-select editor:
- Assignee
- Parent / Epic Link target issue
- single-user and single-issue custom fields

### Assignee UI
Challenge:
- assignee is currently rendered only as an avatar in the title area, not as a chip
Recommendation:
- keep the avatar display
- show a pencil affordance on assignee avatar hover
- open the same popover editor anchored to the avatar area
- if unassigned, render a small placeholder avatar slot so the edit affordance still exists

### Status UI
Challenge:
- status is not a normal field update
Recommendation:
- keep showing the current status chip in the popup
- clicking edit should open a dropdown of available transitions, not all statuses
- labels should reflect the transition action or target status clearly
- save should POST the chosen transition and refresh the issue

### Parent UI
Challenge:
- current popup display merges `parent` and Epic-style linkage into one `epicOrParent` presentation
Recommendation:
- separate the data model first
- only show an edit affordance when we can identify which linkage model applies
- do not pretend `parent` and `Epic Link` are the same field in write logic

## Jira/API Strategy
### Shared capability discovery
Add issue-scoped edit capability discovery as the base for most upcoming fields.

Primary source:
- GET `/rest/api/2/issue/{issueKey}/editmeta`

Use it for:
- whether a field is editable at all
- allowed operations
- allowed values for bounded select fields
- custom-field schema inspection

Cache:
- per issue key
- invalidate after successful save along with existing issue cache invalidation

### Priority
Read source:
- `editmeta.fields.priority.allowedValues`

Likely write path:
- PUT `/rest/api/2/issue/{issueKey}`

Payload:
```js
{
  fields: {
    priority: { id: priorityId }
  }
}
```

Notes:
- do not assume the global priority list is valid for every issue without `editmeta`
- hide edit if `editmeta` does not expose the field as editable

### Status via transitions
Read source:
- GET `/rest/api/2/issue/{issueKey}/transitions`

Likely write path:
- POST `/rest/api/2/issue/{issueKey}/transitions`

Payload:
```js
{
  transition: { id: transitionId }
}
```

Notes:
- dropdown options are transitions, not statuses
- if no transitions are available, hide or disable the edit affordance
- if multiple transitions lead to similarly named target states, show enough label detail to disambiguate

### Assignee
Preferred read sources:
- current assignee from existing issue payload
- candidate users from Jira user/assignee suggestion endpoint available on the target instance
- fallback to `editmeta` if it exposes assignable users, though that is often insufficient alone

Preferred write path:
- PUT `/rest/api/2/issue/{issueKey}/assignee`

Possible payload shapes vary by Jira deployment:
```js
{ name: username }
```
or
```js
{ accountId: accountId }
```

Notes:
- detect the shape supported by the current instance instead of hardcoding one identifier style
- support unassign if permissions allow it
- debounce user search and cache recent query results

### Parent / Epic Link
Read sources:
- current `parent` from issue payload
- current Epic-style field via existing field-name resolution
- candidate issues via issue picker / issue search endpoint

Likely write paths:
- PUT `/rest/api/2/issue/{issueKey}` with either:
  - `fields.parent = { key: parentKey }` for supported parent relationships
  - `fields[epicLinkFieldId] = epicKey` for classic Epic Link style fields

Notes:
- first detect which linkage applies for the current issue
- do not expose edit if the applicable field cannot be resolved safely
- prefer same-project search by default, with project-scoped query expansion when needed
- preload only lightweight cached context that is clearly relevant:
  - current parent / epic
  - recent successful search results for the current project
  - no large eager issue preloads

### Labels
Challenge:
- labels are often freeform and not backed by a bounded allowed-values list

Possible sources to investigate:
- Jira suggestion endpoint if available on this instance
- autocomplete APIs used by Jira's own issue editor

Recommendation:
- do not commit to labels until a reliable existing-label suggestion source is confirmed on the target Jira instance
- if supported, constrain V1 to selecting and removing existing labels only
- no freeform label creation in popup V1

### Custom Fields
Support only fields that pass all of the following:
- present in configured custom-field list or explicit allowlist
- exposed by `editmeta` as editable
- schema maps to a supported interaction type
- bounded option or search source is known

Initial custom-field types worth supporting:
- single-select custom field with `allowedValues`
- multi-select custom field with `allowedValues`
- single-user picker custom field, if we can reuse assignee search
- single-issue picker / epic-like field, if we can reuse issue search safely

Do not support in the generic path initially:
- cascading selects
- rich text
- arbitrary text fields
- numeric/date fields without explicit product need
- fields that require workflow screens or side effects

### Issue Type
Recommendation:
- treat as a separate investigation
- do not include in the next implementation batch

Reason:
- issue type changes often require Jira move semantics and field remapping
- the popup editor is the wrong place to discover move-screen requirements

## Architecture Changes
### Capability layer
Add reusable capability helpers in `content.jsx`:
- `getIssueEditMeta(issueKey)`
- `getEditableFieldCapability(issueData, fieldKey)`
- `getTransitionOptions(issueKey)`
- `searchAssignableUsers(query, issueData)`
- `searchParentCandidates(query, issueData)`
- `resolveCustomFieldEditor(fieldMeta, editMetaField)`

### Editor modes
Extend the popup edit state to support explicit editor modes:
```js
{
  fieldKey: '',
  editorType: 'single-select' | 'multi-select' | 'transition-select' | 'user-search' | 'issue-search',
  inputValue: '',
  options: [],
  selectedOptionId: '',
  selectedOptionIds: [],
  selectedOptions: [],
  loadingOptions: false,
  saving: false,
  errorMessage: '',
  hasChanges: false,
  selectionStart: 0,
  selectionEnd: 0
}
```

### Template updates
Update popup rendering to support:
- header-level edit affordance for assignee avatar
- row-chip edit affordances for priority / status / parent
- option rows with optional icons / avatars / meta text
- explicit Save / Discard row for multi-select and search-backed editors when needed

### Search providers
Add debounced query providers with small in-memory caches:
- assignee search cache by query prefix + project / issue context
- issue search cache by query prefix + project key + linkage mode
- keep result sizes bounded

### Refresh strategy
After any successful write:
- invalidate issue cache
- invalidate related editmeta cache for the issue
- invalidate any field-option cache that depends on issue project / context when needed
- refetch issue payload and rerender popup

## Recommended Delivery Order
### Track 1: strong next candidates
1. Add `editmeta` fetch + cache + capability helpers
2. Implement Priority from `editmeta.allowedValues`
3. Implement Status from transitions API
4. Implement Assignee with avatar-anchored popover and user search

### Track 2: linkage editing
5. Split current combined `epicOrParent` display into explicit linkage metadata
6. Implement Parent / Epic Link editing only for the linkage model we can resolve safely per issue
7. Add same-project issue search with debounce and result caching

### Track 3: conditional expansions
8. Investigate whether labels have a reliable suggestion endpoint on the target Jira instance
9. If yes, implement existing-label-only multi-select
10. Add `editmeta`-driven custom-field support for an allowlisted subset of field schemas

### Separate spike
11. Investigate Issue Type editing as a move-style workflow, not as a normal inline field edit

## Detailed Implementation Steps
### Phase 1: capability groundwork
1. Introduce `editmeta` retrieval and cache invalidation alongside existing issue refresh logic
2. Build a field capability map for standard fields:
   - priority
   - assignee
   - labels
   - supported custom fields
3. Add editor-type discrimination so field definitions can request:
   - bounded single-select
   - bounded multi-select
   - transitions
   - user search
   - issue search

### Phase 2: priority
1. Read `priority` capability from `editmeta`
2. Convert the current static priority chip to an editable chip when allowed
3. Render allowed priorities with icon support if available
4. Save selected priority and refresh popup state

### Phase 3: status transitions
1. Add transition fetch helper for the hovered issue
2. Map transitions into dropdown options with labels that are understandable in the popup
3. Convert the status chip to transition-backed edit mode only when transitions are available
4. POST selected transition and refresh popup state
5. Handle workflow validation errors cleanly

### Phase 4: assignee
1. Add an assignee edit affordance in the header avatar region
2. Resolve search API shape for the target Jira instance
3. Implement debounced user search and result rendering with avatars
4. Save via assignee endpoint using instance-appropriate identifier shape
5. Support clearing assignee when permitted

### Phase 5: parent / epic linkage
1. Split current combined display logic into explicit linkage resolution
2. Detect whether current issue should edit `parent` or Epic-style field
3. Implement debounced issue search scoped to same project by default
4. Save selected issue key to the resolved linkage field
5. Refresh and rerender the linked issue summary

### Phase 6: labels, only if source is reliable
1. Confirm existing-label suggestion endpoint exists and behaves well enough
2. Implement bounded multi-select labels editor
3. Explicitly block freeform creation in V1
4. Save full label array replacement and refresh popup state

### Phase 7: supported custom fields
1. Read configured custom fields from existing settings
2. Join configured fields with `editmeta` capabilities
3. Map each supported custom field to one of the existing editor types
4. Hide unsupported custom-field editors instead of half-supporting them
5. Add schema-specific save payload builders

## Testing
### Priority
- editable issue with allowed priorities -> update succeeds
- field not editable in `editmeta` -> no edit affordance
- permission failure -> editor stays open with error

### Status
- one or more transitions available -> chosen transition succeeds
- no transitions available -> no edit affordance
- transition validation failure -> error shown, popup stays open

### Assignee
- assign to another user succeeds
- unassign succeeds when allowed
- search with no matches shows empty state
- instance identifier mismatch is handled without breaking popup state

### Parent / Epic Link
- sub-task style parent update succeeds when supported
- Epic-style linkage update succeeds when field id is resolvable
- ambiguous linkage model -> edit hidden
- search returns too many results -> list stays bounded and responsive

### Labels
- existing label add/remove succeeds when suggestion source is confirmed
- freeform unknown label is blocked in V1
- no suggestion support -> feature remains disabled

### Custom Fields
- supported single-select field with allowed values updates correctly
- supported multi-select field updates correctly
- unsupported schema never renders edit affordance
- field editable in config but not in `editmeta` stays read-only

## Open Questions / Assumptions
Assumptions for planning:
- background JSON write support is already good enough for additional PUT / POST field writes
- target Jira instance is Server / Data Center-like enough that `/rest/api/2/...` remains the primary integration surface
- we will prefer per-field correctness over forcing every field into the same editor UI

Questions to resolve during implementation, not before planning:
- which assignee suggestion endpoint is available on the target instance
- whether labels have a reliable bounded suggestion source on the target instance
- whether parent editing should initially support only one linkage model instead of both

## Recommendation
Recommended next implementation order:
- Priority
- Status via transitions
- Assignee
- Parent / Epic Link

Do not start with:
- Issue Type
- generic custom fields
- labels without first confirming suggestion support
