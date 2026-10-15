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

export const REMOTE_LINK_ID_PREFIX = 'remote:';

export function remoteLinkRowId(remoteLink) {
  const id = String(remoteLink?.id || '').trim();
  return id ? `${REMOTE_LINK_ID_PREFIX}${id}` : '';
}

export function remoteLinkIdFromRowId(rowId) {
  const value = String(rowId || '');
  return value.startsWith(REMOTE_LINK_ID_PREFIX) ? value.slice(REMOTE_LINK_ID_PREFIX.length) : '';
}

function compareLabels(left, right) {
  return left.label.localeCompare(right.label, undefined, {sensitivity: 'base'});
}

function groupRows(rows) {
  const groupsByKey = new Map();
  rows.forEach(row => {
    if (!groupsByKey.has(row.groupKey)) {
      groupsByKey.set(row.groupKey, {key: row.groupKey, label: row.relationLabel, rows: []});
    }
    groupsByKey.get(row.groupKey).rows.push(row);
  });
  return [...groupsByKey.values()]
    .map(group => ({...group, count: group.rows.length, hasLabel: true}))
    .sort(compareLabels);
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch (error) {
    return '';
  }
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
  const currentIssueKey = issueKeyOf(issueData);
  const relationshipOptions = buildRelationshipOptions(linkedState.linkTypes);
  const selectedRelationshipId = linkedState.relationshipId || relationshipOptions[0]?.id || '';
  const pendingRemoveIds = new Set(linkedState.pendingRemoveIds || []);

  function removalState(rowId) {
    return {
      isPendingRemove: pendingRemoveIds.has(rowId),
      isConfirmingRemove: linkedState.confirmingRemoveId === rowId,
      removeDisabledAttr: pendingRemoveIds.has(rowId) ? 'disabled' : '',
    };
  }

  function issueRow(issue, embeddedFields = {}) {
    const key = issueKeyOf(issue);
    const detailedIssue = linkedState.issueDetailsByKey?.[key] || issue;
    const fields = {...embeddedFields, ...(issue?.fields || {}), ...(detailedIssue?.fields || {})};
    const summary = String(fields.summary || key).trim();
    const userView = buildUserView(fields.assignee);
    const issueUrl = `${instanceUrl}browse/${key}`;
    return {
      isIssue: true,
      isRemote: false,
      key,
      summary,
      issueUrl,
      issueLinkTitle: buildLinkHoverTitle('Open issue in Jira', `[${key}] ${summary}`, issueUrl),
      issueTypeIconUrl: fields.issuetype?.iconUrl || '',
      issueTypeTitle: `Issue type: ${fields.issuetype?.name || 'Unknown'}`,
      statusText: fields.status?.name || 'Unknown',
      assigneeAvatarUrl: userView.avatarUrl || '',
      assigneeInitials: userView.displayName ? userView.initials : '--',
      assigneeTitle: `Assignee: ${userView.displayName || 'Unassigned'}`,
    };
  }

  const rawChildren = Array.isArray(options?.children) && options.children.length
    ? options.children
    : (Array.isArray(issueData?.fields?.subtasks) ? issueData.fields.subtasks : []);
  const seenChildKeys = new Set();
  const childRows = rawChildren
    .map(child => ({
      ...issueRow(child),
      id: `child:${issueKeyOf(child)}`,
      canRemove: false,
      isPendingRemove: false,
      isConfirmingRemove: false,
      removeDisabledAttr: '',
    }))
    .filter(row => {
      if (!row.key || seenChildKeys.has(row.key)) return false;
      seenChildKeys.add(row.key);
      return true;
    });

  const rawLinks = Array.isArray(issueData?.fields?.issuelinks) ? issueData.fields.issuelinks : [];
  const linkRows = rawLinks.map(link => {
    const direction = link?.outwardIssue ? 'outward' : 'inward';
    const embeddedIssue = link?.outwardIssue || link?.inwardIssue || {};
    const row = issueRow(embeddedIssue, embeddedIssue?.fields || {});
    const relationLabel = String(link?.type?.[direction] || link?.type?.name || 'relates to').trim();
    const linkId = String(link?.id || `${relationLabel}:${row.key}`);
    return {
      ...row,
      id: linkId,
      relationLabel,
      groupKey: `${link?.type?.id || link?.type?.name || relationLabel}:${relationLabel.toLowerCase()}`,
      canRemove: true,
      removeTitle: `Remove link to ${row.key}`,
      confirmTarget: row.key,
      ...removalState(linkId),
    };
  }).filter(link => link.key);

  const rawRemoteLinks = Array.isArray(options?.remoteLinks) ? options.remoteLinks : [];
  const remoteRows = rawRemoteLinks.map(remoteLink => {
    const rowId = remoteLinkRowId(remoteLink);
    const object = remoteLink?.object || {};
    const url = String(object.url || '').trim();
    const title = String(object.title || url).trim();
    const relationLabel = String(remoteLink?.relationship || 'links to').trim();
    const sourceText = String(remoteLink?.application?.name || hostnameOf(url)).trim();
    return {
      isIssue: false,
      isRemote: true,
      id: rowId,
      key: '',
      title,
      url,
      linkTitle: buildLinkHoverTitle('Open link', title, url),
      iconUrl: object.icon?.url16x16 || '',
      iconTitle: object.icon?.title || sourceText || 'External link',
      sourceText,
      isResolved: object.status?.resolved === true,
      relationLabel,
      groupKey: `remote:${relationLabel.toLowerCase()}`,
      canRemove: true,
      removeTitle: `Remove link ${title}`,
      confirmTarget: title,
      ...removalState(rowId),
    };
  }).filter(row => row.id && row.url);

  const encodedKey = JSON.stringify(currentIssueKey);
  const childrenJql = String(options?.childrenJql || '').trim();
  const sections = [
    {
      key: 'children',
      title: 'Children',
      count: childRows.length,
      viewAllUrl: childrenJql ? `${instanceUrl}issues/?jql=${encodeURIComponent(childrenJql)}` : '',
      viewAllTitle: childrenJql ? `Open child issues in Jira: ${childrenJql}` : '',
      groups: childRows.length ? [{key: 'children', label: 'Children', hasLabel: false, count: childRows.length, rows: childRows}] : [],
    },
    {
      key: 'linked',
      title: 'Linked issues',
      count: linkRows.length,
      viewAllUrl: currentIssueKey ? `${instanceUrl}issues/?jql=${encodeURIComponent(`issue in linkedIssues(${encodedKey})`)}` : '',
      viewAllTitle: currentIssueKey ? `Open linked issues in Jira: issue in linkedIssues(${encodedKey})` : '',
      groups: groupRows(linkRows),
    },
    {
      key: 'external',
      title: 'External links',
      count: remoteRows.length,
      viewAllUrl: '',
      viewAllTitle: '',
      groups: groupRows(remoteRows),
    },
  ].filter(section => section.count > 0);
  const count = childRows.length + linkRows.length + remoteRows.length;
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
    loadingText: linkedState.loading ? 'Loading links...' : '',
    errorMessage: linkedState.errorMessage || '',
    feedbackMessage: linkedState.feedbackMessage || '',
    count,
    sections,
    hasSections: sections.length > 0,
    emptyText: linkedState.loading ? '' : 'No children, linked issues, or external links yet.',
    viewInJiraUrl: currentIssueKey ? `${instanceUrl}browse/${currentIssueKey}#linkingmodule` : '',
    viewInJiraTitle: currentIssueKey ? `Open ${currentIssueKey} links in Jira` : '',
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
