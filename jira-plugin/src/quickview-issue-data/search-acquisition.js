import {buildJiraSearchRequestUrls} from 'src/jira-issue-helpers';

function stripMarkup(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUser(user) {
  if (!user || typeof user !== 'object') {
    return null;
  }
  const candidate = user.user && typeof user.user === 'object' ? user.user : user;
  const avatarUrl = candidate?.avatarUrls?.['48x48'] || candidate?.avatarUrl || '';
  return {
    ...candidate,
    accountId: candidate?.accountId || candidate?.id || '',
    name: candidate?.name || candidate?.username || candidate?.userName || '',
    key: candidate?.key || candidate?.userKey || '',
    displayName: candidate?.displayName || candidate?.name || candidate?.username || candidate?.emailAddress || '',
    emailAddress: candidate?.emailAddress || candidate?.email || '',
    avatarUrls: candidate?.avatarUrls || (avatarUrl ? {'48x48': avatarUrl} : {}),
  };
}

function normalizeUsers(users) {
  const seen = new Set();
  return (Array.isArray(users) ? users : [])
    .map(normalizeUser)
    .filter(user => {
      const identity = String(user?.accountId || user?.name || user?.key || '');
      if (!identity || seen.has(identity)) {
        return false;
      }
      seen.add(identity);
      return true;
    });
}

function extractArray(response) {
  return Array.isArray(response) ? response : null;
}

function extractPicker(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.users)) return response.users;
  if (Array.isArray(response?.items)) return response.items;
  return null;
}

function extractInternal(response) {
  if (Array.isArray(response)) return response;
  for (const key of ['users', 'items', 'results', 'values']) {
    if (Array.isArray(response?.[key])) return response[key];
  }
  return null;
}

function normalizeLabels(payload) {
  let entries = [];
  if (Array.isArray(payload)) {
    entries = payload;
  } else if (Array.isArray(payload?.results)) {
    entries = payload.results;
  } else if (Array.isArray(payload?.suggestions)) {
    entries = payload.suggestions;
  }
  return entries.map(entry => {
    const value = typeof entry === 'string'
      ? entry
      : entry?.label || entry?.value || entry?.name || stripMarkup(entry?.html || entry?.displayName || '');
    const metaText = typeof entry === 'string' ? '' : stripMarkup(entry?.html || entry?.displayName || '');
    return {
      label: String(value || '').trim(),
      value: String(value || '').trim(),
      metaText: metaText && metaText !== value ? metaText : '',
    };
  }).filter(item => item.value);
}

export function createSearchAcquisition(options = {}) {
  const cache = options.cache;
  const jira = options.jira;
  const instanceUrl = options.instanceUrl;
  const ttlMs = options.ttlMs;
  const loadCore = options.loadCore;
  const preferredStrategies = new Map();

  function encodeJqlValue(value) {
    return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  async function readFirst(strategyFamily, strategies, signal) {
    const preferred = preferredStrategies.get(strategyFamily);
    const ordered = preferred
      ? [...strategies.filter(strategy => strategy.key === preferred), ...strategies.filter(strategy => strategy.key !== preferred)]
      : strategies;
    let lastError = null;
    for (const strategy of ordered) {
      try {
        const response = await jira.read({path: strategy.path, signal});
        const items = strategy.extract(response);
        if (!Array.isArray(items)) {
          throw new Error(`Unexpected response for ${strategy.key}`);
        }
        preferredStrategies.set(strategyFamily, strategy.key);
        return {items, strategyUsed: strategy.key};
      } catch (error) {
        lastError = error;
      }
    }
    preferredStrategies.delete(strategyFamily);
    throw lastError || new Error('Jira search failed');
  }

  async function searchAssignee({issueKey, query, signal}) {
    const projectKey = issueKey.split('-')[0];
    const encodedQuery = encodeURIComponent(query);
    const encodedIssueKey = encodeURIComponent(issueKey);
    const encodedProjectKey = encodeURIComponent(projectKey);
    const result = await readFirst('assignee', [
      {key: 'internal-assignee', path: `${instanceUrl}rest/internal/2/users/assignee?issueKey=${encodedIssueKey}&maxResults=100&query=${encodedQuery}`, extract: extractInternal},
      {key: 'issue-query', path: `${instanceUrl}rest/api/2/user/assignable/search?issueKey=${encodedIssueKey}&maxResults=20&query=${encodedQuery}`, extract: extractArray},
      {key: 'project-query', path: `${instanceUrl}rest/api/2/user/assignable/search?project=${encodedProjectKey}&maxResults=20&query=${encodedQuery}`, extract: extractArray},
      {key: 'issue-username', path: `${instanceUrl}rest/api/2/user/assignable/search?issueKey=${encodedIssueKey}&maxResults=20&username=${encodedQuery}`, extract: extractArray},
      {key: 'project-username', path: `${instanceUrl}rest/api/2/user/assignable/search?project=${encodedProjectKey}&maxResults=20&username=${encodedQuery}`, extract: extractArray},
    ], signal);
    return {...result, items: normalizeUsers(result.items)};
  }

  async function searchPeople({query, signal}) {
    const encodedQuery = encodeURIComponent(query);
    const result = await readFirst('people', [
      {key: 'picker-query', path: `${instanceUrl}rest/api/2/user/picker?query=${encodedQuery}`, extract: extractPicker},
      {key: 'search-query', path: `${instanceUrl}rest/api/2/user/search?query=${encodedQuery}&maxResults=20`, extract: extractArray},
      {key: 'search-username', path: `${instanceUrl}rest/api/2/user/search?username=${encodedQuery}&maxResults=20`, extract: extractArray},
    ], signal);
    return {...result, items: normalizeUsers(result.items)};
  }

  async function searchLabels({query, signal}) {
    const response = await jira.read({
      path: `${instanceUrl}rest/api/2/jql/autocompletedata/suggestions?fieldName=labels&fieldValue=${encodeURIComponent(query)}`,
      signal,
    });
    return {items: normalizeLabels(response), strategyUsed: 'jql-suggestions'};
  }

  async function searchTempo({query, projectId, signal}) {
    if (!projectId) {
      return {items: [], strategyUsed: 'tempo-account-search'};
    }
    const tqlQuery = `status=OPEN AND (project=${projectId} OR project=GLOBAL)`;
    const response = await jira.read({
      path: `${instanceUrl}rest/tempo-accounts/1/account/search?tqlQuery=${encodeURIComponent(tqlQuery)}&query=${encodeURIComponent(query)}&limit=15&offset=0`,
      signal,
    });
    return {
      items: Array.isArray(response?.accounts) ? response.accounts : [],
      strategyUsed: 'tempo-account-search',
    };
  }

  async function loadIssueTypes(signal) {
    return cache.read({
      family: 'issueTypes',
      key: instanceUrl,
      ttlMs,
      load: async () => {
        let lastError = null;
        for (const version of ['3', '2']) {
          try {
            const response = await jira.read({path: `${instanceUrl}rest/api/${version}/issuetype`, signal});
            if (Array.isArray(response)) return response;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError || new Error('Could not load Jira issue types');
      },
    });
  }

  function buildIssueTypeClause(issueTypeIds) {
    const ids = [...new Set((issueTypeIds || []).map(id => String(id || '').trim()).filter(Boolean))];
    return ids.length ? `issuetype in (${ids.map(encodeJqlValue).join(', ')})` : '';
  }

  async function resolveParentConstraint(issue, linkageMode, signal) {
    let issueTypes = [];
    try {
      issueTypes = await loadIssueTypes(signal);
    } catch (error) {
      issueTypes = [];
    }
    const issueType = issue?.fields?.issuetype || {};
    const currentType = issueTypes.find(type => String(type?.id || '') === String(issueType?.id || '')) || issueType;
    const hasHierarchyMetadata = issueTypes.some(type => Number.isFinite(Number(type?.hierarchyLevel)));
    if (linkageMode === 'epicLink') {
      if (hasHierarchyMetadata) {
        const typeIds = issueTypes.filter(type => Number(type?.hierarchyLevel) === 1).map(type => type.id);
        const clause = buildIssueTypeClause(typeIds);
        if (clause) return {allowedTypeIds: new Set(typeIds.map(String)), clause, sameProjectOnly: false};
      }
      return {allowedTypeIds: null, clause: 'issuetype = Epic', sameProjectOnly: false};
    }
    const currentLevel = Number(currentType?.hierarchyLevel);
    if (hasHierarchyMetadata && Number.isFinite(currentLevel)) {
      const typeIds = issueTypes.filter(type => Number(type?.hierarchyLevel) === currentLevel + 1).map(type => type.id);
      const clause = buildIssueTypeClause(typeIds);
      if (clause) return {allowedTypeIds: new Set(typeIds.map(String)), clause, sameProjectOnly: false};
    }
    if (currentType?.subtask === true || issueType?.subtask === true) {
      return {allowedTypeIds: null, clause: 'issuetype in standardIssueTypes()', sameProjectOnly: true};
    }
    return {allowedTypeIds: null, clause: 'issuetype = Epic', sameProjectOnly: false};
  }

  function buildSafeSearchClauses(query, projectKey) {
    if (!query) return [];
    const clauses = query.split(/[^A-Za-z0-9]+/)
      .map(token => token.trim())
      .filter(token => token.length >= 2)
      .slice(0, 4)
      .map(token => `summary ~ "${token.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}*"`);
    const result = clauses.length > 1 ? [`(${clauses.join(' AND ')})`] : clauses;
    if (/^\d+$/.test(query)) result.push(`key = ${encodeJqlValue(`${projectKey}-${query}`)}`);
    if (/^[A-Z][A-Z0-9_]*-\d+$/i.test(query)) result.push(`key = ${encodeJqlValue(query.toUpperCase())}`);
    return result;
  }

  async function runIssueSearch(jql, signal) {
    let lastError = null;
    const urls = buildJiraSearchRequestUrls(instanceUrl, {
      maxResults: 30,
      fields: ['summary', 'issuetype', 'status', 'project'],
      jql,
    });
    for (const path of urls) {
      try {
        const response = await jira.read({path, signal});
        return {issues: Array.isArray(response?.issues) ? response.issues : [], strategyUsed: new URL(path).pathname};
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Issue search failed');
  }

  async function searchParents({issueKey, fieldId, query, signal}) {
    const issue = await loadCore(issueKey, signal);
    const projectKey = issueKey.split('-')[0];
    const linkageMode = fieldId === 'parent' ? 'parent' : 'epicLink';
    const constraint = await resolveParentConstraint(issue, linkageMode, signal);
    const commonParts = [`key != ${encodeJqlValue(issueKey)}`, constraint.clause];
    const searchClauses = buildSafeSearchClauses(query, projectKey);
    if (searchClauses.length) commonParts.push(`(${searchClauses.join(' OR ')})`);
    const plans = [`project = ${encodeJqlValue(projectKey)}`];
    if (!constraint.sameProjectOnly) plans.push(`project != ${encodeJqlValue(projectKey)}`);
    const settled = await Promise.allSettled(plans.map(projectClause => {
      return runIssueSearch(`${projectClause} AND ${commonParts.join(' AND ')} ORDER BY summary ASC`, signal);
    }));
    const fulfilled = settled.filter(result => result.status === 'fulfilled');
    if (!fulfilled.length) throw settled[0]?.reason || new Error('Issue search failed');
    const seen = new Set();
    const items = fulfilled.flatMap(result => result.value.issues).filter(candidate => {
      const candidateKey = String(candidate?.key || '');
      const candidateTypeId = String(candidate?.fields?.issuetype?.id || '');
      if (!candidateKey || seen.has(candidateKey)) return false;
      if (constraint.allowedTypeIds && !constraint.allowedTypeIds.has(candidateTypeId)) return false;
      seen.add(candidateKey);
      return true;
    }).sort((left, right) => {
      const leftLocal = String(left?.fields?.project?.key || left?.key || '').split('-')[0] === projectKey;
      const rightLocal = String(right?.fields?.project?.key || right?.key || '').split('-')[0] === projectKey;
      if (leftLocal !== rightLocal) return leftLocal ? -1 : 1;
      return String(left?.fields?.summary || left?.key || '').localeCompare(String(right?.fields?.summary || right?.key || ''), undefined, {numeric: true, sensitivity: 'base'});
    });
    return {
      items,
      strategyUsed: fulfilled.map(result => result.value.strategyUsed).join(','),
    };
  }

  function normalizeIssueCandidate(issue) {
    const key = String(issue?.key || issue?.id || '').trim().toUpperCase();
    const label = stripMarkup(issue?.label || '');
    const summary = stripMarkup(issue?.summaryText || issue?.summary || issue?.fields?.summary || label.replace(key, '') || key);
    return {
      ...issue,
      id: String(issue?.id || key),
      key,
      fields: {
        ...(issue?.fields || {}),
        summary,
        project: issue?.fields?.project || {key: key.split('-')[0]},
        issuetype: issue?.fields?.issuetype || {},
        status: issue?.fields?.status || {},
        assignee: issue?.fields?.assignee || null,
      },
    };
  }

  async function searchLinkedIssues({issueKey, query, selectedValues, signal}) {
    if (query.length < 2) return {items: [], strategyUsed: ''};
    const issue = await loadCore(issueKey, signal);
    const projectKey = issueKey.split('-')[0];
    const pickerParams = new URLSearchParams({
      query,
      currentIssueKey: issueKey,
      currentProjectId: String(issue?.fields?.project?.id || ''),
      showSubTasks: 'true',
      showSubTaskParent: 'true',
    });
    let candidates = [];
    let strategyUsed = '';
    for (const version of ['2', '3']) {
      try {
        const response = await jira.read({path: `${instanceUrl}rest/api/${version}/issue/picker?${pickerParams}`, signal});
        const pickerIssues = (response?.sections || []).flatMap(section => section?.issues || []);
        if (pickerIssues.length) {
          candidates = pickerIssues;
          strategyUsed = `picker-v${version}`;
          break;
        }
      } catch (error) {
        // Continue to the next deliberate Jira search adapter.
      }
    }
    if (!candidates.length) {
      const escapedQuery = query.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const clauses = [`summary ~ "${escapedQuery}*"`];
      if (/^[A-Z][A-Z0-9_]*-\d+$/i.test(query)) clauses.push(`key = ${encodeJqlValue(query.toUpperCase())}`);
      const common = `key != ${encodeJqlValue(issueKey)} AND (${clauses.join(' OR ')})`;
      const settled = await Promise.allSettled([
        runIssueSearch(`project = ${encodeJqlValue(projectKey)} AND ${common} ORDER BY updated DESC`, signal),
        runIssueSearch(`project != ${encodeJqlValue(projectKey)} AND ${common} ORDER BY updated DESC`, signal),
      ]);
      const fulfilled = settled.filter(result => result.status === 'fulfilled');
      if (!fulfilled.length) throw settled[0]?.reason || new Error('Issue search failed');
      candidates = fulfilled.flatMap(result => result.value.issues);
      strategyUsed = fulfilled.map(result => result.value.strategyUsed).join(',');
    }
    const excluded = new Set([issueKey, ...(selectedValues || [])].map(value => String(value || '').toUpperCase()));
    const seen = new Set();
    return {
      items: candidates.map(normalizeIssueCandidate).filter(candidate => {
        if (!candidate.key || excluded.has(candidate.key) || seen.has(candidate.key)) return false;
        const searchText = `${candidate.key} ${candidate.fields.summary || ''}`.toLowerCase();
        if (!searchText.includes(query.toLowerCase())) return false;
        seen.add(candidate.key);
        return true;
      }).sort((left, right) => {
        const leftLocal = left.key.split('-')[0] === projectKey;
        const rightLocal = right.key.split('-')[0] === projectKey;
        if (leftLocal !== rightLocal) return leftLocal ? -1 : 1;
        return left.key.localeCompare(right.key, undefined, {numeric: true, sensitivity: 'base'});
      }).slice(0, 20),
      strategyUsed,
    };
  }

  async function search({purpose, issueKey, fieldId, query, projectId, selectedValues, signal}) {
    const normalizedPurpose = String(purpose || '').trim();
    const normalizedIssueKey = String(issueKey || '').trim();
    const normalizedQuery = String(query || '').trim().toLowerCase();
    const selectedKey = (selectedValues || []).map(value => String(value || '')).sort().join(',');
    const key = [normalizedIssueKey, fieldId || '', projectId || '', normalizedQuery, selectedKey].join('::');
    return cache.read({
      family: `search:${normalizedPurpose}`,
      key,
      ttlMs,
      load: () => {
        if (normalizedPurpose === 'assignee') {
          if (!normalizedIssueKey) return {items: [], strategyUsed: ''};
          return searchAssignee({issueKey: normalizedIssueKey, query: normalizedQuery, signal});
        }
        if (['userPicker', 'watcher'].includes(normalizedPurpose)) {
          return searchPeople({query: normalizedQuery, signal});
        }
        if (normalizedPurpose === 'label') {
          return searchLabels({query: normalizedQuery, signal});
        }
        if (normalizedPurpose === 'tempo') {
          return searchTempo({query: normalizedQuery, projectId: String(projectId || ''), signal});
        }
        if (normalizedPurpose === 'parent') {
          return searchParents({issueKey: normalizedIssueKey, fieldId: String(fieldId || ''), query: normalizedQuery, signal});
        }
        if (normalizedPurpose === 'linkedIssue') {
          return searchLinkedIssues({issueKey: normalizedIssueKey, query: normalizedQuery, selectedValues, signal});
        }
        throw new Error(`Unsupported Jira search purpose: ${normalizedPurpose}`);
      },
    });
  }

  function invalidateIssue(issueKey, mutation = {}) {
    const fieldId = String(mutation.fieldId || '').toLowerCase();
    if (mutation.kind === 'issueChanged') {
      ['assignee', 'label', 'linkedIssue', 'parent', 'tempo', 'userPicker', 'watcher']
        .forEach(purpose => cache.invalidateFamily(`search:${purpose}`));
      return;
    }
    if (mutation.kind === 'watchersChanged') cache.invalidateFamily('search:watcher');
    if (mutation.kind === 'linksChanged') cache.invalidateFamily('search:linkedIssue');
    if (mutation.kind === 'quickAction') {
      if (mutation.action === 'assign-to-me') cache.invalidateFamily('search:assignee');
      return;
    }
    if (mutation.kind !== 'fieldChanged') return;
    if (fieldId === 'assignee') cache.invalidateFamily('search:assignee');
    if (fieldId === 'labels') cache.invalidateFamily('search:label');
    if (fieldId === 'parent' || fieldId.includes('epic') || ['issuetype', 'project'].includes(fieldId)) {
      cache.invalidateFamily('search:parent');
    }
  }

  return {invalidateIssue, search};
}
