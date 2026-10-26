const path = require('path');
const {test, expect} = require('@playwright/test');

const harnessPath = path.resolve(__dirname, '../../output/playwright/deep-modules/harness.js');

test.beforeEach(async ({page}) => {
  await page.setContent(`<!doctype html><html><body>
    <p id="message">See <a id="link" href="https://jira.example/browse/ABC-1">ABC-1</a> and ABC-2 in the plan.</p>
  </body></html>`);
  await page.addScriptTag({path: harnessPath});
});

const nextFrame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test('a second install on the same page reuses the page state instead of adding duplicate copy buttons', async ({page}) => {
  // An extension reload leaves the previous content script running in open tabs,
  // so two installs can share one document.
  await page.evaluate(() => {
    const {installJiraInlineCopyButtons} = window.JiraQuickViewDeepModules;
    const copy = () => Promise.resolve();
    installJiraInlineCopyButtons({document, instanceUrl: 'https://jira.example/', copy});
    installJiraInlineCopyButtons({document, instanceUrl: 'https://jira.example/', copy});
  });
  await nextFrame(page);
  await page.locator('#message').evaluate(element => element.append(' Updated.'));
  await nextFrame(page);

  await expect(page.locator('#link ~ ._JX_inline_copy_button')).toHaveCount(1);
  await expect(page.locator('._JX_inline_copy_button[data-jx-inline-copy-key="ABC-2"]')).toHaveCount(1);
});

test('an install whose extension context is gone removes its copy buttons and a live install replaces them', async ({page}) => {
  await page.evaluate(() => {
    const {installJiraInlineCopyButtons} = window.JiraQuickViewDeepModules;
    window.oldAlive = true;
    installJiraInlineCopyButtons({
      document, instanceUrl: 'https://jira.example/', copy: () => Promise.resolve(), isAlive: () => window.oldAlive,
    });
  });
  await nextFrame(page);
  await expect(page.locator('._JX_inline_copy_button')).toHaveCount(2);

  // The extension is reloaded: the old script's context dies and a new one installs.
  await page.evaluate(() => {
    window.oldAlive = false;
    window.newCopies = 0;
    window.JiraQuickViewDeepModules.installJiraInlineCopyButtons({
      document, instanceUrl: 'https://jira.example/', copy: () => { window.newCopies += 1; return Promise.resolve(); },
    });
  });
  await nextFrame(page);
  await page.locator('#message').evaluate(element => element.append(' Updated.'));
  await nextFrame(page);
  await nextFrame(page);

  await expect(page.locator('#link ~ ._JX_inline_copy_button')).toHaveCount(1);
  await expect(page.locator('._JX_inline_copy_button[data-jx-inline-copy-key="ABC-2"]')).toHaveCount(1);
  // Every remaining button belongs to the live install.
  await page.locator('#link ~ ._JX_inline_copy_button').click();
  await page.locator('._JX_inline_copy_button[data-jx-inline-copy-key="ABC-2"]').click();
  await expect.poll(() => page.evaluate(() => window.newCopies)).toBe(2);
});

test('a Jira link that is a grid cell keeps its row: the copy button goes inside the link', async ({page}) => {
  // Dashboards such as Claude artifacts lay rows out as grids; a sibling button
  // would become an extra cell and shift every following column.
  const row = await page.evaluate(() => {
    document.body.innerHTML = `
      <div id="row" style="display:grid;grid-template-columns:120px 1fr 80px;width:600px">
        <a id="grid-link" href="https://jira.example/browse/ABC-7">ABC-7</a>
        <span id="title">Title</span>
        <span id="status">Open</span>
      </div>`;
    const {installJiraInlineCopyButtons} = window.JiraQuickViewDeepModules;
    const copy = () => Promise.resolve();
    // A second install, as after an extension reload, must not add another button.
    installJiraInlineCopyButtons({document, instanceUrl: 'https://jira.example/', copy});
    installJiraInlineCopyButtons({document, instanceUrl: 'https://jira.example/', copy});
  });
  await nextFrame(page);
  await nextFrame(page);

  await expect(page.locator('#row > *')).toHaveCount(3);
  await expect(page.locator('#grid-link > ._JX_inline_copy_button')).toHaveCount(1);
  await expect(page.locator('._JX_inline_copy_button')).toHaveCount(1);
  const titleOffset = await page.locator('#title').evaluate(title =>
    title.getBoundingClientRect().left - title.parentElement.getBoundingClientRect().left);
  expect(titleOffset).toBe(120);
});

test('allowing claude.ai also allows the frames Claude renders artifacts in, once', async ({page}) => {
  const result = await page.evaluate(() => {
    const {withEmbeddedContentDomains: expand} = window.JiraQuickViewDeepModules;
    return {
      bare: expand(['github.com', 'claude.ai']),
      pattern: expand(['*://claude.ai/*']),
      alreadyListed: expand(['https://claude.ai/', '*://*.frame.claudeusercontent.com/*']),
      widerListed: expand(['claude.ai', '*.claudeusercontent.com']),
      unrelated: expand(['github.com', 'mail.google.com']),
    };
  });
  expect(result).toEqual({
    bare: ['github.com', 'claude.ai', 'https://*.frame.claudeusercontent.com/*'],
    pattern: ['*://claude.ai/*', 'https://*.frame.claudeusercontent.com/*'],
    alreadyListed: ['https://claude.ai/', '*://*.frame.claudeusercontent.com/*'],
    widerListed: ['claude.ai', '*.claudeusercontent.com'],
    unrelated: ['github.com', 'mail.google.com'],
  });
});
