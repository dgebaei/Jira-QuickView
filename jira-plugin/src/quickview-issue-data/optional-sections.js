import {buildJiraSearchRequestUrls} from 'src/jira-issue-helpers';

function encodeJqlValue(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function customFieldClause(fieldId, issueKey) {
  const match = String(fieldId || '').match(/^customfield_(\d+)$/i);
  return match?.[1] ? `cf[${match[1]}] = ${encodeJqlValue(issueKey)}` : '';
}

function uniqueIssues(issues) {
  const seen = new Set();
  return (Array.isArray(issues) ? issues : []).filter(issue => {
    const key = String(issue?.key || '').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizePullRequests(response) {
  if (Array.isArray(response)) return response.filter(Boolean);
  const details = Array.isArray(response?.detail)
    ? response.detail
    : Array.isArray(response?.details)
      ? response.details
      : response ? [response] : [];
  return details.flatMap(entry => {
    if (Array.isArray(entry?.pullRequests)) return entry.pullRequests;
    if (Array.isArray(entry?.pullrequests)) return entry.pullrequests;
    if (Array.isArray(entry?.pullRequest)) return entry.pullRequest;
    return [];
  }).filter(Boolean);
}

function linkedIssueKeys(issue) {
  const keys = [];
  (issue?.fields?.issuelinks || []).forEach(link => {
    const key = String(link?.outwardIssue?.key || link?.inwardIssue?.key || '').trim().toUpperCase();
    if (key && !keys.includes(key)) keys.push(key);
  });
  return keys;
}

function normalizeUser(user) {
  const accountId = user?.accountId || '';
  const name = user?.name || user?.username || '';
  const key = user?.key || '';
  const displayName = user?.displayName || name || key || 'Unknown user';
  const nameParts = displayName.trim().split(/\s+/).filter(Boolean);
  const initials = nameParts.length > 1
    ? `${nameParts[0][0] || ''}${nameParts[nameParts.length - 1][0] || ''}`.toUpperCase()
    : String(nameParts[0] || '--').slice(0, 2).toUpperCase();
  const avatarUrl = user?.avatarUrls?.['48x48'] || user?.avatarUrl || '';
  return {
    ...user,
    id: accountId || name || key,
    accountId,
    name,
    key,
    displayName,
    avatarUrl,
    initials,
    metaText: user?.emailAddress || name || key || '',
    titleText: `Watcher: ${displayName}`,
    rawValue: {accountId, name, key},
  };
}

function sameUser(left, right) {
  const leftIds = [left?.accountId, left?.name, left?.username, left?.key].filter(Boolean);
  const rightIds = [right?.accountId, right?.name, right?.username, right?.key].filter(Boolean);
  return leftIds.some(id => rightIds.includes(id));
}

export function createOptionalSectionAcquisition(options = {}) {
  const cache = options.cache;
  const fieldFacts = options.fieldFacts;
  const instanceUrl = options.instanceUrl;
  const jira = options.jira;
  const ttlMs = options.ttlMs;

  async function searchIssues(jql, signal) {
    let lastError = null;
    for (const path of buildJiraSearchRequestUrls(instanceUrl, {
      maxResults: 100,
      fields: ['summary', 'issuetype', 'status', 'assignee'],
      jql,
    })) {
      try {
        const response = await jira.read({path, signal});
        return Array.isArray(response?.issues) ? response.issues : [];
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Issue search failed');
  }

  async function loadChildren(issueKey, signal) {
    return cache.read({
      family: 'children',
      key: issueKey,
      ttlMs,
      load: async () => {
        const directJql = `parent = ${encodeJqlValue(issueKey)}`;
        let directError = null;
        let direct = [];
        try {
          direct = await searchIssues(directJql, signal);
        } catch (error) {
          directError = error;
        }
        if (direct.length) return {items: uniqueIssues(direct), jql: directJql};

        let fieldIds = [];
        try {
          const [epicLink, parentLink] = await Promise.all([
            fieldFacts.getCatalogFieldIds('epicLink', signal),
            fieldFacts.getCatalogFieldIds('parentLink', signal),
          ]);
          fieldIds = [...epicLink, ...parentLink];
        } catch (error) {
          if (directError) throw directError;
        }
        const fallbackJqls = fieldIds.map(fieldId => customFieldClause(fieldId, issueKey)).filter(Boolean);
        if (!fallbackJqls.length) {
          if (directError) throw directError;
          return {items: [], jql: directJql};
        }
        const settled = await Promise.allSettled(fallbackJqls.map(jql => searchIssues(jql, signal)));
        const fulfilled = settled.filter(result => result.status === 'fulfilled');
        if (!fulfilled.length) throw directError || settled[0]?.reason || new Error('Child issue search failed');
        return {
          items: uniqueIssues(fulfilled.flatMap(result => result.value)),
          jql: fallbackJqls.filter((jql, index) => settled[index].status === 'fulfilled').join(' OR '),
        };
      },
    });
  }

  async function loadPullRequests(issueId, signal) {
    if (!issueId) return [];
    return cache.read({
      family: 'pullRequests',
      key: issueId,
      ttlMs,
      load: async () => {
        const response = await jira.read({
          path: `${instanceUrl}rest/dev-status/1.0/issue/detail?issueId=${encodeURIComponent(issueId)}&applicationType=gitlabselfmanaged&dataType=pullrequest`,
          signal,
        });
        return normalizePullRequests(response);
      },
    });
  }

  async function loadLinkTypes(signal) {
    return cache.read({
      family: 'linkTypes',
      key: instanceUrl,
      ttlMs,
      load: async () => {
        const response = await jira.read({path: `${instanceUrl}rest/api/2/issueLinkType`, signal});
        return Array.isArray(response?.issueLinkTypes) ? response.issueLinkTypes : [];
      },
    });
  }

  async function loadLinkedIssues(issue, signal) {
    const issueKey = String(issue?.key || '');
    return cache.read({
      family: 'linkedIssues',
      key: issueKey,
      ttlMs,
      load: async () => {
        const keys = linkedIssueKeys(issue);
        const linkTypesPromise = loadLinkTypes(signal);
        let detailsByKey = {};
        if (keys.length) {
          const items = await searchIssues(`key in (${keys.map(encodeJqlValue).join(', ')})`, signal);
          detailsByKey = Object.fromEntries(items.map(item => [String(item?.key || '').toUpperCase(), item]));
        }
        return {detailsByKey, items: Object.values(detailsByKey), linkTypes: await linkTypesPromise};
      },
    });
  }

  async function loadViewer(signal) {
    return cache.read({
      family: 'viewer',
      key: instanceUrl,
      ttlMs,
      load: async () => {
        try {
          return normalizeUser(await jira.read({path: `${instanceUrl}rest/api/2/myself`, signal}));
        } catch (primaryError) {
          const session = await jira.read({path: `${instanceUrl}rest/auth/1/session`, signal});
          return normalizeUser(session?.user || {});
        }
      },
    });
  }

  async function loadWatchers(issueKey, signal) {
    return cache.read({
      family: 'watchers',
      key: issueKey,
      ttlMs,
      load: async () => {
        const [response, viewerResult] = await Promise.all([
          jira.read({path: `${instanceUrl}rest/api/2/issue/${encodeURIComponent(issueKey)}/watchers`, signal}),
          loadViewer(signal).catch(() => null),
        ]);
        const viewer = viewerResult || null;
        const seen = new Set();
        const watchers = (Array.isArray(response?.watchers) ? response.watchers : [])
          .map(user => ({...normalizeUser(user), isCurrentUser: sameUser(user, viewer)}))
          .filter(user => {
            if (!user.id || seen.has(user.id)) return false;
            seen.add(user.id);
            return true;
          })
          .sort((left, right) => {
            if (left.isCurrentUser !== right.isCurrentUser) return left.isCurrentUser ? -1 : 1;
            return left.displayName.localeCompare(right.displayName, undefined, {sensitivity: 'base'});
          });
        const watchCount = Number(response?.watchCount);
        return {
          isWatching: typeof response?.isWatching === 'boolean'
            ? response.isWatching
            : watchers.some(watcher => watcher.isCurrentUser),
          watchCount: Number.isFinite(watchCount) ? watchCount : watchers.length,
          watchers,
        };
      },
    });
  }

  async function loadReactions(commentIds, signal) {
    const ids = (commentIds || []).map(id => String(id || '')).filter(Boolean);
    if (!ids.length) return {byCommentId: {}, supported: true};
    return cache.read({
      family: 'reactions',
      key: ids.join(','),
      ttlMs,
      load: async () => {
        const response = await jira.write({
          method: 'POST',
          path: `${instanceUrl}rest/internal/2/reactions/view`,
          body: {commentIds: ids.map(Number)},
          headers: {'X-Atlassian-Token': 'no-check'},
          signal,
        });
        const byCommentId = {};
        (Array.isArray(response) ? response : []).forEach(entry => {
          const commentId = String(entry?.commentId || '');
          const emojiId = String(entry?.emojiId || '');
          if (!commentId || !emojiId) return;
          byCommentId[commentId] = byCommentId[commentId] || {};
          byCommentId[commentId][emojiId] = {
            count: Number(entry.count) || 0,
            reacted: !!entry.reacted,
            pending: false,
          };
        });
        return {byCommentId, supported: true};
      },
    });
  }

  function invalidateIssue(issueKey, issueId, mutation = {}) {
    if (mutation.kind === 'issueChanged' || mutation.kind === 'linksChanged' ||
      (mutation.kind === 'fieldChanged' && ['parent', 'customfield_10014'].includes(String(mutation.fieldId || '').toLowerCase()))) {
      cache.invalidate('children', issueKey);
    }
    if (mutation.kind === 'issueChanged' || mutation.kind === 'linksChanged') {
      cache.invalidate('linkedIssues', issueKey);
    }
    if (mutation.kind === 'issueChanged' || mutation.kind === 'watchersChanged') {
      cache.invalidate('watchers', issueKey);
    }
    if (mutation.kind === 'issueChanged' || mutation.kind === 'commentChanged' || mutation.kind === 'reactionChanged') {
      const commentIds = Array.isArray(mutation.commentIds) ? mutation.commentIds.map(String).filter(Boolean) : [];
      if (commentIds.length) {
        cache.invalidate('reactions', commentIds.join(','));
      } else {
        cache.invalidateFamily('reactions');
      }
    }
    if (mutation.kind === 'issueChanged' && issueId) cache.invalidate('pullRequests', issueId);
  }

  return {invalidateIssue, loadChildren, loadLinkedIssues, loadPullRequests, loadReactions, loadViewer, loadWatchers};
}
