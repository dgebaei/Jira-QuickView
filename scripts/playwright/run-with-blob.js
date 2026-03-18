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

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

fs.mkdirSync(blobDir, {recursive: true});

const label = detectLabel(args).replace(/[^a-zA-Z0-9_-]+/g, '-');
const runId = `${label}-${timestamp()}`;
const outputName = `${runId}.zip`;
const env = {
  ...process.env,
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

const mergeResult = spawnSync(process.execPath, [mergeScript], {
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
