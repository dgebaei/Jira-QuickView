const {test, expect, configureExtension, hoverIssueKey, injectContentScript} = require('./helpers/extension-fixtures');
const {buildExtensionConfig, requireJiraTestTarget} = require('./helpers/test-targets');
const {patchJsonResponse} = require('./helpers/jira-route-mocks');

const OWN_IMAGE = {id: '901', filename: 'image-2026-03-17-10-47-20-728.png'};

async function openPopup({extensionApp, optionsPage, servers}) {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Attachment deletion writes are tested against the mock only.');
  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, buildExtensionConfig(servers, {hoverModifierKey: 'none', hoverActivationMode: 'automatic'}, target));
  const page = await extensionApp.context.newPage();
  await page.goto(`${servers.allowedPage.origin}/popup-actions`);
  await injectContentScript(extensionApp, page);
  await hoverIssueKey(page, '#popup-key');
  await expect(page.locator('#_JX_title_link')).toContainText(target.primaryIssueKey);
  const attachments = page.locator('[data-content-block="attachments"]');
  await expect(attachments.locator('._JX_thumb')).toHaveCount(4);
  return {page, target, attachments};
}

function deletes(page) {
  const requests = [];
  page.context().on('request', request => {
    if (request.method() === 'DELETE' && /\/rest\/api\/2\/attachment\/[^/]+$/.test(new URL(request.url()).pathname)) requests.push(request.url());
  });
  return requests;
}

test('offers delete on hover only for your own attachments and asks before deleting @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, target, attachments} = await openPopup({extensionApp, optionsPage, servers});
  const sent = deletes(page);
  const ownThumb = attachments.locator(`._JX_thumb[data-attachment-id="${OWN_IMAGE.id}"]`);
  const deleteButton = ownThumb.getByRole('button', {name: `Delete ${OWN_IMAGE.filename}`});

  await expect(attachments.locator('._JX_thumb[data-attachment-id="900"]').getByRole('button', {name: /^Delete /})).toHaveCount(0);
  await expect(deleteButton).toHaveCSS('opacity', '0');
  await ownThumb.hover();
  await expect(deleteButton).toHaveCSS('opacity', '1');

  await deleteButton.click();
  const confirmation = ownThumb.getByRole('group', {name: `Delete ${OWN_IMAGE.filename}?`});
  await expect(confirmation).toBeVisible();
  await expect(page.locator('._JX_preview_overlay')).not.toHaveClass(/is-open/);
  await confirmation.getByRole('button', {name: 'Cancel'}).click();
  await expect(confirmation).toHaveCount(0);
  await expect(attachments.locator('._JX_thumb')).toHaveCount(4);
  expect(sent).toHaveLength(0);

  await ownThumb.hover();
  await deleteButton.click();
  await confirmation.getByRole('button', {name: 'Delete'}).click();
  await expect(ownThumb).toHaveCount(0);
  await expect(attachments.locator('._JX_thumb')).toHaveCount(3);
  await expect(page.getByTestId('jira-toast')).toContainText(`Deleted ${OWN_IMAGE.filename}`);
  expect(sent).toEqual([`${target.instanceUrl}/rest/api/2/attachment/${OWN_IMAGE.id}`]);

  // Closing and reopening must not bring back a cached copy.
  await page.keyboard.press('Escape');
  await expect(page.locator('#_JX_title_link')).toHaveCount(0);
  await hoverIssueKey(page, '#popup-key');
  await expect(attachments.locator('._JX_thumb')).toHaveCount(3);
  await page.reload();
  await injectContentScript(extensionApp, page);
  await hoverIssueKey(page, '#popup-key');
  await expect(attachments.locator('._JX_thumb')).toHaveCount(3);
  await page.close();
});

test('Delete All Attachments lets you delete anyone\'s attachment @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Attachment deletion writes are tested against the mock only.');
  await patchJsonResponse(extensionApp.context, target.instanceUrl, '/rest/api/2/mypermissions\\?[^#]+$', payload => ({
    permissions: {...payload.permissions, DELETE_ALL_ATTACHMENTS: {key: 'DELETE_ALL_ATTACHMENTS', havePermission: true}},
  }));
  const {page, attachments} = await openPopup({extensionApp, optionsPage, servers});
  const sent = deletes(page);
  const othersThumb = attachments.locator('._JX_thumb[data-attachment-id="900"]');
  await othersThumb.hover();
  await othersThumb.getByRole('button', {name: 'Delete evidence.png'}).click();
  await othersThumb.getByRole('group', {name: 'Delete evidence.png?'}).getByRole('button', {name: 'Delete'}).click();
  await expect(othersThumb).toHaveCount(0);
  await expect(attachments.locator('._JX_thumb')).toHaveCount(3);
  expect(sent).toEqual([`${target.instanceUrl}/rest/api/2/attachment/900`]);
  await page.close();
});

test('hides delete on your own attachments when Jira withholds Delete Own Attachments @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Attachment deletion writes are tested against the mock only.');
  await patchJsonResponse(extensionApp.context, target.instanceUrl, '/rest/api/2/mypermissions\\?[^#]+$', payload => ({
    permissions: {...payload.permissions, DELETE_OWN_ATTACHMENTS: {key: 'DELETE_OWN_ATTACHMENTS', havePermission: false}},
  }));
  const {page, attachments} = await openPopup({extensionApp, optionsPage, servers});
  await expect(attachments.locator('._JX_thumb')).toHaveCount(4);
  await expect(attachments.locator('._JX_attachment_delete')).toHaveCount(0);
  await page.close();
});

test('keeps the attachment and says why when Jira refuses the delete @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, target, attachments} = await openPopup({extensionApp, optionsPage, servers});
  await page.context().route(`${target.instanceUrl}/rest/api/2/attachment/${OWN_IMAGE.id}`, route => route.request().method() === 'DELETE'
    ? route.fulfill({status: 403, contentType: 'application/json', body: JSON.stringify({errorMessages: ['No permission']})})
    : route.continue());
  const ownThumb = attachments.locator(`._JX_thumb[data-attachment-id="${OWN_IMAGE.id}"]`);
  await ownThumb.hover();
  await ownThumb.getByRole('button', {name: `Delete ${OWN_IMAGE.filename}`}).click();
  await ownThumb.getByRole('group', {name: `Delete ${OWN_IMAGE.filename}?`}).getByRole('button', {name: 'Delete'}).click();
  await expect(page.getByTestId('jira-toast')).toContainText(`Jira did not allow deleting ${OWN_IMAGE.filename}`);
  await expect(ownThumb.getByRole('group')).toHaveCount(0);
  await expect(attachments.locator('._JX_thumb')).toHaveCount(4);
  await page.close();
});

test('file rows offer the same delete, and Escape cancels the confirmation without closing QuickView @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Attachment deletion writes are tested against the mock only.');
  await patchJsonResponse(extensionApp.context, target.instanceUrl, `/rest/api/2/issue/${target.primaryIssueKey}\\?[^#]+$`, payload => ({
    ...payload,
    fields: {
      ...payload.fields,
      attachment: [...(payload.fields?.attachment || []), {
        id: 'report-pdf',
        filename: 'release-report.pdf',
        mimeType: 'application/pdf',
        content: `${target.instanceUrl}/rest/api/2/attachment/content/report-pdf`,
        size: 24576,
        author: {accountId: 'user-me', displayName: 'Morgan Agent'},
      }],
    },
  }));
  const {page, attachments} = await openPopup({extensionApp, optionsPage, servers});
  const sent = deletes(page);
  const row = attachments.locator('._JX_attachment_file[data-attachment-id="report-pdf"]');
  await row.hover();
  await row.getByRole('button', {name: 'Delete release-report.pdf'}).click();
  const confirmation = row.getByRole('group', {name: 'Delete release-report.pdf?'});
  await expect(confirmation).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirmation).toHaveCount(0);
  await expect(page.locator('#_JX_title_link')).toBeVisible();
  expect(sent).toHaveLength(0);
  await page.close();
});
