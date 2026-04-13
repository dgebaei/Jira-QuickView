const fs = require('fs/promises');
const extensionManifest = require('../../jira-plugin/manifest.json');
const {test, expect, configureExtension} = require('./helpers/extension-fixtures');
const {failWithJson, patchJsonResponse} = require('./helpers/jira-route-mocks');
const {getFirstCustomFieldId} = require('./helpers/live-jira-api');
const {contentBlockItem, customFieldLibraryItem, openAdvancedSettings, optionsPageModel} = require('./helpers/options-page');
const {buildExtensionConfig, requireJiraTestTarget} = require('./helpers/test-targets');

const CURRENT_EXTENSION_VERSION = String(extensionManifest.version || '');

function baseConfig(servers, target, overrides = {}) {
  return {
    ...buildExtensionConfig(servers, {}, target),
    customFields: [],
    ...overrides,
  };
}

function buildJiraAttachmentContentDownloadUrl(target, attachmentId) {
  const instanceUrl = String(target.instanceUrl).replace(/\/?$/, '/');
  return `${instanceUrl}rest/api/2/attachment/content/${attachmentId}?redirect=false`;
}

async function readStoredConfig(optionsPage) {
  return optionsPage.evaluate(async () => chrome.storage.sync.get(['hoverDepth', 'hoverModifierKey', 'displayFields']));
}

async function readSimpleSyncStorage(optionsPage) {
  const stored = await optionsPage.evaluate(async () => chrome.storage.local.get(['jqv.simpleSync']));
  return stored['jqv.simpleSync'];
}

test('shows validation for an empty Jira instance URL', async ({optionsPage}) => {
  const form = optionsPageModel(optionsPage);
  await form.instanceUrlInput.fill('');
  await form.saveButton.click();
  await expect(form.saveNotice).toContainText('You must provide your Jira instance URL.');
});

test('shows whether there are unsaved changes in the hero status pill', async ({optionsPage}) => {
  const form = optionsPageModel(optionsPage);

  await expect(form.statusPill).toContainText('No unsaved changes.');

  await form.instanceUrlInput.fill('example.atlassian.net');

  await expect(form.statusPill).toContainText('Unsaved changes.');
});

test('shows quick links to docs and issue reporting in the hero header', async ({optionsPage}) => {
  const form = optionsPageModel(optionsPage);

  await expect(form.heroLinks).toBeVisible();
  await expect(form.heroLinkDownload).toHaveAttribute('href', 'https://chromewebstore.google.com/detail/jira-quickview/oddgjhpfjkeckcppcldgjomlnablfkia');
  await expect(form.heroLinkWebsite).toHaveAttribute('href', 'https://dgebaei.github.io/Jira-QuickView/');
  await expect(form.heroLinkGuide).toHaveAttribute('href', 'https://dgebaei.github.io/Jira-QuickView/user-guide.html');
  await expect(form.heroLinkRepo).toHaveAttribute('href', 'https://github.com/dgebaei/Jira-QuickView');
  await expect(form.heroLinkIssues).toHaveAttribute('href', 'https://github.com/dgebaei/Jira-QuickView/issues');
  await expect(form.heroLinkNewIssue).toHaveAttribute('href', 'https://github.com/dgebaei/Jira-QuickView/issues/new/choose');

  const screenshotPath = String(process.env.JHL_CAPTURE_OPTIONS_SCREENSHOT || '').trim();
  if (screenshotPath) {
    await optionsPage.setViewportSize({width: 1440, height: 960});
    await optionsPage.screenshot({path: screenshotPath});
  }
});

test('normalizes and persists a bare Jira hostname on save', async ({optionsPage}) => {
  const form = optionsPageModel(optionsPage);

  await form.instanceUrlInput.fill('example.atlassian.net');
  await form.saveButton.click();
  await expect(form.saveNotice).toContainText('Options saved successfully.');

  await optionsPage.reload();
  await expect(form.instanceUrlInput).toHaveValue('https://example.atlassian.net/');

  const stored = await optionsPage.evaluate(async () => chrome.storage.sync.get(['instanceUrl', 'domains']));
  expect(stored.instanceUrl).toBe('https://example.atlassian.net/');
  expect(stored.domains).toContain('https://example.atlassian.net/');
});

test('allows supported Jira field ids in the popup layout while blocking built-in duplicates', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  const form = optionsPageModel(optionsPage);
  if (target.mode === 'mock') {
    await patchJsonResponse(optionsPage.context(), target.instanceUrl, '/rest/api/2/field(?:\\?.*)?$', (payload, request) => {
      if (request.method() !== 'GET') {
        return payload;
      }
      return [
        ...(Array.isArray(payload) ? payload : []),
        {id: 'resolution', name: 'Resolution', schema: {type: 'option'}},
      ];
    });
  }
  await configureExtension(optionsPage, baseConfig(servers, target));
  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);

  await form.fieldLibraryAddButton.click();

  await form.fieldLibraryInput.fill('not_a_real_jira_field');
  await expect(form.fieldLibraryValidation).toContainText('Not found in Jira');
  await expect(form.fieldLibrarySaveButton).toBeDisabled();

  await form.fieldLibraryInput.fill('labels');
  await expect(form.fieldLibraryValidation).toContainText('Built-in field');
  await expect(form.fieldLibrarySaveButton).toBeDisabled();

  await form.fieldLibraryInput.fill('resolution');
  await expect(form.fieldLibraryValidation).toContainText('Resolution');
  await expect(form.fieldLibrarySaveButton).toBeEnabled();

  await form.fieldLibrarySaveButton.click();
  await expect(customFieldLibraryItem(optionsPage, 'resolution')).toContainText('Resolution');

  await form.saveButton.click();
  await expect(form.saveNotice).toContainText('Options saved successfully.');

  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);
  await expect(customFieldLibraryItem(optionsPage, 'resolution')).toContainText('Resolution');

  const stored = await optionsPage.evaluate(async () => chrome.storage.sync.get(['customFields']));
  expect(stored.customFields).toEqual(expect.arrayContaining([{fieldId: 'resolution', row: 3}]));
});

test('persists custom fields added through the options page', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  const form = optionsPageModel(optionsPage);
  const customFieldId = target.mode === 'mock' ? 'customfield_12345' : await getFirstCustomFieldId(target);
  test.skip(!customFieldId, 'No Jira custom field is available for persistence coverage.');

  await configureExtension(optionsPage, baseConfig(servers, target));
  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);

  await form.fieldLibraryAddButton.click();
  await form.fieldLibraryInput.fill(customFieldId);
  await expect(form.fieldLibrarySaveButton).toBeEnabled();
  await form.fieldLibrarySaveButton.click();
  await form.saveButton.click();
  await expect(form.saveNotice).toContainText('Options saved successfully.');

  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);
  await expect(customFieldLibraryItem(optionsPage, customFieldId)).toBeVisible();

  const stored = await optionsPage.evaluate(async () => chrome.storage.sync.get(['customFields']));
  expect(stored.customFields).toEqual(expect.arrayContaining([{fieldId: customFieldId, row: 3}]));
});

test('persists custom field row changes when moving a field into row 2', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  const form = optionsPageModel(optionsPage);
  const customFieldId = target.mode === 'mock' ? 'customfield_12345' : await getFirstCustomFieldId(target);
  test.skip(!customFieldId, 'No Jira custom field is available for row persistence coverage.');

  await configureExtension(optionsPage, baseConfig(servers, target, {
    customFields: [{fieldId: customFieldId, row: 3}],
  }));
  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);

  await expect(customFieldLibraryItem(optionsPage, customFieldId)).toBeVisible();

  await optionsPage.evaluate(({fieldKey}) => {
    window.__JHL_TEST_API__.moveTooltipField(fieldKey, 'row2');
  }, {fieldKey: `custom_${customFieldId}`});

  await expect(optionsPage.getByTestId('options-tooltip-row-row2')).toHaveAttribute(
    'data-layout-order',
    new RegExp(`(^|,)custom_${customFieldId}($|,)`)
  );

  await form.saveButton.click();
  await expect(form.saveNotice).toContainText('Options saved successfully.');

  const stored = await optionsPage.evaluate(async () => chrome.storage.sync.get(['customFields', 'tooltipLayout']));
  expect(stored.customFields).toEqual(expect.arrayContaining([{fieldId: customFieldId, row: 2}]));
  expect(stored.tooltipLayout.row2).toContain(`custom_${customFieldId}`);
});

test('persists hover behavior settings through the options page', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  const form = optionsPageModel(optionsPage);
  await configureExtension(optionsPage, baseConfig(servers, target));
  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);

  await form.hoverDepthSelect.selectOption('deep');
  await form.hoverModifierSelect.selectOption('shift');
  await form.saveButton.click();
  await expect(form.saveNotice).toContainText('Options saved successfully.');

  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);

  await expect(form.hoverDepthSelect).toHaveValue('deep');
  await expect(form.hoverModifierSelect).toHaveValue('shift');

  const stored = await optionsPage.evaluate(async () => chrome.storage.sync.get(['hoverDepth', 'hoverModifierKey']));
  expect(stored.hoverDepth).toBe('deep');
  expect(stored.hoverModifierKey).toBe('shift');
});

test('persists reordered content blocks through the options page', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  const form = optionsPageModel(optionsPage);

  await configureExtension(optionsPage, baseConfig(servers, target));
  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);

  await expect(contentBlockItem(optionsPage, 'pullRequests')).toBeVisible();
  await optionsPage.evaluate(() => {
    window.__JHL_TEST_API__.moveContentBlock('pullRequests', 1);
  });

  await expect(form.contentBlocksDropzone).toHaveAttribute('data-content-order', /^description,pullRequests,/);
  await form.saveButton.click();
  await expect(form.saveNotice).toContainText('Options saved successfully.');

  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);
  await expect(form.contentBlocksDropzone).toHaveAttribute('data-content-order', /^description,pullRequests,/);

  const stored = await optionsPage.evaluate(async () => chrome.storage.sync.get(['tooltipLayout']));
  expect(stored.tooltipLayout.contentBlocks.slice(0, 2)).toEqual(['description', 'pullRequests']);
});

test('exports the current settings as JSON', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  const form = optionsPageModel(optionsPage);

  await configureExtension(optionsPage, baseConfig(servers, target, {
    instanceUrl: 'https://example.atlassian.net/',
    hoverDepth: 'deep',
    hoverModifierKey: 'shift',
  }));
  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);

  const downloadPromise = optionsPage.waitForEvent('download');
  await optionsPage.getByTestId('options-export-settings').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('jira-quickview-settings.json');
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();

  const exported = JSON.parse(await fs.readFile(downloadPath, 'utf8'));
  expect(exported.schemaVersion).toBe(1);
  expect(exported.settingsRevision).toBe(1);
  expect(exported.minimumExtensionVersion).toBe(CURRENT_EXTENSION_VERSION);
  expect(exported.policy.instanceUrl).toBe('locked');
  expect(exported.settings.instanceUrl).toBe('https://example.atlassian.net/');
  expect(exported.settings.hoverDepth).toBe('deep');
  expect(exported.settings.hoverModifierKey).toBe('shift');
  expect(exported.settings.tooltipLayout.contentBlocks).toContain('pullRequests');
});

test('shows an error when importing an invalid settings file', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  await configureExtension(optionsPage, baseConfig(servers, target));
  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);

  const fileChooserPromise = optionsPage.waitForEvent('filechooser');
  await optionsPage.getByTestId('options-import-settings').click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: 'invalid-settings.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{not valid json', 'utf8'),
  });

  await expect(optionsPage.getByTestId('options-save-notice')).toContainText('Failed to import settings file.');
});

test('imports the Team Sync-compatible settings envelope', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  const form = optionsPageModel(optionsPage);

  await configureExtension(optionsPage, baseConfig(servers, target));
  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);

  const fileChooserPromise = optionsPage.waitForEvent('filechooser');
  await optionsPage.getByTestId('options-import-settings').click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: 'team-sync-settings.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      schemaVersion: 1,
      settingsRevision: 4,
      settings: {
        instanceUrl: 'https://example.atlassian.net/',
        domains: ['https://github.com/*'],
        hoverDepth: 'deep',
        hoverModifierKey: 'shift',
      },
    }), 'utf8'),
  });

  await expect(form.saveNotice).toContainText('Settings imported. Click Save to apply.');
  await expect(form.instanceUrlInput).toHaveValue('https://example.atlassian.net/');
  await expect(form.hoverDepthSelect).toHaveValue('deep');
  await expect(form.hoverModifierSelect).toHaveValue('shift');
});

test('runs Sync Now against draft Team Sync fields without saving the source', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  const form = optionsPageModel(optionsPage);
  const settingsUrl = `${String(target.instanceUrl).replace(/\/?$/, '/')}files/jira-quickview-settings.json`;
  const syncedSettings = {
    schemaVersion: 1,
    settingsRevision: 3,
    settings: {
      instanceUrl: target.instanceUrl,
      domains: target.domains,
      hoverDepth: 'deep',
      hoverModifierKey: 'shift',
    },
    policy: {
      instanceUrl: 'locked',
      domains: 'default',
      hoverDepth: 'locked',
      hoverModifierKey: 'locked',
    },
  };

  await configureExtension(optionsPage, baseConfig(servers, target));
  await optionsPage.context().route(settingsUrl, async route => {
    await route.fulfill({
      status: 200,
      headers: {'content-type': 'application/json; charset=utf-8'},
      body: JSON.stringify(syncedSettings),
    });
  });
  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);

  await form.teamSyncSourceTypeSelect.selectOption('url');
  await form.teamSyncUrlInput.fill(settingsUrl);
  await form.teamSyncNowButton.click();

  await expect(form.hoverDepthSelect).toHaveValue('deep');
  await expect(form.hoverModifierSelect).toHaveValue('shift');

  const syncStorage = await readSimpleSyncStorage(optionsPage);
  expect(syncStorage).toBeUndefined();
});

test('shows an error when optional host permissions are denied', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  const form = optionsPageModel(optionsPage);

  await optionsPage.evaluate(() => {
    const denyRequest = (_permissions, callback) => callback(false);
    try {
      chrome.permissions.request = denyRequest;
    } catch (error) {
      Object.defineProperty(chrome.permissions, 'request', {
        configurable: true,
        value: denyRequest,
      });
    }
  });

  await form.instanceUrlInput.fill(target.instanceUrl);
  await form.domainsInput.fill(target.domains.join(', '));
  await form.saveButton.click();

  await expect(form.saveNotice).toContainText('Options not saved.');

  const stored = await optionsPage.evaluate(async () => chrome.storage.sync.get(['instanceUrl', 'domains']));
  expect(stored.instanceUrl || '').toBe('');
  expect(Array.isArray(stored.domains) ? stored.domains : []).toEqual([]);
});

test('syncs settings from the newest matching Jira attachment', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Jira attachment sync is covered against the mock Jira server.');

  const form = optionsPageModel(optionsPage);
  const settingsFileName = 'jira-quickview-settings.json';
  const settingsAttachmentId = 'jqv-settings-2';
  const syncedSettings = {
    schemaVersion: 1,
    settingsRevision: 2,
    settings: {
      instanceUrl: target.instanceUrl,
      domains: target.domains,
      hoverDepth: 'deep',
      hoverModifierKey: 'shift',
      displayFields: {
        labels: false,
        comments: true,
      },
    },
    policy: {
      instanceUrl: 'locked',
      domains: 'default',
      hoverDepth: 'locked',
      hoverModifierKey: 'locked',
      displayFields: 'locked',
    },
  };

  await configureExtension(optionsPage, baseConfig(servers, target, {
    hoverDepth: 'exact',
    hoverModifierKey: 'none',
  }));

  await patchJsonResponse(optionsPage.context(), target.instanceUrl, `/rest/api/2/issue/${target.primaryIssueKey}(?:\\?.*)?$`, payload => ({
    ...payload,
    fields: {
      ...(payload.fields || {}),
      attachment: [
        ...((payload.fields && payload.fields.attachment) || []),
        {
          id: settingsAttachmentId,
          filename: settingsFileName,
          created: '2026-04-10T12:00:00.000Z',
          mimeType: 'application/json',
          content: `${target.instanceUrl}/rest/api/2/attachment/content/${settingsAttachmentId}`,
        },
      ],
    },
  }));

  await optionsPage.context().route(buildJiraAttachmentContentDownloadUrl(target, settingsAttachmentId), async route => {
    await route.fulfill({
      status: 200,
      headers: {'content-type': 'application/json; charset=utf-8'},
      body: JSON.stringify(syncedSettings),
    });
  });

  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);

  await form.teamSyncIssueKeyInput.fill(target.primaryIssueKey);
  await form.teamSyncFileNameInput.fill(settingsFileName);
  await form.saveButton.click();

  await expect(form.saveNotice).toContainText('Options saved successfully.');
  await expect(form.hoverDepthSelect).toHaveValue('deep');
  await expect(form.hoverModifierSelect).toHaveValue('shift');

  const stored = await readStoredConfig(optionsPage);
  expect(stored.hoverDepth).toBe('deep');
  expect(stored.hoverModifierKey).toBe('shift');
  expect(stored.displayFields.labels).toBe(false);

  const syncStorage = await readSimpleSyncStorage(optionsPage);
  expect(syncStorage.lastRevision).toBe(2);
  expect(syncStorage.source.issueKey).toBe(target.primaryIssueKey);
});

test('exports the last synced revision and policy after Team Sync applies', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Team Sync export metadata is covered against the mock Jira server.');

  const form = optionsPageModel(optionsPage);
  const settingsFileName = 'jira-quickview-settings.json';
  const settingsAttachmentId = 'jqv-settings-export';
  const syncedSettings = {
    schemaVersion: 1,
    settingsRevision: 7,
    minimumExtensionVersion: CURRENT_EXTENSION_VERSION,
    policy: {
      instanceUrl: 'locked',
      domains: 'default',
      hoverDepth: 'locked',
      hoverModifierKey: 'locked',
      displayFields: 'default',
      themeMode: 'unmanaged',
      tooltipLayout: 'default',
      customFields: 'default',
    },
    settings: {
      instanceUrl: target.instanceUrl,
      domains: target.domains,
      hoverDepth: 'deep',
      hoverModifierKey: 'shift',
    },
  };

  await configureExtension(optionsPage, baseConfig(servers, target, {
    hoverDepth: 'exact',
    hoverModifierKey: 'none',
  }));

  await patchJsonResponse(optionsPage.context(), target.instanceUrl, `/rest/api/2/issue/${target.primaryIssueKey}(?:\\?.*)?$`, payload => ({
    ...payload,
    fields: {
      ...(payload.fields || {}),
      attachment: [
        ...((payload.fields && payload.fields.attachment) || []),
        {
          id: settingsAttachmentId,
          filename: settingsFileName,
          created: '2026-04-10T12:10:00.000Z',
          mimeType: 'application/json',
          content: `${target.instanceUrl}/rest/api/2/attachment/content/${settingsAttachmentId}`,
        },
      ],
    },
  }));

  await optionsPage.context().route(buildJiraAttachmentContentDownloadUrl(target, settingsAttachmentId), async route => {
    await route.fulfill({
      status: 200,
      headers: {'content-type': 'application/json; charset=utf-8'},
      body: JSON.stringify(syncedSettings),
    });
  });

  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);

  await form.teamSyncIssueKeyInput.fill(target.primaryIssueKey);
  await form.teamSyncFileNameInput.fill(settingsFileName);
  await form.saveButton.click();
  await expect(form.saveNotice).toContainText('Options saved successfully.');

  const downloadPromise = optionsPage.waitForEvent('download');
  await optionsPage.getByTestId('options-export-settings').click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();

  const exported = JSON.parse(await fs.readFile(downloadPath, 'utf8'));
  expect(exported.settingsRevision).toBe(7);
  expect(exported.minimumExtensionVersion).toBe(CURRENT_EXTENSION_VERSION);
  expect(exported.policy.hoverDepth).toBe('locked');
  expect(exported.settings.hoverDepth).toBe('deep');
});

test('matches Jira duplicate attachment names with GUID suffix and still picks the newest logical file', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Jira duplicate attachment naming is covered against the mock Jira server.');

  const form = optionsPageModel(optionsPage);
  const settingsFileName = 'jira-quickview-settings.json';
  const olderAttachmentId = 'jqv-settings-old';
  const newerAttachmentId = 'jqv-settings-guid';
  const olderSettings = {
    schemaVersion: 1,
    settingsRevision: 1,
    settings: {
      instanceUrl: target.instanceUrl,
      domains: target.domains,
      hoverDepth: 'shallow',
      hoverModifierKey: 'none',
    },
    policy: {
      instanceUrl: 'locked',
      domains: 'default',
      hoverDepth: 'locked',
      hoverModifierKey: 'locked',
    },
  };
  const newerSettings = {
    schemaVersion: 1,
    settingsRevision: 2,
    settings: {
      instanceUrl: target.instanceUrl,
      domains: target.domains,
      hoverDepth: 'deep',
      hoverModifierKey: 'shift',
    },
    policy: {
      instanceUrl: 'locked',
      domains: 'default',
      hoverDepth: 'locked',
      hoverModifierKey: 'locked',
    },
  };

  await configureExtension(optionsPage, baseConfig(servers, target, {
    hoverDepth: 'exact',
    hoverModifierKey: 'none',
  }));

  await patchJsonResponse(optionsPage.context(), target.instanceUrl, `/rest/api/2/issue/${target.primaryIssueKey}(?:\\?.*)?$`, payload => ({
    ...payload,
    fields: {
      ...(payload.fields || {}),
      attachment: [
        ...((payload.fields && payload.fields.attachment) || []),
        {
          id: olderAttachmentId,
          filename: settingsFileName,
          created: '2026-04-10T12:00:00.000Z',
          mimeType: 'application/json',
          content: `${target.instanceUrl}/rest/api/2/attachment/content/${olderAttachmentId}`,
        },
        {
          id: newerAttachmentId,
          filename: 'jira-quickview-settings (a785ec68-c65c-42f8-b458-2f087cc7cbb2).json',
          created: '2026-04-10T12:10:00.000Z',
          mimeType: 'application/json',
          content: `${target.instanceUrl}/rest/api/2/attachment/content/${newerAttachmentId}`,
        },
      ],
    },
  }));

  await optionsPage.context().route(buildJiraAttachmentContentDownloadUrl(target, olderAttachmentId), async route => {
    await route.fulfill({
      status: 200,
      headers: {'content-type': 'application/json; charset=utf-8'},
      body: JSON.stringify(olderSettings),
    });
  });

  await optionsPage.context().route(buildJiraAttachmentContentDownloadUrl(target, newerAttachmentId), async route => {
    await route.fulfill({
      status: 200,
      headers: {'content-type': 'application/json; charset=utf-8'},
      body: JSON.stringify(newerSettings),
    });
  });

  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);

  await form.teamSyncIssueKeyInput.fill(target.primaryIssueKey);
  await form.teamSyncFileNameInput.fill(settingsFileName);
  await form.saveButton.click();

  await expect(form.saveNotice).toContainText('Options saved successfully.');
  await expect(form.hoverDepthSelect).toHaveValue('deep');
  await expect(form.hoverModifierSelect).toHaveValue('shift');

  const syncStorage = await readSimpleSyncStorage(optionsPage);
  expect(syncStorage.lastRevision).toBe(2);
});

test('syncs settings from Jira attachment with redirect-free download', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Jira attachment redirect handling is covered against the mock Jira server.');

  const form = optionsPageModel(optionsPage);
  const settingsFileName = 'jira-quickview-settings.json';
  const settingsAttachmentId = 'jqv-settings-redirect';
  const syncedSettings = {
    schemaVersion: 1,
    settingsRevision: 3,
    settings: {
      instanceUrl: target.instanceUrl,
      domains: target.domains,
      hoverDepth: 'deep',
      hoverModifierKey: 'shift',
    },
    policy: {
      instanceUrl: 'locked',
      domains: 'default',
      hoverDepth: 'locked',
      hoverModifierKey: 'locked',
    },
  };

  await configureExtension(optionsPage, baseConfig(servers, target, {
    hoverDepth: 'exact',
    hoverModifierKey: 'none',
  }));

  await patchJsonResponse(optionsPage.context(), target.instanceUrl, `/rest/api/2/issue/${target.primaryIssueKey}(?:\\?.*)?$`, payload => ({
    ...payload,
    fields: {
      ...(payload.fields || {}),
      attachment: [
        ...((payload.fields && payload.fields.attachment) || []),
        {
          id: settingsAttachmentId,
          filename: settingsFileName,
          created: '2026-04-10T12:30:00.000Z',
          mimeType: 'application/json',
          content: `${target.instanceUrl}/rest/api/2/attachment/content/${settingsAttachmentId}`,
        },
      ],
    },
  }));

  await optionsPage.context().route(buildJiraAttachmentContentDownloadUrl(target, settingsAttachmentId), async route => {
    await route.fulfill({
      status: 200,
      headers: {'content-type': 'application/json; charset=utf-8'},
      body: JSON.stringify(syncedSettings),
    });
  });

  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);

  await form.teamSyncIssueKeyInput.fill(target.primaryIssueKey);
  await form.teamSyncFileNameInput.fill(settingsFileName);
  await form.saveButton.click();

  await expect(form.saveNotice).toContainText('Options saved successfully.');
  await expect(form.hoverDepthSelect).toHaveValue('deep');
  await expect(form.hoverModifierSelect).toHaveValue('shift');

  const stored = await readStoredConfig(optionsPage);
  expect(stored.hoverDepth).toBe('deep');
  expect(stored.hoverModifierKey).toBe('shift');

  const syncStorage = await readSimpleSyncStorage(optionsPage);
  expect(syncStorage.lastRevision).toBe(3);
  expect(syncStorage.source.issueKey).toBe(target.primaryIssueKey);
});

test('syncs settings from Jira attachment using the metadata content URL', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Jira attachment metadata URL handling is covered against the mock Jira server.');

  const form = optionsPageModel(optionsPage);
  const settingsFileName = 'jira-quickview-settings.json';
  const settingsAttachmentId = 'jqv-settings-server';
  const settingsContentUrl = `${String(target.instanceUrl).replace(/\/$/, '')}/secure/attachment/${settingsAttachmentId}/${settingsFileName}`;
  const syncedSettings = {
    schemaVersion: 1,
    settingsRevision: 4,
    settings: {
      instanceUrl: target.instanceUrl,
      domains: target.domains,
      hoverDepth: 'deep',
      hoverModifierKey: 'shift',
    },
    policy: {
      instanceUrl: 'locked',
      domains: 'default',
      hoverDepth: 'locked',
      hoverModifierKey: 'locked',
    },
  };

  await configureExtension(optionsPage, baseConfig(servers, target, {
    hoverDepth: 'exact',
    hoverModifierKey: 'none',
  }));

  await patchJsonResponse(optionsPage.context(), target.instanceUrl, `/rest/api/2/issue/${target.primaryIssueKey}(?:\\?.*)?$`, payload => ({
    ...payload,
    fields: {
      ...(payload.fields || {}),
      attachment: [
        ...((payload.fields && payload.fields.attachment) || []),
        {
          id: settingsAttachmentId,
          filename: settingsFileName,
          created: '2026-04-10T12:35:00.000Z',
          mimeType: 'application/json',
          content: settingsContentUrl,
        },
      ],
    },
  }));

  await optionsPage.context().route(settingsContentUrl, async route => {
    await route.fulfill({
      status: 200,
      headers: {'content-type': 'application/json; charset=utf-8'},
      body: JSON.stringify(syncedSettings),
    });
  });

  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);

  await form.teamSyncIssueKeyInput.fill(target.primaryIssueKey);
  await form.teamSyncFileNameInput.fill(settingsFileName);
  await form.saveButton.click();

  await expect(form.saveNotice).toContainText('Options saved successfully.');
  await expect(form.hoverDepthSelect).toHaveValue('deep');
  await expect(form.hoverModifierSelect).toHaveValue('shift');

  const syncStorage = await readSimpleSyncStorage(optionsPage);
  expect(syncStorage.lastRevision).toBe(4);
  expect(syncStorage.source.issueKey).toBe(target.primaryIssueKey);
});

test('shows a contextual error when the Jira attachment download fails', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Jira attachment redirect handling is covered against the mock Jira server.');

  const form = optionsPageModel(optionsPage);
  const settingsFileName = 'jira-quickview-settings.json';
  const settingsAttachmentId = 'jqv-settings-redirect-error';

  await configureExtension(optionsPage, baseConfig(servers, target));

  await patchJsonResponse(optionsPage.context(), target.instanceUrl, `/rest/api/2/issue/${target.primaryIssueKey}(?:\\?.*)?$`, payload => ({
    ...payload,
    fields: {
      ...(payload.fields || {}),
      attachment: [
        ...((payload.fields && payload.fields.attachment) || []),
        {
          id: settingsAttachmentId,
          filename: settingsFileName,
          created: '2026-04-10T12:40:00.000Z',
          mimeType: 'application/json',
          content: `${target.instanceUrl}/rest/api/2/attachment/content/${settingsAttachmentId}`,
        },
      ],
    },
  }));

  await optionsPage.context().route(buildJiraAttachmentContentDownloadUrl(target, settingsAttachmentId), async route => {
    await route.abort('failed');
  });

  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);

  await form.teamSyncIssueKeyInput.fill(target.primaryIssueKey);
  await form.teamSyncFileNameInput.fill(settingsFileName);
  await form.saveButton.click();

  await expect(form.saveNotice).toContainText('Options saved successfully.');
  await expect(form.teamSyncMessage).toContainText('Could not download the settings attachment from Jira.');
});

test('syncs settings from a direct URL source', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  const form = optionsPageModel(optionsPage);
  const settingsUrl = `${String(target.instanceUrl).replace(/\/?$/, '/')}files/jira-quickview-settings.json`;
  const syncedSettings = {
    schemaVersion: 1,
    settingsRevision: 3,
    settings: {
      instanceUrl: target.instanceUrl,
      domains: target.domains,
      hoverDepth: 'deep',
      hoverModifierKey: 'shift',
      displayFields: {
        labels: false,
      },
    },
    policy: {
      instanceUrl: 'locked',
      domains: 'default',
      hoverDepth: 'locked',
      hoverModifierKey: 'locked',
      displayFields: 'locked',
    },
  };

  await configureExtension(optionsPage, baseConfig(servers, target, {
    hoverDepth: 'exact',
    hoverModifierKey: 'none',
  }));

  await optionsPage.context().route(settingsUrl, async route => {
    await route.fulfill({
      status: 200,
      headers: {'content-type': 'application/json; charset=utf-8'},
      body: JSON.stringify(syncedSettings),
    });
  });

  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);

  await form.teamSyncSourceTypeSelect.selectOption('url');
  await form.teamSyncUrlInput.fill(settingsUrl);
  await form.saveButton.click();

  await expect(form.saveNotice).toContainText('Options saved successfully.');
  await expect(form.hoverDepthSelect).toHaveValue('deep');
  await expect(form.hoverModifierSelect).toHaveValue('shift');

  const stored = await readStoredConfig(optionsPage);
  expect(stored.hoverDepth).toBe('deep');
  expect(stored.hoverModifierKey).toBe('shift');
  expect(stored.displayFields.labels).toBe(false);

  const syncStorage = await readSimpleSyncStorage(optionsPage);
  expect(syncStorage.sourceType).toBe('url');
  expect(syncStorage.source.url).toBe(settingsUrl);
  expect(syncStorage.lastRevision).toBe(3);
});

test('keeps the last synced config when the settings URL is invalid', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  const form = optionsPageModel(optionsPage);
  const validSettingsUrl = `${String(target.instanceUrl).replace(/\/?$/, '/')}files/jira-quickview-settings.json`;
  const missingSettingsUrl = `${String(target.instanceUrl).replace(/\/?$/, '/')}files/missing-settings.json`;
  const syncedSettings = {
    schemaVersion: 1,
    settingsRevision: 3,
    settings: {
      instanceUrl: target.instanceUrl,
      domains: target.domains,
      hoverDepth: 'deep',
      hoverModifierKey: 'shift',
    },
    policy: {
      instanceUrl: 'locked',
      domains: 'default',
      hoverDepth: 'locked',
      hoverModifierKey: 'locked',
    },
  };

  await configureExtension(optionsPage, baseConfig(servers, target, {
    hoverDepth: 'exact',
    hoverModifierKey: 'none',
  }));

  await optionsPage.context().route(validSettingsUrl, async route => {
    await route.fulfill({
      status: 200,
      headers: {'content-type': 'application/json; charset=utf-8'},
      body: JSON.stringify(syncedSettings),
    });
  });

  await optionsPage.context().route(missingSettingsUrl, async route => {
    await route.fulfill({
      status: 404,
      headers: {'content-type': 'text/plain; charset=utf-8'},
      body: 'Not found',
    });
  });

  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);

  await form.teamSyncSourceTypeSelect.selectOption('url');
  await form.teamSyncUrlInput.fill(validSettingsUrl);
  await form.saveButton.click();
  await expect(form.saveNotice).toContainText('Options saved successfully.');

  await form.teamSyncUrlInput.fill(missingSettingsUrl);
  await form.saveButton.click();

  await expect(form.saveNotice).toContainText('Options saved successfully.');
  await expect(form.teamSyncMessage).toContainText('HTTP 404');
  await expect(form.hoverDepthSelect).toHaveValue('deep');
  await expect(form.hoverModifierSelect).toHaveValue('shift');

  const stored = await readStoredConfig(optionsPage);
  expect(stored.hoverDepth).toBe('deep');
  expect(stored.hoverModifierKey).toBe('shift');

  const syncStorage = await readSimpleSyncStorage(optionsPage);
  expect(syncStorage.status).toBe('error');
  expect(syncStorage.lastRevision).toBe(3);
  expect(syncStorage.source.url).toBe(missingSettingsUrl);
});

test('keeps the last synced config when the Jira issue key is invalid', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Jira attachment sync failure handling is covered against the mock Jira server.');

  const form = optionsPageModel(optionsPage);
  const settingsFileName = 'jira-quickview-settings.json';
  const settingsAttachmentId = 'jqv-settings-valid';
  const invalidIssueKey = 'OPS-404';
  const syncedSettings = {
    schemaVersion: 1,
    settingsRevision: 2,
    settings: {
      instanceUrl: target.instanceUrl,
      domains: target.domains,
      hoverDepth: 'deep',
      hoverModifierKey: 'shift',
    },
    policy: {
      instanceUrl: 'locked',
      domains: 'default',
      hoverDepth: 'locked',
      hoverModifierKey: 'locked',
    },
  };

  await configureExtension(optionsPage, baseConfig(servers, target, {
    hoverDepth: 'exact',
    hoverModifierKey: 'none',
  }));

  await patchJsonResponse(optionsPage.context(), target.instanceUrl, `/rest/api/2/issue/${target.primaryIssueKey}(?:\\?.*)?$`, payload => ({
    ...payload,
    fields: {
      ...(payload.fields || {}),
      attachment: [
        ...((payload.fields && payload.fields.attachment) || []),
        {
          id: settingsAttachmentId,
          filename: settingsFileName,
          created: '2026-04-10T12:00:00.000Z',
          mimeType: 'application/json',
          content: `${target.instanceUrl}/rest/api/2/attachment/content/${settingsAttachmentId}`,
        },
      ],
    },
  }));

  await optionsPage.context().route(buildJiraAttachmentContentDownloadUrl(target, settingsAttachmentId), async route => {
    await route.fulfill({
      status: 200,
      headers: {'content-type': 'application/json; charset=utf-8'},
      body: JSON.stringify(syncedSettings),
    });
  });

  await failWithJson(
    optionsPage.context(),
    target.instanceUrl,
    `/rest/api/2/issue/${invalidIssueKey}(?:\\?.*)?$`,
    404,
    {errorMessages: ['Issue does not exist']}
  );

  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);

  await form.teamSyncIssueKeyInput.fill(target.primaryIssueKey);
  await form.teamSyncFileNameInput.fill(settingsFileName);
  await form.saveButton.click();
  await expect(form.saveNotice).toContainText('Options saved successfully.');

  await form.teamSyncIssueKeyInput.fill(invalidIssueKey);
  await form.saveButton.click();

  await expect(form.saveNotice).toContainText('Options saved successfully.');
  await expect(form.teamSyncMessage).toContainText(`Could not find Jira issue ${invalidIssueKey}.`);
  await expect(form.hoverDepthSelect).toHaveValue('deep');
  await expect(form.hoverModifierSelect).toHaveValue('shift');

  const stored = await readStoredConfig(optionsPage);
  expect(stored.hoverDepth).toBe('deep');
  expect(stored.hoverModifierKey).toBe('shift');

  const syncStorage = await readSimpleSyncStorage(optionsPage);
  expect(syncStorage.status).toBe('error');
  expect(syncStorage.lastRevision).toBe(2);
  expect(syncStorage.source.issueKey).toBe(invalidIssueKey);
});

test('keeps the last synced config when the settings file is corrupted', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Jira attachment sync failure handling is covered against the mock Jira server.');

  const form = optionsPageModel(optionsPage);
  const settingsFileName = 'jira-quickview-settings.json';
  const validAttachmentId = 'jqv-settings-valid';
  const brokenAttachmentId = 'jqv-settings-broken';
  const validSettings = {
    schemaVersion: 1,
    settingsRevision: 2,
    settings: {
      instanceUrl: target.instanceUrl,
      domains: target.domains,
      hoverDepth: 'deep',
      hoverModifierKey: 'shift',
    },
    policy: {
      instanceUrl: 'locked',
      domains: 'default',
      hoverDepth: 'locked',
      hoverModifierKey: 'locked',
    },
  };

  await configureExtension(optionsPage, baseConfig(servers, target, {
    hoverDepth: 'exact',
    hoverModifierKey: 'none',
  }));

  await patchJsonResponse(optionsPage.context(), target.instanceUrl, `/rest/api/2/issue/${target.primaryIssueKey}(?:\\?.*)?$`, payload => ({
    ...payload,
    fields: {
      ...(payload.fields || {}),
      attachment: [
        ...((payload.fields && payload.fields.attachment) || []),
        {
          id: validAttachmentId,
          filename: settingsFileName,
          created: '2026-04-10T12:00:00.000Z',
          mimeType: 'application/json',
          content: `${target.instanceUrl}/rest/api/2/attachment/content/${validAttachmentId}`,
        },
      ],
    },
  }));

  await optionsPage.context().route(buildJiraAttachmentContentDownloadUrl(target, validAttachmentId), async route => {
    await route.fulfill({
      status: 200,
      headers: {'content-type': 'application/json; charset=utf-8'},
      body: JSON.stringify(validSettings),
    });
  });

  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);

  await form.teamSyncIssueKeyInput.fill(target.primaryIssueKey);
  await form.teamSyncFileNameInput.fill(settingsFileName);
  await form.saveButton.click();
  await expect(form.saveNotice).toContainText('Options saved successfully.');

  await patchJsonResponse(optionsPage.context(), target.instanceUrl, `/rest/api/2/issue/${target.primaryIssueKey}(?:\\?.*)?$`, payload => ({
    ...payload,
    fields: {
      ...(payload.fields || {}),
      attachment: [
        {
          id: brokenAttachmentId,
          filename: settingsFileName,
          created: '2026-04-10T13:00:00.000Z',
          mimeType: 'application/json',
          content: `${target.instanceUrl}/rest/api/2/attachment/content/${brokenAttachmentId}`,
        },
        ...((payload.fields && payload.fields.attachment) || []),
      ],
    },
  }));

  await optionsPage.context().route(buildJiraAttachmentContentDownloadUrl(target, brokenAttachmentId), async route => {
    await route.fulfill({
      status: 200,
      headers: {'content-type': 'application/json; charset=utf-8'},
      body: JSON.stringify({
        schemaVersion: 1,
        settings: {
          hoverDepth: 'exact',
        },
      }),
    });
  });

  await form.teamSyncNowButton.click();

  await expect(form.teamSyncMessage).toContainText('top-level "settingsRevision" number such as 1, 2, or 3');
  await expect(form.hoverDepthSelect).toHaveValue('deep');
  await expect(form.hoverModifierSelect).toHaveValue('shift');

  const stored = await readStoredConfig(optionsPage);
  expect(stored.hoverDepth).toBe('deep');
  expect(stored.hoverModifierKey).toBe('shift');

  const syncStorage = await readSimpleSyncStorage(optionsPage);
  expect(syncStorage.status).toBe('error');
  expect(syncStorage.lastRevision).toBe(2);
});
