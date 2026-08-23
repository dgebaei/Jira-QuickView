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

export function createPopupSession({issueData, fieldEditing, comments, surface}) {
  requireOperation(issueData, 'openIssue');
  requireOperation(fieldEditing, 'attach');
  requireOperation(fieldEditing, 'detach');
  requireOperation(fieldEditing, 'view');
  requireOperation(comments, 'attach');
  requireOperation(comments, 'detach');
  requireOperation(comments, 'view');
  requireOperation(surface, 'render');
  requireOperation(surface, 'hide');

  let activationRequest = 0;
  let disposed = false;
  let renderRevision = 0;
  let scheduledRender = null;
  let sessionSequence = 0;
  let stateRevision = 0;
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
    await fieldEditing.detach({sessionId: previous.sessionId, reason});
    await comments.detach({sessionId: previous.sessionId, reason});
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
    if (intent.type === 'render') {
      const nextSnapshot = intent.issueSnapshot;
      const nextIssueKey = normalizeIssueKey(nextSnapshot?.issueKey || nextSnapshot?.core?.key);
      if (nextSnapshot?.core && nextIssueKey !== state.issueKey) {
        return outcome('ignored', {reason: 'stale-issue-snapshot'});
      }
      if (nextSnapshot?.core) state = {...state, snapshot: nextSnapshot};
      return scheduleRender(String(intent.reason || 'feature-changed'));
    }
    const transition = transitionPopupPresentation(state.presentation, intent);
    if (transition.kind === 'ignored') return outcome('ignored', {reason: transition.reason});
    state = {...state, presentation: transition.presentation};
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
