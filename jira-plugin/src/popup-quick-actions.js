export function createPopupQuickActions(deps) {
  const {
    INSTANCE_URL,
    formatSprintActionLabel,
    getProjectSprintOptions,
    issueData,
    jira,
    loadFieldContext,
    loadViewer,
    readSprintsFromIssue,
  } = deps;

  if (typeof jira?.write !== 'function') throw new TypeError('Popup quick actions require jira.write()');
  if (typeof issueData?.refreshAfterMutation !== 'function') {
    throw new TypeError('Popup quick actions require issueData.refreshAfterMutation()');
  }

  let requestRevision = 0;
  let state = emptyState();

  function emptyState() {
    return {
      actions: [],
      errorMessage: '',
      issueKey: '',
      issueSnapshot: null,
      loadingKey: '',
      notice: '',
      sessionId: '',
      status: 'detached',
    };
  }

  function buildQuickActionError(error) {
    return error?.message || error?.inner || 'Action failed';
  }

  function areSameJiraUser(left, right) {
    if (!left || !right) {
      return false;
    }
    const leftIds = [left.accountId, left.name, left.username, left.key].filter(Boolean);
    const rightIds = [right.accountId, right.name, right.username, right.key].filter(Boolean);
    return leftIds.some(value => rightIds.includes(value));
  }

  async function getCurrentUserInfo(issueKey = '') {
    return loadViewer(issueKey);
  }

  function buildAssignPayload(user) {
    if (user?.accountId) {
      return {accountId: user.accountId};
    }
    if (user?.name) {
      return {name: user.name};
    }
    if (user?.key) {
      return {key: user.key};
    }
    throw new Error('Could not resolve the current Jira user');
  }

  async function getAvailableTransitions(issueKey) {
    const outcome = await loadFieldContext({issueKey, fieldId: 'status', includeTransitions: true});
    return outcome.context?.transitions || [];
  }

  function isInProgressStatusCategory(statusCategory) {
    const key = String(statusCategory?.key || '').toLowerCase();
    const name = String(statusCategory?.name || '').toLowerCase();
    return key === 'indeterminate' || name.includes('in progress');
  }

  function buildTransitionActionLabel(transition) {
    const transitionName = String(transition?.name || '').trim();
    const targetName = String(transition?.to?.name || '').trim();
    const normalizedTransitionName = transitionName.toLowerCase();

    if (
      normalizedTransitionName.includes('start') ||
      normalizedTransitionName.includes('progress') ||
      normalizedTransitionName.includes('begin') ||
      normalizedTransitionName.includes('resume')
    ) {
      return transitionName || 'Start progress';
    }

    if (targetName) {
      return `Move to ${targetName}`;
    }

    return transitionName || 'Start progress';
  }

  function findStartProgressTransition(transitions) {
    const candidates = Array.isArray(transitions) ? transitions.filter(Boolean) : [];
    return candidates.find(transition => {
      const transitionName = String(transition?.name || '').toLowerCase();
      const targetName = String(transition?.to?.name || '').toLowerCase();
      return isInProgressStatusCategory(transition?.to?.statusCategory) ||
        targetName.includes('in progress') ||
        transitionName.includes('start progress') ||
        transitionName.includes('start work') ||
        transitionName.includes('begin progress') ||
        transitionName.includes('begin work') ||
        transitionName.includes('resume progress');
    }) || null;
  }

  async function resolveQuickActions(issueData) {
    const actionResults = await Promise.allSettled([
      getCurrentUserInfo(issueData.key),
      getAvailableTransitions(issueData.key),
      getProjectSprintOptions(issueData),
      loadFieldContext({issueKey: issueData.key, fieldId: 'sprint'}),
    ]);

    const currentUser = actionResults[0].status === 'fulfilled' ? actionResults[0].value : null;
    const transitions = actionResults[1].status === 'fulfilled' ? actionResults[1].value : [];
    const sprintOptions = actionResults[2].status === 'fulfilled' ? actionResults[2].value : {activeSprints: [], upcomingSprint: null};
    const sprintFieldId = actionResults[3].status === 'fulfilled'
      ? (actionResults[3].value.context?.fieldId || '')
      : '';
    const actions = [];

    if (currentUser && !areSameJiraUser(issueData.fields.assignee, currentUser)) {
      actions.push({
        key: 'assign-to-me',
        label: 'Assign to me',
        successMessage: 'Assigned to you',
        payload: buildAssignPayload(currentUser),
      });
    }

    const startProgressTransition = findStartProgressTransition(transitions);
    if (startProgressTransition) {
      actions.push({
        key: 'start-progress',
        label: buildTransitionActionLabel(startProgressTransition),
        successMessage: `Moved to ${startProgressTransition.to?.name || startProgressTransition.name}`,
        transitionId: startProgressTransition.id,
      });
    }

    const existingSprints = readSprintsFromIssue(issueData)
      .map(sprint => String(sprint.id || ''))
      .filter(Boolean);
    const sprintCandidates = [
      ...(Array.isArray(sprintOptions.activeSprints) ? sprintOptions.activeSprints : []),
      ...(sprintOptions.upcomingSprint ? [sprintOptions.upcomingSprint] : []),
    ].filter(sprint => sprint?.id && !existingSprints.includes(String(sprint.id)));
    const seenSprintIds = new Set();
    sprintCandidates.forEach(sprint => {
      const sprintId = String(sprint.id);
      if (seenSprintIds.has(sprintId) || !sprintFieldId) {
        return;
      }
      seenSprintIds.add(sprintId);
      actions.push({
        key: `move-to-sprint-${sprintId}`,
        kind: 'move-to-sprint',
        label: formatSprintActionLabel(sprint),
        successMessage: `Moved to Sprint ${sprint.name}`,
        sprintId,
        sprintFieldId,
      });
    });

    return actions;
  }

  async function executeQuickAction(action, currentIssueData) {
    if (!action) {
      throw new Error('Action is unavailable');
    }

    if (action.key === 'assign-to-me') {
      await jira.write({method: 'PUT', path: `${INSTANCE_URL}rest/api/2/issue/${currentIssueData.key}/assignee`, body: action.payload});
      return action.successMessage;
    }

    if (action.key === 'start-progress') {
      await jira.write({
        method: 'POST',
        path: `${INSTANCE_URL}rest/api/2/issue/${currentIssueData.key}/transitions`,
        body: {transition: {id: action.transitionId}},
      });
      return action.successMessage;
    }

    if (action.kind === 'move-to-sprint') {
      await jira.write({
        method: 'PUT',
        path: `${INSTANCE_URL}rest/api/2/issue/${currentIssueData.key}`,
        body: {fields: {
          [action.sprintFieldId]: action.sprintId,
        }},
      });
      return action.successMessage;
    }

    throw new Error('Unknown action');
  }

  function view() {
    const sourceActions = state.actions;
    const firstSprintActionIndex = sourceActions.findIndex(action => action?.kind === 'move-to-sprint');
    const actions = sourceActions.map((action, index) => ({
      ...action,
      showDividerBefore: firstSprintActionIndex > 0 && index === firstSprintActionIndex,
      disabled: !!state.loadingKey && state.loadingKey !== action.key,
      disabledAttr: state.loadingKey && state.loadingKey !== action.key ? 'disabled' : '',
      isLoading: state.loadingKey === action.key,
      labelText: state.loadingKey === action.key ? `${action.label}...` : action.label,
    }));
    return {
      actions,
      errorMessage: state.errorMessage,
      hasQuickActions: actions.length > 0,
      issueKey: state.issueKey,
      loadingKey: state.loadingKey,
      notice: state.notice,
      sessionId: state.sessionId,
      status: state.status,
    };
  }

  async function resolveForCurrentSnapshot(expectedRevision) {
    const issue = state.issueSnapshot?.core;
    if (!issue) return {kind: 'ignored', reason: 'missing-issue'};
    try {
      const actions = await resolveQuickActions(issue);
      if (expectedRevision !== requestRevision) return {kind: 'ignored', reason: 'superseded'};
      state = {...state, actions, errorMessage: '', status: 'ready'};
      return {kind: 'resolved', view: view()};
    } catch (error) {
      if (expectedRevision !== requestRevision) return {kind: 'ignored', reason: 'superseded'};
      state = {...state, actions: [], errorMessage: '', status: 'ready'};
      return {kind: 'resolved', view: view()};
    }
  }

  async function attach({sessionId, issueSnapshot} = {}) {
    const issueKey = String(issueSnapshot?.issueKey || issueSnapshot?.core?.key || '').trim();
    const revision = ++requestRevision;
    state = {
      ...emptyState(),
      issueKey,
      issueSnapshot,
      sessionId: String(sessionId || ''),
      status: 'resolving',
    };
    return resolveForCurrentSnapshot(revision);
  }

  function detach({sessionId} = {}) {
    if (sessionId && state.sessionId && String(sessionId) !== state.sessionId) {
      return {kind: 'ignored', reason: 'stale-session'};
    }
    requestRevision += 1;
    state = emptyState();
    return {kind: 'detached'};
  }

  async function dispatch(intent = {}) {
    if (!state.sessionId || !state.issueSnapshot?.core) return {kind: 'ignored', reason: 'detached'};
    if (intent.type === 'clearNotice') {
      if (!state.notice || (intent.notice && intent.notice !== state.notice)) {
        return {kind: 'ignored', reason: 'notice-unchanged'};
      }
      state = {...state, notice: ''};
      return {kind: 'changed', view: view()};
    }
    if (intent.type === 'snapshotChanged') {
      const issueKey = String(intent.issueSnapshot?.issueKey || intent.issueSnapshot?.core?.key || '').trim();
      if (!intent.issueSnapshot?.core || issueKey !== state.issueKey) {
        return {kind: 'ignored', reason: 'stale-issue-snapshot'};
      }
      if (state.loadingKey) return {kind: 'ignored', reason: 'mutation-pending'};
      if (intent.issueSnapshot === state.issueSnapshot) {
        return {kind: 'unchanged', view: view()};
      }
      const revision = ++requestRevision;
      state = {...state, issueSnapshot: intent.issueSnapshot, status: 'resolving'};
      return resolveForCurrentSnapshot(revision);
    }
    if (intent.type !== 'execute') return {kind: 'ignored', reason: 'unknown-intent'};
    if (state.loadingKey) return {kind: 'ignored', reason: 'busy'};
    const action = state.actions.find(candidate => candidate.key === intent.actionKey);
    if (!action) return {kind: 'ignored', reason: 'unavailable'};

    const sessionId = state.sessionId;
    const issueKey = state.issueKey;
    const revision = ++requestRevision;
    state = {...state, loadingKey: action.key, errorMessage: '', notice: '', status: 'executing'};
    try {
      await executeQuickAction(action, state.issueSnapshot.core);
      if (revision !== requestRevision || state.sessionId !== sessionId) {
        return {kind: 'ignored', reason: 'superseded'};
      }
      const refreshed = await issueData.refreshAfterMutation({
        issueKey,
        priorSnapshot: state.issueSnapshot,
        mutation: {kind: 'quickAction', action: action.key},
        requirements: intent.requirements || {},
      });
      if (revision !== requestRevision || state.sessionId !== sessionId) {
        return {kind: 'ignored', reason: 'superseded'};
      }
      if (!refreshed?.snapshot?.core) {
        throw new Error(refreshed?.failures?.core?.message || 'Could not refresh issue');
      }
      state = {
        ...state,
        issueSnapshot: refreshed.snapshot,
        loadingKey: '',
        notice: action.successMessage,
        status: 'resolving',
      };
      await resolveForCurrentSnapshot(revision);
      if (revision !== requestRevision || state.sessionId !== sessionId) {
        return {kind: 'ignored', reason: 'superseded'};
      }
      state = {...state, notice: action.successMessage};
      return {
        kind: 'executed',
        actionKey: action.key,
        notice: action.successMessage,
        refreshedSnapshot: refreshed.snapshot,
        sessionId,
        view: view(),
      };
    } catch (error) {
      if (revision !== requestRevision || state.sessionId !== sessionId) {
        return {kind: 'ignored', reason: 'superseded'};
      }
      const failure = {message: buildQuickActionError(error)};
      state = {...state, errorMessage: failure.message, loadingKey: '', status: 'ready'};
      return {kind: 'failed', actionKey: action.key, failure, sessionId, view: view()};
    }
  }

  return {
    attach,
    detach,
    dispatch,
    view,
  };
}
