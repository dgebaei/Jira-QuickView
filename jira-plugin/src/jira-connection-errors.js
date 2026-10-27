// Turns a failed Jira request into a message the user can act on. Only covers
// failures about reaching or signing in to Jira; everything else returns '' so
// callers keep their own wording.
const NETWORK_ERROR_PATTERN = /(failed to fetch|networkerror|network request failed|load failed|err_)/i;
const TIMEOUT_PATTERN = /timed?\s*out/i;

function failureText(error) {
  return String(error?.message || error?.inner || error || '');
}

export function getJiraHttpStatus(error) {
  const match = failureText(error).match(/\bHTTP\s+(\d{3})\b/i);
  return match ? Number(match[1]) : null;
}

function jiraLabel(instanceUrl) {
  try {
    return `Jira at ${new URL(instanceUrl).hostname}`;
  } catch (ex) {
    return 'Jira';
  }
}

export function describeJiraConnectionFailure(error, instanceUrl) {
  const jira = jiraLabel(instanceUrl);
  const status = getJiraHttpStatus(error);
  if (status === 401) return `Not signed in to ${jira}. Sign in to Jira in this browser, then try again.`;
  if (status === 403) return `${jira} denied access (HTTP 403). Check that you are signed in and can view this issue.`;
  if (status >= 500) return `${jira} is not responding (HTTP ${status}). Try again later.`;
  const text = failureText(error);
  if (TIMEOUT_PATTERN.test(text)) return `${jira} did not respond in time. Check your VPN or network connection.`;
  if (NETWORK_ERROR_PATTERN.test(text)) return `Could not reach ${jira}. Check your VPN or network connection.`;
  return '';
}
