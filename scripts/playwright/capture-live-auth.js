require('./load-env-defaults');

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {chromium} = require('@playwright/test');
const {normalizeInstanceUrl} = require('../../tests/e2e/helpers/live-jira');

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const instanceUrl = String(process.env.JIRA_LIVE_INSTANCE_URL || '').trim();
  const normalizedInstanceUrl = normalizeInstanceUrl(instanceUrl);
  if (!instanceUrl) {
    throw new Error('Set JIRA_LIVE_INSTANCE_URL before capturing live Jira auth state.');
  }
  if (!normalizedInstanceUrl) {
    throw new Error('JIRA_LIVE_INSTANCE_URL must be a valid Jira URL. You can use the site root or a Jira Cloud board/project URL.');
  }

  const repoRoot = path.resolve(__dirname, '../..');
  const authDir = path.join(repoRoot, 'tests/.auth');
  const storageStatePath = path.resolve(
    process.env.JIRA_LIVE_STORAGE_STATE || path.join(authDir, 'jira-live.json')
  );

  fs.mkdirSync(path.dirname(storageStatePath), {recursive: true});

  const browser = await chromium.launch({headless: false, channel: 'chromium'});
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log(`Opening ${instanceUrl} in a real browser window.`);
  console.log(`Normalized Jira site for tests: ${normalizedInstanceUrl}`);
  console.log('Log in with your dedicated Jira test account, then return here.');
  await page.goto(instanceUrl, {waitUntil: 'domcontentloaded'});

  await ask('Press Enter after Jira is fully logged in and ready to save session state... ');
  await context.storageState({path: storageStatePath});
  await browser.close();

  console.log(`Saved live Jira storage state to ${storageStatePath}`);
  console.log('Treat this file like a session secret and keep it out of git.');
}

main().catch(error => {
  console.error(error.message || String(error));
  process.exit(1);
});
