require('./scripts/playwright/load-env-defaults');

const path = require('path');

const outputRoot = path.join(__dirname, 'tests/output/playwright');
const testResultsDir = path.join(outputRoot, 'test-results');

module.exports = {
  testDir: path.join(__dirname, 'tests/e2e'),
  timeout: 90 * 1000,
  expect: {
    timeout: 10 * 1000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ['list'],
    ['html', {outputFolder: path.join(outputRoot, 'report'), open: 'never'}],
  ],
  outputDir: testResultsDir,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10 * 1000,
    navigationTimeout: 30 * 1000,
  },
  globalSetup: path.join(__dirname, 'tests/e2e/helpers/global-setup.js'),
  projects: [
    {
      name: 'mock-edge',
      testMatch: /(?:^|\/)(?:error-states|partial-failures|user-field-editing)\.spec\.js$/,
    },
    {
      name: 'mock-popup',
      testMatch: /(?:^|\/)(?:mock-jira-flows|advanced-mock-flows)\.spec\.js$/,
      grep: /@mock-only/,
    },
    {
      name: 'public-smoke',
      testMatch: /(?:^|\/)public-jira\.spec\.js$/,
    },
    {
      name: 'live-authenticated',
      testMatch: /(?:^|\/)(?:options|hover-and-popup|mock-jira-flows|advanced-mock-flows|live-jira)\.spec\.js$/,
      grepInvert: /@mock-only/,
    },
  ],
};
