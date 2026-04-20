const fs = require('fs');
const path = require('path');
const {formatCommand, spawnCommandSync} = require('./lib/spawn-command');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const {result} = spawnCommandSync(command, args, {
    cwd: options.cwd,
    stdio: options.captureOutput ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });

  if (result.error) {
    fail(result.error.message || `Failed to start ${formatCommand(command, args)}`);
  }

  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    fail(stderr || `${formatCommand(command, args)} failed.`);
  }

  return String(result.stdout || '').trim();
}

function normalizePath(value) {
  return path.resolve(String(value || '').trim());
}

function copyIntoActiveExtension(targetWorktree, activeExtensionRoot) {
  fs.rmSync(activeExtensionRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
  fs.mkdirSync(activeExtensionRoot, {recursive: true});

  fs.copyFileSync(
    path.join(targetWorktree, 'jira-plugin', 'manifest.json'),
    path.join(activeExtensionRoot, 'manifest.json'),
  );

  for (const entry of ['build', 'options', 'resources']) {
    fs.cpSync(
      path.join(targetWorktree, 'jira-plugin', entry),
      path.join(activeExtensionRoot, entry),
      {recursive: true},
    );
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 1) {
    fail('Usage: node scripts/build-extension-and-reload.js [worktree-path]');
  }

  const currentWorktreeRoot = run('git', ['rev-parse', '--show-toplevel'], {captureOutput: true});
  const gitCommonDir = run('git', ['rev-parse', '--git-common-dir'], {captureOutput: true});
  const repoRoot = path.dirname(normalizePath(gitCommonDir));
  const targetWorktree = args[0] ? normalizePath(args[0]) : normalizePath(currentWorktreeRoot);

  if (!fs.existsSync(path.join(targetWorktree, 'jira-plugin'))) {
    fail(`Could not find jira-plugin in: ${targetWorktree}`);
  }

  const activeExtensionRoot = path.join(repoRoot, '.worktrees', '_active-extension_', 'jira-plugin');

  console.log(`Building extension from: ${targetWorktree}`);
  run('npx', ['webpack', '--mode=development', '--config', path.join(targetWorktree, 'webpack.config.js')], {
    cwd: targetWorktree,
  });

  copyIntoActiveExtension(targetWorktree, activeExtensionRoot);

  console.log(`Active unpacked extension updated at: ${activeExtensionRoot}`);
  console.log('Refresh this extension in chrome://extensions');
}

main();
