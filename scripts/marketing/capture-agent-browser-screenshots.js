#!/usr/bin/env node

const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const {spawn, spawnSync} = require('child_process');

const {createMockJiraServer} = require('../../tests/e2e/helpers/mock-jira-server');

const REPO_ROOT = path.resolve(__dirname, '../..');
const EXTENSION_SOURCE = path.join(REPO_ROOT, 'jira-plugin');
const OUTPUT_DIR = path.join(REPO_ROOT, 'docs', 'screenshots', 'marketing-agent-browser');
const SESSION_NAME = 'jhl-marketing';
const CDP_PORT = 9222;
const OPTIONS_VIEWPORT = {width: 2560, height: 1600};
const POPUP_VIEWPORT = {width: 2560, height: 1600};
const DEVICE_SCALE_FACTOR = 2;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Unexpected ${response.statusCode} from ${url}`));
        return;
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
  });
}

function renderMarketingStageHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Jira HotLinker Marketing Stage</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #1a2435;
        --muted: rgba(26, 36, 53, 0.72);
        --line: rgba(88, 102, 126, 0.18);
        --panel: rgba(255, 255, 255, 0.82);
        --accent: #14b8a6;
        --accent-strong: #0f766e;
        --accent-warm: #f97316;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at 0% 0%, rgba(20, 184, 166, 0.22), transparent 30%),
          radial-gradient(circle at 100% 100%, rgba(249, 115, 22, 0.18), transparent 26%),
          linear-gradient(140deg, #f6f0e5 0%, #fff9f1 48%, #efe8db 100%);
      }

      body::before {
        content: "";
        position: fixed;
        inset: 0;
        background-image:
          linear-gradient(rgba(88, 102, 126, 0.05) 1px, transparent 1px),
          linear-gradient(90deg, rgba(88, 102, 126, 0.05) 1px, transparent 1px);
        background-size: 44px 44px;
        mask-image: radial-gradient(circle at center, black 35%, transparent 85%);
        pointer-events: none;
      }

      main {
        width: min(2200px, calc(100vw - 140px));
        margin: 0 auto;
        padding: 92px 0 116px;
        display: grid;
        grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr);
        gap: 56px;
        align-items: start;
      }

      .hero {
        padding-top: 18px;
      }

      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 9px 14px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.62);
        color: var(--muted);
        font: 600 12px/1.1 ui-sans-serif, system-ui, sans-serif;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }

      .eyebrow::before {
        content: "";
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--accent);
        box-shadow: 0 0 0 6px rgba(20, 184, 166, 0.14);
      }

      h1 {
        max-width: 9ch;
        margin: 20px 0 18px;
        font-size: clamp(62px, 7vw, 88px);
        line-height: 0.94;
        letter-spacing: -0.05em;
      }

      .lede {
        max-width: 32rem;
        margin: 0 0 28px;
        color: var(--muted);
        font: 500 20px/1.6 ui-sans-serif, system-ui, sans-serif;
      }

      .bullet-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
        margin-bottom: 28px;
      }

      .bullet {
        border: 1px solid var(--line);
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.78);
        padding: 16px 18px;
        box-shadow: 0 24px 48px rgba(63, 58, 45, 0.08);
      }

      .bullet strong {
        display: block;
        margin-bottom: 6px;
        font: 700 13px/1.2 ui-sans-serif, system-ui, sans-serif;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .bullet span {
        color: var(--muted);
        font: 500 15px/1.55 ui-sans-serif, system-ui, sans-serif;
      }

      .review-shell {
        position: relative;
        border: 1px solid rgba(20, 184, 166, 0.18);
        border-radius: 28px;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(252, 248, 242, 0.82));
        box-shadow: 0 36px 92px rgba(88, 73, 47, 0.12);
        overflow: hidden;
      }

      .review-topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 20px 24px 18px;
        border-bottom: 1px solid var(--line);
      }

      .review-title {
        font: 700 15px/1.3 ui-sans-serif, system-ui, sans-serif;
        letter-spacing: 0.02em;
      }

      .review-badge {
        padding: 7px 11px;
        border-radius: 999px;
        background: rgba(20, 184, 166, 0.12);
        color: var(--accent-strong);
        font: 700 12px/1 ui-sans-serif, system-ui, sans-serif;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .review-content {
        padding: 24px;
        display: grid;
        gap: 18px;
      }

      .review-block {
        border: 1px solid var(--line);
        border-radius: 22px;
        background: rgba(255, 255, 255, 0.8);
        padding: 18px 20px;
      }

      .review-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 14px;
        color: var(--muted);
        font: 600 12px/1.2 ui-sans-serif, system-ui, sans-serif;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .review-code {
        margin: 0;
        white-space: pre-wrap;
        font: 500 16px/1.8 ui-monospace, SFMono-Regular, Menlo, monospace;
        color: #233146;
      }

      .review-code .accent {
        color: #c2410c;
      }

      .review-code .token {
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(20, 184, 166, 0.14);
        color: var(--accent-strong);
      }

      #popup-key {
        cursor: pointer;
      }

      .stage-notes {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .stage-note {
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 8px 12px;
        background: rgba(255, 255, 255, 0.76);
        color: var(--muted);
        font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="eyebrow">Jira HotLinker</div>
        <h1>Review Jira issues without context switching.</h1>
        <p class="lede">Hover a ticket key from a pull request, a notes app, or a bug triage queue and get a dense, editable view of the issue instantly.</p>
        <div class="bullet-grid">
          <div class="bullet">
            <strong>At a Glance</strong>
            <span>Status, assignee, rich description, PRs, comments, and attachments stay one hover away.</span>
          </div>
          <div class="bullet">
            <strong>Edit In Place</strong>
            <span>Adjust fields, descriptions, and comments without opening Jira in another tab.</span>
          </div>
          <div class="bullet">
            <strong>Change History</strong>
            <span>Open a timeline of edits and rich content updates directly from the preview.</span>
          </div>
          <div class="bullet">
            <strong>Tailored Layout</strong>
            <span>Reorder sections and field chips from the options page to match each team’s workflow.</span>
          </div>
        </div>
        <div class="stage-notes">
          <div class="stage-note">Hover the linked issue key on the right.</div>
          <div class="stage-note">The popup is repositioned for clean marketing captures.</div>
        </div>
      </section>
      <section class="review-shell">
        <div class="review-topbar">
          <div class="review-title">Mock Release Review</div>
          <div class="review-badge">Engineering</div>
        </div>
        <div class="review-content">
          <div class="review-block">
            <div class="review-meta">
              <span>Pull Request Thread</span>
              <span>Needs Triage</span>
            </div>
            <p class="review-code">We should ship the editor fix after validating <span id="popup-key" class="token">JRACLOUD-97846</span> against the latest multiline slash-command behavior and attachment previews.</p>
          </div>
          <div class="review-block">
            <div class="review-meta">
              <span>Release Checklist</span>
              <span>3 pending items</span>
            </div>
            <p class="review-code"><span class="accent">1.</span> Confirm the updated description editor formatting.
<span class="accent">2.</span> Review assignee / sprint quick actions.
<span class="accent">3.</span> Capture the final popup states for docs and store listings.</p>
          </div>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

async function createMarketingStageServer() {
  const html = renderMarketingStageHtml();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/' && url.pathname !== '/popup-stage') {
      res.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
      res.end('Not found');
      return;
    }
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    res.end(html);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    close: () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  };
}

function buildDisplayFields() {
  return {
    issueType: true,
    status: true,
    priority: true,
    sprint: true,
    fixVersions: true,
    affects: true,
    environment: true,
    labels: true,
    epicParent: true,
    attachments: true,
    comments: true,
    description: true,
    reporter: true,
    assignee: true,
    pullRequests: true,
    timeTracking: true,
  };
}

function buildConfig({instanceUrl, domains, themeMode = 'dark', hoverDepth = 'shallow', hoverModifierKey = 'none', customFields = [], tooltipLayout} = {}) {
  return {
    instanceUrl,
    domains,
    themeMode,
    v15upgrade: true,
    customFields,
    hoverDepth,
    hoverModifierKey,
    displayFields: buildDisplayFields(),
    tooltipLayout: tooltipLayout || {
      row1: ['issueType', 'status', 'priority', 'epicParent'],
      row2: ['sprint', 'affects', 'fixVersions'],
      row3: ['environment', 'labels'],
      contentBlocks: ['description', 'attachments', 'pullRequests', 'comments', 'timeTracking'],
      people: ['reporter', 'assignee'],
    },
  };
}

async function createExtensionCopy() {
  const extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jhl-agent-browser-extension-'));
  await fs.cp(EXTENSION_SOURCE, extensionDir, {recursive: true});
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.permissions = Array.from(new Set([...(manifest.permissions || []), 'scripting']));
  manifest.host_permissions = ['<all_urls>'];
  manifest.optional_host_permissions = ['<all_urls>'];
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return extensionDir;
}

async function findChromeExecutable() {
  const browsersRoot = path.join(os.homedir(), '.agent-browser', 'browsers');
  const entries = await fs.readdir(browsersRoot, {withFileTypes: true});
  const candidates = entries
    .filter(entry => entry.isDirectory() && /^chrome-\d/.test(entry.name))
    .map(entry => path.join(browsersRoot, entry.name, 'chrome'))
    .sort()
    .reverse();

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch (_error) {
      // Ignore missing candidates.
    }
  }

  throw new Error('Could not find an agent-browser managed Chrome install. Run `agent-browser install` first.');
}

function launchChrome({chromePath, extensionPath, userDataDir, port}) {
  const chrome = spawn(
    chromePath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-dev-shm-usage',
      '--hide-crash-restore-bubble',
      `--force-device-scale-factor=${DEVICE_SCALE_FACTOR}`,
      `--high-dpi-support=${DEVICE_SCALE_FACTOR}`,
      `--window-size=${POPUP_VIEWPORT.width},${POPUP_VIEWPORT.height}`,
      'about:blank',
    ],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let stderr = '';
  chrome.stderr.on('data', chunk => {
    stderr += String(chunk || '');
    if (stderr.length > 8000) {
      stderr = stderr.slice(-8000);
    }
  });
  chrome.stdout.on('data', () => {});
  chrome.unref();

  return {
    process: chrome,
    getStderr: () => stderr.trim(),
  };
}

async function waitForCdp(port) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      await httpGetJson(`http://127.0.0.1:${port}/json/version`);
      return;
    } catch (_error) {
      await delay(250);
    }
  }
  throw new Error(`Timed out waiting for CDP on port ${port}.`);
}

async function waitForExtensionId(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const targets = await httpGetJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    for (const target of targets) {
      const url = String(target.url || '');
      const match = url.match(/^chrome-extension:\/\/([a-z]{32})\/build\/background\.js/);
      if (match) {
        return match[1];
      }
    }
    await delay(250);
  }
  throw new Error('Timed out waiting for the extension service worker to appear.');
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENT_BROWSER_SESSION: SESSION_NAME,
    },
    ...options,
  });

  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${output}`);
  }
  return output;
}

function agentBrowser(...args) {
  return runCommand('agent-browser', ['--session', SESSION_NAME, ...args]);
}

function agentEval(source) {
  return agentBrowser('eval', source);
}

function screenshotPath(name) {
  return path.join(OUTPUT_DIR, name);
}

function installPopupCaptureStyle() {
  return agentEval(`(() => {
    const existing = document.getElementById('jhl-marketing-capture-style');
    if (existing) {
      return 'ok';
    }
    const style = document.createElement('style');
    style.id = 'jhl-marketing-capture-style';
    style.textContent = \`
      body {
        overflow: hidden !important;
      }
      ._JX_container {
        position: fixed !important;
        top: 110px !important;
        right: 120px !important;
        left: auto !important;
        z-index: 2147483647 !important;
        transform: scale(1.08);
        transform-origin: top right;
        filter: drop-shadow(0 28px 60px rgba(3, 7, 18, 0.35));
      }
      ._JX_content_blocks {
        max-height: min(660px, calc(100vh - 220px)) !important;
      }
      ._JX_history_flyout {
        max-height: min(720px, calc(100vh - 180px)) !important;
      }
    \`;
    document.head.appendChild(style);
    return 'ok';
  })()`);
}

function scrollPopupToBlock(blockKey) {
  return agentEval(`(() => {
    const container = document.querySelector('._JX_content_blocks');
    const block = document.querySelector('[data-content-block="${blockKey}"]');
    if (!container || !block) {
      return 'missing';
    }
    container.scrollTop = Math.max(0, block.offsetTop - 14);
    return String(container.scrollTop);
  })()`);
}

function resetPopupScroll() {
  return agentEval(`(() => {
    const container = document.querySelector('._JX_content_blocks');
    if (!container) {
      return 'missing';
    }
    container.scrollTop = 0;
    return 'ok';
  })()`);
}

function openOptionsPage(optionsUrl) {
  agentBrowser('set', 'viewport', String(OPTIONS_VIEWPORT.width), String(OPTIONS_VIEWPORT.height));
  agentBrowser('open', optionsUrl);
  agentBrowser('wait', '1200');
}

function setPageZoom(scale) {
  agentEval(`document.documentElement.style.zoom = '${scale}'; document.body.style.zoom = '${scale}'; 'ok';`);
  agentBrowser('wait', '150');
}

function focusNewestTab() {
  const listing = agentBrowser('tab');
  const indexes = Array.from(listing.matchAll(/\[(\d+)\]/g))
    .map(match => Number(match[1]))
    .filter(Number.isFinite);
  if (!indexes.length) {
    throw new Error(`Could not parse tab list:\n${listing}`);
  }
  const newest = Math.max(...indexes);
  agentBrowser('tab', String(newest));
  agentBrowser('wait', '200');
}

function applyOptionsConfig(config, {showAdvanced = false, scrollY = 0} = {}) {
  agentEval(`(async () => {
    await chrome.storage.sync.set(${JSON.stringify(config)});
    sessionStorage.setItem('jhl_adv', '${showAdvanced ? '1' : '0'}');
    return 'ok';
  })()`);
  agentBrowser('reload');
  agentBrowser('wait', '1000');
  if (scrollY > 0) {
    agentEval(`window.scrollTo(0, ${scrollY}); 'ok';`);
    agentBrowser('wait', '250');
  } else {
    agentEval(`window.scrollTo(0, 0); 'ok';`);
  }
}

function saveInitialOptions({optionsUrl, instanceUrl, stageOrigin}) {
  openOptionsPage(optionsUrl);
  agentBrowser('fill', '[data-testid="options-instance-url"]', `${instanceUrl}/`);
  agentBrowser('fill', '[data-testid="options-domains"]', `${stageOrigin}/`);
  agentBrowser('click', '[data-testid="options-save"]');
  agentBrowser('wait', '1200');
  const notice = agentBrowser('get', 'text', '[data-testid="options-save-notice"]');
  if (!/saved successfully/i.test(notice)) {
    throw new Error(`Expected a successful save notice, got:\n${notice}`);
  }
}

function openPopupStage(stageUrl) {
  agentBrowser('set', 'viewport', String(POPUP_VIEWPORT.width), String(POPUP_VIEWPORT.height));
  agentBrowser('tab', 'new');
  focusNewestTab();
  agentBrowser('open', `${stageUrl}/popup-stage`);
  agentBrowser('wait', '#popup-key');
  agentBrowser('hover', '#popup-key');
  agentBrowser('wait', '._JX_container');
  installPopupCaptureStyle();
  agentBrowser('wait', '200');
  resetPopupScroll();
}

function closeCurrentTab() {
  try {
    agentBrowser('tab', 'close');
  } catch (_error) {
    // Ignore close failures during cleanup.
  }
}

function capturePopupShot(stageUrl, callback) {
  openPopupStage(stageUrl);
  try {
    callback();
  } finally {
    closeCurrentTab();
  }
}

async function main() {
  await fs.rm(OUTPUT_DIR, {recursive: true, force: true});
  await fs.mkdir(OUTPUT_DIR, {recursive: true});

  const chromePath = await findChromeExecutable();
  const extensionPath = await createExtensionCopy();
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jhl-agent-browser-profile-'));
  const jira = await createMockJiraServer();
  const stage = await createMarketingStageServer();
  const chrome = launchChrome({
    chromePath,
    extensionPath,
    userDataDir,
    port: CDP_PORT,
  });

  const cleanup = async () => {
    try {
      process.kill(-chrome.process.pid, 'SIGTERM');
    } catch (_error) {
      // Ignore if already closed.
    }
    await Promise.allSettled([
      jira.close(),
      stage.close(),
      fs.rm(userDataDir, {recursive: true, force: true}),
      fs.rm(extensionPath, {recursive: true, force: true}),
    ]);
  };

  try {
    await waitForCdp(CDP_PORT);
    const extensionId = await waitForExtensionId(CDP_PORT);
    const optionsUrl = `chrome-extension://${extensionId}/options/options.html`;
    const baseConfig = buildConfig({
      instanceUrl: jira.origin,
      domains: [`${stage.origin}/`],
    });
    const advancedConfig = buildConfig({
      instanceUrl: jira.origin,
      domains: [`${stage.origin}/`],
      customFields: [{fieldId: 'customfield_12345', row: 2}],
      tooltipLayout: {
        row1: ['issueType', 'status', 'priority', 'epicParent'],
        row2: ['sprint', 'affects', 'fixVersions', 'custom_customfield_12345'],
        row3: ['environment', 'labels'],
        contentBlocks: ['description', 'pullRequests', 'attachments', 'comments', 'timeTracking'],
        people: ['reporter', 'assignee'],
      },
    });

    agentBrowser('connect', String(CDP_PORT));
    saveInitialOptions({
      optionsUrl,
      instanceUrl: jira.origin,
      stageOrigin: stage.origin,
    });

    openOptionsPage(optionsUrl);
    applyOptionsConfig(baseConfig, {showAdvanced: false, scrollY: 0});
    setPageZoom(1.16);
    agentBrowser('screenshot', screenshotPath('options-basic-overview.png'));

    openOptionsPage(optionsUrl);
    applyOptionsConfig(advancedConfig, {showAdvanced: true, scrollY: 460});
    setPageZoom(1.12);
    agentBrowser('screenshot', screenshotPath('options-advanced-layout.png'));

    openOptionsPage(optionsUrl);
    applyOptionsConfig(advancedConfig, {showAdvanced: true, scrollY: 1260});
    setPageZoom(1.12);
    agentBrowser('screenshot', screenshotPath('options-advanced-sync.png'));

    capturePopupShot(stage.origin, () => {
      agentBrowser('screenshot', screenshotPath('popup-overview.png'));
    });

    capturePopupShot(stage.origin, () => {
      agentBrowser('click', '._JX_shortcuts_help');
      agentBrowser('wait', '._JX_shortcuts_panel');
      agentBrowser('screenshot', screenshotPath('popup-actions.png'));
    });

    capturePopupShot(stage.origin, () => {
      agentBrowser('click', '._JX_field_chip_edit[data-field-key="assignee"]');
      agentBrowser('wait', '._JX_edit_input[data-field-key="assignee"]');
      agentBrowser('fill', '._JX_edit_input[data-field-key="assignee"]', 'Mor');
      agentBrowser('wait', '._JX_edit_option[data-field-key="assignee"]');
      agentBrowser('screenshot', screenshotPath('popup-inline-editor.png'));
    });

    capturePopupShot(stage.origin, () => {
      scrollPopupToBlock('description');
      agentBrowser('click', '[data-testid="jira-popup-description-edit"]');
      agentBrowser('wait', '[data-testid="jira-popup-description-input"]');
      agentBrowser('fill', '[data-testid="jira-popup-description-input"]', 'Polish the final release notes and link the verified regression evidence.');
      agentBrowser('screenshot', screenshotPath('popup-description-editor.png'));
    });

    capturePopupShot(stage.origin, () => {
      scrollPopupToBlock('comments');
      agentBrowser('click', '._JX_comment_input');
      agentBrowser('fill', '._JX_comment_input', '@mor');
      agentBrowser('wait', '._JX_comment_mention_option');
      agentBrowser('screenshot', screenshotPath('popup-comment-compose.png'));
    });

    capturePopupShot(stage.origin, () => {
      scrollPopupToBlock('comments');
      agentBrowser('fill', '._JX_comment_input', 'Owned comment ready for follow-up edits.');
      agentBrowser('click', '._JX_comment_save');
      agentBrowser('wait', '._JX_comment_edit_button');
      agentEval(`(() => {
        const buttons = Array.from(document.querySelectorAll('._JX_comment_edit_button'));
        const last = buttons[buttons.length - 1];
        if (!last) {
          return 'missing';
        }
        last.click();
        return 'ok';
      })()`);
      agentBrowser('wait', '._JX_comment_edit_input');
      agentBrowser('fill', '._JX_comment_edit_input', 'Edited comment draft for the release checklist.');
      agentBrowser('screenshot', screenshotPath('popup-comment-edit.png'));
    });

    capturePopupShot(stage.origin, () => {
      scrollPopupToBlock('pullRequests');
      agentBrowser('screenshot', screenshotPath('popup-pull-requests.png'));
    });

    capturePopupShot(stage.origin, () => {
      agentBrowser('click', '._JX_history_toggle');
      agentBrowser('wait', '._JX_history_flyout');
      agentEval(`(() => {
        const summary = document.querySelector('._JX_history_flyout details summary');
        if (summary) {
          summary.click();
          return 'ok';
        }
        return 'missing';
      })()`);
      agentBrowser('wait', '200');
      agentBrowser('screenshot', screenshotPath('popup-history.png'));
    });

    const files = (await fs.readdir(OUTPUT_DIR))
      .filter(name => name.endsWith('.png'))
      .sort();
    console.log(JSON.stringify({
      extensionId,
      jiraOrigin: jira.origin,
      stageOrigin: stage.origin,
      outputDir: OUTPUT_DIR,
      files,
    }, null, 2));
  } catch (error) {
    const details = [
      error?.stack || String(error),
      chrome.getStderr() ? `Chrome stderr:\n${chrome.getStderr()}` : '',
    ].filter(Boolean).join('\n\n');
    console.error(details);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

main();
