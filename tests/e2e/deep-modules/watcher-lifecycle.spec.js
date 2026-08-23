const path = require('path');
const {test, expect} = require('@playwright/test');

const harnessPath = path.resolve(__dirname, '../../output/playwright/deep-modules/harness.js');

test.beforeEach(async ({page}) => {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({path: harnessPath});
});

test('watcher lifecycle owns open, search, fallback write, refresh, and feedback', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createWatcherLifecycle} = window.JiraQuickViewDeepModules;
    const writes = [];
    const alex = {id: 'alex', accountId: 'alex', displayName: 'Alex'};
    const me = {accountId: 'me', name: 'morgan', displayName: 'Morgan'};
    const snapshot = watchers => ({
      issueKey: 'ABC-1',
      core: {key: 'ABC-1', fields: {}},
      sections: {watchers: {status: 'ready', data: {watchers}}},
    });
    const lifecycle = createWatcherLifecycle({
      instanceUrl: 'https://jira.example/',
      issueData: {
        async openIssue() { return {snapshot: snapshot([alex])}; },
        async search() { return {kind: 'loaded', items: [me]}; },
        async refreshAfterMutation() { return {snapshot: snapshot([alex, {...me, id: 'me'}])}; },
      },
      jira: {async write(request) {
        writes.push(request);
        if (writes.length === 1) throw new Error('Cloud identifier rejected');
      }},
      loadViewer: async () => me,
      normalizeUsers: users => users.map(user => ({
        ...user,
        id: user.accountId || user.name,
        rawValue: {accountId: user.accountId, name: user.name},
      })),
    });
    lifecycle.attach({sessionId: 'popup-1', issueSnapshot: snapshot([])});
    const opened = await lifecycle.dispatch({type: 'open'});
    const searched = await lifecycle.dispatch({type: 'search', query: 'mor'});
    const added = await lifecycle.dispatch({type: 'add', watcherId: 'me'});
    return {
      opened: {kind: opened.kind, watchers: opened.view.watchers.map(user => user.id)},
      searched: {kind: searched.kind, results: searched.view.searchResults.map(user => user.id)},
      added: {kind: added.kind, expires: added.feedbackExpiresIn, watchers: added.view.watchers.map(user => user.id)},
      feedback: lifecycle.view().addFeedback,
      writes,
    };
  });

  expect(result.opened).toEqual({kind: 'opened', watchers: ['alex']});
  expect(result.searched).toEqual({kind: 'searched', results: ['me']});
  expect(result.added).toEqual({kind: 'added', expires: 5000, watchers: ['alex', 'me']});
  expect(result.feedback).toMatchObject({id: 'me', message: 'Morgan added to watchers'});
  expect(result.writes).toEqual([
    {method: 'POST', path: 'https://jira.example/rest/api/2/issue/ABC-1/watchers', body: 'me'},
    {method: 'POST', path: 'https://jira.example/rest/api/2/issue/ABC-1/watchers', body: 'morgan'},
  ]);
});

test('failed watcher removal preserves the row and exposes recoverable feedback', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createWatcherLifecycle} = window.JiraQuickViewDeepModules;
    const alex = {id: 'alex', accountId: 'alex', displayName: 'Alex'};
    const snapshot = {
      issueKey: 'ABC-1', core: {key: 'ABC-1', fields: {}},
      sections: {watchers: {status: 'ready', data: {watchers: [alex]}}},
    };
    const lifecycle = createWatcherLifecycle({
      instanceUrl: 'https://jira.example/',
      issueData: {
        async openIssue() { return {snapshot}; },
        async search() { return {kind: 'loaded', items: []}; },
        async refreshAfterMutation() { return {snapshot}; },
      },
      jira: {async write() { throw new Error('Remove unavailable'); }},
      loadViewer: async () => null,
      normalizeUsers: users => users,
    });
    lifecycle.attach({sessionId: 'popup-1', issueSnapshot: snapshot});
    await lifecycle.dispatch({type: 'open'});
    const failed = await lifecycle.dispatch({type: 'remove', watcherId: 'alex'});
    return {failed, view: lifecycle.view()};
  });

  expect(result.failed).toMatchObject({kind: 'failed', failure: {message: 'Remove unavailable'}, feedbackExpiresIn: 5000});
  expect(result.view.watchers.map(user => user.id)).toEqual(['alex']);
  expect(result.view.pendingRemoveIds).toEqual([]);
  expect(result.view.removeFeedback).toMatchObject({id: 'alex', message: 'Remove unavailable'});
});

test('issue switching rejects stale watcher searches', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createDeferred, createWatcherLifecycle} = window.JiraQuickViewDeepModules;
    const search = createDeferred();
    const lifecycle = createWatcherLifecycle({
      instanceUrl: 'https://jira.example/',
      issueData: {
        async openIssue(request) { return {snapshot: request.issueKey === 'ABC-1'
          ? {issueKey: 'ABC-1', core: {key: 'ABC-1'}, sections: {watchers: {status: 'empty', data: {watchers: []}}}}
          : {issueKey: 'XYZ-2', core: {key: 'XYZ-2'}, sections: {watchers: {status: 'empty', data: {watchers: []}}}}}; },
        search() { return search.promise; },
        async refreshAfterMutation() { return {}; },
      },
      jira: {async write() {}},
      loadViewer: async () => null,
      normalizeUsers: users => users,
    });
    const first = {issueKey: 'ABC-1', core: {key: 'ABC-1'}, sections: {}};
    lifecycle.attach({sessionId: 'popup-1', issueSnapshot: first});
    await lifecycle.dispatch({type: 'open'});
    const pending = lifecycle.dispatch({type: 'search', query: 'alex'});
    lifecycle.detach({sessionId: 'popup-1'});
    lifecycle.attach({sessionId: 'popup-2', issueSnapshot: {issueKey: 'XYZ-2', core: {key: 'XYZ-2'}, sections: {}}});
    search.resolve({kind: 'loaded', items: [{id: 'alex'}]});
    const outcome = await pending;
    return {outcome, view: lifecycle.view()};
  });

  expect(result.outcome).toEqual({kind: 'ignored', reason: 'superseded'});
  expect(result.view).toMatchObject({issueKey: 'XYZ-2', sessionId: 'popup-2', searchResults: []});
});
