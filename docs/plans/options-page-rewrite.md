# Options Page Rewrite — Implementation Plan

## Overview

Redesign the options page (`jira-plugin/options/options.jsx`) to support a **Basic/Advanced split** UI. Basic shows only Connection + Appearance. Advanced reveals Hover Behavior, Tooltip Layout (drag-and-drop editor), Custom Fields, and Settings Sync. The toggle state is session-only — the page always loads in basic view.

**Files touched:** `options.jsx`, `options.scss`, `config.js` (mostly read-only).

**Skills that help:** see [Skills Reference](#skills-reference) at the bottom.

---

## Progress

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 1 — Basic Structure & Toggle Shell | **Done** | See [Phase 1 Complete](#phase-1--basic-structure--toggle-shell) |
| Phase 2 — Appearance Card | **Done** | See [Phase 2 Complete](#phase-2--appearance-card) |
| Phase 3 — Hover Behavior Card | **Done** | Two-column layout, native selects with help text |
| Phase 4 — Drag-and-Drop Editor | **Done** | See [Phase 4 Complete](#phase-4--drag-and-drop-editor) |
| Phase 5 — Custom Fields Card | Pending | |
| Phase 6 — Settings Sync | Pending | |
| Phase 7 — Visual Polish | Pending | |
| Phase 8 — Testing | Pending | |

---

## Phase 1 — Basic Structure & Toggle Shell ✅

**Completed:** Full SCSS rewrite + JSX basic/advanced split.

### What was built

- **CSS variables** — complete re-theme with 40+ tokens, full dark mode support. Dark hero (`#1e293b`), blue section titles (`#1e40af`), grey descriptions, pill toggles, dashed toggle card, footer action bar.
- **`showAdvanced` state** — backed by `sessionStorage` (`jhl_adv` key). Page always loads in basic view. Tab close → toggle resets.
- **Hero** — dark header with Jira HotLinker eyebrow, "Extension Options" title, description, amber-dot status pill.
- **Basic cards** — Connection (Jira URL + allowed pages) + Appearance (theme pills) in a 2-column grid.
- **ADVANCED toggle** — dashed-border card with ⚙ icon, description, "Show" button. Renders all advanced sections when open.
- **Footer** — Discard (reloads page) + Save buttons, sticky-ish at bottom.
- **Responsive** — cards stack vertically on mobile, toggle switches to vertical layout.
- **Stable custom field keys** — `_uid` property assigned on init, used as React key instead of array index.

### Custom fields stable key pattern

```jsx
// On init — assign _uid if missing
const [customFields, setCustomFields] = useState(() =>
  normalizeCustomFields(props.customFields).map((f, i) => ({...f, _uid: f._uid || `cf-${Date.now()}-${i}`}))
);
```

### Toggle callback

```jsx
const toggleAdvanced = useCallback(() => {
  setShowAdvanced(prev => {
    const next = !prev;
    sessionStorage.setItem('jhl_adv', next ? '1' : '0');
    return next;
  });
}, []);
```

---

## Phase 2 — Appearance Card (Basic) ✅

**Completed:** Theme selector redesigned from `<select>` to three pill buttons.

---

## Phase 3 — Hover Behavior Card (Advanced) ✅

**Completed:** Hover trigger settings extracted to their own card.

### What was built

- **Gated behind `showAdvanced`** — only visible when advanced is shown
- **Two-column layout** — trigger depth (left), modifier key (right), responsive to single column on mobile
- **Native selects** — kept for v1, with help text beneath each
- **Card styling** — matches the new card system (header strip, blue title, grey description)

---

## Phase 4 — Drag-and-Drop Editor ✅

**Completed:** Tooltip Layout editor with @dnd-kit for drag-and-drop field placement.

### What was built

- **`tooltipLayout` state** — new data model with `row1`, `row2`, `row3`, `contentBlocks`, `people` arrays
- **`buildTooltipLayoutFromDisplayFields` migration** — converts legacy `displayFields` booleans to new ordered arrays
- **`TooltipLayoutEditor` component** — sidebar + preview panel with three droppable zones
- **`FieldLibrary` sidebar** — shows unplaced fields available to drag
- **`FieldZone` components** — droppable targets for Row 1, Row 2, Row 3
- **Content blocks** — shown as locked pills (fixed order, not draggable)
- **People section** — reporter + assignee with drag-to-reorder support
- **CSS styles** — pill styling, zone highlighting, drag overlay, responsive layout

### Migration

On load, if `tooltipLayout` is not present in stored config, it's built from `displayFields` using `buildTooltipLayoutFromDisplayFields()`.

---

## Design Decisions

### Toggle Behavior

- The page **always loads in basic view** — `showAdvanced` defaults to `false` on every page load.
- State is stored in `sessionStorage` (`jhl_adv`). Within the same browser tab, reopening the options page retains the toggle state. Closing and reopening the tab resets to basic.
- **No smart-reveal**: if the user has configured advanced settings before, they don't automatically appear on next load. The user clicks "Show" to see advanced sections.
- Rationale: casual users just need Jira URL + theme. Power users click "Show" once per session. No complexity needed.

### Visual Language

The options page adopts the tooltip mockup's design system:
- Dark hero header (`#1e293b`) with Jira HotLinker eyebrow + "Extension Options" title
- Status pill with amber dot (unsaved changes indicator)
- Section cards: light grey top strip, blue section title, grey description, white body
- BASIC/ADVANCED labels in small-caps grey
- Footer: Discard (ghost) + Save (blue filled)

---

## Phase 1 — Basic Structure & Toggle Shell

**Goal:** Establish the basic/advanced toggle with zero visual changes to existing controls.

### Steps

1. **Add session state** for the advanced toggle:
   ```jsx
   const [showAdvanced, setShowAdvanced] = useState(
     () => sessionStorage.getItem('jhl_adv') === '1'
   );
   ```
   On toggle: set `sessionStorage.setItem('jhl_adv', showAdvanced ? '1' : '0')`.

2. **Add a toggle component** at the bottom of the settings grid, before the footer:
   - Dashed-border card, ⚙ icon, title "Show advanced settings"
   - Description listing what's hidden (hover triggers, layout editor, custom fields, sync)
   - Blue "Show" button → toggles `showAdvanced`
   - When advanced is open, button reads "Hide" and card collapses sections

3. **Wrap existing ADVANCED sections** in a `showAdvanced && (...)` guard:
   - Hover Behavior card
   - Tooltip Layout card
   - Custom Fields card
   - Settings Sync card
   They remain fully functional — just hidden from the DOM when collapsed.

4. **Refactor `options.scss`**: two-column layout for the basic cards (side-by-side). Extract shared card styles (header strip, section title, body padding) so all cards share the same visual language.

5. **Extract Appearance from Hover Behavior**: Move `themeMode` into its own card ("Appearance") in the basic section. Hover Behavior becomes advanced-only.

**Deliverable:** Toggle works. Basic cards are side-by-side. Advanced sections hidden on every fresh page load. Existing functionality unchanged.

---

## Phase 2 — Appearance Card (Basic)

**Goal:** Redesign the theme selector to a three-pill toggle instead of a native `<select>`.

### Steps

1. Replace the `<select>` for `themeMode` with three styled pill buttons (System / Light / Dark).
2. Keep the same `normalizeThemeMode` / `SUPPORTED_THEME_MODES` logic — just swap the input widget.
3. Add a tip box inside the card: "Most users keep the default System setting."
4. Style pills: selected = blue fill + blue border, unselected = white fill + grey border.

**Deliverable:** Appearance card matches the mockup.

---

## Phase 3 — Hover Behavior Card (Advanced)

**Goal:** Extract hover trigger settings to their own card in advanced mode.

### Steps

1. Gate the Hover Behavior card behind `showAdvanced`.
2. Two-column layout inside the card: trigger depth (left), modifier key (right).
3. Style the `<select>` inputs with custom dropdown appearance or keep native for v1.
4. Add help text beneath each select.

**Deliverable:** Hover Behavior card matches mockup.

---

## Phase 4 — Tooltip Layout: Drag-and-Drop Editor (Advanced, Core Feature)

This is the most complex piece. Build the drag-and-drop layout editor — the centerpiece of the redesign.

### 4a. Data Model

Add a new top-level config key:

```js
// config.js
tooltipLayout: {
  row1: ['issueType', 'status', 'priority', 'epicParent'],
  row2: ['sprint', 'affects', 'fixVersions'],
  row3: ['environment', 'labels'],
  contentBlocks: ['description', 'attachments', 'comments', 'pullRequests']
}
```

Migrate from the existing `displayFields` boolean map to this ordered-array model. `displayFields[key]` becomes `tooltipLayout.row1.includes(key) || row2... || row3... || contentBlocks...`. Fields not in any array are "unplaced" (shown in the sidebar as yellow pills).

### 4b. Drag-and-Drop Library

Use `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities`.

```bash
npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

Two `DndContext` patterns:
1. **Sidebar → Zone**: drag pills from the library onto zone drop targets.
2. **Within zone**: reorder pills inside each row zone.

### 4c. Component Structure

```
<TooltipLayoutEditor>
  <FieldLibrary>           // sidebar (left)
    <RowFieldPill /> × N   // built-in, always in library
    <CustomFieldPill /> × N // from customFields config
    <AddCustomFieldInput /> // + Add row
  </FieldLibrary>
  <HoverCardPreview>       // live preview (right)
    <Zone zone="row1" />   // droppable
    <Zone zone="row2" />
    <Zone zone="row3" />
    <ContentBlockPreview /> // locked order, not draggable
  </HoverCardPreview>
</TooltipLayoutEditor>
```

### 4d. Field Library Sidebar

- **Row Fields section**: lists all built-in row fields not yet placed in any zone. Each is a draggable pill (blue fill, matching the tooltip color system).
- **Custom Fields section**: lists unplaced custom fields from `customFields` config. Yellow dashed pill border. Shows field name resolved from Jira.
- **+ Add custom field**: input row at the bottom of the sidebar. Adding one creates an entry in `customFields` AND adds it to the unplaced library section.
- Hover × on a custom field pill to remove it from the config.

### 4e. Hover Card Preview Panel

The right-side panel shows a live-updating preview built from `tooltipLayout`:
- Zones (Row 1, Row 2, Row 3) are **droppable targets** with dashed borders. When a pill is dropped in, it renders in-place.
- Content blocks (Description, Attachments, PRs, Comments) are shown in fixed order as locked rows — always shown in the preview but not reorderable.
- The preview mirrors the tooltip mockup: dark header with title + avatar, row pills, content blocks, counters, time tracking. Use shared CSS classes from the tooltip's SCSS so the preview looks identical to the actual hover card.

### 4f. Drag Interaction States

- **Dragging from library**: ghost follows cursor, original stays in place.
- **Over a zone**: zone border turns solid blue, placeholder shown where pill will land.
- **Drop in zone**: pill appears in position, removed from library.
- **Drag pill out of zone**: returns to library (or a "remove" zone at the top of the sidebar).
- **Reorder within zone**: pills shift to make room.

### 4g. Save Integration

`tooltipLayout` is persisted to `chrome.storage.sync` alongside the rest of the config in `saveOptions()`. The drag-and-drop editor updates local React state on every drop; the full config is written to storage only on "Save changes".

**Deliverable:** Drag pills from library → drop in zones → preview updates live. Custom fields can be added/removed. Layout persists on Save.

---

## Phase 5 — Custom Fields Card (Advanced)

**Goal:** The custom field editor already exists. Style it and connect it to the drag-and-drop editor's sidebar.

### Steps

1. Keep the existing card structure but style it to match the new card design (header strip, blue title, grey description).
2. Connect it to the drag-and-drop editor's sidebar: adding a custom field here also adds it to the library sidebar (and vice versa). Both views write to the same `customFields` array.
3. The card becomes a "detail view" for managing custom field IDs and row placement — the drag-and-drop editor provides the visual alternative.

**Deliverable:** Custom Fields card visible in advanced, fully functional, visually consistent.

---

## Phase 6 — Settings Sync (Advanced)

**Goal:** Add Export/Import JSON buttons. No backend yet — this is Phase 1 of the sync roadmap.

### Steps

1. **Export**: `JSON.stringify(storedConfig, null, 2)` → create a `Blob` → trigger `URL.createObjectURL` download as `jira-hotlinker-settings.json`.

2. **Import**: `<input type="file" accept=".json">` hidden, triggered by the Import button. Read the file, `JSON.parse` it, validate it has at least `instanceUrl` and `domains`, then merge it into the current form state (don't save yet — populate the form for review before clicking "Save changes").

3. **Team Sync (Pro) button**: Link to a placeholder modal ("Coming soon — sign up for the Pro waitlist"). Purple styling matches mockup. Wire up to a `mailto` or a simple info dialog for now.

4. Add Export / Import / Team Sync buttons to the bottom of the Settings Sync card, with a brief description line.

**Deliverable:** Export/Import work. Pro button is visually present with a "coming soon" treatment.

---

## Phase 7 — Visual Polish & CSS

**Goal:** Make the options page feel cohesive with the tooltip design language.

### Steps

1. **Card redesign**: Every section card gets the new header style (light grey top strip, section title in blue, description in grey). Consistent padding, border-radius, shadow.
2. **Typography**: Eyebrow labels (`BASIC`, `ADVANCED`) in small-caps grey, section titles in blue, descriptions in slate.
3. **Color mode sync**: Extract `themeMode` sync into a `useDocumentTheme` hook so the options page itself changes theme (light/dark/system) as the user edits the setting — no reload needed.
4. **Status pill**: Keep the "Changes are local until you save" status in the hero, styled as a dark grey pill with amber dot.
5. **Footer**: Discard + Save buttons (ghost + blue filled), styled as in the mockup.
6. **Hero section**: Dark header strip, Jira HotLinker eyebrow, "Extension Options" title, description, status pill on right.
7. **Responsive**: Stack the basic cards vertically on narrow viewports. Show a message on mobile instead of the drag-and-drop editor.

---

## Phase 8 — Testing

1. **Playwright E2E**: Update `tests/e2e/hover-and-popup.spec.js` and related test files. Test: toggle opens/closes advanced, Export downloads a valid `.json`, Import populates the form.
2. **Manual drag-and-drop test**: Drag pill library → zone → reorder within zone → remove from zone. Verify custom field addition from both the card and the sidebar.
3. **Theme toggle test**: Change color mode → options page theme changes immediately (no reload).
4. **Config migration test**: Existing users with `displayFields` booleans should have their config migrated to `tooltipLayout` arrays on first save. Write a migration function in `config.js`.

---

## Migration: `displayFields` → `tooltipLayout`

In `saveOptions()`, add a one-time migration:

```js
if (!storedConfig.tooltipLayout) {
  tooltipLayout = buildTooltipLayoutFromDisplayFields(displayFields);
}
```

`buildTooltipLayoutFromDisplayFields` maps the old booleans to the new ordered arrays, using a hardcoded default order for field placement. Only enabled fields get placed; disabled fields stay "unplaced" in the library.

---

## File Changes Summary

| File | Change |
|------|--------|
| `options/options.jsx` | Major rewrite: toggle, basic/advanced split, drag-and-drop editor, theme pills, Settings Sync |
| `options/options.scss` | Full visual redesign: card system, hero, footer, typography |
| `options/config.js` | Add `tooltipLayout` key with default order arrays; migration helper |
| `package.json` | Add `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` |
| `tests/e2e/hover-and-popup.spec.js` | Update for new section structure and Settings Sync |
| `webpack.config.js` | No changes expected |

---

## Effort Estimate

| Phase | Effort |
|-------|--------|
| Phase 1 — Shell & toggle | 1 day |
| Phase 2 — Appearance | 0.5 day |
| Phase 3 — Hover Behavior | 0.5 day |
| Phase 4 — Drag-and-drop editor | 3-4 days |
| Phase 5 — Custom Fields card | 0.5 day |
| Phase 6 — Settings Sync | 0.5 day |
| Phase 7 — Visual polish | 1 day |
| Phase 8 — Testing | 1 day |
| **Total** | **~8-9 days** |

---

## Skills Reference

| Skill | How it helps |
|-------|-------------|
| **playwright** | Running E2E tests throughout implementation; verifying the toggle, export/import, and drag-and-drop work correctly in a real browser |
| **e2e-testing-patterns** | Writing robust Playwright tests for the options page rewrite — testing the toggle, form population via Import, and theme changes |
| **frontend-react-best-practices** | Writing performant React components during the rewrite — avoiding barrel imports (dnd-kit), memoizing callbacks, using functional state updates, deriving values during render, and applying correct hooks patterns |
| **build-extension-and-reload** | Rebuilding and reloading the unpacked extension in Chrome after each change during the implementation loop |

No other skills are directly relevant. The implementation is primarily React/SCSS work within the existing extension codebase.
