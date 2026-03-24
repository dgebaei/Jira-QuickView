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
  await optionsPage.getByRole('button', {name: 'Save'}).click();
  await expect(optionsPage.locator('.saveNotice')).toContainText('You must provide your Jira instance URL.');
});

test.skip('validates custom field ids and resolves their names from Jira metadata', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  await configureExtension(optionsPage, baseConfig(servers, target));
  await optionsPage.reload();

  await optionsPage.locator('.advToggleBtn').click();
  await optionsPage.locator('.advToggleBtn[aria-expanded="true"]').waitFor();
  await optionsPage.locator('.fieldLibraryAddBtn').click();
  const fieldInput = optionsPage.locator('.fieldLibraryInput');

  await fieldInput.fill('impact');
  await expect(optionsPage.locator('.fieldLibraryValidation')).toContainText('Use a Jira custom field ID in the form customfield_12345.');
  await expect(optionsPage.locator('.fieldLibrarySave')).toBeDisabled();

  const customFieldId = target.mode === 'mock' ? 'customfield_12345' : await getFirstCustomFieldId(target);
  test.skip(!customFieldId, 'No Jira custom field is available for metadata resolution.');
  await fieldInput.fill(customFieldId);
  await expect(optionsPage.locator('.fieldLibraryValidation')).toContainText(/Resolved:|Waiting for Jira field metadata\./);
  await expect(optionsPage.locator('.fieldLibrarySave')).toBeEnabled();
});

test.skip('persists hover behavior and layout settings through the options page', async ({optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  const customFieldId = target.mode === 'mock' ? 'customfield_12345' : await getFirstCustomFieldId(target);
  test.skip(!customFieldId, 'No Jira custom field is available for options persistence coverage.');

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

  // Hover settings are behind the Advanced toggle; expand it before asserting
  await optionsPage.locator('.advToggleBtn').click();
  await optionsPage.locator('.advToggleBtn[aria-expanded="true"]').waitFor();
  await expect(optionsPage.getByLabel('Trigger depth')).toHaveValue('deep');
  await expect(optionsPage.getByLabel('Modifier key')).toHaveValue('shift');

  // displayFields and customFields are configured via storage (drag-and-drop
  // UI), so verify them through chrome.storage instead of DOM selectors.
  const stored = await optionsPage.evaluate(() => {
    return new Promise(resolve => chrome.storage.sync.get(['displayFields', 'customFields'], resolve));
  });
  expect(stored.displayFields.comments).toBe(false);
  expect(stored.displayFields.pullRequests).toBe(false);
  expect(stored.customFields[0].fieldId).toBe(customFieldId);
});
