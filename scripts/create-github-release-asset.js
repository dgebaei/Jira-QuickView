const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {spawnSync} = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const pluginRoot = path.join(repoRoot, 'jira-plugin');
const crcTable = buildCrcTable();

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    stdio: options.captureOutput ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    const summary = [command, ...args].join(' ');
    const stderr = String(result.stderr || '').trim();
    fail(stderr ? `${summary} failed: ${stderr}` : `${summary} failed.`);
  }

  return String(result.stdout || '').trim();
}

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let j = 0; j < 8; j += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[i] = value >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosDate = ((year - 1980) << 9)
    | ((date.getMonth() + 1) << 5)
    | date.getDate();
  const dosTime = (date.getHours() << 11)
    | (date.getMinutes() << 5)
    | Math.floor(date.getSeconds() / 2);
  return {
    dosDate: dosDate & 0xffff,
    dosTime: dosTime & 0xffff,
  };
}

function uint16LE(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
}

function uint32LE(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function ensureFileExists(relativePath) {
  const filePath = path.join(pluginRoot, relativePath);
  const stats = fs.statSync(filePath, {throwIfNoEntry: false});
  if (!stats || !stats.isFile()) {
    fail(`Required file is missing: jira-plugin/${relativePath}`);
  }
  return {
    sourcePath: filePath,
    zipPath: relativePath.replace(/\\/g, '/'),
    stats,
  };
}

function createZip(entries, outputPath) {
  const fileParts = [];
  const centralParts = [];
  let offset = 0;

  entries.forEach(entry => {
    const input = fs.readFileSync(entry.sourcePath);
    const compressed = zlib.deflateRawSync(input, {level: zlib.constants.Z_BEST_COMPRESSION});
    const fileName = Buffer.from(entry.zipPath, 'utf8');
    const {dosDate, dosTime} = toDosDateTime(entry.stats.mtime);
    const checksum = crc32(input);

    const localHeader = Buffer.concat([
      uint32LE(0x04034b50),
      uint16LE(20),
      uint16LE(0),
      uint16LE(8),
      uint16LE(dosTime),
      uint16LE(dosDate),
      uint32LE(checksum),
      uint32LE(compressed.length),
      uint32LE(input.length),
      uint16LE(fileName.length),
      uint16LE(0),
      fileName,
    ]);

    fileParts.push(localHeader, compressed);

    const centralHeader = Buffer.concat([
      uint32LE(0x02014b50),
      uint16LE(20),
      uint16LE(20),
      uint16LE(0),
      uint16LE(8),
      uint16LE(dosTime),
      uint16LE(dosDate),
      uint32LE(checksum),
      uint32LE(compressed.length),
      uint32LE(input.length),
      uint16LE(fileName.length),
      uint16LE(0),
      uint16LE(0),
      uint16LE(0),
      uint16LE(0),
      uint32LE(0),
      uint32LE(offset),
      fileName,
    ]);

    centralParts.push(centralHeader);
    offset += localHeader.length + compressed.length;
  });

  const centralDirectory = Buffer.concat(centralParts);
  const endOfCentralDirectory = Buffer.concat([
    uint32LE(0x06054b50),
    uint16LE(0),
    uint16LE(0),
    uint16LE(entries.length),
    uint16LE(entries.length),
    uint32LE(centralDirectory.length),
    uint32LE(offset),
    uint16LE(0),
  ]);

  fs.writeFileSync(outputPath, Buffer.concat([
    ...fileParts,
    centralDirectory,
    endOfCentralDirectory,
  ]));
}

function main() {
  console.log('Validating manifest...');
  run(process.execPath, [path.join(repoRoot, 'scripts', 'validate-manifest.js')]);

  console.log('Building production bundle...');
  run('npm', ['run', 'build:bundle-prod']);

  const entries = [
    'manifest.json',
    'build/background.js',
    'build/background.js.LICENSE.txt',
    'build/background.js.map',
    'build/main.js',
    'build/main.js.LICENSE.txt',
    'build/main.js.map',
    'resources/ajax-loader.gif',
    'resources/annotation.html',
    'resources/status-chip.html',
    'resources/jira-quickview-16.png',
    'resources/jira-quickview-32.png',
    'resources/jira-quickview-48.png',
    'resources/jiralink128.png',
    'options/options.html',
    'options/declarative.js',
    'options/config.js',
    'options/options.jsx',
    'options/options.scss',
    'options/options-utils.js',
    'options/tooltip-layout-editor.jsx',
    'options/build/options.js',
    'options/build/options.js.LICENSE.txt',
    'options/build/options.js.map',
  ].map(ensureFileExists);

  const outputPath = path.join(repoRoot, 'jira-plugin-build.zip');
  console.log(`Creating ${path.basename(outputPath)}...`);
  createZip(entries, outputPath);

  const artifactSizeKiB = (fs.statSync(outputPath).size / 1024).toFixed(1);
  console.log(`Created ${path.relative(repoRoot, outputPath)} (${artifactSizeKiB} KiB)`);
  console.log('The archive extracts directly into the extension root (the folder containing manifest.json).');
}

main();
