const {test, expect, configureExtension, hoverIssueKey, injectContentScript} = require('./helpers/extension-fixtures');
const {failWithJson, fulfillMalformedJson} = require('./helpers/jira-route-mocks');
const {buildExtensionConfig, requireJiraTestTarget, replaceIssueKeysOnPage, resolveTargetIssueKeys} = require('./helpers/test-targets');

const TEST_PNG_BYTES = Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0wAAAABJRU5ErkJggg==',
  'base64'
));

function baseConfig(servers, target) {
  return buildExtensionConfig(servers, {
    customFields: target.mode === 'mock' ? [{fieldId: 'customfield_12345', row: 2}] : [],
  }, target);
}

async function openPopup(extensionApp, servers, target) {
  const resolvedTarget = await resolveTargetIssueKeys(target);
  const page = await extensionApp.context.newPage();
  await page.goto(`${servers.allowedPage.origin}/popup-actions`);
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

async function pasteImageIntoComment(page) {
  await page.locator('._JX_comment_input').evaluate((element, bytes) => {
    const file = new File([new Uint8Array(bytes)], 'paste.png', {type: 'image/png'});
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    const event = typeof ClipboardEvent === 'function'
      ? new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData: dataTransfer})
      : new Event('paste', {bubbles: true, cancelable: true});
    Object.defineProperty(event, 'clipboardData', {value: dataTransfer});
    Object.defineProperty(event, 'originalEvent', {value: {clipboardData: dataTransfer}});
    element.dispatchEvent(event);
  }, TEST_PNG_BYTES);
}

test('keeps core issue rendering when pull request endpoints fail', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('pr-data-fails');
  } else {
    await failWithJson(extensionApp.context, target.instanceUrl, '/rest/dev-status/.+$', 500, {errorMessages: ['Could not load pull requests']});
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page, target: resolvedTarget} = await openPopup(extensionApp, servers, target);
  const popup = page.locator('._JX_container');
  await expect(popup).toContainText(resolvedTarget.primaryIssueKey);
  await expect(page.locator('._JX_related_pr')).toHaveCount(0);
  await page.close();
});

test('keeps the popup usable when pull request payloads are malformed', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('pr-data-malformed');
  } else {
    await fulfillMalformedJson(extensionApp.context, target.instanceUrl, '/rest/dev-status/.+$');
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page, target: resolvedTarget} = await openPopup(extensionApp, servers, target);
  const popup = page.locator('._JX_container');
  await expect(popup).toContainText(resolvedTarget.primaryIssueKey);
  await page.close();
});

test('falls back to a non-editable labels chip when label suggestions are unavailable', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('label-search-fails');
  } else {
    await failWithJson(extensionApp.context, target.instanceUrl, '/rest/api/2/jql/autocompletedata/suggestions(?:\\?.*)?$', 500, {errorMessages: ['Could not load labels']});
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  await expect(page.locator('._JX_field_chip_edit[data-field-key="labels"]')).toHaveCount(0);
  const labelsChip = page.locator('._JX_labels_chip_content');
  await expect(labelsChip).toContainText('Labels');
  await page.close();
});

test('shows an inline editor error when issue search fails for parent selection', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('issue-search-fails');
  } else {
    await failWithJson(extensionApp.context, target.instanceUrl, '/rest/api/2/search(?:\\?.*)?$', 500, {errorMessages: ['Could not search issues']});
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page, target: resolvedTarget} = await openPopup(extensionApp, servers, target);
  await page.locator('._JX_field_chip_edit[data-field-key="parentLink"]').click();
  await page.locator('._JX_edit_input[data-field-key="parentLink"]').fill(resolvedTarget.secondaryIssueKey.split('-')[1] || '1');
  await expect(page.locator('._JX_edit_hint')).toContainText('Searching parent');
  await expect.poll(async () => (await page.locator('._JX_edit_error').textContent()) || '', {timeout: 15000}).toMatch(/\S+/);
  await page.close();
});

test('shows a composer error when saving a comment fails', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('comment-save-fails');
  } else {
    await failWithJson(extensionApp.context, target.instanceUrl, '/rest/api/2/issue/[^/]+/comment$', 500, {errorMessages: ['Could not save comment']});
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const commentInput = page.locator('._JX_comment_input');
  await commentInput.fill('This should fail to save');
  await expect(page.locator('._JX_comment_save')).toBeEnabled();
  await page.locator('._JX_comment_save').click();
  await expect.poll(async () => (await page.locator('._JX_comment_error').textContent()) || '').toMatch(/HTTP 500|Could not save comment/);
  await page.close();
});

test('shows a mention lookup error when people search fails', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('mention-search-fails');
  } else {
    await failWithJson(extensionApp.context, target.instanceUrl, '/rest/api/2/user/picker(?:\\?.*)?$', 500, {errorMessages: ['Could not load people']});
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const commentInput = page.locator('._JX_comment_input');
  await commentInput.fill('@mor');
  await expect(page.locator('._JX_comment_mentions')).toContainText('Could not load people.');
  await page.close();
});

test('keeps the watchers panel usable when adding a watcher fails', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Watcher failure coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('watchers-add-fails');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const trigger = page.locator('._JX_watchers_trigger');
  await expect(trigger).toContainText('2');

  await trigger.click();
  const searchInput = page.locator('._JX_watchers_search_input');
  await searchInput.fill('Darko');
  const result = page.locator('._JX_watchers_search_result[data-watcher-id="user-darko"]');
  await expect(result).toBeVisible();
  await result.click();

  await expect(page.locator('._JX_watchers_search_results')).toContainText(/Could not add watcher|HTTP 500/);
  await expect(searchInput).toHaveValue('Darko');
  await expect(page.locator('._JX_watchers_row[data-watcher-id="user-darko"]')).toHaveCount(0);
  await expect(trigger).toContainText('2');
  await page.close();
});

test('restores watcher rows when removing a watcher fails', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Watcher failure coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('watchers-remove-fails');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const trigger = page.locator('._JX_watchers_trigger');
  await trigger.click();

  const alexRow = page.locator('._JX_watchers_row[data-watcher-id="user-alex"]');
  await expect(alexRow).toBeVisible();
  await alexRow.hover();
  await alexRow.locator('._JX_watchers_remove').click();

  await expect(page.locator('._JX_watchers_section').filter({hasText: 'Watching now'})).toContainText(/Could not remove watcher|HTTP 500/);
  await expect(page.locator('._JX_watchers_row[data-watcher-id="user-alex"]')).toBeVisible();
  await expect(trigger).toContainText('2');
  await page.close();
});

test('discards comment drafts and clears the composer state', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('editable');
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const commentInput = page.locator('._JX_comment_input');
  await commentInput.fill('Draft comment');
  await expect(page.locator('._JX_comment_save')).toBeEnabled();
  await page.locator('._JX_comment_discard').click();
  await expect(commentInput).toHaveValue('');
  await expect(page.locator('._JX_comment_error')).toHaveText('');
  await expect(page.locator('._JX_comment_save')).toBeDisabled();
  await page.close();
});

test('renders graceful empty states for labels, parent, and fix versions', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'This empty-state coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('empty-optional-fields');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = page.locator('._JX_container');

  await expect(popup).toContainText('Parent: --');
  await expect(popup).toContainText('Fix version: --');
  await expect(popup).toContainText(/Labels\s*:\s*--/);

  await page.locator('._JX_field_chip_edit[data-field-key="parentLink"]').click();
  await expect(page.locator('._JX_edit_popover[data-field-key="parentLink"]')).toContainText('No matching values');
  await page.locator('._JX_edit_cancel[data-field-key="parentLink"]').click();

  await page.locator('._JX_field_chip_edit[data-field-key="fixVersions"]').click();
  await expect(page.locator('._JX_edit_option[data-field-key="fixVersions"]').first()).toBeVisible();
  await page.locator('._JX_edit_discard[data-field-key="fixVersions"]').click();

  await page.locator('._JX_field_chip_edit[data-field-key="labels"]').click();
  await expect(page.locator('._JX_edit_popover[data-field-key="labels"]')).toContainText('No matching values');
  await page.locator('._JX_edit_discard[data-field-key="labels"]').click();

  await page.close();
});

test('shows a composer error when pasted image upload fails', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Pasted-image failure coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('attachment-upload-fails');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  await pasteImageIntoComment(page);

  await expect(page.locator('._JX_comment_error')).toContainText(/HTTP 500|Could not upload pasted image/);
  await expect(page.locator('._JX_comment_upload_status')).toContainText(/HTTP 500|Could not upload pasted image/);

  await page.close();
});
