const path = require('path');
const {test, expect, configureExtension, hoverIssueKey, injectContentScript} = require('./helpers/extension-fixtures');
const {getCurrentUser} = require('./helpers/live-jira-api');
const {popupModel} = require('./helpers/popup');
const {buildExtensionConfig, requireJiraTestTarget, replaceIssueKeysOnPage, resolveTargetIssueKeys} = require('./helpers/test-targets');
const {failWithJson, patchJsonResponse} = require('./helpers/jira-route-mocks');

const themeScreenshotDir = String(process.env.JHL_CAPTURE_THEME_SCREENSHOTS || '').trim();

function baseConfig(servers, target, overrides = {}) {
  return buildExtensionConfig(servers, {
    customFields: target.mode === 'mock' ? [{fieldId: 'customfield_12345', row: 2}] : [],
    ...overrides,
  }, target);
}

async function openPopup(extensionApp, servers, target, route = '/popup-actions') {
  const resolvedTarget = await resolveTargetIssueKeys(target);
  const page = await extensionApp.context.newPage();
  const popup = page.locator('._JX_container');
  const titleLink = page.locator('#_JX_title_link');
  await page.goto(`${servers.allowedPage.origin}${route}`);
  await replaceIssueKeysOnPage(page, [
    {from: 'JRACLOUD-97846', to: resolvedTarget.primaryIssueKey},
    {from: 'JRACLOUD-98123', to: resolvedTarget.secondaryIssueKey},
  ]);
  await injectContentScript(extensionApp, page);
  await expect.poll(async () => popup.count()).toBe(1);
  await hoverIssueKey(page, '#popup-key');
  await expect(titleLink).toContainText(resolvedTarget.primaryIssueKey);
  await expect(popup).toContainText(resolvedTarget.primaryIssueKey);
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
  await expect(popup.editPopover('parentLink')).toContainText('Parent');
  await popup.editInput('parentLink').fill(resolvedTarget.secondaryIssueKey.split('-')[1]);
  await expect(page.locator(`._JX_edit_option[data-field-key="parentLink"][data-option-id="${resolvedTarget.secondaryIssueKey}"]`).first()).toBeVisible();

  await page.close();
});

test('lists valid Parent candidates from the current project before other projects @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Parent hierarchy ordering is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page);
  await popup.editButton('parentLink').click();

  const options = page.locator('._JX_edit_option[data-field-key="parentLink"]:not([data-option-id^="__group__"])');
  await waitForOptions(options, 3);
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toHaveAttribute('data-option-id', 'JRACLOUD-97000');
  await expect(options.nth(1)).toHaveAttribute('data-option-id', 'JRACLOUD-98123');
  await expect(options.nth(2)).toHaveAttribute('data-option-id', 'PLATFORM-101');
  await expect(page.locator('._JX_edit_option[data-field-key="parentLink"][data-option-id="JRACLOUD-99999"]')).toHaveCount(0);
  await expect(popup.editPopover('parentLink')).toContainText('JRACLOUD project');
  await expect(popup.editPopover('parentLink')).toContainText('Other projects');

  await page.close();
});

test('uses the Parent label and Epic-only candidates with Jira Data Center Epic Link @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Data Center compatibility is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await failWithJson(extensionApp.context, target.instanceUrl, '/rest/api/3/issuetype(?:\\?.*)?$', 404, {errorMessages: ['Not available']});
  await patchJsonResponse(extensionApp.context, target.instanceUrl, '/rest/api/2/issuetype(?:\\?.*)?$', payload => (
    payload.map(issueType => {
      const dataCenterIssueType = {...issueType};
      delete dataCenterIssueType.hierarchyLevel;
      return dataCenterIssueType;
    })
  ));
  await patchJsonResponse(extensionApp.context, target.instanceUrl, '/rest/api/2/field(?:\\?.*)?$', payload => [
    ...payload,
    {id: 'customfield_10014', name: 'Epic Link', schema: {custom: 'com.pyxis.greenhopper.jira:gh-epic-link'}},
  ]);
  await patchJsonResponse(extensionApp.context, target.instanceUrl, `/rest/api/2/issue/${target.primaryIssueKey}\\?[^#]+$`, payload => ({
    ...payload,
    names: {...payload.names, customfield_10014: 'Epic Link'},
    fields: {
      ...payload.fields,
      parent: null,
      customfield_10014: 'JRACLOUD-97000',
    },
  }));
  await patchJsonResponse(extensionApp.context, target.instanceUrl, '/rest/api/2/issue/[^/]+/editmeta(?:\\?.*)?$', payload => {
    const fields = {...payload.fields};
    delete fields.parent;
    fields.customfield_10014 = {
      name: 'Epic Link',
      operations: ['set'],
      schema: {custom: 'com.pyxis.greenhopper.jira:gh-epic-link'},
    };
    return {...payload, fields};
  });
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page);
  await popup.editButton('parentLink').click();
  await expect(popup.editPopover('parentLink')).toContainText('Parent');

  const options = page.locator('._JX_edit_option[data-field-key="parentLink"]:not([data-option-id^="__group__"])');
  await waitForOptions(options, 3);
  await expect(page.locator('._JX_edit_option[data-field-key="parentLink"][data-option-id="JRACLOUD-99999"]')).toHaveCount(0);
  await expect(options.nth(0)).toHaveAttribute('data-option-id', 'JRACLOUD-97000');
  await expect(options.nth(2)).toHaveAttribute('data-option-id', 'PLATFORM-101');

  const nextParent = page.locator('._JX_edit_option[data-field-key="parentLink"][data-option-id="JRACLOUD-98123"]');
  const updateRequestPromise = extensionApp.context.waitForEvent('request', request => (
    request.method() === 'PUT' && request.url().includes(`/rest/api/2/issue/${target.primaryIssueKey}`)
  ));
  await nextParent.click();
  await popup.editInput('parentLink').press('Enter');
  const updateRequest = await updateRequestPromise;
  await expect.poll(async () => updateRequest.postDataJSON()).toEqual({
    fields: {customfield_10014: 'JRACLOUD-98123'},
  });

  await page.close();
});

test('selects the top filtered single-select option with Enter @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Single-select keyboard coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page);

  await popup.editButton('assignee').click();
  await popup.editInput('assignee').fill('Morgan');
  const topResult = popup.editOptions('assignee').first();
  await expect(topResult).toContainText('Morgan Agent');
  await expect(topResult).toHaveClass(/is-highlighted/);
  await popup.editInput('assignee').press('Enter');

  await expect(popup.root).toContainText('Assignee set to Morgan Agent');
  await expect(page.locator('._JX_title_assignee_slot [title="Assignee: Morgan Agent"]')).toHaveCount(1);

  await page.close();
});

test('navigates dropdown options immediately and after filtering @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Dropdown keyboard navigation coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page);

  await popup.editButton('sprint').click();
  const sprintInput = popup.editInput('sprint');
  const sprintOptions = popup.editOptions('sprint');
  await waitForOptions(sprintOptions, 2);
  await expect(sprintInput).toBeFocused();

  const firstSprintOptionId = await sprintOptions.nth(0).getAttribute('id');
  const secondSprintOptionId = await sprintOptions.nth(1).getAttribute('id');
  await sprintInput.press('ArrowDown');
  await expect(sprintInput).toHaveAttribute('aria-activedescendant', secondSprintOptionId);
  await expect(sprintOptions.nth(1)).toHaveClass(/is-highlighted/);

  await sprintInput.press('ArrowUp');
  await expect(sprintInput).toHaveAttribute('aria-activedescendant', firstSprintOptionId);
  await sprintInput.press('Escape');

  await popup.editButton('assignee').click();
  const assigneeInput = popup.editInput('assignee');
  await assigneeInput.fill('Morgan');
  const filteredResult = popup.editOptions('assignee').first();
  await expect(filteredResult).toContainText('Morgan Agent');
  const filteredResultId = await filteredResult.getAttribute('id');
  await assigneeInput.press('ArrowDown');
  await expect(assigneeInput).toHaveAttribute('aria-activedescendant', filteredResultId);
  await assigneeInput.press('Enter');

  await expect(popup.root).toContainText('Assignee set to Morgan Agent');
  await page.close();
});

test('keeps fix version options readable and distinct in dark mode @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Dark-theme editor colors are deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target));
  await optionsPage.evaluate(() => chrome.storage.sync.set({themeMode: 'dark'}));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page);
  await expect(page.locator('html')).toHaveAttribute('data-jhl-theme', 'dark');
  await popup.editButton('fixVersions').click();

  const options = popup.editOptions('fixVersions');
  await waitForOptions(options, 4);
  const highlightedOption = page.locator('._JX_edit_option[data-field-key="fixVersions"].is-highlighted').first();
  const selectedOption = page.locator('._JX_edit_option[data-field-key="fixVersions"].is-selected').first();
  const normalOption = page.locator('._JX_edit_option[data-field-key="fixVersions"]:not(.is-selected):not(.is-highlighted)').first();

  await expect(normalOption).toHaveCSS('color', 'rgb(241, 245, 249)');
  await expect(selectedOption).toHaveCSS('background-color', 'rgb(38, 56, 79)');
  await expect(highlightedOption).toHaveCSS('background-color', 'rgb(49, 95, 143)');
  await expect(highlightedOption).toHaveCSS('color', 'rgb(255, 255, 255)');

  await page.close();
});

test('themes the linked-issue relationship dropdown in light and dark modes @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Relationship dropdown colors are deterministic in mocked mode only.');

  await servers.jira.setScenario('linked-issues');
  await configureExtension(optionsPage, baseConfig(servers, target));
  await optionsPage.evaluate(() => chrome.storage.sync.set({themeMode: 'light'}));

  const {page} = await openPopup(extensionApp, servers, target);
  await page.getByTestId('jira-popup-linked-issues-trigger').click();
  const relationshipSelect = page.getByRole('combobox', {name: 'Relationship'});
  const issueSearchInput = page.getByTestId('jira-popup-linked-issues-search');
  const firstOption = relationshipSelect.locator('option').first();

  await expect(relationshipSelect).toHaveCSS('color-scheme', 'light');
  await expect(firstOption).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(firstOption).toHaveCSS('color', 'rgb(23, 43, 77)');
  if (themeScreenshotDir) {
    await page.getByTestId('jira-popup-linked-issues-panel').screenshot({path: path.join(themeScreenshotDir, 'linked-issues-dropdown-light.png')});
  }

  await page.locator('html').evaluate(element => element.setAttribute('data-jhl-theme', 'dark'));
  await expect(relationshipSelect).toHaveCSS('color-scheme', 'dark');
  await expect(relationshipSelect).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(relationshipSelect).toHaveCSS('color', 'rgb(23, 43, 77)');
  await expect(issueSearchInput).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(issueSearchInput).toHaveCSS('color', 'rgb(23, 43, 77)');
  await expect(firstOption).toHaveCSS('background-color', 'rgb(32, 39, 51)');
  await expect(firstOption).toHaveCSS('color', 'rgb(241, 245, 249)');
  if (themeScreenshotDir) {
    await page.getByTestId('jira-popup-linked-issues-panel').screenshot({path: path.join(themeScreenshotDir, 'linked-issues-dropdown-dark.png')});
  }

  await page.close();
});

test('prefers Jira internal assignee results when public user endpoints miss a candidate @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Assignee fallback coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await patchJsonResponse(extensionApp.context, target.instanceUrl, '/rest/internal/2/users/assignee(?:\\?.*)?$', (payload, request) => {
    const url = new URL(request.url());
    const query = String(url.searchParams.get('query') || '').trim().toLowerCase();
    if (query.includes('morgan')) {
      return Array.isArray(payload)
        ? payload.filter(user => String(user?.displayName || '').toLowerCase() === 'morgan agent')
        : payload;
    }
    return Array.isArray(payload)
      ? payload.filter(user => String(user?.displayName || '').toLowerCase() !== 'morgan agent')
      : payload;
  });
  await patchJsonResponse(extensionApp.context, target.instanceUrl, '/rest/api/2/user/assignable/search(?:\\?.*)?$', (payload, request) => {
    const url = new URL(request.url());
    const query = String(url.searchParams.get('query') || url.searchParams.get('username') || '').trim().toLowerCase();
    if (!query || query.includes('morgan')) {
      return Array.isArray(payload)
        ? payload.filter(user => String(user?.displayName || '').toLowerCase() !== 'morgan agent')
        : payload;
    }
    return payload;
  });
  await patchJsonResponse(extensionApp.context, target.instanceUrl, '/rest/api/2/user/search(?:\\?.*)?$', payload => {
    return Array.isArray(payload)
      ? payload.filter(user => String(user?.displayName || '').toLowerCase() !== 'morgan agent')
      : payload;
  });
  await patchJsonResponse(extensionApp.context, target.instanceUrl, '/rest/api/2/user/picker(?:\\?.*)?$', payload => {
    if (Array.isArray(payload)) {
      return payload.filter(user => String(user?.displayName || '').toLowerCase() !== 'morgan agent');
    }
    return {
      ...(payload || {}),
      users: Array.isArray(payload?.users)
        ? payload.users.filter(user => String(user?.displayName || '').toLowerCase() !== 'morgan agent')
        : [],
    };
  });
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page);

  await popup.editButton('assignee').click();
  const morganOption = page.locator('._JX_edit_option[data-field-key="assignee"][data-option-id="user-me"]').first();
  await expect(morganOption).toHaveCount(0);
  await popup.editInput('assignee').fill('Morgan');
  await expect(morganOption).toBeVisible();
  await morganOption.click();
  await page.keyboard.press('Enter');
  await expect(page.locator('._JX_title_assignee_slot [title="Assignee: Morgan Agent"]')).toHaveCount(1);

  await page.close();
});

test('falls back to legacy user search when picker search fails for assignee suggestions @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Assignee fallback coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await failWithJson(extensionApp.context, target.instanceUrl, '/rest/internal/2/users/assignee(?:\\?.*)?$', 500, {errorMessages: ['Could not load assignee candidates']});
  await patchJsonResponse(extensionApp.context, target.instanceUrl, '/rest/api/2/user/assignable/search(?:\\?.*)?$', (payload, request) => {
    const url = new URL(request.url());
    const query = String(url.searchParams.get('query') || url.searchParams.get('username') || '').trim().toLowerCase();
    if (!query || query.includes('morgan')) {
      return Array.isArray(payload)
        ? payload.filter(user => String(user?.displayName || '').toLowerCase() !== 'morgan agent')
        : payload;
    }
    return payload;
  });
  await failWithJson(extensionApp.context, target.instanceUrl, '/rest/api/2/user/picker(?:\\?.*)?$', 500, {errorMessages: ['Could not load people']});
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page);

  await popup.editButton('assignee').click();
  const morganOption = page.locator('._JX_edit_option[data-field-key="assignee"][data-option-id="user-me"]').first();
  await expect(morganOption).toHaveCount(0);
  await popup.editInput('assignee').fill('Morgan');
  await expect(morganOption).toBeVisible();
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

test('removes a selected fix version directly from its chip @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Fix version removal coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page);

  await popup.editButton('fixVersions').click();
  const fixVersionOptions = popup.editOptions('fixVersions');
  await waitForOptions(fixVersionOptions, 1);

  const selectedOption = page.locator('._JX_edit_option[data-field-key="fixVersions"].is-selected').first();
  const selectedOptionId = String(await selectedOption.getAttribute('data-option-id') || '');
  const selectedIndicator = selectedOption.locator('._JX_edit_option_selected_indicator');
  const removeIndicator = selectedOption.locator('._JX_edit_option_remove_indicator');
  const removeButton = popup.editRemoveButtons('fixVersions').first();
  const selectedChip = removeButton.locator('..');
  const dropdown = popup.editPopover('fixVersions').locator('._JX_edit_dropdown');
  const measureLayout = async () => Promise.all([
    popup.editPopover('fixVersions'),
    dropdown,
    selectedOption,
  ].map(locator => locator.evaluate(node => {
    const {width, height} = node.getBoundingClientRect();
    return {width, height};
  })));

  await expect(selectedIndicator).toBeVisible();
  await expect(removeIndicator).toBeHidden();
  const layoutBeforeHover = await measureLayout();
  await selectedOption.hover();
  await expect(selectedIndicator).toBeHidden();
  await expect(removeIndicator).toBeVisible();
  expect(await measureLayout()).toEqual(layoutBeforeHover);

  await expect(removeButton).toHaveCSS('opacity', '0');
  await selectedChip.hover();
  await expect(removeButton).toHaveCSS('opacity', '1');
  await removeButton.click();

  await expect(popup.editRemoveButtons('fixVersions')).toHaveCount(0);
  await expect(page.locator(`._JX_edit_option[data-field-key="fixVersions"][data-option-id="${selectedOptionId}"]`)).not.toHaveClass(/is-selected/);
  await expect(popup.editSave('fixVersions')).toBeEnabled();
  await popup.editSave('fixVersions').click();
  await expect(popup.root).toContainText('Fix version: --');

  await page.close();
});

test('recovers Sprint editing after a transient field catalog failure @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Transient field catalog recovery is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  let fieldCatalogRequests = 0;
  await patchJsonResponse(extensionApp.context, target.instanceUrl, '/rest/api/2/field(?:\\?.*)?$', payload => {
    fieldCatalogRequests += 1;
    return fieldCatalogRequests === 1 ? [] : payload;
  });
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page);

  await expect.poll(() => fieldCatalogRequests).toBeGreaterThanOrEqual(2);
  await expect(popup.editButton('sprint')).toBeVisible();
  await popup.editButton('sprint').click();
  await waitForOptions(popup.editOptions('sprint'), 1);
  await expect(popup.editOptions('sprint').first()).toBeVisible();
  await page.close();
});

test('clears Sprint with a null Jira field value @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Sprint clearing payloads are deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  const sprintUpdatePayloads = [];
  extensionApp.context.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== 'PUT' || !/^\/rest\/api\/2\/issue\/[^/]+$/.test(pathname)) {
      return;
    }
    const payload = request.postDataJSON();
    if (Object.prototype.hasOwnProperty.call(payload?.fields || {}, 'customfield_10020')) {
      sprintUpdatePayloads.push(payload);
    }
  });
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page);

  await popup.editButton('sprint').click();
  await waitForOptions(popup.editOptions('sprint'), 1);
  await page.locator('._JX_edit_option[data-field-key="sprint"][data-option-id=""]').click();
  await popup.editInput('sprint').press('Enter');

  await expect.poll(() => sprintUpdatePayloads.length).toBe(1);
  expect(sprintUpdatePayloads[0].fields.customfield_10020).toBeNull();
  await expect(popup.root).toContainText('Sprint: --');
  await page.close();
});

test('coalesces edit metadata requests while preserving read-only fields @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Edit metadata request behavior is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  let editMetaRequests = 0;
  await patchJsonResponse(extensionApp.context, target.instanceUrl, '/rest/api/2/issue/[^/]+/editmeta(?:\\?.*)?$', payload => {
    editMetaRequests += 1;
    const fields = {...(payload.fields || {})};
    delete fields.customfield_10020;
    delete fields.fixVersions;
    return {
      ...payload,
      fields,
    };
  });
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page);

  await expect(popup.editButton('summary')).toBeVisible();
  await expect(popup.editButton('sprint')).toHaveCount(0);
  await expect(popup.editButton('fixVersions')).toHaveCount(0);
  expect(editMetaRequests).toBe(1);
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
  await page.evaluate(() => {
    window.__jqvTimeTrackingDisabledObserved = false;
    const observer = new MutationObserver(mutations => {
      const sawDisabledInput = mutations.some(mutation => {
        if (mutation.target?.matches?.('._JX_time_tracking_input') && mutation.target.disabled) return true;
        return [...(mutation.addedNodes || [])].some(node => {
          if (node?.matches?.('._JX_time_tracking_input:disabled')) return true;
          return !!node?.querySelector?.('._JX_time_tracking_input:disabled');
        });
      });
      if (sawDisabledInput) {
        window.__jqvTimeTrackingDisabledObserved = true;
        observer.disconnect();
      }
    });
    observer.observe(document.body, {attributes: true, attributeFilter: ['disabled'], childList: true, subtree: true});
  });
  await page.locator('._JX_time_tracking_save').click();

  await expect.poll(() => page.evaluate(() => window.__jqvTimeTrackingDisabledObserved)).toBe(true);
  await expect(originalEstimateInput).toBeEnabled();
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

test('hides attachment and pull request sections when those layout blocks are disabled @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Content block visibility is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target, {
    tooltipLayout: {
      row1: ['issueType', 'status', 'priority'],
      row2: ['epicParent', 'sprint', 'affects', 'fixVersions'],
      row3: ['environment', 'labels'],
      contentBlocks: ['description', 'comments'],
      people: ['reporter', 'assignee'],
    },
  }));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = page.locator('._JX_container');

  await expect(popup).not.toContainText('Attachments');
  await expect(popup).not.toContainText('Pull Requests');
  await page.close();
});

test('shows attachments when the persisted tooltip layout enables the block @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Attachment layout persistence is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target, {
    displayFields: {
      attachments: false,
    },
    tooltipLayout: {
      row1: ['issueType', 'status', 'priority'],
      row2: ['epicParent', 'sprint', 'affects', 'fixVersions'],
      row3: ['environment', 'labels'],
      contentBlocks: ['description', 'attachments', 'comments'],
      people: ['reporter', 'assignee'],
    },
  }));

  const {page} = await openPopup(extensionApp, servers, target);
  const attachments = page.locator('[data-content-block="attachments"]');

  await expect(attachments).toContainText('Attachments');
  await expect(attachments.locator('._JX_thumb')).toHaveCount(4);
  await page.close();
});

test('uses legacy display fields when no tooltip layout was persisted @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Legacy attachment configuration is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target, {
    displayFields: {
      attachments: true,
    },
  }));
  await optionsPage.evaluate(async () => chrome.storage.sync.remove('tooltipLayout'));

  const {page} = await openPopup(extensionApp, servers, target);
  await expect(page.locator('[data-content-block="attachments"] ._JX_thumb')).toHaveCount(4);
  await page.close();
});
