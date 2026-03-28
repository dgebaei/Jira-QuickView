const {test, expect, configureExtension, hoverIssueKey, injectContentScript} = require('./helpers/extension-fixtures');
const {popupModel} = require('./helpers/popup');
const {deleteIssueComment, getIssueComments, getLiveIssue, getMentionUsers} = require('./helpers/live-jira-api');
const {ensurePreviewAttachment} = require('./helpers/live-jira-seed');
const {patchJsonResponse} = require('./helpers/jira-route-mocks');
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
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {origin: servers.allowedPage.origin});
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
    Object.defineProperty(event, 'clipboardData', {
      value: dataTransfer,
    });
    Object.defineProperty(event, 'originalEvent', {
      value: {clipboardData: dataTransfer},
    });
    element.dispatchEvent(event);
  }, TEST_PNG_BYTES);
}

test('renders Jira metadata, comments, attachments, pull requests, and custom fields', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('editable');
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page, target: resolvedTarget} = await openPopup(extensionApp, servers, target);
  const popup = page.locator('._JX_container');

  if (target.mode === 'mock') {
    await expect(popup).toContainText('Pressing END removes non-command text');
    await expect(popup).toContainText('Medium');
    await expect(popup).toContainText('Sprint 42');
    await expect(popup).toContainText('Customer impact: High');
    await expect(popup).toContainText('Initial comment with a link');
    await expect(popup).toContainText('Fix slash command cursor behavior');
    await expect(page.locator('._JX_thumb')).toHaveCount(1);
  } else {
    const issue = await getLiveIssue(resolvedTarget.primaryIssueKey, resolvedTarget);
    await expect(popup).toContainText(issue.fields.summary);
    if (issue.fields.priority?.name) {
      await expect(popup).toContainText(issue.fields.priority.name);
    }
    if ((issue.renderedFields?.comment?.comments || []).length) {
      await expect(page.locator('._JX_comment').first()).toBeVisible();
    }
    if ((issue.fields.attachment || []).length) {
      await expect(page.locator('._JX_attachment, ._JX_thumb').first()).toBeVisible();
    }
  }
  await page.close();
});

test('keeps editable custom fields visible when they are currently empty @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Empty custom field placeholder coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await patchJsonResponse(optionsPage.context(), target.instanceUrl, '/rest/api/2/issue/[^?]+(?:\\?.*)?$', payload => ({
    ...payload,
    names: {
      ...payload.names,
      customfield_22222: 'Customer Tier',
    },
    fields: {
      ...payload.fields,
      customfield_22222: null,
    },
  }));
  await patchJsonResponse(optionsPage.context(), target.instanceUrl, '/rest/api/2/issue/[^/]+/editmeta(?:\\?.*)?$', payload => ({
    ...payload,
    fields: {
      ...payload.fields,
      customfield_22222: {
        required: false,
        name: 'Customer Tier',
        key: 'customfield_22222',
        schema: {
          type: 'option',
          custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select',
        },
        operations: ['set'],
        allowedValues: [
          {id: '20001', value: 'Gold'},
          {id: '20002', value: 'Silver'},
        ],
      },
    },
  }));
  await configureExtension(optionsPage, buildExtensionConfig(servers, {
    customFields: [{fieldId: 'customfield_22222', row: 2}],
  }, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page);

  await expect(popup.root).toContainText('Customer Tier: --');
  await expect(page.locator('button[data-field-key="customfield_22222"]')).toBeVisible();

  await page.close();
});

test('supports search-based editing for user picker custom fields @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'User-picker custom field coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await patchJsonResponse(optionsPage.context(), target.instanceUrl, '/rest/api/2/issue/[^?]+(?:\\?.*)?$', payload => ({
    ...payload,
    names: {
      ...payload.names,
      customfield_54321: 'Approver',
    },
    fields: {
      ...payload.fields,
      customfield_54321: null,
    },
  }));
  await patchJsonResponse(optionsPage.context(), target.instanceUrl, '/rest/api/2/issue/[^/]+/editmeta(?:\\?.*)?$', payload => ({
    ...payload,
    fields: {
      ...payload.fields,
      customfield_54321: {
        required: false,
        name: 'Approver',
        key: 'customfield_54321',
        schema: {
          type: 'user',
          custom: 'com.atlassian.jira.plugin.system.customfieldtypes:userpicker',
        },
        operations: ['set'],
      },
    },
  }));
  await configureExtension(optionsPage, buildExtensionConfig(servers, {
    customFields: [{fieldId: 'customfield_54321', row: 2}],
  }, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page);

  await expect(popup.root).toContainText('Approver: --');
  await page.locator('button[data-field-key="customfield_54321"]').click();
  await page.locator('input[data-field-key="customfield_54321"]').fill('Alex');
  const alexOption = page.locator('button[data-field-key="customfield_54321"]').filter({hasText: 'Alex Reviewer'}).first();
  await expect(alexOption).toBeVisible();

  await page.close();
});

test('copies the Jira issue link and previews attachment images', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('editable');
  } else {
    const resolvedTarget = await resolveTargetIssueKeys(target);
    await ensurePreviewAttachment(resolvedTarget.primaryIssueKey, resolvedTarget);
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page, target: resolvedTarget} = await openPopup(extensionApp, servers, target);
  await page.locator('._JX_title_copy').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(`browse/${resolvedTarget.primaryIssueKey}`);

  const previewable = page.locator('._JX_previewable');
  await expect.poll(async () => previewable.count(), {timeout: 10000}).toBeGreaterThan(0);
  await previewable.first().click();
  const popup = popupModel(page);
  await expect(popup.previewOverlay).toHaveClass(/is-open/);
  await expect(popup.previewImage).toHaveAttribute('src', /\S+/);
  await page.keyboard.press('Escape');
  await page.close();
});

test('supports quick actions and inline edits against mocked Jira APIs', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('editable');
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = page.locator('._JX_container');

  await page.locator('._JX_actions_toggle').click();
  const assignToMe = page.locator('._JX_action_item[data-action-key="assign-to-me"]');
  if (target.mode === 'mock') {
    await assignToMe.click();
    await expect(popup).toContainText('Assigned to you');
    await expect(page.locator('._JX_title_assignee_slot [title="Assignee: Morgan Agent"]')).toHaveCount(1);

    await page.locator('._JX_field_chip_edit[data-field-key="priority"]').click();
    await page.locator('._JX_edit_option[data-field-key="priority"][data-option-id="1"]').click();
    await page.locator('._JX_edit_input[data-field-key="priority"]').press('Enter');
    await expect(popup).toContainText('Priority set to Highest');
    await expect(popup).toContainText('Highest');

    await page.locator('._JX_field_chip_edit[data-field-key="labels"]').click();
    const labelInput = page.locator('._JX_edit_input[data-field-key="labels"]');
    await labelInput.fill('release-candidate');
    await page.locator('._JX_edit_option[data-field-key="labels"][data-option-id="release-candidate"]').click();
    await page.locator('._JX_edit_save[data-field-key="labels"]').click();
    await expect(popup).toContainText('Labels updated');
    await expect(popup).toContainText('release-candidate');

    await page.locator('._JX_field_chip_edit[data-field-key="status"]').click();
    await page.locator('._JX_edit_option[data-field-key="status"][data-option-id="31"]').click();
    await expect(popup).toContainText('Status moved to In Progress');
    await expect(popup).toContainText('In Progress');
  } else {
    const actionItems = page.locator('._JX_action_item');
    test.skip(await actionItems.count() < 1, 'No quick actions are available for this live Jira issue.');
    await expect(page.locator('._JX_field_chip_edit[data-field-key="priority"]')).toHaveCount(1);
    await expect(page.locator('._JX_field_chip_edit[data-field-key="labels"]')).toHaveCount(1);
    await expect(page.locator('._JX_field_chip_edit[data-field-key="status"]')).toHaveCount(1);
    if (await assignToMe.count()) {
      await expect(assignToMe).toContainText(/Assign to me/i);
    }
  }

  await page.close();
});

test('adds and removes watchers from the popup panel in mocked mode @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Watcher mutation coverage currently uses the mock Jira server only.');
  await servers.jira.setScenario('watcher-self-off');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const trigger = page.locator('._JX_watchers_trigger');
  await expect(trigger).toContainText('1');
  await expect(trigger).not.toHaveClass(/is-watching/);

  await trigger.click();
  const searchInput = page.locator('._JX_watchers_search_input');
  await expect(searchInput).toBeVisible();
  await searchInput.fill('Morgan');
  await expect(page.locator('._JX_watchers_search_result[data-watcher-id="user-me"]')).toBeVisible();
  await page.locator('._JX_watchers_search_result[data-watcher-id="user-me"]').click();

  await expect(trigger).toContainText('2');
  await expect(trigger).toHaveClass(/is-watching/);
  await expect(page.locator('._JX_watchers_feedback_row').filter({hasText: 'Morgan Agent added to watchers'})).toBeVisible();
  await expect(page.locator('._JX_watchers_row[data-watcher-id="user-me"]')).toBeVisible();
  await page.waitForTimeout(5200);
  await expect(page.locator('._JX_watchers_feedback_row').filter({hasText: 'Morgan Agent added to watchers'})).toHaveCount(0);

  await searchInput.fill('Alex');
  await expect(page.locator('._JX_watchers_search_result[data-watcher-id="user-alex"]')).toHaveCount(0);

  const myRow = page.locator('._JX_watchers_row[data-watcher-id="user-me"]');
  await myRow.hover();
  await myRow.locator('._JX_watchers_remove').click();

  await expect(trigger).toContainText('1');
  await expect(trigger).not.toHaveClass(/is-watching/);
  await expect(page.locator('._JX_watchers_feedback_row').filter({hasText: 'Morgan Agent removed from watchers'})).toBeVisible();
  await expect(page.locator('._JX_watchers_row[data-watcher-id="user-me"]')).toHaveCount(0);
  await page.waitForTimeout(5200);
  await expect(page.locator('._JX_watchers_feedback_row').filter({hasText: 'Morgan Agent removed from watchers'})).toHaveCount(0);
  await page.close();
});

test('supports mentions and saving new comments in mocked mode', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('editable');
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page, target: resolvedTarget} = await openPopup(extensionApp, servers, target);
  const commentInput = page.locator('._JX_comment_input');
  const mentionQuery = target.mode === 'mock' ? 'mor' : 'ge';
  if (target.mode === 'live') {
    const mentionUsers = await getMentionUsers(mentionQuery, target);
    test.skip(!mentionUsers.length, 'No mention suggestions are available for the live Jira tenant.');
  }
  await commentInput.fill(`@${mentionQuery}`);
  await expect(page.locator('._JX_comment_mention_option').first()).toBeVisible();
  await commentInput.press('ArrowDown');
  await commentInput.press('Enter');
  const commentText = ` Investigated and reproduced locally. [playwright-${Date.now()}]`;
  await commentInput.type(commentText);

  const existingCommentIds = target.mode === 'live'
    ? new Set((await getIssueComments(resolvedTarget.primaryIssueKey, resolvedTarget)).map(comment => String(comment.id)))
    : null;

  await page.locator('._JX_comment_save').click();

  const newestComment = page.locator('._JX_comment').last();
  await expect(newestComment).toContainText('Investigated and reproduced locally.');

  if (target.mode === 'live') {
    const nextComments = await getIssueComments(resolvedTarget.primaryIssueKey, resolvedTarget);
    const createdComment = nextComments.find(comment => !existingCommentIds.has(String(comment.id)) && String(comment.body || '').includes('[playwright-'));
    if (createdComment?.id) {
      await deleteIssueComment(resolvedTarget.primaryIssueKey, createdComment.id, resolvedTarget);
    }
  }
  await page.close();
});

test('uploads a pasted image into the comment composer in mocked mode @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Pasted-image upload coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  await pasteImageIntoComment(page);

  await expect(page.locator('._JX_comment_upload_status')).toContainText('Attached to issue');
  await expect(page.locator('._JX_comment_input')).toHaveValue(/!pasted-image.*\.png!/);

  await page.close();
});
