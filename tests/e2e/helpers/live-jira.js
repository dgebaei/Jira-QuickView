const fs = require('fs');

function parseCsvEnv(name) {
  return String(process.env[name] || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function normalizeInstanceUrl(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) {
    return '';
  }

  try {
    return new URL(value).origin;
  } catch (error) {
    return '';
  }
}

function getLiveJiraConfig() {
  const instanceUrlInput = String(process.env.JIRA_LIVE_INSTANCE_URL || '').trim();
  const instanceUrl = normalizeInstanceUrl(instanceUrlInput);
  const projectKeys = parseCsvEnv('JIRA_LIVE_PROJECT_KEYS');
  const issueKeys = parseCsvEnv('JIRA_LIVE_ISSUE_KEYS');
  const storageStatePath = String(process.env.JIRA_LIVE_STORAGE_STATE || '').trim();

  return {
    instanceUrlInput,
    instanceUrl,
    projectKeys,
    issueKeys,
    storageStatePath,
    isConfigured: !!instanceUrl && projectKeys.length > 0 && issueKeys.length > 0,
    hasAuth: !!storageStatePath && fs.existsSync(storageStatePath),
  };
}

function getIssueProjectKey(issueKey) {
  return String(issueKey || '').split('-')[0] || '';
}

function assertAllowedLiveIssue(issueKey, config = getLiveJiraConfig()) {
  if (!config.instanceUrl) {
    throw new Error('Missing JIRA_LIVE_INSTANCE_URL');
  }
  if (!config.projectKeys.length) {
    throw new Error('Missing JIRA_LIVE_PROJECT_KEYS');
  }
  if (!config.issueKeys.length) {
    throw new Error('Missing JIRA_LIVE_ISSUE_KEYS');
  }
  if (!config.issueKeys.includes(issueKey)) {
    throw new Error(`Issue ${issueKey} is outside JIRA_LIVE_ISSUE_KEYS`);
  }

  const projectKey = getIssueProjectKey(issueKey);
  if (!config.projectKeys.includes(projectKey)) {
    throw new Error(`Issue ${issueKey} is outside JIRA_LIVE_PROJECT_KEYS`);
  }
}

function getAllowedLiveIssueKeys(config = getLiveJiraConfig()) {
  return config.issueKeys.filter(issueKey => config.projectKeys.includes(getIssueProjectKey(issueKey)));
}

function getAllowedLiveIssue(config = getLiveJiraConfig(), index = 0) {
  return getAllowedLiveIssueKeys(config)[index] || null;
}

module.exports = {
  assertAllowedLiveIssue,
  getAllowedLiveIssue,
  getAllowedLiveIssueKeys,
  getIssueProjectKey,
  getLiveJiraConfig,
  normalizeInstanceUrl,
};
