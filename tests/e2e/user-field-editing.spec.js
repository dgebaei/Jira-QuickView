const {test, expect, configureExtension, hoverIssueKey, injectContentScript} = require('./helpers/extension-fixtures');
const {buildExtensionConfig, requireJiraTestTarget, replaceIssueKeysOnPage, resolveTargetIssueKeys} = require('./helpers/test-targets');

function baseConfig(servers, target, overrides = {}) {
  return buildExtensionConfig(servers, {
    customFields: [{fieldId: 'customfield_67890', row: 2}],
    ...overrides,
  }, target);
}

async function openPopup(extensionApp, servers, target, route = '/popup-actions') {
  const resolvedTarget = await resolveTargetIssueKeys(target);
  const page = await extensionApp.context.newPage();
  await page.goto(`${servers.allowedPage.origin}${route}`);
  await replaceIssueKeysOnPage(page, [
    {from: 'JRACLOUD-97846', to: resolvedTarget.primaryIssueKey},
    {from: 'JRACLOUD-98123', to: resolvedTarget.secondaryIssueKey},
  ]);
  await injectContentScript(extensionApp, page);
  await expect.poll(async () => page.locator('._JX_container').count()).toBe(1);
  await hoverIssueKey(page, '#popup-key');
  await expect(page.locator('._JX_container')).toContainText(resolvedTarget.primaryIssueKey);
  return {page, target: resolvedTarget};
}

async function waitForOptions(locator, minimumCount = 1) {
  await expect.poll(async () => locator.count(), {timeout: 10000}).toBeGreaterThanOrEqual(minimumCount);
  return locator.count();
}

test('renders user-type custom field and allows editing via user search', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('editable');
  }
  await configureExtension(optionsPage, baseConfig(servers, target, {
    customFields: [{fieldId: 'customfield_12345', row: 2}, {fieldId: 'customfield_67890', row: 2}],
  }));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = page.locator('._JX_container');

  // Verify the user custom field renders with the user's displayName
  await expect(popup).toContainText('Reviewer: Alex Reviewer');

  // Open the editor for the user custom field
  const editButton = popup.locator('._JX_field_chip_edit[data-field-key="customfield_67890"]');
  await expect(editButton).toHaveCount(1);
  await editButton.click();

  // Verify the user-search editor popover opens
  const input = popup.locator('._JX_edit_input[data-field-key="customfield_67890"]');
  await expect(input).toBeVisible();

  // Search for a different user
  await input.fill('Morgan');
  const options = popup.locator('._JX_edit_option[data-field-key="customfield_67890"]');
  await waitForOptions(options);

  // Find and click the Morgan Agent option, then press Enter to save
  const morganOption = options.filter({hasText: 'Morgan Agent'});
  await expect(morganOption).toHaveCount(1);
  await morganOption.click();
  await input.press('Enter');

  // Wait for save to complete and verify the chip updated
  await expect(popup).toContainText('Reviewer: Morgan Agent');
  await page.close();
});

test('shows empty user custom field as editable placeholder chip', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('empty-user-field');
  }
  await configureExtension(optionsPage, baseConfig(servers, target, {
    customFields: [{fieldId: 'customfield_67890', row: 2}],
  }));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = page.locator('._JX_container');

  // Verify the empty field shows placeholder chip
  await expect(popup).toContainText('Reviewer: --');

  // Verify the edit button is present
  const editButton = popup.locator('._JX_field_chip_edit[data-field-key="customfield_67890"]');
  await expect(editButton).toHaveCount(1);

  // Open editor and search for a user
  await editButton.click();
  const input = popup.locator('._JX_edit_input[data-field-key="customfield_67890"]');
  await expect(input).toBeVisible();
  await input.fill('Alex');
  const options = popup.locator('._JX_edit_option[data-field-key="customfield_67890"]');
  await waitForOptions(options);

  // Select the user and press Enter to save
  const alexOption = options.filter({hasText: 'Alex Reviewer'});
  await expect(alexOption).toHaveCount(1);
  await alexOption.click();
  await input.press('Enter');

  // Verify save succeeded
  await expect(popup).toContainText('Reviewer: Alex Reviewer');
  await page.close();
});
