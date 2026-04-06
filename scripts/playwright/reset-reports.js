const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');
const target = path.join(repoRoot, 'tests/output/playwright');

fs.rmSync(target, {recursive: true, force: true});

console.log('Cleared Playwright report data.');
