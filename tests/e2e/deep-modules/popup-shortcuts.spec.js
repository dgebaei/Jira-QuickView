const path = require('path');
const {test, expect} = require('@playwright/test');
const harnessPath = path.resolve(__dirname, '../../output/playwright/deep-modules/harness.js');

test.beforeEach(async ({page}) => {
  await page.setContent('<!doctype html><html><body><input id="input"><div contenteditable="true" id="editor"></div></body></html>');
  await page.addScriptTag({path: harnessPath});
  await page.evaluate(() => {
    const fixture = {
      writes: [], presets: {}, searches: [],
      sprints: [{id: 42, name: 'Sprint 42', state: 'active'}],
      versions: [
        {id: '301', name: '2026.03', released: true},
        {id: '302', name: '2026.05', released: false},
        {id: '401', name: '2026.04', released: false},
      ],
      users: [{accountId: 'other', displayName: 'Other person'}],
      transitions: [{id: '41', name: 'Resolve', to: {name: 'Done', statusCategory: {key: 'done'}}, fields: {
        resolution: {required: true, allowedValues: [{id: '1', name: 'Fixed'}, {id: '2', name: 'Duplicate'}]},
        comment: {required: true},
      }}],
      snapshot: {issueKey: 'ABC-1', core: {key: 'ABC-1', fields: {project: {id: '100'}, issuetype: {id: '1'}}}, sections: {}},
    };
    const deps = {
      instanceUrl: 'https://jira.example/',
      jira: {
        read: async () => ({transitions: fixture.transitions}),
        write: async request => { fixture.writes.push(request); if (fixture.writePromise) await fixture.writePromise; },
      },
      issueData: {
        loadFieldContext: async ({fieldId}) => ({context: {
          editable: fixture.editable !== false, fieldId: fieldId === 'sprint' ? 'customfield_10020' : fieldId,
          options: fieldId === 'fixVersions' ? fixture.versions : fixture.sprints,
        }}),
        search: async ({query}) => { fixture.searches.push(query); return {kind: 'loaded', items: fixture.users}; },
        refreshAfterMutation: async () => {
          if (fixture.refreshFailure) throw new Error('Refresh failed');
          return {snapshot: fixture.snapshot};
        },
      },
      loadViewer: async () => ({accountId: 'me', displayName: 'Me'}),
      readSprintsFromIssue: () => fixture.existingSprints || [],
      loadPreset: async key => fixture.presets[key],
      savePreset: async (key, value) => { fixture.presets[key] = value; },
    };
    fixture.deps = deps;
    fixture.workflow = window.JiraQuickViewDeepModules.createPopupShortcutWorkflow(deps);
    fixture.begin = (kind, alternate = false) => fixture.workflow.begin({kind, alternate, sessionId: 'popup-1', issueSnapshot: fixture.snapshot});
    fixture.apply = kind => fixture.workflow.apply({kind, sessionId: 'popup-1', issueSnapshot: fixture.snapshot})
      .catch(error => ({kind: 'error', message: error.message}));
    window.fixture = fixture;
  });
});

test('stages sprint and assignee, cancels both, and submits them as one update', async ({page}) => {
  const result = await page.evaluate(async () => {
    const f = window.fixture;
    await f.begin('plan');
    f.workflow.update({userId: 'other'});
    const stagedWrites = f.writes.length;
    f.workflow.reset();
    const cancelled = f.workflow.view();
    await f.workflow.submit({sessionId: 'popup-1'});
    const cancelledWrites = f.writes.length;
    await f.begin('plan');
    f.workflow.update({userId: 'other'});
    const outcome = await f.workflow.submit({sessionId: 'popup-1'});
    return {stagedWrites, cancelled, cancelledWrites, kind: outcome.kind, writes: f.writes};
  });
  expect(result).toEqual({stagedWrites: 0, cancelled: null, cancelledWrites: 0, kind: 'saved', writes: [{
    method: 'PUT', path: 'https://jira.example/rest/api/2/issue/ABC-1',
    body: {fields: {assignee: {accountId: 'other'}, customfield_10020: 42}},
  }]});
});

test('reassign starts from the current assignee: confirming keeps them, and typing searches', async ({page}) => {
  const result = await page.evaluate(async () => {
    const f = window.fixture;
    f.snapshot.core.fields.assignee = {name: 'filip', key: 'JIRAUSER9', displayName: 'Filip Višić'};
    await f.begin('plan');
    const {query, users, userId} = f.workflow.view();
    const searchesBeforeTyping = f.searches.length;
    await f.workflow.submit({sessionId: 'popup-1'});
    await f.begin('plan');
    await f.workflow.search('oth');
    return {query, users, userId, searchesBeforeTyping, write: f.writes[0].body, typed: f.workflow.view().users};
  });
  expect(result).toEqual({
    query: 'Filip Višić', users: [{name: 'filip', key: 'JIRAUSER9', displayName: 'Filip Višić'}], userId: 'filip',
    searchesBeforeTyping: 0, write: {fields: {assignee: {name: 'filip'}, customfield_10020: 42}},
    typed: [{accountId: 'other', displayName: 'Other person'}],
  });
});

test('multiple active sprints require a choice, including assign-to-me mode', async ({page}) => {
  const result = await page.evaluate(async () => {
    const f = window.fixture;
    f.sprints.push({id: 43, name: 'Parallel sprint', state: 'active'});
    await f.begin('plan', true);
    const initial = f.workflow.view();
    await f.workflow.submit({sessionId: 'popup-1'});
    const invalidWrites = f.writes.length;
    f.workflow.update({sprintId: '43'});
    await f.workflow.submit({sessionId: 'popup-1'});
    return {sprintId: initial.sprintId, userId: initial.userId, invalidWrites, fields: f.writes[0].body.fields};
  });
  expect(result).toEqual({sprintId: '', userId: 'me', invalidWrites: 0, fields: {assignee: {accountId: 'me'}, customfield_10020: 43}});
});

test('an issue already in the selected sprint only changes assignee', async ({page}) => {
  const result = await page.evaluate(async () => {
    const f = window.fixture;
    f.existingSprints = [{id: 42}];
    await f.begin('plan', true);
    await f.workflow.submit({sessionId: 'popup-1'});
    return f.writes;
  });
  expect(result).toHaveLength(1);
  expect(result[0].body).toEqual({fields: {assignee: {accountId: 'me'}}});
});

test('Data Center users use their username instead of a Cloud accountId', async ({page}) => {
  const result = await page.evaluate(async () => {
    const f = window.fixture;
    f.users = [{name: 'alex', key: 'JIRAUSER1', displayName: 'Alex'}];
    await f.begin('plan');
    f.workflow.update({userId: 'alex'});
    await f.workflow.submit({sessionId: 'popup-1'});
    return f.writes[0].body;
  });
  expect(result).toEqual({fields: {assignee: {name: 'alex'}, customfield_10020: 42}});
});

for (const reason of ['no-active-sprint', 'not-editable']) {
  test(`does not write when ${reason}`, async ({page}) => {
    const result = await page.evaluate(async reason => {
      const f = window.fixture;
      if (reason === 'no-active-sprint') f.sprints = [{id: 44, state: 'future'}];
      else f.editable = false;
      await f.begin('plan', true);
      await f.workflow.submit({sessionId: 'popup-1'});
      return {writes: f.writes.length, error: f.workflow.view().error};
    }, reason);
    expect(result.writes).toBe(0);
    expect(result.error).toBeTruthy();
  });
}

test('completion requires resolution and comment, then sends both with the transition', async ({page}) => {
  const result = await page.evaluate(async () => {
    const f = window.fixture;
    await f.begin('resolve');
    await f.workflow.submit({sessionId: 'popup-1'});
    const missingResolution = f.workflow.view().error;
    f.workflow.update({resolutionId: '1'});
    await f.workflow.submit({sessionId: 'popup-1'});
    const missingComment = f.workflow.view().error;
    f.workflow.update({comment: 'Verified fixed'});
    await f.workflow.submit({sessionId: 'popup-1'});
    return {missingResolution, missingComment, writes: f.writes};
  });
  expect(result.missingResolution).toContain('resolution');
  expect(result.missingComment).toContain('comment');
  expect(result.writes).toEqual([{
    method: 'POST', path: 'https://jira.example/rest/api/2/issue/ABC-1/transitions',
    body: {transition: {id: '41'}, fields: {resolution: {id: '1'}}, update: {comment: [{add: {body: 'Verified fixed'}}]}},
  }]);
});

test('quick-close only uses remembered, still-valid defaults and opt-in required-comment fallback', async ({page}) => {
  const result = await page.evaluate(async () => {
    const f = window.fixture;
    await f.begin('resolve', true);
    const unconfigured = f.workflow.view();
    f.workflow.update({resolutionId: '1', comment: 'A real closing comment', remember: true, useDot: true});
    await f.workflow.submit({sessionId: 'popup-1'});
    await f.begin('resolve', true);
    const configured = f.workflow.view();
    f.transitions[0].fields.comment.required = false;
    await f.begin('resolve', true);
    const optional = f.workflow.view();
    f.transitions[0].fields.resolution.allowedValues = [{id: '99', name: 'Something else'}];
    await f.begin('resolve', true);
    return {unconfigured, configured, optional, invalid: f.workflow.view(), writes: f.writes.length};
  });
  expect(result.unconfigured.resolutionId).toBe('');
  expect(result.unconfigured.comment).toBe('');
  expect(result.configured.resolutionId).toBe('1');
  expect(result.configured.comment).toBe('.');
  expect(result.optional.comment).toBe('');
  expect(result.invalid.resolutionId).toBe('');
  expect(result.invalid.hint).toContain('No default is guessed');
  expect(result.writes).toBe(1);
});

test('workflow-managed resolution is left alone and unsupported required fields block submission', async ({page}) => {
  const result = await page.evaluate(async () => {
    const f = window.fixture;
    f.transitions[0].fields = {};
    await f.begin('resolve');
    await f.workflow.submit({sessionId: 'popup-1'});
    f.transitions[0].fields = {customfield_1: {required: true, name: 'Root cause'}};
    await f.begin('resolve');
    await f.workflow.submit({sessionId: 'popup-1'});
    return {writes: f.writes, error: f.workflow.view().error};
  });
  expect(result.writes).toHaveLength(1);
  expect(result.writes[0].body).toEqual({transition: {id: '41'}});
  expect(result.error).toContain('Root cause');
});

test('write lock rejects duplicate submissions and refresh failure never permits a second write', async ({page}) => {
  const result = await page.evaluate(async () => {
    const f = window.fixture;
    let release;
    f.writePromise = new Promise(resolve => { release = resolve; });
    f.refreshFailure = true;
    await f.begin('plan', true);
    const first = f.workflow.submit({sessionId: 'popup-1'});
    const duplicate = await f.workflow.submit({sessionId: 'popup-1'});
    const switching = await f.begin('resolve');
    release();
    const saved = await first;
    const retry = await f.workflow.submit({sessionId: 'popup-1'});
    return {duplicate: duplicate.kind, switching: switching.kind, retry: retry.kind, saved, writes: f.writes.length};
  });
  expect(result.duplicate).toBe('ignored');
  expect(result.switching).toBe('ignored');
  expect(result.retry).toBe('ignored');
  expect(result.saved.kind).toBe('saved');
  expect(result.saved.notice).toContain('Refresh failed');
  expect(result.writes).toBe(1);
});

test('successful write remains non-retryable when remembering defaults fails', async ({page}) => {
  const result = await page.evaluate(async () => {
    const f = window.fixture;
    const workflow = window.JiraQuickViewDeepModules.createPopupShortcutWorkflow({...f.deps, savePreset: async () => { throw new Error('Storage full'); }});
    await workflow.begin({kind: 'resolve', sessionId: 'popup-1', issueSnapshot: f.snapshot});
    workflow.update({resolutionId: '1', comment: 'Done', remember: true});
    const saved = await workflow.submit({sessionId: 'popup-1'});
    await workflow.submit({sessionId: 'popup-1'});
    return {saved, writes: f.writes.length};
  });
  expect(result.saved.kind).toBe('saved');
  expect(result.saved.notice).toContain('Defaults could not be saved');
  expect(result.writes).toBe(1);
});

test('multiple completion transitions require a choice and changed transition clears the previous resolution', async ({page}) => {
  const result = await page.evaluate(async () => {
    const f = window.fixture;
    f.transitions.push({...f.transitions[0], id: '42', name: 'Close'});
    await f.begin('resolve');
    const initial = f.workflow.view().transitionId;
    await f.workflow.submit({sessionId: 'popup-1'});
    const error = f.workflow.view().error;
    f.workflow.update({transitionId: '41', resolutionId: '1'});
    f.workflow.update({transitionId: '42'});
    return {initial, error, resolution: f.workflow.view().resolutionId, writes: f.writes.length};
  });
  expect(result).toEqual({initial: '', error: 'Choose a transition.', resolution: '', writes: 0});
});

test('cancelled discovery, stale searches and stale sessions cannot change another workflow', async ({page}) => {
  const result = await page.evaluate(async () => {
    const f = window.fixture;
    let release;
    f.deps.jira.read = () => new Promise(resolve => { release = resolve; });
    const lateBegin = f.begin('resolve');
    f.workflow.reset();
    release({transitions: f.transitions});
    await lateBegin;
    const cancelled = f.workflow.view();
    await f.begin('plan');
    let releaseSearch;
    f.deps.issueData.search = () => new Promise(resolve => { releaseSearch = resolve; });
    const oldSearch = f.workflow.search('old');
    f.deps.issueData.search = async () => ({kind: 'loaded', items: [{accountId: 'new'}]});
    await f.workflow.search('new');
    releaseSearch({kind: 'loaded', items: [{accountId: 'old'}]});
    await oldSearch;
    f.workflow.update({userId: 'new'});
    const staleSubmit = await f.workflow.submit({sessionId: 'popup-2'});
    return {cancelled, users: f.workflow.view().users, staleSubmit, writes: f.writes.length};
  });
  expect(result).toEqual({cancelled: null, users: [{accountId: 'new'}], staleSubmit: {kind: 'ignored'}, writes: 0});
});

test('future sprints are offered, and the next-sprint target picks the first future sprint on the issue\'s board', async ({page}) => {
  const result = await page.evaluate(async () => {
    const f = window.fixture;
    f.sprints = [
      {id: 52, name: 'Other board next', state: 'future', startDate: '2026-11-01T00:00:00Z', boardRefs: [{id: '9'}]},
      {id: 51, name: 'Sprint 51', state: 'future', startDate: '2026-11-08T00:00:00Z', boardRefs: [{id: '7'}]},
      {id: 50, name: 'Sprint 50', state: 'future', startDate: '2026-11-02T00:00:00Z', boardRefs: [{id: '7'}]},
      {id: 42, name: 'Sprint 42', state: 'active', boardRefs: [{id: '7'}]},
      {id: 30, name: 'Old', state: 'closed', boardRefs: [{id: '7'}]},
    ];
    f.existingSprints = [{id: 42, name: 'Sprint 42', state: 'active'}];
    await f.begin('plan');
    const current = f.workflow.view();
    await f.workflow.begin({kind: 'plan', alternate: true, sprintTarget: 'next', sessionId: 'popup-1', issueSnapshot: f.snapshot});
    const next = f.workflow.view();
    await f.workflow.submit({sessionId: 'popup-1'});
    return {
      offered: current.sprints.map(item => item.name), currentId: current.sprintId, nextId: next.sprintId,
      fields: f.writes[0].body.fields,
    };
  });
  expect(result).toEqual({
    offered: ['Sprint 42', 'Other board next', 'Sprint 50', 'Sprint 51'], currentId: '42', nextId: '50',
    fields: {assignee: {accountId: 'me'}, customfield_10020: 50},
  });
});

test('Alt+2 moves straight to the current sprint, prefers the issue\'s board, and never guesses between boards', async ({page}) => {
  const result = await page.evaluate(async () => {
    const f = window.fixture;
    const single = await f.apply('current-sprint');
    f.existingSprints = [{id: 42}];
    const already = await f.apply('current-sprint');
    f.sprints = [
      {id: 42, name: 'Sprint 42', state: 'active', boardRefs: [{id: '7'}]},
      {id: 44, name: 'Other team', state: 'active', boardRefs: [{id: '9'}]},
      {id: 50, name: 'Sprint 50', state: 'future', boardRefs: [{id: '9'}]},
    ];
    f.existingSprints = [];
    const ambiguous = await f.apply('current-sprint');
    f.existingSprints = [{id: 50}];
    const byBoard = await f.apply('current-sprint');
    f.editable = false;
    const readonly = await f.apply('current-sprint');
    return {single, already, ambiguous, byBoard, readonly, writes: f.writes};
  });
  expect(result.single).toMatchObject({kind: 'saved', sessionId: 'popup-1', notice: 'Moved ABC-1 to Sprint 42'});
  expect(result.already).toEqual({kind: 'unchanged', notice: 'ABC-1 is already in Sprint 42'});
  expect(result.ambiguous).toEqual({kind: 'choose', notice: 'Several sprints are active. Choose one.'});
  expect(result.byBoard).toMatchObject({kind: 'saved', notice: 'Moved ABC-1 to Other team'});
  expect(result.readonly).toEqual({kind: 'error', message: 'Jira does not allow changing the sprint of this issue.'});
  expect(result.writes).toEqual([
    {method: 'PUT', path: 'https://jira.example/rest/api/2/issue/ABC-1', body: {fields: {customfield_10020: 42}}},
    {method: 'PUT', path: 'https://jira.example/rest/api/2/issue/ABC-1', body: {fields: {customfield_10020: 44}}},
  ]);
});

test('Alt+4 adds the first unreleased version in Jira order without replacing the others', async ({page}) => {
  const result = await page.evaluate(async () => {
    const f = window.fixture;
    f.snapshot.core.fields.fixVersions = [{id: '401', name: '2026.04'}];
    const added = await f.apply('next-fix-version');
    f.snapshot.core.fields.fixVersions = [{id: '302', name: '2026.05'}];
    const already = await f.apply('next-fix-version');
    f.versions = [{id: '301', name: '2026.03', released: true}];
    const none = await f.apply('next-fix-version');
    return {added, already, none, writes: f.writes};
  });
  expect(result.added).toMatchObject({kind: 'saved', notice: 'Added fix version 2026.05 to ABC-1'});
  expect(result.already).toEqual({kind: 'unchanged', notice: 'ABC-1 already has fix version 2026.05'});
  expect(result.none).toEqual({kind: 'error', message: 'This project has no unreleased version.'});
  expect(result.writes).toEqual([
    {method: 'PUT', path: 'https://jira.example/rest/api/2/issue/ABC-1', body: {update: {fixVersions: [{add: {id: '302'}}]}}},
  ]);
});

test('A reassigns, S changes the sprint, C focuses comments, and Ctrl/Cmd+C copies the link unless text is selected', async ({page}) => {
  const result = await page.evaluate(() => {
    const match = window.JiraQuickViewDeepModules.matchPopupShortcut;
    const base = {target: document.body};
    const noSelection = match({...base, key: 'c', code: 'KeyC', ctrlKey: true});
    const mac = match({...base, key: 'c', code: 'KeyC', metaKey: true});
    const range = document.createRange();
    document.body.append(document.createTextNode('Selected words'));
    range.selectNodeContents(document.body.lastChild);
    getSelection().addRange(range);
    return {
      comment: match({...base, key: 'c', code: 'KeyC'}), sprint: match({...base, key: 's', code: 'KeyS'}), assignee: match({...base, key: 'a', code: 'KeyA'}), noSelection, mac,
      withSelection: match({...base, key: 'c', code: 'KeyC', ctrlKey: true}),
      next: match({...base, key: '6', code: 'Digit6'}), nextAlt: match({...base, key: '§', code: 'Digit6', altKey: true}),
      inInput: match({target: document.querySelector('input'), key: 'c', code: 'KeyC', ctrlKey: true}),
      shifted: match({...base, key: 'C', code: 'KeyC', shiftKey: true}),
    };
  });
  expect(result).toEqual({
    comment: {digit: '7', alternate: false}, sprint: {digit: '2', alternate: false}, assignee: {digit: '1', alternate: false}, noSelection: {digit: '8', alternate: false}, mac: {digit: '8', alternate: false},
    withSelection: null, next: {digit: '6', alternate: false}, nextAlt: {digit: '6', alternate: true}, inInput: null, shifted: null,
  });
});

test('digit matching rejects editing, modifiers, IME, repeat and reserved variants; supports macOS Option digits', async ({page}) => {
  const result = await page.evaluate(() => {
    const match = window.JiraQuickViewDeepModules.matchPopupShortcut;
    const base = {key: '3', code: 'Digit3', target: document.body};
    return {
      normal: match(base), alt: match({...base, key: '£', altKey: true}),
      rejected: [
        {target: document.querySelector('input')}, {target: document.querySelector('#editor')},
        {repeat: true}, {isComposing: true}, {ctrlKey: true}, {metaKey: true}, {shiftKey: true},
        {defaultPrevented: true}, {getModifierState: () => true}, {key: '0', code: 'Digit0'},
        {key: '7', code: 'Digit7', altKey: true}, {key: '9', code: 'Digit9', altKey: true},
      ].map(change => match({...base, ...change})),
      help: match({...base, key: '0', code: 'Digit0', altKey: true}),
      accepted: [
        {key: '™', code: 'Digit2', altKey: true}, {key: '¢', code: 'Digit4', altKey: true},
        {key: '•', code: 'Digit8', altKey: true}, {key: '9', code: 'Digit9'},
      ].map(change => match({...base, ...change})),
    };
  });
  expect(result.normal).toEqual({digit: '3', alternate: false});
  expect(result.alt).toEqual({digit: '3', alternate: true});
  expect(result.help).toEqual({digit: '0', alternate: true});
  expect(result.rejected).toEqual(Array(12).fill(null));
  expect(result.accepted).toEqual([
    {digit: '2', alternate: true}, {digit: '4', alternate: true}, {digit: '8', alternate: true}, {digit: '9', alternate: false},
  ]);
});
