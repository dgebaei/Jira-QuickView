function uniqueBy(values, getKey) {
  const seen = new Set();
  return (values || []).filter(value => {
    const key = getKey(value);
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

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

function issueProjectKey(issue) {
  return String(issue?.fields?.project?.key || issue?.key || '').split('-')[0].toUpperCase();
}

function issueKeyOf(value) {
  return String(value?.key || value?.id || '').trim().toUpperCase();
}

export function parseLinkedIssueKeys(value) {
  const matches = String(value || '').toUpperCase().match(/\b[A-Z][A-Z0-9_]*-\d+\b/g) || [];
  return [...new Set(matches)];
}

function normalizePickerIssue(issue) {
  const key = issueKeyOf(issue);
  const label = stripMarkup(issue?.label || '');
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const labelWithoutKey = label.replace(new RegExp(`^${escapedKey}\\s*[-:–—]?\\s*`, 'i'), '');
  const summary = stripMarkup(issue?.summaryText || issue?.summary || issue?.fields?.summary || labelWithoutKey || key);
  return {
    id: String(issue?.id || key),
    key,
    fields: {
      summary,
      project: {key: key.split('-')[0]},
      issuetype: issue?.fields?.issuetype || {},
      status: issue?.fields?.status || {},
      assignee: issue?.fields?.assignee || null,
    },
  };
}

function normalizeIssueCandidate(issue) {
  const key = issueKeyOf(issue);
  const fields = issue?.fields || {};
  return {
    id: String(issue?.id || key),
    key,
    summary: String(fields.summary || issue?.summary || key).trim(),
    projectKey: issueProjectKey(issue),
    issueTypeIconUrl: fields.issuetype?.iconUrl || '',
    issueTypeName: fields.issuetype?.name || '',
    statusText: fields.status?.name || '',
    assignee: fields.assignee || null,
  };
}

function rankCandidate(candidate, normalizedQuery, currentProjectKey) {
  if (candidate.projectKey === currentProjectKey && candidate.key === normalizedQuery) {
    return 0;
  }
  if (candidate.projectKey === currentProjectKey) {
    return 1;
  }
  if (candidate.key === normalizedQuery) {
    return 2;
  }
  if (candidate.key.startsWith(normalizedQuery)) {
    return 3;
  }
  return 4;
}

function buildSearchText(candidate) {
  return `${candidate.key} ${candidate.summary}`.toLowerCase();
}

export function createEmptyLinkedIssuesState() {
  return {
    open: false,
    loading: false,
    errorMessage: '',
    feedbackMessage: '',
    linkTypes: [],
    relationshipId: '',
    issueDetailsByKey: {},
    searchValue: '',
    searchSelectionStart: 0,
    searchSelectionEnd: 0,
    searchLoading: false,
    searchRequestId: 0,
    searchResults: [],
    selectedIssues: [],
    pendingAddKeys: [],
    pendingRemoveIds: [],
    confirmingRemoveId: '',
    focusSearch: false,
  };
}

export function buildRelationshipOptions(linkTypes) {
  return (Array.isArray(linkTypes) ? linkTypes : []).flatMap(type => {
    const typeId = String(type?.id || type?.name || '').trim();
    const typeName = String(type?.name || '').trim();
    const outward = String(type?.outward || typeName || '').trim();
    const inward = String(type?.inward || typeName || '').trim();
    if (!typeId || !typeName || !outward) {
      return [];
    }
    const options = [{
      id: `${typeId}:outward`,
      typeId,
      typeName,
      direction: 'outward',
      label: outward,
    }];
    if (inward && inward.toLowerCase() !== outward.toLowerCase()) {
      options.push({
        id: `${typeId}:inward`,
        typeId,
        typeName,
        direction: 'inward',
        label: inward,
      });
    }
    return options;
  }).sort((left, right) => left.label.localeCompare(right.label, undefined, {sensitivity: 'base'}));
}

export function buildIssueLinkCreatePayload(currentIssueKey, relationship, targetIssueKey) {
  if (!currentIssueKey || !targetIssueKey || !relationship?.typeName) {
    return null;
  }
  const currentIssue = {key: currentIssueKey};
  const targetIssue = {key: targetIssueKey};
  return {
    type: {name: relationship.typeName},
    outwardIssue: relationship.direction === 'inward' ? targetIssue : currentIssue,
    inwardIssue: relationship.direction === 'inward' ? currentIssue : targetIssue,
  };
}

export function getLinkedIssueKeys(issueData) {
  return (Array.isArray(issueData?.fields?.issuelinks) ? issueData.fields.issuelinks : [])
    .map(link => issueKeyOf(link?.outwardIssue || link?.inwardIssue))
    .filter(Boolean);
}

export function buildLinkedIssuesPanelView(state, issueData, options = {}) {
  const linkedState = state?.linkedIssuesState || createEmptyLinkedIssuesState();
  const buildUserView = options?.buildUserView || (user => ({
    avatarUrl: user?.avatarUrls?.['48x48'] || '',
    displayName: user?.displayName || '',
    initials: '',
  }));
  const buildLinkHoverTitle = options?.buildLinkHoverTitle || ((prefix, label) => `${prefix}: ${label}`);
  const instanceUrl = options?.instanceUrl || '';
  const relationshipOptions = buildRelationshipOptions(linkedState.linkTypes);
  const selectedRelationshipId = linkedState.relationshipId || relationshipOptions[0]?.id || '';
  const pendingRemoveIds = new Set(linkedState.pendingRemoveIds || []);
  const rawLinks = Array.isArray(issueData?.fields?.issuelinks) ? issueData.fields.issuelinks : [];
  const normalizedLinks = rawLinks.map(link => {
    const direction = link?.outwardIssue ? 'outward' : 'inward';
    const embeddedIssue = link?.outwardIssue || link?.inwardIssue || {};
    const key = issueKeyOf(embeddedIssue);
    const detailedIssue = linkedState.issueDetailsByKey?.[key] || embeddedIssue;
    const fields = {...(embeddedIssue?.fields || {}), ...(detailedIssue?.fields || {})};
    const summary = String(fields.summary || key).trim();
    const relationLabel = String(link?.type?.[direction] || link?.type?.name || 'relates to').trim();
    const userView = buildUserView(fields.assignee);
    const issueUrl = `${instanceUrl}browse/${key}`;
    const linkId = String(link?.id || `${relationLabel}:${key}`);
    return {
      id: linkId,
      key,
      summary,
      relationLabel,
      groupKey: `${link?.type?.id || link?.type?.name || relationLabel}:${relationLabel.toLowerCase()}`,
      issueUrl,
      issueLinkTitle: buildLinkHoverTitle('Open issue in Jira', `[${key}] ${summary}`, issueUrl),
      issueTypeIconUrl: fields.issuetype?.iconUrl || '',
      issueTypeTitle: `Issue type: ${fields.issuetype?.name || 'Unknown'}`,
      statusText: fields.status?.name || 'Unknown',
      assigneeAvatarUrl: userView.avatarUrl || '',
      assigneeInitials: userView.displayName ? userView.initials : '--',
      assigneeTitle: `Assignee: ${userView.displayName || 'Unassigned'}`,
      isPendingRemove: pendingRemoveIds.has(linkId),
      isConfirmingRemove: linkedState.confirmingRemoveId === linkId,
      removeDisabledAttr: pendingRemoveIds.has(linkId) ? 'disabled' : '',
    };
  }).filter(link => link.key);

  const groupsByKey = new Map();
  normalizedLinks.forEach(link => {
    if (!groupsByKey.has(link.groupKey)) {
      groupsByKey.set(link.groupKey, {key: link.groupKey, label: link.relationLabel, rows: []});
    }
    groupsByKey.get(link.groupKey).rows.push(link);
  });
  const groups = [...groupsByKey.values()]
    .map(group => ({...group, count: group.rows.length}))
    .sort((left, right) => left.label.localeCompare(right.label, undefined, {sensitivity: 'base'}));
  const selectedKeys = new Set((linkedState.selectedIssues || []).map(issue => issue.key));
  const searchResults = (linkedState.searchResults || [])
    .filter(result => !selectedKeys.has(result.key))
    .map(result => ({
      ...result,
      optionLabel: `[${result.key}] ${result.summary}`,
    }));
  const pendingAddKeys = new Set(linkedState.pendingAddKeys || []);
  const selectedIssues = (linkedState.selectedIssues || []).map(issue => ({
    ...issue,
    title: `[${issue.key}] ${issue.summary}`,
    removeDisabledAttr: pendingAddKeys.has(issue.key) ? 'disabled' : '',
  }));

  return {
    isOpen: !!linkedState.open,
    isLoading: !!linkedState.loading,
    loadingText: linkedState.loading ? 'Loading linked issues...' : '',
    errorMessage: linkedState.errorMessage || '',
    feedbackMessage: linkedState.feedbackMessage || '',
    count: normalizedLinks.length,
    groups,
    hasGroups: groups.length > 0,
    emptyText: linkedState.loading ? '' : 'No linked issues yet.',
    relationshipOptions: relationshipOptions.map(option => ({
      ...option,
      selectedAttr: option.id === selectedRelationshipId ? 'selected' : '',
    })),
    hasRelationshipOptions: relationshipOptions.length > 0,
    searchValue: linkedState.searchValue || '',
    searchLoading: !!linkedState.searchLoading,
    searchResults,
    hasSearchResults: searchResults.length > 0,
    showSearchEmpty: !!(linkedState.searchValue && !linkedState.searchLoading && searchResults.length === 0),
    selectedIssues,
    hasSelectedIssues: selectedIssues.length > 0,
    addDisabledAttr: !selectedIssues.length || pendingAddKeys.size ? 'disabled' : '',
    addButtonText: pendingAddKeys.size ? 'Linking...' : 'Link',
  };
}

export function createContentLinkedIssuesHelpers(options) {
  const issueDataModule = options?.issueData;

  async function loadLinkedSection(issueKey) {
    const outcome = await issueDataModule.openIssue({issueKey, requirements: {linkedIssues: true}});
    const section = outcome.snapshot?.sections?.linkedIssues;
    if (!section || section.status === 'failed') {
      throw new Error(section?.failure?.message || outcome.failures?.core?.message || 'Could not load linked issues');
    }
    return section;
  }

  async function getIssueLinkTypes(issueKey) {
    return (await loadLinkedSection(issueKey)).linkTypes || [];
  }

  async function searchIssueLinkCandidates(query, issueData, excludedKeys = []) {
    const normalizedQuery = String(query || '').trim();
    if (normalizedQuery.length < 2) {
      return [];
    }
    const currentKey = issueKeyOf(issueData);
    const currentProjectKey = currentKey.split('-')[0];
    const outcome = await issueDataModule.search({
      purpose: 'linkedIssue',
      issueKey: currentKey,
      query: normalizedQuery,
      selectedValues: excludedKeys,
    });
    if (outcome.kind !== 'loaded') {
      throw new Error(outcome.failure?.message || 'Issue search failed');
    }
    const issues = outcome.items;
    const excluded = new Set([currentKey, ...(excludedKeys || []).map(value => String(value || '').toUpperCase())]);
    const loweredQuery = normalizedQuery.toLowerCase();
    return uniqueBy(issues, issueKeyOf)
      .map(normalizeIssueCandidate)
      .filter(candidate => candidate.key && !excluded.has(candidate.key) && buildSearchText(candidate).includes(loweredQuery))
      .sort((left, right) => {
        const rankDelta = rankCandidate(left, normalizedQuery.toUpperCase(), currentProjectKey) - rankCandidate(right, normalizedQuery.toUpperCase(), currentProjectKey);
        if (rankDelta !== 0) {
          return rankDelta;
        }
        return left.key.localeCompare(right.key, undefined, {numeric: true, sensitivity: 'base'});
      })
      .slice(0, 20);
  }

  async function getLinkedIssueDetails(issueData) {
    return (await loadLinkedSection(issueKeyOf(issueData))).detailsByKey || {};
  }

  return {
    getIssueLinkTypes,
    getLinkedIssueDetails,
    searchIssueLinkCandidates,
  };
}
