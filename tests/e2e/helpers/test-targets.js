const {assertAllowedLiveIssue, getAllowedLiveIssue, getAllowedLiveIssueKeys, getLiveJiraConfig} = require('./live-jira');
const {getLiveIssue} = require('./live-jira-api');

const MOCK_DEFAULT_ISSUE_KEYS = ['JRACLOUD-97846', 'JRACLOUD-98123'];

function parseBooleanEnv(name, defaultValue) {
  const value = String(process.env[name] || '').trim().toLowerCase();
  if (!value) {
    return defaultValue;
  }
  if (['1', 'true', 'yes', 'on'].includes(value)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(value)) {
    return false;
  }
  return defaultValue;
}

function isMockMode() {
  return parseBooleanEnv('MOCK', true);
}

function getJiraTestTarget(servers) {
  if (isMockMode()) {
    return {
      mode: 'mock',
      isConfigured: true,
      hasAuth: true,
      instanceUrl: servers.jira.origin,
      domains: [servers.allowedPage.origin],
      issueKeys: [...MOCK_DEFAULT_ISSUE_KEYS],
      primaryIssueKey: MOCK_DEFAULT_ISSUE_KEYS[0],
      secondaryIssueKey: MOCK_DEFAULT_ISSUE_KEYS[1],
      supportsLiveApi: false,
    };
  }

  const config = getLiveJiraConfig();
  const issueKeys = getAllowedLiveIssueKeys(config);

  return {
    mode: 'live',
    ...config,
    domains: [servers.allowedPage.origin],
    issueKeys,
    primaryIssueKey: getAllowedLiveIssue(config, 0),
    secondaryIssueKey: getAllowedLiveIssue(config, 1) || getAllowedLiveIssue(config, 0),
    supportsLiveApi: true,
  };
}

function requireJiraTestTarget(playwrightTest, servers, options = {}) {
  const target = getJiraTestTarget(servers);
  if (!target.isConfigured) {
    playwrightTest.skip(true, 'Set JIRA_LIVE_INSTANCE_URL, JIRA_LIVE_PROJECT_KEYS, and JIRA_LIVE_ISSUE_KEYS when MOCK=false.');
  }
  if (target.mode === 'live' && options.requireAuth && !target.hasAuth) {
    playwrightTest.skip(true, 'Set JIRA_LIVE_STORAGE_STATE when MOCK=false.');
  }
  if (target.mode === 'live') {
    const minimumIssueCount = options.minimumIssueCount || 1;
    playwrightTest.skip(target.issueKeys.length < minimumIssueCount, `Need at least ${minimumIssueCount} allowed Jira issue key(s) when MOCK=false.`);
    for (const issueKey of target.issueKeys) {
      assertAllowedLiveIssue(issueKey, target);
    }
  }
  return target;
}

function buildExtensionConfig(servers, overrides = {}, target = getJiraTestTarget(servers)) {
  return {
    instanceUrl: target.instanceUrl,
    domains: target.domains,
    hoverDepth: 'shallow',
    hoverModifierKey: 'none',
    customFields: [],
    ...overrides,
  };
}

async function replaceIssueKeysOnPage(page, replacements) {
  await page.evaluate(entries => {
    const pairs = entries.filter(entry => entry.from && entry.to && entry.from !== entry.to);
    if (!pairs.length) {
      return;
    }

    const replaceText = value => {
      let nextValue = String(value || '');
      for (const pair of pairs) {
        nextValue = nextValue.split(pair.from).join(pair.to);
      }
      return nextValue;
    };

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();
    while (textNode) {
      textNode.nodeValue = replaceText(textNode.nodeValue);
      textNode = walker.nextNode();
    }

    for (const element of document.querySelectorAll('[href]')) {
      const href = element.getAttribute('href');
      if (href) {
        element.setAttribute('href', replaceText(href));
      }
    }
  }, replacements);
}

async function resolveTargetIssueKeys(target) {
  if (!target || target.mode !== 'live') {
    return target;
  }

  const resolvedIssueKeys = [];
  for (const issueKey of target.issueKeys || []) {
    const issue = await getLiveIssue(issueKey, target);
    const canonicalKey = String(issue?.key || issueKey).trim();
    if (canonicalKey && !resolvedIssueKeys.includes(canonicalKey)) {
      resolvedIssueKeys.push(canonicalKey);
    }
  }

  return {
    ...target,
    issueKeys: resolvedIssueKeys,
    primaryIssueKey: resolvedIssueKeys[0] || target.primaryIssueKey,
    secondaryIssueKey: resolvedIssueKeys[1] || resolvedIssueKeys[0] || target.secondaryIssueKey || target.primaryIssueKey,
  };
}

module.exports = {
  buildExtensionConfig,
  getJiraTestTarget,
  isMockMode,
  replaceIssueKeysOnPage,
  requireJiraTestTarget,
  resolveTargetIssueKeys,
};
