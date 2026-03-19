const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const {execFileSync} = require('child_process');
const {chromium} = require('playwright');
const {createMockJiraServer} = require('../../tests/e2e/helpers/mock-jira-server');
const {createFixtureServer} = require('../../tests/e2e/helpers/fixture-server');

const repoRoot = path.resolve(__dirname, '../..');
const extensionPath = path.join(repoRoot, 'jira-plugin');
const screenshotDir = path.join(repoRoot, 'docs', 'screenshots');

async function createTestExtensionCopy() {
  const extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jira-hot-linker-marketing-extension-'));
  await fs.cp(extensionPath, extensionDir, {recursive: true});
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.permissions = Array.from(new Set([...(manifest.permissions || []), 'scripting']));
  manifest.host_permissions = ['<all_urls>'];
  manifest.optional_host_permissions = ['<all_urls>'];
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return extensionDir;
}

async function launchExtensionContext() {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jira-hot-linker-marketing-profile-'));
  const testExtensionPath = await createTestExtensionCopy();
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: {width: 1600, height: 1100},
    args: [
      `--disable-extensions-except=${testExtensionPath}`,
      `--load-extension=${testExtensionPath}`,
    ],
  });
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker');
  }
  const extensionId = serviceWorker.url().split('/')[2];
  return {context, serviceWorker, extensionId, userDataDir, testExtensionPath};
}

async function injectContentScript(serviceWorker, page) {
  await serviceWorker.evaluate(async targetUrl => {
    const tabs = await new Promise(resolve => chrome.tabs.query({}, resolve));
    const tab = tabs.find(candidate => candidate.url === targetUrl);
    if (!tab || typeof tab.id !== 'number' || tab.id < 0) {
      throw new Error(`Could not find tab for ${targetUrl}`);
    }
    await chrome.scripting.executeScript({
      target: {tabId: tab.id},
      files: ['build/main.js'],
    });
  }, page.url());
}

async function configureExtension(page, config) {
  await page.getByLabel('Jira instance URL').fill(config.instanceUrl);
  await page.getByLabel('Allowed pages').fill(config.domains.join(', '));
  await page.getByLabel('Trigger depth').selectOption(config.hoverDepth);
  await page.getByLabel('Modifier key').selectOption(config.hoverModifierKey);
  await page.getByLabel('Color mode').selectOption(config.colorMode);

  for (const [key, checked] of Object.entries(config.displayFields)) {
    await page.locator(`#displayField_${key}`).setChecked(checked);
  }

  for (let index = 0; index < config.customFields.length; index += 1) {
    const existingRows = await page.locator('.customFieldRow').count();
    if (existingRows <= index) {
      await page.getByRole('button', {name: 'Add another field'}).click();
    }
    const row = page.locator('.customFieldRow').nth(index);
    await row.getByLabel('Field ID').fill(config.customFields[index].fieldId);
    await row.getByLabel('Location').selectOption(String(config.customFields[index].row));
  }

  await page.getByRole('button', {name: 'Save changes'}).click();
  await page.locator('.saveNotice').waitFor({state: 'visible'});
}

async function styleFixturePage(page) {
  await page.addStyleTag({
    content: `
      body {
        min-height: 100vh;
        margin: 0;
        background:
          radial-gradient(circle at top left, rgba(15, 118, 110, 0.22), transparent 32%),
          radial-gradient(circle at bottom right, rgba(31, 111, 235, 0.18), transparent 28%),
          linear-gradient(135deg, #0b1220 0%, #132238 52%, #1b2d45 100%);
        color: #e8eef7;
      }
      main {
        max-width: 1200px;
        margin: 0 auto;
        padding: 56px 40px 96px;
      }
      h1 {
        font: 700 44px/1.05 Georgia, 'Times New Roman', serif;
        letter-spacing: -0.03em;
        max-width: 11ch;
        margin-bottom: 12px;
      }
      .hero-copy {
        max-width: 680px;
        color: rgba(232, 238, 247, 0.82);
        font-size: 18px;
        margin-bottom: 24px;
      }
      .card {
        background: rgba(10, 18, 32, 0.64);
        border: 1px solid rgba(148, 163, 184, 0.25);
        box-shadow: 0 30px 70px rgba(7, 11, 20, 0.45);
        backdrop-filter: blur(18px);
      }
      .marker {
        color: #93c5fd;
        background: rgba(30, 64, 175, 0.28);
        padding: 2px 8px;
        border-radius: 999px;
      }
    `,
  });
  await page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main || document.querySelector('.hero-copy')) {
      return;
    }
    const intro = document.createElement('div');
    intro.innerHTML = `
      <div class="hero-copy">Hover the Jira key in this mocked review note to open a fully interactive preview with issue details, quick actions, comments, attachments, and edit controls.</div>
    `;
    const heading = main.querySelector('h1');
    if (heading) {
      heading.textContent = 'Review Jira issues without leaving the page';
      heading.insertAdjacentElement('afterend', intro.firstElementChild);
    }
  });
}

async function capturePopupScreens(page, outputPrefix) {
  const popup = page.locator('._JX_container');
  await popup.waitFor({state: 'visible'});
  await page.screenshot({path: path.join(screenshotDir, `${outputPrefix}-overview.png`), fullPage: true});

  await page.locator('._JX_actions_toggle').click();
  await page.screenshot({path: path.join(screenshotDir, `${outputPrefix}-actions.png`), fullPage: true});

  await page.locator('._JX_field_chip_edit[data-field-key="labels"]').click();
  const labelInput = page.locator('._JX_edit_input[data-field-key="labels"]');
  await labelInput.fill('release');
  await page.screenshot({path: path.join(screenshotDir, `${outputPrefix}-editor.png`), fullPage: true});
}

async function main() {
  await fs.mkdir(screenshotDir, {recursive: true});
  execFileSync('npx', ['webpack', '--mode=development'], {cwd: repoRoot, stdio: 'inherit'});

  const jira = await createMockJiraServer();
  const fixture = await createFixtureServer();
  const {context, serviceWorker, extensionId, userDataDir, testExtensionPath} = await launchExtensionContext();

  try {
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options/options.html`, {waitUntil: 'domcontentloaded'});
    await configureExtension(optionsPage, {
      instanceUrl: jira.origin,
      domains: [fixture.origin],
      hoverDepth: 'shallow',
      hoverModifierKey: 'none',
      colorMode: 'dark',
      displayFields: {
        comments: true,
        attachments: true,
        pullRequests: true,
        environment: true,
      },
      customFields: [{fieldId: 'customfield_12345', row: 2}],
    });
    await optionsPage.screenshot({path: path.join(screenshotDir, 'options-page.png'), fullPage: true});
    await optionsPage.close();

    const popupPage = await context.newPage();
    await popupPage.goto(`${fixture.origin}/popup-actions`, {waitUntil: 'domcontentloaded'});
    await styleFixturePage(popupPage);
    await injectContentScript(serviceWorker, popupPage);
    await popupPage.locator('#popup-key').hover();
    await capturePopupScreens(popupPage, 'popup');
    await popupPage.close();
  } finally {
    await context.close();
    await Promise.allSettled([
      jira.close(),
      fixture.close(),
      fs.rm(userDataDir, {recursive: true, force: true}),
      fs.rm(testExtensionPath, {recursive: true, force: true}),
    ]);
  }

  console.log(`Saved screenshots to ${screenshotDir}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
