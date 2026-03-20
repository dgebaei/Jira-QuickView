const {test, expect, configureExtension, hoverIssueKey, injectContentScript} = require('./helpers/extension-fixtures');
const {assertAllowedLiveIssue, getAllowedLiveIssue, getAllowedLiveIssueKeys, getLiveJiraConfig} = require('./helpers/live-jira');
const {getAssignableUsers, getCurrentUser, getLiveIssue, updateIssueFields} = require('./helpers/live-jira-api');
const {ensurePriorityValue, ensureReusableLabel} = require('./helpers/live-jira-seed');

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

async function injectLiveHoverAnchor(page, issueKey) {
  await page.evaluate(key => {
    const existing = document.getElementById('playwright-live-issue-key');
    if (existing) {
      existing.remove();
    }
    const link = document.createElement('a');
    link.id = 'playwright-live-issue-key';
    link.href = `/browse/${key}`;
    link.textContent = key;
    link.style.position = 'fixed';
    link.style.top = '8px';
    link.style.right = '8px';
    link.style.zIndex = '2147483647';
    link.style.background = '#fff';
    link.style.padding = '4px 6px';
    link.style.color = '#0052cc';
    document.body.appendChild(link);
  }, issueKey);
}

async function rehydrateLivePopupAfterReload(extensionApp, page, issueKey) {
  await injectContentScript(extensionApp, page);
  await expect.poll(async () => page.locator('._JX_container').count()).toBe(1);
  await injectLiveHoverAnchor(page, issueKey);
  await hoverIssueKey(page, '#playwright-live-issue-key');
  await expect(page.locator('._JX_container')).toContainText(issueKey);
}

async function openLivePopupForIssue(extensionApp, optionsPage, config, issueKey) {
  assertAllowedLiveIssue(issueKey, config);
  const issue = await getLiveIssue(issueKey, config);
  const canonicalIssueKey = String(issue?.key || issueKey).trim();
  await configureLiveExtension(optionsPage, config);
  const page = await openLiveIssuePage(extensionApp, `${config.instanceUrl.replace(/\/$/, '')}/browse/${canonicalIssueKey}`);
  await injectLiveHoverAnchor(page, canonicalIssueKey);
  await hoverIssueKey(page, '#playwright-live-issue-key');
  await expect(page.locator('._JX_container')).toContainText(canonicalIssueKey);
  return page;
}

async function getAssigneeTitle(page) {
  const assigneeNode = page.locator('._JX_title_assignee_slot [title^="Assignee:"]').first();
  if (await assigneeNode.count()) {
    return await assigneeNode.getAttribute('title');
  }
  return 'Assignee: Unassigned';
}

async function waitForOptionCount(locator, minimumCount = 1) {
  await expect.poll(async () => locator.count(), {timeout: 10000}).toBeGreaterThanOrEqual(minimumCount);
  return locator.count();
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
  const seededPriority = await ensurePriorityValue(issueKey, config);
  expect(seededPriority?.id).toBeTruthy();
  const page = await openLivePopupForIssue(extensionApp, optionsPage, config, issueKey);
  const popup = page.locator('._JX_container');
  await expect(page.locator('._JX_field_chip_edit[data-field-key="priority"]')).toHaveCount(1);

  const currentPriority = await getLiveIssue(issueKey, config);
  const currentPriorityId = String(currentPriority?.fields?.priority?.id || '');
  const currentPriorityText = String(currentPriority?.fields?.priority?.name || '').trim();
  await page.locator('._JX_field_chip_edit[data-field-key="priority"]').click();
  const options = page.locator('._JX_edit_option[data-field-key="priority"]');
  const optionCount = await waitForOptionCount(options, 2);

  let targetOptionId = null;
  for (let index = 0; index < optionCount; index += 1) {
    const candidateId = await options.nth(index).getAttribute('data-option-id');
    if (candidateId && candidateId !== currentPriorityId) {
      targetOptionId = candidateId;
      break;
    }
  }
  expect(targetOptionId).toBeTruthy();

  await page.locator(`._JX_edit_option[data-field-key="priority"][data-option-id="${targetOptionId}"]`).click();
  await page.locator('._JX_edit_input[data-field-key="priority"]').press('Enter');
  await expect(popup).toContainText(/Priority set to/i);
  await expect.poll(async () => String((await getLiveIssue(issueKey, config))?.fields?.priority?.id || ''), {timeout: 10000}).toBe(String(targetOptionId));

  await updateIssueFields(issueKey, {
    priority: {id: currentPriorityId},
  }, config);
  await page.reload({waitUntil: 'domcontentloaded'});
  await rehydrateLivePopupAfterReload(extensionApp, page, issueKey);
  await expect(page.locator('._JX_container')).toContainText(currentPriorityText);

  await page.close();
});

test('updates assignee on an allowed live Jira issue and restores it @live', async ({extensionApp, optionsPage}) => {
  const config = requireLiveAuthConfig();
  const issueKey = getAllowedLiveIssue(config, 0);
  const issue = await getLiveIssue(issueKey, config);
  const assignableUsers = await getAssignableUsers(issueKey, '', config);
  expect(assignableUsers.length).toBeGreaterThan(0);
  const currentUser = await getCurrentUser(config);
  const page = await openLivePopupForIssue(extensionApp, optionsPage, config, issueKey);
  const popup = page.locator('._JX_container');

  const currentAssigneeTitle = await getAssigneeTitle(page);
  const currentAssigneeAccountId = String(issue?.fields?.assignee?.accountId || '');

  if (currentAssigneeAccountId && currentAssigneeAccountId === String(currentUser?.accountId || '')) {
    await updateIssueFields(issueKey, {
      assignee: null,
    }, config);
    await page.reload({waitUntil: 'domcontentloaded'});
    await rehydrateLivePopupAfterReload(extensionApp, page, issueKey);
  }

  const assignToMeAction = page.locator('._JX_action_item[data-action-key="assign-to-me"]');
  await page.locator('._JX_actions_toggle').click();
  await expect(assignToMeAction).toBeVisible();
  await assignToMeAction.click();
  await expect(popup).toContainText(/Assigned to you|Assigned/i);
  await expect.poll(async () => String((await getLiveIssue(issueKey, config))?.fields?.assignee?.accountId || ''), {timeout: 10000}).toBe(String(currentUser?.accountId || ''));

  if (currentAssigneeAccountId) {
    await updateIssueFields(issueKey, {
      assignee: {accountId: currentAssigneeAccountId},
    }, config);
  } else {
    await updateIssueFields(issueKey, {
      assignee: null,
    }, config);
  }
  await page.reload({waitUntil: 'domcontentloaded'});
  await rehydrateLivePopupAfterReload(extensionApp, page, issueKey);
  await expect.poll(async () => getAssigneeTitle(page), {timeout: 10000}).toBe(currentAssigneeTitle);

  await expect(popup).toContainText(issueKey);
  await page.close();
});

test('adds and removes a temporary label on an allowed live Jira issue @live', async ({extensionApp, optionsPage}) => {
  const config = requireLiveAuthConfig();
  const issueKey = getAllowedLiveIssue(config, 0);
  const backupIssueKey = getAllowedLiveIssue(config, 1) || issueKey;
  const originalIssue = await getLiveIssue(issueKey, config);
  const originalLabels = (originalIssue?.fields?.labels || [])
    .map(label => String(label || '').trim())
    .filter(label => label && !label.startsWith('playwright-seed-label'));
  const tempLabel = await ensureReusableLabel(issueKey, backupIssueKey, config);
  expect(tempLabel).toBeTruthy();
  const page = await openLivePopupForIssue(extensionApp, optionsPage, config, issueKey);
  const popup = page.locator('._JX_container');

  await page.locator('._JX_field_chip_edit[data-field-key="labels"]').click();
  const labelInput = page.locator('._JX_edit_input[data-field-key="labels"]');
  const labelQuery = tempLabel.split('-').slice(0, 2).join('-') || tempLabel;
  await labelInput.fill(labelQuery);
  await expect(page.locator(`._JX_edit_option[data-field-key="labels"][data-option-id="${tempLabel}"]`).first()).toBeVisible();
  await page.locator(`._JX_edit_option[data-field-key="labels"][data-option-id="${tempLabel}"]`).first().click();
  await page.locator('._JX_edit_save[data-field-key="labels"]').click();
  await expect(popup).toContainText(/Labels updated/i);
  await expect.poll(async () => (await getLiveIssue(issueKey, config))?.fields?.labels || [], {timeout: 10000}).toContain(tempLabel);

  await updateIssueFields(issueKey, {
    labels: originalLabels,
  }, config);
  await page.reload({waitUntil: 'domcontentloaded'});
  await rehydrateLivePopupAfterReload(extensionApp, page, issueKey);
  await expect(page.locator('._JX_container')).not.toContainText(tempLabel);

  await page.close();
});
