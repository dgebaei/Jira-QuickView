const {test, expect, configureExtension, hoverIssueKey, injectContentScript} = require('./helpers/extension-fixtures');
const {getCurrentUser} = require('./helpers/live-jira-api');
const {popupModel} = require('./helpers/popup');
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
  const popup = popupModel(page);

  await popup.editButton('assignee').click();
  await popup.editInput('assignee').fill(target.mode === 'mock' ? 'Morgan' : '');
  await expect(popup.editOptions('assignee').first()).toBeVisible();
  await popup.editCancel('assignee').click();

  await popup.editButton('parentLink').click();
  await popup.editInput('parentLink').fill(resolvedTarget.secondaryIssueKey.split('-')[1]);
  await expect(page.locator(`._JX_edit_option[data-field-key="parentLink"][data-option-id="${resolvedTarget.secondaryIssueKey}"]`).first()).toBeVisible();

  await page.close();
});

test('edits the popup title inline and applies the change immediately', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('editable');
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = page.locator('._JX_container');
  const titleEditButton = page.locator('._JX_title_edit_button');

  if (target.mode === 'live') {
    if (await titleEditButton.count()) {
      await titleEditButton.click();
      await expect(page.locator('._JX_edit_input[data-field-key="summary"]')).toBeVisible();
      await page.keyboard.press('Escape');
    }
    await page.close();
    return;
  }

  const originalTitle = 'Pressing END removes non-command text starting with "/" in multi line text fields';
  const updatedTitle = 'Pressing End preserves slash-prefixed text in multiline editor fields';

  await expect(popup).toContainText(originalTitle);
  await expect(titleEditButton).toHaveCount(1);

  await titleEditButton.click();
  const summaryInput = page.locator('._JX_edit_input[data-field-key="summary"]');
  await expect(summaryInput).toBeVisible();
  await summaryInput.fill(`${updatedTitle} draft`);
  await page.locator('._JX_edit_discard[data-field-key="summary"]').click();
  await expect(popup).toContainText(originalTitle);

  await titleEditButton.click();
  await expect(summaryInput).toBeVisible();
  await summaryInput.fill(updatedTitle);
  await summaryInput.press('Enter');

  await expect(popup).toContainText(updatedTitle);
  await expect(popup).not.toContainText(originalTitle);
  await expect(page.locator('#_JX_title_link')).toHaveAttribute('data-title', updatedTitle);

  await page.close();
});

test('updates sprint and version fields through edit popovers', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('editable');
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page);

  if (target.mode === 'live') {
    await popup.editButton('sprint').click();
    const sprintOptions = popup.editOptions('sprint');
    await waitForOptions(sprintOptions, 1);
    await expect(sprintOptions.first()).toBeVisible();
    await page.keyboard.press('Escape');

    const affectsEditButton = popup.editButton('versions');
    if (await affectsEditButton.count()) {
      await affectsEditButton.click();
      const versionOptions = popup.editOptions('versions');
      await waitForOptions(versionOptions, 1);
      await expect(versionOptions.first()).toBeVisible();
      await page.keyboard.press('Escape');
    } else {
      await expect(popup.root).toContainText('Affects: --');
    }

    await popup.editButton('fixVersions').click();
    const fixVersionOptions = popup.editOptions('fixVersions');
    await waitForOptions(fixVersionOptions, 1);
    await expect(fixVersionOptions.first()).toBeVisible();
    await page.keyboard.press('Escape');

    await page.close();
    return;
  }

  await popup.editButton('sprint').click();
  let sprintOptions = popup.editOptions('sprint');
  await waitForOptions(sprintOptions, 1);
  const currentSprintOption = page.locator('._JX_edit_option[data-field-key="sprint"].is-selected').first();
  const currentSprintOptionId = await currentSprintOption.getAttribute('data-option-id');
  const currentSprintOptionLabel = String(await currentSprintOption.textContent() || '').trim();
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
  await popup.editInput('sprint').press('Enter');
  await expect(popup.root).toContainText(/Sprint/i);
  await popup.editButton('sprint').click();
  sprintOptions = popup.editOptions('sprint');
  await waitForOptions(sprintOptions, 1);
  if (currentSprintOptionLabel) {
    await expect(popup.editInput('sprint')).toBeEnabled();
    await popup.editInput('sprint').fill('');
    const originalSprintOption = page.locator(`._JX_edit_option[data-field-key="sprint"][data-option-id="${currentSprintOptionId}"]`).first();
    await expect(originalSprintOption).toBeVisible();
    const isOriginalSprintSelected = await originalSprintOption.evaluate(node => node.classList.contains('is-selected'));
    if (!isOriginalSprintSelected) {
      await originalSprintOption.click();
    }
    await popup.editInput('sprint').press('Enter');
  }

  const affectsEditButton = popup.editButton('versions');
  if (await affectsEditButton.count()) {
    await affectsEditButton.click();
    let versionOptions = popup.editOptions('versions');
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
    await popup.editSave('versions').click();
    await expect(popup.root).toContainText(/Affects versions updated|version/i);
    await affectsEditButton.click();
    versionOptions = popup.editOptions('versions');
    await waitForOptions(versionOptions, 1);
    await setSelectedOptionIds(versionOptions, originalVersionIds);
    await popup.editSave('versions').click();
  } else {
    await expect(popup.root).toContainText('Affects: --');
  }

  await popup.editButton('fixVersions').click();
  let fixVersionOptions = popup.editOptions('fixVersions');
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
  await popup.editSave('fixVersions').click();
  await expect(popup.root).toContainText(/Fix version/i);
  await popup.editButton('fixVersions').click();
  fixVersionOptions = popup.editOptions('fixVersions');
  await waitForOptions(fixVersionOptions, 1);
  await setSelectedOptionIds(fixVersionOptions, originalFixVersionIds);
  await popup.editSave('fixVersions').click();

  await page.close();
});

test('updates time tracking estimates through the content block editor @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Time tracking persistence is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target, {
    tooltipLayout: {
      row1: ['issueType', 'status', 'priority', 'epicParent'],
      row2: ['sprint', 'affects', 'fixVersions'],
      row3: ['environment', 'labels'],
      contentBlocks: ['description', 'attachments', 'comments', 'pullRequests', 'timeTracking'],
      people: ['reporter', 'assignee'],
    },
  }));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page);
  const originalEstimateInput = page.locator('._JX_time_tracking_input[data-time-tracking-field="originalEstimateInput"]');
  const remainingEstimateInput = page.locator('._JX_time_tracking_input[data-time-tracking-field="remainingEstimateInput"]');

  await expect(originalEstimateInput).toHaveValue('1w');
  await expect(remainingEstimateInput).toHaveValue('1d');

  await originalEstimateInput.fill('2w');
  await remainingEstimateInput.fill('3d');
  await page.locator('._JX_time_tracking_save').click();

  await expect(page.locator('body')).toContainText(/Time tracking updated|Estimates updated/);
  await expect(originalEstimateInput).toHaveValue('2w');
  await expect(remainingEstimateInput).toHaveValue('3d');
  await expect(popup.root).toContainText('Time Tracking');

  await page.keyboard.press('Escape');
  await hoverIssueKey(page, '#popup-key');
  await expect(originalEstimateInput).toHaveValue('2w');
  await expect(remainingEstimateInput).toHaveValue('3d');

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
  }));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = page.locator('._JX_container');

  await expect(popup).not.toContainText('Attachments');
  await expect(popup).not.toContainText('Pull Requests');
  await page.close();
});
