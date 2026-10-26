require('./load-env-defaults');

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {chromium} = require('playwright');
const {createMockJiraServer} = require('../../tests/e2e/helpers/mock-jira-server');
const {createFixtureServer} = require('../../tests/e2e/helpers/fixture-server');
const {configureExtension, hoverIssueKey, injectContentScript} = require('../../tests/e2e/helpers/extension-fixtures');
const {buildExtensionConfig} = require('../../tests/e2e/helpers/test-targets');

const repoRoot = path.resolve(__dirname, '../..');
const extensionPath = path.join(repoRoot, 'jira-plugin');
const webpackConfigPath = path.join(repoRoot, 'webpack.config.js');
const defaultOutputDir = path.join(repoRoot, 'tests', 'output', 'playwright');
const requiredBundlePaths = [
  path.join(extensionPath, 'build', 'background.js'),
  path.join(extensionPath, 'build', 'main.js'),
  path.join(extensionPath, 'options', 'build', 'options.js'),
];
const popupViewport = {width: 1500, height: 1200};
const baseTooltipLayout = {
  row1: ['issueType', 'status', 'priority', 'epicParent'],
  row2: ['sprint', 'affects', 'fixVersions'],
  row3: ['environment', 'labels'],
  contentBlocks: ['description', 'attachments', 'comments', 'pullRequests', 'timeTracking'],
  people: ['reporter', 'assignee'],
};

const PRESETS = {
  'pull-requests': {
    outputFile: 'pull-requests.png',
    scenario: 'pr-gitlab',
    configureOverrides: {tooltipLayout: {...baseTooltipLayout, contentBlocks: ['pullRequests']}},
    targetSelector: '._JX_related_table_pr',
    waitForSelector: '._JX_pr_signal_failure',
    open: async page => {
      await page.locator('._JX_pr_signal_failure').waitFor({state: 'visible'});
      await page.mouse.move(20, 20);
    },
  },
  'pull-requests-details': {
    outputFile: 'pull-requests-details.png',
    scenario: 'pr-gitlab',
    configureOverrides: {tooltipLayout: {...baseTooltipLayout, contentBlocks: ['pullRequests']}},
    targetSelector: '._JX_related_table_pr',
    waitForSelector: '._JX_tooltip:popover-open',
    extraSelector: '._JX_tooltip:popover-open',
    open: async page => {
      await page.locator('._JX_pr_signal_failure').waitFor({state: 'visible'});
      await page.locator('._JX_pr_time').first().focus();
    },
  },
  'pull-requests-dark': {
    outputFile: 'pull-requests-dark.png',
    scenario: 'pr-gitlab',
    configureOverrides: {themeMode: 'dark', tooltipLayout: {...baseTooltipLayout, contentBlocks: ['pullRequests']}},
    targetSelector: '._JX_related_table_pr',
    waitForSelector: '._JX_pr_signal_failure',
    open: async page => {
      await page.locator('._JX_pr_signal_failure').waitFor({state: 'visible'});
      await page.mouse.move(20, 20);
    },
  },
  'pull-requests-approvals': {
    outputFile: 'pull-requests-approvals.png',
    scenario: 'pr-gitlab',
    configureOverrides: {tooltipLayout: {...baseTooltipLayout, contentBlocks: ['pullRequests']}},
    targetSelector: '._JX_related_table_pr',
    waitForSelector: '._JX_tooltip:popover-open',
    extraSelector: '._JX_tooltip:popover-open',
    open: async page => {
      await page.locator('._JX_pr_signal_approval').first().waitFor({state: 'visible'});
      await page.locator('._JX_pr_signal_approval').first().focus();
    },
  },
  'pull-requests-approvals-hover': {
    outputFile: 'pull-requests-approvals-hover.png',
    scenario: 'pr-gitlab',
    configureOverrides: {tooltipLayout: {...baseTooltipLayout, contentBlocks: ['pullRequests']}},
    targetSelector: '._JX_related_table_pr',
    waitForSelector: '._JX_tooltip:popover-open',
    extraSelector: '._JX_tooltip:popover-open',
    open: async page => {
      await page.locator('._JX_pr_signal_approval').first().hover();
    },
  },
  'pull-requests-title-tooltip': {
    outputFile: 'pull-requests-title-tooltip.png',
    scenario: 'pr-gitlab',
    configureOverrides: {tooltipLayout: {...baseTooltipLayout, contentBlocks: ['pullRequests']}},
    targetSelector: '._JX_related_table_pr',
    waitForSelector: '[data-testid="jira-popup-tooltip"]:popover-open',
    extraSelector: '[data-testid="jira-popup-tooltip"]:popover-open',
    open: async page => {
      await page.locator('._JX_pr_branch').first().hover();
    },
  },
  'header-title-hover': {
    outputFile: 'header-title-hover.png',
    targetSelector: '._JX_title',
    waitForSelector: '._JX_title_edit_button',
    open: async page => {
      await page.locator('#_JX_title_link').hover();
    },
  },
  'header-assignee-hover': {
    outputFile: 'header-assignee-hover.png',
    targetSelector: '._JX_title',
    waitForSelector: '._JX_assignee_edit_button',
    open: async page => {
      await page.locator('._JX_title_assignee_slot').hover();
    },
  },
  'layout-moved-fields': {
    outputFile: 'layout-moved-fields.png',
    configureOverrides: {customFields: [{fieldId: 'customfield_67890', row: 2}], tooltipLayout: {
      ...baseTooltipLayout,
      row1: ['issueType', 'status', 'priority', 'affects', 'fixVersions'],
      row2: ['sprint', 'custom_customfield_67890', 'epicParent'],
      row3: ['environment', 'labels'],
    }},
    targetSelector: '._JX_status',
    waitForSelector: '._JX_status_row_primary',
    open: async () => {},
  },
  'header-title-tooltip': {
    outputFile: 'header-title-tooltip.png',
    targetSelector: '._JX_title',
    waitForSelector: '[data-testid="jira-popup-tooltip"]:popover-open',
    extraSelector: '[data-testid="jira-popup-tooltip"]:popover-open',
    open: async page => {
      await page.locator('#_JX_title_link').hover();
    },
  },
  'layout-empty-row': {
    outputFile: 'layout-empty-row.png',
    configureOverrides: {tooltipLayout: {
      ...baseTooltipLayout,
      row1: ['issueType', 'epicParent', 'status', 'sprint', 'priority', 'fixVersions'],
      row2: [],
      row3: ['environment', 'labels'],
    }},
    targetSelector: '._JX_status',
    waitForSelector: '._JX_status_row_primary',
    open: async () => {},
  },
  'chip-edit-priority': {
    outputFile: 'chip-edit-priority.png',
    targetSelector: '[data-testid="jira-popup-edit-popover-priority"]',
    waitForSelector: '._JX_edit_option[data-field-key="priority"]',
    open: async page => {
      await page.locator('._JX_field_chip_edit[data-field-key="priority"]').click();
    },
  },
  'chip-edit-sprint': {
    outputFile: 'chip-edit-sprint.png',
    targetSelector: '[data-testid="jira-popup-edit-popover-sprint"]',
    waitForSelector: '._JX_edit_option[data-field-key="sprint"]',
    open: async page => {
      await page.locator('._JX_field_chip_edit[data-field-key="sprint"]').click();
    },
  },
  'header-title-edit': {
    outputFile: 'header-title-edit.png',
    targetSelector: '._JX_title',
    waitForSelector: '._JX_title_edit_input',
    extraSelector: '._JX_title_edit_actions',
    open: async page => {
      await page.locator('#_JX_title_link').hover();
      await page.locator('._JX_title_edit_button').click();
    },
  },
  'header-shortcuts-help': {
    outputFile: 'header-shortcuts-help.png',
    targetSelector: '._JX_title',
    waitForSelector: '._JX_shortcuts_panel',
    extraSelector: '._JX_shortcuts_panel',
    open: async page => {
      await page.locator('._JX_shortcuts_help').click();
    },
  },
  'header-shortcuts-help-dark': {
    outputFile: 'header-shortcuts-help-dark.png',
    configureOverrides: {themeMode: 'dark'},
    targetSelector: '._JX_title',
    waitForSelector: '._JX_shortcuts_panel',
    extraSelector: '._JX_shortcuts_panel',
    open: async page => {
      await page.locator('._JX_shortcuts_help').click();
    },
  },
  'pull-requests-unavailable': {
    outputFile: 'pull-requests-unavailable.png',
    scenario: 'pr-gitlab-auth-fails',
    configureOverrides: {tooltipLayout: {...baseTooltipLayout, contentBlocks: ['pullRequests']}},
    targetSelector: '._JX_related_table_pr',
    waitForSelector: '._JX_gitlab_connect',
    open: async () => {},
  },
  'pull-requests-details-dark': {
    outputFile: 'pull-requests-details-dark.png',
    scenario: 'pr-gitlab',
    configureOverrides: {themeMode: 'dark', tooltipLayout: {...baseTooltipLayout, contentBlocks: ['pullRequests']}},
    targetSelector: '._JX_related_table_pr',
    waitForSelector: '._JX_tooltip:popover-open',
    extraSelector: '._JX_tooltip:popover-open',
    open: async page => {
      await page.locator('._JX_pr_signal_failure').waitFor({state: 'visible'});
      await page.locator('._JX_pr_time').first().focus();
    },
  },
  'linked-issues-panel': {
    outputFile: 'linked-issues-panel.png',
    configureOverrides: {},
    targetSelector: '._JX_linked_issues_panel',
    waitForSelector: '._JX_linked_issues_row',
    open: async page => {
      await page.locator('._JX_linked_issues_trigger').click();
    },
  },
  'linked-issues-search': {
    outputFile: 'linked-issues-search.png',
    configureOverrides: {},
    targetSelector: '._JX_linked_issues_panel',
    waitForSelector: '._JX_linked_issues_search_result',
    open: async page => {
      await page.locator('._JX_linked_issues_trigger').click();
      await page.locator('._JX_linked_issues_search_input').fill('API');
    },
  },
  'linked-issues-multi-select': {
    outputFile: 'linked-issues-multi-select.png',
    configureOverrides: {},
    targetSelector: '._JX_linked_issues_panel',
    waitForSelector: '._JX_linked_issues_selected_chip',
    open: async page => {
      await page.locator('._JX_linked_issues_trigger').click();
      await page.locator('._JX_linked_issues_search_input').fill('JRACLOUD-99001, API-204');
    },
  },
  'linked-issues-remove-confirmation': {
    outputFile: 'linked-issues-remove-confirmation.png',
    configureOverrides: {},
    targetSelector: '._JX_linked_issues_panel',
    waitForSelector: '._JX_linked_issues_remove_confirmation',
    open: async page => {
      await page.locator('._JX_linked_issues_trigger').click();
      const row = page.locator('._JX_linked_issues_row[data-issue-key="JRACLOUD-98123"]');
      await row.hover();
      await row.locator('._JX_linked_issues_remove').click();
    },
  },
  'history-panel': {
    outputFile: 'history-panel-restyled.png',
    configureOverrides: {},
    targetSelector: '._JX_history_flyout',
    waitForSelector: '._JX_history_entry',
    open: async page => {
      await page.locator('._JX_history_toggle').click();
    },
  },
  'watchers-panel': {
    outputFile: 'watchers-panel-reference.png',
    configureOverrides: {},
    targetSelector: '._JX_watchers_panel',
    waitForSelector: '._JX_watchers_row',
    open: async page => {
      await page.locator('._JX_watchers_trigger').click();
    },
  },
  'time-tracking': {
    outputFile: 'time-tracking-alignment.png',
    configureOverrides: {
      tooltipLayout: {
        ...baseTooltipLayout,
        contentBlocks: ['timeTracking'],
      },
    },
    targetSelector: '._JX_time_tracking',
    waitForSelector: '._JX_time_tracking',
    open: async () => {},
  },
};

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    stdio: 'inherit',
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function parseArgs(argv) {
  const parsed = {
    frame: 'context',
    outputDir: defaultOutputDir,
    padding: 20,
    presets: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--list-presets') {
      parsed.listPresets = true;
      continue;
    }
    if (token === '--preset') {
      parsed.presets.push(String(argv[index + 1] || '').trim());
      index += 1;
      continue;
    }
    if (token === '--frame') {
      parsed.frame = String(argv[index + 1] || '').trim().toLowerCase();
      index += 1;
      continue;
    }
    if (token === '--output-dir') {
      parsed.outputDir = path.resolve(repoRoot, String(argv[index + 1] || '').trim());
      index += 1;
      continue;
    }
    if (token === '--output') {
      parsed.outputPath = path.resolve(repoRoot, String(argv[index + 1] || '').trim());
      index += 1;
      continue;
    }
    if (token === '--padding') {
      parsed.padding = Number.parseInt(String(argv[index + 1] || '').trim(), 10);
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${token}`);
  }

  if (!['context', 'popup', 'panel', 'page'].includes(parsed.frame)) {
    fail(`Invalid frame: ${parsed.frame}`);
  }
  if (!Number.isFinite(parsed.padding) || parsed.padding < 0) {
    fail(`Invalid padding: ${parsed.padding}`);
  }
  if (parsed.outputPath && parsed.presets.length > 1) {
    fail('--output can only be used with a single --preset value.');
  }
  if (!parsed.listPresets && parsed.presets.length === 0) {
    fail('Provide at least one --preset value, or use --list-presets.');
  }

  return parsed;
}

async function ensureExtensionBundle() {
  const bundleExists = await Promise.all(requiredBundlePaths.map(filePath => fs.access(filePath).then(() => true).catch(() => false)));
  if (bundleExists.every(Boolean)) {
    return;
  }

  console.log('Extension bundle missing; running webpack build...');
  run('npx', ['webpack', '--mode=development', '--config', webpackConfigPath]);
}

async function createTestExtensionCopy() {
  const extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jira-quickview-extension-'));
  await fs.cp(extensionPath, extensionDir, {recursive: true});

  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.permissions = Array.from(new Set([...(manifest.permissions || []), 'scripting']));
  manifest.host_permissions = ['<all_urls>'];
  manifest.optional_host_permissions = ['<all_urls>'];
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return extensionDir;
}

async function getExtensionId(context) {
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    try {
      serviceWorker = await context.waitForEvent('serviceworker', {timeout: 30000});
    } catch (_firstTimeout) {
      const nudgePage = await context.newPage();
      await nudgePage.goto('about:blank').catch(() => {});
      await nudgePage.close().catch(() => {});
      [serviceWorker] = context.serviceWorkers();
      if (!serviceWorker) {
        serviceWorker = await context.waitForEvent('serviceworker', {timeout: 15000});
      }
    }
  }

  return serviceWorker.url().split('/')[2];
}

async function createHarness() {
  await ensureExtensionBundle();

  const jira = await createMockJiraServer();
  const allowedPage = await createFixtureServer();
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jira-quickview-playwright-'));
  const testExtensionPath = await createTestExtensionCopy();
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: popupViewport,
    args: [
      `--disable-extensions-except=${testExtensionPath}`,
      `--load-extension=${testExtensionPath}`,
    ],
  });

  const extensionId = await getExtensionId(context);
  const extensionApp = {context, extensionId};
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/options/options.html`, {waitUntil: 'domcontentloaded'});

  async function configure(overrides = {}) {
    await optionsPage.evaluate(themeMode => chrome.storage.sync.set({themeMode}), overrides.themeMode || 'light');
    const tooltipLayout = overrides.tooltipLayout || baseTooltipLayout;
    await configureExtension(optionsPage, buildExtensionConfig({jira, allowedPage}, {
      tooltipLayout,
      ...overrides,
    }));
  }

  async function openPopup(route = '/popup-actions') {
    const page = await context.newPage();
    await page.goto(`${allowedPage.origin}${route}`, {waitUntil: 'domcontentloaded'});
    await injectContentScript(extensionApp, page);
    await hoverIssueKey(page, '#popup-key');
    await page.locator('#_JX_title_link').waitFor({state: 'visible'});
    return page;
  }

  async function cleanup() {
    await Promise.allSettled([
      optionsPage.close(),
      context.close(),
      jira.close(),
      allowedPage.close(),
      fs.rm(userDataDir, {recursive: true, force: true}),
      fs.rm(testExtensionPath, {recursive: true, force: true}),
    ]);
  }

  return {
    setScenario: scenario => jira.setScenario(scenario),
    configure,
    openPopup,
    cleanup,
  };
}

async function getBoundingBox(locator, description) {
  const box = await locator.boundingBox();
  if (!box) {
    fail(`Could not determine bounding box for ${description}.`);
  }
  return box;
}

function buildClip(boxes, viewport, padding) {
  const minX = Math.min(...boxes.map(box => box.x));
  const minY = Math.min(...boxes.map(box => box.y));
  const maxX = Math.max(...boxes.map(box => box.x + box.width));
  const maxY = Math.max(...boxes.map(box => box.y + box.height));
  const x = Math.max(0, minX - padding);
  const y = Math.max(0, minY - padding);
  const maxWidth = Math.max(1, viewport.width - x);
  const maxHeight = Math.max(1, viewport.height - y);

  return {
    x,
    y,
    width: Math.max(1, Math.min(maxWidth, (maxX - minX) + (padding * 2))),
    height: Math.max(1, Math.min(maxHeight, (maxY - minY) + (padding * 2))),
  };
}

async function screenshotRegion(page, locators, outputPath, padding, boundsLocator = null) {
  const viewport = page.viewportSize() || popupViewport;
  const boxes = [];
  for (const entry of locators) {
    boxes.push(await getBoundingBox(entry.locator, entry.description));
  }
  const clip = buildClip(boxes, viewport, padding);
  // A panel scrolled inside the popup can extend past it; nothing beyond the popup's edge is visible.
  if (boundsLocator) {
    const bounds = await getBoundingBox(boundsLocator, 'popup bounds');
    clip.height = Math.max(1, Math.min(clip.y + clip.height, bounds.y + bounds.height + padding) - clip.y);
  }
  await page.screenshot({path: outputPath, clip});
}

async function capturePreset(harness, presetName, options) {
  const preset = PRESETS[presetName];
  if (!preset) {
    fail(`Unknown preset: ${presetName}`);
  }

  const outputPath = options.outputPath || path.join(options.outputDir, preset.outputFile);
  await fs.mkdir(path.dirname(outputPath), {recursive: true});
  await harness.setScenario(preset.scenario || 'editable');
  await harness.configure(preset.configureOverrides);

  const page = await harness.openPopup(preset.route || '/popup-actions');
  try {
    const popupLocator = page.locator('._JX_container');
    await popupLocator.waitFor({state: 'visible'});
    await preset.open(page);
    await page.locator(preset.targetSelector).waitFor({state: 'visible'});
    await page.locator(preset.waitForSelector).first().waitFor({state: 'visible'});
    await page.waitForTimeout(250);

    if (options.frame === 'page') {
      await page.screenshot({path: outputPath, fullPage: true});
    } else if (options.frame === 'popup') {
      await screenshotRegion(page, [
        {locator: popupLocator, description: `${presetName} popup`},
      ], outputPath, options.padding);
    } else if (options.frame === 'panel') {
      await screenshotRegion(page, [
        {locator: page.locator(preset.targetSelector), description: `${presetName} panel`},
        ...(preset.extraSelector ? [{locator: page.locator(preset.extraSelector), description: 'PR event details'}] : []),
      ], outputPath, options.padding, preset.extraSelector ? null : popupLocator);
    } else {
      await screenshotRegion(page, [
        {locator: popupLocator, description: `${presetName} popup`},
        {locator: page.locator(preset.targetSelector), description: `${presetName} panel`},
      ], outputPath, options.padding);
    }

    return outputPath;
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.listPresets) {
    Object.keys(PRESETS).sort().forEach(name => console.log(name));
    return;
  }

  const harness = await createHarness();
  try {
    const generatedPaths = [];
    for (const presetName of options.presets) {
      generatedPaths.push(await capturePreset(harness, presetName, options));
    }
    generatedPaths.forEach(filePath => {
      console.log(`Saved screenshot to ${filePath}`);
    });
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
