const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {test: base, expect, chromium} = require('@playwright/test');
const {createMockJiraServer} = require('./mock-jira-server');
const {createFixtureServer} = require('./fixture-server');

const extensionPath = path.resolve(__dirname, '../../../jira-plugin');

async function readStorageStateFile() {
  const storageStatePath = String(process.env.JIRA_LIVE_STORAGE_STATE || '').trim();
  if (!storageStatePath) {
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
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jira-hot-linker-playwright-'));
  const testExtensionPath = await createTestExtensionCopy();
  const storageState = await readStorageStateFile();
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
}

async function getExtensionId(context) {
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker');
  }
  return serviceWorker.url().split('/')[2];
}

async function configureExtension(optionsPage, config, permissionOverride) {
  if (typeof permissionOverride === 'boolean') {
    await optionsPage.evaluate(result => {
      const original = chrome.permissions.request.bind(chrome.permissions);
      chrome.permissions.request = (permissions, callback) => {
        window.__lastPermissionRequest = permissions;
        callback(result);
      };
      window.__restorePermissionsRequest = () => {
        chrome.permissions.request = original;
      };
    }, permissionOverride);
  }

  await optionsPage.getByLabel('Jira instance URL').fill(config.instanceUrl);
  await optionsPage.getByLabel('Allowed pages').fill(config.domains.join(', '));

  if (config.hoverDepth) {
    await optionsPage.getByLabel('Trigger depth').selectOption(config.hoverDepth);
  }
  if (config.hoverModifierKey) {
    await optionsPage.getByLabel('Modifier key').selectOption(config.hoverModifierKey);
  }

  if (config.displayFields) {
    for (const [key, checked] of Object.entries(config.displayFields)) {
      await optionsPage.locator(`#displayField_${key}`).setChecked(checked);
    }
  }

  if (Array.isArray(config.customFields)) {
    const addButton = optionsPage.getByRole('button', {name: 'Add another field'});
    for (let index = 0; index < config.customFields.length; index += 1) {
      const existingRows = await optionsPage.locator('.customFieldRow').count();
      if (existingRows <= index) {
        await addButton.click();
      }
      const row = optionsPage.locator('.customFieldRow').nth(index);
      await row.getByLabel('Field ID').fill(config.customFields[index].fieldId);
      await row.getByLabel('Location').selectOption(String(config.customFields[index].row));
    }
  }

  await optionsPage.getByRole('button', {name: 'Save changes'}).click();
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
    const tabs = await new Promise(resolve => {
      chrome.tabs.query({}, resolve);
    });
    const tab = tabs.find(candidate => candidate.url === targetUrl);
    if (!tab || typeof tab.id !== 'number' || tab.id < 0) {
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
