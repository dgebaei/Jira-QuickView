const fs = require('fs');
const path = require('path');

function main() {
  const [requestedScript, ...scriptArgs] = process.argv.slice(2);
  if (!requestedScript) {
    console.error('Usage: node scripts/run-platform-script.js <script-path> [args...]');
    process.exit(1);
  }

  const repoRoot = path.resolve(__dirname, '..');
  const originalPath = path.resolve(repoRoot, requestedScript);
  const extension = path.extname(originalPath);
  const windowsPath = extension
    ? `${originalPath.slice(0, -extension.length)}.windows${extension}`
    : `${originalPath}.windows.js`;
  const selectedPath = process.platform === 'win32' && fs.existsSync(windowsPath)
    ? windowsPath
    : originalPath;

  process.argv = [process.argv[0], selectedPath, ...scriptArgs];
  require(selectedPath);
}

main();
