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
  return {page, popup, target, dialog: page.getByTestId('jira-shortcut-dialog'), help: page.getByTestId('jira-shortcut-help')};
}

async function screenshot(page, name) {
  const directory = process.env.JQV_SHORTCUT_SCREENSHOTS;
  if (!directory) return;
  await fs.mkdir(directory, {recursive: true});
  await page.screenshot({path: path.join(directory, `${name}.png`)});
}

test('Alt+0 and the toolbar button drop down fixed shortcuts; Escape returns focus without closing QuickView @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, popup, dialog, help} = await openPopup({extensionApp, optionsPage, servers});
  const toggle = page.getByTestId('jira-popup-shortcuts-help');
  await expect(page.getByTestId('jira-popup-actions-toggle')).toHaveCount(0);
  await expect(page.locator('._JX_title_controls ._JX_control_button')).toHaveClass([/_JX_title_copy/, /_JX_pin_button/, /_JX_shortcuts_help/, /_JX_close_button/]);
  await page.keyboard.press('Alt+0');
  await expect(help).toBeVisible();
  await expect(help.getByRole('heading')).toHaveText('Keyboard shortcuts');
  await expect(help.getByRole('row')).toHaveCount(10);
  await expect(help.locator('._JX_inline_copy_button')).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  await expect(popup).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const [panelBox, toggleBox] = [await help.boundingBox(), await toggle.boundingBox()];
  expect(panelBox.y).toBeGreaterThanOrEqual(toggleBox.y + toggleBox.height);
  expect(Math.abs((panelBox.x + panelBox.width) - (toggleBox.x + toggleBox.width))).toBeLessThanOrEqual(1);
  await screenshot(page, 'shortcut-help');
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  await expect(popup).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#_JX_title_link')).toBeVisible();
  await toggle.click();
  await expect(help).toBeVisible();
  await toggle.click();
  await expect(help).toBeHidden();
  await toggle.click();
  await expect(help).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(help).toBeHidden();
  await popup.focus();
  await page.keyboard.press('Alt+0');
  await expect(help).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('#_JX_title_link')).toHaveCount(0);
  await expect(help).toBeHidden();
  await page.close();
});

test('a shortcut pressed while the help is open closes it and runs @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, help} = await openPopup({extensionApp, optionsPage, servers});
  await page.keyboard.press('Alt+0');
  await expect(help).toBeVisible();
  await page.keyboard.press('7');
  await expect(help).toBeHidden();
  await expect(page.locator('._JX_comment_input')).toBeFocused();
  await page.close();
});

test('numbers and Alt numbers leave host inputs and popup comment text alone @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, popup, dialog} = await openPopup({extensionApp, optionsPage, servers});
  await page.keyboard.press('7');
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
  await expect(page.getByTestId('jira-shortcut-help')).toBeHidden();
  await popup.focus();
  await page.keyboard.press('Control+3');
  await expect(dialog).toHaveCount(0);
  await page.close();
});

test('5 stages both changes, supports assignee search, and Escape or backdrop cancels without writes @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, popup, dialog} = await openPopup({extensionApp, optionsPage, servers});
  const writes = [];
  page.context().on('request', request => { if (['PUT', 'POST'].includes(request.method()) && /\/issue\/[^/]+(?:\/assignee)?$/.test(new URL(request.url()).pathname)) writes.push(request); });
  await page.keyboard.press('5');
  const search = page.getByTestId('jira-shortcut-assignee');
  await expect(search).toBeFocused();
  await search.fill('Alex');
  await expect(dialog.getByRole('option', {name: /Alex/})).toBeVisible();
  await screenshot(page, 'plan-and-assign');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(popup).toBeFocused();
  expect(writes).toHaveLength(0);
  await page.keyboard.press('5');
  await expect(search).toBeFocused();
  await page.mouse.click(2, 2);
  await expect(dialog).toHaveCount(0);
  expect(writes).toHaveLength(0);
  await page.close();
});

test('5 confirms sprint and typed assignee with one PUT and refreshes the popup @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, dialog, target} = await openPopup({extensionApp, optionsPage, servers});
  await page.keyboard.press('5');
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

test('Alt+5 stages assign-to-me and only sends after confirmation @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, dialog, target} = await openPopup({extensionApp, optionsPage, servers});
  await page.keyboard.press('Alt+5');
  await expect(dialog).toContainText('Assign to:');
  await expect(page.getByTestId('jira-shortcut-submit')).toBeFocused();
  const requestPromise = page.context().waitForEvent('request', request => request.method() === 'PUT' && request.url() === `${target.instanceUrl}/rest/api/2/issue/${target.primaryIssueKey}`);
  await page.keyboard.press('Enter');
  const request = await requestPromise;
  expect(request.postDataJSON().fields.customfield_10020).toBe(42);
  await expect(dialog).toHaveCount(0);
  await page.close();
});

test('Alt+3 requires resolution and comment, remembers explicit defaults, then prefills them but does not submit @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, popup, dialog, target} = await openPopup({extensionApp, optionsPage, servers}, 'shortcut-resolution');
  const transitions = [];
  page.context().on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/transitions')) transitions.push(request.postDataJSON()); });
  await page.keyboard.press('Alt+3');
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
  await expect(page.locator('._JX_toast ._JX_inline_copy_button')).toHaveCount(0);
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
    await page.keyboard.press('Alt+3');
    await requested;
    await expect(dialog).toContainText('Loading');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press('Alt+0');
    const help = page.getByTestId('jira-shortcut-help');
    await expect(help.getByRole('heading')).toHaveText('Keyboard shortcuts');
    const response = page.context().waitForEvent('response', response => response.url().includes('/transitions?expand='));
    release();
    await response;
    await expect(help.getByRole('row')).toHaveCount(10);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('jira-shortcut-submit')).toHaveCount(0);
  } finally { release(); }
  await page.close();
});

test('readonly issues explain unavailable completion without offering a submit button @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, dialog} = await openPopup({extensionApp, optionsPage, servers}, 'readonly');
  await page.keyboard.press('Alt+3');
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
    await page.keyboard.press('Alt+5');
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
  const {page, help} = await openPopup({extensionApp, optionsPage, servers});
  await page.setViewportSize({width: 390, height: 700});
  await page.evaluate(() => document.documentElement.setAttribute('data-jhl-theme', 'dark'));
  await page.keyboard.press('Alt+0');
  await expect(help).toBeVisible();
  await expect(help.getByRole('heading', {name: 'Keyboard shortcuts'})).toBeInViewport();
  const dimensions = await help.evaluate(element => ({
    left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
    scroll: element.scrollWidth, client: element.clientWidth, background: getComputedStyle(element).backgroundColor,
  }));
  expect(dimensions.left).toBeGreaterThanOrEqual(0);
  expect(dimensions.right).toBeLessThanOrEqual(390);
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
  expect(dimensions.background).not.toBe('rgb(255, 255, 255)');
  await screenshot(page, 'shortcut-help-narrow-dark');
  await page.keyboard.press('Escape');
  await page.close();
});

test('1 and A open the assignee picker; Alt+1 assigns to me @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, popup} = await openPopup({extensionApp, optionsPage, servers});
  await page.keyboard.press('1');
  await expect(page.getByTestId('jira-popup-edit-input-assignee')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('jira-popup-edit-input-assignee')).toHaveCount(0);
  await popup.focus();
  await page.keyboard.press('a');
  await expect(page.getByTestId('jira-popup-edit-input-assignee')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('jira-popup-edit-input-assignee')).toHaveCount(0);
  await popup.focus();
  const requestPromise = page.context().waitForEvent('request', request => request.method() === 'PUT' && request.url().endsWith('/assignee'));
  await page.keyboard.press('Alt+1');
  await requestPromise;
  await expect(page.getByTestId('jira-toast')).toContainText('Assigned to you');
  await page.close();
});

test('3 opens status picker; Alt+3 opens resolve / close @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, popup, dialog} = await openPopup({extensionApp, optionsPage, servers});
  await page.keyboard.press('3');
  await expect(page.getByTestId('jira-popup-edit-input-status')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('jira-popup-edit-input-status')).toHaveCount(0);
  await popup.focus();
  await page.keyboard.press('Alt+3');
  await expect(dialog.getByRole('heading')).toHaveText('Resolve / close issue');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.close();
});

test('C focuses comments, S opens the sprint picker, Ctrl+C copies the issue link, and Alt+6 plans the next sprint for me @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, popup, dialog, target} = await openPopup({extensionApp, optionsPage, servers});
  await page.bringToFront();
  await page.evaluate(() => navigator.clipboard.writeText('before'));
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${target.instanceUrl}/browse/${target.primaryIssueKey}`);
  await popup.focus();
  await page.keyboard.press('c');
  await expect(page.locator('._JX_comment_input')).toBeFocused();
  await popup.focus();
  await page.keyboard.press('s');
  await expect(page.getByTestId('jira-popup-edit-input-sprint')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('jira-popup-edit-popover-sprint')).toHaveCount(0);
  await popup.focus();
  await page.keyboard.press('Alt+6');
  await expect(dialog.getByRole('heading')).toHaveText('Next sprint + assign to me');
  await expect(dialog.getByRole('button', {name: 'Open in Jira'})).toHaveCount(0);
  await expect(dialog.getByRole('radio', {name: /Sprint 43/})).toHaveAttribute('aria-checked', 'true');
  const requestPromise = page.context().waitForEvent('request', request => request.method() === 'PUT' && request.url() === `${target.instanceUrl}/rest/api/2/issue/${target.primaryIssueKey}`);
  await page.getByTestId('jira-shortcut-submit').click();
  expect((await requestPromise).postDataJSON()).toMatchObject({fields: {assignee: expect.any(Object), customfield_10020: 43}});
  await expect(dialog).toHaveCount(0);
  await page.close();
});

test('8 copies a reference, Alt+8 copies the URL, and 9 opens Jira in a tab @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, popup, target} = await openPopup({extensionApp, optionsPage, servers});
  await page.bringToFront();
  const url = `${target.instanceUrl}/browse/${target.primaryIssueKey}`;
  await page.keyboard.press('8');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  await popup.focus();
  await page.keyboard.press('Alt+8');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  const opened = page.context().waitForEvent('page');
  await page.keyboard.press('9');
  const jira = await opened;
  await expect(jira).toHaveURL(url);
  await jira.close();
  await page.close();
});

test('Alt+2 moves the issue to the current sprint at once and then reports it is already there @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, popup, dialog, target} = await openPopup({extensionApp, optionsPage, servers});
  const endpoint = `${target.instanceUrl}/rest/api/2/issue/${target.primaryIssueKey}`;
  const requestPromise = page.context().waitForEvent('request', request => request.method() === 'PUT' && request.url() === endpoint);
  await page.keyboard.press('Alt+2');
  expect((await requestPromise).postDataJSON()).toEqual({fields: {customfield_10020: 42}});
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('jira-toast')).toContainText(`Moved ${target.primaryIssueKey} to Sprint 42`);
  await expect(popup).toContainText('Sprint 42');
  await popup.focus();
  await page.keyboard.press('Alt+2');
  await expect(page.getByTestId('jira-toast')).toContainText(`${target.primaryIssueKey} is already in Sprint 42`);
  await page.close();
});

test('4 opens the fix version picker; Alt+4 adds the next unreleased version @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, popup, target} = await openPopup({extensionApp, optionsPage, servers});
  await page.keyboard.press('4');
  await expect(page.getByTestId('jira-popup-edit-input-fixVersions')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('jira-popup-edit-input-fixVersions')).toHaveCount(0);
  await popup.focus();
  const endpoint = `${target.instanceUrl}/rest/api/2/issue/${target.primaryIssueKey}`;
  const requestPromise = page.context().waitForEvent('request', request => request.method() === 'PUT' && request.url() === endpoint);
  await page.keyboard.press('Alt+4');
  expect((await requestPromise).postDataJSON()).toEqual({update: {fixVersions: [{add: {id: '302'}}]}});
  await expect(page.getByTestId('jira-toast')).toContainText(`Added fix version 2026.05 to ${target.primaryIssueKey}`);
  await expect(popup).toContainText('2026.05');
  await expect(popup).toContainText('2026.04');
  await page.close();
});

test('5 starts from the current assignee, selected: Enter keeps them, typing searches someone else @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, dialog, target} = await openPopup({extensionApp, optionsPage, servers});
  await page.keyboard.press('5');
  const search = page.getByTestId('jira-shortcut-assignee');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('Alex Reviewer');
  expect(await search.evaluate(input => [input.selectionStart, input.selectionEnd])).toEqual([0, 'Alex Reviewer'.length]);
  await expect(dialog.getByRole('option', {name: 'Alex Reviewer'})).toHaveAttribute('aria-selected', 'true');
  await screenshot(page, 'plan-prefilled-assignee');
  const requestPromise = page.context().waitForEvent('request', request => request.method() === 'PUT' && request.url() === `${target.instanceUrl}/rest/api/2/issue/${target.primaryIssueKey}`);
  await search.press('Enter');
  expect((await requestPromise).postDataJSON()).toEqual({fields: {assignee: {accountId: 'user-alex'}, customfield_10020: 42}});
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('._JX_title_user_assignee')).toHaveAttribute('title', /Alex Reviewer/);
  await page.keyboard.press('5');
  await expect(search).toHaveValue('Alex Reviewer');
  await page.keyboard.type('Morg');
  await expect(search).toHaveValue('Morg');
  await expect(dialog.getByRole('option', {name: /Morgan Agent/})).toBeVisible();
  await expect(dialog.getByRole('option', {name: 'Alex Reviewer'})).toHaveCount(0);
  await page.close();
});

test('clicking the title bar or status row keeps focus in QuickView so shortcuts still work @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page, popup, dialog} = await openPopup({extensionApp, optionsPage, servers});
  // The title bar and status row are drag handles; dragging cancels mousedown's focus change.
  for (const [start, region] of [['body', '._JX_title'], ['body', '._JX_status'], ['button', '._JX_title'], ['button', '._JX_status']]) {
    await page.evaluate(start => {
      if (start === 'body') document.activeElement?.blur();
      else document.querySelector('._JX_title_controls ._JX_control_button').focus();
    }, start);
    const box = await page.locator(region).first().boundingBox();
    await page.mouse.click(box.x + 3, box.y + box.height / 2);
    await expect(popup, `${region} from ${start}`).toBeFocused();
    await page.keyboard.press('5');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
  const title = await page.locator('._JX_title').boundingBox();
  const before = await popup.boundingBox();
  await page.mouse.move(title.x + 3, title.y + title.height / 2);
  await page.mouse.down();
  await page.mouse.move(title.x + 63, title.y + title.height / 2 + 40, {steps: 5});
  await page.mouse.up();
  const after = await popup.boundingBox();
  expect(Math.round(after.x - before.x)).toBe(60);
  await expect(popup).toBeFocused();
  await page.close();
});

test('Ctrl+Enter in the new comment field saves the comment @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const {page} = await openPopup({extensionApp, optionsPage, servers});
  await page.keyboard.press('7');
  const comment = page.locator('._JX_comment_input');
  await expect(comment).toBeFocused();
  await comment.fill('Saved from the keyboard');
  const requestPromise = page.context().waitForEvent('request', request => request.method() === 'POST' && /\/comment$/.test(new URL(request.url()).pathname));
  await comment.press('Control+Enter');
  expect((await requestPromise).postDataJSON()).toMatchObject({body: 'Saved from the keyboard'});
  await expect(page.locator('._JX_comment').last()).toContainText('Saved from the keyboard');
  await expect(comment).toHaveValue('');
  await page.close();
});
