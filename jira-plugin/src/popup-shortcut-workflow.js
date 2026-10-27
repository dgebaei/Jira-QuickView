const REFRESH_WARNING = ' Refresh failed; reopen QuickView to see the saved change.';

// Staged mutations: opening, searching, selecting and cancelling never write to Jira.
// apply() is the exception: a one-key change with a single obvious target.
export function createPopupShortcutWorkflow({instanceUrl, jira, issueData, loadViewer, loadPreset, savePreset, getSession, readSprintsFromIssue = () => []}) {
  let revision = 0;
  let searchRevision = 0;
  let writing = false;
  let state = null;

  function reset() {
    revision += 1;
    searchRevision += 1;
    state = null;
  }

  function transition() {
    return state?.transitions?.find(item => String(item.id) === state.transitionId);
  }

  function view() {
    const selected = transition();
    const fields = selected?.fields || {};
    const unsupported = Object.entries(fields)
      .filter(([id, field]) => field.required && !['resolution', 'comment'].includes(id))
      .map(([id, field]) => field.name || id);
    if (selected?.hasScreen && !selected.fields) unsupported.push('Transition screen metadata');
    return state ? {
      ...state,
      writing,
      resolutions: fields.resolution?.allowedValues || [],
      resolutionRequired: !!fields.resolution?.required,
      hasResolution: !!fields.resolution,
      commentRequired: !!fields.comment?.required,
      unsupported,
    } : null;
  }

  function presetKey(issue) {
    return `${instanceUrl}|${issue.fields?.project?.id || issue.fields?.project?.key || issue.key.split('-')[0]}|${issue.fields?.issuetype?.id || ''}`;
  }

  function userId(user) {
    return String(user?.accountId || user?.name || user?.key || '');
  }

  async function search(query) {
    if (!state || state.phase !== 'editing' || state.kind !== 'plan' || state.alternate || writing) return;
    const expected = revision;
    const request = ++searchRevision;
    state = {...state, query, userId: '', users: [], searching: true, error: ''};
    try {
      const outcome = await issueData.search({purpose: 'assignee', issueKey: state.issueKey, query});
      if (expected !== revision || request !== searchRevision) return;
      if (outcome.kind !== 'loaded') throw new Error(outcome.failure?.message || 'Could not search assignees');
      state = {...state, searching: false, users: outcome.items || []};
    } catch (error) {
      if (expected === revision && request === searchRevision) state = {...state, searching: false, error: error.message};
    }
  }

  // Active sprints first, then future ones in planning order (start date, then creation).
  function plannableSprints(options) {
    const stateOf = item => String(item?.state || '').toLowerCase();
    const order = {active: 0, future: 1};
    const time = item => Date.parse(item?.startDate || '') || Number.MAX_SAFE_INTEGER;
    return [...new Map((options || [])
      .filter(item => item.id && stateOf(item) in order)
      .map(item => [String(item.id), item])).values()]
      .sort((left, right) => (order[stateOf(left)] - order[stateOf(right)]) ||
        (time(left) - time(right)) || (Number(left.id) - Number(right.id)));
  }

  function sprintsInState(sprints, sprintState) {
    return sprints.filter(item => String(item.state).toLowerCase() === sprintState);
  }

  function onIssueBoard(sprints, issue) {
    const issueSprintIds = new Set(readSprintsFromIssue(issue).map(item => String(item.id)));
    const boardIds = new Set(sprints.filter(item => issueSprintIds.has(String(item.id)))
      .flatMap(item => (item.boardRefs || []).map(board => String(board.id))));
    return item => (item.boardRefs || []).some(board => boardIds.has(String(board.id)));
  }

  // The next sprint is the first future sprint on the board of a sprint the issue is
  // already in; other boards of the project are the fallback.
  function nextSprint(sprints, issue) {
    const future = sprintsInState(sprints, 'future');
    return future.find(onIssueBoard(sprints, issue)) || future[0] || null;
  }

  // The current sprint is the active one on the issue's board. Without a board to go
  // by, only a single active sprint is unambiguous.
  function currentSprint(sprints, issue) {
    const active = sprintsInState(sprints, 'active');
    return active.find(onIssueBoard(sprints, issue)) || (active.length === 1 ? active[0] : null);
  }

  async function begin({kind, alternate = false, sessionId, issueSnapshot, sprintTarget = 'current'}) {
    if (writing) return {kind: 'ignored'};
    reset();
    const expected = revision;
    const issue = issueSnapshot?.core;
    if (!issue?.key || !sessionId) return {kind: 'ignored'};
    state = {
      kind, alternate, sprintTarget, sessionId, issueSnapshot, issueKey: issue.key,
      phase: 'loading', error: '', hint: '', sprints: [], sprintId: '',
      users: [], userId: '', query: '', searching: false,
      transitions: [], transitionId: '', resolutionId: '', comment: '',
      remember: false, useDot: false,
    };
    try {
      if (kind === 'plan') {
        const [sprintResult, assigneeResult, viewer] = await Promise.all([
          issueData.loadFieldContext({issueKey: issue.key, fieldId: 'sprint', includeOptions: true}),
          issueData.loadFieldContext({issueKey: issue.key, fieldId: 'assignee'}),
          alternate ? loadViewer(issue.key) : null,
        ]);
        if (expected !== revision) return {kind: 'ignored'};
        const sprint = sprintResult.context;
        if (!sprint?.editable || !sprint.fieldId || !assigneeResult.context?.editable) {
          throw new Error('Jira does not allow editing both sprint and assignee on this issue.');
        }
        const sprints = plannableSprints(sprint.options);
        if (!sprints.length) throw new Error('No active or future sprint is available. Open Jira to plan this issue.');
        if (alternate && !userId(viewer)) throw new Error('Could not identify the current Jira user.');
        const active = sprints.filter(item => String(item.state).toLowerCase() === 'active');
        const preselected = sprintTarget === 'next' ? nextSprint(sprints, issue) : (active.length === 1 ? active[0] : null);
        state = {
          ...state, phase: 'editing', sprints, sprintFieldId: sprint.fieldId,
          sprintId: preselected ? String(preselected.id) : '',
          hint: sprintTarget === 'next' && !preselected ? 'No future sprint is planned; choose a sprint.' : '',
          users: viewer ? [viewer] : [], userId: userId(viewer),
        };
        if (!alternate) await search('');
      } else {
        // Fresh, expanded metadata: cached status options do not include transition-screen fields.
        const [result, preset] = await Promise.all([
          jira.read({path: `${instanceUrl}rest/api/2/issue/${encodeURIComponent(issue.key)}/transitions`, query: {expand: 'transitions.fields'}}),
          alternate ? loadPreset(presetKey(issue)) : null,
        ]);
        if (expected !== revision) return {kind: 'ignored'};
        const transitions = (result.transitions || []).filter(item => item.id && item.to?.statusCategory?.key === 'done');
        if (!transitions.length) throw new Error('No completion transition is available. Open Jira to review this workflow.');
        const preferred = transitions.find(item => String(item.id) === preset?.transitionId);
        const selected = preferred || (transitions.length === 1 ? transitions[0] : null);
        const resolution = selected?.fields?.resolution;
        const validPreset = !!preferred && (!resolution?.required || !!preset.resolutionId) &&
          (!preset.resolutionId || (resolution?.allowedValues || []).some(item => String(item.id) === preset.resolutionId));
        state = {
          ...state, phase: 'editing', transitions, transitionId: selected ? String(selected.id) : '',
          resolutionId: validPreset ? preset.resolutionId : '',
          comment: validPreset && preset.useDot && selected?.fields?.comment?.required ? '.' : '',
          useDot: validPreset && !!preset.useDot,
          hint: alternate && !validPreset
            ? 'Choose and remember quick-close defaults below. No default is guessed.' : '',
        };
      }
    } catch (error) {
      if (expected === revision) state = {...state, phase: 'editing', error: error.message};
    }
    return {kind: expected === revision ? 'opened' : 'ignored'};
  }

  function update(changes) {
    if (!state || writing || state.phase !== 'editing') return;
    const allowed = ['sprintId', 'userId', 'transitionId', 'resolutionId', 'comment', 'remember', 'useDot'];
    const next = Object.fromEntries(Object.entries(changes).filter(([key]) => allowed.includes(key)));
    if (next.transitionId !== undefined && next.transitionId !== state.transitionId) {
      next.resolutionId = '';
      // A required-comment fallback must not leak into another transition.
      if (state.comment === '.' && state.alternate) next.comment = '';
    }
    state = {...state, ...next, error: ''};
  }

  async function submit({sessionId}) {
    if (!state || writing || state.phase !== 'editing' || sessionId !== state.sessionId) return {kind: 'ignored'};
    const expected = revision;
    const captured = state;
    let request;
    try {
      const path = `${instanceUrl}rest/api/2/issue/${encodeURIComponent(state.issueKey)}`;
      if (state.kind === 'plan') {
        const user = state.users.find(item => userId(item) === state.userId);
        if (!state.sprintFieldId || !state.sprints.some(item => String(item.id) === state.sprintId)) throw new Error('Choose a sprint.');
        if (!user) throw new Error('Choose an assignee.');
        const assignee = user.accountId ? {accountId: user.accountId} : user.name ? {name: user.name} : {key: user.key};
        const fields = {assignee};
        if (!readSprintsFromIssue(state.issueSnapshot.core).some(sprint => String(sprint.id) === state.sprintId)) {
          fields[state.sprintFieldId] = Number(state.sprintId);
        }
        request = {method: 'PUT', path, body: {fields}};
      } else {
        const selected = transition();
        const projected = view();
        if (!selected) throw new Error('Choose a transition.');
        if (projected.unsupported.length) throw new Error(`Complete these fields in Jira: ${projected.unsupported.join(', ')}.`);
        const body = {transition: {id: String(selected.id)}};
        if (projected.resolutionRequired && !state.resolutionId) throw new Error('Choose a resolution.');
        if (state.resolutionId) {
          if (!projected.resolutions.some(item => String(item.id) === state.resolutionId)) throw new Error('This resolution is no longer available.');
          body.fields = {resolution: {id: state.resolutionId}};
        }
        if (projected.commentRequired && !state.comment.trim()) throw new Error('A comment is required by this transition.');
        if (state.comment.trim()) body.update = {comment: [{add: {body: state.comment.trim()}}]};
        request = {method: 'POST', path: `${path}/transitions`, body};
      }
      writing = true;
      state = {...state, phase: 'saving', error: ''};
      await jira.write(request);
    } catch (error) {
      writing = false;
      if (expected === revision) state = {...state, phase: 'editing', error: error.message || 'Jira update failed'};
      return {kind: 'failed'};
    }

    // A successful write must never become retryable just because saving a preset or refreshing failed.
    let warning = '';
    if (captured.kind === 'resolve' && captured.remember) {
      try {
        await savePreset(presetKey(captured.issueSnapshot.core), {
          transitionId: captured.transitionId, resolutionId: captured.resolutionId, useDot: captured.useDot,
        });
      } catch (error) { warning = ' Defaults could not be saved.'; }
    }
    const refreshedSnapshot = await refresh(captured.issueKey, captured.issueSnapshot);
    if (!refreshedSnapshot) warning += REFRESH_WARNING;
    writing = false;
    if (expected !== revision) return {kind: 'ignored'};
    const notice = `Saved ${captured.issueKey}.${warning}`;
    state = {...state, phase: 'saved', notice};
    return {kind: 'saved', sessionId: captured.sessionId, refreshedSnapshot, notice};
  }

  async function refresh(issueKey, priorSnapshot) {
    try {
      const result = await issueData.refreshAfterMutation({
        issueKey, priorSnapshot,
        mutation: {kind: 'issueChanged'},
        requirements: {children: true, reactions: true},
      });
      return result.snapshot?.core ? result.snapshot : null;
    } catch (error) { return null; }
  }

  async function editableContext(issueKey, fieldId, readonlyMessage) {
    const outcome = await issueData.loadFieldContext({issueKey, fieldId, includeOptions: true});
    const failure = outcome.failures?.fieldContext || outcome.failures?.options;
    if (failure) throw new Error(failure.message);
    if (!outcome.context?.editable) {
      throw new Error(Object.values(outcome.failures || {})[0]?.message || readonlyMessage);
    }
    return outcome.context;
  }

  async function apply({kind, sessionId, issueSnapshot}) {
    const issue = issueSnapshot?.core;
    if (writing || !issue?.key || !sessionId) return {kind: 'ignored'};
    let body;
    let notice;
    if (kind === 'current-sprint') {
      const context = await editableContext(issue.key, 'sprint', 'Jira does not allow changing the sprint of this issue.');
      const sprints = plannableSprints(context.options);
      if (!context.fieldId || !sprintsInState(sprints, 'active').length) throw new Error('No sprint is active right now.');
      const sprint = currentSprint(sprints, issue);
      if (!sprint) return {kind: 'choose', notice: 'Several sprints are active. Choose one.'};
      if (readSprintsFromIssue(issue).some(item => String(item.id) === String(sprint.id))) {
        return {kind: 'unchanged', notice: `${issue.key} is already in ${sprint.name}`};
      }
      body = {fields: {[context.fieldId]: Number(sprint.id)}};
      notice = `Moved ${issue.key} to ${sprint.name}`;
    } else if (kind === 'next-fix-version') {
      const context = await editableContext(issue.key, 'fixVersions', 'Jira does not allow changing the fix versions of this issue.');
      // Jira lists versions in the project's release order.
      const version = (context.options || []).find(item => item?.id && !item.released && !item.archived);
      if (!version) throw new Error('This project has no unreleased version.');
      if ((issue.fields?.fixVersions || []).some(item => String(item.id) === String(version.id))) {
        return {kind: 'unchanged', notice: `${issue.key} already has fix version ${version.name}`};
      }
      // add, not set: a version someone else added since the popup loaded stays.
      body = {update: {fixVersions: [{add: {id: String(version.id)}}]}};
      notice = `Added fix version ${version.name} to ${issue.key}`;
    } else return {kind: 'ignored'};

    if (writing || (getSession && getSession()?.sessionId !== sessionId)) return {kind: 'ignored'};
    writing = true;
    try {
      await jira.write({method: 'PUT', path: `${instanceUrl}rest/api/2/issue/${encodeURIComponent(issue.key)}`, body});
    } catch (error) {
      writing = false;
      throw error;
    }
    const refreshedSnapshot = await refresh(issue.key, issueSnapshot);
    writing = false;
    return {kind: 'saved', sessionId, refreshedSnapshot, notice: refreshedSnapshot ? notice : `${notice}.${REFRESH_WARNING}`};
  }

  return {apply, begin, reset, search, submit, update, view, busy: () => writing};
}
