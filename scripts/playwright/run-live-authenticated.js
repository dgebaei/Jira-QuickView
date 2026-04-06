require('./load-env-defaults');

const {spawnSync} = require('child_process');

function main() {
  const args = process.argv.slice(2);
  const result = spawnSync('npx', ['playwright', 'test', '--project=live-authenticated', ...args], {
    stdio: 'inherit',
    env: {
      ...process.env,
      MOCK: 'false',
    },
  });

  if (typeof result.status === 'number') {
    process.exit(result.status);
  }

  process.exit(1);
}

main();
