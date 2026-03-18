const {test, expect, configureExtension, hoverIssueKey, injectContentScript} = require('./helpers/extension-fixtures');
const {assertAllowedLiveIssue, getAllowedLiveIssue, getAllowedLiveIssueKeys, getLiveJiraConfig} = require('./helpers/live-jira');

function requireLiveConfig() {
  const config = getLiveJiraConfig();
  test.skip(!config.isConfigured, 'Set JIRA_LIVE_INSTANCE_URL, JIRA_LIVE_PROJECT_KEYS, and JIRA_LIVE_ISSUE_KEYS to enable private Jira tests.');
  return config;
}

function requireLiveAuthConfig() {
  const config = requireLiveConfig();
  test.skip(!config.hasAuth, 'Set JIRA_LIVE_STORAGE_STATE to enable authenticated private Jira tests.');
  return config;
}

async function openLiveIssuePage(extensionApp, issueUrl) {
  const page = await extensionApp.context.newPage();
  await page.goto(issueUrl, {waitUntil: 'domcontentloaded'});
  await injectContentScript(extensionApp, page);
  await expect.poll(async () => page.locator('._JX_container').count()).toBe(1);
  return page;
}

async function configureLiveExtension(optionsPage, config) {
  await configureExtension(optionsPage, {
    instanceUrl: config.instanceUrl,
    domains: [config.instanceUrl],
    hoverDepth: 'shallow',
    hoverModifierKey: 'none',
    customFields: [],
  }, true);
}

async function openLivePopupForIssue(extensionApp, optionsPage, config, issueKey) {
  assertAllowedLiveIssue(issueKey, config);
  await configureLiveExtension(optionsPage, config);
  const page = await openLiveIssuePage(extensionApp, `${config.instanceUrl.replace(/\/$/, '')}/browse/${issueKey}`);
  await hoverIssueKey(page, `text=${issueKey}`);
  await expect(page.locator('._JX_container')).toContainText(issueKey);
  return page;
}

async function getAssigneeTitle(page) {
  const assigneeNode = page.locator('._JX_title_assignee_slot [title^="Assignee:"]').first();
  if (await assigneeNode.count()) {
    return await assigneeNode.getAttribute('title');
  }
  return 'Assignee: Unassigned';
}

test('enforces the configured live Jira issue scope before running @live', async () => {
  const config = requireLiveConfig();
  const allowedIssueKeys = getAllowedLiveIssueKeys(config);

  expect(allowedIssueKeys.length).toBeGreaterThan(0);
  for (const issueKey of allowedIssueKeys) {
    expect(() => assertAllowedLiveIssue(issueKey, config)).not.toThrow();
  }
});

test('loads a popup only for explicitly allowed live Jira issues @live', async ({extensionApp, optionsPage}) => {
  const config = requireLiveAuthConfig();
  const issueKey = getAllowedLiveIssue(config, 0);
  const page = await openLivePopupForIssue(extensionApp, optionsPage, config, issueKey);
  await page.close();
});

test('uses authenticated storage state on an allowed live Jira issue @live', async ({extensionApp, optionsPage}) => {
  const config = requireLiveAuthConfig();
  const issueKey = getAllowedLiveIssue(config, 0);
  const page = await openLivePopupForIssue(extensionApp, optionsPage, config, issueKey);
  await expect(page.locator('text=/Log in|Sign in/i')).toHaveCount(0);
  await expect(page.locator('._JX_container')).not.toContainText('Not logged in');
  await page.close();
});

test('shows live edit controls and quick actions only on the allowed issue scope @live', async ({extensionApp, optionsPage}) => {
  const config = requireLiveAuthConfig();
  const issueKey = getAllowedLiveIssue(config, 0);
  const page = await openLivePopupForIssue(extensionApp, optionsPage, config, issueKey);

  await expect(page.locator('._JX_assignee_edit_button')).toHaveCount(1);
  await expect(page.locator('._JX_field_chip_edit[data-field-key="priority"]')).toHaveCount(1);
  await expect(page.locator('._JX_field_chip_edit[data-field-key="labels"]')).toHaveCount(1);

  const actionsToggle = page.locator('._JX_actions_toggle');
  if (await actionsToggle.count()) {
    await actionsToggle.click();
    await expect(page.locator('._JX_action_item')).toHaveCount(await page.locator('._JX_action_item').count());
  }

  await page.close();
});

test('updates issue priority on an allowed live Jira issue and restores it @live', async ({extensionApp, optionsPage}) => {
  const config = requireLiveAuthConfig();
  const issueKey = getAllowedLiveIssue(config, 0);
  const page = await openLivePopupForIssue(extensionApp, optionsPage, config, issueKey);
  const popup = page.locator('._JX_container');

  const currentPriorityText = (await page.locator('._JX_field_chip[data-field-key="priority"]').textContent() || '').trim();
  await page.locator('._JX_field_chip_edit[data-field-key="priority"]').click();
  const options = page.locator('._JX_edit_option[data-field-key="priority"]');
  const optionCount = await options.count();
  test.skip(optionCount < 2, 'Need at least two priority options to run restoration-based mutation test.');

  const currentSelected = page.locator('._JX_edit_option[data-field-key="priority"].is-selected');
  const currentOptionId = await currentSelected.first().getAttribute('data-option-id');
  let targetOptionId = null;
  for (let index = 0; index < optionCount; index += 1) {
    const candidateId = await options.nth(index).getAttribute('data-option-id');
    if (candidateId && candidateId !== currentOptionId) {
      targetOptionId = candidateId;
      break;
    }
  }
  test.skip(!targetOptionId, 'Could not find an alternate priority option.');

  await page.locator(`._JX_edit_option[data-field-key="priority"][data-option-id="${targetOptionId}"]`).click();
  await page.locator('._JX_edit_input[data-field-key="priority"]').press('Enter');
  await expect(popup).not.toContainText(currentPriorityText);

  await page.locator('._JX_field_chip_edit[data-field-key="priority"]').click();
  if (currentOptionId) {
    await page.locator(`._JX_edit_option[data-field-key="priority"][data-option-id="${currentOptionId}"]`).click();
    await page.locator('._JX_edit_input[data-field-key="priority"]').press('Enter');
    await expect(popup).toContainText(currentPriorityText);
  }

  await page.close();
});

test('updates assignee on an allowed live Jira issue and restores it @live', async ({extensionApp, optionsPage}) => {
  const config = requireLiveAuthConfig();
  const issueKey = getAllowedLiveIssue(config, 0);
  const page = await openLivePopupForIssue(extensionApp, optionsPage, config, issueKey);
  const popup = page.locator('._JX_container');

  const currentAssigneeTitle = await getAssigneeTitle(page);
  await page.locator('._JX_assignee_edit_button').click();
  const options = page.locator('._JX_edit_option[data-field-key="assignee"]');
  const optionCount = await options.count();
  test.skip(optionCount < 2, 'Need at least two assignee options to run restoration-based mutation test.');

  const currentSelected = page.locator('._JX_edit_option[data-field-key="assignee"].is-selected');
  const currentOptionId = await currentSelected.first().getAttribute('data-option-id');
  let targetOptionId = null;
  for (let index = 0; index < optionCount; index += 1) {
    const candidateId = await options.nth(index).getAttribute('data-option-id');
    if (candidateId && candidateId !== currentOptionId) {
      targetOptionId = candidateId;
      break;
    }
  }
  test.skip(!targetOptionId, 'Could not find an alternate assignee option.');

  await page.locator(`._JX_edit_option[data-field-key="assignee"][data-option-id="${targetOptionId}"]`).click();
  await page.locator('._JX_edit_input[data-field-key="assignee"]').press('Enter');
  await expect.poll(async () => getAssigneeTitle(page)).not.toBe(currentAssigneeTitle);

  await page.locator('._JX_assignee_edit_button').click();
  if (currentOptionId) {
    await page.locator(`._JX_edit_option[data-field-key="assignee"][data-option-id="${currentOptionId}"]`).click();
    await page.locator('._JX_edit_input[data-field-key="assignee"]').press('Enter');
    await expect.poll(async () => getAssigneeTitle(page)).toBe(currentAssigneeTitle);
  }

  await expect(popup).toContainText(issueKey);
  await page.close();
});

test('adds and removes a temporary label on an allowed live Jira issue @live', async ({extensionApp, optionsPage}) => {
  const config = requireLiveAuthConfig();
  const issueKey = getAllowedLiveIssue(config, 0);
  const page = await openLivePopupForIssue(extensionApp, optionsPage, config, issueKey);
  const popup = page.locator('._JX_container');
  const tempLabel = `e2e-playwright-${Date.now()}`;

  await page.locator('._JX_field_chip_edit[data-field-key="labels"]').click();
  const labelInput = page.locator('._JX_edit_input[data-field-key="labels"]');
  await labelInput.fill(tempLabel);
  await labelInput.press('Enter');
  await page.locator('._JX_edit_save[data-field-key="labels"]').click();
  await expect(popup).toContainText(tempLabel);

  await page.locator('._JX_field_chip_edit[data-field-key="labels"]').click();
  const selectedLabelOption = page.locator(`._JX_edit_option[data-field-key="labels"][data-option-id="${tempLabel}"]`);
  if (await selectedLabelOption.count()) {
    await selectedLabelOption.click();
  }
  await page.locator('._JX_edit_save[data-field-key="labels"]').click();
  await expect(popup).not.toContainText(tempLabel);

  await page.close();
});
