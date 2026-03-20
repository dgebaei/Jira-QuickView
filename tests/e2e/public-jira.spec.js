const {test, expect, configureExtension, hoverIssueKey, injectContentScript} = require('./helpers/extension-fixtures');

async function openPublicPage(extensionApp, url) {
  const page = await extensionApp.context.newPage();
  await page.goto(url, {waitUntil: 'domcontentloaded'});
  await injectContentScript(extensionApp, page);
  await expect.poll(async () => page.locator('._JX_container').count()).toBe(1);
  return page;
}

async function openPublicPageOrSkip(playwrightTest, extensionApp, url) {
  try {
    return await openPublicPage(extensionApp, url);
  } catch (error) {
    const message = String(error?.message || error);
    playwrightTest.skip(message.includes('ERR_INTERNET_DISCONNECTED'), 'Public Jira smoke tests require outbound internet access.');
    throw error;
  }
}

test('loads a popup on the public Atlassian issue page @public', async ({extensionApp, optionsPage}) => {
  test.skip(process.env.RUN_PUBLIC_JIRA_TESTS !== '1', 'Set RUN_PUBLIC_JIRA_TESTS=1 to run live public Jira smoke tests.');

  await configureExtension(optionsPage, {
    instanceUrl: 'https://jira.atlassian.com/',
    domains: ['https://jira.atlassian.com/'],
    hoverDepth: 'shallow',
    hoverModifierKey: 'none',
    customFields: [],
  }, true);

  const page = await openPublicPageOrSkip(test, extensionApp, 'https://jira.atlassian.com/browse/JRACLOUD-97846');
  const issueLink = page.locator('#key-val, a[href="/browse/JRACLOUD-97846"]').first();

  await issueLink.hover();
  await expect(page.locator('._JX_container')).toContainText('JRACLOUD-97846');
  await page.close();
});

test('loads a popup from the public Atlassian search results page @public', async ({extensionApp, optionsPage}) => {
  test.skip(process.env.RUN_PUBLIC_JIRA_TESTS !== '1', 'Set RUN_PUBLIC_JIRA_TESTS=1 to run live public Jira smoke tests.');

  await configureExtension(optionsPage, {
    instanceUrl: 'https://jira.atlassian.com/',
    domains: ['https://jira.atlassian.com/'],
    hoverDepth: 'shallow',
    hoverModifierKey: 'none',
    customFields: [],
  }, true);

  const page = await openPublicPageOrSkip(test, extensionApp, 'https://jira.atlassian.com/issues/?jql=project%3DJRACLOUD%20AND%20type%3DBug%20AND%20statusCategory!%3DDone%20ORDER%20BY%20updated');
  const issueLink = page.locator('a[href^="/browse/"]').filter({hasText: /^[A-Z][A-Z0-9_]+-\d+$/}).first();
  await expect(issueLink).toBeVisible();
  const issueKey = String((await issueLink.textContent()) || '').trim();
  await issueLink.hover();
  await expect(page.locator('._JX_container')).toContainText(issueKey);
  await page.close();
});
