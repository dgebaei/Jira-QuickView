import {
  buildIssueLinkCreatePayload,
  buildRelationshipOptions,
  createEmptyLinkedIssuesState,
  getLinkedIssueKeys,
  parseLinkedIssueKeys,
} from 'src/content-linked-issues-helpers';

function failureOf(error, fallback) {
  return {message: String(error?.message || error?.inner || error || fallback)};
}

function issueKeyOf(value) {
  return String(value?.key || value?.id || '').trim().toUpperCase();
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

function normalizeCandidate(issue) {
  const key = issueKeyOf(issue);
  const fields = issue?.fields || {};
  const label = stripMarkup(issue?.label || '');
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const labelWithoutKey = label.replace(new RegExp(`^${escapedKey}\\s*[-:–—]?\\s*`, 'i'), '');
  const summary = stripMarkup(fields.summary || issue?.summary || issue?.summaryText || labelWithoutKey || key);
  return {
    assignee: fields.assignee || null,
    id: String(issue?.id || key),
    issueTypeIconUrl: fields.issuetype?.iconUrl || '',
    issueTypeName: fields.issuetype?.name || '',
    key,
    projectKey: String(fields.project?.key || key.split('-')[0]).toUpperCase(),
    statusText: fields.status?.name || '',
    summary,
  };
}

function rankCandidate(candidate, query, projectKey) {
  if (candidate.projectKey === projectKey && candidate.key === query) return 0;
  if (candidate.projectKey === projectKey) return 1;
  if (candidate.key === query) return 2;
  if (candidate.key.startsWith(query)) return 3;
  return 4;
}

function copyView(state) {
  return {
    ...state,
    issueDetailsByKey: {...state.issueDetailsByKey},
    linkTypes: [...state.linkTypes],
    pendingAddKeys: [...state.pendingAddKeys],
    pendingRemoveIds: [...state.pendingRemoveIds],
    searchResults: [...state.searchResults],
    selectedIssues: [...state.selectedIssues],
  };
}

export function createLinkedIssueLifecycle({instanceUrl, issueData, jira}) {
  if (typeof issueData?.openIssue !== 'function') throw new TypeError('Linked issue lifecycle requires issueData.openIssue()');
  if (typeof issueData?.refreshAfterMutation !== 'function') {
    throw new TypeError('Linked issue lifecycle requires issueData.refreshAfterMutation()');
  }
  if (typeof issueData?.search !== 'function') throw new TypeError('Linked issue lifecycle requires issueData.search()');
  if (typeof jira?.write !== 'function') throw new TypeError('Linked issue lifecycle requires jira.write()');

  let revision = 0;
  let snapshot = null;
  let state = {...createEmptyLinkedIssuesState(), issueKey: '', sessionId: ''};

  function view() {
    return copyView(state);
  }

  function isCurrent(expectedRevision, sessionId) {
    return revision === expectedRevision && state.sessionId === sessionId;
  }

  function attach({sessionId, issueSnapshot} = {}) {
    revision += 1;
    snapshot = issueSnapshot || null;
    state = {
      ...createEmptyLinkedIssuesState(),
      issueKey: issueKeyOf(issueSnapshot?.core) || String(issueSnapshot?.issueKey || ''),
      sessionId: String(sessionId || ''),
    };
    return {kind: 'attached', view: view()};
  }

  function detach({sessionId} = {}) {
    if (sessionId && state.sessionId && String(sessionId) !== state.sessionId) {
      return {kind: 'ignored', reason: 'stale-session'};
    }
    revision += 1;
    snapshot = null;
    state = {...createEmptyLinkedIssuesState(), issueKey: '', sessionId: ''};
    return {kind: 'detached'};
  }

  async function open() {
    const expectedRevision = ++revision;
    const sessionId = state.sessionId;
    state = {...state, open: true, loading: true, errorMessage: '', feedbackMessage: '', focusSearch: true};
    const outcome = await issueData.openIssue({issueKey: state.issueKey, requirements: {linkedIssues: true}});
    if (!isCurrent(expectedRevision, sessionId) || !state.open) return {kind: 'ignored', reason: 'superseded'};
    const section = outcome.snapshot?.sections?.linkedIssues;
    if (!['ready', 'empty', 'staleRetained'].includes(section?.status)) {
      const failure = failureOf(section?.failure || outcome.failures?.core, 'Could not load linked issues');
      state = {...state, loading: false, errorMessage: failure.message};
      return {kind: 'failed', failure, view: view()};
    }
    snapshot = outcome.snapshot;
    const relationshipOptions = buildRelationshipOptions(section.linkTypes || []);
    state = {
      ...state,
      loading: false,
      linkTypes: section.linkTypes || [],
      relationshipId: state.relationshipId || relationshipOptions[0]?.id || '',
      issueDetailsByKey: section.detailsByKey || {},
      errorMessage: '',
      focusSearch: true,
    };
    return {kind: 'opened', issueSnapshot: snapshot, view: view()};
  }

  function close() {
    revision += 1;
    state = {
      ...createEmptyLinkedIssuesState(),
      issueKey: state.issueKey,
      sessionId: state.sessionId,
    };
    return {kind: 'closed', view: view()};
  }

  function searchChanged(intent) {
    if (!state.open) return {kind: 'ignored', reason: 'closed'};
    const searchValue = String(intent.value || '');
    const shouldSearch = searchValue.trim().length >= 2;
    const requestId = ++revision;
    state = {
      ...state,
      searchValue,
      searchSelectionStart: Number.isInteger(intent.selectionStart) ? intent.selectionStart : searchValue.length,
      searchSelectionEnd: Number.isInteger(intent.selectionEnd) ? intent.selectionEnd : searchValue.length,
      searchLoading: shouldSearch,
      searchRequestId: requestId,
      searchResults: [],
      errorMessage: '',
      feedbackMessage: '',
      focusSearch: true,
    };
    return {kind: 'changed', requestId, searchAfterMs: shouldSearch ? 180 : 0, view: view()};
  }

  async function runSearch(intent) {
    const requestId = Number(intent.requestId);
    const sessionId = state.sessionId;
    if (!state.open || requestId !== state.searchRequestId) return {kind: 'ignored', reason: 'superseded'};
    const excludedKeys = [
      ...getLinkedIssueKeys(snapshot?.core),
      ...state.selectedIssues.map(issue => issue.key),
    ];
    const outcome = await issueData.search({
      purpose: 'linkedIssue',
      issueKey: state.issueKey,
      query: state.searchValue.trim(),
      selectedValues: excludedKeys,
    });
    if (!isCurrent(requestId, sessionId) || !state.open) return {kind: 'ignored', reason: 'superseded'};
    if (outcome.kind !== 'loaded') {
      const failure = failureOf(outcome.failure, 'Issue search failed');
      state = {...state, searchLoading: false, searchResults: [], errorMessage: failure.message, focusSearch: true};
      return {kind: 'failed', failure, view: view()};
    }
    const currentProjectKey = state.issueKey.split('-')[0];
    const query = state.searchValue.trim().toUpperCase();
    const excluded = new Set([state.issueKey, ...excludedKeys.map(key => String(key).toUpperCase())]);
    const seen = new Set();
    const results = (outcome.items || [])
      .map(normalizeCandidate)
      .filter(candidate => {
        if (!candidate.key || excluded.has(candidate.key) || seen.has(candidate.key)) return false;
        seen.add(candidate.key);
        return `${candidate.key} ${candidate.summary}`.toLowerCase().includes(query.toLowerCase());
      })
      .sort((left, right) => rankCandidate(left, query, currentProjectKey) - rankCandidate(right, query, currentProjectKey) ||
        left.key.localeCompare(right.key, undefined, {numeric: true, sensitivity: 'base'}))
      .slice(0, 20);
    state = {...state, searchLoading: false, searchResults: results, errorMessage: '', focusSearch: true};
    return {kind: 'searched', view: view()};
  }

  function selectKeys(keys) {
    if (!state.open) return {kind: 'ignored', reason: 'closed'};
    const excluded = new Set([
      state.issueKey,
      ...getLinkedIssueKeys(snapshot?.core),
      ...state.selectedIssues.map(issue => issue.key),
    ]);
    const selected = keys.filter(key => !excluded.has(key)).map(key => ({key, summary: key}));
    if (!selected.length) return {kind: 'ignored', reason: 'unavailable'};
    revision += 1;
    state = {
      ...state,
      selectedIssues: [...state.selectedIssues, ...selected],
      searchValue: '',
      searchLoading: false,
      searchRequestId: revision,
      searchResults: [],
      errorMessage: '',
      feedbackMessage: '',
      focusSearch: true,
    };
    return {kind: 'selected', view: view()};
  }

  function selectCandidate(issueKey) {
    const issue = state.searchResults.find(candidate => candidate.key === issueKey);
    if (!issue || state.selectedIssues.some(candidate => candidate.key === issue.key)) {
      return {kind: 'ignored', reason: 'unavailable'};
    }
    revision += 1;
    state = {...state, selectedIssues: [...state.selectedIssues, issue], searchValue: '', searchLoading: false, searchResults: [], errorMessage: '', focusSearch: true};
    return {kind: 'selected', view: view()};
  }

  function commitInput(value, force) {
    const keys = parseLinkedIssueKeys(value);
    const hasDelimiter = /[,;\n]/.test(String(value || ''));
    if (!keys.length || (!force && keys.length < 2 && !hasDelimiter)) return {kind: 'ignored', reason: 'incomplete-input'};
    return selectKeys(keys);
  }

  async function refreshAfterLinksChanged(requirements, changes) {
    const outcome = await issueData.refreshAfterMutation({
      issueKey: state.issueKey,
      priorSnapshot: snapshot,
      mutation: {kind: 'linksChanged'},
      requirements: {...requirements, linkedIssues: true},
    });
    const section = outcome.snapshot?.sections?.linkedIssues;
    if (!outcome.snapshot?.core || !['ready', 'empty', 'staleRetained'].includes(section?.status)) {
      throw new Error(section?.failure?.message || outcome.failures?.core?.message || 'Could not refresh linked issues');
    }
    snapshot = outcome.snapshot;
    state = {
      ...state,
      loading: false,
      issueDetailsByKey: section.detailsByKey || {},
      pendingAddKeys: [],
      pendingRemoveIds: [],
      confirmingRemoveId: '',
      focusSearch: false,
      ...changes,
    };
    return snapshot;
  }

  async function addSelected(requirements) {
    if (!state.open || !state.selectedIssues.length || state.pendingAddKeys.length) {
      return {kind: 'ignored', reason: 'unavailable'};
    }
    const relationship = buildRelationshipOptions(state.linkTypes).find(option => option.id === state.relationshipId);
    if (!relationship) return {kind: 'ignored', reason: 'missing-relationship'};
    const expectedRevision = ++revision;
    const sessionId = state.sessionId;
    const selected = [...state.selectedIssues];
    state = {...state, pendingAddKeys: selected.map(issue => issue.key), errorMessage: '', feedbackMessage: '', focusSearch: false};
    const settled = await Promise.allSettled(selected.map(issue => jira.write({
      method: 'POST',
      path: `${instanceUrl}rest/api/2/issueLink`,
      body: buildIssueLinkCreatePayload(state.issueKey, relationship, issue.key),
    })));
    if (!isCurrent(expectedRevision, sessionId)) return {kind: 'ignored', reason: 'superseded'};
    const succeeded = selected.filter((issue, index) => settled[index].status === 'fulfilled');
    const failed = selected.filter((issue, index) => settled[index].status === 'rejected');
    const firstFailure = settled.find(result => result.status === 'rejected');
    const feedbackMessage = succeeded.length ? `${succeeded.length} linked issue${succeeded.length === 1 ? '' : 's'} added.` : '';
    const errorMessage = failed.length
      ? `Could not link ${failed.map(issue => issue.key).join(', ')}. ${failureOf(firstFailure.reason, 'Link failed').message}`
      : '';
    if (!succeeded.length) {
      state = {...state, pendingAddKeys: [], errorMessage, feedbackMessage: '', focusSearch: true};
      return {kind: 'failed', failure: {message: errorMessage}, view: view()};
    }
    try {
      const issueSnapshot = await refreshAfterLinksChanged(requirements, {selectedIssues: failed, errorMessage, feedbackMessage});
      if (!isCurrent(expectedRevision, sessionId)) return {kind: 'ignored', reason: 'superseded'};
      return {kind: failed.length ? 'partial' : 'added', issueSnapshot, view: view()};
    } catch (error) {
      if (!isCurrent(expectedRevision, sessionId)) return {kind: 'ignored', reason: 'superseded'};
      const failure = failureOf(error, 'Could not refresh linked issues');
      state = {...state, pendingAddKeys: [], errorMessage: failure.message, focusSearch: true};
      return {kind: 'failed', failure, view: view()};
    }
  }

  async function confirmRemove(intent) {
    const linkId = String(intent.linkId || '');
    if (!state.open || state.pendingRemoveIds.includes(linkId)) return {kind: 'ignored', reason: 'unavailable'};
    const link = (snapshot?.core?.fields?.issuelinks || []).find(candidate => String(candidate?.id || '') === linkId);
    if (!link) return {kind: 'ignored', reason: 'missing-link'};
    const linkedKey = issueKeyOf(link.outwardIssue || link.inwardIssue) || 'linked issue';
    const expectedRevision = ++revision;
    const sessionId = state.sessionId;
    state = {...state, pendingRemoveIds: [...state.pendingRemoveIds, linkId], confirmingRemoveId: '', errorMessage: '', feedbackMessage: '', focusSearch: false};
    try {
      await jira.write({method: 'DELETE', path: `${instanceUrl}rest/api/2/issueLink/${encodeURIComponent(linkId)}`});
      if (!isCurrent(expectedRevision, sessionId)) return {kind: 'ignored', reason: 'superseded'};
      const issueSnapshot = await refreshAfterLinksChanged(intent.requirements || {}, {
        feedbackMessage: `Link to ${linkedKey} removed.`,
        errorMessage: '',
      });
      if (!isCurrent(expectedRevision, sessionId)) return {kind: 'ignored', reason: 'superseded'};
      return {kind: 'removed', issueSnapshot, view: view()};
    } catch (error) {
      if (!isCurrent(expectedRevision, sessionId)) return {kind: 'ignored', reason: 'superseded'};
      const failure = failureOf(error, 'Could not remove linked issue');
      state = {...state, pendingRemoveIds: state.pendingRemoveIds.filter(id => id !== linkId), errorMessage: failure.message};
      return {kind: 'failed', failure, view: view()};
    }
  }

  async function dispatch(intent = {}) {
    if (!state.sessionId) return {kind: 'ignored', reason: 'detached'};
    if (intent.type === 'open') return open();
    if (intent.type === 'close') return close();
    if ((state.pendingAddKeys.length || state.pendingRemoveIds.length) && !['addSelected', 'removeConfirmed'].includes(intent.type)) {
      return {kind: 'ignored', reason: 'mutation-pending'};
    }
    if (intent.type === 'relationshipChanged') {
      state = {...state, relationshipId: String(intent.relationshipId || ''), feedbackMessage: '', errorMessage: '', focusSearch: true};
      return {kind: 'changed', view: view()};
    }
    if (intent.type === 'searchChanged') return searchChanged(intent);
    if (intent.type === 'inputChanged') {
      const committed = commitInput(intent.value, false);
      return committed.kind === 'ignored' ? searchChanged(intent) : committed;
    }
    if (intent.type === 'enterPressed') {
      const committed = commitInput(intent.value, true);
      if (committed.kind !== 'ignored') return committed;
      return state.searchResults.length ? selectCandidate(state.searchResults[0].key) : committed;
    }
    if (intent.type === 'runSearch') return runSearch(intent);
    if (intent.type === 'selectCandidate') return selectCandidate(String(intent.issueKey || '').toUpperCase());
    if (intent.type === 'commitInput') return commitInput(intent.value, !!intent.force);
    if (intent.type === 'removeToken') {
      state = {...state, selectedIssues: state.selectedIssues.filter(issue => issue.key !== intent.issueKey), focusSearch: true};
      return {kind: 'changed', view: view()};
    }
    if (intent.type === 'addSelected') return addSelected(intent.requirements || {});
    if (intent.type === 'confirmRemoval') {
      state = {...state, confirmingRemoveId: String(intent.linkId || ''), errorMessage: '', feedbackMessage: '', focusSearch: false};
      return {kind: 'changed', view: view()};
    }
    if (intent.type === 'cancelRemoval') {
      state = {...state, confirmingRemoveId: '', focusSearch: false};
      return {kind: 'changed', view: view()};
    }
    if (intent.type === 'removeConfirmed') return confirmRemove(intent);
    return {kind: 'ignored', reason: 'unknown-intent'};
  }

  return {attach, detach, dispatch, view};
}
