# Time Tracking Plan

## Goal
- Display and edit Original Estimate and Remaining Estimate.
- Allow Time Spent only through adding a new worklog entry.
- Use one explicit `Save` button for the section.

## Recommendation
- Implement as a dedicated section below row 3, not as field chips.

## Jira API
- Read from `fields.timetracking`.
- Check estimate editability with `editmeta.fields.timetracking`.
- Update estimates with `PUT /rest/api/2/issue/{key}`:

```json
{
  "fields": {
    "timetracking": {
      "originalEstimate": "1w 2d",
      "remainingEstimate": "3h 30m"
    }
  }
}
```

- Add spent time with:
  - `POST /rest/api/2/issue/{key}/worklog?adjustEstimate=leave`

```json
{
  "timeSpent": "1h 30m"
}
```

## UX
- Keep current total Time Spent read-only.
- Provide inputs for:
  - Original Estimate
  - Remaining Estimate
  - Add Time Spent
- Enable `Save` only when a valid change exists.

## Preferred Mockup
```text
Time Tracking
Original estimate   [ 1w 2d ]
Remaining estimate  [ 3d 4h ]
Log work            [ 30m   ]  Adds to Time Spent
Time Spent: 6h 15m                      [Save]
```

## State Model
- separate `timeTrackingEditState` from existing single-field `editState`
- keep original values, current inputs, saving flag, and error state
- support mixed saves where worklog and estimates may both be submitted

## Risks
- Estimate edit permission and worklog permission may differ.
- Shared Save can partially succeed.
- Jira duration parsing varies by instance, so client validation should be permissive.

## Code Areas
- `jira-plugin/src/content.jsx`
  - fetch/build timetracking display data
  - add section-level state and save handler
- `jira-plugin/resources/annotation.html`
  - render section under row 3
- `jira-plugin/src/content.scss`
  - compact form layout

## Tests
- section renders when timetracking exists
- save disabled when nothing changed
- estimate-only save works
- worklog-only save works
- combined save handles success and failure cleanly
