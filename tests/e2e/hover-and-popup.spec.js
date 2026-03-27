const {test, expect, configureExtension, hoverIssueKey, injectContentScript} = require('./helpers/extension-fixtures');
const {popupModel} = require('./helpers/popup');
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

test('does not open the popup from a stale pending hover while typing', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: targetModeRequiresAuth()});
  await configureExtension(optionsPage, baseConfig(servers, target, {hoverModifierKey: 'shift'}));
  const {page} = await openAllowedPage(extensionApp, servers, target, '/modifier-input');

  await hoverIssueKey(page, '#sidebar-key');
  await expect(page.locator('._JX_container')).toBeEmpty();

  await page.locator('#subject-input').click();
  await page.keyboard.press('Shift');
  await expect(page.locator('._JX_container')).toBeEmpty();

  await page.close();
});

test('does not open the popup when the pointer has moved away before pressing the modifier', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: targetModeRequiresAuth()});
  await configureExtension(optionsPage, baseConfig(servers, target, {hoverModifierKey: 'shift'}));
  const {page} = await openAllowedPage(extensionApp, servers, target, '/modifier-input');

  await hoverIssueKey(page, '#sidebar-key');
  await expect(page.locator('._JX_container')).toBeEmpty();

  await page.locator('#subject-input').hover();
  await page.keyboard.press('Shift');
  await expect(page.locator('._JX_container')).toBeEmpty();

  await page.close();
});

test('clears a stale pending Jira key when moving to a non-resolvable row before pressing the modifier', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: targetModeRequiresAuth(), minimumIssueCount: 2});
  await configureExtension(optionsPage, baseConfig(servers, target, {hoverModifierKey: 'shift', hoverDepth: 'exact'}));
  const {page} = await openAllowedPage(extensionApp, servers, target, '/repeated-key-list');

  await hoverIssueKey(page, '#repeated-row-1-subject');
  await expect(page.locator('._JX_container')).toBeEmpty();

  const countBox = await page.locator('#repeated-row-2-count').boundingBox();
  await page.mouse.move(Math.round(countBox.x + (countBox.width / 2)), Math.round(countBox.y + (countBox.height / 2)));
  await expect(page.locator('._JX_container')).toBeEmpty();
  await page.waitForTimeout(150);

  await page.keyboard.press('Shift');
  await expect(page.locator('._JX_container')).toBeEmpty();

  await page.close();
});

test('supports pinning and closing the popup', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: targetModeRequiresAuth()});
  await configureExtension(optionsPage, baseConfig(servers, target));
  const {page, target: resolvedTarget} = await openAllowedPage(extensionApp, servers, target, '/popup-actions');

  await hoverIssueKey(page, '#popup-key');
  const popup = popupModel(page).root;
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
