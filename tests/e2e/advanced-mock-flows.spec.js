const {test, expect, configureExtension, hoverIssueKey, injectContentScript} = require('./helpers/extension-fixtures');
const {getCurrentUser} = require('./helpers/live-jira-api');
const {buildExtensionConfig, requireJiraTestTarget, replaceIssueKeysOnPage, resolveTargetIssueKeys} = require('./helpers/test-targets');
const {patchJsonResponse} = require('./helpers/jira-route-mocks');

function baseConfig(servers, target, overrides = {}) {
  return buildExtensionConfig(servers, {
    customFields: target.mode === 'mock' ? [{fieldId: 'customfield_12345', row: 2}] : [],
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

async function getSelectedOptionIds(locator) {
  const selectedIds = [];
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const option = locator.nth(index);
    if (await option.evaluate(node => node.classList.contains('is-selected'))) {
      selectedIds.push(String(await option.getAttribute('data-option-id') || ''));
    }
  }
  return selectedIds.filter(Boolean);
}

async function setSelectedOptionIds(locator, selectedIds) {
  const expectedIds = new Set(selectedIds.map(value => String(value || '')).filter(Boolean));
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const option = locator.nth(index);
    const optionId = String(await option.getAttribute('data-option-id') || '');
    if (!optionId) {
      continue;
    }
    const isSelected = await option.evaluate(node => node.classList.contains('is-selected'));
    const shouldBeSelected = expectedIds.has(optionId);
    if (isSelected !== shouldBeSelected) {
      await option.click();
    }
  }
}

test('shows assignee and parent search results inside their editors', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false', minimumIssueCount: 2});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('editable');
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page, target: resolvedTarget} = await openPopup(extensionApp, servers, target);

  await page.locator('._JX_assignee_edit_button').click();
  await page.locator('._JX_edit_input[data-field-key="assignee"]').fill(target.mode === 'mock' ? 'Morgan' : '');
  await expect(page.locator('._JX_edit_option[data-field-key="assignee"]').first()).toBeVisible();
  await page.locator('._JX_edit_cancel[data-field-key="assignee"]').click();

  await page.locator('._JX_field_chip_edit[data-field-key="parentLink"]').click();
  await page.locator('._JX_edit_input[data-field-key="parentLink"]').fill(resolvedTarget.secondaryIssueKey.split('-')[1]);
  await expect(page.locator(`._JX_edit_option[data-field-key="parentLink"][data-option-id="${resolvedTarget.secondaryIssueKey}"]`).first()).toBeVisible();

  await page.close();
});

test('updates sprint and version fields through edit popovers', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('editable');
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = page.locator('._JX_container');

  if (target.mode === 'live') {
    await page.locator('._JX_field_chip_edit[data-field-key="sprint"]').click();
    const sprintOptions = page.locator('._JX_edit_option[data-field-key="sprint"]');
    await waitForOptions(sprintOptions, 1);
    await expect(sprintOptions.first()).toBeVisible();
    await page.keyboard.press('Escape');

    const affectsEditButton = page.locator('._JX_field_chip_edit[data-field-key="versions"]');
    if (await affectsEditButton.count()) {
      await affectsEditButton.click();
      const versionOptions = page.locator('._JX_edit_option[data-field-key="versions"]');
      await waitForOptions(versionOptions, 1);
      await expect(versionOptions.first()).toBeVisible();
      await page.keyboard.press('Escape');
    } else {
      await expect(popup).toContainText('Affects: --');
    }

    await page.locator('._JX_field_chip_edit[data-field-key="fixVersions"]').click();
    const fixVersionOptions = page.locator('._JX_edit_option[data-field-key="fixVersions"]');
    await waitForOptions(fixVersionOptions, 1);
    await expect(fixVersionOptions.first()).toBeVisible();
    await page.keyboard.press('Escape');

    await page.close();
    return;
  }

  await page.locator('._JX_field_chip_edit[data-field-key="sprint"]').click();
  const sprintOptions = page.locator('._JX_edit_option[data-field-key="sprint"]');
  await waitForOptions(sprintOptions, 1);
  const currentSprintOptionId = await page.locator('._JX_edit_option[data-field-key="sprint"].is-selected').first().getAttribute('data-option-id');
  const sprintOptionCount = await sprintOptions.count();
  let nextSprintOptionId = '';
  for (let index = 0; index < sprintOptionCount; index += 1) {
    const candidateId = String(await sprintOptions.nth(index).getAttribute('data-option-id') || '');
    if (candidateId && candidateId !== currentSprintOptionId) {
      nextSprintOptionId = candidateId;
      break;
    }
  }
  await page.locator(`._JX_edit_option[data-field-key="sprint"][data-option-id="${nextSprintOptionId}"]`).click();
  await page.locator('._JX_edit_input[data-field-key="sprint"]').press('Enter');
  await expect(popup).toContainText(/Sprint/i);
  await page.locator('._JX_field_chip_edit[data-field-key="sprint"]').click();
  await waitForOptions(sprintOptions, 1);
  if (currentSprintOptionId) {
    await page.locator(`._JX_edit_option[data-field-key="sprint"][data-option-id="${currentSprintOptionId}"]`).click();
    await page.locator('._JX_edit_input[data-field-key="sprint"]').press('Enter');
  }

  const affectsEditButton = page.locator('._JX_field_chip_edit[data-field-key="versions"]');
  if (await affectsEditButton.count()) {
    await affectsEditButton.click();
    const versionOptions = page.locator('._JX_edit_option[data-field-key="versions"]');
    await waitForOptions(versionOptions, 1);
    const originalVersionIds = await getSelectedOptionIds(versionOptions);
    const versionOptionCount = await versionOptions.count();
    let nextVersionOptionId = '';
    for (let index = 0; index < versionOptionCount; index += 1) {
      const candidateId = String(await versionOptions.nth(index).getAttribute('data-option-id') || '');
      if (candidateId && !originalVersionIds.includes(candidateId)) {
        nextVersionOptionId = candidateId;
        break;
      }
    }
    await page.locator(`._JX_edit_option[data-field-key="versions"][data-option-id="${nextVersionOptionId}"]`).click();
    await page.locator('._JX_edit_save[data-field-key="versions"]').click();
    await expect(popup).toContainText(/Affects versions updated|version/i);
    await affectsEditButton.click();
    await waitForOptions(versionOptions, 1);
    await setSelectedOptionIds(versionOptions, originalVersionIds);
    await page.locator('._JX_edit_save[data-field-key="versions"]').click();
  } else {
    await expect(popup).toContainText('Affects: --');
  }

  await page.locator('._JX_field_chip_edit[data-field-key="fixVersions"]').click();
  const fixVersionOptions = page.locator('._JX_edit_option[data-field-key="fixVersions"]');
  await waitForOptions(fixVersionOptions, 1);
  const originalFixVersionIds = await getSelectedOptionIds(fixVersionOptions);
  const fixVersionOptionCount = await fixVersionOptions.count();
  let nextFixVersionOptionId = '';
  for (let index = 0; index < fixVersionOptionCount; index += 1) {
    const candidateId = String(await fixVersionOptions.nth(index).getAttribute('data-option-id') || '');
    if (candidateId && !originalFixVersionIds.includes(candidateId)) {
      nextFixVersionOptionId = candidateId;
      break;
    }
  }
  await page.locator(`._JX_edit_option[data-field-key="fixVersions"][data-option-id="${nextFixVersionOptionId}"]`).click();
  await page.locator('._JX_edit_save[data-field-key="fixVersions"]').click();
  await expect(popup).toContainText(/Fix version/i);
  await page.locator('._JX_field_chip_edit[data-field-key="fixVersions"]').click();
  await waitForOptions(fixVersionOptions, 1);
  await setSelectedOptionIds(fixVersionOptions, originalFixVersionIds);
  await page.locator('._JX_edit_save[data-field-key="fixVersions"]').click();

  await page.close();
});

test('shows grouped quick actions for assignment, transition, and sprint moves', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('editable');
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  await page.locator('._JX_actions_toggle').click();

  await expect(page.locator('._JX_action_item').first()).toBeVisible();

  await page.close();
});

test('offers an explicit unassigned option in the assignee editor', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('editable');
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);

  await page.locator('._JX_assignee_edit_button').click();
  const unassignedOption = page.locator('._JX_edit_option[data-field-key="assignee"][data-option-id="__unassigned__"]');
  await expect(unassignedOption).toBeVisible();
  await page.close();
});

test('hides quick actions when the issue is already assigned, already in progress, and has no sprint move targets', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('in-progress-no-sprint-actions');
  } else {
    const currentUser = await getCurrentUser(target);
    await patchJsonResponse(extensionApp.context, target.instanceUrl, '/rest/api/2/issue/[^/?]+/transitions(?:\\?.*)?$', payload => ({...payload, transitions: []}));
    await patchJsonResponse(extensionApp.context, target.instanceUrl, '/rest/agile/1.0/board/[^/]+/sprint(?:\\?.*)?$', payload => ({...payload, values: []}));
    await patchJsonResponse(extensionApp.context, target.instanceUrl, '/rest/api/2/issue/[^?]+\\?[^#]*fields=.*(?:&.*)?$', payload => ({
      ...payload,
      fields: {
        ...payload.fields,
        assignee: {
          displayName: currentUser.displayName || 'You',
          accountId: currentUser.accountId || '',
          name: currentUser.name || '',
          username: currentUser.username || '',
          key: currentUser.key || '',
        },
        status: {
          ...(payload.fields?.status || {}),
          name: 'In Progress',
          statusCategory: {key: 'indeterminate', name: 'In Progress'},
        },
      },
    }));
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  await expect(page.locator('._JX_actions_toggle')).toHaveCount(0);
  await page.close();
});

test('hides attachment and pull request sections when those display settings are disabled', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('editable');
  }
  await configureExtension(optionsPage, baseConfig(servers, target, {
    displayFields: {
      comments: false,
      attachments: false,
      pullRequests: false,
    },
  }), true);

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = page.locator('._JX_container');

  await expect(popup).not.toContainText('Attachments');
  await expect(popup).not.toContainText('Pull Requests');
  await page.close();
});
