const fs = require('fs/promises');
const path = require('path');
const {test, expect, configureExtension, hoverIssueKey, injectContentScript} = require('./helpers/extension-fixtures');
const {buildExtensionConfig, requireJiraTestTarget} = require('./helpers/test-targets');

async function openPopup({extensionApp, optionsPage, servers}, scenario = 'shortcut-planning') {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Keyboard workflow writes are tested against the mock only.');
  await servers.jira.setScenario(scenario);
  await configureExtension(optionsPage, buildExtensionConfig(servers, {hoverModifierKey: 'none', hoverActivationMode: 'automatic'}, target));
  const page = await extensionApp.context.newPage();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {origin: servers.allowedPage.origin});
  await page.goto(`${servers.allowedPage.origin}/popup-actions`);
  await injectContentScript(extensionApp, page);
  await hoverIssueKey(page, '#popup-key');
  await expect(page.locator('#_JX_title_link')).toContainText(target.primaryIssueKey);
  const popup = page.getByTestId('jira-popup-root');
  await popup.focus();
  return {page, popup, target, dialog: page.getByTestId('jira-shortcut-dialog')};
}

async function screenshot(page, name) {
  const directory = process.env.JQV_SHORTCUT_SCREENSHOTS;
  if (!directory) return;
  await fs.mkdir(directory, {recursive: true});
  await page.screenshot({path: path.join(directory, `${name}.png`)});
}

test('Alt+0 and the toolbar button show fixed shortcuts; Escape returns focus without closing QuickView @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, popup, dialog} = await openPopup({extensionApp, optionsPage, servers});
  await page.keyboard.press('Alt+0');
  await expect(dialog).toContainText('Keyboard shortcuts');
  await expect(dialog.getByRole('row')).toHaveCount(9);
  await expect(dialog.locator('._JX_inline_copy_button')).toHaveCount(0);
  await screenshot(page, 'shortcut-help');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(popup).toBeFocused();
  await expect(page.locator('#_JX_title_link')).toBeVisible();
  await page.getByTestId('jira-popup-shortcuts-help').click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('#_JX_title_link')).toHaveCount(0);
  await page.close();
});

test('numbers and Alt numbers leave host inputs and popup comment text alone @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, popup, dialog} = await openPopup({extensionApp, optionsPage, servers});
  await page.keyboard.press('5');
  const comment = page.locator('._JX_comment_input');
  await expect(comment).toBeFocused();
  await page.keyboard.type('1234567');
  await page.keyboard.press('Alt+3');
  await expect(comment).toHaveValue('1234567');
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'host-input';
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.type('123');
  await page.keyboard.press('Alt+0');
  await expect(page.locator('#host-input')).toHaveValue('123');
  await expect(dialog).toHaveCount(0);
  await popup.focus();
  await page.keyboard.press('Control+3');
  await expect(dialog).toHaveCount(0);
  await page.close();
});

test('2 stages both changes, supports assignee search, and Escape or backdrop cancels without writes @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, popup, dialog} = await openPopup({extensionApp, optionsPage, servers});
  const writes = [];
  page.context().on('request', request => { if (['PUT', 'POST'].includes(request.method()) && /\/issue\/[^/]+(?:\/assignee)?$/.test(new URL(request.url()).pathname)) writes.push(request); });
  await page.keyboard.press('2');
  const search = page.getByTestId('jira-shortcut-assignee');
  await expect(search).toBeFocused();
  await search.fill('Alex');
  await expect(dialog.getByRole('option', {name: /Alex/})).toBeVisible();
  await screenshot(page, 'plan-and-assign');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(popup).toBeFocused();
  expect(writes).toHaveLength(0);
  await page.keyboard.press('2');
  await expect(search).toBeFocused();
  await page.mouse.click(2, 2);
  await expect(dialog).toHaveCount(0);
  expect(writes).toHaveLength(0);
  await page.close();
});

test('2 confirms sprint and typed assignee with one PUT and refreshes the popup @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, dialog, target} = await openPopup({extensionApp, optionsPage, servers});
  await page.keyboard.press('2');
  const search = page.getByTestId('jira-shortcut-assignee');
  await expect(search).toBeFocused();
  await search.fill('Alex');
  await expect(dialog.getByRole('option', {name: /Alex/})).toBeVisible();
  const requestPromise = page.context().waitForEvent('request', request => request.method() === 'PUT' && request.url() === `${target.instanceUrl}/rest/api/2/issue/${target.primaryIssueKey}`);
  await search.press('Enter');
  const request = await requestPromise;
  expect(request.postDataJSON()).toMatchObject({fields: {assignee: {accountId: expect.any(String)}, customfield_10020: 42}});
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('._JX_title_user_assignee')).toHaveAttribute('title', /Alex/);
  await page.close();
});

test('Alt+2 stages assign-to-me and only sends after confirmation @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, dialog, target} = await openPopup({extensionApp, optionsPage, servers});
  await page.keyboard.press('Alt+2');
  await expect(dialog).toContainText('Assign to:');
  await expect(page.getByTestId('jira-shortcut-submit')).toBeFocused();
  const requestPromise = page.context().waitForEvent('request', request => request.method() === 'PUT' && request.url() === `${target.instanceUrl}/rest/api/2/issue/${target.primaryIssueKey}`);
  await page.keyboard.press('Enter');
  const request = await requestPromise;
  expect(request.postDataJSON().fields.customfield_10020).toBe(42);
  await expect(dialog).toHaveCount(0);
  await page.close();
});

test('3 requires resolution and comment, remembers explicit defaults; Alt+3 prefills but does not submit @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, popup, dialog, target} = await openPopup({extensionApp, optionsPage, servers}, 'shortcut-resolution');
  const transitions = [];
  page.context().on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/transitions')) transitions.push(request.postDataJSON()); });
  await page.keyboard.press('3');
  const resolution = page.getByTestId('jira-shortcut-resolutionId');
  await expect(resolution).toBeVisible();
  await expect(resolution).toHaveValue('');
  await page.getByTestId('jira-shortcut-submit').click();
  expect(transitions).toHaveLength(0);
  await resolution.selectOption('1');
  await page.getByTestId('jira-shortcut-submit').click();
  expect(transitions).toHaveLength(0);
  await page.getByTestId('jira-shortcut-comment').fill('Verified fixed');
  await page.getByTestId('jira-shortcut-remember').check();
  await page.getByTestId('jira-shortcut-useDot').check();
  await screenshot(page, 'resolve-confirmation');
  expect(transitions).toHaveLength(0);
  await page.getByTestId('jira-shortcut-submit').click();
  await expect(dialog).toHaveCount(0);
  expect(transitions).toEqual([{transition: {id: '41'}, fields: {resolution: {id: '1'}}, update: {comment: [{add: {body: 'Verified fixed'}}]}}]);
  const presets = await optionsPage.evaluate(async () => (await chrome.storage.local.get('jqv.quickClosePresets'))['jqv.quickClosePresets']);
  expect(Object.values(presets)).toEqual([{transitionId: '41', resolutionId: '1', useDot: true}]);
  await expect(page.getByTestId('jira-popup-field-status')).toContainText('Done');
  // Mock exposes the transition again so we can exercise the saved preset without reopening the browser.
  await popup.focus();
  await page.keyboard.press('Alt+3');
  await expect(resolution).toHaveValue('1');
  await expect(page.getByTestId('jira-shortcut-comment')).toHaveValue('.');
  await expect(page.locator('._JX_snack ._JX_inline_copy_button')).toHaveCount(0);
  await expect(page.getByTestId('jira-shortcut-submit')).toBeFocused();
  expect(transitions).toHaveLength(1);
  await screenshot(page, 'quick-close-defaults');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(popup).toBeFocused();
  await expect(page.locator('#_JX_title_link')).toBeVisible();
  expect(transitions).toHaveLength(1);
  await page.keyboard.press('Alt+3');
  await expect(page.getByTestId('jira-shortcut-submit')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  expect(transitions).toHaveLength(2);
  expect(transitions[1]).toEqual({transition: {id: '41'}, fields: {resolution: {id: '1'}}, update: {comment: [{add: {body: '.'}}]}});
  expect(target.mode).toBe('mock');
  await page.close();
});

test('Escape cancels a loading workflow and its late response cannot replace shortcut help @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, dialog} = await openPopup({extensionApp, optionsPage, servers});
  let release;
  let received;
  const held = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { received = resolve; });
  await page.context().route('**/transitions?expand=*', async route => {
    received();
    await held;
    await route.continue();
  });
  try {
    await page.keyboard.press('3');
    await requested;
    await expect(dialog).toContainText('Loading');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press('Alt+0');
    await expect(dialog.getByRole('heading')).toHaveText('Keyboard shortcuts');
    const response = page.context().waitForEvent('response', response => response.url().includes('/transitions?expand='));
    release();
    await response;
    await expect(dialog.getByRole('row')).toHaveCount(9);
    await expect(page.getByTestId('jira-shortcut-submit')).toHaveCount(0);
  } finally { release(); }
  await page.close();
});

test('readonly issues explain unavailable completion without offering a submit button @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, dialog} = await openPopup({extensionApp, optionsPage, servers}, 'readonly');
  await page.keyboard.press('3');
  await expect(dialog).toContainText('No completion transition is available');
  await expect(dialog.getByRole('button', {name: 'Open in Jira'})).toBeVisible();
  await expect(page.getByTestId('jira-shortcut-submit')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.close();
});

test('saving blocks repeated Enter and Escape; failure remains safely retryable @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, dialog, target} = await openPopup({extensionApp, optionsPage, servers});
  const endpoint = `${target.instanceUrl}/rest/api/2/issue/${target.primaryIssueKey}`;
  let release;
  let received;
  const held = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { received = resolve; });
  let writes = 0;
  await page.context().route(endpoint, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    writes += 1;
    if (writes > 1) return route.continue();
    received();
    await held;
    await route.fulfill({status: 400, contentType: 'application/json', body: JSON.stringify({errorMessages: ['Workflow rejected update']})});
  });
  try {
    await page.keyboard.press('Alt+2');
    await expect(page.getByTestId('jira-shortcut-submit')).toBeFocused();
    await page.keyboard.press('Enter');
    await requested;
    await expect(dialog).toContainText('Saving');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    expect(writes).toBe(1);
    release();
    await expect(dialog).toContainText('HTTP 400');
    await expect(page.getByTestId('jira-shortcut-submit')).toBeEnabled();
    await page.getByTestId('jira-shortcut-submit').click();
    await expect(dialog).toHaveCount(0);
    expect(writes).toBe(2);
  } finally { release(); }
  await page.close();
});

test('shortcut help fits a narrow viewport and follows dark mode @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, dialog} = await openPopup({extensionApp, optionsPage, servers});
  await page.setViewportSize({width: 390, height: 700});
  await page.evaluate(() => document.documentElement.setAttribute('data-jhl-theme', 'dark'));
  await page.keyboard.press('Alt+0');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', {name: 'Keyboard shortcuts'})).toBeInViewport();
  const dimensions = await dialog.evaluate(element => ({width: element.getBoundingClientRect().width, scroll: element.scrollWidth, client: element.clientWidth}));
  expect(dimensions.width).toBeLessThan(390);
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
  await screenshot(page, 'shortcut-help-narrow-dark');
  await page.keyboard.press('Escape');
  await page.close();
});

test('1 opens existing assignee picker; Alt+1 assigns to me @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, popup} = await openPopup({extensionApp, optionsPage, servers});
  await page.keyboard.press('1');
  await expect(page.getByTestId('jira-popup-edit-input-assignee')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('jira-popup-edit-input-assignee')).toHaveCount(0);
  await popup.focus();
  const requestPromise = page.context().waitForEvent('request', request => request.method() === 'PUT' && request.url().endsWith('/assignee'));
  await page.keyboard.press('Alt+1');
  await requestPromise;
  await expect(page.locator('._JX_action_notice')).toContainText('Assigned to you');
  await page.close();
});

test('4 opens status picker; Alt+4 reviews an in-progress transition before submitting @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, popup, dialog} = await openPopup({extensionApp, optionsPage, servers});
  await page.keyboard.press('4');
  await expect(page.getByTestId('jira-popup-edit-input-status')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('jira-popup-edit-input-status')).toHaveCount(0);
  await popup.focus();
  await page.keyboard.press('Alt+4');
  await expect(dialog).toContainText('Start progress');
  await expect(page.getByTestId('jira-shortcut-submit')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('jira-popup-field-status')).toContainText('In Progress');
  await page.close();
});

test('6 copies a reference, Alt+6 copies the URL, and 7 opens Jira in a tab @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, popup, target} = await openPopup({extensionApp, optionsPage, servers});
  await page.bringToFront();
  const url = `${target.instanceUrl}/browse/${target.primaryIssueKey}`;
  await page.keyboard.press('6');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  await popup.focus();
  await page.keyboard.press('Alt+6');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  const opened = page.context().waitForEvent('page');
  await page.keyboard.press('7');
  const jira = await opened;
  await expect(jira).toHaveURL(url);
  await jira.close();
  await page.close();
});
