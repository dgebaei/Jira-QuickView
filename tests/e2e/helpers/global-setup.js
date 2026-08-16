const fs = require('fs');
const path = require('path');
const {execSync} = require('child_process');

module.exports = async () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const outputDir = path.join(repoRoot, 'tests/output/playwright');
  fs.mkdirSync(outputDir, {recursive: true});
  if (process.env.JQV_SKIP_EXTENSION_BUILD === '1') {
    return;
  }
  execSync('npm run build', {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  execSync('npm run build:deep-modules', {
    cwd: repoRoot,
    stdio: 'inherit',
  });
};
