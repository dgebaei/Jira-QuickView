function issueKeyOf(value) {
  return String(value?.key || value?.id || '').trim().toUpperCase();
}

export function parseLinkedIssueKeys(value) {
  const matches = String(value || '').toUpperCase().match(/\b[A-Z][A-Z0-9_]*-\d+\b/g) || [];
  return [...new Set(matches)];
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
  const linkedState = state?.linkedIssueView || createEmptyLinkedIssuesState();
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
