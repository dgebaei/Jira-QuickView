const path = require('path');
const {test, expect} = require('@playwright/test');

const harnessPath = path.resolve(__dirname, '../../output/playwright/deep-modules/harness.js');

test.beforeEach(async ({page}) => {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({path: harnessPath});
});

test('linked issue lifecycle owns open, ranked search, and selected input', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createLinkedIssueLifecycle} = window.JiraQuickViewDeepModules;
    const snapshot = {
      issueKey: 'ABC-1',
      core: {key: 'ABC-1', fields: {issuelinks: []}},
      sections: {linkedIssues: {
        status: 'empty', detailsByKey: {}, items: [],
        linkTypes: [{id: '100', name: 'Blocks', outward: 'blocks', inward: 'is blocked by'}],
      }},
    };
    const lifecycle = createLinkedIssueLifecycle({
      instanceUrl: 'https://jira.example/',
      issueData: {
        async openIssue() { return {snapshot}; },
        async refreshAfterMutation() { return {snapshot}; },
        async search() { return {kind: 'loaded', items: [
          {key: 'XYZ-2', fields: {summary: 'Cross project'}},
          {key: 'ABC-3', fields: {summary: 'Same project'}},
        ]}; },
      },
      jira: {async write() {}},
    });
    lifecycle.attach({sessionId: 'popup-1', issueSnapshot: snapshot});
    const opened = await lifecycle.dispatch({type: 'open'});
    const changed = await lifecycle.dispatch({type: 'inputChanged', value: 'project', selectionStart: 7, selectionEnd: 7});
    const searched = await lifecycle.dispatch({type: 'runSearch', requestId: changed.requestId});
    const selected = await lifecycle.dispatch({type: 'selectCandidate', issueKey: 'ABC-3'});
    return {
      opened: {kind: opened.kind, relationshipId: opened.view.relationshipId},
      searched: searched.view.searchResults.map(issue => issue.key),
      selected: selected.view.selectedIssues.map(issue => issue.key),
      searchValue: selected.view.searchValue,
    };
  });

  expect(result).toEqual({
    opened: {kind: 'opened', relationshipId: '100:outward'},
    searched: ['ABC-3', 'XYZ-2'],
    selected: ['ABC-3'],
    searchValue: '',
  });
});

test('partial linked issue writes retain failed selections and refresh successful links', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createLinkedIssueLifecycle} = window.JiraQuickViewDeepModules;
    const writes = [];
    const initial = {
      issueKey: 'ABC-1', core: {key: 'ABC-1', fields: {issuelinks: []}},
      sections: {linkedIssues: {status: 'empty', detailsByKey: {}, items: [], linkTypes: [
        {id: '100', name: 'Blocks', outward: 'blocks', inward: 'is blocked by'},
      ]}},
    };
    const refreshed = {
      issueKey: 'ABC-1', core: {key: 'ABC-1', fields: {issuelinks: [
        {id: '10', type: {name: 'Blocks', outward: 'blocks'}, outwardIssue: {key: 'ABC-2'}},
      ]}},
      sections: {linkedIssues: {status: 'ready', detailsByKey: {}, items: [{key: 'ABC-2'}], linkTypes: initial.sections.linkedIssues.linkTypes}},
    };
    const lifecycle = createLinkedIssueLifecycle({
      instanceUrl: 'https://jira.example/',
      issueData: {
        async openIssue() { return {snapshot: initial}; },
        async refreshAfterMutation() { return {snapshot: refreshed}; },
        async search() { return {kind: 'loaded', items: []}; },
      },
      jira: {async write(request) {
        writes.push(request);
        if (request.body?.inwardIssue?.key === 'XYZ-3') throw new Error('Link rejected');
      }},
    });
    lifecycle.attach({sessionId: 'popup-1', issueSnapshot: initial});
    await lifecycle.dispatch({type: 'open'});
    await lifecycle.dispatch({type: 'commitInput', value: 'ABC-2, XYZ-3', force: true});
    const outcome = await lifecycle.dispatch({type: 'addSelected'});
    return {outcome, writes, view: lifecycle.view()};
  });

  expect(result.outcome.kind).toBe('partial');
  expect(result.outcome.issueSnapshot.core.fields.issuelinks[0].outwardIssue.key).toBe('ABC-2');
  expect(result.view.selectedIssues.map(issue => issue.key)).toEqual(['XYZ-3']);
  expect(result.view.feedbackMessage).toBe('1 linked issue added.');
  expect(result.view.errorMessage).toContain('Could not link XYZ-3. Link rejected');
  expect(result.writes.map(write => write.body)).toEqual([
    {type: {name: 'Blocks'}, outwardIssue: {key: 'ABC-1'}, inwardIssue: {key: 'ABC-2'}},
    {type: {name: 'Blocks'}, outwardIssue: {key: 'ABC-1'}, inwardIssue: {key: 'XYZ-3'}},
  ]);
});

test('failed linked issue removal preserves a recoverable row state', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createLinkedIssueLifecycle} = window.JiraQuickViewDeepModules;
    const snapshot = {
      issueKey: 'ABC-1',
      core: {key: 'ABC-1', fields: {issuelinks: [{id: '10', outwardIssue: {key: 'ABC-2'}}]}},
      sections: {linkedIssues: {status: 'ready', detailsByKey: {}, items: [{key: 'ABC-2'}], linkTypes: []}},
    };
    const lifecycle = createLinkedIssueLifecycle({
      instanceUrl: 'https://jira.example/',
      issueData: {
        async openIssue() { return {snapshot}; },
        async refreshAfterMutation() { return {snapshot}; },
        async search() { return {kind: 'loaded', items: []}; },
      },
      jira: {async write() { throw new Error('Delete unavailable'); }},
    });
    lifecycle.attach({sessionId: 'popup-1', issueSnapshot: snapshot});
    await lifecycle.dispatch({type: 'open'});
    await lifecycle.dispatch({type: 'confirmRemoval', linkId: '10'});
    const failed = await lifecycle.dispatch({type: 'removeConfirmed', linkId: '10'});
    return {failed, view: lifecycle.view()};
  });

  expect(result.failed).toMatchObject({kind: 'failed', failure: {message: 'Delete unavailable'}});
  expect(result.view.pendingRemoveIds).toEqual([]);
  expect(result.view.errorMessage).toBe('Delete unavailable');
  expect(result.view.open).toBe(true);
});

test('issue switching rejects a stale linked issue search', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createDeferred, createLinkedIssueLifecycle} = window.JiraQuickViewDeepModules;
    const search = createDeferred();
    const snapshot = key => ({
      issueKey: key, core: {key, fields: {issuelinks: []}},
      sections: {linkedIssues: {status: 'empty', detailsByKey: {}, items: [], linkTypes: []}},
    });
    const lifecycle = createLinkedIssueLifecycle({
      instanceUrl: 'https://jira.example/',
      issueData: {
        async openIssue(request) { return {snapshot: snapshot(request.issueKey)}; },
        async refreshAfterMutation() { return {}; },
        search() { return search.promise; },
      },
      jira: {async write() {}},
    });
    lifecycle.attach({sessionId: 'popup-1', issueSnapshot: snapshot('ABC-1')});
    await lifecycle.dispatch({type: 'open'});
    const changed = await lifecycle.dispatch({type: 'inputChanged', value: 'ABC'});
    const pending = lifecycle.dispatch({type: 'runSearch', requestId: changed.requestId});
    lifecycle.detach({sessionId: 'popup-1'});
    lifecycle.attach({sessionId: 'popup-2', issueSnapshot: snapshot('XYZ-2')});
    search.resolve({kind: 'loaded', items: [{key: 'ABC-3'}]});
    const outcome = await pending;
    return {outcome, view: lifecycle.view()};
  });

  expect(result.outcome).toEqual({kind: 'ignored', reason: 'superseded'});
  expect(result.view).toMatchObject({issueKey: 'XYZ-2', sessionId: 'popup-2', searchResults: []});
});
