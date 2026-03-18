# Clickable Labels Plan

## Goal
- In display mode, make each label clickable to a JQL search.
- Make the `Labels` label text clickable to a combined `labels in (...)` JQL search.

## JQL Rules
- Per label:

```text
project = "<PROJECT>" AND labels = "<LABEL>"
```

- Header link:

```text
project = "<PROJECT>" AND labels in ("a", "b", "c")
```

## Rendering Strategy
- Keep Mustache structured data.
- Replace the single labels chip string with a composite labels chip model:
  - header link
  - label items
  - separators
- Preserve current labels edit mode and show non-link text while editing.

## Code Areas
- `jira-plugin/src/content.jsx`
  - build labels composite chip model
  - reuse existing JQL escaping and URL helpers
- `jira-plugin/resources/annotation.html`
  - add labels-specific display branch inside row-3 rendering
- `jira-plugin/src/content.scss`
  - minor spacing/separator styling if needed

## Risks
- Template complexity increases slightly.
- Need to ensure labels with quotes, commas, or slashes are escaped correctly.
- Header query should dedupe truthy labels.

## Tests
- each label renders as a link
- header `Labels` renders as a link
- JQL is encoded correctly
- labels edit mode still works
