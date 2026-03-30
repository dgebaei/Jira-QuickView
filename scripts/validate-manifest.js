const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.join(repoRoot, 'package.json');
const manifestPath = path.join(repoRoot, 'jira-plugin', 'manifest.json');
const optionsPath = path.join(repoRoot, 'jira-plugin', 'options', 'options.jsx');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function fail(message) {
  throw new Error(message);
}

function readOptionsExportVersion() {
  const source = fs.readFileSync(optionsPath, 'utf8');
  const match = source.match(/\bversion:\s*['"]([^'"]+)['"]/);
  return match ? match[1] : '';
}

function validateManifestVersion(manifestVersion) {
  if (!/^\d+(?:\.\d+)*$/.test(String(manifestVersion || '').trim())) {
    fail(`jira-plugin/manifest.json version must contain only digits and dots. Received: ${JSON.stringify(manifestVersion)}`);
  }
}

function main() {
  const packageJson = readJson(packageJsonPath);
  const manifest = readJson(manifestPath);
  const optionsExportVersion = readOptionsExportVersion();
  const displayVersion = String(manifest.version_name || manifest.version || '').trim();

  validateManifestVersion(manifest.version);

  if (!displayVersion) {
    fail('jira-plugin/manifest.json must define version or version_name.');
  }

  if (String(packageJson.version || '').trim() !== displayVersion) {
    fail(`package.json version (${packageJson.version}) must match the extension display version (${displayVersion}).`);
  }

  if (optionsExportVersion && optionsExportVersion !== displayVersion) {
    fail(`jira-plugin/options/options.jsx export version (${optionsExportVersion}) must match the extension display version (${displayVersion}).`);
  }

  console.log('Manifest validation passed.');
  console.log(`Manifest version: ${manifest.version}`);
  console.log(`Display version: ${displayVersion}`);
}

try {
  main();
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}
