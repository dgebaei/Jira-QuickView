const path = require('path');
const {test, expect} = require('@playwright/test');

const harnessPath = path.resolve(__dirname, '../../output/playwright/deep-modules/harness.js');

test.beforeEach(async ({page}) => {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({path: harnessPath});
});

test('quick actions own discovery, write, refresh, and observable state', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createPopupQuickActions} = window.JiraQuickViewDeepModules;
    const writes = [];
    const refreshedSnapshot = {
      issueKey: 'ABC-1',
      core: {key: 'ABC-1', fields: {assignee: {accountId: 'me'}}},
      sections: {},
    };
    const actions = createPopupQuickActions({
      INSTANCE_URL: 'https://jira.example/',
      formatSprintActionLabel: sprint => `Move to ${sprint.name}`,
      getProjectSprintOptions: async () => ({activeSprints: [], upcomingSprint: null}),
      issueData: {async refreshAfterMutation() { return {snapshot: refreshedSnapshot}; }},
      jira: {async write(request) { writes.push(request); return {}; }},
      loadFieldContext: async request => request.fieldId === 'status'
        ? {context: {transitions: [{id: '31', name: 'Start progress', to: {name: 'In Progress'}}]}}
        : {context: {fieldId: 'customfield_10020'}},
      loadViewer: async () => ({accountId: 'me'}),
      readSprintsFromIssue: () => [],
    });
    const initialSnapshot = {issueKey: 'ABC-1', core: {key: 'ABC-1', fields: {assignee: null}}, sections: {}};
    await actions.attach({sessionId: 'popup-1', issueSnapshot: initialSnapshot});
    const before = actions.view();
    const outcome = await actions.dispatch({type: 'execute', actionKey: 'assign-to-me'});
    return {
      before: {keys: before.actions.map(action => action.key), status: before.status},
      outcome: {kind: outcome.kind, notice: outcome.notice, issueKey: outcome.refreshedSnapshot.core.key},
      after: actions.view(),
      writes,
    };
  });

  expect(result.before).toEqual({keys: ['assign-to-me', 'start-progress'], status: 'ready'});
  expect(result.outcome).toEqual({kind: 'executed', notice: 'Assigned to you', issueKey: 'ABC-1'});
  expect(result.after.actions.map(action => action.key)).toEqual(['start-progress']);
  expect(result.after.notice).toBe('Assigned to you');
  expect(result.writes).toEqual([{
    method: 'PUT',
    path: 'https://jira.example/rest/api/2/issue/ABC-1/assignee',
    body: {accountId: 'me'},
  }]);
});

test('failed quick actions remain retryable and expose feedback through the interface', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createPopupQuickActions} = window.JiraQuickViewDeepModules;
    let attempts = 0;
    const snapshot = {issueKey: 'ABC-1', core: {key: 'ABC-1', fields: {assignee: null}}, sections: {}};
    const actions = createPopupQuickActions({
      INSTANCE_URL: 'https://jira.example/',
      formatSprintActionLabel: sprint => sprint.name,
      getProjectSprintOptions: async () => ({activeSprints: [], upcomingSprint: null}),
      issueData: {async refreshAfterMutation() { return {snapshot}; }},
      jira: {async write() { attempts += 1; if (attempts === 1) throw new Error('Write unavailable'); }},
      loadFieldContext: async request => request.fieldId === 'status'
        ? {context: {transitions: []}}
        : {context: {fieldId: ''}},
      loadViewer: async () => ({accountId: 'me'}),
      readSprintsFromIssue: () => [],
    });
    await actions.attach({sessionId: 'popup-1', issueSnapshot: snapshot});
    const failed = await actions.dispatch({type: 'execute', actionKey: 'assign-to-me'});
    const failedView = actions.view();
    const retried = await actions.dispatch({type: 'execute', actionKey: 'assign-to-me'});
    return {
      failed: {kind: failed.kind, failure: failed.failure.message},
      failedView: {errorMessage: failedView.errorMessage, loadingKey: failedView.loadingKey},
      retried: retried.kind,
      attempts,
    };
  });

  expect(result).toEqual({
    failed: {kind: 'failed', failure: 'Write unavailable'},
    failedView: {errorMessage: 'Write unavailable', loadingKey: ''},
    retried: 'executed',
    attempts: 2,
  });
});

test('detaching rejects a late quick-action catalog from the old popup issue', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createDeferred, createPopupQuickActions} = window.JiraQuickViewDeepModules;
    const viewer = createDeferred();
    const actions = createPopupQuickActions({
      INSTANCE_URL: 'https://jira.example/',
      formatSprintActionLabel: sprint => sprint.name,
      getProjectSprintOptions: async () => ({activeSprints: [], upcomingSprint: null}),
      issueData: {async refreshAfterMutation() { return {}; }},
      jira: {async write() {}},
      loadFieldContext: async request => request.fieldId === 'status'
        ? {context: {transitions: []}}
        : {context: {fieldId: ''}},
      loadViewer: () => viewer.promise,
      readSprintsFromIssue: () => [],
    });
    const pending = actions.attach({
      sessionId: 'popup-1',
      issueSnapshot: {issueKey: 'ABC-1', core: {key: 'ABC-1', fields: {assignee: null}}, sections: {}},
    });
    actions.detach({sessionId: 'popup-1'});
    viewer.resolve({accountId: 'me'});
    const outcome = await pending;
    return {outcome, view: actions.view()};
  });

  expect(result.outcome).toEqual({kind: 'ignored', reason: 'superseded'});
  expect(result.view).toMatchObject({actions: [], issueKey: '', sessionId: '', status: 'detached'});
});
