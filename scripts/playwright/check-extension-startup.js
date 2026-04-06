require('./load-env-defaults');

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {chromium} = require('playwright');

const repoRoot = path.resolve(__dirname, '../..');
const extensionPath = path.join(repoRoot, 'jira-plugin');
const webpackConfigPath = path.join(repoRoot, 'webpack.config.js');
const requiredBundlePaths = [
  path.join(extensionPath, 'build', 'background.js'),
  path.join(extensionPath, 'build', 'main.js'),
  path.join(extensionPath, 'options', 'build', 'options.js'),
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    stdio: 'inherit',
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

async function ensureExtensionBundle() {
  const bundleExists = await Promise.all(requiredBundlePaths.map(filePath => fs.access(filePath).then(() => true).catch(() => false)));
  if (bundleExists.every(Boolean)) {
    return;
  }

  console.log('Extension bundle missing; running webpack build for startup smoke...');
  run('npx', ['webpack', '--mode=development', '--config', webpackConfigPath]);
}

async function createTestExtensionCopy() {
  const extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jira-hot-linker-extension-'));
  await fs.cp(extensionPath, extensionDir, {recursive: true});

  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.permissions = Array.from(new Set([...(manifest.permissions || []), 'scripting']));
  manifest.host_permissions = ['<all_urls>'];
  manifest.optional_host_permissions = ['<all_urls>'];
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return extensionDir;
}

async function getExtensionId(context) {
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    try {
      serviceWorker = await context.waitForEvent('serviceworker', {timeout: 30000});
    } catch (_firstTimeout) {
      const nudgePage = await context.newPage();
      await nudgePage.goto('about:blank').catch(() => {});
      await nudgePage.close().catch(() => {});
      [serviceWorker] = context.serviceWorkers();
      if (!serviceWorker) {
        serviceWorker = await context.waitForEvent('serviceworker', {timeout: 15000});
      }
    }
  }

  return serviceWorker.url().split('/')[2];
}

async function main() {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jira-hot-linker-playwright-'));
  await ensureExtensionBundle();
  const testExtensionPath = await createTestExtensionCopy();
  let context = null;

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${testExtensionPath}`,
        `--load-extension=${testExtensionPath}`,
      ],
    });

    const extensionId = await getExtensionId(context);
    console.log(`Extension startup OK (${extensionId})`);
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    await fs.rm(userDataDir, {recursive: true, force: true});
    await fs.rm(testExtensionPath, {recursive: true, force: true});
  }
}

main().catch(error => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
