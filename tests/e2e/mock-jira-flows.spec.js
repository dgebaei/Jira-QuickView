const {test, expect, configureExtension, hoverIssueKey, injectContentScript} = require('./helpers/extension-fixtures');
const {deleteIssueComment, getIssueComments, getLiveIssue, getMentionUsers} = require('./helpers/live-jira-api');
const {ensurePreviewAttachment} = require('./helpers/live-jira-seed');
const {buildExtensionConfig, requireJiraTestTarget, replaceIssueKeysOnPage, resolveTargetIssueKeys} = require('./helpers/test-targets');

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

test('renders Jira metadata, comments, attachments, pull requests, and custom fields', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('editable');
  }
  await configureExtension(optionsPage, baseConfig(servers, target), true);

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

test('copies the Jira issue link and previews attachment images', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('editable');
  } else {
    const resolvedTarget = await resolveTargetIssueKeys(target);
    await ensurePreviewAttachment(resolvedTarget.primaryIssueKey, resolvedTarget);
  }
  await configureExtension(optionsPage, baseConfig(servers, target), true);

  const {page, target: resolvedTarget} = await openPopup(extensionApp, servers, target);
  await page.locator('._JX_title_copy').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(`browse/${resolvedTarget.primaryIssueKey}`);

  const previewable = page.locator('._JX_previewable');
  await expect.poll(async () => previewable.count(), {timeout: 10000}).toBeGreaterThan(0);
  await previewable.first().click();
  await expect(page.locator('._JX_preview_overlay')).toHaveClass(/is-open/);
  await expect(page.locator('._JX_preview_image')).toHaveAttribute('src', /\S+/);
  await page.keyboard.press('Escape');
  await page.close();
});

test('supports quick actions and inline edits against mocked Jira APIs', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('editable');
  }
  await configureExtension(optionsPage, baseConfig(servers, target), true);

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

test('supports mentions and saving new comments in mocked mode', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('editable');
  }
  await configureExtension(optionsPage, baseConfig(servers, target), true);

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
