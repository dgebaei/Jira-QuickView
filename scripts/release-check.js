const path = require('path');
const {formatCommand, spawnCommandSync} = require('./lib/spawn-command');

const repoRoot = path.resolve(__dirname, '..');

function run(command, args, options = {}) {
  const {result} = spawnCommandSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.captureOutput ? 'pipe' : 'inherit',
  });

  if (result.error) {
    throw new Error(result.error.message || `Failed to start ${formatCommand(command, args)}`);
  }

  if (result.status !== 0) {
    const summary = formatCommand(command, args);
    const stderr = String(result.stderr || '').trim();
    throw new Error(stderr ? `${summary} failed: ${stderr}` : `${summary} failed.`);
  }

  return String(result.stdout || '').trim();
}

function ensureBranchIsMaster() {
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {captureOutput: true});
  if (branch !== 'master') {
    throw new Error(`Releases must be created from master. Current branch: ${branch}`);
  }
}

function ensureNoTrackedChanges() {
  const status = run('git', ['status', '--short', '--untracked-files=no'], {captureOutput: true});
  if (status) {
    throw new Error('Tracked working tree changes are present. Commit, stash, or discard them before releasing.');
  }
}

function warnOnUntrackedFiles() {
  const status = run('git', ['status', '--short'], {captureOutput: true});
  const untracked = status.split('\n').filter(line => line.startsWith('?? '));
  if (untracked.length) {
    console.warn('Warning: untracked files are present and will not be part of the release check:');
    for (const line of untracked) {
      console.warn(line);
    }
  }
}

function main() {
  ensureBranchIsMaster();
  ensureNoTrackedChanges();
  warnOnUntrackedFiles();
  run('gh', ['auth', 'status']);
  run(process.execPath, ['scripts/validate-manifest.js']);
  run('npm', ['run', 'build']);
  run('npm', ['run', 'test:e2e:startup-smoke']);
  console.log('Release preflight passed.');
}

try {
  main();
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}
