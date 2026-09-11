function requireOperation(operation, name) {
  if (typeof operation !== 'function') throw new TypeError(`Browser popup model requires ${name}()`);
}

function projectIssueSnapshot(snapshot) {
  const children = snapshot?.sections?.children;
  const pullRequests = snapshot?.sections?.pullRequests;
  const reactions = snapshot?.sections?.reactions;
  return {
    issueSnapshot: snapshot,
    issueData: snapshot?.core || null,
    children: Array.isArray(children?.items) ? children.items : [],
    childrenJql: children?.jql || '',
    childrenError: children?.status === 'failed' ? (children.failure?.message || 'Could not load child issues') : '',
    pullRequests: Array.isArray(pullRequests?.items) ? pullRequests.items : [],
    commentReactionState: {
      byCommentId: reactions?.byCommentId || {},
      supported: reactions?.supported !== false,
    },
  };
}

export function createBrowserPopupModel({createDescriptionState, createTimeTrackingState, renderProjection}) {
  requireOperation(createDescriptionState, 'createDescriptionState');
  requireOperation(createTimeTrackingState, 'createTimeTrackingState');
  requireOperation(renderProjection, 'renderProjection');

  let state = null;

  function view() {
    return state;
  }

  function applyFrame(frame, {opening = false} = {}) {
    const snapshotView = projectIssueSnapshot(frame.issueSnapshot);
    const issueData = snapshotView.issueData;
    const presentation = frame.presentation || {};
    const activePanel = presentation.activePanel || '';
    if (opening || !state || state.key !== frame.issueKey) {
      state = {
        key: frame.issueKey,
        issueSnapshot: snapshotView.issueSnapshot,
        issueData,
        children: snapshotView.children,
        childrenJql: snapshotView.childrenJql,
        childrenError: snapshotView.childrenError,
        pullRequests: snapshotView.pullRequests,
        pointerX: Number(frame.anchor?.x) || 0,
        pointerY: Number(frame.anchor?.y) || 0,
        commentReactionState: snapshotView.commentReactionState,
        descriptionEditState: createDescriptionState(issueData),
        timeTrackingEditState: createTimeTrackingState(issueData),
      };
    } else if (frame.issueSnapshot?.core && frame.issueSnapshot !== state.issueSnapshot) {
      state = {
        ...state,
        issueSnapshot: snapshotView.issueSnapshot,
        issueData,
        children: snapshotView.children,
        childrenJql: snapshotView.childrenJql,
        childrenError: snapshotView.childrenError,
        pullRequests: snapshotView.pullRequests,
        commentReactionState: snapshotView.commentReactionState,
      };
    }
    state = {
      ...state,
      ...presentation,
      historyOpen: activePanel === 'history',
      quickActionView: frame.quickActions || {},
      watcherView: frame.watchers || {},
      historyView: frame.history || {},
      linkedIssueView: frame.linkedIssues || {},
      lastActionSuccess: frame.notice || '',
    };
    return state;
  }

  async function commit(frame, context, options = {}) {
    if (typeof context?.isCurrent === 'function' && !context.isCurrent()) return {kind: 'stale'};
    if (!options.opening && (!state || state.key !== frame.issueKey)) return {kind: 'ignored'};
    const projection = applyFrame(frame, options);
    await renderProjection(projection, context);
    return typeof context?.isCurrent === 'function' && !context.isCurrent()
      ? {kind: 'stale'}
      : {kind: 'committed'};
  }

  function dispatch(intent = {}) {
    if (!state) return {kind: 'ignored', reason: 'closed'};
    if (intent.type === 'descriptionChanged') {
      state = {...state, descriptionEditState: intent.state};
      return {kind: 'changed', view: state};
    }
    if (intent.type === 'timeTrackingChanged') {
      state = {...state, timeTrackingEditState: intent.state};
      return {kind: 'changed', view: state};
    }
    if (intent.type === 'attachmentUploaded') {
      const uploaded = intent.attachment;
      const attachments = Array.isArray(state.issueData?.fields?.attachment) ? state.issueData.fields.attachment : [];
      const nextAttachments = [
        ...attachments.filter(attachment => String(attachment?.id || '') !== String(uploaded?.id || '') &&
          String(attachment?.filename || '') !== String(uploaded?.filename || '')),
        uploaded,
      ];
      state = {
        ...state,
        issueData: {
          ...state.issueData,
          fields: {...state.issueData.fields, attachment: nextAttachments},
        },
      };
      return {kind: 'changed', view: state};
    }
    return {kind: 'ignored', reason: 'unknown-intent'};
  }

  function close() {
    const previous = state;
    state = null;
    return {kind: 'closed', previous};
  }

  return {close, commit, dispatch, view};
}
