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
    const jira = createMockJiraAdapter({scripts: [{
      operation: 'read',
      match: request => request.path.includes('/issue/ABC-1?fields='),
      deferred,
    }]});
    const issueData = createQuickViewIssueData({
      jira,
      instanceUrl: 'https://jira.example/',
      customFields: [],
      getSprintFieldIds: async () => [],
      getEpicLinkFieldIds: async () => [],
    });

    const first = issueData.openIssue({issueKey: 'ABC-1'});
    const second = issueData.openIssue({issueKey: 'ABC-1'});
    for (let attempt = 0; attempt < 10 && jira.getRequests().length === 0; attempt += 1) {
      await Promise.resolve();
    }
    const requestCountWhilePending = jira.getRequests().length;
    deferred.resolve({id: '10001', key: 'ABC-1', fields: {summary: 'First'}});
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    return {
      requestCountWhilePending,
      totalRequests: jira.getRequests().length,
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
        {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'v1'}}},
        {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'v2'}}},
      ],
    });
    const issueData = createQuickViewIssueData({
      jira,
      instanceUrl: 'https://jira.example/',
      clock: () => now,
      freshnessPolicy: {coreMs: 60000, summaryMs: 60000, historyMs: 60000},
      customFields: [],
      getSprintFieldIds: async () => [],
      getEpicLinkFieldIds: async () => [],
    });

    const first = await issueData.openIssue({issueKey: 'ABC-1'});
    now = 60999;
    const beforeEdge = await issueData.openIssue({issueKey: 'ABC-1'});
    now = 61000;
    const atEdge = await issueData.openIssue({issueKey: 'ABC-1'});
    return {
      summaries: [first, beforeEdge, atEdge].map(outcome => outcome.snapshot.core.fields.summary),
      requestCount: jira.getRequests().length,
    };
  });

  expect(result).toEqual({summaries: ['v1', 'v1', 'v2'], requestCount: 2});
});

test('a rejected core read does not poison retry', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', error: 'Temporary outage'},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'Recovered'}}},
    ]});
    const issueData = createQuickViewIssueData({
      jira,
      instanceUrl: 'https://jira.example/',
      customFields: [],
      getSprintFieldIds: async () => [],
      getEpicLinkFieldIds: async () => [],
    });

    const failed = await issueData.openIssue({issueKey: 'ABC-1'});
    const retried = await issueData.openIssue({issueKey: 'ABC-1'});
    return {
      failed: {kind: failed.kind, message: failed.failures.core.message},
      retried: {kind: retried.kind, summary: retried.snapshot.core.fields.summary},
      requestCount: jira.getRequests().length,
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
      {operation: 'read', deferred},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'Retried'}}},
    ]});
    const issueData = createQuickViewIssueData({
      jira,
      instanceUrl: 'https://jira.example/',
      customFields: [],
      getSprintFieldIds: async () => [],
      getEpicLinkFieldIds: async () => [],
    });

    const controller = new AbortController();
    const pending = issueData.openIssue({issueKey: 'ABC-1', signal: controller.signal});
    for (let attempt = 0; attempt < 10 && jira.getRequests().length === 0; attempt += 1) {
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
      requests: jira.getRequests().map(request => ({aborted: request.aborted, operation: request.operation})),
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
      {operation: 'read', match: request => request.path.includes('?fields='), result: {id: '1', key: 'ABC-1', fields: {summary: 'Core'}}},
      {operation: 'read', match: request => request.path.includes('expand=changelog'), error: 'History unavailable'},
      {operation: 'read', match: request => request.path.includes('expand=changelog'), result: {changelog: {histories: [{id: 'h1'}]}}},
    ]});
    const issueData = createQuickViewIssueData({
      jira,
      instanceUrl: 'https://jira.example/',
      customFields: [],
      getSprintFieldIds: async () => [],
      getEpicLinkFieldIds: async () => [],
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
  expect(result.paths).toHaveLength(3);
});

test('an invalidated older read cannot repopulate the cache', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createDeferred, createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const oldRead = createDeferred();
    const jira = createMockJiraAdapter({scripts: [
      {operation: 'read', deferred: oldRead},
      {operation: 'read', result: {id: '1', key: 'ABC-1', fields: {summary: 'new'}}},
    ]});
    const issueData = createQuickViewIssueData({
      jira,
      instanceUrl: 'https://jira.example/',
      customFields: [],
      getSprintFieldIds: async () => [],
      getEpicLinkFieldIds: async () => [],
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
      requestCount: jira.getRequests().length,
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
    const jira = createMockJiraAdapter({scripts: [{
      operation: 'read',
      result: {id: '1', key: 'ABC-1', fields: {summary: 'Original', labels: ['one']}},
    }]});
    const issueData = createQuickViewIssueData({
      jira,
      instanceUrl: 'https://jira.example/',
      customFields: [],
      getSprintFieldIds: async () => [],
      getEpicLinkFieldIds: async () => [],
    });

    const first = await issueData.openIssue({issueKey: 'ABC-1'});
    first.snapshot.core.fields.summary = 'Caller mutation';
    first.snapshot.core.fields.labels.push('two');
    const second = await issueData.openIssue({issueKey: 'ABC-1'});
    return {
      summary: second.snapshot.core.fields.summary,
      labels: second.snapshot.core.fields.labels,
      requestCount: jira.getRequests().length,
    };
  });

  expect(result).toEqual({summary: 'Original', labels: ['one'], requestCount: 1});
});

test('mutation invalidation preserves an unaffected summary projection', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createMockJiraAdapter, createQuickViewIssueData} = window.JiraQuickViewDeepModules;
    const jira = createMockJiraAdapter({scripts: [
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
      getSprintFieldIds: async () => [],
      getEpicLinkFieldIds: async () => [],
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
      requestCount: jira.getRequests().length,
      pendingScripts: jira.getPendingScriptCount(),
    };
  });

  expect(result).toEqual({
    summaries: ['Cached summary', 'Cached summary', 'Refreshed summary'],
    requestCount: 5,
    pendingScripts: 0,
  });
});
