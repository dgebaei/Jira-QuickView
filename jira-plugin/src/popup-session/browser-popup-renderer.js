import Mustache from 'mustache';

// Re-rendering replaces these scroll containers, so keep the reader's place in them.
const SCROLL_PRESERVED_SELECTORS = ['._JX_content_blocks', '._JX_linked_issues_groups', '._JX_watchers_list', '._JX_history_entries'];

function restoreSelection(input, selection = {}) {
  if (!input) return;
  input.focus();
  if (typeof input.setSelectionRange !== 'function' || input.type === 'date') return;
  const maxIndex = String(input.value || '').length;
  const start = Math.min(maxIndex, Number.isInteger(selection.start) ? selection.start : maxIndex);
  const end = Math.min(maxIndex, Number.isInteger(selection.end) ? selection.end : start);
  input.setSelectionRange(start, end);
}

function reorderContentBlocks(container, order) {
  const contentBlocksContainer = container.find('._JX_content_blocks');
  if (!contentBlocksContainer.length) return;
  const blocks = contentBlocksContainer.children('[data-content-block]');
  blocks.sort((left, right) => {
    const leftIndex = order.indexOf(left.getAttribute('data-content-block'));
    const rightIndex = order.indexOf(right.getAttribute('data-content-block'));
    return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
  });
  contentBlocksContainer.prepend(blocks);
}

export function createBrowserPopupRenderer({
  comments,
  commentPresentation,
  container,
  contentBlockOrder,
  continuity,
  fieldEditing,
  shell,
  projectState,
  template,
  partials = {},
  toast = null,
}) {
  let shownNotice = '';

  // Notices float as toasts; a re-render that keeps the same notice leaves it alone.
  function syncNotice({actionNoticeText = '', actionNoticeKind = 'success'}) {
    const key = actionNoticeText ? `${actionNoticeKind}:${actionNoticeText}` : '';
    if (!toast || key === shownNotice) return;
    // A progress notice ("Saving…") lasts until its outcome replaces it.
    if (!key && shownNotice.startsWith('info:')) toast.hide();
    shownNotice = key;
    if (key) toast.show(actionNoticeText, actionNoticeKind === 'info' ? {kind: 'info', timeout: 0} : {kind: actionNoticeKind});
  }

  async function renderLoading(frame, context = {}) {
    if (typeof context.isCurrent === 'function' && !context.isCurrent()) {
      return {kind: 'stale'};
    }
    await shell.dispatch({type: 'prepare-opening'});
    if (typeof context.isCurrent === 'function' && !context.isCurrent()) {
      return {kind: 'stale'};
    }

    const documentRef = container[0]?.ownerDocument;
    const loading = documentRef?.createElement('div');
    if (!loading) return {kind: 'ignored', reason: 'missing-document'};
    loading.className = '_JX_loading_tooltip';
    loading.dataset.testid = 'jira-popup-loading';
    loading.setAttribute('role', 'status');
    loading.setAttribute('aria-live', 'polite');
    const spinner = documentRef.createElement('span');
    spinner.className = '_JX_loading_spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const message = documentRef.createElement('span');
    message.textContent = `Loading ${String(frame.issueKey || '')}`;
    loading.append(spinner, message);
    container.html('').append(loading).css(shell.position(frame.anchor));
    if (frame.activation === 'click') {
      await shell.dispatch({type: 'pin', announce: false});
    }
    await shell.dispatch({type: 'take-focus'});
    return {kind: 'committed'};
  }

  async function render(state, context = {}) {
    if (!state?.issueData) return {kind: 'ignored', reason: 'missing-issue-data'};
    if (typeof context.isCurrent === 'function' && !context.isCurrent()) {
      return {kind: 'stale'};
    }

    const existingCommentInput = container.find('._JX_comment_input').get(0);
    if (existingCommentInput && state.key === comments.view().issueKey) {
      comments.dispatch({
        type: 'composeFocusChanged',
        focused: document.activeElement === existingCommentInput,
      }).catch(() => {});
    }
    const displayData = await projectState(state);
    if (typeof context.isCurrent === 'function' && !context.isCurrent()) {
      return {kind: 'stale'};
    }

    const containerElement = container[0];
    const hadFocus = !!containerElement?.contains(containerElement.ownerDocument?.activeElement);
    const savedScrollPositions = SCROLL_PRESERVED_SELECTORS.map(selector => {
      const element = container.find(selector);
      return element.length ? {selector, left: element.scrollLeft(), top: element.scrollTop()} : null;
    }).filter(Boolean);
    container.html(Mustache.render(template, displayData, partials));
    syncNotice(displayData);
    reorderContentBlocks(container, contentBlockOrder);
    savedScrollPositions.forEach(({selector, left, top}) => {
      const element = container.find(selector);
      if (!element.length) return;
      element.scrollLeft(left);
      element.scrollTop(top);
    });

    commentPresentation.render({applyValue: true, restoreFocus: true});
    if (shell.view().pinned) {
      await shell.dispatch({type: 'reposition', anchor: {x: state.pointerX, y: state.pointerY}});
    } else {
      container.css(shell.position({x: state.pointerX, y: state.pointerY}));
    }

    const activeFieldEditState = fieldEditing.view(state);
    if (activeFieldEditState?.fieldKey) {
      restoreSelection(container.find('._JX_edit_input')[0], {
        start: activeFieldEditState.selectionStart,
        end: activeFieldEditState.selectionEnd,
      });
      const highlightedOption = container.find('._JX_edit_option.is-highlighted')[0];
      if (highlightedOption) highlightedOption.scrollIntoView({block: 'nearest'});
    } else if (state.timeTrackingEditState?.activeInputField) {
      restoreSelection(container.find(`._JX_time_tracking_input[data-time-tracking-field="${state.timeTrackingEditState.activeInputField}"]`)[0], {
        start: state.timeTrackingEditState.selectionStart,
        end: state.timeTrackingEditState.selectionEnd,
      });
    } else if (state.descriptionEditState?.open) {
      const input = container.find('._JX_description_input')[0];
      const nextValue = String(state.descriptionEditState.inputValue || '');
      if (input && input.value !== nextValue) input.value = nextValue;
      restoreSelection(input, {
        start: state.descriptionEditState.selectionStart,
        end: state.descriptionEditState.selectionEnd,
      });
    } else if (state.linkedIssueView?.open && state.linkedIssueView.focusSearch) {
      restoreSelection(container.find('._JX_linked_issues_search_input')[0], {
        start: state.linkedIssueView.searchSelectionStart,
        end: state.linkedIssueView.searchSelectionEnd,
      });
    } else if (state.watcherView?.open && state.watcherView.focusSearch) {
      const input = container.find('._JX_watchers_search_input')[0];
      const end = String(input?.value || '').length;
      restoreSelection(input, {start: end, end});
    }

    const commentRowAction = comments.view().rowAction;
    if (commentRowAction?.mode === 'edit' && commentRowAction.commentId) {
      restoreSelection(container.find(`._JX_comment_edit_input[data-comment-id="${commentRowAction.commentId}"]`)[0], {
        start: commentRowAction.selection?.start,
        end: commentRowAction.selection?.end,
      });
    }
    // Replacing the markup drops focus from a removed child to <body>; keep it in the popup.
    if (hadFocus && !containerElement.contains(containerElement.ownerDocument.activeElement)) {
      containerElement.focus({preventScroll: true});
    }
    continuity.renderEditMentions();
    continuity.constrainPopovers();
    return {kind: 'committed'};
  }

  return {render, renderLoading};
}
