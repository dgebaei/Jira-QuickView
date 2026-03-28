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
  await expect.poll(async () => locator.count(), {timeout: 20000}).toBeGreaterThanOrEqual(minimumCount);
  return locator.count();
}

async function selectUserOptionAndSubmit(popup, fieldKey, optionText) {
  const options = popup.locator(`._JX_edit_option[data-field-key="${fieldKey}"]`);
  const matchingOption = options.filter({hasText: optionText});
  const editPopover = popup.locator(`._JX_edit_popover[data-field-key="${fieldKey}"]`);
  await waitForOptions(options);
  await expect(matchingOption).toHaveCount(1);
  await matchingOption.click();

  const input = popup.locator(`._JX_edit_input[data-field-key="${fieldKey}"]`);
  await expect(input).toHaveValue(optionText);
  await expect(matchingOption).toHaveClass(/is-selected/);
  await expect(editPopover).not.toContainText('Searching');
  await input.press('Enter');
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
  await expect(popup).toContainText('Reviewer: Alex Reviewer');

  const editButton = popup.locator('._JX_field_chip_edit[data-field-key="customfield_67890"]');
  await expect(editButton).toHaveCount(1);
  await editButton.click();

  const input = popup.locator('._JX_edit_input[data-field-key="customfield_67890"]');
  await expect(input).toBeVisible();
  await input.fill('Morgan');
  await selectUserOptionAndSubmit(popup, 'customfield_67890', 'Morgan Agent');

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
  await expect(popup).toContainText('Reviewer: --');

  const editButton = popup.locator('._JX_field_chip_edit[data-field-key="customfield_67890"]');
  await expect(editButton).toHaveCount(1);
  await editButton.click();

  const input = popup.locator('._JX_edit_input[data-field-key="customfield_67890"]');
  await expect(input).toBeVisible();
  await input.fill('Alex');
  await selectUserOptionAndSubmit(popup, 'customfield_67890', 'Alex Reviewer');

  await expect(popup).toContainText('Reviewer: Alex Reviewer');
  await page.close();
});
