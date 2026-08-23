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

test('field editing describes built-in capabilities and Parent linkage through its interface', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [
        {id: 'status', name: 'Status', schema: {type: 'status'}},
        {id: 'parent', name: 'Parent'},
      ]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {
        status: {name: 'Status', operations: ['set']},
        parent: {name: 'Parent', operations: ['set']},
      }}},
      {operation: 'read', match: request => request.path.endsWith('/transitions'), result: {transitions: [
        {id: '31', name: 'Start progress', to: {id: '3', name: 'In Progress'}},
      ]}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({sessionId: 'popup-1', issueSnapshot: {
      issueKey: 'ABC-1',
      core: {id: '1', key: 'ABC-1', fields: {parent: {key: 'ABC-9', fields: {summary: 'Current parent'}}}},
      sections: {},
    }});
    const status = await fields.dispatch({type: 'describeField', fieldId: 'status'});
    const linkage = await fields.dispatch({type: 'describeLinkage'});
    return {
      status: {kind: status.kind, field: status.field},
      linkage: {kind: linkage.kind, linkage: linkage.linkage},
    };
  });

  expect(result).toEqual({
    status: {
      kind: 'described',
      field: {
        allowedValues: [],
        editable: true,
        fieldId: 'status',
        operations: ['set'],
        transitions: [{
          id: '31',
          label: 'Start progress -> In Progress',
          iconUrl: '',
          metaText: 'Start progress',
          searchText: 'start progress -> in progress in progress start progress',
          targetStatusName: 'In Progress',
          transitionName: 'Start progress',
        }],
      },
    },
    linkage: {
      kind: 'described',
      linkage: {
        currentLink: {key: 'ABC-9', summary: 'Current parent', url: 'https://jira.example/browse/ABC-9'},
        editable: true,
        fieldId: 'parent',
        label: 'Parent',
        mode: 'parent',
      },
    },
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
    const filtered = await fields.dispatch({
      type: 'inputChanged',
      editId: begun.editId,
      value: 'Ta',
      selection: {start: 2, end: 2},
    });
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
      filteredVisibleOptionIds: filtered.view.edit?.visibleOptions?.map(option => option.id),
      selected: {kind: selected.kind, selectedOptionId: selected.view.edit?.selectedOptionId},
      writesBeforeEnter,
      saved: {kind: saved.kind, notice: saved.notice, type: saved.refreshedSnapshot?.core?.fields?.issuetype?.name},
      write: write ? {method: write.method, path: write.path, body: write.body} : null,
    };
  });

  expect(result).toEqual({
    begun: {kind: 'changed', labels: ['Bug', 'Task'], selectedOptionId: '1'},
    filteredVisibleOptionIds: ['2'],
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

test('fix version editing owns multi-selection, filtering, keyboard selection, and the Jira payload', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'fixVersions', name: 'Fix Version/s'}]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {fixVersions: {
        name: 'Fix Version/s',
        operations: ['set'],
      }}}},
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/project/ABC/versions'), result: [
        {id: '1', name: 'v1'},
        {id: '10', name: 'v10'},
        {id: '2', name: 'v2', archived: true},
      ]},
      {operation: 'write', method: 'PUT', result: {}},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', fixVersions: [{id: '1', name: 'v1'}, {id: '10', name: 'v10'}]}}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({
      sessionId: 'popup-1',
      issueSnapshot: {issueKey: 'ABC-1', core: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', fixVersions: [{id: '1', name: 'v1'}]}}, sections: {}},
    });

    const begun = await fields.dispatch({type: 'begin', fieldId: 'fixVersions'});
    const filtered = await fields.dispatch({type: 'inputChanged', editId: begun.editId, value: 'v10'});
    const selected = await fields.dispatch({type: 'key', editId: begun.editId, key: 'Enter'});
    const writesBeforeSave = jira.getRequests().filter(request => request.operation === 'write').length;
    const saved = await fields.dispatch({type: 'key', editId: begun.editId, key: 'Enter', ctrlKey: true});
    const write = jira.getRequests().find(request => request.operation === 'write');
    return {
      begun: {
        kind: begun.kind,
        labels: begun.view.edit?.options.map(option => option.label),
        selectedOptionIds: begun.view.edit?.selectedOptionIds,
      },
      filtered: {kind: filtered.kind, inputValue: filtered.view.edit?.inputValue},
      selected: {
        kind: selected.kind,
        selectedOptionIds: selected.view.edit?.selectedOptionIds,
        hasChanges: selected.view.edit?.hasChanges,
      },
      writesBeforeSave,
      saved: {kind: saved.kind, notice: saved.notice},
      writeBody: write?.body || null,
    };
  });

  expect(result).toEqual({
    begun: {kind: 'changed', labels: ['v10', 'v1'], selectedOptionIds: ['1']},
    filtered: {kind: 'changed', inputValue: 'v10'},
    selected: {kind: 'changed', selectedOptionIds: ['1', '10'], hasChanges: true},
    writesBeforeSave: 0,
    saved: {kind: 'saved', notice: 'Fix versions updated'},
    writeBody: {fields: {fixVersions: [{id: '1'}, {id: '10'}]}},
  });
});

test('version chip selection toggles off and saves the cleared Affects version field', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'versions', name: 'Affects Version/s'}]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {versions: {name: 'Affects Version/s'}}}},
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/project/ABC/versions'), result: [{id: '1', name: '2026.1'}]},
      {operation: 'write', method: 'PUT', result: {}},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', versions: []}}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({
      sessionId: 'popup-1',
      issueSnapshot: {issueKey: 'ABC-1', core: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', versions: [{id: '1', name: '2026.1'}]}}, sections: {}},
    });
    const begun = await fields.dispatch({type: 'begin', fieldId: 'versions'});
    const removed = await fields.dispatch({type: 'selectOption', editId: begun.editId, optionId: '1'});
    const saved = await fields.dispatch({type: 'save', editId: begun.editId});
    const write = jira.getRequests().find(request => request.operation === 'write');
    return {
      removed: {
        kind: removed.kind,
        selectedOptionIds: removed.view.edit?.selectedOptionIds,
        selectedOptions: removed.view.edit?.selectedOptions,
        hasChanges: removed.view.edit?.hasChanges,
      },
      saved: {kind: saved.kind, notice: saved.notice},
      writeBody: write?.body || null,
    };
  });

  expect(result).toEqual({
    removed: {kind: 'changed', selectedOptionIds: [], selectedOptions: [], hasChanges: true},
    saved: {kind: 'saved', notice: 'Affects versions cleared'},
    writeBody: {fields: {versions: []}},
  });
});

test('failed version save preserves the selection and remains retryable', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'fixVersions', name: 'Fix Version/s'}]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {fixVersions: {name: 'Fix Version/s', operations: ['set']}}}},
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/project/ABC/versions'), result: [{id: '1', name: 'v1'}, {id: '2', name: 'v2'}]},
      {operation: 'write', method: 'PUT', error: 'Version save unavailable'},
      {operation: 'write', method: 'PUT', result: {}},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', fixVersions: [{id: '2', name: 'v2'}]}}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({
      sessionId: 'popup-1',
      issueSnapshot: {issueKey: 'ABC-1', core: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', fixVersions: [{id: '1', name: 'v1'}]}}, sections: {}},
    });
    const begun = await fields.dispatch({type: 'begin', fieldId: 'fixVersions'});
    await fields.dispatch({type: 'selectOption', editId: begun.editId, optionId: '1'});
    await fields.dispatch({type: 'selectOption', editId: begun.editId, optionId: '2'});
    const failed = await fields.dispatch({type: 'save', editId: begun.editId});
    const failedView = fields.view().edit;
    const retried = await fields.dispatch({type: 'save', editId: begun.editId});
    return {
      failed: {kind: failed.kind, failure: failed.failure?.message},
      failedView: {
        selectedOptionIds: failedView?.selectedOptionIds,
        hasChanges: failedView?.hasChanges,
        errorMessage: failedView?.errorMessage,
      },
      retried: {kind: retried.kind, notice: retried.notice},
      writeCount: jira.getRequests().filter(request => request.operation === 'write').length,
    };
  });

  expect(result).toEqual({
    failed: {kind: 'failed', failure: 'Version save unavailable'},
    failedView: {selectedOptionIds: ['2'], hasChanges: true, errorMessage: 'Version save unavailable'},
    retried: {kind: 'saved', notice: 'Fix versions updated'},
    writeCount: 2,
  });
});

test('Sprint editing owns resolved field ids, board grouping, selection, and the Jira payload', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const sprintField = {id: 'customfield_10020', name: 'Sprint', schema: {custom: 'com.pyxis.greenhopper.jira:gh-sprint'}};
    const currentIssue = {
      id: '1',
      key: 'ABC-1',
      names: {customfield_10020: 'Sprint'},
      fields: {
        project: {key: 'ABC', name: 'Alpha'},
        summary: 'Issue',
        customfield_10020: [{id: 41, name: 'Current', state: 'active', boardId: 7}],
      },
    };
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [sprintField]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {customfield_10020: {...sprintField, operations: ['set']}}}},
      {operation: 'read', match: request => request.path.includes('/issue/ABC-1?fields='), result: currentIssue},
      {operation: 'read', match: request => request.path.includes('/rest/agile/1.0/board?'), result: {values: [
        {id: 7, name: 'Delivery'},
        {id: 8, name: 'Platform'},
      ]}},
      {operation: 'read', match: request => request.path.includes('/rest/agile/1.0/board/7/sprint?'), result: {values: [
        {id: 41, name: 'Current', state: 'active'},
        {id: 42, name: 'Next', state: 'future'},
      ]}},
      {operation: 'read', match: request => request.path.includes('/rest/agile/1.0/board/8/sprint?'), result: {values: [
        {id: 50, name: 'Platform Future', state: 'future'},
      ]}},
      {operation: 'write', method: 'PUT', result: {}},
      {operation: 'read', match: request => request.path.includes('/issue/ABC-1?fields='), result: {
        ...currentIssue,
        fields: {...currentIssue.fields, customfield_10020: [{id: 42, name: 'Next', state: 'future', boardId: 7}]},
      }},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({sessionId: 'popup-1', issueSnapshot: {issueKey: 'ABC-1', core: currentIssue, sections: {}}});

    const begun = await fields.dispatch({type: 'begin', fieldId: 'sprint'});
    const selected = await fields.dispatch({type: 'selectOption', editId: begun.editId, optionId: '42'});
    const saved = await fields.dispatch({type: 'key', editId: begun.editId, key: 'Enter'});
    const write = jira.getRequests().find(request => request.operation === 'write');
    return {
      begun: {
        kind: begun.kind,
        labels: begun.view.edit?.options.map(option => option.label),
        groupLabels: begun.view.edit?.options.filter(option => option.isGroupLabel).map(option => option.label),
        selectedOptionId: begun.view.edit?.selectedOptionId,
      },
      selected: {kind: selected.kind, selectedOptionId: selected.view.edit?.selectedOptionId},
      saved: {kind: saved.kind, notice: saved.notice},
      writeBody: write?.body || null,
    };
  });

  expect(result).toEqual({
    begun: {
      kind: 'changed',
      labels: ['No sprint', 'ABC board', 'Current (ACTIVE)', 'Next (FUTURE)', 'Platform', 'Platform Future (FUTURE)'],
      groupLabels: ['ABC board', 'Platform'],
      selectedOptionId: '41',
    },
    selected: {kind: 'changed', selectedOptionId: '42'},
    saved: {kind: 'saved', notice: 'Sprint set to Next (FUTURE)'},
    writeBody: {fields: {customfield_10020: 42}},
  });
});

test('Sprint editing clears the resolved Jira field with null', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const sprintField = {id: 'customfield_10020', name: 'Sprint', schema: {custom: 'com.pyxis.greenhopper.jira:gh-sprint'}};
    const currentIssue = {
      id: '1',
      key: 'ABC-1',
      names: {customfield_10020: 'Sprint'},
      fields: {summary: 'Issue', customfield_10020: [{id: 41, name: 'Current', state: 'active', boardId: 7}]},
    };
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [sprintField]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {customfield_10020: sprintField}}},
      {operation: 'read', match: request => request.path.includes('/issue/ABC-1?fields='), result: currentIssue},
      {operation: 'read', match: request => request.path.includes('/rest/agile/1.0/board?'), result: {values: [{id: 7, name: 'Delivery'}]}},
      {operation: 'read', match: request => request.path.includes('/rest/agile/1.0/board/7/sprint?'), result: {values: [{id: 41, name: 'Current', state: 'active'}]}},
      {operation: 'write', method: 'PUT', result: {}},
      {operation: 'read', match: request => request.path.includes('/issue/ABC-1?fields='), result: {
        ...currentIssue,
        fields: {...currentIssue.fields, customfield_10020: []},
      }},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({sessionId: 'popup-1', issueSnapshot: {issueKey: 'ABC-1', core: currentIssue, sections: {}}});
    const begun = await fields.dispatch({type: 'begin', fieldId: 'sprint'});
    await fields.dispatch({type: 'selectOption', editId: begun.editId, optionId: ''});
    const saved = await fields.dispatch({type: 'key', editId: begun.editId, key: 'Enter'});
    const write = jira.getRequests().find(request => request.operation === 'write');
    return {saved: {kind: saved.kind, notice: saved.notice}, writeBody: write?.body || null};
  });

  expect(result).toEqual({
    saved: {kind: 'saved', notice: 'Sprint cleared'},
    writeBody: {fields: {customfield_10020: null}},
  });
});

test('Sprint option failure leaves the interface retryable', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const sprintField = {id: 'customfield_10020', name: 'Sprint', schema: {custom: 'com.pyxis.greenhopper.jira:gh-sprint'}};
    const currentIssue = {id: '1', key: 'ABC-1', names: {customfield_10020: 'Sprint'}, fields: {summary: 'Issue', customfield_10020: []}};
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [sprintField]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {customfield_10020: sprintField}}},
      {operation: 'read', match: request => request.path.includes('/issue/ABC-1?fields='), result: currentIssue},
      {operation: 'read', match: request => request.path.includes('/rest/agile/1.0/board?'), error: 'Boards unavailable'},
      {operation: 'read', match: request => request.path.includes('/rest/agile/1.0/board?'), result: {values: [{id: 7, name: 'Delivery'}]}},
      {operation: 'read', match: request => request.path.includes('/rest/agile/1.0/board/7/sprint?'), result: {values: [{id: 42, name: 'Next', state: 'future'}]}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({sessionId: 'popup-1', issueSnapshot: {issueKey: 'ABC-1', core: currentIssue, sections: {}}});
    const failed = await fields.dispatch({type: 'begin', fieldId: 'sprint'});
    const retried = await fields.dispatch({type: 'begin', fieldId: 'sprint'});
    return {
      failed: {kind: failed.kind, failure: failed.failure?.message, edit: failed.view.edit},
      retried: {kind: retried.kind, labels: retried.view.edit?.options.map(option => option.label)},
      boardRequests: jira.getRequests().filter(request => request.path.includes('/rest/agile/1.0/board?')).length,
    };
  });

  expect(result).toEqual({
    failed: {kind: 'ignored', failure: 'Boards unavailable', edit: null},
    retried: {kind: 'changed', labels: ['No sprint', 'Next (FUTURE)']},
    boardRequests: 2,
  });
});

test('Assignee editing owns initial options, merged search, selection, payload, and refresh', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'assignee', name: 'Assignee'}]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {assignee: {name: 'Assignee', operations: ['set']}}}},
      {operation: 'read', match: request => request.path.includes('/rest/internal/2/users/assignee') && request.path.includes('query='), result: [
        {accountId: 'bob-1', name: 'bob', key: 'BOB', displayName: 'Bob Builder'},
      ]},
      {operation: 'read', match: request => request.path.includes('/rest/internal/2/users/assignee') && request.path.includes('query=morgan'), result: [
        {accountId: 'morgan-1', name: 'morgan', key: 'MORGAN', displayName: 'Morgan Agent'},
      ]},
      {operation: 'read', match: request => request.path.includes('/rest/api/2/user/picker?query=morgan'), result: {users: [
        {accountId: 'morgan-1', name: 'morgan', key: 'MORGAN', displayName: 'Morgan Agent'},
        {accountId: 'mae-1', name: 'mae', key: 'MAE', displayName: 'Mae Agent'},
      ]}},
      {operation: 'write', method: 'PUT', match: request => request.path.endsWith('/issue/ABC-1/assignee'), result: {}},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', assignee: {accountId: 'morgan-1', displayName: 'Morgan Agent'}}}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({
      sessionId: 'popup-1',
      issueSnapshot: {issueKey: 'ABC-1', core: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', assignee: {
        accountId: 'ada-1', name: 'ada', key: 'ADA', displayName: 'Ada Agent',
      }}}, sections: {}},
    });
    const begun = await fields.dispatch({type: 'begin', fieldId: 'assignee'});
    const searched = await fields.dispatch({type: 'inputChanged', editId: begun.editId, value: 'Morgan'});
    const selected = await fields.dispatch({type: 'selectOption', editId: begun.editId, optionId: 'morgan-1'});
    const saved = await fields.dispatch({type: 'key', editId: begun.editId, key: 'Enter'});
    const write = jira.getRequests().find(request => request.operation === 'write');
    return {
      begun: {
        kind: begun.kind,
        ids: begun.view.edit?.options.map(option => option.id),
        selectedOptionId: begun.view.edit?.selectedOptionId,
      },
      searched: {kind: searched.kind, labels: searched.view.edit?.options.map(option => option.label)},
      selected: {kind: selected.kind, selectedOptionId: selected.view.edit?.selectedOptionId},
      saved: {kind: saved.kind, notice: saved.notice},
      write: write ? {method: write.method, path: write.path, body: write.body} : null,
    };
  });

  expect(result).toEqual({
    begun: {kind: 'changed', ids: ['__unassigned__', 'ada-1', 'bob-1'], selectedOptionId: 'ada-1'},
    searched: {kind: 'changed', labels: ['Unassigned', 'Ada Agent', 'Morgan Agent', 'Mae Agent', 'Bob Builder']},
    selected: {kind: 'changed', selectedOptionId: 'morgan-1'},
    saved: {kind: 'saved', notice: 'Assignee set to Morgan Agent'},
    write: {
      method: 'PUT',
      path: 'https://jira.example/rest/api/2/issue/ABC-1/assignee',
      body: {accountId: 'morgan-1'},
    },
  });
});

test('Assignee payload fallback and clearing preserve Jira identifier ordering', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const field = {id: 'assignee', name: 'Assignee'};
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [field]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {assignee: field}}},
      {operation: 'read', match: request => request.path.includes('/rest/internal/2/users/assignee'), result: [
        {accountId: 'morgan-1', name: 'morgan', key: 'MORGAN', displayName: 'Morgan Agent'},
      ]},
      {operation: 'write', method: 'PUT', error: 'Name payload unsupported'},
      {operation: 'write', method: 'PUT', result: {}},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', assignee: {accountId: 'morgan-1', displayName: 'Morgan Agent'}}}},
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [field]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {assignee: field}}},
      {operation: 'read', match: request => request.path.includes('/rest/internal/2/users/assignee'), result: []},
      {operation: 'write', method: 'PUT', result: {}},
      {operation: 'read', result: {id: '2', key: 'XYZ-2', fields: {summary: 'Other', assignee: null}}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({
      sessionId: 'popup-1',
      issueSnapshot: {issueKey: 'ABC-1', core: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', assignee: {name: 'ada', displayName: 'Ada Agent'}}}, sections: {}},
    });
    const begun = await fields.dispatch({type: 'begin', fieldId: 'assignee'});
    await fields.dispatch({type: 'selectOption', editId: begun.editId, optionId: 'morgan-1'});
    const assigned = await fields.dispatch({type: 'save', editId: begun.editId});

    fields.attach({
      sessionId: 'popup-2',
      issueSnapshot: {issueKey: 'XYZ-2', core: {id: '2', key: 'XYZ-2', fields: {summary: 'Other', assignee: {accountId: 'ada-2', displayName: 'Ada Two'}}}, sections: {}},
    });
    const clearBegun = await fields.dispatch({type: 'begin', fieldId: 'assignee'});
    await fields.dispatch({type: 'selectOption', editId: clearBegun.editId, optionId: '__unassigned__'});
    const cleared = await fields.dispatch({type: 'save', editId: clearBegun.editId});
    return {
      assigned: {kind: assigned.kind, notice: assigned.notice},
      cleared: {kind: cleared.kind, notice: cleared.notice},
      writeBodies: jira.getRequests().filter(request => request.operation === 'write').map(request => request.body),
    };
  });

  expect(result).toEqual({
    assigned: {kind: 'saved', notice: 'Assignee set to Morgan Agent'},
    cleared: {kind: 'saved', notice: 'Assignee cleared'},
    writeBodies: [{name: 'morgan'}, {accountId: 'morgan-1'}, {accountId: null}],
  });
});

test('a stale Assignee search cannot replace newer suggestions', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createDeferred, createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const oldAssignee = createDeferred();
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'assignee', name: 'Assignee'}]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {assignee: {name: 'Assignee'}}}},
      {operation: 'read', match: request => request.path.includes('/rest/internal/2/users/assignee') && request.path.endsWith('query='), result: []},
      {operation: 'read', match: request => request.path.includes('/rest/internal/2/users/assignee') && request.path.includes('query=old'), deferred: oldAssignee},
      {operation: 'read', match: request => request.path.includes('/rest/api/2/user/picker?query=old'), result: {users: []}},
      {operation: 'read', match: request => request.path.includes('/rest/internal/2/users/assignee') && request.path.includes('query=new'), result: [
        {accountId: 'new-1', displayName: 'New Result'},
      ]},
      {operation: 'read', match: request => request.path.includes('/rest/api/2/user/picker?query=new'), result: {users: []}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({
      sessionId: 'popup-1',
      issueSnapshot: {issueKey: 'ABC-1', core: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', assignee: null}}, sections: {}},
    });
    const begun = await fields.dispatch({type: 'begin', fieldId: 'assignee'});
    const oldSearch = fields.dispatch({type: 'inputChanged', editId: begun.editId, value: 'old'});
    await Promise.resolve();
    const newSearch = await fields.dispatch({type: 'inputChanged', editId: begun.editId, value: 'new'});
    oldAssignee.resolve([{accountId: 'old-1', displayName: 'Old Result'}]);
    const stale = await oldSearch;
    return {
      newSearch: {kind: newSearch.kind, labels: newSearch.view.edit?.options.map(option => option.label)},
      stale: {kind: stale.kind},
      finalLabels: fields.view().edit?.options.map(option => option.label),
    };
  });

  expect(result).toEqual({
    newSearch: {kind: 'changed', labels: ['Unassigned', 'New Result']},
    stale: {kind: 'ignored'},
    finalLabels: ['Unassigned', 'New Result'],
  });
});

test('Cloud Parent editing owns local-first search, grouping, payload, and refresh', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const currentIssue = {
      id: '1',
      key: 'ABC-1',
      fields: {
        summary: 'Issue',
        project: {id: '10', key: 'ABC'},
        issuetype: {id: 'story'},
        parent: {key: 'ABC-9', fields: {summary: 'Current parent'}},
      },
    };
    const localIssues = [
      {key: 'ABC-9', fields: {summary: 'Current parent', project: {key: 'ABC'}, issuetype: {id: 'epic'}, status: {name: 'Open'}}},
      {key: 'ABC-10', fields: {summary: 'Next parent', project: {key: 'ABC'}, issuetype: {id: 'epic'}, status: {name: 'Open'}}},
    ];
    const remoteIssue = {key: 'XYZ-2', fields: {summary: 'Remote parent', project: {key: 'XYZ'}, issuetype: {id: 'epic'}, status: {name: 'Backlog'}}};
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'parent', name: 'Parent'}]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {parent: {name: 'Parent', operations: ['set']}}}},
      {operation: 'read', match: request => request.path.includes('/issue/ABC-1?fields='), result: currentIssue},
      {operation: 'read', match: request => request.path.endsWith('/rest/api/3/issuetype'), result: [
        {id: 'story', hierarchyLevel: 0},
        {id: 'epic', hierarchyLevel: 1},
      ]},
      {operation: 'read', match: request => request.path.includes('/rest/api/latest/search?') && new URL(request.path).searchParams.get('jql').includes('project = "ABC"'), result: {issues: localIssues}},
      {operation: 'read', match: request => request.path.includes('/rest/api/latest/search?') && new URL(request.path).searchParams.get('jql').includes('project != "ABC"'), result: {issues: [remoteIssue]}},
      {operation: 'write', method: 'PUT', result: {}},
      {operation: 'read', match: request => request.path.includes('/issue/ABC-1?fields='), result: {
        ...currentIssue,
        fields: {...currentIssue.fields, parent: {key: 'ABC-10', fields: {summary: 'Next parent'}}},
      }},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({sessionId: 'popup-1', issueSnapshot: {issueKey: 'ABC-1', core: currentIssue, sections: {}}});
    const begun = await fields.dispatch({type: 'begin', fieldId: 'parentLink'});
    await fields.dispatch({type: 'selectOption', editId: begun.editId, optionId: 'ABC-10'});
    const saved = await fields.dispatch({type: 'key', editId: begun.editId, key: 'Enter'});
    const write = jira.getRequests().find(request => request.operation === 'write');
    return {
      begun: {
        kind: begun.kind,
        ids: begun.view.edit?.options.filter(option => !option.isGroupLabel).map(option => option.id),
        groupLabels: begun.view.edit?.options.filter(option => option.isGroupLabel).map(option => option.label),
        selectedOptionId: begun.view.edit?.selectedOptionId,
      },
      saved: {kind: saved.kind, notice: saved.notice},
      writeBody: write?.body || null,
    };
  });

  expect(result).toEqual({
    begun: {
      kind: 'changed',
      ids: ['ABC-9', 'ABC-10', 'XYZ-2'],
      groupLabels: ['ABC project', 'Other projects'],
      selectedOptionId: 'ABC-9',
    },
    saved: {kind: 'saved', notice: 'Parent set to ABC-10'},
    writeBody: {fields: {parent: {key: 'ABC-10'}}},
  });
});

test('Data Center Epic Link editing uses the resolved custom field while presenting Parent', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const epicField = {id: 'customfield_10014', name: 'Epic Link', schema: {custom: 'com.pyxis.greenhopper.jira:gh-epic-link'}};
    const currentIssue = {
      id: '1',
      key: 'ABC-1',
      names: {customfield_10014: 'Epic Link'},
      fields: {
        summary: 'Issue',
        project: {id: '10', key: 'ABC'},
        issuetype: {id: 'story'},
        parent: null,
        customfield_10014: 'ABC-9',
      },
    };
    const candidate = key => ({key, fields: {
      summary: key === 'ABC-9' ? 'Current epic' : 'Next epic',
      project: {key: 'ABC'},
      issuetype: {id: 'epic'},
      status: {name: 'Open'},
    }});
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [epicField]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {customfield_10014: {...epicField, operations: ['set']}}}},
      {operation: 'read', match: request => request.path.includes('/issue/ABC-1?fields='), result: currentIssue},
      {operation: 'read', match: request => request.path.endsWith('/rest/api/3/issuetype'), result: [
        {id: 'story', hierarchyLevel: 0},
        {id: 'epic', hierarchyLevel: 1},
      ]},
      {operation: 'read', match: request => request.path.includes('/rest/api/latest/search?') && new URL(request.path).searchParams.get('jql').includes('project = "ABC"'), result: {issues: [candidate('ABC-9'), candidate('ABC-10')]}},
      {operation: 'read', match: request => request.path.includes('/rest/api/latest/search?') && new URL(request.path).searchParams.get('jql').includes('project != "ABC"'), result: {issues: []}},
      {operation: 'write', method: 'PUT', result: {}},
      {operation: 'read', match: request => request.path.includes('/issue/ABC-1?fields='), result: {
        ...currentIssue,
        fields: {...currentIssue.fields, customfield_10014: 'ABC-10'},
      }},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({sessionId: 'popup-1', issueSnapshot: {issueKey: 'ABC-1', core: currentIssue, sections: {}}});
    const begun = await fields.dispatch({type: 'begin', fieldId: 'parentLink'});
    await fields.dispatch({type: 'selectOption', editId: begun.editId, optionId: 'ABC-10'});
    const saved = await fields.dispatch({type: 'save', editId: begun.editId});
    const write = jira.getRequests().find(request => request.operation === 'write');
    return {
      begun: {
        kind: begun.kind,
        fieldKey: begun.view.edit?.fieldKey,
        label: begun.view.edit?.label,
        selectedLabel: begun.view.edit?.selectedOptions[0]?.label,
      },
      saved: {kind: saved.kind, notice: saved.notice},
      writeBody: write?.body || null,
    };
  });

  expect(result).toEqual({
    begun: {kind: 'changed', fieldKey: 'parentLink', label: 'Parent', selectedLabel: '[ABC-9] Current epic'},
    saved: {kind: 'saved', notice: 'Parent set to ABC-10'},
    writeBody: {fields: {customfield_10014: 'ABC-10'}},
  });
});

test('Labels editing owns suggestions, multi-selection, keyboard toggling, payload, and refresh', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'labels', name: 'Labels'}]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {labels: {name: 'Labels', operations: ['set']}}}},
      {operation: 'read', match: request => request.path.includes('fieldName=labels') && request.path.endsWith('fieldValue='), result: {
        suggestions: [{label: 'existing'}, {label: 'baseline'}],
      }},
      {operation: 'read', match: request => request.path.includes('fieldValue=release'), result: {
        suggestions: [{label: 'release-candidate'}, {label: 'release-ready'}],
      }},
      {operation: 'write', method: 'PUT', result: {}},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', labels: ['existing', 'release-candidate']}}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({
      sessionId: 'popup-1',
      issueSnapshot: {issueKey: 'ABC-1', core: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', labels: ['existing']}}, sections: {}},
    });
    const begun = await fields.dispatch({type: 'begin', fieldId: 'labels'});
    const searched = await fields.dispatch({type: 'inputChanged', editId: begun.editId, value: 'release'});
    const toggled = await fields.dispatch({type: 'key', editId: begun.editId, key: 'Enter'});
    const saved = await fields.dispatch({type: 'save', editId: begun.editId});
    const write = jira.getRequests().find(request => request.operation === 'write');
    return {
      begun: {kind: begun.kind, labels: begun.view.edit?.options.map(option => option.label), selectedOptionIds: begun.view.edit?.selectedOptionIds},
      searched: {kind: searched.kind, labels: searched.view.edit?.options.map(option => option.label)},
      toggled: {
        kind: toggled.kind,
        inputValue: toggled.view.edit?.inputValue,
        selectedOptionIds: toggled.view.edit?.selectedOptionIds,
      },
      saved: {kind: saved.kind, notice: saved.notice},
      writeBody: write?.body || null,
    };
  });

  expect(result).toEqual({
    begun: {kind: 'changed', labels: ['existing', 'baseline'], selectedOptionIds: ['existing']},
    searched: {kind: 'changed', labels: ['release-candidate', 'release-ready']},
    toggled: {kind: 'changed', inputValue: 'release', selectedOptionIds: ['existing', 'release-candidate']},
    saved: {kind: 'saved', notice: 'Labels updated'},
    writeBody: {fields: {labels: ['existing', 'release-candidate']}},
  });
});

test('Labels search failure preserves selections and succeeds on retry', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'labels', name: 'Labels'}]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {labels: {name: 'Labels'}}}},
      {operation: 'read', match: request => request.path.includes('fieldName=labels') && request.path.endsWith('fieldValue='), result: {suggestions: [{label: 'existing'}]}},
      {operation: 'read', match: request => request.path.includes('fieldValue=recover'), error: 'Labels unavailable'},
      {operation: 'read', match: request => request.path.includes('fieldValue=recover'), result: {suggestions: [{label: 'recovered'}]}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({
      sessionId: 'popup-1',
      issueSnapshot: {issueKey: 'ABC-1', core: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', labels: ['existing']}}, sections: {}},
    });
    const begun = await fields.dispatch({type: 'begin', fieldId: 'labels'});
    const failed = await fields.dispatch({type: 'inputChanged', editId: begun.editId, value: 'recover'});
    const retried = await fields.dispatch({type: 'inputChanged', editId: begun.editId, value: 'recover'});
    return {
      failed: {
        kind: failed.kind,
        errorMessage: failed.view.edit?.errorMessage,
        selectedOptionIds: failed.view.edit?.selectedOptionIds,
      },
      retried: {
        kind: retried.kind,
        labels: retried.view.edit?.options.map(option => option.label),
        selectedOptionIds: retried.view.edit?.selectedOptionIds,
      },
      searchCount: jira.getRequests().filter(request => request.path.includes('fieldValue=recover')).length,
    };
  });

  expect(result).toEqual({
    failed: {kind: 'failed', errorMessage: 'Labels unavailable', selectedOptionIds: ['existing']},
    retried: {kind: 'changed', labels: ['recovered'], selectedOptionIds: ['existing']},
    searchCount: 2,
  });
});

test('Labels input debounce cancels superseded searches inside the editing interface', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'labels', name: 'Labels'}]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {labels: {name: 'Labels'}}}},
      {operation: 'read', match: request => request.path.includes('fieldName=labels') && request.path.endsWith('fieldValue='), result: {suggestions: []}},
      {operation: 'read', match: request => request.path.includes('fieldValue=new'), result: {suggestions: [{label: 'new-label'}]}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({
      sessionId: 'popup-1',
      issueSnapshot: {issueKey: 'ABC-1', core: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', labels: []}}, sections: {}},
    });
    const begun = await fields.dispatch({type: 'begin', fieldId: 'labels'});
    const supersededPromise = fields.dispatch({type: 'inputChanged', editId: begun.editId, value: 'old'});
    const latestPromise = fields.dispatch({type: 'inputChanged', editId: begun.editId, value: 'new'});
    const [superseded, latest] = await Promise.all([supersededPromise, latestPromise]);
    const labelSearches = jira.getRequests().filter(request => request.path.includes('fieldName=labels') && !request.path.endsWith('fieldValue='));
    return {
      superseded: superseded.kind,
      latest: latest.kind,
      labels: latest.view.edit?.options.map(option => option.label),
      searchPaths: labelSearches.map(request => request.path),
    };
  });

  expect(result).toEqual({
    superseded: 'ignored',
    latest: 'changed',
    labels: ['new-label'],
    searchPaths: ['https://jira.example/rest/api/2/jql/autocompletedata/suggestions?fieldName=labels&fieldValue=new'],
  });
});

test('Environment editing owns textarea state, exact payload, notice, and refresh', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'environment', name: 'Environment', schema: {type: 'string'}}]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {environment: {name: 'Environment', operations: ['set'], schema: {type: 'string'}}}}},
      {operation: 'write', method: 'PUT', result: {}},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', environment: '  Linux staging  '}}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({
      sessionId: 'popup-1',
      issueSnapshot: {issueKey: 'ABC-1', core: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', environment: 'Linux'}}, sections: {}},
    });
    const begun = await fields.dispatch({type: 'begin', fieldId: 'environment'});
    const changed = await fields.dispatch({
      type: 'inputChanged',
      editId: begun.editId,
      value: '  Linux staging  ',
      selection: {start: 4, end: 9},
    });
    const saved = await fields.dispatch({type: 'save', editId: begun.editId});
    const write = jira.getRequests().find(request => request.operation === 'write');
    return {
      begun: {
        kind: begun.kind,
        editorType: begun.view.edit?.editorType,
        inputValue: begun.view.edit?.inputValue,
        placeholder: begun.view.edit?.inputPlaceholder,
      },
      changed: {
        kind: changed.kind,
        inputValue: changed.view.edit?.inputValue,
        selectionStart: changed.view.edit?.selectionStart,
        selectionEnd: changed.view.edit?.selectionEnd,
      },
      saved: {kind: saved.kind, notice: saved.notice, environment: saved.refreshedSnapshot?.core?.fields?.environment},
      writeBody: write?.body || null,
    };
  });

  expect(result).toEqual({
    begun: {kind: 'changed', editorType: 'textarea', inputValue: 'Linux', placeholder: 'Describe the environment'},
    changed: {kind: 'changed', inputValue: '  Linux staging  ', selectionStart: 4, selectionEnd: 9},
    saved: {kind: 'saved', notice: 'Environment updated', environment: '  Linux staging  '},
    writeBody: {fields: {environment: '  Linux staging  '}},
  });
});

test('Environment clearing uses null and a failed save remains retryable', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'environment', name: 'Environment'}]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {environment: {name: 'Environment', operations: ['set']}}}},
      {operation: 'write', method: 'PUT', error: 'Environment update failed'},
      {operation: 'write', method: 'PUT', result: {}},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', environment: null}}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({
      sessionId: 'popup-1',
      issueSnapshot: {issueKey: 'ABC-1', core: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', environment: 'Linux'}}, sections: {}},
    });
    const begun = await fields.dispatch({type: 'begin', fieldId: 'environment'});
    await fields.dispatch({type: 'inputChanged', editId: begun.editId, value: '   '});
    const failed = await fields.dispatch({type: 'save', editId: begun.editId});
    const retried = await fields.dispatch({type: 'save', editId: begun.editId});
    const writes = jira.getRequests().filter(request => request.operation === 'write');
    return {
      failed: {kind: failed.kind, errorMessage: failed.view.edit?.errorMessage, inputValue: failed.view.edit?.inputValue},
      retried: {kind: retried.kind, notice: retried.notice},
      writeBodies: writes.map(request => request.body),
    };
  });

  expect(result).toEqual({
    failed: {kind: 'failed', errorMessage: 'Environment update failed', inputValue: '   '},
    retried: {kind: 'saved', notice: 'Environment cleared'},
    writeBodies: [{fields: {environment: null}}, {fields: {environment: null}}],
  });
});

test('custom text fields expose a presentation projection and preserve exact text payloads', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const field = {
      id: 'customfield_12345',
      name: 'Customer impact',
      schema: {type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea'},
    };
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [field]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {customfield_12345: {...field, operations: ['set']}}}},
      {operation: 'write', method: 'PUT', result: {}},
      {operation: 'read', result: {id: '1', key: 'ABC-1', names: {customfield_12345: 'Customer impact'}, fields: {summary: 'Issue', customfield_12345: '  High\nimpact  '}}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({
      sessionId: 'popup-1',
      issueSnapshot: {
        issueKey: 'ABC-1',
        core: {id: '1', key: 'ABC-1', names: {customfield_12345: 'Customer impact'}, fields: {summary: 'Issue', customfield_12345: null}},
        sections: {},
      },
    });

    const described = await fields.dispatch({type: 'describeField', fieldId: 'customfield_12345'});
    const begun = await fields.dispatch({type: 'begin', fieldId: 'customfield_12345'});
    await fields.dispatch({type: 'inputChanged', editId: begun.editId, value: '  High\nimpact  ', selection: {start: 2, end: 6}});
    const saved = await fields.dispatch({type: 'save', editId: begun.editId});
    const write = jira.getRequests().find(request => request.operation === 'write');
    return {
      described: {kind: described.kind, field: described.field},
      begun: {kind: begun.kind, editorType: begun.view.edit?.editorType, label: begun.view.edit?.label},
      saved: {kind: saved.kind, notice: saved.notice},
      writeBody: write?.body || null,
    };
  });

  expect(result).toEqual({
    described: {
      kind: 'described',
      field: {
        editable: true,
        empty: true,
        fieldId: 'customfield_12345',
        jqlClause: '',
        linkLabel: '',
        supported: true,
        text: 'Customer impact: --',
        visibleWhenEmpty: true,
      },
    },
    begun: {kind: 'changed', editorType: 'textarea', label: 'Customer impact'},
    saved: {kind: 'saved', notice: 'Customer impact updated'},
    writeBody: {fields: {customfield_12345: '  High\nimpact  '}},
  });
});

test('multi-select custom fields own selected values, direct removal, and Jira payload shape', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const field = {id: 'customfield_22222', name: 'Regions', schema: {type: 'array', items: 'option'}};
    const current = [{id: '1', value: 'North'}, {id: '2', value: 'South'}];
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [field]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {customfield_22222: {...field, operations: ['set'], allowedValues: [...current, {id: '3', value: 'West'}]}}}},
      {operation: 'write', method: 'PUT', result: {}},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', customfield_22222: [{id: '2', value: 'South'}, {id: '3', value: 'West'}]}}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({sessionId: 'popup-1', issueSnapshot: {issueKey: 'ABC-1', core: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', customfield_22222: current}}, sections: {}}});

    const begun = await fields.dispatch({type: 'begin', fieldId: 'customfield_22222'});
    await fields.dispatch({type: 'selectOption', editId: begun.editId, optionId: '1'});
    const selected = await fields.dispatch({type: 'selectOption', editId: begun.editId, optionId: '3'});
    const saved = await fields.dispatch({type: 'save', editId: begun.editId});
    const write = jira.getRequests().find(request => request.operation === 'write');
    return {
      begun: {kind: begun.kind, editorType: begun.view.edit?.editorType, selectedIds: begun.view.edit?.selectedOptionIds},
      selectedIds: selected.view.edit?.selectedOptionIds,
      saved: {kind: saved.kind, notice: saved.notice},
      writeBody: write?.body || null,
    };
  });

  expect(result).toEqual({
    begun: {kind: 'changed', editorType: 'multi-select', selectedIds: ['1', '2']},
    selectedIds: ['2', '3'],
    saved: {kind: 'saved', notice: 'Regions updated'},
    writeBody: {fields: {customfield_22222: [{id: '2'}, {id: '3'}]}},
  });
});

test('user-picker custom fields merge both search strategies and retry Jira identity payloads', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const field = {id: 'customfield_54321', name: 'Approver', schema: {type: 'user'}};
    const alex = {accountId: 'cloud-alex', name: 'alex', key: 'ALEX', displayName: 'Alex Reviewer'};
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [field]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {customfield_54321: {...field, operations: ['set']}}}},
      {operation: 'read', match: request => request.path.includes('/users/assignee'), result: []},
      {operation: 'read', match: request => request.path.includes('/user/picker'), result: {users: [alex]}},
      {operation: 'read', match: request => request.path.includes('/users/assignee'), result: [alex]},
      {operation: 'read', match: request => request.path.includes('/user/picker'), result: {users: [alex]}},
      {operation: 'write', method: 'PUT', error: 'accountId unsupported'},
      {operation: 'write', method: 'PUT', result: {}},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', customfield_54321: alex}}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({sessionId: 'popup-1', issueSnapshot: {issueKey: 'ABC-1', core: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', customfield_54321: null}}, sections: {}}});

    const begun = await fields.dispatch({type: 'begin', fieldId: 'customfield_54321'});
    const searched = await fields.dispatch({type: 'inputChanged', editId: begun.editId, value: 'Alex'});
    await fields.dispatch({type: 'selectOption', editId: begun.editId, optionId: 'cloud-alex'});
    const saved = await fields.dispatch({type: 'save', editId: begun.editId});
    const writes = jira.getRequests().filter(request => request.operation === 'write');
    return {
      begun: {kind: begun.kind, editorType: begun.view.edit?.editorType, labels: begun.view.edit?.options.map(option => option.label)},
      searched: {kind: searched.kind, labels: searched.view.edit?.options.map(option => option.label)},
      saved: {kind: saved.kind, notice: saved.notice},
      writeBodies: writes.map(request => request.body),
    };
  });

  expect(result).toEqual({
    begun: {kind: 'changed', editorType: 'user-search', labels: ['Clear Approver', 'Alex Reviewer']},
    searched: {kind: 'changed', labels: ['Clear Approver', 'Alex Reviewer']},
    saved: {kind: 'saved', notice: 'Approver set to Alex Reviewer'},
    writeBodies: [
      {fields: {customfield_54321: {accountId: 'cloud-alex'}}},
      {fields: {customfield_54321: {name: 'alex'}}},
    ],
  });
});

test('Tempo account custom fields own search, clearing, and payload fallback order', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createJiraFieldEditing, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const field = {id: 'customfield_77777', name: 'Account', schema: {type: 'account', custom: 'com.tempoplugin.tempo-accounts:accounts.customfield'}};
    const account = {id: 42, key: 'ACME', name: 'Acme delivery', customer: {name: 'Acme'}};
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [field]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {customfield_77777: {...field, operations: ['set']}}}},
      {operation: 'read', match: request => request.path.includes('/tempo-accounts/1/account/search'), result: {accounts: [account]}},
      {operation: 'read', match: request => request.path.includes('/tempo-accounts/1/account/search'), result: {accounts: [account]}},
      {operation: 'write', method: 'PUT', error: 'object id unsupported'},
      {operation: 'write', method: 'PUT', result: {}},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', project: {id: '10000'}, customfield_77777: account}}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const fields = createJiraFieldEditing({jira, issueData, instanceUrl: 'https://jira.example/'});
    fields.attach({sessionId: 'popup-1', issueSnapshot: {issueKey: 'ABC-1', core: {id: '1', key: 'ABC-1', fields: {summary: 'Issue', project: {id: '10000'}, customfield_77777: null}}, sections: {}}});

    const begun = await fields.dispatch({type: 'begin', fieldId: 'customfield_77777'});
    const searched = await fields.dispatch({type: 'inputChanged', editId: begun.editId, value: 'Acme'});
    await fields.dispatch({type: 'selectOption', editId: begun.editId, optionId: '42'});
    const saved = await fields.dispatch({type: 'save', editId: begun.editId});
    const writes = jira.getRequests().filter(request => request.operation === 'write');
    return {
      begun: {kind: begun.kind, editorType: begun.view.edit?.editorType, labels: begun.view.edit?.options.map(option => option.label)},
      searched: {kind: searched.kind, labels: searched.view.edit?.options.map(option => option.label)},
      saved: {kind: saved.kind, notice: saved.notice},
      writeBodies: writes.map(request => request.body),
    };
  });

  expect(result).toEqual({
    begun: {kind: 'changed', editorType: 'tempo-account-search', labels: ['Clear Account', 'Acme delivery']},
    searched: {kind: 'changed', labels: ['Clear Account', 'Acme delivery']},
    saved: {kind: 'saved', notice: 'Account set to Acme delivery'},
    writeBodies: [
      {fields: {customfield_77777: {id: 42}}},
      {fields: {customfield_77777: 42}},
    ],
  });
});
