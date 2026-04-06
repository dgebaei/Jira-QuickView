export function createContentIssueLinkageHelpers(options) {
  const encodeJqlValue = options?.encodeJqlValue;
  const get = options?.get;
  const getBuildEditOption = options?.getBuildEditOption;
  const getCachedValue = options?.getCachedValue;
  const getGetIssueEditMeta = options?.getIssueEditMeta;
  const getIssueSummary = options?.getIssueSummary;
  const instanceUrl = options?.instanceUrl;
  const issueSearchCache = options?.issueSearchCache;
  const issueSearchRecentCache = options?.issueSearchRecentCache;

  function extractIssueKeyFromLinkageValue(value) {
    if (!value) {
      return '';
    }
    if (typeof value === 'string') {
      return value.trim();
    }
    if (typeof value === 'object') {
      return String(value.key || value.value || value.id || '').trim();
    }
    return '';
  }

  function findEpicLinkFieldId(issueData, editMeta) {
    const names = issueData?.names || {};
    const editMetaFields = editMeta?.fields || {};
    const fromNames = Object.keys(names).find(fieldId => {
      const fieldName = String(names[fieldId] || '').toLowerCase();
      return fieldName === 'epic link' || fieldName === 'epic';
    });
    if (fromNames) {
      return fromNames;
    }
    return Object.keys(editMetaFields).find(fieldId => {
      const fieldName = String(editMetaFields[fieldId]?.name || '').toLowerCase();
      return fieldName === 'epic link' || fieldName === 'epic';
    }) || '';
  }

  async function resolveIssueLinkage(issueData) {
    const getIssueEditMeta = getGetIssueEditMeta?.();
    if (typeof getIssueEditMeta !== 'function') {
      throw new Error('Missing getIssueEditMeta helper');
    }
    if (!issueData?.key) {
      return {
        mode: '',
        label: 'Parent',
        editable: false,
        fieldKey: '',
        currentLink: null
      };
    }
    const editMeta = await getIssueEditMeta(issueData.key).catch(() => ({fields: {}}));
    const parentValue = issueData?.fields?.parent;
    const parentFieldMeta = editMeta.fields?.parent;
    if (parentValue?.key || parentFieldMeta) {
      const currentKey = parentValue?.key || '';
      const currentSummary = parentValue?.fields?.summary || currentKey;
      return {
        mode: 'parent',
        label: 'Parent',
        editable: !!parentFieldMeta,
        fieldKey: 'parent',
        currentLink: currentKey
          ? {
              key: currentKey,
              summary: currentSummary,
              url: `${instanceUrl}browse/${currentKey}`
            }
          : null
      };
    }

    const epicFieldId = findEpicLinkFieldId(issueData, editMeta);
    const epicKey = extractIssueKeyFromLinkageValue(issueData?.fields?.[epicFieldId]);
    if (!epicFieldId && !epicKey) {
      return {
        mode: '',
        label: 'Parent',
        editable: false,
        fieldKey: '',
        currentLink: null
      };
    }
    let epicSummary = epicKey;
    if (epicKey) {
      try {
        const epicSummaryData = await getIssueSummary(epicKey);
        epicSummary = epicSummaryData?.summary || epicKey;
      } catch (error) {
        epicSummary = epicKey;
      }
    }
    return {
      mode: 'epicLink',
      label: 'Epic',
      editable: !!editMeta.fields?.[epicFieldId],
      fieldKey: epicFieldId,
      currentLink: epicKey
        ? {
            key: epicKey,
            summary: epicSummary,
            url: `${instanceUrl}browse/${epicKey}`
          }
        : null
    };
  }

  function buildIssueSearchOption(issue, extra = {}) {
    const buildEditOption = getBuildEditOption?.();
    if (typeof buildEditOption !== 'function') {
      throw new Error('Missing buildEditOption helper');
    }
    const issueKey = String(issue?.key || '').trim();
    const issueSummary = String(issue?.fields?.summary || issue?.summary || issueKey).trim();
    const statusName = issue?.fields?.status?.name || '';
    return buildEditOption(issueKey, `[${issueKey}] ${issueSummary}`.trim(), {
      id: issueKey,
      iconUrl: issue?.fields?.issuetype?.iconUrl || issue?.issuetype?.iconUrl || '',
      metaText: statusName,
      rawValue: {
        key: issueKey,
        summary: issueSummary
      },
      searchText: `${issueKey} ${issueSummary} ${statusName}`,
      ...extra
    });
  }

  function buildIssueSearchCacheKey(query, issueData, mode) {
    const projectKey = String(issueData?.key || '').split('-')[0];
    return `${projectKey}__${mode}__${String(query || '').trim().toLowerCase()}`;
  }

  function getRecentIssueSearchOptions(issueData, mode) {
    const projectKey = String(issueData?.key || '').split('-')[0];
    return issueSearchRecentCache.get(`${projectKey}__${mode}`) || [];
  }

  function setRecentIssueSearchOptions(issueData, mode, options) {
    const projectKey = String(issueData?.key || '').split('-')[0];
    if (!projectKey || !mode) {
      return;
    }
    issueSearchRecentCache.set(`${projectKey}__${mode}`, (Array.isArray(options) ? options : []).slice(0, 30));
  }

  function buildSafeIssueSearchClauses(query, projectKey) {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) {
      return [];
    }

    const clauses = [];
    const tokenClauses = normalizedQuery
      .split(/[^A-Za-z0-9]+/)
      .map(token => token.trim())
      .filter(token => token.length >= 2)
      .slice(0, 4)
      .map(token => {
        const escapedToken = token
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"');
        return `summary ~ "${escapedToken}*"`;
      });

    if (tokenClauses.length === 1) {
      clauses.push(tokenClauses[0]);
    } else if (tokenClauses.length > 1) {
      clauses.push(`(${tokenClauses.join(' AND ')})`);
    }

    if (/^\d+$/.test(normalizedQuery)) {
      clauses.push(`key = ${encodeJqlValue(`${projectKey}-${normalizedQuery}`)}`);
    } else if (/^[A-Z][A-Z0-9_]*-\d+$/i.test(normalizedQuery)) {
      clauses.push(`key = ${encodeJqlValue(normalizedQuery.toUpperCase())}`);
    }

    return clauses;
  }

  async function searchParentCandidates(query, issueData, linkageMode) {
    const issueKey = String(issueData?.key || '').trim();
    const projectKey = issueKey.split('-')[0];
    if (!issueKey || !projectKey) {
      return [];
    }
    const normalizedQuery = String(query || '').trim();
    const cacheKey = buildIssueSearchCacheKey(normalizedQuery, issueData, linkageMode || 'linkage');
    return getCachedValue(issueSearchCache, cacheKey, async () => {
      const escapedIssueKey = encodeJqlValue(issueKey);
      const isEpicLinkMode = linkageMode === 'epicLink';
      const jqlParts = [`key != ${escapedIssueKey}`];
      if (!isEpicLinkMode) {
        const escapedProjectKey = encodeJqlValue(projectKey);
        jqlParts.unshift(`project = ${escapedProjectKey}`);
      }
      const searchClauses = buildSafeIssueSearchClauses(normalizedQuery, projectKey);
      if (searchClauses.length) {
        jqlParts.push(`(${searchClauses.join(' OR ')})`);
      }
      const jql = `${jqlParts.join(' AND ')} ORDER BY updated DESC`;
      let response;
      try {
        response = await get(`${instanceUrl}rest/api/2/search?maxResults=20&fields=summary,issuetype,status&jql=${encodeURIComponent(jql)}`);
      } catch (error) {
        const errorText = String(error?.message || error?.inner || error || '');
        if (!errorText.includes('410')) {
          throw error;
        }
        response = await get(`${instanceUrl}rest/api/3/search/jql?maxResults=20&fields=summary,issuetype,status&jql=${encodeURIComponent(jql)}`);
      }
      const issues = Array.isArray(response?.issues) ? response.issues : [];
      const options = issues
        .map(issue => buildIssueSearchOption(issue))
        .filter(option => option.id);
      setRecentIssueSearchOptions(issueData, linkageMode || 'linkage', options);
      return options;
    });
  }

  return {
    getRecentIssueSearchOptions,
    resolveIssueLinkage,
    searchParentCandidates,
  };
}
