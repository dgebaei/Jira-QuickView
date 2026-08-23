export function createPopupQuickActions(deps) {
  const {
    INSTANCE_URL,
    formatSprintActionLabel,
    getProjectSprintOptions,
    loadFieldContext,
    loadViewer,
    readSprintsFromIssue,
    requestJson,
  } = deps;

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

  async function executeQuickAction(action, issueData) {
    if (!action) {
      throw new Error('Action is unavailable');
    }

    if (action.key === 'assign-to-me') {
      await requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}/assignee`, action.payload);
      return action.successMessage;
    }

    if (action.key === 'start-progress') {
      await requestJson('POST', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}/transitions`, {
        transition: {id: action.transitionId},
      });
      return action.successMessage;
    }

    if (action.kind === 'move-to-sprint') {
      await requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
        fields: {
          [action.sprintFieldId]: action.sprintId,
        },
      });
      return action.successMessage;
    }

    throw new Error('Unknown action');
  }

  function buildQuickActionViewData(actionsOpen, actionLoadingKey, quickActions) {
    const sourceActions = Array.isArray(quickActions) ? quickActions : [];
    const firstSprintActionIndex = sourceActions.findIndex(action => action?.kind === 'move-to-sprint');
    const actions = sourceActions.map((action, index) => ({
      ...action,
      showDividerBefore: firstSprintActionIndex > 0 && index === firstSprintActionIndex,
      disabled: actionLoadingKey && actionLoadingKey !== action.key,
      disabledAttr: actionLoadingKey && actionLoadingKey !== action.key ? 'disabled' : '',
      isLoading: actionLoadingKey === action.key,
      labelText: actionLoadingKey === action.key ? `${action.label}...` : action.label,
    }));
    return {
      hasQuickActions: actions.length > 0,
      actionsOpen: actionsOpen && actions.length > 0,
      quickActions: actions,
    };
  }

  return {
    buildQuickActionError,
    buildQuickActionViewData,
    executeQuickAction,
    getCurrentUserInfo,
    resolveQuickActions,
  };
}
