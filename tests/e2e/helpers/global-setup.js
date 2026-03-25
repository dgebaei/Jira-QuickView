const fs = require('fs');
const path = require('path');
const {execSync} = require('child_process');

module.exports = async () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const outputDir = path.join(repoRoot, 'tests/output/playwright');
  fs.mkdirSync(outputDir, {recursive: true});
  execSync('npm run build', {
    cwd: repoRoot,
    stdio: 'inherit',
  });
};
