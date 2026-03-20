const {test, expect, configureExtension} = require('./helpers/extension-fixtures');
const {getFirstCustomFieldId} = require('./helpers/live-jira-api');
const {buildExtensionConfig, requireJiraTestTarget} = require('./helpers/test-targets');

function baseConfig(servers, target, overrides = {}) {
  return {
    ...buildExtensionConfig(servers, {}, target),
    customFields: [],
    ...overrides,
  };
}

test('shows validation for an empty Jira instance URL', async ({optionsPage}) => {
  await optionsPage.getByLabel('Jira instance URL').fill('');
  await optionsPage.getByRole('button', {name: 'Save changes'}).click();
  await expect(optionsPage.locator('.saveNotice')).toContainText('You must provide your Jira instance URL.');
});

test('validates custom field ids and resolves their names from Jira metadata', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  await configureExtension(optionsPage, baseConfig(servers, target), true);
  await expect(optionsPage.locator('.saveNotice')).toContainText('Options saved successfully.');
  await optionsPage.reload();

  await optionsPage.getByRole('button', {name: 'Add another field'}).click();
  const row = optionsPage.locator('.customFieldRow').first();

  await row.getByLabel('Field ID').fill('impact');
  await expect(row.getByText('Use a Jira custom field ID in the form customfield_12345.')).toBeVisible();
  await expect(optionsPage.getByRole('button', {name: 'Save changes'})).toBeDisabled();

  const customFieldId = target.mode === 'mock' ? 'customfield_12345' : await getFirstCustomFieldId(target);
  test.skip(!customFieldId, 'No Jira custom field is available for metadata resolution.');
  await row.getByLabel('Field ID').fill(customFieldId);
  await expect(row.locator('.customFieldMeta')).toContainText(/Resolved field name:|Waiting for Jira field metadata\./);
  await expect(optionsPage.getByRole('button', {name: 'Save changes'})).toBeEnabled();
});

test('persists hover behavior and layout settings through the options page', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  const customFieldId = target.mode === 'mock' ? 'customfield_12345' : await getFirstCustomFieldId(target);
  test.skip(!customFieldId, 'No Jira custom field is available for options persistence coverage.');
  await configureExtension(optionsPage, baseConfig(servers, target), true);
  await expect(optionsPage.locator('.saveNotice')).toContainText('Options saved successfully.');
  await optionsPage.reload();

  await configureExtension(optionsPage, {
    ...baseConfig(servers, target),
    hoverDepth: 'deep',
    hoverModifierKey: 'shift',
    displayFields: {
      comments: false,
      pullRequests: false,
    },
    customFields: [{fieldId: customFieldId, row: 2}],
  }, true);

  await expect(optionsPage.locator('.saveNotice')).toContainText('Options saved successfully.');
  await optionsPage.reload();

  await expect(optionsPage.getByLabel('Trigger depth')).toHaveValue('deep');
  await expect(optionsPage.getByLabel('Modifier key')).toHaveValue('shift');
  await expect(optionsPage.locator('#displayField_comments')).not.toBeChecked();
  await expect(optionsPage.locator('#displayField_pullRequests')).not.toBeChecked();
  await expect(optionsPage.locator('.customFieldRow').first().getByLabel('Field ID')).toHaveValue(customFieldId);
});

test('shows an error when optional host permissions are denied', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  await configureExtension(optionsPage, baseConfig(servers, target), false);
  await expect(optionsPage.locator('.saveNotice')).toContainText('Options not saved.');
});
