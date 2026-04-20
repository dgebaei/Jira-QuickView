require('./load-env-defaults');

const path = require('path');
const {spawnCommandSync} = require('../lib/spawn-command');

const repoRoot = path.resolve(__dirname, '../..');

function deriveProjectEnv(label, currentEnv) {
  const env = {...currentEnv};

  if (label === 'mock-edge') {
    env.MOCK = env.MOCK || 'true';
  }

  if (label === 'public-smoke') {
    env.RUN_PUBLIC_JIRA_TESTS = env.RUN_PUBLIC_JIRA_TESTS || '1';
    env.MOCK = env.MOCK || 'true';
  }

  if (label === 'live-authenticated') {
    env.MOCK = env.MOCK || 'false';
  }

  return env;
}

const suites = [
  {label: 'mock-edge', args: ['--project=mock-edge', '--project=mock-popup']},
  {label: 'public-smoke', args: ['--project=public-smoke']},
  {label: 'live-authenticated', args: ['--project=live-authenticated']},
];

for (const suite of suites) {
  const {result} = spawnCommandSync('npm', ['exec', '--', 'playwright', 'test', ...suite.args], {
    cwd: repoRoot,
    env: deriveProjectEnv(suite.label, process.env),
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(result.error.message || 'Could not start Playwright suite.');
    process.exit(result.status || 1);
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
