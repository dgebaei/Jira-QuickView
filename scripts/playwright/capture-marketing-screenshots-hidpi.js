const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const {chromium} = require('playwright');
const {createMockJiraServer} = require('../../tests/e2e/helpers/mock-jira-server');
const {createFixtureServer} = require('../../tests/e2e/helpers/fixture-server');

const repoRoot = path.resolve(__dirname, '../..');
const extensionPath = path.join(repoRoot, 'jira-plugin');
const viewport = {width: 2560, height: 1600};
const deviceScaleFactor = 2;

function parseCliArgs(argv) {
  let theme = 'dark';
  let outputDirName = '';
  let layoutMode = 'tight-16x10';
  let includeUserGuide = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || '');
    if (value === '--theme') {
      theme = String(argv[index + 1] || '').trim().toLowerCase();
      index += 1;
      continue;
    }
    if (value === '--output-dir') {
      outputDirName = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (value === '--layout-mode') {
      layoutMode = String(argv[index + 1] || '').trim().toLowerCase();
      index += 1;
      continue;
    }
    if (value === '--user-guide') {
      includeUserGuide = true;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  if (!['dark', 'light', 'system'].includes(theme)) {
    throw new Error(`Invalid theme: ${theme}`);
  }
  if (!['tight-16x10', 'legacy'].includes(layoutMode)) {
    throw new Error(`Invalid layout mode: ${layoutMode}`);
  }

  if (!outputDirName) {
    outputDirName = theme === 'dark' ? 'marketing-hidpi' : `marketing-hidpi-${theme}`;
  }

  return {
    theme,
    layoutMode,
    includeUserGuide,
    screenshotDir: path.join(repoRoot, 'docs', 'screenshots', outputDirName),
  };
}

const cliOptions = parseCliArgs(process.argv.slice(2));
const screenshotDir = cliOptions.screenshotDir;
const userGuideScreenshotDir = path.join(repoRoot, 'docs', 'screenshots', 'user-guide');

const FIXTURE_STORIES = {
  overview: {
    heading: 'Review Jira issues without context switching.',
    lede: 'Hover a Jira key in a pull request, a notes app, or a bug triage queue and get issue context, inline edits, comments, attachments, and related PRs instantly.',
    bullets: [
      {title: 'At a Glance', body: 'Status, assignee, rich description, PRs, comments, and attachments stay one hover away.'},
      {title: 'Edit In Place', body: 'Adjust fields, descriptions, and comments without opening Jira in another tab.'},
      {title: 'Comment Reactions', body: 'React to discussion, add comments, and keep the issue thread moving from the popup.'},
      {title: 'Custom Fields', body: 'Bring Jira custom fields into the card so each team sees the data it actually uses.'},
    ],
    panelTitle: 'Linked Issue Review',
    panelBadge: 'Engineering',
    panelBlocks: [
      {
        label: 'Pull Request Thread',
        meta: 'Needs Triage',
        body: 'We should ship the editor fix after validating <span id="popup-key">JRACLOUD-97846</span> against the latest multiline slash-command behavior and attachment previews.',
      },
      {
        label: 'Release Checklist',
        meta: '4 core workflows',
        body: '<span class="jhl-accent">1.</span> Inspect issue context.<br/><span class="jhl-accent">2.</span> Edit fields inline.<br/><span class="jhl-accent">3.</span> Review related evidence.<br/><span class="jhl-accent">4.</span> Comment without leaving the page.',
      },
    ],
  },
  actions: {
    heading: 'Trigger Jira actions from the hover card.',
    lede: 'Run Jira-backed quick actions like assign to me, workflow transitions, and pinned popup controls directly from the preview.',
    bullets: [
      {title: 'Workflow Aware', body: 'Actions come from Jira capabilities and transitions, not hardcoded shortcuts.'},
      {title: 'Faster Triage', body: 'Move an issue forward while you are still reading the pull request or release note.'},
      {title: 'No Tab Hop', body: 'Open the action menu, apply the change, and keep working where you already are.'},
      {title: 'Pinned Context', body: 'Keep the popup open while you inspect related code, docs, and comments.'},
    ],
    panelTitle: 'Action Menu',
    panelBadge: 'Workflow',
    panelBlocks: [
      {
        label: 'Transition Review',
        meta: 'Jira backed',
        body: 'Use <span id="popup-key">JRACLOUD-97846</span> to test assign, copy, pin, and next-step workflow actions without opening the full issue page.',
      },
      {
        label: 'What It Replaces',
        meta: 'Fewer interruptions',
        body: '<span class="jhl-accent">1.</span> Open Jira.<br/><span class="jhl-accent">2.</span> Find the issue.<br/><span class="jhl-accent">3.</span> Change state.<br/><span class="jhl-accent">4.</span> Return to the review.',
      },
    ],
  },
  inlineEditor: {
    heading: 'Edit Jira fields where the work already is.',
    lede: 'Update assignee, status, sprint, labels, and supported Jira custom fields inline while the issue stays visible beside your current page.',
    bullets: [
      {title: 'Field Editing', body: 'Search and apply values directly inside the popup.'},
      {title: 'Custom Fields', body: 'Surface Jira custom fields in the card and edit supported custom field types in place.'},
      {title: 'Safer Updates', body: 'Use Jira-provided allowed values and validation rules.'},
      {title: 'Review Flow', body: 'Resolve metadata questions without leaving the PR or document.'},
    ],
    panelTitle: 'Inline Field Editing',
    panelBadge: 'Assignee',
    panelBlocks: [
      {
        label: 'Live Search',
        meta: 'Jira values',
        body: 'Hover <span id="popup-key">JRACLOUD-97846</span>, open the assignee chip, and search the exact Jira-backed value you need.',
      },
      {
        label: 'Layout Benefit',
        meta: 'Custom data',
        body: '<span class="jhl-accent">1.</span> Add Customer Impact.<br/><span class="jhl-accent">2.</span> Show Reviewer or Tempo fields.<br/><span class="jhl-accent">3.</span> Keep team-specific metadata visible.',
      },
    ],
  },
  descriptionEditor: {
    heading: 'Rewrite issue descriptions without opening Jira.',
    lede: 'Edit the description inline with formatting controls, pasted evidence, and immediate feedback while the original page stays in view.',
    bullets: [
      {title: 'Rich Editing', body: 'Update longer issue descriptions without leaving review context.'},
      {title: 'Formatting Tools', body: 'Use basic toolbar actions for lists, emphasis, and structured updates.'},
      {title: 'Evidence Ready', body: 'Attach screenshots and rollout notes directly from the popup flow.'},
      {title: 'Fewer Context Switches', body: 'Keep the source page and the issue side by side.'},
    ],
    panelTitle: 'Description Updates',
    panelBadge: 'Rich Text',
    panelBlocks: [
      {
        label: 'Release Notes',
        meta: 'Inline draft',
        body: 'Use <span id="popup-key">JRACLOUD-97846</span> to finalize rollout text, link evidence, and keep the issue accurate from the review page.',
      },
      {
        label: 'What Teams Gain',
        meta: 'Documentation speed',
        body: '<span class="jhl-accent">1.</span> Update specs.<br/><span class="jhl-accent">2.</span> Adjust release notes.<br/><span class="jhl-accent">3.</span> Keep Jira aligned with current work.',
      },
    ],
  },
  commentCompose: {
    heading: 'Add comments, mentions, and reactions in place.',
    lede: 'Reply to Jira threads directly from the hover popup, mention teammates, and keep lightweight review feedback moving without a detour to Jira.',
    bullets: [
      {title: 'Threaded Follow-Up', body: 'Draft the next comment while the issue and surrounding context stay visible.'},
      {title: 'Mentions', body: 'Use Jira mentions from the popup when you need another reviewer involved.'},
      {title: 'Reactions', body: 'Comment reactions are supported for lightweight acknowledgement and triage.'},
      {title: 'Shared Context', body: 'Comments live beside metadata, attachments, and related pull requests.'},
    ],
    panelTitle: 'Comment Workflow',
    panelBadge: 'Collaboration',
    panelBlocks: [
      {
        label: 'Follow-Up',
        meta: 'Mention ready',
        body: 'Hover <span id="popup-key">JRACLOUD-97846</span>, scan the thread, and post the next comment without interrupting the review.',
      },
      {
        label: 'Lightweight Coordination',
        meta: 'Thread + reactions',
        body: '<span class="jhl-accent">1.</span> Mention teammates.<br/><span class="jhl-accent">2.</span> Add reactions.<br/><span class="jhl-accent">3.</span> Keep the issue discussion current.',
      },
    ],
  },
  commentEdit: {
    heading: 'Refine issue discussions without losing the page.',
    lede: 'Edit existing comments, fix follow-up notes, and keep Jira conversations accurate while you continue reading the surrounding document or pull request.',
    bullets: [
      {title: 'Edit Existing Notes', body: 'Reword or clarify previously posted comments directly in the popup.'},
      {title: 'Stay in Context', body: 'Review the issue thread and current metadata at the same time.'},
      {title: 'Reactions Supported', body: 'Use emoji reactions alongside comments for faster acknowledgement.'},
      {title: 'Less Friction', body: 'Keep collaboration inside the same hover flow.'},
    ],
    panelTitle: 'Comment Cleanup',
    panelBadge: 'Thread Editing',
    panelBlocks: [
      {
        label: 'Issue Thread',
        meta: 'Current discussion',
        body: 'Open <span id="popup-key">JRACLOUD-97846</span>, revise the latest comment, and keep the Jira thread aligned with the latest decision.',
      },
      {
        label: 'Typical Use',
        meta: 'Review follow-up',
        body: '<span class="jhl-accent">1.</span> Fix wording.<br/><span class="jhl-accent">2.</span> Add clarification.<br/><span class="jhl-accent">3.</span> Preserve momentum in the current page.',
      },
    ],
  },
  pullRequests: {
    heading: 'See related pull requests and their status instantly.',
    lede: 'The popup can surface linked pull requests with their title, author, branch, and status so you can judge delivery state without leaving the current page.',
    bullets: [
      {title: 'PR Overview', body: 'See which pull requests are open, merged, or still in progress.'},
      {title: 'Status at a Glance', body: 'Read review state and branch context right inside the issue popup.'},
      {title: 'Release Readiness', body: 'Pair Jira status with code status before changing workflow state.'},
      {title: 'Fewer Clicks', body: 'No need to open Jira first just to find linked development work.'},
    ],
    panelTitle: 'Related Pull Requests',
    panelBadge: 'Delivery State',
    panelBlocks: [
      {
        label: 'Release Review',
        meta: 'PR status visible',
        body: 'Hover <span id="popup-key">JRACLOUD-97846</span> to see whether linked pull requests are still open, who owns them, and which branch they came from.',
      },
      {
        label: 'Why It Helps',
        meta: 'Before transitioning',
        body: '<span class="jhl-accent">1.</span> Check linked PRs.<br/><span class="jhl-accent">2.</span> Confirm merged state.<br/><span class="jhl-accent">3.</span> Move Jira only when code is ready.',
      },
    ],
  },
  attachments: {
    heading: 'Inspect attachments and rollout evidence inline.',
    lede: 'Open image attachments, compare screenshots, and validate release evidence without jumping away from the page where the Jira key appeared.',
    bullets: [
      {title: 'Preview Evidence', body: 'Image attachments are visible directly inside the popup.'},
      {title: 'Compare States', body: 'Use screenshots and exported visuals to validate fixes and regressions.'},
      {title: 'Context Nearby', body: 'Attachments live beside comments, description, and pull requests.'},
      {title: 'Release Friendly', body: 'Great for QA sweeps, rollout reviews, and bug triage.'},
    ],
    panelTitle: 'Evidence Review',
    panelBadge: 'Attachments',
    panelBlocks: [
      {
        label: 'Regression Evidence',
        meta: 'Visual proof',
        body: 'Hover <span id="popup-key">JRACLOUD-97846</span> to inspect screenshots, rollout evidence, and comparison images without opening Jira.',
      },
      {
        label: 'Useful In',
        meta: 'QA + release',
        body: '<span class="jhl-accent">1.</span> Bug triage.<br/><span class="jhl-accent">2.</span> Validation passes.<br/><span class="jhl-accent">3.</span> Final release checks.',
      },
    ],
  },
  history: {
    heading: 'Open change history next to the current issue state.',
    lede: 'Browse grouped history, recent field changes, comment edits, and referenced attachments directly from the popup.',
    bullets: [
      {title: 'Timeline View', body: 'See what changed and when without navigating into Jira history pages.'},
      {title: 'Grouped Updates', body: 'Follow related edits, comments, and attachment references together.'},
      {title: 'Richer Context', body: 'Useful during debugging, triage, and release verification.'},
      {title: 'One Hover Surface', body: 'Current state and historical state stay side by side.'},
    ],
    panelTitle: 'Issue Timeline',
    panelBadge: 'History',
    panelBlocks: [
      {
        label: 'Change Review',
        meta: 'Grouped timeline',
        body: 'Hover <span id="popup-key">JRACLOUD-97846</span> and open the history flyout to review recent edits, comments, and evidence in sequence.',
      },
      {
        label: 'Best For',
        meta: 'Triage context',
        body: '<span class="jhl-accent">1.</span> Audit latest edits.<br/><span class="jhl-accent">2.</span> Track who changed what.<br/><span class="jhl-accent">3.</span> Review discussion and evidence together.',
      },
    ],
  },
};

function buildConfig({instanceUrl, domains, customFields = [], tooltipLayout, themeMode = 'dark'} = {}) {
  return {
    instanceUrl: instanceUrl.endsWith('/') ? instanceUrl : `${instanceUrl}/`,
    domains,
    themeMode,
    v15upgrade: true,
    hoverDepth: 'shallow',
    hoverModifierKey: 'none',
    displayFields: {
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
    },
    tooltipLayout: tooltipLayout || {
      row1: ['issueType', 'status', 'priority', 'epicParent'],
      row2: ['sprint', 'affects', 'fixVersions'],
      row3: ['environment', 'labels'],
      contentBlocks: ['attachments', 'pullRequests', 'comments', 'timeTracking'],
      people: ['reporter', 'assignee'],
    },
    customFields,
  };
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

  throw new Error('Could not find a Chrome install under ~/.agent-browser/browsers.');
}

async function createTestExtensionCopy() {
  const extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jira-hot-linker-hidpi-extension-'));
  await fs.cp(extensionPath, extensionDir, {recursive: true});
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.permissions = Array.from(new Set([...(manifest.permissions || []), 'scripting']));
  manifest.host_permissions = ['<all_urls>'];
  manifest.optional_host_permissions = ['<all_urls>'];
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return extensionDir;
}

async function launchExtensionContext(executablePath) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jira-hot-linker-hidpi-profile-'));
  const testExtensionPath = await createTestExtensionCopy();
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: true,
    viewport,
    deviceScaleFactor,
    args: [
      `--disable-extensions-except=${testExtensionPath}`,
      `--load-extension=${testExtensionPath}`,
      '--force-device-scale-factor=2',
      '--high-dpi-support=2',
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

async function setOptionsState(page, config, {showAdvanced = false, scrollY = 0, zoom = 1.12} = {}) {
  await page.evaluate(async ({data, advanced, zoomLevel}) => {
    await chrome.storage.sync.set(data);
    await chrome.storage.local.remove('jqv.simpleSync');
    sessionStorage.setItem('jhl_adv', advanced ? '1' : '0');
    document.documentElement.style.zoom = String(zoomLevel);
    document.body.style.zoom = String(zoomLevel);
  }, {data: config, advanced: showAdvanced, zoomLevel: zoom});
  await page.reload({waitUntil: 'domcontentloaded'});
  await page.evaluate(({advanced, zoomLevel}) => {
    sessionStorage.setItem('jhl_adv', advanced ? '1' : '0');
    document.documentElement.style.zoom = String(zoomLevel);
    document.body.style.zoom = String(zoomLevel);
    window.scrollTo(0, 0);
  }, {advanced: showAdvanced, zoomLevel: zoom});
  if (scrollY > 0) {
    await page.evaluate(y => window.scrollTo(0, y), scrollY);
  }
  await page.waitForTimeout(250);
}

function buildFixtureStoryMarkup(storyKey = 'overview') {
  const story = FIXTURE_STORIES[storyKey] || FIXTURE_STORIES.overview;
  const bulletMarkup = story.bullets.map(({title, body}) => `
          <div class="jhl-bullet">
            <strong>${title}</strong>
            <span>${body}</span>
          </div>
  `).join('');
  const panelMarkup = story.panelBlocks.map(({label, meta, body}) => `
          <div class="jhl-review-block">
            <div class="jhl-review-meta">
              <span>${label}</span>
              <span>${meta}</span>
            </div>
            <p class="jhl-review-code">${body}</p>
          </div>
  `).join('');

  return `
      <section class="jhl-hero">
        <div class="jhl-eyebrow">Jira QuickView</div>
        <h1>${story.heading}</h1>
        <p class="jhl-lede">${story.lede}</p>
        <div class="jhl-grid">
          ${bulletMarkup}
        </div>
      </section>
      <section class="jhl-review">
        <div class="jhl-review-top">
          <div class="jhl-review-title">${story.panelTitle}</div>
          <div class="jhl-review-badge">${story.panelBadge}</div>
        </div>
        <div class="jhl-review-content">
          ${panelMarkup}
        </div>
      </section>
  `;
}

async function styleFixturePage(page, storyKey = 'overview') {
  const layoutPreset = cliOptions.layoutMode === 'legacy'
    ? {
        mainWidth: 'min(2200px, calc(100vw - 140px))',
        mainMargin: '0 auto',
        mainPadding: '92px 0 116px',
        mainColumns: 'minmax(0, 1.1fr) minmax(420px, 0.9fr)',
        mainGap: '56px',
        heroPaddingTop: '18px',
        popupTop: '110px',
        popupRight: '120px',
        popupScale: '1.08',
      }
    : {
        mainWidth: 'calc(100vw - 80px)',
        mainMargin: '0 40px',
        mainPadding: '64px 0 84px',
        mainColumns: 'minmax(760px, 1fr) minmax(940px, 1fr)',
        mainGap: '28px',
        heroPaddingTop: '4px',
        popupTop: '78px',
        popupRight: '48px',
        popupScale: '1.18',
      };

  await page.addStyleTag({
    content: `
      :root {
        color-scheme: light;
        --ink: #1a2435;
        --muted: rgba(26, 36, 53, 0.72);
        --line: rgba(88, 102, 126, 0.18);
      }
      body {
        min-height: 100vh;
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        background:
          radial-gradient(circle at 0% 0%, rgba(20, 184, 166, 0.22), transparent 30%),
          radial-gradient(circle at 100% 100%, rgba(249, 115, 22, 0.18), transparent 26%),
          linear-gradient(140deg, #f6f0e5 0%, #fff9f1 48%, #efe8db 100%);
        color: var(--ink);
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
        width: ${layoutPreset.mainWidth};
        margin: ${layoutPreset.mainMargin};
        padding: ${layoutPreset.mainPadding};
        display: grid;
        grid-template-columns: ${layoutPreset.mainColumns};
        gap: ${layoutPreset.mainGap};
        align-items: start;
      }
      .jhl-hero {
        padding-top: ${layoutPreset.heroPaddingTop};
      }
      .jhl-eyebrow {
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
      .jhl-eyebrow::before {
        content: "";
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: #14b8a6;
        box-shadow: 0 0 0 6px rgba(20, 184, 166, 0.14);
      }
      .jhl-hero h1 {
        max-width: 9ch;
        margin: 20px 0 18px;
        font-size: clamp(62px, 7vw, 88px);
        line-height: 0.94;
        letter-spacing: -0.05em;
      }
      .jhl-lede {
        max-width: 32rem;
        margin: 0 0 28px;
        color: var(--muted);
        font: 500 20px/1.6 ui-sans-serif, system-ui, sans-serif;
      }
      .jhl-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }
      .jhl-bullet {
        border: 1px solid var(--line);
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.78);
        padding: 16px 18px;
        box-shadow: 0 24px 48px rgba(63, 58, 45, 0.08);
      }
      .jhl-bullet strong {
        display: block;
        margin-bottom: 6px;
        font: 700 13px/1.2 ui-sans-serif, system-ui, sans-serif;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .jhl-bullet span {
        color: var(--muted);
        font: 500 15px/1.55 ui-sans-serif, system-ui, sans-serif;
      }
      .jhl-review {
        position: relative;
        border: 1px solid rgba(20, 184, 166, 0.18);
        border-radius: 28px;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(252, 248, 242, 0.82));
        box-shadow: 0 36px 92px rgba(88, 73, 47, 0.12);
        overflow: hidden;
      }
      .jhl-review-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 20px 24px 18px;
        border-bottom: 1px solid var(--line);
      }
      .jhl-review-title {
        font: 700 15px/1.3 ui-sans-serif, system-ui, sans-serif;
      }
      .jhl-review-badge {
        padding: 7px 11px;
        border-radius: 999px;
        background: rgba(20, 184, 166, 0.12);
        color: #0f766e;
        font: 700 12px/1 ui-sans-serif, system-ui, sans-serif;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .jhl-review-content {
        padding: 24px;
        display: grid;
        gap: 18px;
      }
      .jhl-review-block {
        border: 1px solid var(--line);
        border-radius: 22px;
        background: rgba(255, 255, 255, 0.8);
        padding: 18px 20px;
      }
      .jhl-review-meta {
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
      .jhl-review-code {
        margin: 0;
        white-space: pre-wrap;
        font: 500 16px/1.8 ui-monospace, SFMono-Regular, Menlo, monospace;
        color: #233146;
      }
      .jhl-accent {
        color: #c2410c;
      }
      #popup-key {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(20, 184, 166, 0.14);
        color: #0f766e;
      }
      body ._JX_container {
        position: fixed !important;
        top: ${layoutPreset.popupTop} !important;
        right: ${layoutPreset.popupRight} !important;
        left: auto !important;
        transform: scale(${layoutPreset.popupScale});
        transform-origin: top right;
        filter: drop-shadow(0 28px 60px rgba(3, 7, 18, 0.35));
        z-index: 999999 !important;
      }
      body ._JX_content_blocks {
        max-height: min(660px, calc(100vh - 220px)) !important;
      }
      body ._JX_history_flyout {
        max-height: min(720px, calc(100vh - 180px)) !important;
      }
    `,
  });

  await page.evaluate(markup => {
    document.querySelector('main').innerHTML = markup;
  }, buildFixtureStoryMarkup(storyKey));
}

async function openStyledPopupPage(context, serviceWorker, fixtureOrigin, storyKey = 'overview') {
  const page = await context.newPage();
  await page.goto(`${fixtureOrigin}/popup-actions`, {waitUntil: 'domcontentloaded'});
  await styleFixturePage(page, storyKey);
  await injectContentScript(serviceWorker, page);
  await page.locator('#popup-key').hover();
  await page.locator('._JX_container').waitFor({state: 'visible'});
  return page;
}

async function saveOptionsShots(context, extensionId, config) {
  const optionsUrl = `chrome-extension://${extensionId}/options/options.html`;
  const optionsPage = await context.newPage();
  await optionsPage.goto(optionsUrl, {waitUntil: 'domcontentloaded'});

  await setOptionsState(optionsPage, config, {showAdvanced: false, scrollY: 0, zoom: 1.16});
  await applyOptionsMarketingAdjustments(optionsPage);
  await saveOptionsPageScreenshot(optionsPage, path.join(screenshotDir, 'options-basic-overview.png'));
  await saveUserGuideLocatorScreenshot(optionsPage.locator('.settingsGrid').first(), 'options-basic-settings.png');
  await saveUserGuideLocatorScreenshot(optionsPage.locator('.advancedPanel'), 'options-advanced-toggle.png');
  await saveUserGuideLocatorScreenshot(optionsPage.locator('.actionBar'), 'options-save-discard.png');

  await setOptionsState(optionsPage, config, {showAdvanced: true, scrollY: 460, zoom: 1.12});
  await applyOptionsMarketingAdjustments(optionsPage);
  await saveOptionsPageScreenshot(optionsPage, path.join(screenshotDir, 'options-advanced-layout.png'));
  await saveUserGuideLocatorScreenshot(optionsPage.locator('.settingsCard.settingsGridFull').nth(0), 'options-hover-behavior.png');
  await saveUserGuideLocatorScreenshot(optionsPage.locator('.settingsCard.settingsGridFull').nth(1), 'options-tooltip-layout.png');
  const teamSyncCard = optionsPage.locator('.settingsCard.settingsGridFull').nth(2);
  await optionsPage.getByTestId('options-team-sync-source-type').selectOption('jiraAttachment');
  await optionsPage.getByTestId('options-team-sync-issue-key').fill('OPS-123');
  await optionsPage.getByTestId('options-team-sync-file-name').fill('jira-quickview-settings.json');
  await saveUserGuideLocatorScreenshot(teamSyncCard, 'options-settings-sync.png');
  await saveUserGuideLocatorScreenshot(teamSyncCard, 'options-settings-sync-jira-attachment.png');

  await optionsPage.getByTestId('options-team-sync-source-type').selectOption('url');
  await optionsPage.getByTestId('options-team-sync-url').fill('https://config.example.com/jira-quickview-settings.json');
  await saveUserGuideLocatorScreenshot(teamSyncCard, 'options-settings-sync-url.png');

  await setOptionsState(optionsPage, config, {showAdvanced: true, scrollY: 460, zoom: 1.12});
  await applyOptionsMarketingAdjustments(optionsPage);
  await optionsPage.getByTestId('options-field-library-add').click();
  await optionsPage.getByTestId('options-field-library-input').fill('customfield_67890');
  await optionsPage.getByTestId('options-field-library-validation').waitFor();
  await optionsPage.getByTestId('options-field-library-save').click();
  await optionsPage.evaluate(() => {
    window.__JHL_TEST_API__?.moveTooltipField?.('custom_customfield_67890', 'row3', 1);
  });
  await optionsPage.waitForTimeout(200);
  await saveOptionsPageScreenshot(optionsPage, path.join(screenshotDir, 'options-custom-fields.png'));
  await saveUserGuideLocatorScreenshot(optionsPage.locator('.settingsCard.settingsGridFull').nth(1), 'options-custom-fields.png');

  await optionsPage.close();
}

async function saveOptionsPageScreenshot(page, outputPath) {
  const root = page.locator('.optionsPage');
  await root.scrollIntoViewIfNeeded();
  await root.screenshot({
    path: outputPath,
    animations: 'disabled',
  });
}

async function saveUserGuideLocatorScreenshot(locator, fileName) {
  if (!cliOptions.includeUserGuide) {
    return;
  }
  await locator.scrollIntoViewIfNeeded();
  await locator.screenshot({
    path: path.join(userGuideScreenshotDir, fileName),
    animations: 'disabled',
  });
}

async function capturePopupOverview(context, serviceWorker, fixtureOrigin) {
  const page = await openStyledPopupPage(context, serviceWorker, fixtureOrigin, 'overview');
  await savePopupCompositionScreenshot(page, 'popup-overview.png');
  await page.close();
}

async function capturePopupActions(context, serviceWorker, fixtureOrigin) {
  const page = await openStyledPopupPage(context, serviceWorker, fixtureOrigin, 'actions');
  await page.locator('._JX_actions_toggle').click();
  await page.locator('._JX_action_item').first().waitFor();
  await savePopupCompositionScreenshot(page, 'popup-actions.png');
  await page.close();
}

async function capturePopupInlineEditor(context, serviceWorker, fixtureOrigin) {
  const page = await openStyledPopupPage(context, serviceWorker, fixtureOrigin, 'inlineEditor');
  await page.locator('._JX_field_chip_edit[data-field-key="assignee"]').click();
  await page.locator('._JX_edit_input[data-field-key="assignee"]').fill('Mor');
  await page.locator('._JX_edit_option[data-field-key="assignee"]').first().waitFor();
  await savePopupCompositionScreenshot(page, 'popup-inline-editor.png');
  await page.close();
}

async function capturePopupDescriptionEditor(context, serviceWorker, fixtureOrigin) {
  const page = await openStyledPopupPage(context, serviceWorker, fixtureOrigin, 'descriptionEditor');
  await scrollPopupContentBlock(page, 'description');
  await page.getByTestId('jira-popup-description-edit').click();
  await page.getByTestId('jira-popup-description-input').fill('Polish the final release notes and link the verified regression evidence.');
  await savePopupCompositionScreenshot(page, 'popup-description-editor.png');
  await page.close();
}

async function capturePopupCommentCompose(context, serviceWorker, fixtureOrigin) {
  const page = await openStyledPopupPage(context, serviceWorker, fixtureOrigin, 'commentCompose');
  await scrollPopupContentBlock(page, 'comments');
  await page.locator('._JX_comment_input').fill('@mor');
  await page.locator('._JX_comment_mention_option').first().waitFor();
  await savePopupCompositionScreenshot(page, 'popup-comment-compose.png');
  await page.close();
}

async function capturePopupCommentEdit(context, serviceWorker, fixtureOrigin) {
  const page = await openStyledPopupPage(context, serviceWorker, fixtureOrigin, 'commentEdit');
  await scrollPopupContentBlock(page, 'comments');
  await page.locator('._JX_comment_input').fill('Owned comment ready for follow-up edits.');
  await page.locator('._JX_comment_save').click();
  const latestComment = page.locator('._JX_comment').last();
  await latestComment.locator('._JX_comment_edit_button').click();
  await latestComment.locator('._JX_comment_edit_input').fill('Edited comment draft for the release checklist.');
  await savePopupCompositionScreenshot(page, 'popup-comment-edit.png');
  await page.close();
}

async function capturePopupPullRequests(context, serviceWorker, fixtureOrigin) {
  const page = await openStyledPopupPage(context, serviceWorker, fixtureOrigin, 'pullRequests');
  await page.locator('text=Fix slash command cursor behavior').waitFor();
  await scrollPopupContentBlock(page, 'pullRequests');
  await savePopupCompositionScreenshot(page, 'popup-pull-requests.png');
  await page.close();
}

async function capturePopupAttachments(context, serviceWorker, fixtureOrigin) {
  const page = await openStyledPopupPage(context, serviceWorker, fixtureOrigin, 'attachments');
  await page.locator('._JX_thumb').first().waitFor();
  await scrollPopupContentBlock(page, 'attachments');
  await savePopupCompositionScreenshot(page, 'popup-attachments.png');
  await page.close();
}

async function capturePopupHistory(context, serviceWorker, fixtureOrigin) {
  const page = await openStyledPopupPage(context, serviceWorker, fixtureOrigin, 'history');
  await page.locator('._JX_history_toggle').click();
  await page.locator('._JX_history_flyout').waitFor();
  const firstSummary = page.locator('._JX_history_flyout details summary').first();
  if (await firstSummary.count()) {
    await firstSummary.click();
  }
  await savePopupCompositionScreenshot(page, 'popup-history.png');
  await page.close();
}

async function captureUserGuidePopupShots(context, serviceWorker, fixtureOrigin) {
  const overviewPage = await openStyledPopupPage(context, serviceWorker, fixtureOrigin, 'overview');
  await saveUserGuideLocatorScreenshot(overviewPage.locator('._JX_title'), 'popup-header.png');
  await saveUserGuideLocatorScreenshot(overviewPage.locator('._JX_status'), 'popup-rows.png');
  await overviewPage.locator('._JX_watchers_trigger').click();
  await overviewPage.locator('._JX_watchers_panel').waitFor();
  await saveUserGuideLocatorScreenshot(overviewPage.locator('._JX_watchers_panel'), 'popup-watchers-panel.png');
  await overviewPage.close();

  const timeTrackingPage = await openStyledPopupPage(context, serviceWorker, fixtureOrigin, 'overview');
  await scrollPopupContentBlock(timeTrackingPage, 'timeTracking');
  await timeTrackingPage.locator('[data-content-block="timeTracking"]').waitFor();
  await saveUserGuideLocatorScreenshot(timeTrackingPage.locator('[data-content-block="timeTracking"]'), 'popup-time-tracking.png');
  await timeTrackingPage.close();
}

async function scrollPopupContentBlock(page, blockName) {
  await page.evaluate(targetBlockName => {
    const container = document.querySelector('._JX_content_blocks');
    const block = document.querySelector(`[data-content-block="${targetBlockName}"]`);
    if (container && block) {
      container.scrollTop = Math.max(0, block.offsetTop - 16);
    }
  }, blockName);
}

async function applyOptionsMarketingAdjustments(page) {
  await page.evaluate(() => {
    const toggleDescription = document.querySelector('.advToggleText p');
    if (toggleDescription) {
      toggleDescription.textContent = 'Hover trigger depth, modifier keys, field layout editor, and Jira custom fields.';
    }
  });
}

async function savePopupCompositionScreenshot(page, fileName) {
  const clip = await page.evaluate(({viewportWidth, viewportHeight, targetAspectRatio, layoutMode}) => {
    const selectors = ['main', '._JX_container', '._JX_history_flyout'];
    const rects = selectors
      .map(selector => document.querySelector(selector))
      .filter(Boolean)
      .map(element => {
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
          return null;
        }
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) {
          return null;
        }
        return {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom};
      })
      .filter(Boolean);

    if (!rects.length) {
      return null;
    }

    const padding = 24;
    const bounds = {
      left: Math.max(0, Math.min(...rects.map(rect => rect.left)) - padding),
      top: Math.max(0, Math.min(...rects.map(rect => rect.top)) - padding),
      right: Math.min(viewportWidth, Math.max(...rects.map(rect => rect.right)) + padding),
      bottom: Math.min(viewportHeight, Math.max(...rects.map(rect => rect.bottom)) + padding),
    };

    let width = bounds.right - bounds.left;
    let height = bounds.bottom - bounds.top;

    if (layoutMode !== 'legacy') {
      if (width / height > targetAspectRatio) {
        height = width / targetAspectRatio;
      } else {
        width = height * targetAspectRatio;
      }

      width = Math.min(width, viewportWidth);
      height = Math.min(height, viewportHeight);
    }

    let x = ((bounds.left + bounds.right) / 2) - (width / 2);
    let y = ((bounds.top + bounds.bottom) / 2) - (height / 2);

    x = Math.max(0, Math.min(x, viewportWidth - width));
    y = Math.max(0, Math.min(y, viewportHeight - height));

    return {
      x: Math.floor(x),
      y: Math.floor(y),
      width: Math.max(1, Math.ceil(width)),
      height: Math.max(1, Math.ceil(height)),
    };
  }, {
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    targetAspectRatio: 16 / 10,
    layoutMode: cliOptions.layoutMode,
  });

  await page.screenshot({
    path: path.join(screenshotDir, fileName),
    ...(clip ? {clip} : {}),
  });
}

async function main() {
  await fs.rm(screenshotDir, {recursive: true, force: true});
  await fs.mkdir(screenshotDir, {recursive: true});
  if (cliOptions.includeUserGuide) {
    await fs.rm(userGuideScreenshotDir, {recursive: true, force: true});
    await fs.mkdir(userGuideScreenshotDir, {recursive: true});
  }

  const executablePath = await findChromeExecutable();
  const jira = await createMockJiraServer();
  const fixture = await createFixtureServer();
  const {context, serviceWorker, extensionId, userDataDir, testExtensionPath} = await launchExtensionContext(executablePath);

  try {
    const config = buildConfig({
      instanceUrl: jira.origin,
      domains: [`${fixture.origin}/`],
      themeMode: cliOptions.theme,
      customFields: [{fieldId: 'customfield_12345', row: 3}],
      tooltipLayout: {
        row1: ['issueType', 'status', 'priority', 'epicParent'],
        row2: ['sprint', 'affects', 'fixVersions'],
        row3: ['environment', 'labels', 'custom_customfield_12345'],
        contentBlocks: ['pullRequests', 'attachments', 'comments', 'timeTracking'],
        people: ['reporter', 'assignee'],
      },
    });

    await saveOptionsShots(context, extensionId, config);
    await capturePopupOverview(context, serviceWorker, fixture.origin);
    await capturePopupActions(context, serviceWorker, fixture.origin);
    await capturePopupInlineEditor(context, serviceWorker, fixture.origin);
    await capturePopupDescriptionEditor(context, serviceWorker, fixture.origin);
    await capturePopupCommentCompose(context, serviceWorker, fixture.origin);
    await capturePopupCommentEdit(context, serviceWorker, fixture.origin);
    await capturePopupPullRequests(context, serviceWorker, fixture.origin);
    await capturePopupAttachments(context, serviceWorker, fixture.origin);
    await capturePopupHistory(context, serviceWorker, fixture.origin);
    if (cliOptions.includeUserGuide) {
      await captureUserGuidePopupShots(context, serviceWorker, fixture.origin);
    }

    const files = (await fs.readdir(screenshotDir)).filter(name => name.endsWith('.png')).sort();
    const result = {
      screenshotDir,
      files,
      viewport,
      deviceScaleFactor,
      themeMode: cliOptions.theme,
      layoutMode: cliOptions.layoutMode,
    };
    if (cliOptions.includeUserGuide) {
      result.userGuideScreenshotDir = userGuideScreenshotDir;
      result.userGuideFiles = (await fs.readdir(userGuideScreenshotDir)).filter(name => name.endsWith('.png')).sort();
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context.close();
    await Promise.allSettled([
      jira.close(),
      fixture.close(),
      fs.rm(userDataDir, {recursive: true, force: true}),
      fs.rm(testExtensionPath, {recursive: true, force: true}),
    ]);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
