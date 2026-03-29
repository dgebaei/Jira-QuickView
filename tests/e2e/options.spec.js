const fs = require('fs/promises');
const {test, expect, configureExtension} = require('./helpers/extension-fixtures');
const {getFirstCustomFieldId, getFirstSupportedCustomField} = require('./helpers/live-jira-api');
const {contentBlockItem, customFieldLibraryItem, openAdvancedSettings, optionsPageModel} = require('./helpers/options-page');
const {buildExtensionConfig, requireJiraTestTarget} = require('./helpers/test-targets');

function baseConfig(servers, target, overrides = {}) {
  return {
    ...buildExtensionConfig(servers, {}, target),
    customFields: [],
    ...overrides,
  };
}

test('shows validation for an empty Jira instance URL', async ({optionsPage}) => {
  const form = optionsPageModel(optionsPage);
  await form.instanceUrlInput.fill('');
  await form.saveButton.click();
  await expect(form.saveNotice).toContainText('You must provide your Jira instance URL.');
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

test('validates custom field ids and resolves their names from Jira metadata', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  const form = optionsPageModel(optionsPage);
  await configureExtension(optionsPage, baseConfig(servers, target));
  await optionsPage.reload();
  await openAdvancedSettings(optionsPage);

  await form.fieldLibraryAddButton.click();

  await form.fieldLibraryInput.fill('impact');
  await expect(form.fieldLibraryValidation).toContainText('Format: customfield_12345');
  await expect(form.fieldLibrarySaveButton).toBeDisabled();

  await form.fieldLibraryInput.fill('customfield_99999');
  await expect(form.fieldLibraryValidation).toContainText('Not found in Jira');
  await expect(form.fieldLibrarySaveButton).toBeDisabled();

  const liveCustomField = target.mode === 'mock' ? null : await getFirstSupportedCustomField(target);
  const customFieldId = target.mode === 'mock' ? 'customfield_12345' : liveCustomField?.id;
  test.skip(!customFieldId, 'No Jira custom field is available for metadata resolution.');
  await form.fieldLibraryInput.fill(customFieldId);
  await expect(form.fieldLibraryValidation).toContainText(target.mode === 'mock' ? 'Customer Impact' : (liveCustomField?.name || /\S+/));
  await expect(form.fieldLibrarySaveButton).toBeEnabled();

  await form.fieldLibrarySaveButton.click();
  if (target.mode === 'mock') {
    await expect(customFieldLibraryItem(optionsPage, customFieldId)).toContainText('Customer Impact');
  } else {
    await expect(customFieldLibraryItem(optionsPage, customFieldId)).toBeVisible();
    await expect(customFieldLibraryItem(optionsPage, customFieldId)).toContainText(liveCustomField?.name || customFieldId);
  }
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
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();

  const exported = JSON.parse(await fs.readFile(downloadPath, 'utf8'));
  expect(exported.instanceUrl).toBe('https://example.atlassian.net/');
  expect(exported.hoverDepth).toBe('deep');
  expect(exported.hoverModifierKey).toBe('shift');
  expect(exported.tooltipLayout.contentBlocks).toContain('pullRequests');
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
