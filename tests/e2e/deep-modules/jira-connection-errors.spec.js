const path = require('path');
const {test, expect} = require('@playwright/test');

const harnessPath = path.resolve(__dirname, '../../output/playwright/deep-modules/harness.js');

test.beforeEach(async ({page}) => {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({path: harnessPath});
});

function describe(page, failure, instanceUrl = 'https://jira.example.com/') {
  return page.evaluate(([failure, instanceUrl]) => {
    const {describeJiraConnectionFailure} = window.JiraQuickViewDeepModules;
    return describeJiraConnectionFailure(new Error(failure), instanceUrl);
  }, [failure, instanceUrl]);
}

test('names the sign-in, access, server, timeout and network causes with the Jira host', async ({page}) => {
  expect(await describe(page, 'HTTP 401 - ')).toBe('Not signed in to Jira at jira.example.com. Sign in to Jira in this browser, then try again.');
  expect(await describe(page, 'HTTP 403 - Forbidden')).toBe('Jira at jira.example.com denied access (HTTP 403). Check that you are signed in and can view this issue.');
  expect(await describe(page, 'HTTP 503 - Service Unavailable')).toBe('Jira at jira.example.com is not responding (HTTP 503). Try again later.');
  expect(await describe(page, 'Request timed out after 15000ms')).toBe('Jira at jira.example.com did not respond in time. Check your VPN or network connection.');
  expect(await describe(page, 'Failed to fetch')).toBe('Could not reach Jira at jira.example.com. Check your VPN or network connection.');
});

test('leaves issue-level failures to the caller and survives a missing instance URL', async ({page}) => {
  expect(await describe(page, 'HTTP 404 - Not Found')).toBe('');
  expect(await describe(page, 'HTTP 400 - Bad Request')).toBe('');
  expect(await describe(page, 'Could not load issue')).toBe('');
  expect(await describe(page, 'HTTP 401 - ', '')).toBe('Not signed in to Jira. Sign in to Jira in this browser, then try again.');
});
