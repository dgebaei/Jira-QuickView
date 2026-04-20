require('./load-env-defaults');

const {spawnCommandSync} = require('../lib/spawn-command');

function main() {
  const args = process.argv.slice(2);
  const {result} = spawnCommandSync('npx', ['playwright', 'test', '--project=live-authenticated', ...args], {
    stdio: 'inherit',
    env: {
      ...process.env,
      MOCK: 'false',
    },
  });

  if (result.error) {
    console.error(result.error.message || 'Could not start live-authenticated Playwright suite.');
    process.exit(result.status || 1);
  }

  if (typeof result.status === 'number') {
    process.exit(result.status);
  }

  process.exit(1);
}

main();
