const path = require('path');
const {test, expect} = require('@playwright/test');

const harnessPath = path.resolve(__dirname, '../../output/playwright/deep-modules/harness.js');

test.beforeEach(async ({page}) => {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({path: harnessPath});
});

test('summary editing owns begin, input, write, refresh, and observable outcome', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'summary', name: 'Summary', schema: {type: 'string'}}]},
      {operation: 'read', match: request => request.path.includes('/issue/ABC-1?fields='), result: {id: '1', key: 'ABC-1', fields: {summary: 'Before'}}},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {summary: {name: 'Summary', operations: ['set'], schema: {type: 'string'}}}}},
      {operation: 'write', method: 'PUT', match: request => request.path.endsWith('/rest/api/2/issue/ABC-1'), result: {}},
      {operation: 'read', match: request => request.path.includes('/issue/ABC-1?fields='), result: {id: '1', key: 'ABC-1', fields: {summary: 'After'}}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const initial = await issueData.openIssue({issueKey: 'ABC-1'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({sessionId: 'popup-1', issueSnapshot: initial.snapshot});

    const begun = await fields.dispatch({type: 'begin', fieldId: 'summary'});
    const changed = await fields.dispatch({
      type: 'inputChanged',
      editId: begun.editId,
      value: 'After',
      selection: {start: 5, end: 5},
    });
    const saved = await fields.dispatch({type: 'save', editId: begun.editId});
    const write = jira.getRequests().find(request => request.operation === 'write');
    return {
      begun: {kind: begun.kind, value: begun.view.edit.inputValue, hasChanges: begun.view.edit.hasChanges},
      changed: {kind: changed.kind, value: changed.view.edit.inputValue, hasChanges: changed.view.edit.hasChanges},
      saved: {kind: saved.kind, notice: saved.notice, summary: saved.refreshedSnapshot.core.fields.summary},
      finalView: fields.view(),
      write: {method: write.method, path: write.path, body: write.body},
    };
  });

  expect(result.begun).toEqual({kind: 'changed', value: 'Before', hasChanges: false});
  expect(result.changed).toEqual({kind: 'changed', value: 'After', hasChanges: true});
  expect(result.saved).toEqual({kind: 'saved', notice: 'Issue title updated', summary: 'After'});
  expect(result.finalView.edit).toBeNull();
  expect(result.write).toEqual({
    method: 'PUT',
    path: 'https://jira.example/rest/api/2/issue/ABC-1',
    body: {fields: {summary: 'After'}},
  });
});

test('failed summary save preserves the draft and remains retryable', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'summary', name: 'Summary', schema: {type: 'string'}}]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {summary: {name: 'Summary', operations: ['set']}}}},
      {operation: 'write', method: 'PUT', error: 'Save unavailable'},
      {operation: 'write', method: 'PUT', result: {}},
      {operation: 'read', match: request => request.path.includes('/issue/ABC-1?fields='), result: {id: '1', key: 'ABC-1', fields: {summary: 'Recovered'}}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({
      sessionId: 'popup-1',
      issueSnapshot: {issueKey: 'ABC-1', issueId: '1', revision: 1, core: {id: '1', key: 'ABC-1', fields: {summary: 'Before'}}, sections: {}},
    });
    const begun = await fields.dispatch({type: 'begin', fieldId: 'summary'});
    await fields.dispatch({type: 'inputChanged', editId: begun.editId, value: 'Recovered', selection: {start: 9, end: 9}});
    const failed = await fields.dispatch({type: 'save', editId: begun.editId});
    const failedView = fields.view();
    const retried = await fields.dispatch({type: 'save', editId: begun.editId});
    return {
      failed: {kind: failed.kind, failure: failed.failure.message},
      failedView: {
        value: failedView.edit.inputValue,
        error: failedView.edit.errorMessage,
        saving: failedView.edit.saving,
      },
      retried: {kind: retried.kind, summary: retried.refreshedSnapshot.core.fields.summary},
      writeCount: jira.getRequests().filter(request => request.operation === 'write').length,
    };
  });

  expect(result).toEqual({
    failed: {kind: 'failed', failure: 'Save unavailable'},
    failedView: {value: 'Recovered', error: 'Save unavailable', saving: false},
    retried: {kind: 'saved', summary: 'Recovered'},
    writeCount: 2,
  });
});

test('detach prevents an old definition result from opening an editor in a new popup session', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createDeferred, createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const editMeta = createDeferred();
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'summary', name: 'Summary'}]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), deferred: editMeta},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({sessionId: 'popup-1', issueSnapshot: {issueKey: 'ABC-1', core: {key: 'ABC-1', fields: {summary: 'Old'}}, sections: {}}});
    const pending = fields.dispatch({type: 'begin', fieldId: 'summary'});
    for (let attempt = 0; attempt < 20 && !jira.getRequests().some(request => request.path.endsWith('/editmeta')); attempt += 1) {
      await Promise.resolve();
    }
    fields.detach({sessionId: 'popup-1', reason: 'issue-switch'});
    fields.attach({sessionId: 'popup-2', issueSnapshot: {issueKey: 'XYZ-2', core: {key: 'XYZ-2', fields: {summary: 'New'}}, sections: {}}});
    editMeta.resolve({fields: {summary: {name: 'Summary', operations: ['set']}}});
    const outcome = await pending;
    return {kind: outcome.kind, outcomeSessionId: outcome.sessionId, view: fields.view()};
  });

  expect(result.kind).toBe('ignored');
  expect(result.outcomeSessionId).toBe('popup-1');
  expect(result.view).toMatchObject({sessionId: 'popup-2', issueKey: 'XYZ-2', edit: null});
});

test('a completed write from a detached session cannot start a stale issue refresh', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createDeferred, createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const write = createDeferred();
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'summary', name: 'Summary'}]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {summary: {name: 'Summary', operations: ['set']}}}},
      {operation: 'write', method: 'PUT', deferred: write},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({sessionId: 'popup-1', issueSnapshot: {issueKey: 'ABC-1', core: {key: 'ABC-1', fields: {summary: 'Old'}}, sections: {}}});
    const begun = await fields.dispatch({type: 'begin', fieldId: 'summary'});
    await fields.dispatch({type: 'inputChanged', editId: begun.editId, value: 'Changed'});
    const pending = fields.dispatch({type: 'save', editId: begun.editId});
    for (let attempt = 0; attempt < 20 && !jira.getRequests().some(request => request.operation === 'write'); attempt += 1) {
      await Promise.resolve();
    }
    fields.detach({sessionId: 'popup-1'});
    fields.attach({sessionId: 'popup-2', issueSnapshot: {issueKey: 'XYZ-2', core: {key: 'XYZ-2', fields: {summary: 'New'}}, sections: {}}});
    write.resolve({});
    const outcome = await pending;
    return {
      kind: outcome.kind,
      outcomeSessionId: outcome.sessionId,
      staleRefreshCount: jira.getRequests().filter(request => request.operation === 'read' && request.path.includes('/issue/ABC-1?fields=')).length,
      view: fields.view(),
    };
  });

  expect(result).toEqual({
    kind: 'ignored',
    outcomeSessionId: 'popup-1',
    staleRefreshCount: 0,
    view: {sessionId: 'popup-2', issueKey: 'XYZ-2', edit: null},
  });
});
