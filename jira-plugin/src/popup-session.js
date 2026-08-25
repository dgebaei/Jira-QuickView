import {
  createPopupPresentationState,
  transitionPopupPresentation,
} from 'src/popup-session/presentation-state';

function requireOperation(owner, operation) {
  if (typeof owner?.[operation] !== 'function') {
    throw new TypeError(`Popup session requires ${operation}()`);
  }
}

function normalizeIssueKey(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeFailure(error, fallback = 'Unable to load issue') {
  return {
    message: String(error?.message || error?.inner || error || fallback),
  };
}

function mergeIssueSnapshots(previous, next) {
  if (!previous || !next || previous.issueKey !== next.issueKey) return next;
  const sections = {...next.sections};
  Object.entries(sections).forEach(([name, section]) => {
    if (section?.status === 'unavailable' && previous.sections?.[name]) {
      sections[name] = previous.sections[name];
    }
  });
  return {
    ...next,
    sections,
    viewer: next.viewer?.status === 'unavailable' && previous.viewer ? previous.viewer : next.viewer,
  };
}

export function createPopupSession({issueData, fieldEditing, comments, quickActions, watchers, linkedIssues, surface}) {
  requireOperation(issueData, 'openIssue');
  requireOperation(fieldEditing, 'attach');
  requireOperation(fieldEditing, 'detach');
  requireOperation(fieldEditing, 'view');
  requireOperation(comments, 'attach');
  requireOperation(comments, 'detach');
  requireOperation(comments, 'view');
  requireOperation(quickActions, 'attach');
  requireOperation(quickActions, 'detach');
  requireOperation(quickActions, 'dispatch');
  requireOperation(quickActions, 'view');
  requireOperation(watchers, 'attach');
  requireOperation(watchers, 'detach');
  requireOperation(watchers, 'dispatch');
  requireOperation(watchers, 'view');
  requireOperation(linkedIssues, 'attach');
  requireOperation(linkedIssues, 'detach');
  requireOperation(linkedIssues, 'dispatch');
  requireOperation(linkedIssues, 'view');
  requireOperation(surface, 'render');
  requireOperation(surface, 'hide');

  let activationRequest = 0;
  let disposed = false;
  let historyLoading = false;
  let historyFailure = null;
  let historyRequest = 0;
  let renderRevision = 0;
  let scheduledRender = null;
  let sessionSequence = 0;
  let stateRevision = 0;
  let watcherFeedbackTimer = null;
  let linkedSearchTimer = null;
  let notice = '';
  let noticeTimer = null;
  let quickActionNoticeTimer = null;
  let state = {
    activation: '',
    anchor: null,
    controller: null,
    issueKey: '',
    presentation: createPopupPresentationState(),
    sessionId: '',
    snapshot: null,
    status: 'hidden',
  };

  function outcome(kind, details = {}) {
    return {kind, ...details};
  }

  function isCurrent(sessionId) {
    return !disposed && state.sessionId === sessionId && !state.controller?.signal.aborted;
  }

  function view() {
    return {
      status: state.status,
      sessionId: state.sessionId,
      issueKey: state.issueKey,
      stateRevision,
    };
  }

  function projectHistory() {
    const section = state.snapshot?.sections?.history;
    return {
      data: ['ready', 'empty', 'staleRetained'].includes(section?.status) ? section.data : {histories: []},
      failure: section?.failure || historyFailure,
      loading: historyLoading,
      status: section?.status || 'unavailable',
    };
  }

  function clearWatcherFeedbackTimer() {
    if (!watcherFeedbackTimer) return;
    clearTimeout(watcherFeedbackTimer);
    watcherFeedbackTimer = null;
  }

  function clearLinkedSearchTimer() {
    if (!linkedSearchTimer) return;
    clearTimeout(linkedSearchTimer);
    linkedSearchTimer = null;
  }

  function clearNoticeTimers() {
    if (noticeTimer) clearTimeout(noticeTimer);
    if (quickActionNoticeTimer) clearTimeout(quickActionNoticeTimer);
    noticeTimer = null;
    quickActionNoticeTimer = null;
  }

  function setNotice(value, sessionId, duration = 5000) {
    notice = String(value || '');
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = null;
    if (!notice || !duration) return;
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      if (!isCurrent(sessionId)) return;
      notice = '';
      scheduleRender('notice-cleared').catch(() => {});
    }, duration);
  }

  async function closeCompetingPanels(activePanel) {
    if (activePanel !== 'watchers' && watchers.view().open) {
      clearWatcherFeedbackTimer();
      await watchers.dispatch({type: 'close'});
    }
    if (activePanel !== 'linkedIssues' && linkedIssues.view().open) {
      clearLinkedSearchTimer();
      await linkedIssues.dispatch({type: 'close'});
    }
    if (activePanel !== 'history') {
      historyRequest += 1;
      historyLoading = false;
    }
  }

  async function publish(kind, details = {}) {
    const sessionId = state.sessionId;
    const expectedStateRevision = stateRevision;
    const expectedRenderRevision = ++renderRevision;
    const frame = {
      kind,
      sessionId,
      issueKey: state.issueKey,
      stateRevision: expectedStateRevision,
      renderRevision: expectedRenderRevision,
      activation: state.activation,
      anchor: state.anchor,
      issueSnapshot: state.snapshot,
      presentation: state.presentation,
      fieldEditing: fieldEditing.view(),
      comments: comments.view(),
      quickActions: quickActions.view(),
      watchers: watchers.view(),
      history: projectHistory(),
      linkedIssues: linkedIssues.view(),
      notice,
      ...details,
    };
    const context = {
      isCurrent() {
        return isCurrent(sessionId)
          && stateRevision === expectedStateRevision
          && renderRevision === expectedRenderRevision;
      },
    };
    const receipt = await surface.render(frame, context);
    if (!context.isCurrent()) return outcome('ignored', {reason: 'stale-render'});
    return outcome('rendered', {receipt});
  }

  async function detachFeatures(previous, reason) {
    if (!previous.sessionId) return;
    previous.controller?.abort();
    clearWatcherFeedbackTimer();
    clearLinkedSearchTimer();
    clearNoticeTimers();
    notice = '';
    await fieldEditing.detach({sessionId: previous.sessionId, reason});
    await comments.detach({sessionId: previous.sessionId, reason});
    await quickActions.detach({sessionId: previous.sessionId, reason});
    await watchers.detach({sessionId: previous.sessionId, reason});
    await linkedIssues.detach({sessionId: previous.sessionId, reason});
  }

  async function activate({
    issueKey: issueKeyInput,
    anchor = null,
    activation = 'programmatic',
    preferences = {},
    requirements = {},
  } = {}) {
    const issueKey = normalizeIssueKey(issueKeyInput);
    if (disposed) return outcome('ignored', {reason: 'disposed'});
    if (!issueKey) return outcome('ignored', {reason: 'missing-issue-key'});

    const requestId = ++activationRequest;
    historyRequest += 1;
    historyLoading = false;
    historyFailure = null;
    const previous = state;
    previous.controller?.abort();
    await detachFeatures(previous, 'issue-switch');
    if (disposed || requestId !== activationRequest) return outcome('ignored', {reason: 'superseded'});

    const controller = new AbortController();
    state = {
      activation: String(activation || 'programmatic'),
      anchor,
      controller,
      issueKey,
      presentation: createPopupPresentationState(preferences),
      sessionId: `popup-${++sessionSequence}`,
      snapshot: null,
      status: 'loading',
    };
    stateRevision += 1;
    await publish('loading');
    if (!isCurrent(state.sessionId) || requestId !== activationRequest) {
      return outcome('ignored', {reason: 'superseded'});
    }

    const sessionId = state.sessionId;
    let acquisition;
    try {
      acquisition = await issueData.openIssue({issueKey, requirements, signal: controller.signal});
    } catch (error) {
      acquisition = {kind: 'failed', failures: {core: normalizeFailure(error)}};
    }
    if (!isCurrent(sessionId) || requestId !== activationRequest) {
      return outcome('ignored', {reason: 'superseded'});
    }

    if (!acquisition?.snapshot?.core) {
      const failure = normalizeFailure(acquisition?.failures?.core);
      state = {...state, status: 'error'};
      stateRevision += 1;
      await publish('error', {failure});
      return isCurrent(sessionId)
        ? outcome('error', {failure})
        : outcome('ignored', {reason: 'superseded'});
    }

    const issueSnapshot = acquisition.snapshot;
    await fieldEditing.attach({sessionId, issueSnapshot, requirements});
    await comments.attach({sessionId, issueSnapshot});
    await quickActions.attach({sessionId, issueSnapshot});
    await watchers.attach({sessionId, issueSnapshot});
    await linkedIssues.attach({sessionId, issueSnapshot});
    if (!isCurrent(sessionId) || requestId !== activationRequest) {
      return outcome('ignored', {reason: 'superseded'});
    }

    state = {...state, snapshot: issueSnapshot, status: 'visible'};
    stateRevision += 1;
    await publish('visible', {issueSnapshot, failures: acquisition.failures || {}});
    return isCurrent(sessionId)
      ? outcome('visible')
      : outcome('ignored', {reason: 'superseded'});
  }

  async function close({reason = 'explicit'} = {}) {
    activationRequest += 1;
    historyRequest += 1;
    historyLoading = false;
    historyFailure = null;
    const previous = state;
    if (!previous.sessionId) return outcome('hidden');
    previous.controller?.abort();
    await detachFeatures(previous, reason);
    if (state.sessionId !== previous.sessionId) return outcome('ignored', {reason: 'superseded'});

    state = {
      activation: '',
      anchor: null,
      controller: null,
      issueKey: '',
      presentation: createPopupPresentationState(),
      sessionId: '',
      snapshot: null,
      status: 'hidden',
    };
    stateRevision += 1;
    await surface.hide({reason, sessionId: previous.sessionId});
    return outcome('hidden');
  }

  function scheduleRender(reason) {
    const sessionId = state.sessionId;
    if (scheduledRender?.sessionId === sessionId) {
      scheduledRender.reason = reason;
      return scheduledRender.promise;
    }
    const scheduled = {
      promise: null,
      reason,
      sessionId,
    };
    scheduled.promise = Promise.resolve().then(async () => {
      if (scheduledRender === scheduled) scheduledRender = null;
      if (!isCurrent(sessionId)) return outcome('ignored', {reason: 'superseded'});
      stateRevision += 1;
      return publish('update', {reason: scheduled.reason});
    });
    scheduledRender = scheduled;
    return scheduled.promise;
  }

  async function dispatch(intent = {}) {
    if (disposed || !state.sessionId) return outcome('ignored', {reason: 'inactive'});
    if (['toggle-history', 'close-history', 'dismiss-history'].includes(intent.type)) {
      const opening = intent.type === 'toggle-history' && state.presentation.activePanel !== 'history';
      const transition = transitionPopupPresentation(state.presentation, {
        type: opening ? 'open-panel' : 'close-panel',
        panel: 'history',
      });
      if (transition.kind === 'ignored') return outcome('ignored', {reason: transition.reason});
      state = {...state, presentation: transition.presentation};
      await closeCompetingPanels(opening ? 'history' : '');
      const requestId = ++historyRequest;
      if (!opening) {
        historyLoading = false;
        return scheduleRender(transition.reason);
      }
      const section = state.snapshot?.sections?.history;
      if (['ready', 'empty', 'staleRetained'].includes(section?.status)) {
        return scheduleRender(transition.reason);
      }
      const sessionId = state.sessionId;
      historyLoading = true;
      historyFailure = null;
      await scheduleRender('history-loading');
      let acquired;
      try {
        acquired = await issueData.openIssue({
          issueKey: state.issueKey,
          requirements: {history: true},
          signal: state.controller?.signal,
        });
      } catch (error) {
        acquired = {snapshot: null, failures: {history: normalizeFailure(error, 'Could not load issue history')}};
      }
      if (!isCurrent(sessionId) || requestId !== historyRequest || state.presentation.activePanel !== 'history') {
        return outcome('ignored', {reason: 'superseded'});
      }
      historyLoading = false;
      historyFailure = acquired.snapshot?.sections?.history?.failure || acquired.failures?.history || acquired.failures?.core || null;
      if (acquired.snapshot?.core) state = {...state, snapshot: mergeIssueSnapshots(state.snapshot, acquired.snapshot)};
      const rendered = await scheduleRender(historyFailure
        ? 'history-failed'
        : 'history-loaded');
      return {...rendered, presentation: state.presentation};
    }
    if (['toggle-watchers', 'close-watchers', 'dismiss-watchers'].includes(intent.type)) {
      const opening = intent.type === 'toggle-watchers' && state.presentation.activePanel !== 'watchers';
      const transition = transitionPopupPresentation(state.presentation, {
        type: opening ? 'open-panel' : 'close-panel',
        panel: 'watchers',
      });
      if (transition.kind === 'ignored') return outcome('ignored', {reason: transition.reason});
      state = {...state, presentation: transition.presentation};
      await closeCompetingPanels(opening ? 'watchers' : '');
      if (!opening) {
        clearWatcherFeedbackTimer();
        await watchers.dispatch({type: 'close'});
        return scheduleRender(transition.reason);
      }
      const sessionId = state.sessionId;
      const pending = watchers.dispatch({type: 'open'});
      await scheduleRender('watchers-loading');
      const watcherOutcome = await pending;
      if (!isCurrent(sessionId)) return outcome('ignored', {reason: 'superseded'});
      if (watcherOutcome.issueSnapshot?.core) {
        state = {...state, snapshot: mergeIssueSnapshots(state.snapshot, watcherOutcome.issueSnapshot)};
      }
      const rendered = await scheduleRender(`watchers-${watcherOutcome.kind}`);
      return {...rendered, presentation: state.presentation, watcherOutcome};
    }
    if (['search-watchers', 'add-watcher', 'remove-watcher'].includes(intent.type)) {
      const watcherIntent = intent.type === 'search-watchers'
        ? {type: 'search', query: intent.query}
        : {
            type: intent.type === 'add-watcher' ? 'add' : 'remove',
            watcherId: intent.watcherId,
            requirements: intent.requirements || {},
          };
      const sessionId = state.sessionId;
      const pending = watchers.dispatch(watcherIntent);
      await scheduleRender(`${intent.type}-pending`);
      const watcherOutcome = await pending;
      if (!isCurrent(sessionId)) return outcome('ignored', {reason: 'superseded'});
      if (watcherOutcome.issueSnapshot?.core) {
        state = {...state, snapshot: mergeIssueSnapshots(state.snapshot, watcherOutcome.issueSnapshot)};
      }
      const rendered = await scheduleRender(`${intent.type}-${watcherOutcome.kind}`);
      if (watcherOutcome.feedbackExpiresIn) {
        if (watcherFeedbackTimer) clearTimeout(watcherFeedbackTimer);
        watcherFeedbackTimer = setTimeout(() => {
          watcherFeedbackTimer = null;
          if (!isCurrent(sessionId)) return;
          watchers.dispatch({type: 'clearFeedback'}).then(() => scheduleRender('watcher-feedback-cleared')).catch(() => {});
        }, watcherOutcome.feedbackExpiresIn);
      }
      return {...rendered, watcherOutcome};
    }
    if (intent.type === 'execute-quick-action') {
      const sessionId = state.sessionId;
      const pending = quickActions.dispatch({
        type: 'execute',
        actionKey: intent.actionKey,
        requirements: intent.requirements || {},
      });
      const transition = transitionPopupPresentation(state.presentation, {type: 'close-actions'});
      if (transition.kind !== 'ignored') state = {...state, presentation: transition.presentation};
      await scheduleRender('quick-action-pending');
      const actionOutcome = await pending;
      if (!isCurrent(sessionId)) return outcome('ignored', {reason: 'superseded'});
      if (actionOutcome.refreshedSnapshot?.core) {
        state = {...state, snapshot: mergeIssueSnapshots(state.snapshot, actionOutcome.refreshedSnapshot)};
      }
      const rendered = await scheduleRender(`quick-action-${actionOutcome.kind}`);
      if (actionOutcome.kind === 'executed' && actionOutcome.notice) {
        if (quickActionNoticeTimer) clearTimeout(quickActionNoticeTimer);
        quickActionNoticeTimer = setTimeout(() => {
          quickActionNoticeTimer = null;
          if (!isCurrent(sessionId)) return;
          quickActions.dispatch({type: 'clearNotice', notice: actionOutcome.notice}).then(() => {
            return scheduleRender('quick-action-notice-cleared');
          }).catch(() => {});
        }, 5000);
      }
      return {...rendered, actionOutcome};
    }
    if (['toggle-linkedIssues', 'close-linkedIssues', 'dismiss-linkedIssues'].includes(intent.type)) {
      const opening = intent.type === 'toggle-linkedIssues' && state.presentation.activePanel !== 'linkedIssues';
      const transition = transitionPopupPresentation(state.presentation, {
        type: opening ? 'open-panel' : 'close-panel',
        panel: 'linkedIssues',
      });
      if (transition.kind === 'ignored') return outcome('ignored', {reason: transition.reason});
      state = {...state, presentation: transition.presentation};
      await closeCompetingPanels(opening ? 'linkedIssues' : '');
      clearLinkedSearchTimer();
      if (!opening) {
        await linkedIssues.dispatch({type: 'close'});
        return scheduleRender(transition.reason);
      }
      const sessionId = state.sessionId;
      const pending = linkedIssues.dispatch({type: 'open'});
      await scheduleRender('linked-issues-loading');
      const linkedOutcome = await pending;
      if (!isCurrent(sessionId)) return outcome('ignored', {reason: 'superseded'});
      if (linkedOutcome.issueSnapshot?.core) {
        state = {...state, snapshot: mergeIssueSnapshots(state.snapshot, linkedOutcome.issueSnapshot)};
      }
      const rendered = await scheduleRender(`linked-issues-${linkedOutcome.kind}`);
      return {...rendered, presentation: state.presentation, linkedOutcome};
    }
    const linkedIntentTypes = {
      'linked-relationship-changed': 'relationshipChanged',
      'linked-input-changed': 'inputChanged',
      'linked-enter': 'enterPressed',
      'linked-select': 'selectCandidate',
      'linked-remove-token': 'removeToken',
      'linked-add': 'addSelected',
      'linked-confirm-remove': 'confirmRemoval',
      'linked-cancel-remove': 'cancelRemoval',
      'linked-remove-confirmed': 'removeConfirmed',
    };
    if (linkedIntentTypes[intent.type]) {
      const sessionId = state.sessionId;
      clearLinkedSearchTimer();
      const lifecycleIntent = {
        ...intent,
        type: linkedIntentTypes[intent.type],
        requirements: intent.requirements || {},
      };
      const pending = linkedIssues.dispatch(lifecycleIntent);
      if (['linked-add', 'linked-remove-confirmed'].includes(intent.type)) {
        await scheduleRender(`${intent.type}-pending`);
      }
      const linkedOutcome = await pending;
      if (!isCurrent(sessionId)) return outcome('ignored', {reason: 'superseded'});
      if (linkedOutcome.issueSnapshot?.core) {
        state = {...state, snapshot: mergeIssueSnapshots(state.snapshot, linkedOutcome.issueSnapshot)};
      }
      const rendered = await scheduleRender(`${intent.type}-${linkedOutcome.kind}`);
      if (linkedOutcome.searchAfterMs) {
        const requestId = linkedOutcome.requestId;
        linkedSearchTimer = setTimeout(() => {
          linkedSearchTimer = null;
          if (!isCurrent(sessionId)) return;
          linkedIssues.dispatch({type: 'runSearch', requestId}).then(() => {
            if (isCurrent(sessionId)) return scheduleRender('linked-search-complete');
            return null;
          }).catch(() => {});
        }, linkedOutcome.searchAfterMs);
      }
      return {...rendered, linkedOutcome};
    }
    if (intent.type === 'render') {
      const sessionId = state.sessionId;
      if (Object.prototype.hasOwnProperty.call(intent, 'notice')) {
        setNotice(intent.notice, sessionId, intent.noticeDuration ?? 5000);
      }
      const nextSnapshot = intent.issueSnapshot;
      const nextIssueKey = normalizeIssueKey(nextSnapshot?.issueKey || nextSnapshot?.core?.key);
      if (nextSnapshot?.core && nextIssueKey !== state.issueKey) {
        return outcome('ignored', {reason: 'stale-issue-snapshot'});
      }
      if (nextSnapshot?.core) {
        const mergedSnapshot = mergeIssueSnapshots(state.snapshot, nextSnapshot);
        state = {...state, snapshot: mergedSnapshot};
        if (['ready', 'empty', 'staleRetained'].includes(mergedSnapshot.sections?.history?.status)) {
          historyFailure = null;
          historyLoading = false;
        }
        await quickActions.dispatch({type: 'snapshotChanged', issueSnapshot: mergedSnapshot});
        if (!isCurrent(sessionId)) return outcome('ignored', {reason: 'superseded'});
      }
      return scheduleRender(String(intent.reason || 'feature-changed'));
    }
    const transition = transitionPopupPresentation(state.presentation, intent);
    if (transition.kind === 'ignored') return outcome('ignored', {reason: transition.reason});
    state = {...state, presentation: transition.presentation};
    if (transition.presentation.activePanel !== 'history' && state.presentation.activePanel !== 'history') {
      historyRequest += 1;
      historyLoading = false;
    }
    await closeCompetingPanels(transition.presentation.activePanel);
    const rendered = await scheduleRender(transition.reason);
    return {...rendered, presentation: transition.presentation};
  }

  async function dispose() {
    if (disposed) return outcome('disposed');
    await close({reason: 'dispose'});
    disposed = true;
    return outcome('disposed');
  }

  return {activate, close, dispatch, dispose, view};
}
