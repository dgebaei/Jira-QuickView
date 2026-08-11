const path = require('path');
const {test, expect, configureExtension, injectContentScript} = require('./helpers/extension-fixtures');
const {buildExtensionConfig, requireJiraTestTarget} = require('./helpers/test-targets');
const {optionsPageModel} = require('./helpers/options-page');

const screenshotDir = String(process.env.JHL_CAPTURE_INLINE_COPY_SCREENSHOTS || '').trim();

async function captureInlineCopyScreenshot(locator, fileName) {
  if (!screenshotDir) {
    return;
  }
  await locator.screenshot({path: path.join(screenshotDir, fileName)});
}

test('activates inline copy on the configured Jira instance even when it is not an allowed hover page @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Inline Jira UI coverage is deterministic in mocked mode only.');
  const form = optionsPageModel(optionsPage);

  await configureExtension(optionsPage, buildExtensionConfig(servers, {
    domains: [servers.allowedPage.origin],
  }, target));
  await optionsPage.reload();
  await optionsPage.getByTestId('options-theme-mode-dark').click();
  await form.saveButton.click();
  await expect(form.saveNotice).toContainText('Options saved successfully.');

  const page = await extensionApp.context.newPage();
  await page.goto(`${servers.jira.origin}/browse/${target.primaryIssueKey}`);
  await expect(page.getByRole('button', {name: `Copy ${target.primaryIssueKey} issue link`})).toBeVisible();
  await page.close();
});

test('copies an issue reference from the Jira Cloud issue header @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Inline Jira UI coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, buildExtensionConfig(servers, {
    domains: [servers.jira.origin],
  }, target));

  const page = await extensionApp.context.newPage();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {origin: servers.jira.origin});
  await page.goto(`${servers.jira.origin}/browse/${target.primaryIssueKey}`);
  await injectContentScript(extensionApp, page);

  const copyButton = page.getByRole('button', {name: `Copy ${target.primaryIssueKey} issue link`});
  await expect(copyButton).toBeVisible();
  await copyButton.hover();
  await captureInlineCopyScreenshot(page.locator('main'), 'jira-inline-copy-cloud-detail.png');
  await copyButton.click();

  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    `${servers.jira.origin}/browse/${target.primaryIssueKey}`
  );
  const copiedHtml = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    return (await item.getType('text/html')).text();
  });
  expect(copiedHtml).toContain(`[${target.primaryIssueKey}] Pressing END removes non-command text`);
  await expect(page.locator('._JX_snack')).toContainText('Copied!');

  await page.close();
});

test('adds one copy button per Jira result and follows SPA additions @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Inline Jira UI coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, buildExtensionConfig(servers, {
    domains: [servers.jira.origin],
  }, target));

  const page = await extensionApp.context.newPage();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {origin: servers.jira.origin});
  await page.goto(`${servers.jira.origin}/issues/`);
  await injectContentScript(extensionApp, page);

  const copyButtons = page.locator('._JX_inline_copy_button');
  await expect(copyButtons).toHaveCount(3);
  await expect(page.getByRole('button', {name: 'Copy JRACLOUD-98123 issue link'})).toHaveCSS('opacity', '0');
  await page.locator('[data-issue-key="JRACLOUD-98123"]').hover();
  const secondCopyButton = page.getByRole('button', {name: 'Copy JRACLOUD-98123 issue link'});
  await expect(secondCopyButton).toHaveCSS('opacity', '1');
  await captureInlineCopyScreenshot(page.locator('main'), 'jira-inline-copy-search-results.png');
  await secondCopyButton.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    `${servers.jira.origin}/browse/JRACLOUD-98123`
  );

  await page.evaluate(() => {
    const row = document.createElement('article');
    row.className = 'issue-row';
    row.dataset.issueKey = 'PLATFORM-101';
    row.innerHTML = '<span class="issue-key-cell"><a class="issue-key" href="/browse/PLATFORM-101">PLATFORM-101</a></span><a class="issue-summary" href="/browse/PLATFORM-101">Cross-project platform initiative</a><span class="status">To Do</span>';
    document.querySelector('#issue-results').appendChild(row);
  });
  await expect(copyButtons).toHaveCount(4);

  await page.evaluate(() => {
    document.querySelector('#issue-results').appendChild(document.createTextNode(' '));
  });
  await expect(copyButtons).toHaveCount(4);

  await page.evaluate(() => {
    const row = document.querySelector('[data-issue-key="JRACLOUD-97846"]');
    row.dataset.issueKey = 'JRACLOUD-97847';
    const keyLink = row.querySelector('.issue-key');
    keyLink.href = '/browse/JRACLOUD-97847';
    keyLink.textContent = 'JRACLOUD-97847';
    const summaryLink = row.querySelector('.issue-summary');
    summaryLink.href = '/browse/JRACLOUD-97847';
    summaryLink.textContent = 'Stabilize slash command parsing';
  });
  await expect(page.getByRole('button', {name: 'Copy JRACLOUD-97847 issue link'})).toHaveCount(1);
  await expect(page.getByRole('button', {name: 'Copy JRACLOUD-97846 issue link'})).toHaveCount(0);
  await expect(copyButtons).toHaveCount(4);
  await page.close();
});

test('adds copy buttons to Jira board cards without issue links @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Inline Jira UI coverage is deterministic in mocked mode only.');

  await configureExtension(optionsPage, buildExtensionConfig(servers, {
    domains: [servers.jira.origin],
  }, target));

  const page = await extensionApp.context.newPage();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {origin: servers.jira.origin});
  await page.goto(`${servers.jira.origin}/jira/software/projects/JRACLOUD/boards/77`);
  await injectContentScript(extensionApp, page);

  const card = page.locator('[data-issue-key="JRACLOUD-97000"]');
  await card.hover();
  const copyButton = page.getByRole('button', {name: 'Copy JRACLOUD-97000 issue link'});
  await expect(copyButton).toBeVisible();
  await captureInlineCopyScreenshot(page.locator('main'), 'jira-inline-copy-board.png');
  await copyButton.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    `${servers.jira.origin}/browse/JRACLOUD-97000`
  );
  await page.close();
});

test('does not add Jira copy buttons when the preference is disabled @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Inline Jira UI coverage is deterministic in mocked mode only.');

  await configureExtension(optionsPage, buildExtensionConfig(servers, {
    domains: [servers.jira.origin],
    inlineCopyButtons: false,
  }, target));

  const page = await extensionApp.context.newPage();
  await page.goto(`${servers.jira.origin}/browse/${target.primaryIssueKey}`);
  await injectContentScript(extensionApp, page);
  await expect(page.locator('._JX_inline_copy_button')).toHaveCount(0);
  await page.close();
});

test('copies from the Jira Data Center issue header with its context path @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Inline Jira UI coverage is deterministic in mocked mode only.');
  const instanceUrl = `${servers.jira.origin}/jira/`;

  await configureExtension(optionsPage, buildExtensionConfig(servers, {
    instanceUrl,
    domains: [servers.jira.origin],
  }, target));

  const page = await extensionApp.context.newPage();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {origin: servers.jira.origin});
  await page.goto(`${instanceUrl}browse/${target.primaryIssueKey}`);
  await injectContentScript(extensionApp, page);

  const copyButton = page.getByRole('button', {name: `Copy ${target.primaryIssueKey} issue link`});
  await expect(copyButton).toBeVisible();
  await copyButton.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    `${instanceUrl}browse/${target.primaryIssueKey}`
  );

  const childIssueKey = 'JRACLOUD-97847';
  const childrenJqlLink = page.getByTestId('jira-dc-children-jql-link');
  await expect(childrenJqlLink).toBeVisible();
  const childrenJqlUrl = new URL(await childrenJqlLink.getAttribute('href'));
  expect(childrenJqlUrl.pathname).toBe('/jira/issues/');
  expect(childrenJqlUrl.searchParams.get('jql')).toBe(`"Epic Link" = "${target.primaryIssueKey}"`);

  const childCopyButton = page.getByRole('button', {name: `Copy ${childIssueKey} issue link`});
  await expect(childCopyButton).toBeVisible();
  await childCopyButton.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    `${instanceUrl}browse/${childIssueKey}`
  );

  const screenshotPath = String(process.env.JHL_CAPTURE_JIRA_DC_CHILDREN_SCREENSHOT || '').trim();
  if (screenshotPath) {
    await page.locator('#greenhopper-epics-issue-web-panel').screenshot({path: screenshotPath});
  }
  await page.close();
});
