const {spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');
const target = path.join(repoRoot, 'tests/output/playwright');
const mergeScript = path.join(repoRoot, 'scripts/playwright/merge-reports.js');

fs.rmSync(target, {recursive: true, force: true});

const result = spawnSync(process.execPath, [mergeScript], {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit',
});

if (result.status !== 0) {
  process.exit(result.status || 1);
}

console.log('Cleared Playwright report data.');
