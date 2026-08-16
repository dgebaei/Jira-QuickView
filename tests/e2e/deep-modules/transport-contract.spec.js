const path = require('path');
const {test, expect} = require('@playwright/test');

const harnessPath = path.resolve(__dirname, '../../output/playwright/deep-modules/harness.js');

async function loadHarness(page) {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({path: harnessPath});
}

for (const adapterKind of ['production', 'mock']) {
  test(`${adapterKind} Jira adapter exposes the shared transport contract`, async ({page}) => {
    await loadHarness(page);
    const result = await page.evaluate(async kind => {
      const {createBrowserMessageJiraAdapter, createMockJiraAdapter} = window.JiraQuickViewDeepModules;
      const envelopes = [];
      let adapter;
      if (kind === 'production') {
        adapter = createBrowserMessageJiraAdapter({
          sendMessage: async envelope => {
            envelopes.push(envelope);
            return {result: {action: envelope.action}};
          },
        });
      } else {
        adapter = createMockJiraAdapter({scripts: [
          {operation: 'read', result: {action: 'get'}},
          {operation: 'write', result: {action: 'requestJson'}},
          {operation: 'upload', result: {action: 'uploadAttachment'}},
          {operation: 'image', result: {action: 'getImageDataUrl'}},
        ]});
      }

      const read = await adapter.read({path: 'https://jira.example/rest/api/2/issue/ABC-1'});
      const write = await adapter.write({
        method: 'PUT',
        path: 'https://jira.example/rest/api/2/issue/ABC-1',
        body: {fields: {summary: 'Updated'}},
        headers: {'X-Test': 'yes'},
      });
      const upload = await adapter.upload({
        path: 'https://jira.example/rest/api/2/issue/ABC-1/attachments',
        file: new File([new Uint8Array([1, 2, 3])], 'evidence.png', {type: 'image/png'}),
      });
      const image = await adapter.image({url: 'https://jira.example/avatar.png', mimeType: 'image/png'});

      return {
        envelopes,
        requests: adapter.getRequests ? adapter.getRequests() : [],
        results: [read.action, write.action, upload.action, image.action],
      };
    }, adapterKind);

    expect(result.results).toEqual(['get', 'requestJson', 'uploadAttachment', 'getImageDataUrl']);
    if (adapterKind === 'production') {
      expect(result.envelopes).toEqual([
        {action: 'get', url: 'https://jira.example/rest/api/2/issue/ABC-1'},
        {
          action: 'requestJson',
          method: 'PUT',
          url: 'https://jira.example/rest/api/2/issue/ABC-1',
          body: {fields: {summary: 'Updated'}},
          headers: {'X-Test': 'yes'},
        },
        {
          action: 'uploadAttachment',
          bytes: [1, 2, 3],
          contentType: 'image/png',
          fileName: 'evidence.png',
          url: 'https://jira.example/rest/api/2/issue/ABC-1/attachments',
        },
        {action: 'getImageDataUrl', url: 'https://jira.example/avatar.png', mimeType: 'image/png'},
      ]);
    } else {
      expect(result.requests.map(request => request.operation)).toEqual(['read', 'write', 'upload', 'image']);
    }
  });

  test(`${adapterKind} Jira adapter normalizes failures and observes cancellation`, async ({page}) => {
    await loadHarness(page);
    const result = await page.evaluate(async kind => {
      const {
        createBrowserMessageJiraAdapter,
        createDeferred,
        createMockJiraAdapter,
      } = window.JiraQuickViewDeepModules;
      const deferred = createDeferred();
      let adapter;
      let productionCallCount = 0;
      if (kind === 'production') {
        adapter = createBrowserMessageJiraAdapter({
          sendMessage: envelope => {
            productionCallCount += 1;
            return productionCallCount === 1
              ? Promise.resolve({error: 'Jira unavailable'})
              : deferred.promise.then(() => ({result: envelope.url}));
          },
        });
      } else {
        adapter = createMockJiraAdapter({scripts: [
          {operation: 'read', error: 'Jira unavailable'},
          {operation: 'read', deferred},
        ]});
      }

      let failure;
      try {
        await adapter.read({path: 'https://jira.example/failure'});
      } catch (error) {
        failure = {message: error.message, inner: error.inner};
      }

      const preAbortedController = new AbortController();
      preAbortedController.abort();
      const preAborted = await adapter.read({
        path: 'https://jira.example/already-aborted',
        signal: preAbortedController.signal,
      }).then(() => ({resolved: true}), error => ({name: error.name, message: error.message}));

      const controller = new AbortController();
      const pending = adapter.read({path: 'https://jira.example/slow', signal: controller.signal})
        .then(() => ({resolved: true}), error => ({name: error.name, message: error.message}));
      controller.abort();
      const aborted = await pending;
      deferred.resolve(true);

      return {
        failure,
        aborted,
        requests: adapter.getRequests ? adapter.getRequests() : [],
        callCount: adapter.getRequests ? adapter.getRequests().length : productionCallCount,
        preAborted,
      };
    }, adapterKind);

    expect(result.failure).toEqual({message: 'Jira unavailable', inner: 'Jira unavailable'});
    expect(result.preAborted).toEqual({name: 'AbortError', message: 'Request aborted'});
    expect(result.aborted).toEqual({name: 'AbortError', message: 'Request aborted'});
    expect(result.callCount).toBe(2);
    if (adapterKind === 'mock') {
      expect(result.requests[1].aborted).toBe(true);
    }
  });
}
