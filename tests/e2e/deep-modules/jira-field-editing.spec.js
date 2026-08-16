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

test('status editing owns transition options, automatic save, payload, and refresh', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'status', name: 'Status', schema: {type: 'status'}}]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {status: {name: 'Status'}}}},
      {operation: 'read', match: request => request.path.endsWith('/transitions'), result: {transitions: [
        {id: '31', name: 'Start progress', to: {id: '3', name: 'In Progress', iconUrl: 'https://jira.example/status-3.png'}},
        {id: '41', name: 'Done', to: {id: '5', name: 'Done', iconUrl: 'https://jira.example/status-5.png'}},
      ]}},
      {operation: 'write', method: 'POST', match: request => request.path.endsWith('/transitions'), result: {}},
      {operation: 'read', match: request => request.path.includes('/issue/ABC-1?fields='), result: {
        id: '1', key: 'ABC-1', fields: {summary: 'Issue', status: {id: '3', name: 'In Progress'}},
      }},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({
      sessionId: 'popup-1',
      issueSnapshot: {
        issueKey: 'ABC-1',
        issueId: '1',
        revision: 1,
        core: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', status: {id: '1', name: 'To Do'}}},
        sections: {},
      },
    });

    const begun = await fields.dispatch({type: 'begin', fieldId: 'status'});
    const selected = await fields.dispatch({type: 'selectOption', editId: begun.editId, optionId: '31'});
    const write = jira.getRequests().find(request => request.operation === 'write');
    return {
      begun: {
        kind: begun.kind,
        editorType: begun.view.edit?.editorType,
        labels: begun.view.edit?.options.map(option => option.label),
      },
      selected: {
        kind: selected.kind,
        notice: selected.notice,
        status: selected.refreshedSnapshot?.core?.fields?.status?.name,
      },
      write: write ? {method: write.method, path: write.path, body: write.body} : null,
      finalView: fields.view(),
    };
  });

  expect(result).toEqual({
    begun: {
      kind: 'changed',
      editorType: 'transition-select',
      labels: ['Start progress -> In Progress', 'Done'],
    },
    selected: {kind: 'saved', notice: 'Status moved to In Progress', status: 'In Progress'},
    write: {
      method: 'POST',
      path: 'https://jira.example/rest/api/2/issue/ABC-1/transitions',
      body: {transition: {id: '31'}},
    },
    finalView: {sessionId: 'popup-1', issueKey: 'ABC-1', edit: null},
  });
});

test('status keyboard filtering completes the highlighted transition and saves with Enter', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'status', name: 'Status'}]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {status: {name: 'Status'}}}},
      {operation: 'read', match: request => request.path.endsWith('/transitions'), result: {transitions: [
        {id: '31', name: 'Start progress', to: {id: '3', name: 'In Progress'}},
        {id: '41', name: 'Done', to: {id: '5', name: 'Done'}},
      ]}},
      {operation: 'write', method: 'POST', result: {}},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', status: {id: '5', name: 'Done'}}}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({
      sessionId: 'popup-1',
      issueSnapshot: {issueKey: 'ABC-1', core: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', status: {name: 'To Do'}}}, sections: {}},
    });

    const begun = await fields.dispatch({type: 'begin', fieldId: 'status'});
    const filtered = await fields.dispatch({
      type: 'inputChanged',
      editId: begun.editId,
      value: 'Do',
      selection: {start: 2, end: 2},
    });
    const saved = await fields.dispatch({type: 'key', editId: begun.editId, key: 'Enter'});
    const write = jira.getRequests().find(request => request.operation === 'write');
    return {
      filtered: {
        inputValue: filtered.view.edit?.inputValue,
        selectedOptionId: filtered.view.edit?.selectedOptionId,
        selectionStart: filtered.view.edit?.selectionStart,
        selectionEnd: filtered.view.edit?.selectionEnd,
      },
      saved: {kind: saved.kind, notice: saved.notice},
      writeBody: write?.body || null,
    };
  });

  expect(result).toEqual({
    filtered: {inputValue: 'Done', selectedOptionId: '41', selectionStart: 2, selectionEnd: 4},
    saved: {kind: 'saved', notice: 'Status moved to Done'},
    writeBody: {transition: {id: '41'}},
  });
});

test('failed status transition preserves the selection and remains retryable', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'status', name: 'Status'}]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {status: {name: 'Status'}}}},
      {operation: 'read', match: request => request.path.endsWith('/transitions'), result: {transitions: [
        {id: '31', name: 'Start progress', to: {id: '3', name: 'In Progress'}},
      ]}},
      {operation: 'write', method: 'POST', error: 'Transition unavailable'},
      {operation: 'write', method: 'POST', result: {}},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', status: {id: '3', name: 'In Progress'}}}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({
      sessionId: 'popup-1',
      issueSnapshot: {issueKey: 'ABC-1', core: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', status: {name: 'To Do'}}}, sections: {}},
    });
    const begun = await fields.dispatch({type: 'begin', fieldId: 'status'});
    const failed = await fields.dispatch({type: 'selectOption', editId: begun.editId, optionId: '31'});
    const failedView = fields.view();
    const retried = await fields.dispatch({type: 'save', editId: begun.editId});
    return {
      failed: {kind: failed.kind, message: failed.failure?.message},
      failedView: {
        error: failedView.edit?.errorMessage,
        inputValue: failedView.edit?.inputValue,
        selectedOptionId: failedView.edit?.selectedOptionId,
      },
      retried: {kind: retried.kind, notice: retried.notice},
      writeCount: jira.getRequests().filter(request => request.operation === 'write').length,
    };
  });

  expect(result).toEqual({
    failed: {kind: 'failed', message: 'Transition unavailable'},
    failedView: {error: 'Transition unavailable', inputValue: 'Start progress -> In Progress', selectedOptionId: '31'},
    retried: {kind: 'saved', notice: 'Status moved to In Progress'},
    writeCount: 2,
  });
});

test('status arrow navigation selects the next transition before Enter saves it', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'status', name: 'Status'}]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {status: {name: 'Status'}}}},
      {operation: 'read', match: request => request.path.endsWith('/transitions'), result: {transitions: [
        {id: '31', name: 'Start progress', to: {id: '3', name: 'In Progress'}},
        {id: '41', name: 'Done', to: {id: '5', name: 'Done'}},
      ]}},
      {operation: 'write', method: 'POST', result: {}},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', status: {id: '5', name: 'Done'}}}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({
      sessionId: 'popup-1',
      issueSnapshot: {issueKey: 'ABC-1', core: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', status: {name: 'To Do'}}}, sections: {}},
    });
    const begun = await fields.dispatch({type: 'begin', fieldId: 'status'});
    const moved = await fields.dispatch({type: 'key', editId: begun.editId, key: 'ArrowDown'});
    const saved = await fields.dispatch({type: 'key', editId: begun.editId, key: 'Enter'});
    const write = jira.getRequests().find(request => request.operation === 'write');
    return {
      highlightedOptionId: moved.view.edit?.highlightedOptionId,
      saved: {kind: saved.kind, notice: saved.notice},
      writeBody: write?.body || null,
    };
  });

  expect(result).toEqual({
    highlightedOptionId: '41',
    saved: {kind: 'saved', notice: 'Status moved to Done'},
    writeBody: {transition: {id: '41'}},
  });
});

test('issue type editing filters allowed values and saves the selected type', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'issuetype', name: 'Issue Type'}]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {issuetype: {
        name: 'Issue Type',
        operations: ['set'],
        allowedValues: [
          {id: '1', name: 'Bug', description: 'Bug report', subtask: false},
          {id: '2', name: 'Task', description: 'Work item', subtask: false},
          {id: '3', name: 'Sub-task', subtask: true},
        ],
      }}}},
      {operation: 'write', method: 'PUT', result: {}},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', issuetype: {id: '2', name: 'Task', subtask: false}}}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({
      sessionId: 'popup-1',
      issueSnapshot: {issueKey: 'ABC-1', core: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', issuetype: {id: '1', name: 'Bug', subtask: false}}}, sections: {}},
    });
    const begun = await fields.dispatch({type: 'begin', fieldId: 'issuetype'});
    const selected = await fields.dispatch({type: 'selectOption', editId: begun.editId, optionId: '2'});
    const writesBeforeEnter = jira.getRequests().filter(request => request.operation === 'write').length;
    const saved = await fields.dispatch({type: 'key', editId: begun.editId, key: 'Enter'});
    const write = jira.getRequests().find(request => request.operation === 'write');
    return {
      begun: {
        kind: begun.kind,
        labels: begun.view.edit?.options.map(option => option.label),
        selectedOptionId: begun.view.edit?.selectedOptionId,
      },
      selected: {kind: selected.kind, selectedOptionId: selected.view.edit?.selectedOptionId},
      writesBeforeEnter,
      saved: {kind: saved.kind, notice: saved.notice, type: saved.refreshedSnapshot?.core?.fields?.issuetype?.name},
      write: write ? {method: write.method, path: write.path, body: write.body} : null,
    };
  });

  expect(result).toEqual({
    begun: {kind: 'changed', labels: ['Bug', 'Task'], selectedOptionId: '1'},
    selected: {kind: 'changed', selectedOptionId: '2'},
    writesBeforeEnter: 0,
    saved: {kind: 'saved', notice: 'Issue type set to Task', type: 'Task'},
    write: {
      method: 'PUT',
      path: 'https://jira.example/rest/api/2/issue/ABC-1',
      body: {fields: {issuetype: {id: '2'}}},
    },
  });
});

test('priority editing reuses allowed-value selection with the priority payload', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'priority', name: 'Priority'}]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {priority: {
        name: 'Priority',
        operations: ['set'],
        allowedValues: [
          {id: '1', name: 'Highest', iconUrl: 'https://jira.example/highest.png'},
          {id: '2', name: 'Medium', iconUrl: 'https://jira.example/medium.png'},
        ],
      }}}},
      {operation: 'write', method: 'PUT', result: {}},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', priority: {id: '1', name: 'Highest'}}}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({
      sessionId: 'popup-1',
      issueSnapshot: {issueKey: 'ABC-1', core: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', priority: {id: '2', name: 'Medium'}}}, sections: {}},
    });
    const begun = await fields.dispatch({type: 'begin', fieldId: 'priority'});
    await fields.dispatch({type: 'selectOption', editId: begun.editId, optionId: '1'});
    const saved = await fields.dispatch({type: 'key', editId: begun.editId, key: 'Enter'});
    const write = jira.getRequests().find(request => request.operation === 'write');
    return {
      begun: {kind: begun.kind, labels: begun.view.edit?.options.map(option => option.label)},
      saved: {kind: saved.kind, notice: saved.notice, priority: saved.refreshedSnapshot?.core?.fields?.priority?.name},
      writeBody: write?.body || null,
    };
  });

  expect(result).toEqual({
    begun: {kind: 'changed', labels: ['Highest', 'Medium']},
    saved: {kind: 'saved', notice: 'Priority set to Highest', priority: 'Highest'},
    writeBody: {fields: {priority: {id: '1'}}},
  });
});
