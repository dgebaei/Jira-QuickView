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
