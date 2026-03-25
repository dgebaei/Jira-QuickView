const {test, expect, configureExtension, hoverIssueKey, injectContentScript} = require('./helpers/extension-fixtures');
const {failWithJson, patchJsonResponse} = require('./helpers/jira-route-mocks');
const {buildExtensionConfig, requireJiraTestTarget, replaceIssueKeysOnPage, resolveTargetIssueKeys} = require('./helpers/test-targets');

function unreachableConfig(servers) {
  return {
    instanceUrl: 'http://127.0.0.1:9/',
    domains: [servers.allowedPage.origin],
    hoverDepth: 'shallow',
    hoverModifierKey: 'none',
    customFields: [],
  };
}

function reachableConfig(servers, target) {
  return buildExtensionConfig(servers, {customFields: []}, target);
}

async function openAllowedPage(extensionApp, servers, target) {
  const resolvedTarget = await resolveTargetIssueKeys(target);
  const page = await extensionApp.context.newPage();
  await page.goto(`${servers.allowedPage.origin}/popup-actions`);
  await replaceIssueKeysOnPage(page, [
    {from: 'JRACLOUD-97846', to: resolvedTarget.primaryIssueKey},
    {from: 'JRACLOUD-98123', to: resolvedTarget.secondaryIssueKey},
  ]);
  await injectContentScript(extensionApp, page);
  await expect.poll(async () => page.locator('._JX_container').count()).toBe(1);
  return {page, target: resolvedTarget};
}

test('surfaces a connection error when Jira is unreachable', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  await configureExtension(optionsPage, unreachableConfig(servers));
  const {page} = await openAllowedPage(extensionApp, servers, target);

  await hoverIssueKey(page, '#popup-key');
  await expect(page.locator('body')).toContainText('Could not reach Jira');
  await page.close();
});

test('does not render a popup when the user is not logged in and Jira returns 401', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('unauthorized');
  } else {
    await failWithJson(extensionApp.context, target.instanceUrl, '/rest/api/2/issue/[^?]+\\?.*$', 401, {errorMessages: ['Login required']});
  }
  await configureExtension(optionsPage, reachableConfig(servers, target));
  const {page} = await openAllowedPage(extensionApp, servers, target);

  await hoverIssueKey(page, '#popup-key');
  await expect(page.locator('._JX_container')).toBeEmpty();
  await page.close();
});

test('falls back to a read-only popup when Jira is viewable anonymously', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('anonymous-readonly');
  } else {
    await patchJsonResponse(extensionApp.context, target.instanceUrl, '/rest/api/2/issue/[^/]+/editmeta$', () => ({fields: {}}));
    await patchJsonResponse(extensionApp.context, target.instanceUrl, '/rest/api/2/issue/[^/]+/transitions$', () => ({transitions: []}));
  }
  await configureExtension(optionsPage, reachableConfig(servers, target));
  const {page, target: resolvedTarget} = await openAllowedPage(extensionApp, servers, target);

  await hoverIssueKey(page, '#popup-key');
  const popup = page.locator('._JX_container');
  await expect(popup).toContainText(resolvedTarget.primaryIssueKey);
  await expect(page.locator('._JX_actions_toggle')).toHaveCount(0);
  await expect(page.locator('button[data-field-key="priority"]')).toHaveCount(0);
  await page.close();
});
