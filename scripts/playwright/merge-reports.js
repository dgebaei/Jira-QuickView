const {spawnSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');
const outputRoot = path.join(repoRoot, 'tests/output/playwright');
const blobDir = path.join(outputRoot, 'blob-report');
const mergedReportDir = path.join(outputRoot, 'report');
const runsDir = path.join(outputRoot, 'runs');
const explorerPath = path.join(outputRoot, 'index.html');
const metadataPath = path.join(outputRoot, 'runs.json');

const laneMeta = {
  'mock-edge': {
    title: 'Mock Failure Coverage',
    description: 'Deterministic unhappy-path coverage using mocked Jira failures and controlled edge cases.',
  },
  'public-smoke': {
    title: 'Public Jira Smoke',
    description: 'Anonymous smoke coverage against public Atlassian Jira pages.',
  },
  'live-authenticated': {
    title: 'Authenticated Jira Cloud',
    description: 'Authenticated Jira Cloud flows against the configured tenant with safe restoration.',
  },
  extension: {
    title: 'Legacy Extension',
    description: 'Legacy extension run stored before the lane split.',
  },
  'live-jira': {
    title: 'Legacy Live Jira',
    description: 'Legacy live Jira run stored before the lane split.',
  },
  'public-jira': {
    title: 'Legacy Public Jira',
    description: 'Legacy public Jira run stored before the lane split.',
  },
  'all-tests': {
    title: 'Test Run',
    description: 'Combined run across mocked failure coverage, public Jira smoke tests, and authenticated Jira Cloud tests.',
  },
};

const suiteMeta = {
  'advanced-mock-flows.spec.js': 'Editing, Assignment, and Workflow Actions',
  'error-states.spec.js': 'Connection and Access States',
  'hover-and-popup.spec.js': 'Popup Trigger Behavior',
  'live-jira.spec.js': 'Authenticated Jira Mutations',
  'mock-jira-flows.spec.js': 'Issue Content and Comment Workflows',
  'options.spec.js': 'Extension Settings and Validation',
  'partial-failures.spec.js': 'Partial Failure Recovery',
  'public-jira.spec.js': 'Public Jira Smoke Coverage',
};

function getArgValue(flagName) {
  const prefix = `--${flagName}=`;
  const arg = process.argv.slice(2).find(value => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

function timestampToIsoString(value) {
  return String(value || '').replace(
    /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/,
    '$1T$2:$3:$4.$5Z'
  );
}

function parseRunId(runId) {
  const match = String(runId || '').match(/^(.*)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/);
  if (!match) {
    return {
      label: String(runId || ''),
      createdAt: '',
    };
  }

  return {
    label: match[1],
    createdAt: timestampToIsoString(match[2]),
  };
}

function getLaneInfo(label) {
  return laneMeta[label] || {
    title: String(label || 'Unknown run')
      .split('-')
      .filter(Boolean)
      .map(token => token.charAt(0).toUpperCase() + token.slice(1))
      .join(' '),
    description: 'Saved Playwright run.',
  };
}

function mergeBlobDirectory(sourceDir, outputDir, reporter) {
  fs.mkdirSync(outputDir, {recursive: true});
  const env = {
    ...process.env,
    PLAYWRIGHT_HTML_OUTPUT_DIR: outputDir,
    PLAYWRIGHT_HTML_OPEN: 'never',
  };

  return spawnSync('npm', ['exec', '--', 'playwright', 'merge-reports', '--reporter', reporter, sourceDir], {
    cwd: repoRoot,
    env,
    stdio: reporter === 'html' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}

function loadRunMetadata() {
  if (!fs.existsSync(metadataPath)) {
    return [];
  }

  try {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf8')) || [];
  } catch (error) {
    return [];
  }
}

function saveRunMetadata(entries) {
  fs.mkdirSync(outputRoot, {recursive: true});
  fs.writeFileSync(metadataPath, `${JSON.stringify(entries, null, 2)}\n`);
}

function formatDuration(durationMs) {
  const duration = Number(durationMs || 0);
  if (!duration) {
    return '0s';
  }
  if (duration >= 60000) {
    return `${(duration / 60000).toFixed(1)}m`;
  }
  return `${(duration / 1000).toFixed(1)}s`;
}

function classifySpec(spec) {
  const tests = Array.isArray(spec.tests) ? spec.tests : [];
  const testStatuses = tests.map(test => test.status).filter(Boolean);
  const results = tests.flatMap(test => Array.isArray(test.results) ? test.results : []);

  if (testStatuses.includes('flaky')) {
    return 'flaky';
  }
  if (results.some(result => ['failed', 'timedOut', 'interrupted'].includes(result.status))) {
    return 'failed';
  }
  if (results.length && results.every(result => result.status === 'skipped')) {
    return 'skipped';
  }
  if (results.some(result => result.status === 'passed')) {
    return 'passed';
  }
  return 'unknown';
}

function describeTest(specTitle, suiteFile) {
  const title = String(specTitle || '');
  if (suiteFile === 'live-jira.spec.js' && title.includes('priority')) {
    return 'Confirms the extension can change Jira priority and restore the original value safely.';
  }
  if (suiteFile === 'live-jira.spec.js' && title.includes('assignee')) {
    return 'Confirms assignment actions work against the real Jira tenant and return the issue to its prior assignee.';
  }
  if (suiteFile === 'live-jira.spec.js' && title.includes('temporary label')) {
    return 'Confirms label editing works with reusable tenant data and cleans up after itself.';
  }
  if (title.includes('configured domains')) {
    return 'Verifies the extension injects only on approved Jira pages.';
  }
  if (title.includes('hover detection')) {
    return 'Verifies popup behavior across exact, shallow, and deep hover targeting modes.';
  }
  if (title.includes('modifier key')) {
    return 'Verifies popup activation respects the configured modifier key.';
  }
  if (title.includes('quick actions')) {
    return 'Checks whether Jira quick actions appear only when the issue state makes them relevant.';
  }
  if (title.includes('options page')) {
    return 'Confirms the settings page validates, saves, and reloads extension configuration correctly.';
  }
  if (title.includes('public Atlassian')) {
    return 'Confirms the extension still opens on anonymous public Jira pages.';
  }
  if (title.includes('search results')) {
    return 'Confirms the popup can open from public Jira search results as well as issue pages.';
  }
  if (title.includes('pull request')) {
    return 'Checks that the popup stays usable even when development-data endpoints fail.';
  }
  if (title.includes('comment')) {
    return 'Exercises comment creation and related composer behavior.';
  }
  if (title.includes('empty states')) {
    return 'Verifies optional Jira fields render gracefully when no values exist.';
  }
  return 'End-to-end check for this extension workflow.';
}

function cleanErrorText(value) {
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  return String(value || '')
    .replace(ansiPattern, '')
    .trim();
}

function mapAttachmentPath(attachmentPath, runId) {
  if (!attachmentPath) {
    return '';
  }
  return `./runs/${runId}/resources/${path.basename(attachmentPath)}`;
}

function summarizeSpecDetails(spec, runId) {
  const tests = Array.isArray(spec.tests) ? spec.tests : [];
  const results = tests.flatMap(test => Array.isArray(test.results) ? test.results : []);
  const latestResult = results[results.length - 1] || null;
  const projectName = tests[0]?.projectName || '';
  const errors = results
    .flatMap(result => Array.isArray(result.errors) ? result.errors : [])
    .map(error => cleanErrorText(error?.message || error?.stack || ''))
    .filter(Boolean);
  const attachments = results
    .flatMap(result => Array.isArray(result.attachments) ? result.attachments : [])
    .map(attachment => ({
      name: attachment.name || 'attachment',
      contentType: attachment.contentType || '',
      path: mapAttachmentPath(attachment.path, runId),
    }))
    .filter(attachment => attachment.path);

  return {
    projectName,
    projectTitle: getLaneInfo(projectName).title,
    errors,
    attachments,
    startTime: latestResult?.startTime || '',
    retry: Number(latestResult?.retry || 0),
  };
}

function summarizeJsonReport(reportData) {
  const summary = {
    total: 0,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    durationMs: 0,
  };
  const suites = [];

  function visitSuite(suite) {
    const nestedSuites = Array.isArray(suite.suites) ? suite.suites : [];
    for (const child of nestedSuites) {
      visitSuite(child);
    }

    const specs = Array.isArray(suite.specs) ? suite.specs : [];
    if (!specs.length) {
      return;
    }

    const tests = specs.map(spec => {
      const status = classifySpec(spec);
      const durationMs = (spec.tests || []).flatMap(test => test.results || []).reduce((total, result) => total + Number(result.duration || 0), 0);
      summary.total += 1;
      summary.durationMs += durationMs;
      if (status === 'passed') summary.passed += 1;
      if (status === 'failed') summary.failed += 1;
      if (status === 'flaky') summary.flaky += 1;
      if (status === 'skipped') summary.skipped += 1;

      const details = summarizeSpecDetails(spec, reportData._runId || '');
      return {
        title: spec.title,
        file: spec.file,
        line: spec.line,
        status,
        durationMs,
        description: describeTest(spec.title, spec.file),
        projectName: details.projectName,
        projectTitle: details.projectTitle,
        errors: details.errors,
        attachments: details.attachments,
        startTime: details.startTime,
        retry: details.retry,
      };
    });

    suites.push({
      file: suite.file || specs[0].file,
      title: suiteMeta[suite.file || specs[0].file] || (suite.title || suite.file || 'Unnamed suite'),
      rawTitle: suite.title || suite.file || 'Unnamed suite',
      total: tests.length,
      passed: tests.filter(test => test.status === 'passed').length,
      failed: tests.filter(test => test.status === 'failed').length,
      flaky: tests.filter(test => test.status === 'flaky').length,
      skipped: tests.filter(test => test.status === 'skipped').length,
      durationMs: tests.reduce((total, test) => total + test.durationMs, 0),
      tests,
    });
  }

  for (const suite of reportData.suites || []) {
    visitSuite(suite);
  }

  suites.sort((left, right) => left.title.localeCompare(right.title));
  return {summary, suites};
}

function generateJsonReport(sourceDir, outputFile) {
  const result = mergeBlobDirectory(sourceDir, path.dirname(outputFile), 'json');
  if (result.status !== 0) {
    return result;
  }
  fs.writeFileSync(outputFile, result.stdout || '{}');
  return result;
}

function buildRunEntry(fileName, existingEntry, latestStatus, latestParentRunId, latestParentRunLabel) {
  const runId = fileName.replace(/\.zip$/, '');
  const parsed = parseRunId(runId);
  return {
    runId,
    label: existingEntry?.label || parsed.label,
    createdAt: existingEntry?.createdAt || parsed.createdAt,
    status: latestStatus || existingEntry?.status || 'unknown',
    blobFile: fileName,
    mergedReportPath: './report/index.html',
    runReportPath: `./runs/${runId}/index.html`,
    jsonReportPath: `./runs/${runId}/report.json`,
    parentRunId: latestParentRunId || existingEntry?.parentRunId || '',
    parentRunLabel: latestParentRunLabel || existingEntry?.parentRunLabel || '',
    laneTitle: getLaneInfo(existingEntry?.label || parsed.label).title,
    laneDescription: getLaneInfo(existingEntry?.label || parsed.label).description,
    summary: existingEntry?.summary || null,
    suites: existingEntry?.suites || [],
  };
}

function ensureRunArtifacts(entry, latestRunId) {
  const zipPath = path.join(blobDir, entry.blobFile);
  const outputDir = path.join(runsDir, entry.runId);
  const outputIndexPath = path.join(outputDir, 'index.html');
  const outputJsonPath = path.join(outputDir, 'report.json');

  if (!fs.existsSync(outputIndexPath) || entry.runId === latestRunId) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-hotlinker-playwright-'));
    try {
      fs.copyFileSync(zipPath, path.join(tempDir, entry.blobFile));
      const htmlResult = mergeBlobDirectory(tempDir, outputDir, 'html');
      if (htmlResult.status !== 0) {
        return htmlResult;
      }
      const jsonResult = generateJsonReport(tempDir, outputJsonPath);
      if (jsonResult.status !== 0) {
        return jsonResult;
      }
    } finally {
      fs.rmSync(tempDir, {recursive: true, force: true});
    }
  } else if (!fs.existsSync(outputJsonPath)) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-hotlinker-playwright-'));
    try {
      fs.copyFileSync(zipPath, path.join(tempDir, entry.blobFile));
      const jsonResult = generateJsonReport(tempDir, outputJsonPath);
      if (jsonResult.status !== 0) {
        return jsonResult;
      }
    } finally {
      fs.rmSync(tempDir, {recursive: true, force: true});
    }
  }

  try {
    const parsedReport = JSON.parse(fs.readFileSync(outputJsonPath, 'utf8'));
    const extracted = summarizeJsonReport(parsedReport);
    entry.summary = extracted.summary;
    entry.suites = extracted.suites;
  } catch (error) {
    entry.summary = entry.summary || null;
    entry.suites = entry.suites || [];
  }

  return {status: 0};
}

function syncRunEntries(blobFiles, latestRunId, latestStatus, latestParentRunId, latestParentRunLabel) {
  const existingEntries = loadRunMetadata();
  const nextEntries = blobFiles
    .filter(fileName => fileName.endsWith('.zip') && !fileName.startsWith('report-'))
    .map(fileName => {
      const runId = fileName.replace(/\.zip$/, '');
      const existingEntry = existingEntries.find(entry => entry.runId === runId);
      return buildRunEntry(
        fileName,
        existingEntry,
        runId === latestRunId ? latestStatus : '',
        runId === latestRunId ? latestParentRunId : '',
        runId === latestRunId ? latestParentRunLabel : ''
      );
    })
    .filter(entry => entry.createdAt || entry.parentRunId || laneMeta[entry.label]);

  nextEntries.sort((left, right) => String(right.createdAt || right.runId).localeCompare(String(left.createdAt || left.runId)));
  return nextEntries;
}

function computeStatus(entries) {
  if (!entries.length) {
    return 'unknown';
  }
  if (entries.some(entry => entry.status === 'failed')) {
    return 'failed';
  }
  if (entries.some(entry => entry.status === 'flaky')) {
    return 'flaky';
  }
  if (entries.every(entry => entry.status === 'passed')) {
    return 'passed';
  }
  return 'unknown';
}

function buildRunGroups(entries) {
  const groups = [];
  const handled = new Set();

  for (const entry of entries) {
    if (handled.has(entry.runId)) {
      continue;
    }

    if (entry.parentRunId) {
      const children = entries.filter(candidate => candidate.parentRunId === entry.parentRunId);
      for (const child of children) {
        handled.add(child.runId);
      }
      const latestChild = children[0];
      const totals = children.reduce((acc, child) => {
        const childSummary = child.summary || {};
        acc.total += Number(childSummary.total || 0);
        acc.passed += Number(childSummary.passed || 0);
        acc.failed += Number(childSummary.failed || 0);
        acc.flaky += Number(childSummary.flaky || 0);
        acc.skipped += Number(childSummary.skipped || 0);
        acc.durationMs += Number(childSummary.durationMs || 0);
        return acc;
      }, {total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, durationMs: 0});

      groups.push({
        id: entry.parentRunId,
        type: 'group',
        title: entry.parentRunLabel || getLaneInfo('all-tests').title,
        description: getLaneInfo('all-tests').description,
        createdAt: latestChild?.createdAt || '',
        status: computeStatus(children),
        children,
        summary: totals,
      });
      continue;
    }

    handled.add(entry.runId);
    groups.push({
      id: entry.runId,
      type: 'single',
      title: entry.laneTitle,
      description: entry.laneDescription,
      createdAt: entry.createdAt,
      status: entry.status,
      children: [entry],
      summary: entry.summary || {total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, durationMs: 0},
    });
  }

  return groups;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildExplorerHtml(runGroups, entries) {
  const totalGroups = runGroups.length;
  const totalStoredRuns = entries.length;
  const latestGroup = runGroups[0] || null;
  const latestSummary = latestGroup?.summary || {total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, durationMs: 0};
  const successfulGroups = runGroups.filter(group => group.status === 'passed').length;
  const dashboardData = JSON.stringify({runGroups, entries});
  const faviconHref = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231263d6'/%3E%3Cpath d='M20 18h24a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4V22a4 4 0 0 1 4-4Z' fill='%23ffffff' opacity='.18'/%3E%3Cpath d='M24 22h16v6H24zm0 10h16v4H24zm0 8h10v4H24z' fill='%23ffffff'/%3E%3Ccircle cx='45' cy='41' r='7' fill='%232cc881'/%3E%3Cpath d='m42 41 2 2 4-5' fill='none' stroke='%230f1115' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Test Automation Dashboard</title>
  <link rel="icon" href="${faviconHref}" />
  <style>
    :root {
      --bg: #0f1115;
      --bg-accent: #111827;
      --panel: rgba(20, 25, 34, 0.88);
      --panel-strong: rgba(24, 31, 43, 0.98);
      --panel-soft: rgba(35, 44, 60, 0.6);
      --border: #283246;
      --text: #edf2ff;
      --muted: #9eadc5;
      --accent: #58b6ff;
      --accent-soft: rgba(88, 182, 255, 0.12);
      --passed: #2cc881;
      --failed: #ff6f7d;
      --flaky: #ffb74d;
      --skipped: #8f9db5;
      --shadow: 0 18px 50px rgba(0, 0, 0, 0.28);
      color-scheme: dark;
    }
    html[data-theme="light"] {
      --bg: #eef3fb;
      --bg-accent: #dde8f6;
      --panel: rgba(255, 255, 255, 0.96);
      --panel-strong: rgba(255, 255, 255, 1);
      --panel-soft: rgba(229, 238, 250, 0.9);
      --border: #c6d4e8;
      --text: #172132;
      --muted: #607089;
      --accent: #1263d6;
      --accent-soft: rgba(18, 99, 214, 0.1);
      --passed: #0d9d5a;
      --failed: #d64052;
      --flaky: #bf7b17;
      --skipped: #75839a;
      --shadow: 0 18px 40px rgba(50, 72, 102, 0.12);
      color-scheme: light;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", Helvetica, Arial, sans-serif;
      background:
        radial-gradient(circle at top right, rgba(88, 182, 255, 0.16), transparent 28%),
      radial-gradient(circle at bottom left, rgba(44, 200, 129, 0.12), transparent 24%),
      linear-gradient(180deg, var(--bg-accent), var(--bg));
      color: var(--text);
      min-height: 100vh;
      overflow-y: auto;
      overflow-x: hidden;
    }
    .layout { display: grid; grid-template-columns: 340px 1fr; min-height: 100vh; overflow: visible; }
    .sidebar {
      border-right: 1px solid var(--border);
      background: var(--panel);
      backdrop-filter: blur(20px);
      padding: 22px 18px;
      overflow-y: auto;
      min-height: 100vh;
      max-height: 100vh;
      position: sticky;
      top: 0;
      align-self: start;
    }
    .content {
      display: grid;
      grid-template-rows: auto auto 1fr;
      min-height: 100vh;
      height: auto;
      overflow: visible;
    }
    .topbar, .hero, .details {
      padding: 18px 24px;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      border-bottom: 1px solid var(--border);
      background: var(--panel);
      backdrop-filter: blur(18px);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .hero {
      border-bottom: 1px solid var(--border);
      background: linear-gradient(180deg, var(--panel), transparent);
    }
    .details { overflow: visible; min-height: 0; }
    h1, h2, h3, h4, p { margin: 0; }
    .eyebrow {
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 10px;
    }
    :root { --overview-columns: minmax(0, 1.15fr) minmax(460px, 1fr); }
    .hero-grid, .overview-metrics-grid, .summary-layout, .suite-grid { display: grid; gap: 14px; }
    .hero-grid { grid-template-columns: var(--overview-columns); align-items: start; }
    .overview-metrics-grid { grid-template-columns: var(--overview-columns); margin-top: 18px; align-items: stretch; }
    .metric-column { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .card {
      background: var(--panel-strong);
      border: 1px solid var(--border);
      border-radius: 18px;
      box-shadow: var(--shadow);
    }
    .metric-card { padding: 16px; }
    .metric-label { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); display: block; margin-bottom: 8px; }
    .metric-value { font-size: 26px; font-weight: 700; }
    .metric-sub { color: var(--muted); font-size: 12px; margin-top: 6px; display: block; }
    .summary-link, .run-link, .lane-button, .action-button, .secondary-button {
      cursor: pointer;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: var(--panel-strong);
      color: var(--text);
      transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
    }
    .summary-link:hover, .run-link:hover, .lane-button:hover,
    .summary-link.is-active, .run-link.is-active, .lane-button.is-active {
      transform: translateY(-1px);
      border-color: var(--accent);
      background: color-mix(in srgb, var(--panel-strong) 84%, var(--accent-soft));
    }
    .summary-link, .run-link { width: 100%; padding: 16px; text-align: left; margin-bottom: 12px; }
    .action-row { display: flex; gap: 10px; flex-wrap: wrap; }
    .sidebar-header-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 18px; margin-bottom: 10px; }
    .sidebar-link-button {
      border: 0;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 0;
    }
    .sidebar-link-button:hover:not([disabled]) {
      color: var(--accent);
      text-decoration: underline;
    }
    .sidebar-link-button[disabled] { opacity: 0.45; cursor: not-allowed; }
    .action-button, .secondary-button { padding: 10px 14px; font-weight: 600; }
    .action-button { background: linear-gradient(180deg, var(--accent), color-mix(in srgb, var(--accent) 80%, #000)); color: white; border-color: transparent; }
    .secondary-button[disabled], .action-button[disabled] { opacity: 0.45; cursor: not-allowed; transform: none; }
    .action-button:hover:not([disabled]) { filter: brightness(1.04); }
    .secondary-button:hover:not([disabled]) {
      transform: translateY(-1px);
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    .split-dropdown, .menu-dropdown { position: relative; display: inline-flex; }
    .split-main { border-top-right-radius: 0; border-bottom-right-radius: 0; }
    .split-toggle {
      border-top-left-radius: 0;
      border-bottom-left-radius: 0;
      padding: 10px 12px;
      min-width: 44px;
      background: linear-gradient(180deg, var(--accent), color-mix(in srgb, var(--accent) 80%, #000));
      color: white;
      border-color: transparent;
      border-left: 1px solid rgba(255, 255, 255, 0.22);
    }
    .split-main:hover:not([disabled]), .split-toggle:hover:not([disabled]) {
      transform: none;
    }
    .split-main:hover:not([disabled]) {
      filter: brightness(1.08) saturate(1.04);
      background: linear-gradient(180deg, var(--accent), color-mix(in srgb, var(--accent) 80%, #000));
      color: white;
      border-color: transparent;
      box-shadow: 0 8px 20px rgba(18, 99, 214, 0.24);
    }
    .split-toggle:hover:not([disabled]) {
      filter: brightness(1.08) saturate(1.04);
      background: linear-gradient(180deg, var(--accent), color-mix(in srgb, var(--accent) 80%, #000));
      color: white;
      border-color: transparent;
      border-left: 1px solid rgba(255, 255, 255, 0.34);
      box-shadow: 0 8px 20px rgba(18, 99, 214, 0.24);
    }
    .icon-button {
      width: 44px;
      height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      line-height: 1;
    }
    .dropdown-menu {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      min-width: 220px;
      padding: 8px;
      border-radius: 16px;
      background: var(--panel-strong);
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
      display: none;
      z-index: 20;
    }
    .dropdown-menu.is-open { display: block; }
    .menu-item {
      width: 100%;
      border: 0;
      background: transparent;
      color: var(--text);
      text-align: left;
      padding: 10px 12px;
      border-radius: 12px;
      cursor: pointer;
      font-size: 14px;
    }
    .menu-item:hover { background: var(--accent-soft); }
    .run-header { display: flex; justify-content: space-between; gap: 12px; align-items: start; margin-bottom: 8px; }
    .run-title { font-size: 18px; font-weight: 700; }
    .run-meta, .muted, .test-meta { color: var(--muted); font-size: 13px; line-height: 1.5; }
    .status-pill, .lane-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 76px;
      height: 32px;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      border: 1px solid currentColor;
    }
    .status-passed { color: var(--passed); }
    .status-failed { color: var(--failed); }
    .status-flaky { color: var(--flaky); }
    .status-skipped, .status-unknown { color: var(--skipped); }
    .suite-run-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin: 18px 0; }
    .lane-button { padding: 16px; text-align: left; }
    .lane-grid-title { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin-bottom: 8px; }
    .lane-toolbar { display: flex; justify-content: space-between; gap: 12px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
    .filter-row { display: flex; gap: 8px; flex-wrap: wrap; margin: 16px 0 12px; }
    .filter-chip {
      cursor: pointer;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 7px 12px;
      background: var(--panel-soft);
      color: var(--text);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .filter-chip:hover, .filter-chip.is-active {
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    .raw-report-link {
      color: var(--accent);
      text-decoration: none;
      font-weight: 700;
      white-space: nowrap;
    }
    .raw-report-link:hover { text-decoration: underline; }
    .progress-bar { margin-top: 12px; height: 10px; border-radius: 999px; overflow: hidden; background: var(--panel-soft); display: flex; }
    .progress-bar span { display: block; height: 100%; }
    .segment-passed { background: var(--passed); }
    .segment-failed { background: var(--failed); }
    .segment-flaky { background: var(--flaky); }
    .segment-skipped { background: var(--skipped); }
    .suite-card { padding: 16px; }
    .suite-grid { margin-top: 18px; }
    .suite-header { display: flex; justify-content: space-between; gap: 10px; align-items: start; margin-bottom: 12px; }
    .suite-title { font-size: 16px; font-weight: 700; }
    .suite-file { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .suite-stats { color: var(--muted); font-size: 12px; }
    .test-list { display: grid; gap: 10px; }
    .test-item { border: 1px solid var(--border); border-radius: 14px; background: var(--panel-soft); overflow: hidden; }
    .test-detail[open] { border-color: var(--accent); }
    .test-summary { list-style: none; cursor: pointer; padding: 12px; }
    .test-summary::-webkit-details-marker { display: none; }
    .test-detail-body { padding: 0 12px 12px; border-top: 1px solid var(--border); }
    .test-title-row { display: flex; justify-content: space-between; gap: 10px; align-items: start; }
    .test-title { font-weight: 600; }
    .test-description { margin-top: 6px; color: var(--muted); font-size: 13px; line-height: 1.45; }
    .test-error-block {
      margin-top: 12px;
      padding: 12px;
      border-radius: 12px;
      background: rgba(255, 111, 125, 0.08);
      border: 1px solid rgba(255, 111, 125, 0.22);
      color: var(--text);
      font-family: Consolas, Monaco, monospace;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      overflow-x: auto;
    }
    .artifact-list { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    .artifact-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      text-decoration: none;
      color: var(--text);
      background: var(--panel-strong);
      border: 1px solid var(--border);
      padding: 8px 10px;
      border-radius: 999px;
      font-size: 12px;
    }
    .artifact-link:hover { border-color: var(--accent); }
    .summary-panel { padding: 18px; }
    .empty { padding: 20px; color: var(--muted); }
    .toolbar-note { font-size: 12px; color: var(--muted); }
    .inline-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; align-items: center; }
    .summary-layout { grid-template-columns: var(--overview-columns); align-items: stretch; }
    .run-log { margin-top: 14px; height: 160px; min-height: 160px; max-height: 160px; overflow: auto; padding: 12px; border-radius: 14px; background: #0c1118; color: #dbe5f6; font-family: Consolas, monospace; font-size: 12px; white-space: pre-wrap; }
    .history-note { padding: 14px; border-radius: 14px; background: var(--panel-soft); color: var(--muted); margin-top: 10px; }
    .hero-stat-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 18px; }
    .hero-stat { padding: 14px; border-radius: 14px; border: 1px solid var(--border); background: var(--panel-soft); min-width: 0; }
    .hero-stat-label { display: block; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; }
    .hero-stat-value { font-size: 22px; font-weight: 700; }
    .overview-panel { display: flex; flex-direction: column; height: 100%; min-height: 100%; }
    .suite-stability-grid { display: grid; gap: 14px; height: 100%; }
    .suite-stability-note { color: var(--muted); font-size: 12px; line-height: 1.5; margin-bottom: 12px; }
    .suite-meta-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
    .suite-meta-stat { padding: 9px; border-radius: 12px; background: var(--panel-soft); border: 1px solid var(--border); min-width: 0; }
    .suite-meta-label { display: block; font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; white-space: nowrap; }
    .suite-meta-value { font-size: 14px; font-weight: 700; }
    .runner-panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
    }
    .active-run-card {
      width: 100%;
      padding: 14px 16px;
      border-radius: 16px;
      border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
      background: color-mix(in srgb, var(--accent-soft) 80%, var(--panel-strong));
      margin-bottom: 12px;
    }
    .active-run-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
    }
    .active-run-meta { color: var(--muted); font-size: 13px; }
    .recent-run-item {
      padding: 16px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background: var(--panel-soft);
      margin-bottom: 12px;
    }
    .history-chart {
      margin-top: 12px;
      padding: 12px;
      border-radius: 16px;
      background: var(--panel-soft);
      flex: 1;
    }
    .chart-canvas-wrap {
      position: relative;
      min-height: 300px;
      height: clamp(300px, 34vh, 420px);
    }
    @keyframes dashboard-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    html[data-theme="light"] .run-log { background: #152235; color: #eef5ff; }
    @media (max-width: 1600px) {
      .summary-layout { grid-template-columns: 1fr; }
      .overview-metrics-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 1420px) {
      .hero-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 1100px) {
      body { height: auto; overflow: auto; }
      .layout { grid-template-columns: 1fr; height: auto; overflow: visible; }
      .sidebar { border-right: 0; border-bottom: 1px solid var(--border); max-height: 38vh; position: static; min-height: 0; }
      .content { height: auto; overflow: visible; }
      .hero-grid, .summary-layout, .overview-metrics-grid { grid-template-columns: 1fr; }
      .metric-column { grid-template-columns: 1fr; }
      .hero-stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .runner-panel-header { align-items: flex-start; flex-direction: column; }
      .suite-meta-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 720px) {
      .hero-stat-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <div class="eyebrow">Dashboard</div>
      <button class="summary-link is-active" data-view="summary" data-group-id="summary">
        <div class="run-title">Overview</div>
        <div class="run-meta">Dashboard summary for all stored test runs, suite results, and trends.</div>
      </button>
      <div class="sidebar-header-row">
        <div class="eyebrow" style="margin:0;">Stored Test Runs</div>
        <button class="sidebar-link-button" id="clear-history">Clear History</button>
      </div>
      <div id="sidebar-runs"></div>
    </aside>
    <main class="content">
      <section class="topbar card" style="border-radius:0; box-shadow:none; border-left:0; border-right:0; border-top:0;">
        <div>
          <div class="eyebrow">Test Automation Dashboard</div>
          <h1 style="font-size:24px;">Test run history, suite results, and local actions</h1>
        </div>
        <div class="action-row">
          <div class="menu-dropdown" id="theme-menu-wrap">
            <button class="secondary-button icon-button" id="theme-toggle" title="Theme">☼</button>
            <div class="dropdown-menu" id="theme-menu">
              <button class="menu-item" data-theme-option="system">System Default</button>
              <button class="menu-item" data-theme-option="dark">Dark</button>
              <button class="menu-item" data-theme-option="light">Light</button>
            </div>
          </div>
        </div>
      </section>
      <section class="hero" id="hero-root"></section>
      <section class="details" id="details-root"></section>
    </main>
  </div>
  <script>
    window.__PLAYWRIGHT_DASHBOARD__ = ${dashboardData};
  </script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0/dist/chartjs-plugin-datalabels.min.js"></script>
  <script>
    (() => {
      const data = window.__PLAYWRIGHT_DASHBOARD__;
      const themeStorageKey = 'jira-hotlinker-playwright-theme';
      const friendlyStatusOrder = { failed: 0, flaky: 1, passed: 2, skipped: 3, unknown: 4 };
      const summaryLink = document.querySelector('[data-view="summary"]');
      const sidebar = document.getElementById('sidebar-runs');
      const heroRoot = document.getElementById('hero-root');
      const detailsRoot = document.getElementById('details-root');
      const themeToggle = document.getElementById('theme-toggle');
      const themeMenu = document.getElementById('theme-menu');
      const clearHistoryButton = document.getElementById('clear-history');
      const actionButtons = {
        all: null,
        mock: null,
        public: null,
        live: null,
        clear: document.getElementById('clear-history'),
      };
      let selectedGroupId = window.location.hash.replace(/^#/, '') || 'summary';
      let selectedLaneRunId = '';
      let selectedTestFilter = 'all';
      let apiState = null;
      let sawRunningState = false;
      let lastCompletedAt = '';
      const dashboardCharts = {
        passFailTrend: null,
      };

      function setTheme(theme) {
        if (theme === 'system') {
          localStorage.setItem(themeStorageKey, 'system');
          document.documentElement.setAttribute('data-theme', window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
          themeToggle.textContent = '◐';
          return;
        }
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem(themeStorageKey, theme);
        themeToggle.textContent = theme === 'light' ? '☀' : '☾';
      }

      setTheme(localStorage.getItem(themeStorageKey) || 'system');

      function statusClass(status) {
        return 'status-' + (status || 'unknown');
      }

      function formatTime(value) {
        if (!value) return 'Unknown time';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
      }

      function formatShortTime(value) {
        if (!value) return '--';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(date);
      }

      function cssVar(name) {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      }

      function destroyOverviewCharts() {
        Object.keys(dashboardCharts).forEach(key => {
          if (dashboardCharts[key]) {
            dashboardCharts[key].destroy();
            dashboardCharts[key] = null;
          }
        });
      }

      function formatDuration(durationMs) {
        const duration = Number(durationMs || 0);
        if (!duration) return '0s';
        if (duration >= 60000) return (duration / 60000).toFixed(1) + 'm';
        return (duration / 1000).toFixed(1) + 's';
      }

      function progressSegments(summary) {
        const total = Math.max(Number(summary.total || 0), 1);
        return [
          ['passed', summary.passed],
          ['failed', summary.failed],
          ['flaky', summary.flaky],
          ['skipped', summary.skipped],
        ].filter(([, value]) => Number(value || 0) > 0).map(([name, value]) => '<span class="segment-' + name + '" style="width:' + ((Number(value) / total) * 100).toFixed(2) + '%"></span>').join('');
      }

      function renderOverviewCharts() {
        destroyOverviewCharts();
        if (!window.Chart) {
          return;
        }
        const trendCanvas = document.getElementById('pass-fail-trend-chart');
        if (!trendCanvas) {
          return;
        }

        const trendRuns = data.runGroups.slice(0, 10).reverse();
        const labels = trendRuns.map(run => [run.title === 'Test Run' ? 'All Tests' : run.title, formatShortTime(run.createdAt)]);
        const totals = trendRuns.map(run => Math.max(Number(run.summary.total || 0), 1));

        dashboardCharts.passFailTrend = new window.Chart(trendCanvas, {
          type: 'bar',
          data: {
            labels,
            datasets: [
              {
                label: 'Passed',
                data: trendRuns.map(run => Number(run.summary.passed || 0)),
                backgroundColor: cssVar('--passed'),
                borderRadius: 8,
                stack: 'results',
              },
              {
                label: 'Failed',
                data: trendRuns.map(run => Number(run.summary.failed || 0)),
                backgroundColor: cssVar('--failed'),
                borderRadius: 8,
                stack: 'results',
              },
              {
                label: 'Skipped',
                data: trendRuns.map(run => Number(run.summary.skipped || 0)),
                backgroundColor: cssVar('--skipped'),
                borderRadius: 8,
                stack: 'results',
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {mode: 'index', intersect: false},
            plugins: {
              legend: {
                display: false,
                position: 'bottom',
                labels: {
                  color: cssVar('--muted'),
                  usePointStyle: true,
                  boxWidth: 10,
                },
              },
              tooltip: {
                callbacks: {
                  footer: items => {
                    const index = items[0]?.dataIndex ?? 0;
                    return 'Pass rate: ' + Math.round((Number(trendRuns[index].summary.passed || 0) / totals[index]) * 100) + '%';
                  },
                },
              },
              datalabels: {
                color: cssVar('--text'),
                anchor: 'end',
                align: 'top',
                offset: 4,
                font: {weight: '700'},
                formatter: (value, context) => {
                  if (context.datasetIndex !== 0) {
                    return '';
                  }
                  const index = context.dataIndex;
                  return String(trendRuns[index].summary.passed) + '/' + String(totals[index]);
                },
              },
            },
            scales: {
              x: {
                stacked: true,
                grid: {display: false},
                ticks: {
                  color: cssVar('--muted'),
                  font: {size: 11},
                },
              },
              y: {
                stacked: true,
                beginAtZero: true,
                ticks: {
                  color: cssVar('--muted'),
                  precision: 0,
                },
                grid: {
                  color: cssVar('--border'),
                },
              },
            },
          },
          plugins: window.ChartDataLabels ? [window.ChartDataLabels] : [],
        });
      }

      function renderSidebar() {
        summaryLink.classList.toggle('is-active', selectedGroupId === 'summary');
        const activeRunMarkup = apiState?.running
          ? '<div class="active-run-card">' +
              '<div class="active-run-title-row"><div class="run-title">Running Now</div><span class="status-pill status-flaky">Running</span></div>' +
              '<div class="run-meta">' + friendlyRunLabel(apiState.command || '') + '</div>' +
              '<div class="active-run-meta">Started ' + formatTime(apiState.startedAt) + '</div>' +
            '</div>'
          : '';

        sidebar.innerHTML = activeRunMarkup + data.runGroups.map(group => {
          const laneBadges = group.children.map(entry => '<span class="lane-pill ' + statusClass(entry.status) + '">' + entry.laneTitle + '</span>').join(' ');
          return '<button class="run-link' + (group.id === selectedGroupId ? ' is-active' : '') + '" data-group-id="' + group.id + '">' +
            '<div class="run-header"><div class="run-title">' + group.title + '</div><span class="status-pill ' + statusClass(group.status) + '">' + group.status + '</span></div>' +
            '<div class="run-meta">' + group.description + '</div>' +
            '<div class="run-meta" style="margin-top:8px;">' + formatTime(group.createdAt) + ' · ' + group.summary.total + ' test cases · ' + formatDuration(group.summary.durationMs) + '</div>' +
            (group.children.length > 1 ? '<div class="inline-actions" style="margin-top:10px;">' + laneBadges + '</div>' : '') +
            '</button>';
        }).join('');

        for (const button of sidebar.querySelectorAll('[data-group-id]')) {
          button.addEventListener('click', () => {
            selectedGroupId = button.dataset.groupId;
            selectedLaneRunId = '';
            selectedTestFilter = 'all';
            window.location.hash = selectedGroupId;
            renderSidebar();
            renderDetails();
          });
        }
      }

      function friendlyRunLabel(command) {
        if (!command) {
          return 'Test run in progress';
        }
        if (command.includes('test:e2e:all')) {
          return 'Running all tests';
        }
        if (command.includes('test:e2e:mock-edge')) {
          return 'Running mock failure coverage';
        }
        if (command.includes('test:e2e:public-smoke')) {
          return 'Running public Jira smoke';
        }
        if (command.includes('test:e2e:live-authenticated')) {
          return 'Running authenticated Jira Cloud';
        }
        return command;
      }

      function closeMenus() {
        themeMenu.classList.remove('is-open');
        const runMenu = document.getElementById('run-menu');
        if (runMenu) {
          runMenu.classList.remove('is-open');
        }
      }

      function runnerActionNodes() {
        return {
          runMenu: document.getElementById('run-menu'),
          runMenuToggle: document.getElementById('run-menu-toggle'),
          all: document.getElementById('run-all'),
          mock: document.getElementById('run-mock'),
          public: document.getElementById('run-public'),
          live: document.getElementById('run-live'),
        };
      }

      function runnerNodes() {
        return {
          noteNode: document.getElementById('runner-note'),
          logNode: document.getElementById('runner-log'),
        };
      }

      function updateActionLabels(isRunning, command) {
        const {all, mock, public: publicButton, live} = runnerActionNodes();
        if (all) {
          all.textContent = isRunning && command.includes('test:e2e:all') ? 'Running All Tests...' : 'Run All Tests';
        }
        if (mock) {
          mock.textContent = 'Run Mock Failure Coverage';
        }
        if (publicButton) {
          publicButton.textContent = 'Run Public Jira Smoke';
        }
        if (live) {
          live.textContent = 'Run Authenticated Jira Cloud';
        }
        if (clearHistoryButton) {
          clearHistoryButton.textContent = 'Clear History';
        }
      }

      function setRunnerActionDisabled(isRunning) {
        const {all, mock, public: publicButton, live, runMenuToggle} = runnerActionNodes();
        [all, mock, publicButton, live, runMenuToggle, clearHistoryButton].forEach(button => {
          if (button) {
            button.disabled = isRunning;
          }
        });
      }

      function bindRunnerActions() {
        const {runMenu, runMenuToggle, all, mock, public: publicButton, live} = runnerActionNodes();
        if (!all || all.dataset.bound === 'true') {
          return;
        }

        if (runMenuToggle) {
          runMenuToggle.addEventListener('click', event => {
            event.stopPropagation();
            themeMenu.classList.remove('is-open');
            if (runMenu) {
              runMenu.classList.toggle('is-open');
            }
          });
        }

        all.addEventListener('click', async () => { sawRunningState = true; showRunStarting('npm run test:e2e:all'); await callApi('/api/run', {target: 'all'}); await refreshApiState(); });
        mock?.addEventListener('click', async () => { sawRunningState = true; showRunStarting('npm run test:e2e:mock-edge'); await callApi('/api/run', {target: 'mock-edge'}); await refreshApiState(); });
        publicButton?.addEventListener('click', async () => { sawRunningState = true; showRunStarting('npm run test:e2e:public-smoke'); await callApi('/api/run', {target: 'public-smoke'}); await refreshApiState(); });
        live?.addEventListener('click', async () => { sawRunningState = true; showRunStarting('npm run test:e2e:live-authenticated'); await callApi('/api/run', {target: 'live-authenticated'}); await refreshApiState(); });

        all.dataset.bound = 'true';
      }

      themeToggle.addEventListener('click', event => {
        event.stopPropagation();
        const {runMenu} = runnerActionNodes();
        if (runMenu) {
          runMenu.classList.remove('is-open');
        }
        themeMenu.classList.toggle('is-open');
      });

      for (const button of document.querySelectorAll('[data-theme-option]')) {
        button.addEventListener('click', () => {
          setTheme(button.dataset.themeOption || 'system');
          closeMenus();
        });
      }

      document.addEventListener('click', () => closeMenus());

      function renderOverviewHero() {
        const latestGroup = data.runGroups[0] || null;
        const latestSummary = latestGroup?.summary || {total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, durationMs: 0};
        const suiteCount = latestGroup?.children?.length || 0;
        return '<div class="hero-grid">' +
          '<div class="card summary-panel">' +
            '<div class="eyebrow">Latest Test Run</div>' +
            '<h2 style="font-size:28px; margin-bottom:10px;">' + (latestGroup ? latestGroup.title : 'No runs yet') + '</h2>' +
            '<p class="muted">' + (latestGroup ? latestGroup.description : 'Run a suite to populate the dashboard.') + '</p>' +
            '<div class="inline-actions">' +
              '<span class="status-pill ' + statusClass(latestGroup ? latestGroup.status : 'unknown') + '">' + (latestGroup ? latestGroup.status : 'unknown') + '</span>' +
              '<span class="muted">' + (latestGroup ? formatTime(latestGroup.createdAt) : '') + '</span>' +
            '</div>' +
            '<div class="progress-bar">' + progressSegments(latestSummary) + '</div>' +
            '<div class="hero-stat-grid">' +
              '<div class="hero-stat"><span class="hero-stat-label">Test Cases</span><span class="hero-stat-value">' + latestSummary.total + '</span></div>' +
              '<div class="hero-stat"><span class="hero-stat-label">Passing</span><span class="hero-stat-value">' + latestSummary.passed + '</span></div>' +
              '<div class="hero-stat"><span class="hero-stat-label">Failed</span><span class="hero-stat-value">' + latestSummary.failed + '</span></div>' +
              '<div class="hero-stat"><span class="hero-stat-label">Included Suites</span><span class="hero-stat-value">' + suiteCount + '</span></div>' +
            '</div>' +
          '</div>' +
          '<div class="card summary-panel">' +
            '<div class="runner-panel-header">' +
              '<div class="eyebrow" style="margin:0;">Runner State</div>' +
              '<div class="split-dropdown" id="run-menu-wrap">' +
                '<button class="action-button split-main" id="run-all">Run All Tests</button>' +
                '<button class="secondary-button split-toggle" id="run-menu-toggle" title="More run actions">▾</button>' +
                '<div class="dropdown-menu" id="run-menu">' +
                  '<button class="menu-item" id="run-mock">Run Mock Failure Coverage</button>' +
                  '<button class="menu-item" id="run-public">Run Public Jira Smoke</button>' +
                  '<button class="menu-item" id="run-live">Run Authenticated Jira Cloud</button>' +
                '</div>' +
            '</div>' +
            '</div>' +
            '<p class="toolbar-note" id="runner-note">Ready to start a test run or clear stored history.</p>' +
            '<div class="run-log" id="runner-log">No active test run.</div>' +
          '</div>' +
        '</div>' +
        '<div class="overview-metrics-grid">' +
          '<div class="metric-column">' +
            '<div class="card metric-card"><span class="metric-label">Test Runs</span><span class="metric-value">${totalGroups}</span><span class="metric-sub">Stored test run history entries</span></div>' +
            '<div class="card metric-card"><span class="metric-label">Suite Runs</span><span class="metric-value">${totalStoredRuns}</span><span class="metric-sub">Stored per-suite execution results</span></div>' +
          '</div>' +
          '<div class="metric-column">' +
            '<div class="card metric-card"><span class="metric-label">Passing Test Runs</span><span class="metric-value">${successfulGroups}</span><span class="metric-sub">Test runs with every suite passing</span></div>' +
            '<div class="card metric-card"><span class="metric-label">Latest Test Cases</span><span class="metric-value">' + latestSummary.total + '</span><span class="metric-sub">' + latestSummary.passed + ' passed / ' + latestSummary.failed + ' failed / ' + latestSummary.skipped + ' skipped</span></div>' +
          '</div>' +
        '</div>';
      }

      function renderOverviewDetails() {
        const recentRuns = data.runGroups.slice(0, 12);
        const suiteHealth = Object.values(data.entries.reduce((acc, entry) => {
          const key = entry.laneTitle;
          if (!acc[key]) {
            acc[key] = {
              title: entry.laneTitle,
              description: entry.laneDescription,
              total: 0,
              passed: 0,
              failed: 0,
              durationMs: 0,
              testCases: 0,
              failedCases: 0,
              passedCases: 0,
              skippedCases: 0,
            };
          }
          acc[key].total += 1;
          acc[key].durationMs += Number(entry.summary?.durationMs || 0);
          acc[key].testCases += Number(entry.summary?.total || 0);
          acc[key].failedCases += Number(entry.summary?.failed || 0);
          acc[key].passedCases += Number(entry.summary?.passed || 0);
          acc[key].skippedCases += Number(entry.summary?.skipped || 0);
          if (entry.status === 'passed') {
            acc[key].passed += 1;
          } else if (entry.status === 'failed') {
            acc[key].failed += 1;
          }
          return acc;
        }, {}));
        const averagePassRate = recentRuns.length
          ? Math.round(recentRuns.reduce((total, run) => total + (Number(run.summary.passed || 0) / Math.max(Number(run.summary.total || 0), 1)), 0) / recentRuns.length * 100)
          : 0;
        const latestFailures = recentRuns[0] ? Number(recentRuns[0].summary.failed || 0) : 0;
        const averageDurationMs = recentRuns.length
          ? recentRuns.reduce((total, run) => total + Number(run.summary.durationMs || 0), 0) / recentRuns.length
          : 0;

        return '<div class="summary-layout">' +
          '<div class="card summary-panel overview-panel">' +
            '<div class="eyebrow">Pass / Fail Trend</div>' +
            '<div class="history-chart"><div class="chart-canvas-wrap"><canvas id="pass-fail-trend-chart"></canvas></div></div>' +
            '<div class="hero-stat-grid" style="margin-top:16px;">' +
              '<div class="hero-stat"><span class="hero-stat-label">Stored Runs</span><span class="hero-stat-value">' + recentRuns.length + '</span><span class="metric-sub">Visible in the trend chart</span></div>' +
              '<div class="hero-stat"><span class="hero-stat-label">Average Pass Rate</span><span class="hero-stat-value">' + averagePassRate + '%</span><span class="metric-sub">Across recent test runs</span></div>' +
              '<div class="hero-stat"><span class="hero-stat-label">Latest Failures</span><span class="hero-stat-value">' + latestFailures + '</span><span class="metric-sub">From the newest test run</span></div>' +
              '<div class="hero-stat"><span class="hero-stat-label">Average Duration</span><span class="hero-stat-value">' + formatDuration(averageDurationMs) + '</span><span class="metric-sub">Across recent test runs</span></div>' +
            '</div>' +
          '</div>' +
          '<div class="card summary-panel overview-panel">' +
            '<div class="eyebrow">Suite Stability</div>' +
            '<div class="suite-stability-note">Aggregated across all stored suite runs in the dashboard history.</div>' +
            '<div class="suite-stability-grid">' + suiteHealth.map(suite => {
              const passRate = suite.total ? Math.round((suite.passed / suite.total) * 100) : 0;
              return '<div class="card suite-card">' +
                '<div class="suite-header"><div><div class="suite-title">' + suite.title + '</div><div class="suite-file">' + suite.description + '</div></div><div class="suite-stats">' + passRate + '% pass rate</div></div>' +
                '<div class="progress-bar"><span class="segment-passed" style="width:' + passRate + '%"></span><span class="segment-failed" style="width:' + (100 - passRate) + '%"></span></div>' +
                '<div class="suite-meta-grid">' +
                  '<div class="suite-meta-stat"><span class="suite-meta-label">Suite Runs</span><span class="suite-meta-value">' + suite.total + '</span></div>' +
                  '<div class="suite-meta-stat"><span class="suite-meta-label">Test Cases</span><span class="suite-meta-value">' + suite.testCases + '</span></div>' +
                  '<div class="suite-meta-stat"><span class="suite-meta-label">Failed Cases</span><span class="suite-meta-value">' + suite.failedCases + '</span></div>' +
                  '<div class="suite-meta-stat"><span class="suite-meta-label">Avg Duration</span><span class="suite-meta-value">' + formatDuration(suite.total ? suite.durationMs / suite.total : 0) + '</span></div>' +
                '</div>' +
              '</div>';
            }).join('') + '</div>' +
          '</div>' +
        '</div>';
      }

      function renderRunHero(group) {
        return '<div class="card summary-panel">' +
          '<div class="eyebrow">Selected Test Run</div>' +
          '<div class="run-header"><div><h2 style="font-size:30px; margin-bottom:8px;">' + group.title + '</h2><p class="muted">' + group.description + '</p></div><span class="status-pill ' + statusClass(group.status) + '">' + group.status + '</span></div>' +
          '<div class="inline-actions"><span class="muted">' + formatTime(group.createdAt) + '</span><span class="muted">' + group.summary.total + ' test cases</span><span class="muted">' + formatDuration(group.summary.durationMs) + '</span></div>' +
          '<div class="progress-bar">' + progressSegments(group.summary) + '</div>' +
        '</div>';
      }

      function renderLaneSection(entry) {
        const suites = [...(entry.suites || [])].sort((left, right) => {
          return (friendlyStatusOrder[left.failed ? 'failed' : left.flaky ? 'flaky' : left.skipped === left.total ? 'skipped' : 'passed'] || 10) - (friendlyStatusOrder[right.failed ? 'failed' : right.flaky ? 'flaky' : right.skipped === right.total ? 'skipped' : 'passed'] || 10);
        });
        const availableFilters = [
          {key: 'all', label: 'All', count: Number(entry.summary.total || 0)},
          {key: 'failed', label: 'Failed', count: Number(entry.summary.failed || 0)},
          {key: 'passed', label: 'Passed', count: Number(entry.summary.passed || 0)},
          {key: 'flaky', label: 'Flaky', count: Number(entry.summary.flaky || 0)},
          {key: 'skipped', label: 'Skipped', count: Number(entry.summary.skipped || 0)},
        ];
        const activeFilter = selectedTestFilter || 'all';
        const filteredSuites = suites
          .map(suite => ({
            ...suite,
            tests: suite.tests.filter(test => activeFilter === 'all' || test.status === activeFilter),
          }))
          .filter(suite => suite.tests.length > 0);

        function renderTestDetail(test) {
          const hasErrors = Array.isArray(test.errors) && test.errors.length > 0;
          const hasAttachments = Array.isArray(test.attachments) && test.attachments.length > 0;
          const isOpen = test.status === 'failed' || test.status === 'flaky';
          return '<details class="test-item test-detail"' + (isOpen ? ' open' : '') + '>' +
            '<summary class="test-summary">' +
              '<div class="test-title-row"><div><div class="test-title">' + test.title + '</div><div class="test-meta">' + test.file + ':' + test.line + ' · ' + formatDuration(test.durationMs) + (test.startTime ? ' · ' + formatTime(test.startTime) : '') + '</div></div><span class="status-pill ' + statusClass(test.status) + '">' + test.status + '</span></div>' +
              '<div class="test-description">' + test.description + '</div>' +
            '</summary>' +
            '<div class="test-detail-body">' +
              '<div class="test-meta">Suite run: ' + (test.projectName || entry.laneTitle) + (test.retry ? ' · Retry #' + test.retry : '') + '</div>' +
              (hasErrors ? test.errors.map(error => '<div class="test-error-block">' + error + '</div>').join('') : '<div class="test-description">No additional error output was recorded for this test.</div>') +
              (hasAttachments ? '<div class="artifact-list">' + test.attachments.map(attachment => '<a class="artifact-link" href="' + attachment.path + '" target="_blank" rel="noreferrer">' + attachment.name + '</a>').join('') + '</div>' : '') +
            '</div>' +
          '</details>';
        }

        return '<div class="card summary-panel">' +
          '<div class="eyebrow">Selected Test Suite</div>' +
          '<h2 style="font-size:24px; margin-bottom:8px;">' + entry.laneTitle + '</h2>' +
          '<p class="muted">' + entry.laneDescription + '</p>' +
          '<div class="lane-toolbar">' +
            '<div class="inline-actions">' +
              '<button class="filter-chip ' + statusClass(entry.status) + '" data-test-filter="' + (['passed', 'failed', 'flaky', 'skipped'].includes(entry.status) ? entry.status : 'all') + '">' + entry.status + '</button>' +
              '<span class="muted">' + formatTime(entry.createdAt) + '</span>' +
              '<span class="muted">' + entry.summary.total + ' test cases · ' + formatDuration(entry.summary.durationMs) + '</span>' +
            '</div>' +
            '<a class="raw-report-link" href="' + entry.runReportPath + '" target="_blank" rel="noreferrer">Open raw report</a>' +
          '</div>' +
          '<div class="filter-row">' + availableFilters.map(filter =>
            '<button class="filter-chip' + (activeFilter === filter.key ? ' is-active' : '') + '" data-test-filter="' + filter.key + '">' + filter.label + ' ' + filter.count + '</button>'
          ).join('') +
          '</div>' +
          '<div class="progress-bar">' + progressSegments(entry.summary) + '</div>' +
          (filteredSuites.length ? '<div class="suite-grid">' + filteredSuites.map(suite =>
            '<div class="card suite-card">' +
              '<div class="suite-header"><div><div class="suite-title">' + suite.title + '</div><div class="suite-file">' + suite.rawTitle + '</div></div><div class="suite-stats">' + suite.total + ' test cases · ' + formatDuration(suite.durationMs) + '</div></div>' +
              '<div class="progress-bar">' + progressSegments(suite) + '</div>' +
              '<div class="test-list" style="margin-top:12px;">' + suite.tests.map(renderTestDetail).join('') + '</div>' +
            '</div>'
          ).join('') + '</div>' : '<div class="card empty" style="margin-top:16px;">No test cases match the current filter.</div>') +
        '</div>';
      }

      function renderGroup(group) {
        const children = [...group.children].sort((left, right) => left.laneTitle.localeCompare(right.laneTitle));
        if (!selectedLaneRunId || !children.some(entry => entry.runId === selectedLaneRunId)) {
          selectedLaneRunId = children[0] ? children[0].runId : '';
        }
        const selectedEntry = children.find(entry => entry.runId === selectedLaneRunId) || children[0];

        return '<div class="card summary-panel">' +
          '<div class="eyebrow">Included Test Suites</div>' +
          '<div class="suite-run-grid">' + children.map(entry =>
            '<button class="lane-button' + (entry.runId === selectedLaneRunId ? ' is-active' : '') + '" data-lane-run-id="' + entry.runId + '">' +
              '<div class="lane-grid-title"><div class="run-title" style="font-size:18px;">' + entry.laneTitle + '</div><span class="status-pill ' + statusClass(entry.status) + '">' + entry.status + '</span></div>' +
              '<div class="muted">' + entry.laneDescription + '</div>' +
              '<div class="muted" style="margin-top:8px;">' + entry.summary.total + ' test cases · ' + formatDuration(entry.summary.durationMs) + '</div>' +
              '<div class="progress-bar">' + progressSegments(entry.summary) + '</div>' +
            '</button>'
          ).join('') + '</div>' +
        '</div>' + (selectedEntry ? '<div style="margin-top:18px;">' + renderLaneSection(selectedEntry) + '</div>' : '<div class="card empty">No suite data available.</div>');
      }

      function renderDetails() {
        if (selectedGroupId === 'summary') {
          heroRoot.innerHTML = renderOverviewHero();
          detailsRoot.innerHTML = renderOverviewDetails();
          bindRunnerActions();
          renderOverviewCharts();
          return;
        }
        destroyOverviewCharts();
        const group = data.runGroups.find(candidate => candidate.id === selectedGroupId) || data.runGroups[0];
        if (!group) {
          heroRoot.innerHTML = '';
          detailsRoot.innerHTML = '<div class="card empty">No report runs available yet.</div>';
          return;
        }
        heroRoot.innerHTML = renderRunHero(group);
        detailsRoot.innerHTML = renderGroup(group);
        for (const button of detailsRoot.querySelectorAll('[data-lane-run-id]')) {
          button.addEventListener('click', () => {
            selectedLaneRunId = button.dataset.laneRunId;
            selectedTestFilter = 'all';
            renderDetails();
          });
        }
        for (const button of detailsRoot.querySelectorAll('[data-test-filter]')) {
          button.addEventListener('click', () => {
            selectedTestFilter = button.dataset.testFilter || 'all';
            renderDetails();
          });
        }
      }

      async function callApi(path, body) {
        const response = await fetch(path, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify(body || {}),
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        return response.json();
      }

      function showRunStarting(targetLabel) {
        apiState = {
          running: true,
          command: targetLabel,
          startedAt: new Date().toISOString(),
          finishedAt: '',
          log: 'Waiting for runner output...',
        };
        const {noteNode, logNode} = runnerNodes();
        if (noteNode) {
          noteNode.textContent = 'Starting test run...';
        }
        if (logNode) {
          logNode.textContent = 'Waiting for runner output...';
        }
        updateActionLabels(true, targetLabel);
        setRunnerActionDisabled(true);
        renderSidebar();
        if (selectedGroupId === 'summary') {
          renderDetails();
        }
      }

      async function refreshApiState() {
        if (!location.protocol.startsWith('http')) {
          const {noteNode, logNode} = runnerNodes();
          if (noteNode) {
            noteNode.textContent = 'Open this dashboard through npm run test:e2e:show-report to enable local test actions.';
          }
          if (logNode) {
            logNode.textContent = 'No active test run.';
          }
          updateActionLabels(false, '');
          setRunnerActionDisabled(true);
          return;
        }

        try {
          const response = await fetch('/api/state', {cache: 'no-store'});
          if (!response.ok) {
            throw new Error('Dashboard actions unavailable');
          }
          apiState = await response.json();
          const isRunning = !!apiState.running;
          if (sawRunningState && !isRunning && apiState.finishedAt && apiState.finishedAt !== lastCompletedAt) {
            lastCompletedAt = apiState.finishedAt;
            window.location.reload();
            return;
          }
          sawRunningState = isRunning;
          const {noteNode, logNode} = runnerNodes();
          if (noteNode) {
            noteNode.textContent = isRunning
              ? 'A test run is currently in progress. The dashboard refreshes runner state automatically.'
              : 'Ready to start a test run or clear stored history.';
          }
          if (logNode) {
            logNode.textContent = apiState.log || 'No active test run.';
          }
          updateActionLabels(isRunning, apiState.command || '');
          setRunnerActionDisabled(isRunning);
          renderSidebar();
        } catch (error) {
          const {noteNode, logNode} = runnerNodes();
          if (noteNode) {
            noteNode.textContent = 'Dashboard actions are unavailable right now. You can still browse the saved history.';
          }
          if (logNode) {
            logNode.textContent = String(error.message || error);
          }
          updateActionLabels(false, '');
          setRunnerActionDisabled(true);
        }
      }

      clearHistoryButton.addEventListener('click', async () => {
        if (!window.confirm('Clear all saved Playwright history, reports, and artifacts?')) {
          return;
        }
        await callApi('/api/reset', {confirm: true});
        window.location.assign('/');
      });

      summaryLink.addEventListener('click', () => {
        selectedGroupId = 'summary';
        selectedLaneRunId = '';
        selectedTestFilter = 'all';
        window.location.hash = 'summary';
        renderSidebar();
        renderDetails();
      });

      renderSidebar();
      renderDetails();
      refreshApiState();
      setInterval(refreshApiState, 4000);
    })();
  </script>
</body>
</html>`;
}

const latestRunId = getArgValue('run-id');
const latestStatus = getArgValue('status');
const latestParentRunId = getArgValue('parent-run-id');
const latestParentRunLabel = getArgValue('parent-run-label');

if (!fs.existsSync(blobDir)) {
  fs.mkdirSync(outputRoot, {recursive: true});
  saveRunMetadata([]);
  fs.writeFileSync(explorerPath, buildExplorerHtml([], []));
  console.log(`Playwright dashboard: ${explorerPath}`);
  process.exit(0);
}

const blobFiles = fs.readdirSync(blobDir).filter(fileName => fileName.endsWith('.zip')).sort();
if (!blobFiles.length) {
  fs.mkdirSync(outputRoot, {recursive: true});
  saveRunMetadata([]);
  fs.writeFileSync(explorerPath, buildExplorerHtml([], []));
  console.log(`Playwright dashboard: ${explorerPath}`);
  process.exit(0);
}

fs.mkdirSync(outputRoot, {recursive: true});
fs.mkdirSync(runsDir, {recursive: true});

const mergedResult = mergeBlobDirectory(blobDir, mergedReportDir, 'html');
if (mergedResult.status !== 0) {
  process.exit(mergedResult.status || 1);
}

const runEntries = syncRunEntries(blobFiles, latestRunId, latestStatus, latestParentRunId, latestParentRunLabel);
for (const entry of runEntries) {
  const result = ensureRunArtifacts(entry, latestRunId);
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

saveRunMetadata(runEntries);
const runGroups = buildRunGroups(runEntries);
fs.writeFileSync(explorerPath, buildExplorerHtml(runGroups, runEntries));

console.log(`Playwright dashboard: ${explorerPath}`);
console.log(`Merged Playwright report: ${path.join(mergedReportDir, 'index.html')}`);
if (latestRunId) {
  console.log(`Latest run report: ${path.join(runsDir, latestRunId, 'index.html')}`);
}
