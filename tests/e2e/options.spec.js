const {test, expect, configureExtension} = require('./helpers/extension-fixtures');
const {getFirstCustomFieldId} = require('./helpers/live-jira-api');
const {customFieldLibraryItem, openAdvancedSettings, optionsPageModel} = require('./helpers/options-page');
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

  const customFieldId = target.mode === 'mock' ? 'customfield_12345' : await getFirstCustomFieldId(target);
  test.skip(!customFieldId, 'No Jira custom field is available for metadata resolution.');
  await form.fieldLibraryInput.fill(customFieldId);
  await expect(form.fieldLibraryValidation).toContainText(target.mode === 'mock' ? 'Customer Impact' : /\S+/);
  await expect(form.fieldLibrarySaveButton).toBeEnabled();

  await form.fieldLibrarySaveButton.click();
  await expect(customFieldLibraryItem(optionsPage, customFieldId)).toContainText(target.mode === 'mock' ? 'Customer Impact' : customFieldId);
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
