const {spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');
const blobDir = path.join(repoRoot, 'tests/output/playwright/blob-report');
const reportDir = path.join(repoRoot, 'tests/output/playwright/report');

if (!fs.existsSync(blobDir)) {
  process.exit(0);
}

const blobFiles = fs.readdirSync(blobDir).filter(fileName => fileName.endsWith('.zip'));
if (!blobFiles.length) {
  process.exit(0);
}

const env = {
  ...process.env,
  PLAYWRIGHT_HTML_OUTPUT_DIR: reportDir,
  PLAYWRIGHT_HTML_OPEN: 'never',
};

const result = spawnSync('npm', ['exec', '--', 'playwright', 'merge-reports', '--reporter', 'html', blobDir], {
  cwd: repoRoot,
  env,
  stdio: 'inherit',
});

process.exit(result.status || 0);
