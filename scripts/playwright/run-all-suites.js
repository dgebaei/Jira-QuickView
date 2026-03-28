require('./load-env-defaults');

const {spawnSync} = require('child_process');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');
const runWithBlobScript = path.join(repoRoot, 'scripts/playwright/run-with-blob.js');

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

const parentRunId = `all-tests-${timestamp()}`;
const parentRunLabel = 'Test Run';

const suites = [
  {label: 'mock-edge', args: ['--project=mock-edge', '--project=mock-popup']},
  {label: 'public-smoke', args: ['--project=public-smoke']},
  {label: 'live-authenticated', args: ['--project=live-authenticated']},
];

for (const suite of suites) {
  const result = spawnSync(process.execPath, [runWithBlobScript, ...suite.args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PLAYWRIGHT_PARENT_RUN_ID: parentRunId,
      PLAYWRIGHT_PARENT_RUN_LABEL: parentRunLabel,
    },
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
