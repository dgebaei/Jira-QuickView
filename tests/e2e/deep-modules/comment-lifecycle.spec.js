const path = require('path');
const {test, expect} = require('@playwright/test');

const harnessPath = path.resolve(__dirname, '../../output/playwright/deep-modules/harness.js');

test.beforeEach(async ({page}) => {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({path: harnessPath});
});

test('new-comment lifecycle owns draft, write, refresh, and observable outcome', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createCommentLifecycle, createMockJiraAdapter} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {
        operation: 'write',
        method: 'POST',
        match: request => request.path.endsWith('/rest/api/2/issue/ABC-1/comment'),
        result: {id: '101', body: 'Ready for [~accountid:abc]'},
      },
    ]});
    const refreshes = [];
    const issueData = {
      async refreshAfterMutation(request) {
        refreshes.push(request);
        return {
          kind: 'loaded',
          snapshot: {
            issueKey: request.issueKey,
            core: {key: request.issueKey, fields: {comment: {comments: [{id: '101'}]}}},
            sections: {},
          },
        };
      },
    };
    const comments = createCommentLifecycle({jira, issueData, instanceUrl: 'https://jira.example/'});
    comments.attach({
      sessionId: 'popup-1',
      issueSnapshot: {issueKey: 'ABC-1', core: {key: 'ABC-1', fields: {}}, sections: {}},
    });
    await comments.dispatch({
      type: 'composeChanged',
      value: 'Ready for @Ada',
      selection: {start: 14, end: 14},
      mentionMappings: [{
        displayText: '@Ada',
        markup: '[~accountid:abc]',
        start: 10,
        beforeContext: 'Ready for ',
        afterContext: '',
      }],
    });
    const beforeSave = comments.view();
    const saved = await comments.dispatch({type: 'saveNewComment', requirements: {history: true}});
    const write = jira.getRequests().find(request => request.operation === 'write');
    return {
      beforeSave,
      saved: {
        kind: saved.kind,
        mutation: saved.mutation,
        notice: saved.notice,
        refreshedIssueKey: saved.refreshedSnapshot.issueKey,
      },
      finalView: comments.view(),
      write: {method: write.method, path: write.path, body: write.body},
      refreshes,
    };
  });

  expect(result.beforeSave).toMatchObject({
    sessionId: 'popup-1',
    issueKey: 'ABC-1',
    compose: {
      value: 'Ready for @Ada',
      selection: {start: 14, end: 14},
      saving: false,
      errorMessage: '',
      canSave: true,
    },
    protectFromAutoHide: true,
  });
  expect(result.saved).toEqual({
    kind: 'mutationCommitted',
    mutation: {kind: 'commentChanged'},
    notice: 'Comment added',
    refreshedIssueKey: 'ABC-1',
  });
  expect(result.finalView).toMatchObject({
    compose: {value: '', saving: false, errorMessage: '', canSave: false},
    protectFromAutoHide: false,
  });
  expect(result.write).toEqual({
    method: 'POST',
    path: 'https://jira.example/rest/api/2/issue/ABC-1/comment',
    body: {body: 'Ready for [~accountid:abc]'},
  });
  expect(result.refreshes).toEqual([{
    issueKey: 'ABC-1',
    mutation: {kind: 'commentChanged'},
    priorSnapshot: {issueKey: 'ABC-1', core: {key: 'ABC-1', fields: {}}, sections: {}},
    requirements: {history: true},
    signal: {},
  }]);
});

test('failed new-comment save preserves a retryable draft and visible feedback', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createCommentLifecycle, createMockJiraAdapter} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'write', method: 'POST', error: 'Save unavailable'},
      {operation: 'write', method: 'POST', result: {id: '102', body: 'Retry me'}},
    ]});
    const issueData = {
      async refreshAfterMutation(request) {
        return {kind: 'loaded', snapshot: {issueKey: request.issueKey, core: {key: request.issueKey}, sections: {}}};
      },
    };
    const comments = createCommentLifecycle({jira, issueData, instanceUrl: 'https://jira.example/'});
    comments.attach({sessionId: 'popup-1', issueSnapshot: {issueKey: 'ABC-1', core: {key: 'ABC-1'}, sections: {}}});
    await comments.dispatch({type: 'composeChanged', value: 'Retry me', selection: {start: 8, end: 8}});
    const failed = await comments.dispatch({type: 'saveNewComment'});
    const failedView = comments.view();
    const retried = await comments.dispatch({type: 'saveNewComment'});
    return {
      failed: {kind: failed.kind, failure: failed.failure},
      failedView,
      retried: {kind: retried.kind},
      writeCount: jira.getRequests().filter(request => request.operation === 'write').length,
    };
  });

  expect(result.failed).toEqual({kind: 'failed', failure: {name: 'Error', message: 'Save unavailable'}});
  expect(result.failedView).toMatchObject({
    compose: {
      value: 'Retry me',
      selection: {start: 8, end: 8},
      saving: false,
      errorMessage: 'Save unavailable',
      canSave: true,
    },
    protectFromAutoHide: true,
  });
  expect(result.retried).toEqual({kind: 'mutationCommitted'});
  expect(result.writeCount).toBe(2);
});

test('a committed write followed by a failed refresh cannot invite a duplicate save', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createCommentLifecycle, createMockJiraAdapter} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'write', method: 'POST', result: {id: '103', body: 'Refresh me'}},
    ]});
    const issueData = {
      async refreshAfterMutation() {
        return {kind: 'failed', snapshot: null, failures: {core: {name: 'Error', message: 'Refresh unavailable'}}};
      },
    };
    const comments = createCommentLifecycle({jira, issueData, instanceUrl: 'https://jira.example/'});
    comments.attach({sessionId: 'popup-1', issueSnapshot: {issueKey: 'ABC-1', core: {key: 'ABC-1'}, sections: {}}});
    await comments.dispatch({type: 'composeChanged', value: 'Refresh me', selection: {start: 10, end: 10}});
    const outcome = await comments.dispatch({type: 'saveNewComment'});
    return {outcome, view: comments.view()};
  });

  expect(result.outcome).toMatchObject({
    kind: 'mutationCommitted',
    failure: {name: 'Error', message: 'Refresh unavailable'},
    mutation: {kind: 'commentChanged'},
    notice: 'Comment added; refresh unavailable',
    writeCommitted: true,
  });
  expect(result.view).toMatchObject({
    compose: {
      value: '',
      selection: {start: 0, end: 0},
      saving: false,
      errorMessage: '',
      canSave: false,
    },
    protectFromAutoHide: false,
  });
});

test('a save completed for an old popup issue cannot refresh or clear the current draft', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createCommentLifecycle, createDeferred, createMockJiraAdapter} = window.JiraQuickViewDeepModules;
    const write = createDeferred();
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'write', method: 'POST', deferred: write},
    ]});
    const refreshes = [];
    const issueData = {
      async refreshAfterMutation(request) {
        refreshes.push(request.issueKey);
        return {kind: 'loaded', snapshot: {issueKey: request.issueKey, core: {key: request.issueKey}, sections: {}}};
      },
    };
    const comments = createCommentLifecycle({jira, issueData, instanceUrl: 'https://jira.example/'});
    comments.attach({sessionId: 'popup-1', issueSnapshot: {issueKey: 'ABC-1', core: {key: 'ABC-1'}, sections: {}}});
    await comments.dispatch({type: 'composeChanged', value: 'Old issue'});
    const pending = comments.dispatch({type: 'saveNewComment'});
    for (let attempt = 0; attempt < 20 && !jira.getRequests().length; attempt += 1) await Promise.resolve();
    comments.detach({sessionId: 'popup-1', reason: 'switch'});
    comments.attach({sessionId: 'popup-2', issueSnapshot: {issueKey: 'XYZ-2', core: {key: 'XYZ-2'}, sections: {}}});
    await comments.dispatch({type: 'composeChanged', value: 'New issue'});
    write.resolve({id: '103', body: 'Old issue'});
    const outcome = await pending;
    return {outcome, refreshes, view: comments.view()};
  });

  expect(result.outcome).toMatchObject({kind: 'ignored', sessionId: 'popup-1', issueKey: 'ABC-1'});
  expect(result.refreshes).toEqual([]);
  expect(result.view).toMatchObject({
    sessionId: 'popup-2',
    issueKey: 'XYZ-2',
    compose: {value: 'New issue', saving: false},
  });
});

test('comment edit owns mention-safe draft, write, refresh, and lane completion', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createCommentLifecycle, createMockJiraAdapter} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'write', method: 'PUT', result: {id: '11'}},
    ]});
    const issueData = {
      async refreshAfterMutation(request) {
        return {kind: 'loaded', snapshot: {issueKey: request.issueKey, core: {key: request.issueKey}, sections: {}}};
      },
    };
    const comments = createCommentLifecycle({jira, issueData, instanceUrl: 'https://jira.example/'});
    comments.attach({
      sessionId: 'popup-1',
      issueSnapshot: {
        issueKey: 'ABC-1',
        core: {key: 'ABC-1', fields: {
          assignee: {accountId: 'ada-1', displayName: 'Ada Lovelace'},
          comment: {comments: [{id: '11', body: 'Hello [~accountid:ada-1]'}]},
        }},
        sections: {},
      },
    });
    const begun = await comments.dispatch({type: 'startEdit', commentId: '11'});
    await comments.dispatch({
      type: 'editChanged',
      commentId: '11',
      value: 'Hello @Ada Lovelace, reviewed',
      selection: {start: 28, end: 28},
    });
    const saved = await comments.dispatch({type: 'saveEdit', commentId: '11', requirements: {history: true}});
    const write = jira.getRequests().find(request => request.operation === 'write');
    return {begun, saved, finalView: comments.view(), write};
  });

  expect(result.begun).toMatchObject({
    kind: 'changed',
    view: {rowAction: {mode: 'edit', commentId: '11', draft: 'Hello @Ada Lovelace', saving: false, canSave: true}},
  });
  expect(result.saved).toMatchObject({kind: 'mutationCommitted', mutation: {kind: 'commentChanged'}, notice: 'Comment updated'});
  expect(result.finalView.rowAction).toBeNull();
  expect(result.write).toMatchObject({
    method: 'PUT',
    path: 'https://jira.example/rest/api/2/issue/ABC-1/comment/11',
    body: {body: 'Hello [~accountid:ada-1], reviewed'},
  });
});

test('failed comment edit preserves its lane while compose remains independent', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createCommentLifecycle, createMockJiraAdapter} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'write', method: 'PUT', error: 'Edit unavailable'},
    ]});
    const issueData = {refreshAfterMutation() { throw new Error('must not refresh'); }};
    const comments = createCommentLifecycle({jira, issueData, instanceUrl: 'https://jira.example/'});
    comments.attach({
      sessionId: 'popup-1',
      issueSnapshot: {issueKey: 'ABC-1', core: {key: 'ABC-1', fields: {comment: {comments: [{id: '11', body: 'Before'}]}}}, sections: {}},
    });
    await comments.dispatch({type: 'composeChanged', value: 'Independent compose'});
    await comments.dispatch({type: 'startEdit', commentId: '11'});
    await comments.dispatch({type: 'editChanged', commentId: '11', value: 'After'});
    const failed = await comments.dispatch({type: 'saveEdit', commentId: '11'});
    return {failed, view: comments.view()};
  });

  expect(result.failed).toMatchObject({kind: 'failed', failure: {message: 'Edit unavailable'}});
  expect(result.view).toMatchObject({
    compose: {value: 'Independent compose'},
    rowAction: {mode: 'edit', commentId: '11', draft: 'After', saving: false, errorMessage: 'Edit unavailable'},
    protectFromAutoHide: true,
  });
});

test('comment delete confirmation owns success and recoverable failure', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createCommentLifecycle, createMockJiraAdapter} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'write', method: 'DELETE', error: 'Delete unavailable'},
      {operation: 'write', method: 'DELETE', result: {}},
    ]});
    const issueData = {
      async refreshAfterMutation(request) {
        return {kind: 'loaded', snapshot: {issueKey: request.issueKey, core: {key: request.issueKey}, sections: {}}};
      },
    };
    const comments = createCommentLifecycle({jira, issueData, instanceUrl: 'https://jira.example/'});
    comments.attach({
      sessionId: 'popup-1',
      issueSnapshot: {issueKey: 'ABC-1', core: {key: 'ABC-1', fields: {comment: {comments: [{id: '11', body: 'Remove me'}]}}}, sections: {}},
    });
    const confirming = await comments.dispatch({type: 'startDelete', commentId: '11'});
    const failed = await comments.dispatch({type: 'confirmDelete', commentId: '11'});
    const failedView = comments.view();
    const retried = await comments.dispatch({type: 'confirmDelete', commentId: '11'});
    return {confirming, failed, failedView, retried, finalView: comments.view(), requests: jira.getRequests()};
  });

  expect(result.confirming).toMatchObject({kind: 'changed', view: {rowAction: {mode: 'delete', commentId: '11'}}});
  expect(result.failed).toMatchObject({kind: 'failed', failure: {message: 'Delete unavailable'}});
  expect(result.failedView.rowAction).toMatchObject({mode: 'delete', commentId: '11', saving: false, errorMessage: 'Delete unavailable'});
  expect(result.retried).toMatchObject({kind: 'mutationCommitted', notice: 'Comment deleted'});
  expect(result.finalView.rowAction).toBeNull();
  expect(result.requests.map(request => ({method: request.method, path: request.path}))).toEqual([
    {method: 'DELETE', path: 'https://jira.example/rest/api/2/issue/ABC-1/comment/11'},
    {method: 'DELETE', path: 'https://jira.example/rest/api/2/issue/ABC-1/comment/11'},
  ]);
});
