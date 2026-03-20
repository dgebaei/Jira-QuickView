require('./load-env-defaults');

const {spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');
const blobDir = path.join(repoRoot, 'tests/output/playwright/blob-report');
const mergeScript = path.join(repoRoot, 'scripts/playwright/merge-reports.js');
const args = process.argv.slice(2);

function detectLabel(cliArgs) {
  const projectArg = cliArgs.find(arg => arg.startsWith('--project='));
  if (projectArg) {
    return projectArg.split('=')[1];
  }
  const projectIndex = cliArgs.indexOf('--project');
  if (projectIndex >= 0 && cliArgs[projectIndex + 1]) {
    return cliArgs[projectIndex + 1];
  }
  return 'all-projects';
}

function deriveProjectEnv(label, currentEnv) {
  const env = {...currentEnv};

  if (label === 'mock-edge') {
    env.MOCK = env.MOCK || 'true';
  }

  if (label === 'public-smoke') {
    env.RUN_PUBLIC_JIRA_TESTS = env.RUN_PUBLIC_JIRA_TESTS || '1';
    env.MOCK = env.MOCK || 'true';
  }

  if (label === 'live-authenticated') {
    env.MOCK = env.MOCK || 'false';
  }

  return env;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

fs.mkdirSync(blobDir, {recursive: true});

const label = detectLabel(args).replace(/[^a-zA-Z0-9_-]+/g, '-');
const runId = `${label}-${timestamp()}`;
const outputName = `${runId}.zip`;
const projectEnv = deriveProjectEnv(label, process.env);
const parentRunId = String(process.env.PLAYWRIGHT_PARENT_RUN_ID || '').trim();
const parentRunLabel = String(process.env.PLAYWRIGHT_PARENT_RUN_LABEL || '').trim();
const env = {
  ...projectEnv,
  PLAYWRIGHT_BLOB_OUTPUT_DIR: blobDir,
  PLAYWRIGHT_BLOB_OUTPUT_NAME: outputName,
  PLAYWRIGHT_OUTPUT_DIR: path.join('tests/output/playwright/test-results', runId),
  PWTEST_BLOB_DO_NOT_REMOVE: '1',
};

const testResult = spawnSync('npm', ['exec', '--', 'playwright', 'test', ...args], {
  cwd: repoRoot,
  env,
  stdio: 'inherit',
});

const reportStatus = testResult.status === 0 ? 'passed' : 'failed';
const mergeArgs = [mergeScript, `--run-id=${runId}`, `--status=${reportStatus}`];
if (parentRunId) {
  mergeArgs.push(`--parent-run-id=${parentRunId}`);
}
if (parentRunLabel) {
  mergeArgs.push(`--parent-run-label=${parentRunLabel}`);
}

const mergeResult = spawnSync(process.execPath, mergeArgs, {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit',
});

if (testResult.status !== 0) {
  process.exit(testResult.status || 1);
}

if (mergeResult.status !== 0) {
  process.exit(mergeResult.status || 1);
}
