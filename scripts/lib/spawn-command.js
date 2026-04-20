const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const WINDOWS_SCRIPT_WRAPPERS = new Set([
  'corepack',
  'npm',
  'npx',
  'pnpm',
  'pnpx',
  'yarn',
  'yarnpkg',
]);

function getCommandBaseName(command) {
  const normalizedCommand = String(command || '').trim();
  const extension = path.extname(normalizedCommand);
  return path.basename(normalizedCommand, extension).toLowerCase();
}

function isWindowsShellWrapper(command) {
  return process.platform === 'win32' && WINDOWS_SCRIPT_WRAPPERS.has(getCommandBaseName(command));
}

function resolveSpawnCommand(command) {
  const normalizedCommand = String(command || '').trim();
  if (!normalizedCommand || process.platform !== 'win32') {
    return normalizedCommand;
  }

  if (isWindowsShellWrapper(normalizedCommand)) {
    return normalizedCommand;
  }

  if (path.extname(normalizedCommand)) {
    return normalizedCommand;
  }

  if (normalizedCommand.includes('\\') || normalizedCommand.includes('/')) {
    for (const extension of ['.cmd', '.exe', '.bat']) {
      const candidate = `${normalizedCommand}${extension}`;
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return normalizedCommand;
  }

  return WINDOWS_SCRIPT_WRAPPERS.has(normalizedCommand.toLowerCase())
    ? `${normalizedCommand}.cmd`
    : normalizedCommand;
}

function quoteWindowsShellArg(value) {
  const stringValue = String(value ?? '');
  if (!stringValue) {
    return '""';
  }

  const escapedValue = stringValue
    .replace(/([&()\[\]{}^=;!'+,`~|<>])/g, '^$1')
    .replace(/"/g, '\\"');

  return /[\s%]/.test(stringValue)
    ? `"${escapedValue}"`
    : escapedValue;
}

function spawnCommandSync(command, args = [], options = {}) {
  const resolvedCommand = resolveSpawnCommand(command);
  if (isWindowsShellWrapper(command)) {
    const commandString = [resolvedCommand, ...args.map(quoteWindowsShellArg)].join(' ');
    const result = spawnSync(commandString, {
      ...options,
      shell: true,
    });
    return {resolvedCommand: commandString, result};
  }

  const result = spawnSync(resolvedCommand, args, options);
  return {resolvedCommand, result};
}

function formatCommand(command, args = []) {
  return [command, ...args].join(' ');
}

module.exports = {
  formatCommand,
  resolveSpawnCommand,
  spawnCommandSync,
};
