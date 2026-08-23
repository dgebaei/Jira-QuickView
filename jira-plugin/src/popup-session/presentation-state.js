const DEFAULT_CHILDREN_SORT = Object.freeze({column: 'key', direction: 'asc'});
const DEFAULT_PULL_REQUESTS_SORT = Object.freeze({column: 'title', direction: 'asc'});
const CHILDREN_SORT_COLUMNS = new Set(['type', 'key', 'status', 'assignee']);
const PULL_REQUEST_SORT_COLUMNS = new Set(['title', 'author', 'branch', 'status']);
const PANELS = new Set(['history', 'watchers', 'linkedIssues']);

function normalizeCommentSortOrder(value) {
  return value === 'newest' ? 'newest' : 'oldest';
}

function toggleSort(current, requestedColumn, allowedColumns) {
  const column = String(requestedColumn || '');
  if (!allowedColumns.has(column)) return null;
  return {
    column,
    direction: current.column === column && current.direction === 'asc' ? 'desc' : 'asc',
  };
}

export function createPopupPresentationState(preferences = {}) {
  return {
    activePanel: '',
    childrenSort: {...DEFAULT_CHILDREN_SORT},
    pullRequestsSort: {...DEFAULT_PULL_REQUESTS_SORT},
    commentSortOrder: normalizeCommentSortOrder(preferences.commentSortOrder),
  };
}

export function transitionPopupPresentation(current, intent = {}) {
  if (['open-panel', 'close-panel', 'toggle-panel'].includes(intent.type)) {
    const panel = String(intent.panel || '');
    if (!PANELS.has(panel)) return {kind: 'ignored', reason: 'invalid-panel'};
    const shouldClose = intent.type === 'close-panel' ||
      (intent.type === 'toggle-panel' && current.activePanel === panel);
    const activePanel = shouldClose ? '' : panel;
    if (current.activePanel === activePanel) return {kind: 'ignored', reason: 'panel-unchanged'};
    return {
      kind: 'changed',
      reason: activePanel ? 'panel-opened' : 'panel-closed',
      presentation: {...current, activePanel},
    };
  }
  if (intent.type === 'sort-children') {
    const childrenSort = toggleSort(current.childrenSort, intent.column, CHILDREN_SORT_COLUMNS);
    return childrenSort
      ? {kind: 'changed', reason: 'children-sort-changed', presentation: {...current, childrenSort}}
      : {kind: 'ignored', reason: 'invalid-sort-column'};
  }
  if (intent.type === 'sort-pull-requests') {
    const pullRequestsSort = toggleSort(current.pullRequestsSort, intent.column, PULL_REQUEST_SORT_COLUMNS);
    return pullRequestsSort
      ? {kind: 'changed', reason: 'pull-request-sort-changed', presentation: {...current, pullRequestsSort}}
      : {kind: 'ignored', reason: 'invalid-sort-column'};
  }
  if (intent.type === 'toggle-comment-sort') {
    const commentSortOrder = current.commentSortOrder === 'newest' ? 'oldest' : 'newest';
    return {
      kind: 'changed',
      reason: 'comment-sort-changed',
      presentation: {...current, commentSortOrder},
    };
  }
  return {kind: 'ignored', reason: 'unsupported-intent'};
}
