function requireOperation(operation, name) {
  if (typeof operation !== 'function') {
    throw new TypeError(`Browser popup surface requires ${name}()`);
  }
}

export function createBrowserPopupSurface({commitCurrent, commitVisible, hidePopup, reportFailure}) {
  requireOperation(commitCurrent, 'commitCurrent');
  requireOperation(commitVisible, 'commitVisible');
  requireOperation(hidePopup, 'hidePopup');
  requireOperation(reportFailure, 'reportFailure');

  async function render(frame, context = {}) {
    if (frame.kind === 'loading') return {kind: 'deferred'};
    if (typeof context.isCurrent === 'function' && !context.isCurrent()) return {kind: 'stale'};
    if (frame.kind === 'error') {
      reportFailure(frame.failure);
      return {kind: 'reported'};
    }
    if (frame.kind === 'update') {
      await commitCurrent(frame, context);
      return typeof context.isCurrent === 'function' && !context.isCurrent()
        ? {kind: 'stale'}
        : {kind: 'committed'};
    }
    if (frame.kind !== 'visible') return {kind: 'ignored'};
    await commitVisible(frame, context);
    return typeof context.isCurrent === 'function' && !context.isCurrent()
      ? {kind: 'stale'}
      : {kind: 'committed'};
  }

  async function hide(details) {
    await hidePopup(details);
    return {kind: 'hidden'};
  }

  return {render, hide};
}
