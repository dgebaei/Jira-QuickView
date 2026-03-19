const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {test, expect} = require('@playwright/test');

const backgroundBundlePath = path.resolve(__dirname, '../../jira-plugin/build/background.js');

function mergeStorageValues(defaults, overrides) {
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    return typeof overrides === 'undefined' ? defaults : overrides;
  }

  return {
    ...defaults,
    ...(overrides || {})
  };
}

function createBackgroundHarness(storageOverrides = {}) {
  const order = [];
  let actionClickListener = null;

  const chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      getURL: value => `chrome-extension://test-extension-id/${value || ''}`,
      openOptionsPage: () => {
        order.push('runtime.openOptionsPage');
      },
      onInstalled: {
        addListener() {}
      },
      onMessage: {
        addListener() {}
      }
    },
    storage: {
      sync: {
        get: (defaults, callback) => {
          order.push('storage.sync.get');
          callback(mergeStorageValues(defaults, storageOverrides));
        },
        set: (value, callback) => {
          void value;
          order.push('storage.sync.set');
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
      }
    },
    tabs: {
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
    console,
    URL,
    Promise,
    AbortController,
    FormData,
    Blob,
    Uint8Array,
    ArrayBuffer,
    Buffer,
    fetch: async () => {
      throw new Error('Unexpected fetch in action click regression test');
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
    clickAction: tab => {
      if (!actionClickListener) {
        throw new Error('Action click listener was not registered');
      }
      actionClickListener(tab);
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
