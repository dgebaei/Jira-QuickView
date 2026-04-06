export function createContentIssueDataHelpers(options) {
  const cacheTtlMs = Number(options?.cacheTtlMs) || 0;
  const changelogCache = options?.changelogCache;
  const customFields = options?.customFields;
  const get = options?.get;
  const getEpicLinkFieldIds = options?.getEpicLinkFieldIds;
  const getSprintFieldIds = options?.getSprintFieldIds;
  const instanceUrl = options?.instanceUrl;
  const issueCache = options?.issueCache;

  async function getCachedValue(cache, key, buildValue) {
    const existing = cache.get(key);
    if (existing && (Date.now() - existing.createdAt) < cacheTtlMs) {
      return existing.value;
    }

    const value = await buildValue();
    cache.set(key, {
      createdAt: Date.now(),
      value
    });
    return value;
  }

  function setCachedValue(cache, key, value) {
    if (!key) {
      return;
    }
    cache.set(key, {
      createdAt: Date.now(),
      value
    });
  }

  async function getIssueChangelog(issueKey) {
    return getCachedValue(changelogCache, issueKey, async () => {
      const response = await get(`${instanceUrl}rest/api/2/issue/${encodeURIComponent(issueKey)}?expand=changelog&fields=id`);
      return response?.changelog || {histories: []};
    });
  }

  async function getIssueMetaData(issueKey) {
    return getCachedValue(issueCache, issueKey, async () => {
      const [sprintFieldIds, epicLinkFieldIds] = await Promise.all([
        getSprintFieldIds(instanceUrl),
        getEpicLinkFieldIds(instanceUrl)
      ]);
      const fields = [
        'description',
        'id',
        'project',
        'reporter',
        'assignee',
        'summary',
        'timetracking',
        'attachment',
        'comment',
        'issuetype',
        'status',
        'priority',
        'labels',
        'environment',
        'versions',
        'parent',
        'fixVersions',
        'watches',
        ...sprintFieldIds,
        ...epicLinkFieldIds,
        ...(customFields || []).map(({fieldId}) => fieldId)
      ];
      return get(`${instanceUrl}rest/api/2/issue/${issueKey}?fields=${fields.join(',')}&expand=renderedFields,names`);
    });
  }

  async function getIssueSummary(issueKey) {
    if (!issueKey) {
      return null;
    }
    return getCachedValue(issueCache, `summary__${issueKey}`, async () => {
      const data = await get(`${instanceUrl}rest/api/2/issue/${issueKey}?fields=summary`);
      return {
        key: issueKey,
        summary: data?.fields?.summary || issueKey
      };
    });
  }

  return {
    getCachedValue,
    getIssueChangelog,
    getIssueMetaData,
    getIssueSummary,
    setCachedValue,
  };
}
