const {test, expect, configureExtension, hoverIssueKey, injectContentScript} = require('./helpers/extension-fixtures');
const {buildExtensionConfig, requireJiraTestTarget, replaceIssueKeysOnPage, resolveTargetIssueKeys} = require('./helpers/test-targets');

function baseConfig(servers, target, overrides = {}) {
  return buildExtensionConfig(servers, overrides, target);
}

async function openAllowedPage(extensionApp, servers, target, route = '/popup-actions') {
  const resolvedTarget = await resolveTargetIssueKeys(target);
  const page = await extensionApp.context.newPage();
  await page.goto(`${servers.allowedPage.origin}${route}`);
  await replaceIssueKeysOnPage(page, [
    {from: 'JRACLOUD-97846', to: resolvedTarget.primaryIssueKey},
    {from: 'JRACLOUD-98123', to: resolvedTarget.secondaryIssueKey},
  ]);
  await injectContentScript(extensionApp, page);
  await expect.poll(async () => page.locator('._JX_container').count()).toBe(1);
  return {page, target: resolvedTarget};
}

test('injects only on configured domains', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: targetModeRequiresAuth()});
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page: allowed} = await openAllowedPage(extensionApp, servers, target, '/');
  const disallowed = await extensionApp.context.newPage();
  await disallowed.goto(`${servers.disallowedPage.origin}/`);

  await expect.poll(async () => allowed.locator('._JX_container').count()).toBe(1);
  await expect.poll(async () => disallowed.locator('._JX_container').count()).toBe(0);

  await allowed.close();
  await disallowed.close();
});

test('respects exact, shallow, and deep hover detection modes', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: targetModeRequiresAuth()});
  await configureExtension(optionsPage, baseConfig(servers, target, {hoverDepth: 'exact'}));
  let result = await openAllowedPage(extensionApp, servers, target, '/hover-depth');
  let page = result.page;
  const resolvedTarget = result.target;
  await hoverIssueKey(page, '#exact-target');
  await expect(page.locator('._JX_container')).toContainText(resolvedTarget.primaryIssueKey);
  await page.keyboard.press('Escape');
  await hoverIssueKey(page, '#shallow-child');
  await expect(page.locator('._JX_container')).toBeEmpty();
  await page.close();

  await optionsPage.goto(`chrome-extension://${extensionApp.extensionId}/options/options.html`);
  await configureExtension(optionsPage, baseConfig(servers, target, {hoverDepth: 'shallow'}));
  result = await openAllowedPage(extensionApp, servers, target, '/hover-depth');
  page = result.page;
  await hoverIssueKey(page, '#shallow-child');
  await expect(page.locator('._JX_container')).toContainText(resolvedTarget.primaryIssueKey);
  await page.keyboard.press('Escape');
  await page.close();

  await optionsPage.goto(`chrome-extension://${extensionApp.extensionId}/options/options.html`);
  await configureExtension(optionsPage, baseConfig(servers, target, {hoverDepth: 'deep'}));
  result = await openAllowedPage(extensionApp, servers, target, '/hover-depth');
  page = result.page;
  await hoverIssueKey(page, '#deep-child');
  await expect(page.locator('._JX_container')).toContainText(resolvedTarget.primaryIssueKey);
  await page.close();
});

test('requires the configured modifier key before opening the popup', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: targetModeRequiresAuth()});
  await configureExtension(optionsPage, baseConfig(servers, target, {hoverModifierKey: 'shift'}));
  const {page, target: resolvedTarget} = await openAllowedPage(extensionApp, servers, target, '/popup-actions');

  await hoverIssueKey(page, '#popup-key');
  await expect(page.locator('._JX_container')).toBeEmpty();

  await hoverIssueKey(page, '#popup-key', 'Shift');
  await expect(page.locator('._JX_container')).toContainText(resolvedTarget.primaryIssueKey);
  await page.close();
});

test('supports pinning and closing the popup', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: targetModeRequiresAuth()});
  await configureExtension(optionsPage, baseConfig(servers, target));
  const {page, target: resolvedTarget} = await openAllowedPage(extensionApp, servers, target, '/popup-actions');

  await hoverIssueKey(page, '#popup-key');
  const popup = page.locator('._JX_container');
  await expect(popup).toContainText(resolvedTarget.primaryIssueKey);

  await page.locator('._JX_pin_button').click();
  await expect(page.locator('body')).toContainText(/Pinned/i);

  await page.mouse.move(5, 5);
  await expect(popup).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(popup).toBeEmpty();
  await page.close();
});

function targetModeRequiresAuth() {
  return process.env.MOCK === 'false';
}
