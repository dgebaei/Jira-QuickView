const path = require('path');
const {test, expect} = require('@playwright/test');

const harnessPath = path.resolve(__dirname, '../../output/playwright/deep-modules/harness.js');

async function loadHarness(page) {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({path: harnessPath});
}

test.beforeEach(async ({page}) => {
  await loadHarness(page);
});

test('identical pending issue reads coalesce behind openIssue', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createDeferred, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const deferred = createDeferred();
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'summary', name: 'Summary'}]},
      {
        operation: 'read',
        match: request => request.path.includes('/issue/ABC-1?fields='),
        deferred,
      },
    ]});
    const issueData = createQuickViewIssueData({
      jira,
      instanceUrl: 'https://jira.example/',
      customFields: [],
    });

    const first = issueData.openIssue({issueKey: 'ABC-1'});
    const second = issueData.openIssue({issueKey: 'ABC-1'});
    for (let attempt = 0; attempt < 20 && !jira.getRequests().some(request => request.path.includes('/issue/ABC-1?fields=')); attempt += 1) {
      await Promise.resolve();
    }
    const requestCountWhilePending = jira.getRequests().filter(request => request.path.includes('/issue/ABC-1?fields=')).length;
    deferred.resolve({id: '10001', key: 'ABC-1', fields: {summary: 'First'}});
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    return {
      requestCountWhilePending,
      totalRequests: jira.getRequests().filter(request => request.path.includes('/issue/ABC-1?fields=')).length,
      first: {kind: firstOutcome.kind, key: firstOutcome.snapshot.core.key},
      second: {kind: secondOutcome.kind, key: secondOutcome.snapshot.core.key},
    };
  });

  expect(result).toEqual({
    requestCountWhilePending: 1,
    totalRequests: 1,
    first: {kind: 'loaded', key: 'ABC-1'},
    second: {kind: 'loaded', key: 'ABC-1'},
  });
});

test('TTL expiration is deterministic at the exact freshness edge', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    let now = 1000;
    const jira = createMockJiraAdapter({
      clock: () => now,
      scripts: [
        {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'summary', name: 'Summary'}]},
        {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'v1'}}},
        {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'summary', name: 'Summary'}]},
        {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'v2'}}},
      ],
    });
    const issueData = createQuickViewIssueData({
      jira,
      instanceUrl: 'https://jira.example/',
      clock: () => now,
      freshnessPolicy: {coreMs: 60000, summaryMs: 60000, historyMs: 60000},
      customFields: [],
    });

    const first = await issueData.openIssue({issueKey: 'ABC-1'});
    now = 60999;
    const beforeEdge = await issueData.openIssue({issueKey: 'ABC-1'});
    now = 61000;
    const atEdge = await issueData.openIssue({issueKey: 'ABC-1'});
    return {
      summaries: [first, beforeEdge, atEdge].map(outcome => outcome.snapshot.core.fields.summary),
      requestCount: jira.getRequests().filter(request => request.path.includes('/issue/ABC-1?fields=')).length,
    };
  });

  expect(result).toEqual({summaries: ['v1', 'v1', 'v2'], requestCount: 2});
});

test('a rejected core read does not poison retry', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'summary', name: 'Summary'}]},
      {operation: 'read', error: 'Temporary outage'},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'Recovered'}}},
    ]});
    const issueData = createQuickViewIssueData({
      jira,
      instanceUrl: 'https://jira.example/',
      customFields: [],
    });

    const failed = await issueData.openIssue({issueKey: 'ABC-1'});
    const retried = await issueData.openIssue({issueKey: 'ABC-1'});
    return {
      failed: {kind: failed.kind, message: failed.failures.core.message},
      retried: {kind: retried.kind, summary: retried.snapshot.core.fields.summary},
      requestCount: jira.getRequests().filter(request => request.path.includes('/issue/ABC-1?fields=')).length,
    };
  });

  expect(result).toEqual({
    failed: {kind: 'failed', message: 'Temporary outage'},
    retried: {kind: 'loaded', summary: 'Recovered'},
    requestCount: 2,
  });
});

test('an aborted core read leaves a later retry usable', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createDeferred, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const deferred = createDeferred();
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'summary', name: 'Summary'}]},
      {operation: 'read', deferred},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'Retried'}}},
    ]});
    const issueData = createQuickViewIssueData({
      jira,
      instanceUrl: 'https://jira.example/',
      customFields: [],
    });

    const controller = new AbortController();
    const pending = issueData.openIssue({issueKey: 'ABC-1', signal: controller.signal});
    for (let attempt = 0; attempt < 20 && !jira.getRequests().some(request => request.path.includes('/issue/ABC-1?fields=')); attempt += 1) {
      await Promise.resolve();
    }
    controller.abort();
    const aborted = await pending;
    deferred.resolve({id: '1', key: 'ABC-1', fields: {summary: 'Too late'}});
    const retried = await issueData.openIssue({issueKey: 'ABC-1'});

    return {
      abortedKind: aborted.kind,
      retriedKind: retried.kind,
      retriedSummary: retried.snapshot.core.fields.summary,
      requests: jira.getRequests()
        .filter(request => request.path.includes('/issue/ABC-1?fields='))
        .map(request => ({aborted: request.aborted, operation: request.operation})),
    };
  });

  expect(result).toEqual({
    abortedKind: 'aborted',
    retriedKind: 'loaded',
    retriedSummary: 'Retried',
    requests: [
      {aborted: true, operation: 'read'},
      {aborted: false, operation: 'read'},
    ],
  });
});

test('history fails independently and succeeds on retry', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'summary', name: 'Summary'}]},
      {operation: 'read', match: request => request.path.includes('?fields='), result: {id: '1', key: 'ABC-1', fields: {summary: 'Core'}}},
      {operation: 'read', match: request => request.path.includes('expand=changelog'), error: 'History unavailable'},
      {operation: 'read', match: request => request.path.includes('expand=changelog'), result: {changelog: {histories: [{id: 'h1'}]}}},
    ]});
    const issueData = createQuickViewIssueData({
      jira,
      instanceUrl: 'https://jira.example/',
      customFields: [],
    });

    const partial = await issueData.openIssue({issueKey: 'ABC-1', requirements: {history: true}});
    const retried = await issueData.openIssue({issueKey: 'ABC-1', requirements: {history: true}});
    return {
      partial: {
        kind: partial.kind,
        status: partial.snapshot.sections.history.status,
        message: partial.snapshot.sections.history.failure.message,
      },
      retried: {
        kind: retried.kind,
        status: retried.snapshot.sections.history.status,
        count: retried.snapshot.sections.history.data.histories.length,
      },
      paths: jira.getRequests().map(request => request.path),
    };
  });

  expect(result.partial).toEqual({kind: 'partial', status: 'failed', message: 'History unavailable'});
  expect(result.retried).toEqual({kind: 'loaded', status: 'ready', count: 1});
  expect(result.paths.filter(pathname => !pathname.endsWith('/rest/api/2/field'))).toHaveLength(3);
});

test('an invalidated older read cannot repopulate the cache', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createDeferred, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const oldRead = createDeferred();
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'summary', name: 'Summary'}]},
      {operation: 'read', deferred: oldRead},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'new'}}},
    ]});
    const issueData = createQuickViewIssueData({
      jira,
      instanceUrl: 'https://jira.example/',
      customFields: [],
    });

    const pendingOld = issueData.openIssue({issueKey: 'ABC-1'});
    await Promise.resolve();
    const refreshed = await issueData.refreshAfterMutation({
      issueKey: 'ABC-1',
      mutation: {kind: 'fieldChanged', fieldId: 'summary'},
    });
    oldRead.resolve({id: '1', key: 'ABC-1', fields: {summary: 'old'}});
    const oldOutcome = await pendingOld;
    const cached = await issueData.openIssue({issueKey: 'ABC-1'});
    return {
      oldSummary: oldOutcome.snapshot.core.fields.summary,
      refreshedSummary: refreshed.snapshot.core.fields.summary,
      cachedSummary: cached.snapshot.core.fields.summary,
      requestCount: jira.getRequests().filter(request => request.path.includes('/issue/ABC-1?fields=')).length,
    };
  });

  expect(result).toEqual({
    oldSummary: 'old',
    refreshedSummary: 'new',
    cachedSummary: 'new',
    requestCount: 2,
  });
});

test('callers receive isolated core values instead of mutable cache entries', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'summary', name: 'Summary'}]},
      {
        operation: 'read',
        result: {id: '1', key: 'ABC-1', fields: {summary: 'Original', labels: ['one']}},
      },
    ]});
    const issueData = createQuickViewIssueData({
      jira,
      instanceUrl: 'https://jira.example/',
      customFields: [],
    });

    const first = await issueData.openIssue({issueKey: 'ABC-1'});
    first.snapshot.core.fields.summary = 'Caller mutation';
    first.snapshot.core.fields.labels.push('two');
    const second = await issueData.openIssue({issueKey: 'ABC-1'});
    return {
      summary: second.snapshot.core.fields.summary,
      labels: second.snapshot.core.fields.labels,
      requestCount: jira.getRequests().filter(request => request.path.includes('/issue/ABC-1?fields=')).length,
    };
  });

  expect(result).toEqual({summary: 'Original', labels: ['one'], requestCount: 1});
});

test('mutation invalidation preserves an unaffected summary projection', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'summary', name: 'Summary'}]},
      {operation: 'read', match: request => request.path.endsWith('?fields=summary'), result: {fields: {summary: 'Cached summary'}}},
      {operation: 'read', match: request => request.path.includes('?fields=description'), result: {id: '1', key: 'ABC-1', fields: {summary: 'Core after comment'}}},
      {operation: 'read', match: request => request.path.includes('?fields=description'), result: {id: '1', key: 'ABC-1', fields: {summary: 'Core after priority'}}},
      {operation: 'read', match: request => request.path.includes('?fields=description'), result: {id: '1', key: 'ABC-1', fields: {summary: 'Core after summary'}}},
      {operation: 'read', match: request => request.path.endsWith('?fields=summary'), result: {fields: {summary: 'Refreshed summary'}}},
    ]});
    const issueData = createQuickViewIssueData({
      jira,
      instanceUrl: 'https://jira.example/',
      customFields: [],
    });

    await issueData.openIssue({issueKey: 'ABC-1', requirements: {core: 'summary'}});
    await issueData.refreshAfterMutation({issueKey: 'ABC-1', mutation: {kind: 'commentChanged'}});
    const afterComment = await issueData.openIssue({issueKey: 'ABC-1', requirements: {core: 'summary'}});
    await issueData.refreshAfterMutation({issueKey: 'ABC-1', mutation: {kind: 'fieldChanged', fieldId: 'priority'}});
    const afterPriority = await issueData.openIssue({issueKey: 'ABC-1', requirements: {core: 'summary'}});
    await issueData.refreshAfterMutation({issueKey: 'ABC-1', mutation: {kind: 'fieldChanged', fieldId: 'summary'}});
    const afterSummary = await issueData.openIssue({issueKey: 'ABC-1', requirements: {core: 'summary'}});

    return {
      summaries: [afterComment, afterPriority, afterSummary].map(outcome => outcome.snapshot?.core?.summary || ''),
      requestCount: jira.getRequests().filter(request => !request.path.endsWith('/rest/api/2/field')).length,
      pendingScripts: jira.getPendingScriptCount(),
    };
  });

  expect(result).toEqual({
    summaries: ['Cached summary', 'Cached summary', 'Refreshed summary'],
    requestCount: 5,
    pendingScripts: 0,
  });
});

test('field catalog failure is retryable and does not poison field context', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), error: 'Catalog unavailable'},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {labels: {name: 'Labels', operations: ['set']}}}},
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'labels', name: 'Labels', schema: {type: 'array'}}]},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});

    const failed = await issueData.loadFieldContext({issueKey: 'ABC-1', fieldId: 'labels'});
    const retried = await issueData.loadFieldContext({issueKey: 'ABC-1', fieldId: 'labels'});
    return {
      failed: {kind: failed.kind, catalog: failed.failures.catalog.message},
      retried: {
        kind: retried.kind,
        fieldId: retried.context.fieldId,
        name: retried.context.field.name,
        editable: retried.context.editable,
      },
      paths: jira.getRequests().map(request => request.path),
    };
  });

  expect(result.failed).toEqual({kind: 'partial', catalog: 'Catalog unavailable'});
  expect(result.retried).toEqual({kind: 'loaded', fieldId: 'labels', name: 'Labels', editable: true});
  expect(result.paths.filter(pathname => pathname.endsWith('/rest/api/2/field'))).toHaveLength(2);
  expect(result.paths.filter(pathname => pathname.endsWith('/editmeta'))).toHaveLength(1);
});

test('identical field context and transition reads coalesce', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createDeferred, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const catalog = createDeferred();
    const editMeta = createDeferred();
    const transitions = createDeferred();
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), deferred: catalog},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), deferred: editMeta},
      {operation: 'read', match: request => request.path.endsWith('/transitions'), deferred: transitions},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});

    const first = issueData.loadFieldContext({issueKey: 'ABC-1', fieldId: 'status', includeTransitions: true});
    const second = issueData.loadFieldContext({issueKey: 'ABC-1', fieldId: 'status', includeTransitions: true});
    for (let attempt = 0; attempt < 10 && jira.getRequests().length < 3; attempt += 1) {
      await Promise.resolve();
    }
    const pendingCount = jira.getRequests().length;
    catalog.resolve([{id: 'status', name: 'Status', schema: {type: 'status'}}]);
    editMeta.resolve({fields: {status: {name: 'Status', operations: ['set']}}});
    transitions.resolve({transitions: [{id: '31', name: 'Start Progress', to: {name: 'In Progress'}}]});
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    return {
      pendingCount,
      totalCount: jira.getRequests().length,
      firstTransition: firstOutcome.context.transitions[0],
      secondTransition: secondOutcome.context.transitions[0],
    };
  });

  expect(result).toEqual({
    pendingCount: 3,
    totalCount: 3,
    firstTransition: {id: '31', name: 'Start Progress', to: {name: 'In Progress'}},
    secondTransition: {id: '31', name: 'Start Progress', to: {name: 'In Progress'}},
  });
});

test('Sprint option failures are retryable and do not cache an incomplete board result', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const sprintField = {id: 'customfield_10020', name: 'Sprint', schema: {custom: 'com.pyxis.greenhopper.jira:gh-sprint'}};
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [sprintField]},
      {operation: 'read', match: request => request.path.endsWith('/editmeta'), result: {fields: {customfield_10020: sprintField}}},
      {operation: 'read', match: request => request.path.includes('/issue/ABC-1?fields='), result: {
        id: '1',
        key: 'ABC-1',
        fields: {project: {id: '10', key: 'ABC'}},
      }},
      {operation: 'read', match: request => request.path.includes('/rest/agile/1.0/board?'), error: 'Boards unavailable'},
      {operation: 'read', match: request => request.path.includes('/rest/agile/1.0/board?'), result: {values: [{id: 7, name: 'Delivery'}]}},
      {operation: 'read', match: request => request.path.includes('/rest/agile/1.0/board/7/sprint?'), result: {
        values: [{id: 42, name: 'Sprint 42', state: 'future'}],
      }},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});

    const failed = await issueData.loadFieldContext({issueKey: 'ABC-1', fieldId: 'sprint', includeOptions: true});
    const retried = await issueData.loadFieldContext({issueKey: 'ABC-1', fieldId: 'sprint', includeOptions: true});
    return {
      failed: {kind: failed.kind, message: failed.failures.options.message},
      retried: {kind: retried.kind, options: retried.context.options},
      boardRequests: jira.getRequests().filter(request => request.path.includes('/rest/agile/1.0/board?')).length,
    };
  });

  expect(result.failed).toEqual({kind: 'partial', message: 'Boards unavailable'});
  expect(result.retried).toEqual({
    kind: 'loaded',
    options: [{id: 42, name: 'Sprint 42', state: 'future', boardRefs: [{id: '7', name: 'Delivery', projectKey: 'ABC'}]}],
  });
  expect(result.boardRequests).toBe(2);
});

test('assignee search preserves fallback ordering and reports the strategy used', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.includes('/rest/internal/2/users/assignee'), error: 'Unsupported'},
      {operation: 'read', match: request => request.path.includes('/user/assignable/search?issueKey='), result: [{accountId: 'u1', displayName: 'Ada Agent'}]},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const outcome = await issueData.search({purpose: 'assignee', issueKey: 'ABC-1', query: 'ada'});
    return {
      kind: outcome.kind,
      strategyUsed: outcome.strategyUsed,
      items: outcome.items,
      paths: jira.getRequests().map(request => request.path),
    };
  });

  expect(result.kind).toBe('loaded');
  expect(result.strategyUsed).toBe('issue-query');
  expect(result.items).toEqual([expect.objectContaining({accountId: 'u1', displayName: 'Ada Agent'})]);
  expect(result.paths[0]).toContain('/rest/internal/2/users/assignee');
  expect(result.paths[1]).toContain('/user/assignable/search?issueKey=');
});

test('failed label search is evicted and succeeds on retry', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', error: 'Labels unavailable'},
      {operation: 'read', result: {suggestions: [{label: 'release-candidate', html: 'release-candidate'}]}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const failed = await issueData.search({purpose: 'label', query: 'release'});
    const retried = await issueData.search({purpose: 'label', query: 'release'});
    return {
      failed: {kind: failed.kind, message: failed.failure.message},
      retried: {kind: retried.kind, items: retried.items},
      requestCount: jira.getRequests().length,
    };
  });

  expect(result).toEqual({
    failed: {kind: 'failed', message: 'Labels unavailable'},
    retried: {kind: 'loaded', items: [{label: 'release-candidate', value: 'release-candidate', metaText: ''}]},
    requestCount: 2,
  });
});

test('parent search preserves Jira search fallback and local-project ranking', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const localIssue = {key: 'ABC-9', fields: {summary: 'Local epic', project: {key: 'ABC'}, issuetype: {id: 'epic'}}};
    const remoteIssue = {key: 'XYZ-2', fields: {summary: 'Remote epic', project: {key: 'XYZ'}, issuetype: {id: 'epic'}}};
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'summary', name: 'Summary'}]},
      {operation: 'read', match: request => request.path.includes('/issue/ABC-1?fields='), result: {key: 'ABC-1', fields: {issuetype: {id: 'story'}, project: {id: '10', key: 'ABC'}}}},
      {operation: 'read', match: request => request.path.endsWith('/rest/api/3/issuetype'), result: [
        {id: 'story', hierarchyLevel: 0},
        {id: 'epic', hierarchyLevel: 1},
      ]},
      {operation: 'read', match: request => request.path.includes('/rest/api/latest/search?') && new URL(request.path).searchParams.get('jql').includes('project = "ABC"'), error: 'latest unavailable'},
      {operation: 'read', match: request => request.path.includes('/rest/api/3/search/jql?') && new URL(request.path).searchParams.get('jql').includes('project = "ABC"'), result: {issues: [localIssue]}},
      {operation: 'read', match: request => request.path.includes('/rest/api/latest/search?') && new URL(request.path).searchParams.get('jql').includes('project != "ABC"'), result: {issues: [remoteIssue]}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const outcome = await issueData.search({purpose: 'parent', issueKey: 'ABC-1', fieldId: 'parent', query: 'epic'});
    return {
      kind: outcome.kind,
      keys: outcome.items.map(issue => issue.key),
      paths: jira.getRequests().map(request => request.path),
    };
  });

  expect(result.kind).toBe('loaded');
  expect(result.keys).toEqual(['ABC-9', 'XYZ-2']);
  expect(result.paths.some(pathname => pathname.includes('/rest/api/3/search/jql?'))).toBe(true);
});

test('parent search falls through latest and v3 to v2 in order for each project plan', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const projectMatch = (request, operator) => new URL(request.path).searchParams.get('jql').includes(`project ${operator} "ABC"`);
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'summary', name: 'Summary'}]},
      {operation: 'read', match: request => request.path.includes('/issue/ABC-1?fields='), result: {
        key: 'ABC-1', fields: {issuetype: {id: 'story'}, project: {id: '10', key: 'ABC'}},
      }},
      {operation: 'read', match: request => request.path.endsWith('/rest/api/3/issuetype'), result: [
        {id: 'story', hierarchyLevel: 0}, {id: 'epic', hierarchyLevel: 1},
      ]},
      ...['=', '!='].flatMap(operator => [
        {operation: 'read', match: request => request.path.includes('/rest/api/latest/search?') && projectMatch(request, operator), error: 'latest unavailable'},
        {operation: 'read', match: request => request.path.includes('/rest/api/3/search/jql?') && projectMatch(request, operator), error: 'v3 unavailable'},
        {operation: 'read', match: request => request.path.includes('/rest/api/2/search?') && projectMatch(request, operator), result: {
          issues: operator === '=' ? [{key: 'ABC-9', fields: {summary: 'Local epic', project: {key: 'ABC'}, issuetype: {id: 'epic'}}}] : [],
        }},
      ]),
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const outcome = await issueData.search({purpose: 'parent', issueKey: 'ABC-1', fieldId: 'parent', query: 'epic'});
    const searches = jira.getRequests().filter(request => request.path.includes('/search?') || request.path.includes('/search/jql?'));
    const versionsFor = operator => searches
      .filter(request => projectMatch(request, operator))
      .map(request => new URL(request.path).pathname.match(/\/rest\/api\/(latest|3|2)\//)?.[1]);
    return {kind: outcome.kind, keys: outcome.items.map(item => item.key), local: versionsFor('='), remote: versionsFor('!=')};
  });

  expect(result).toEqual({kind: 'loaded', keys: ['ABC-9'], local: ['latest', '3', '2'], remote: ['latest', '3', '2']});
});

test('linked-issue search falls back from both picker adapters through the issue-data seam', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'summary', name: 'Summary'}]},
      {operation: 'read', match: request => request.path.includes('/issue/APP-1?fields='), result: {
        id: '1', key: 'APP-1', fields: {project: {id: '10', key: 'APP'}},
      }},
      {operation: 'read', match: request => request.path.includes('/rest/api/2/issue/picker?'), error: 'v2 picker unavailable'},
      {operation: 'read', match: request => request.path.includes('/rest/api/3/issue/picker?'), error: 'v3 picker unavailable'},
      {operation: 'read', match: request => request.path.includes('/rest/api/latest/search?') && new URL(request.path).searchParams.get('jql').includes('project = "APP"'), result: {
        issues: [{id: '2', key: 'APP-2', fields: {summary: 'Retry failed requests', project: {key: 'APP'}}}],
      }},
      {operation: 'read', match: request => request.path.includes('/rest/api/latest/search?') && new URL(request.path).searchParams.get('jql').includes('project != "APP"'), result: {issues: []}},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const outcome = await issueData.search({purpose: 'linkedIssue', issueKey: 'APP-1', query: 'retry'});
    const paths = jira.getRequests().map(request => request.path);
    return {
      kind: outcome.kind,
      items: outcome.items.map(item => ({key: item.key, summary: item.fields.summary})),
      pickerRequests: paths.filter(pathname => pathname.includes('/issue/picker?')).length,
      usedSearch: paths.some(pathname => pathname.includes('/search?')),
    };
  });

  expect(result).toEqual({
    kind: 'loaded',
    items: [{key: 'APP-2', summary: 'Retry failed requests'}],
    pickerRequests: 2,
    usedSearch: true,
  });
});

test('openIssue returns independent children, pull-request, and reaction sections', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'summary', name: 'Summary'}]},
      {operation: 'read', match: request => request.path.includes('/issue/ABC-1?fields='), result: {
        id: '10001',
        key: 'ABC-1',
        fields: {comment: {comments: [{id: '11'}]}},
      }},
      {operation: 'read', match: request => request.path.includes('/rest/api/latest/search?'), result: {issues: [{key: 'ABC-2', fields: {summary: 'Child'}}]}},
      {operation: 'read', match: request => request.path.includes('/rest/dev-status/1.0/issue/detail?'), result: {detail: [{pullRequests: [{id: 'pr-1', name: 'Ready PR'}]}]}},
      {operation: 'write', method: 'POST', match: request => request.path.endsWith('/rest/internal/2/reactions/view'), result: [{commentId: 11, emojiId: 'thumbsup', count: 2, reacted: true}]},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const outcome = await issueData.openIssue({
      issueKey: 'ABC-1',
      requirements: {children: true, pullRequests: true, reactions: true},
    });
    return {
      kind: outcome.kind,
      childKeys: outcome.snapshot.sections.children.items.map(issue => issue.key),
      pullRequestIds: outcome.snapshot.sections.pullRequests.items.map(item => item.id),
      reaction: outcome.snapshot.sections.reactions.byCommentId['11'].thumbsup,
      operations: jira.getRequests()
        .filter(request => !request.path.endsWith('/rest/api/2/field'))
        .map(request => request.operation),
    };
  });

  expect(result).toEqual({
    kind: 'loaded',
    childKeys: ['ABC-2'],
    pullRequestIds: ['pr-1'],
    reaction: {count: 2, reacted: true, pending: false},
    operations: ['read', 'read', 'read', 'write'],
  });
});

test('optional failure is partial and mutation refresh retains prior section data', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'summary', name: 'Summary'}]},
      {operation: 'read', match: request => request.path.includes('/issue/ABC-1?fields='), result: {id: '10001', key: 'ABC-1', fields: {}}},
      {operation: 'read', match: request => request.path.includes('/rest/dev-status/1.0/issue/detail?'), result: {detail: [{pullRequests: [{id: 'pr-1'}]}]}},
      {operation: 'read', match: request => request.path.includes('/issue/ABC-1?fields='), result: {id: '10001', key: 'ABC-1', fields: {summary: 'Updated'}}},
      {operation: 'read', match: request => request.path.includes('/rest/dev-status/1.0/issue/detail?'), error: 'Dev status unavailable'},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const initial = await issueData.openIssue({issueKey: 'ABC-1', requirements: {pullRequests: true}});
    const refreshed = await issueData.refreshAfterMutation({
      issueKey: 'ABC-1',
      priorSnapshot: initial.snapshot,
      mutation: {kind: 'issueChanged'},
      requirements: {pullRequests: true},
    });
    return {
      kind: refreshed.kind,
      status: refreshed.snapshot.sections.pullRequests.status,
      ids: refreshed.snapshot.sections.pullRequests.items.map(item => item.id),
      failure: refreshed.snapshot.sections.pullRequests.failure.message,
    };
  });

  expect(result).toEqual({
    kind: 'partial',
    status: 'staleRetained',
    ids: ['pr-1'],
    failure: 'Dev status unavailable',
  });
});

test('reaction refresh invalidates only reactions and reuses core and history facts', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'summary', name: 'Summary'}]},
      {operation: 'read', match: request => request.path.includes('/issue/ABC-1?fields='), result: {
        id: '10001', key: 'ABC-1', fields: {summary: 'Stable', comment: {comments: [{id: '11'}, {id: '12'}]}},
      }},
      {operation: 'read', match: request => request.path.includes('expand=changelog'), result: {changelog: {histories: [{id: 'h1'}]}}},
      {operation: 'write', match: request => request.path.endsWith('/rest/internal/2/reactions/view'), result: [
        {commentId: 11, emojiId: 'thumbsup', count: 1, reacted: false},
      ]},
      {operation: 'write', match: request => request.path.endsWith('/rest/internal/2/reactions/view'), result: [
        {commentId: 11, emojiId: 'thumbsup', count: 2, reacted: true},
      ]},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const requirements = {history: true, reactions: true};
    const initial = await issueData.openIssue({issueKey: 'ABC-1', requirements});
    const requestCountBefore = jira.getRequests().length;
    const refreshed = await issueData.refreshAfterMutation({
      issueKey: 'ABC-1',
      priorSnapshot: initial.snapshot,
      mutation: {kind: 'reactionChanged', commentIds: ['11']},
      requirements,
    });
    return {
      reaction: refreshed.snapshot.sections.reactions.byCommentId['11'].thumbsup,
      newRequests: jira.getRequests().slice(requestCountBefore).map(request => ({operation: request.operation, path: request.path})),
    };
  });

  expect(result.reaction).toEqual({count: 2, reacted: true, pending: false});
  expect(result.newRequests).toEqual([{operation: 'write', path: 'https://jira.example/rest/internal/2/reactions/view'}]);
});

test('default Jira avatars are marked before image normalization so callers can prefer initials', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const defaultAvatarUrl = 'https://jira.example/secure/useravatar?avatarId=10122';
    const customAvatarUrl = 'https://jira.example/secure/useravatar?ownerId=custom-user&avatarId=20001';
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: []},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {
        summary: 'Issue',
        reporter: {accountId: 'default-user', displayName: 'Default User', avatarUrls: {'48x48': defaultAvatarUrl}},
        assignee: {accountId: 'custom-user', displayName: 'Custom User', avatarUrls: {'48x48': customAvatarUrl}},
      }}},
      {operation: 'image', path: defaultAvatarUrl, result: 'data:image/png;base64,ZGVmYXVsdA=='},
      {operation: 'image', path: customAvatarUrl, result: 'data:image/png;base64,Y3VzdG9t'},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const opened = await issueData.openIssue({issueKey: 'ABC-1'});
    const reporter = opened.snapshot.core.fields.reporter;
    const assignee = opened.snapshot.core.fields.assignee;
    return {
      reporter: {avatarUrl: reporter.avatarUrls['48x48'], isDefaultAvatar: reporter.isDefaultAvatar},
      assignee: {avatarUrl: assignee.avatarUrls['48x48'], isDefaultAvatar: assignee.isDefaultAvatar},
    };
  });

  expect(result).toEqual({
    reporter: {avatarUrl: '', isDefaultAvatar: true},
    assignee: {avatarUrl: 'data:image/png;base64,Y3VzdG9t', isDefaultAvatar: false},
  });
});

test('failed Jira image normalization falls back safely and retries without refetching core', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const avatarUrl = 'https://jira.example/secure/useravatar?ownerId=ada&avatarId=1';
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', match: request => request.path.endsWith('/rest/api/2/field'), result: [{id: 'summary', name: 'Summary'}]},
      {operation: 'read', match: request => request.path.includes('/issue/ABC-1?fields='), result: {
        id: '1', key: 'ABC-1', fields: {reporter: {accountId: 'u1', displayName: 'Ada', avatarUrls: {'48x48': avatarUrl}}},
      }},
      {operation: 'image', path: avatarUrl, error: 'Image unavailable'},
      {operation: 'image', path: avatarUrl, result: 'data:image/png;base64,b2s='},
    ]});
    const issueData = createQuickViewIssueData({jira, instanceUrl: 'https://jira.example/'});
    const first = await issueData.openIssue({issueKey: 'ABC-1'});
    const second = await issueData.openIssue({issueKey: 'ABC-1'});
    return {
      avatars: [first, second].map(outcome => outcome.snapshot.core.fields.reporter.avatarUrls['48x48']),
      coreReads: jira.getRequests().filter(request => request.operation === 'read' && request.path.includes('/issue/ABC-1?fields=')).length,
      imageReads: jira.getRequests().filter(request => request.operation === 'image').length,
    };
  });

  expect(result).toEqual({
    avatars: ['https://jira.example/secure/useravatar?ownerId=ada&avatarId=1', 'data:image/png;base64,b2s='],
    coreReads: 1,
    imageReads: 2,
  });
});
