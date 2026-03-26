const {test, expect, configureExtension} = require('./helpers/extension-fixtures');
const {getFirstCustomFieldId} = require('./helpers/live-jira-api');
const {optionsPageModel} = require('./helpers/options-page');
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

test.skip('validates custom field ids and resolves their names from Jira metadata', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  await configureExtension(optionsPage, baseConfig(servers, target));
  await optionsPage.reload();

  const showButton = optionsPage.getByRole('button', {name: 'Show'});
  if (await showButton.isVisible().catch(() => false)) {
    await showButton.click();
  }

  await optionsPage.getByRole('button', {name: 'Add field'}).first().click();
  const row = optionsPage.locator('.customFieldRow').first();

  await row.locator('input[placeholder="customfield_12345"]').fill('impact');
  await expect(row.getByText('Use a Jira custom field ID in the form customfield_12345.')).toBeVisible();
  await expect(optionsPage.getByRole('button', {name: 'Save'})).toBeDisabled();

  const customFieldId = target.mode === 'mock' ? 'customfield_12345' : await getFirstCustomFieldId(target);
  test.skip(!customFieldId, 'No Jira custom field is available for metadata resolution.');
  await row.locator('input[placeholder="customfield_12345"]').fill(customFieldId);
  await expect(row.locator('.customFieldMeta')).toContainText(/Resolved field name:|Waiting for Jira field metadata\./);
  await expect(optionsPage.getByRole('button', {name: 'Save'})).toBeEnabled();
});

test.skip('persists hover behavior and layout settings through the options page', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  const customFieldId = target.mode === 'mock' ? 'customfield_12345' : await getFirstCustomFieldId(target);
  test.skip(!customFieldId, 'No Jira custom field is available for options persistence coverage.');
  await configureExtension(optionsPage, baseConfig(servers, target));
  await optionsPage.reload();

  const showButton = optionsPage.getByRole('button', {name: 'Show'});
  if (await showButton.isVisible().catch(() => false)) {
    await showButton.click();
  }

  await configureExtension(optionsPage, {
    ...baseConfig(servers, target),
    hoverDepth: 'deep',
    hoverModifierKey: 'shift',
    displayFields: {
      comments: false,
      pullRequests: false,
    },
    customFields: [{fieldId: customFieldId, row: 2}],
  });

  await optionsPage.reload();

  const showButton2 = optionsPage.getByRole('button', {name: 'Show'});
  if (await showButton2.isVisible().catch(() => false)) {
    await showButton2.click();
  }

  await expect(optionsPage.getByLabel('Trigger depth')).toHaveValue('deep');
  await expect(optionsPage.getByLabel('Modifier key')).toHaveValue('shift');
  await expect(optionsPage.locator('#displayField_comments')).not.toBeChecked();
  await expect(optionsPage.locator('#displayField_pullRequests')).not.toBeChecked();
  await expect(optionsPage.locator('.customFieldRow').first().locator('input[placeholder="customfield_12345"]')).toHaveValue(customFieldId);
});
