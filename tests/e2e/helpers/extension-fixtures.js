const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {test: base, expect} = require('@playwright/test');
const {chromium} = require('playwright');
const {createMockJiraServer} = require('./mock-jira-server');
const {createFixtureServer} = require('./fixture-server');

const extensionPath = path.resolve(__dirname, '../../../jira-plugin');
const EXTENSION_LAUNCH_RETRIES = 3;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readStorageStateFile() {
  const storageStatePath = String(process.env.JIRA_LIVE_STORAGE_STATE || '').trim();
  if (!storageStatePath) {
    return null;
  }
  try {
    await fs.access(path.resolve(storageStatePath));
  } catch (error) {
    return null;
  }
  const raw = await fs.readFile(path.resolve(storageStatePath), 'utf8');
  return JSON.parse(raw);
}

async function applyStorageState(context, storageState) {
  if (!storageState) {
    return;
  }

  if (Array.isArray(storageState.cookies) && storageState.cookies.length) {
    await context.addCookies(storageState.cookies);
  }

  const origins = Array.isArray(storageState.origins) ? storageState.origins : [];
  if (origins.length) {
    await context.addInitScript(({entries}) => {
      const currentOrigin = window.location.origin;
      const match = entries.find(entry => entry.origin === currentOrigin);
      if (!match || !Array.isArray(match.localStorage)) {
        return;
      }
      for (const item of match.localStorage) {
        window.localStorage.setItem(item.name, item.value);
      }
    }, {entries: origins});
  }
}

async function createTestExtensionCopy() {
  const extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jira-hot-linker-extension-'));
  await fs.cp(extensionPath, extensionDir, {recursive: true});
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.permissions = Array.from(new Set([...(manifest.permissions || []), 'scripting']));
  manifest.host_permissions = ['<all_urls>'];
  manifest.optional_host_permissions = ['<all_urls>'];
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return extensionDir;
}

async function launchExtensionContext() {
  const storageState = await readStorageStateFile();
  let lastError = null;

  for (let attempt = 1; attempt <= EXTENSION_LAUNCH_RETRIES; attempt += 1) {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jira-hot-linker-playwright-'));
    const testExtensionPath = await createTestExtensionCopy();

    try {
      const context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chromium',
        headless: true,
        args: [
          `--disable-extensions-except=${testExtensionPath}`,
          `--load-extension=${testExtensionPath}`,
        ],
      });
      await applyStorageState(context, storageState);
      return {context, userDataDir, testExtensionPath};
    } catch (error) {
      lastError = error;
      await fs.rm(userDataDir, {recursive: true, force: true}).catch(() => {});
      await fs.rm(testExtensionPath, {recursive: true, force: true}).catch(() => {});
      if (attempt < EXTENSION_LAUNCH_RETRIES) {
        await sleep(250 * attempt);
      }
    }
  }

  throw lastError || new Error('Could not launch Chromium extension context.');
}

async function getExtensionId(context) {
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    try {
      serviceWorker = await context.waitForEvent('serviceworker', {timeout: 30000});
    } catch (_firstTimeout) {
      // Chrome can be slow to start the extension worker; open a blank page to nudge it
      const nudgePage = await context.newPage();
      await nudgePage.goto('about:blank').catch(() => {});
      await nudgePage.close().catch(() => {});
      [serviceWorker] = context.serviceWorkers();
      if (!serviceWorker) {
        serviceWorker = await context.waitForEvent('serviceworker', {timeout: 15000});
      }
    }
  }
  return serviceWorker.url().split('/')[2];
}

async function configureExtension(optionsPage, config) {
  let normalizedUrl = String(config.instanceUrl || '').trim();
  if (normalizedUrl && !normalizedUrl.endsWith('/')) {
    normalizedUrl += '/';
  }

  const tooltipLayout = config.tooltipLayout || {
    row1: ['issueType', 'status', 'priority', 'epicParent'],
    row2: ['sprint', 'affects', 'fixVersions'],
    row3: ['environment', 'labels'],
    contentBlocks: ['description', 'attachments', 'comments', 'pullRequests'],
    people: ['reporter', 'assignee']
  };

  const storageData = {
    instanceUrl: normalizedUrl,
    domains: config.domains,
    hoverDepth: config.hoverDepth || 'exact',
    hoverModifierKey: config.hoverModifierKey || 'none',
    displayFields: config.displayFields || {},
    customFields: config.customFields || [],
    tooltipLayout,
    v15upgrade: true
  };

  await optionsPage.evaluate(async (data) => {
    await chrome.storage.sync.set(data);
  }, storageData);
  await optionsPage.waitForTimeout(500);

  const saved = await optionsPage.evaluate(() => {
    return chrome.storage.sync.get(['instanceUrl', 'domains', 'tooltipLayout', 'v15upgrade']);
  });

  if (!saved.instanceUrl) {
    throw new Error('Failed to save instanceUrl to storage');
  }

  if (!saved.tooltipLayout) {
    throw new Error('Failed to save tooltipLayout to storage');
  }

  if (!saved.v15upgrade) {
    throw new Error('Failed to save v15upgrade to storage');
  }
}

async function hoverIssueKey(page, selector, modifier) {
  if (modifier) {
    await page.keyboard.down(modifier);
  }
  await page.locator(selector).hover();
  if (modifier) {
    await page.keyboard.up(modifier);
  }
}

async function injectContentScript(extensionApp, page) {
  const serviceWorker = extensionApp.context.serviceWorkers()[0] || await extensionApp.context.waitForEvent('serviceworker');
  const pageUrl = page.url();
  await serviceWorker.evaluate(async targetUrl => {
    function normalizeUrl(value) {
      try {
        const url = new URL(value);
        url.hash = '';
        return url.toString();
      } catch (error) {
        return String(value || '');
      }
    }

    function samePage(left, right) {
      try {
        const leftUrl = new URL(left);
        const rightUrl = new URL(right);
        return leftUrl.origin === rightUrl.origin && leftUrl.pathname === rightUrl.pathname;
      } catch (error) {
        return false;
      }
    }

    function sameOrigin(left, right) {
      try {
        return new URL(left).origin === new URL(right).origin;
      } catch (error) {
        return false;
      }
    }

    const normalizedTargetUrl = normalizeUrl(targetUrl);
    const deadline = Date.now() + 5000;
    let tab = null;

    while (!tab && Date.now() < deadline) {
      const tabs = await new Promise(resolve => {
        chrome.tabs.query({}, resolve);
      });

      tab = tabs.find(candidate => {
        const candidateUrl = normalizeUrl(candidate.url);
        return candidateUrl === normalizedTargetUrl || candidateUrl.startsWith(normalizedTargetUrl) || samePage(candidateUrl, normalizedTargetUrl);
      }) || null;

      if (!tab) {
        const sameOriginTabs = tabs.filter(candidate => sameOrigin(candidate.url, normalizedTargetUrl));
        tab = sameOriginTabs[sameOriginTabs.length - 1] || null;
      }

      if (!tab) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    if (!tab?.id) {
      throw new Error(`Could not find tab for ${targetUrl}`);
    }
    await chrome.scripting.executeScript({
      target: {tabId: tab.id},
      files: ['build/main.js'],
    });
  }, pageUrl);
}

const test = base.extend({
  servers: [async ({browserName}, use) => {
    void browserName;
    const jira = await createMockJiraServer();
    const allowedPage = await createFixtureServer();
    const disallowedPage = await createFixtureServer();
    await use({jira, allowedPage, disallowedPage});
    await Promise.all([jira.close(), allowedPage.close(), disallowedPage.close()]);
  }, {scope: 'worker'}],

  extensionApp: async ({browserName}, use) => {
    void browserName;
    const {context, userDataDir, testExtensionPath} = await launchExtensionContext();
    try {
      const extensionId = await getExtensionId(context);
      await use({context, extensionId, userDataDir, testExtensionPath});
    } finally {
      await context.close();
      await fs.rm(userDataDir, {recursive: true, force: true});
      await fs.rm(testExtensionPath, {recursive: true, force: true});
    }
  },

  optionsPage: async ({extensionApp}, use) => {
    const optionsUrl = `chrome-extension://${extensionApp.extensionId}/options/options.html`;
    const page = extensionApp.context.pages().find(candidate => candidate.url().startsWith(optionsUrl)) || await extensionApp.context.newPage();
    if (!page.url().startsWith(optionsUrl)) {
      try {
        await page.goto(optionsUrl, {waitUntil: 'domcontentloaded'});
      } catch (error) {
        if (!String(error?.message || '').includes('interrupted')) {
          throw error;
        }
        await page.waitForURL(new RegExp(`^${optionsUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      }
    } else {
      await page.waitForLoadState('domcontentloaded');
    }
    await use(page);
    if (!page.isClosed()) {
      await page.close();
    }
  },
});

module.exports = {
  test,
  expect,
  configureExtension,
  hoverIssueKey,
  injectContentScript,
};
