#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const toolRoot = path.join(repoRoot, '.tools', 'llm-tldr');
const isWindows = process.platform === 'win32';
const executablePath = path.join(toolRoot, isWindows ? 'Scripts' : 'bin', isWindows ? 'tldr.exe' : 'tldr');

if (!fs.existsSync(executablePath)) {
  console.error('llm-tldr is not installed in .tools/llm-tldr.');
  console.error('Install it with: npm run tldr:setup');
  process.exit(1);
}

const toolHome = path.join(toolRoot, 'home');
const xdgCacheHome = path.join(toolHome, '.cache');
const xdgConfigHome = path.join(toolHome, '.config');
const xdgDataHome = path.join(toolHome, '.local', 'share');

[toolHome, xdgCacheHome, xdgConfigHome, xdgDataHome].forEach(dir => {
  fs.mkdirSync(dir, {recursive: true});
});

const env = {
  ...process.env,
  HOME: toolHome,
  USERPROFILE: toolHome,
  XDG_CACHE_HOME: xdgCacheHome,
  XDG_CONFIG_HOME: xdgConfigHome,
  XDG_DATA_HOME: xdgDataHome,
};

const result = spawnSync(executablePath, process.argv.slice(2), {
  stdio: 'inherit',
  env,
});

if (result.error) {
  console.error(result.error.message || 'Failed to start llm-tldr');
  process.exit(typeof result.status === 'number' ? result.status : 1);
}

process.exit(result.status ?? 0);
