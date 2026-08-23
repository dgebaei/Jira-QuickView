function normalizeFailure(error, fallback) {
  return {message: String(error?.message || error?.inner || error || fallback)};
}

function emptyView(overrides = {}) {
  return {
    addFeedback: null,
    errorMessage: '',
    focusSearch: false,
    issueKey: '',
    loading: false,
    open: false,
    pendingAddIds: [],
    pendingRemoveIds: [],
    removeFeedback: null,
    searchLoading: false,
    searchRequestId: 0,
    searchResults: [],
    searchValue: '',
    sessionId: '',
    watchers: [],
    ...overrides,
  };
}

function watcherIdentifiers(user) {
  const candidates = [
    {type: 'accountId', value: user?.accountId || user?.rawValue?.accountId || ''},
    {type: 'name', value: user?.name || user?.rawValue?.name || ''},
    {type: 'key', value: user?.key || user?.rawValue?.key || ''},
  ];
  return candidates.filter((candidate, index, values) => candidate.value &&
    values.findIndex(other => other.type === candidate.type && other.value === candidate.value) === index);
}

export function createWatcherLifecycle({instanceUrl, issueData, jira, loadViewer, normalizeUsers}) {
  if (typeof issueData?.openIssue !== 'function') throw new TypeError('Watcher lifecycle requires issueData.openIssue()');
  if (typeof issueData?.refreshAfterMutation !== 'function') {
    throw new TypeError('Watcher lifecycle requires issueData.refreshAfterMutation()');
  }
  if (typeof issueData?.search !== 'function') throw new TypeError('Watcher lifecycle requires issueData.search()');
  if (typeof jira?.write !== 'function') throw new TypeError('Watcher lifecycle requires jira.write()');
  if (typeof loadViewer !== 'function') throw new TypeError('Watcher lifecycle requires loadViewer()');
  if (typeof normalizeUsers !== 'function') throw new TypeError('Watcher lifecycle requires normalizeUsers()');

  let revision = 0;
  let snapshot = null;
  let state = emptyView();

  function view() {
    return {
      ...state,
      pendingAddIds: [...state.pendingAddIds],
      pendingRemoveIds: [...state.pendingRemoveIds],
      searchResults: [...state.searchResults],
      watchers: [...state.watchers],
    };
  }

  function isCurrent(expectedRevision, sessionId) {
    return revision === expectedRevision && state.sessionId === sessionId;
  }

  function attach({sessionId, issueSnapshot} = {}) {
    revision += 1;
    snapshot = issueSnapshot || null;
    state = emptyView({
      issueKey: String(issueSnapshot?.issueKey || issueSnapshot?.core?.key || ''),
      sessionId: String(sessionId || ''),
    });
    return {kind: 'attached', view: view()};
  }

  function detach({sessionId} = {}) {
    if (sessionId && state.sessionId && String(sessionId) !== state.sessionId) {
      return {kind: 'ignored', reason: 'stale-session'};
    }
    revision += 1;
    snapshot = null;
    state = emptyView();
    return {kind: 'detached'};
  }

  async function writeWithFallback(method, issueKey, user) {
    let lastError;
    for (const candidate of watcherIdentifiers(user)) {
      const queryKey = candidate.type === 'accountId' ? 'accountId' : (candidate.type === 'key' ? 'key' : 'username');
      const path = method === 'POST'
        ? `${instanceUrl}rest/api/2/issue/${issueKey}/watchers`
        : `${instanceUrl}rest/api/2/issue/${issueKey}/watchers?${queryKey}=${encodeURIComponent(candidate.value)}`;
      try {
        await jira.write({method, path, body: method === 'POST' ? candidate.value : undefined});
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error(`Could not ${method === 'POST' ? 'add' : 'remove'} watcher`);
  }

  async function open() {
    const sessionId = state.sessionId;
    const expectedRevision = ++revision;
    state = {...state, open: true, loading: true, errorMessage: '', focusSearch: true};
    const outcome = await issueData.openIssue({issueKey: state.issueKey, requirements: {watchers: true}});
    if (!isCurrent(expectedRevision, sessionId) || !state.open) return {kind: 'ignored', reason: 'superseded'};
    const section = outcome.snapshot?.sections?.watchers;
    if (!['ready', 'empty', 'staleRetained'].includes(section?.status)) {
      const failure = normalizeFailure(section?.failure || outcome.failures?.core, 'Could not load watchers');
      state = {...state, loading: false, errorMessage: failure.message};
      return {kind: 'failed', failure, view: view()};
    }
    snapshot = outcome.snapshot;
    state = {...state, loading: false, watchers: section.data?.watchers || [], errorMessage: ''};
    return {kind: 'opened', issueSnapshot: snapshot, view: view()};
  }

  function close() {
    revision += 1;
    state = emptyView({issueKey: state.issueKey, sessionId: state.sessionId});
    return {kind: 'closed', view: view()};
  }

  async function search(queryInput) {
    if (!state.open) return {kind: 'ignored', reason: 'closed'};
    const query = String(queryInput || '');
    const sessionId = state.sessionId;
    const expectedRevision = ++revision;
    state = {...state, searchValue: query, searchResults: [], errorMessage: '', focusSearch: true};
    if (!query.trim()) {
      state = {...state, searchLoading: false};
      return {kind: 'changed', view: view()};
    }
    state = {...state, searchLoading: true, searchRequestId: expectedRevision};
    const [outcome, viewer] = await Promise.all([
      issueData.search({purpose: 'watcher', query}),
      loadViewer(state.issueKey).catch(() => null),
    ]);
    if (!isCurrent(expectedRevision, sessionId) || !state.open) return {kind: 'ignored', reason: 'superseded'};
    if (outcome.kind !== 'loaded') {
      const failure = normalizeFailure(outcome.failure, 'Could not search Jira users');
      state = {...state, searchLoading: false, errorMessage: failure.message};
      return {kind: 'failed', failure, view: view()};
    }
    state = {...state, searchLoading: false, searchResults: normalizeUsers(outcome.items, viewer)};
    return {kind: 'searched', view: view()};
  }

  async function mutate(kind, watcherId, requirements) {
    if (!state.open) return {kind: 'ignored', reason: 'closed'};
    const adding = kind === 'add';
    const collection = adding ? state.searchResults : state.watchers;
    const user = collection.find(candidate => candidate.id === watcherId);
    const pendingKey = adding ? 'pendingAddIds' : 'pendingRemoveIds';
    if (!user || state[pendingKey].includes(watcherId)) return {kind: 'ignored', reason: 'unavailable'};
    const sessionId = state.sessionId;
    const expectedRevision = ++revision;
    state = {...state, [pendingKey]: [...state[pendingKey], watcherId], errorMessage: '', [adding ? 'addFeedback' : 'removeFeedback']: null};
    try {
      await writeWithFallback(adding ? 'POST' : 'DELETE', state.issueKey, user);
      if (!isCurrent(expectedRevision, sessionId)) return {kind: 'ignored', reason: 'superseded'};
      const refreshed = await issueData.refreshAfterMutation({
        issueKey: state.issueKey,
        priorSnapshot: snapshot,
        mutation: {kind: 'watchersChanged'},
        requirements: {...requirements, watchers: true},
      });
      if (!isCurrent(expectedRevision, sessionId)) return {kind: 'ignored', reason: 'superseded'};
      const section = refreshed.snapshot?.sections?.watchers;
      if (!refreshed.snapshot?.core || !['ready', 'empty', 'staleRetained'].includes(section?.status)) {
        throw new Error(section?.failure?.message || refreshed.failures?.core?.message || 'Could not refresh watchers');
      }
      snapshot = refreshed.snapshot;
      const feedback = {
        id: watcherId,
        message: `${user.displayName} ${adding ? 'added to' : 'removed from'} watchers`,
        toneClass: adding ? '_JX_watchers_feedback_row_success' : '_JX_watchers_feedback_row_neutral',
      };
      state = {
        ...state,
        [pendingKey]: [],
        watchers: section.data?.watchers || [],
        searchResults: adding ? state.searchResults.filter(candidate => candidate.id !== watcherId) : state.searchResults,
        [adding ? 'addFeedback' : 'removeFeedback']: feedback,
        focusSearch: adding,
      };
      return {kind: adding ? 'added' : 'removed', feedbackExpiresIn: 5000, issueSnapshot: snapshot, view: view()};
    } catch (error) {
      if (!isCurrent(expectedRevision, sessionId)) return {kind: 'ignored', reason: 'superseded'};
      const failure = normalizeFailure(error, `Could not ${adding ? 'add' : 'remove'} watcher`);
      state = {
        ...state,
        [pendingKey]: state[pendingKey].filter(id => id !== watcherId),
        [adding ? 'addFeedback' : 'removeFeedback']: {
          id: watcherId,
          message: failure.message,
          toneClass: '_JX_watchers_feedback_row_error',
        },
        focusSearch: adding,
      };
      return {kind: 'failed', failure, feedbackExpiresIn: 5000, view: view()};
    }
  }

  async function dispatch(intent = {}) {
    if (!state.sessionId) return {kind: 'ignored', reason: 'detached'};
    if (intent.type === 'open') return open();
    if (intent.type === 'close') return close();
    if (intent.type === 'search') return search(intent.query);
    if (intent.type === 'add') return mutate('add', String(intent.watcherId || ''), intent.requirements || {});
    if (intent.type === 'remove') return mutate('remove', String(intent.watcherId || ''), intent.requirements || {});
    if (intent.type === 'clearFeedback') {
      state = {...state, addFeedback: null, removeFeedback: null};
      return {kind: 'changed', view: view()};
    }
    return {kind: 'ignored', reason: 'unknown-intent'};
  }

  return {attach, detach, dispatch, view};
}
