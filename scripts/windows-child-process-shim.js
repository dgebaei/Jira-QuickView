const childProcess = require('child_process');
const path = require('path');

let enabled = false;

function shouldUseShell(command) {
  const baseName = path.basename(String(command || '')).toLowerCase();
  return baseName === 'npx' || baseName === 'npx.cmd';
}

function mergeShellOption(options = {}) {
  return {
    ...options,
  };
}

function quoteForCmd(value) {
  const text = String(value ?? '');
  if (!/[ \t"&()^<>|]/.test(text)) {
    return text;
  }
  return `"${text.replace(/(["^])/g, '^$1')}"`;
}

function buildCommandLine(command, args = []) {
  return [command, ...args].map(quoteForCmd).join(' ');
}

function normalizeArgsAndOptions(args, options) {
  if (Array.isArray(args)) {
    return {
      args,
      options: options || {},
    };
  }

  return {
    args: [],
    options: args || {},
  };
}

function enable() {
  if (enabled || process.platform !== 'win32') {
    return;
  }

  const originalSpawnSync = childProcess.spawnSync;
  const originalExecFileSync = childProcess.execFileSync;

  childProcess.spawnSync = function patchedSpawnSync(command, args, options) {
    if (!shouldUseShell(command)) {
      return originalSpawnSync.call(this, command, args, options);
    }

    const normalized = normalizeArgsAndOptions(args, options);
    return originalSpawnSync.call(
      this,
      'cmd.exe',
      ['/d', '/s', '/c', buildCommandLine(command, normalized.args)],
      mergeShellOption(normalized.options),
    );
  };

  childProcess.execFileSync = function patchedExecFileSync(command, args, options) {
    if (!shouldUseShell(command)) {
      return originalExecFileSync.call(this, command, args, options);
    }

    const normalized = normalizeArgsAndOptions(args, options);
    return originalExecFileSync.call(
      this,
      'cmd.exe',
      ['/d', '/s', '/c', buildCommandLine(command, normalized.args)],
      mergeShellOption(normalized.options),
    );
  };

  enabled = true;
}

module.exports = {
  enable,
};
