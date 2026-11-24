const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {test, expect} = require('@playwright/test');
const extensionManifest = require('../../jira-plugin/manifest.json');

const backgroundBundlePath = path.resolve(__dirname, '../../jira-plugin/build/background.js');
const CURRENT_EXTENSION_VERSION = String(extensionManifest.version || '');

function createJsonResponse(payload, {status = 200, statusText = 'OK'} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: {
      get: name => {
        if (String(name).toLowerCase() === 'content-type') {
          return 'application/json';
        }
        return null;
      }
    },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function mergeStorageValues(defaults, overrides) {
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    return typeof overrides === 'undefined' ? defaults : overrides;
  }

  return {
    ...defaults,
    ...(overrides || {})
  };
}

function createBackgroundHarness(options = {}) {
  const harnessOptions = options && Object.prototype.hasOwnProperty.call(options, 'syncStorageOverrides')
    ? options
    : {syncStorageOverrides: options};
  const syncStorageOverrides = harnessOptions.syncStorageOverrides || {};
  const localStorageState = {
    ...(harnessOptions.localStorageOverrides || {})
  };
  const fetchCalls = [];
  const infoLogs = [];
  const errorLogs = [];
  const order = [];
  let actionClickListener = null;
  let startupListener = null;
  let installedListener = null;
  let alarmListener = null;

  const fetchHandler = harnessOptions.fetchHandler || (async url => {
    throw new Error(`Unexpected fetch in background harness: ${url}`);
  });
  const containsPermission = harnessOptions.containsPermission;

  const testConsole = {
    info: (...args) => {
      infoLogs.push(args);
    },
    log: (...args) => {
      infoLogs.push(args);
    },
    warn: (...args) => {
      errorLogs.push(args);
    },
    error: (...args) => {
      errorLogs.push(args);
    }
  };

  const chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      getURL: value => `chrome-extension://test-extension-id/${value || ''}`,
      getManifest: () => ({
        version: CURRENT_EXTENSION_VERSION
      }),
      openOptionsPage: () => {
        order.push('runtime.openOptionsPage');
      },
      onInstalled: {
        addListener: listener => {
          installedListener = listener;
        }
      },
      onStartup: {
        addListener: listener => {
          startupListener = listener;
        }
      },
      onMessage: {
        addListener() {}
      }
    },
    storage: {
      sync: {
        get: (defaults, callback) => {
          order.push('storage.sync.get');
          callback(mergeStorageValues(defaults, syncStorageOverrides));
        },
        set: (value, callback) => {
          void value;
          order.push('storage.sync.set');
          if (callback) {
            callback();
          }
        }
      },
      local: {
        get: (defaults, callback) => {
          order.push('storage.local.get');
          callback(mergeStorageValues(defaults, localStorageState));
        },
        set: (value, callback) => {
          order.push('storage.local.set');
          Object.assign(localStorageState, value || {});
          if (callback) {
            callback();
          }
        }
      }
    },
    permissions: {
      request: (permissions, callback) => {
        void permissions;
        order.push('permissions.request');
        callback(true);
      },
      contains: (permissions, callback) => {
        void permissions;
        order.push('permissions.contains');
        callback(typeof containsPermission === 'undefined' ? true : !!containsPermission);
      }
    },
    tabs: {
      query: (queryInfo, callback) => {
        void queryInfo;
        order.push('tabs.query');
        callback(harnessOptions.tabs || []);
      },
      sendMessage: (tabId, payload, callback) => {
        void tabId;
        void payload;
        order.push('tabs.sendMessage');
        if (callback) {
          callback();
        }
      }
    },
    action: {
      setTitle: (options, callback) => {
        void options;
        order.push('action.setTitle');
        if (callback) {
          callback();
        }
      },
      setBadgeText: (options, callback) => {
        void options;
        order.push('action.setBadgeText');
        if (callback) {
          callback();
        }
      },
      setBadgeBackgroundColor: (options, callback) => {
        void options;
        order.push('action.setBadgeBackgroundColor');
        if (callback) {
          callback();
        }
      },
      onClicked: {
        addListener: listener => {
          actionClickListener = listener;
        }
      }
    },
    alarms: {
      create: options => {
        void options;
        order.push('alarms.create');
      },
      onAlarm: {
        addListener: listener => {
          alarmListener = listener;
        }
      }
    },
    webNavigation: {
      onCommitted: {
        addListener() {}
      }
    },
    scripting: {
      executeScript: (options, callback) => {
        void options;
        order.push('scripting.executeScript');
        if (callback) {
          callback();
        }
      }
    },
    declarativeContent: {
      onPageChanged: {
        removeRules: (rules, callback) => {
          void rules;
          if (callback) {
            callback();
          }
        },
        addRules: (rules, callback) => {
          void rules;
          if (callback) {
            callback();
          }
        }
      },
      PageStateMatcher: function PageStateMatcher(config) {
        this.config = config;
      },
      RequestContentScript: function RequestContentScript(config) {
        this.config = config;
      }
    }
  };

  const context = {
    chrome,
    console: testConsole,
    URL,
    URLSearchParams,
    Promise,
    AbortController,
    FormData,
    Blob,
    Uint8Array,
    ArrayBuffer,
    Buffer,
    fetch: async (url, init) => {
      fetchCalls.push({url, init});
      return fetchHandler(url, init);
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    btoa: value => Buffer.from(String(value), 'binary').toString('base64')
  };
  context.globalThis = context;
  context.self = context;

  vm.runInNewContext(fs.readFileSync(backgroundBundlePath, 'utf8'), context, {
    filename: backgroundBundlePath
  });

  return {
    order,
    fetchCalls,
    infoLogs,
    errorLogs,
    localStorageState,
    clickAction: tab => {
      if (!actionClickListener) {
        throw new Error('Action click listener was not registered');
      }
      actionClickListener(tab);
    },
    triggerStartup: () => {
      if (!startupListener) {
        throw new Error('Startup listener was not registered');
      }
      startupListener();
    },
    triggerInstalled: () => {
      if (!installedListener) {
        throw new Error('Installed listener was not registered');
      }
      installedListener();
    },
    triggerAlarm: alarm => {
      if (!alarmListener) {
        throw new Error('Alarm listener was not registered');
      }
      alarmListener(alarm);
    }
  };
}

async function flushUntil(predicate, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for background handler state');
}

test('requests permissions before reading config on action click', async () => {
  const harness = createBackgroundHarness({
    instanceUrl: 'https://jira.example.com/',
    v15upgrade: true,
    domains: []
  });

  harness.clickAction({
    id: 7,
    url: 'https://docs.google.com/spreadsheets/d/example/edit'
  });

  await flushUntil(() => harness.order.includes('storage.sync.get'));

  expect(harness.order[0]).toBe('permissions.request');
  expect(harness.order.indexOf('permissions.request')).toBeLessThan(harness.order.indexOf('storage.sync.get'));
});

test('requests permissions before checking whether Jira is configured', async () => {
  const harness = createBackgroundHarness({
    instanceUrl: '',
    v15upgrade: false,
    domains: []
  });

  harness.clickAction({
    id: 9,
    url: 'https://docs.google.com/spreadsheets/d/example/edit'
  });

  await flushUntil(() => harness.order.includes('runtime.openOptionsPage'));

  expect(harness.order[0]).toBe('permissions.request');
  expect(harness.order.indexOf('permissions.request')).toBeLessThan(harness.order.indexOf('storage.sync.get'));
  expect(harness.order.indexOf('storage.sync.get')).toBeLessThan(harness.order.indexOf('runtime.openOptionsPage'));
});

test('startup smoke skips when the extension is not configured yet', async () => {
  const harness = createBackgroundHarness({
    syncStorageOverrides: {
      instanceUrl: '',
      v15upgrade: false,
      domains: []
    }
  });

  harness.triggerStartup();

  await flushUntil(() => harness.infoLogs.some(entry => String(entry[0]).includes('smoke test skipped: instanceUrl not configured')));

  expect(harness.fetchCalls).toEqual([]);
  expect(
    harness.infoLogs.some(entry => String(entry[0]).includes(`Jira QuickView v${CURRENT_EXTENSION_VERSION} initialized via onStartup`))
  ).toBe(true);
});

test('startup smoke fetches the popup issue payload for the first accessible issue', async () => {
  const harness = createBackgroundHarness({
    syncStorageOverrides: {
      instanceUrl: 'https://jira.example.com/',
      v15upgrade: true,
      domains: [],
      customFields: [{fieldId: 'customfield_10010'}]
    },
    fetchHandler: async url => {
      if (url === 'https://jira.example.com/rest/api/2/myself') {
        return createJsonResponse({displayName: 'Ada Lovelace', accountId: 'account-1'});
      }
      if (url.startsWith('https://jira.example.com/rest/api/latest/search?')) {
        return createJsonResponse({
          errorMessages: ['Search endpoint unavailable on this Jira flavor'],
          errors: {}
        }, {
          status: 404,
          statusText: 'Not Found'
        });
      }
      if (url.startsWith('https://jira.example.com/rest/api/2/search?')) {
        return createJsonResponse({
          errorMessages: ['The requested API has been removed. Please migrate to the /rest/api/3/search/jql API. A full migration guideline is available at https://developer.atlassian.com/changelog/#CHANGE-2046'],
          errors: {}
        }, {
          status: 400,
          statusText: 'Bad Request'
        });
      }
      if (url.startsWith('https://jira.example.com/rest/api/3/search/jql?')) {
        return createJsonResponse({
          issues: [{key: 'JRACLOUD-1', id: '10001'}]
        });
      }
      if (url === 'https://jira.example.com/rest/api/2/field') {
        return createJsonResponse([
          {
            id: 'customfield_20000',
            name: 'Sprint',
            schema: {custom: 'com.pyxis.greenhopper.jira:gh-sprint'}
          },
          {
            id: 'customfield_30000',
            name: 'Epic Link',
            schema: {custom: 'com.pyxis.greenhopper.jira:gh-epic-link'}
          }
        ]);
      }
      if (url.startsWith('https://jira.example.com/rest/api/2/issue/JRACLOUD-1?')) {
        return createJsonResponse({
          id: '10001',
          key: 'JRACLOUD-1',
          fields: {
            summary: 'Smoke test issue'
          }
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
  });

  harness.triggerStartup();

  await flushUntil(() => harness.infoLogs.some(entry => String(entry[0]).includes('smoke test passed for JRACLOUD-1')));

  const issueRequest = harness.fetchCalls.find(call => call.url.includes('/rest/api/2/issue/JRACLOUD-1?'));
  expect(issueRequest).toBeTruthy();
  expect(issueRequest.url).toContain('customfield_10010');
  expect(issueRequest.url).toContain('customfield_20000');
  expect(issueRequest.url).toContain('customfield_30000');
  expect(harness.infoLogs.some(entry => String(entry[0]).includes('Jira reachable'))).toBe(true);
});

test('startup smoke logs a failure when the popup issue payload fetch fails', async () => {
  const harness = createBackgroundHarness({
    syncStorageOverrides: {
      instanceUrl: 'https://jira.example.com/',
      v15upgrade: true,
      domains: [],
      customFields: []
    },
    fetchHandler: async url => {
      if (url === 'https://jira.example.com/rest/api/2/myself') {
        return createJsonResponse({displayName: 'Ada Lovelace'});
      }
      if (url.startsWith('https://jira.example.com/rest/api/latest/search?')) {
        return createJsonResponse({errorMessages: ['Missing search endpoint']}, {
          status: 404,
          statusText: 'Not Found'
        });
      }
      if (url.startsWith('https://jira.example.com/rest/api/3/search/jql?')) {
        return createJsonResponse({errorMessages: ['Missing search endpoint']}, {
          status: 404,
          statusText: 'Not Found'
        });
      }
      if (url.startsWith('https://jira.example.com/rest/api/2/search?')) {
        return createJsonResponse({
          issues: [{key: 'JRACLOUD-404', id: '404'}]
        });
      }
      if (url === 'https://jira.example.com/rest/api/2/field') {
        return createJsonResponse([]);
      }
      if (url.startsWith('https://jira.example.com/rest/api/2/issue/JRACLOUD-404?')) {
        return createJsonResponse({errorMessages: ['Missing issue']}, {
          status: 500,
          statusText: 'Internal Server Error'
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
  });

  harness.triggerStartup();

  await flushUntil(() => harness.errorLogs.some(entry => String(entry[0]).includes('smoke test failed for JRACLOUD-404')));

  expect(harness.errorLogs.some(entry => String(entry[0]).includes('HTTP 500 - Internal Server Error: Missing issue'))).toBe(true);
});
