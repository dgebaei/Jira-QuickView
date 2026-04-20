#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {spawnCommandSync} = require('./lib/spawn-command');

const repoRoot = path.resolve(__dirname, '..');
const toolRoot = path.join(repoRoot, '.tools', 'llm-tldr');
const cacheDir = path.join(repoRoot, '.tools', 'uv-cache');
const isWindows = process.platform === 'win32';
const pythonPath = path.join(toolRoot, isWindows ? 'Scripts' : 'bin', isWindows ? 'python.exe' : 'python');
const tldrPath = path.join(toolRoot, isWindows ? 'Scripts' : 'bin', isWindows ? 'tldr.exe' : 'tldr');
const args = new Set(process.argv.slice(2));
const shouldUpgrade = args.has('--upgrade');
const shouldReinstall = args.has('--reinstall') || args.has('--force');

fs.mkdirSync(cacheDir, {recursive: true});

function run(command, commandArgs, extra = {}) {
  const {result} = spawnCommandSync(command, commandArgs, {
    stdio: 'inherit',
    cwd: repoRoot,
    ...extra,
  });
  if (result.error) {
    console.error(result.error.message || `Failed to start ${command}`);
    process.exit(result.status ?? 1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function ensureUv() {
  const {result: check} = spawnCommandSync('uv', ['--version'], {
    stdio: 'ignore',
    cwd: repoRoot,
  });
  if (check.error || check.status !== 0) {
    console.error('uv is required to bootstrap llm-tldr.');
    console.error('Install uv first, then rerun `npm run tldr:setup`.');
    process.exit(1);
  }
}

ensureUv();

if (!fs.existsSync(pythonPath)) {
  console.log('Creating repo-local llm-tldr virtualenv...');
  run('uv', ['venv', toolRoot, '--python', 'python3', '--cache-dir', cacheDir]);
}

if (!fs.existsSync(tldrPath) || shouldUpgrade || shouldReinstall) {
  console.log(`${fs.existsSync(tldrPath) ? 'Updating' : 'Installing'} llm-tldr into ${toolRoot}...`);
  const installArgs = ['pip', 'install', '--python', pythonPath, '--cache-dir', cacheDir];
  if (shouldUpgrade) {
    installArgs.push('--upgrade');
  }
  if (shouldReinstall) {
    installArgs.push('--reinstall');
  }
  installArgs.push('llm-tldr');
  run('uv', installArgs);
} else {
  console.log('llm-tldr is already installed.');
}

console.log(`Ready: ${tldrPath}`);
console.log('Run it via: npm run tldr:code -- <command>');
