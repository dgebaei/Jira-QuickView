import Mustache from 'mustache';

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
}) {
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

    const existingContentBlocks = container.find('._JX_content_blocks');
    const savedScrollLeft = existingContentBlocks.length ? existingContentBlocks.scrollLeft() : 0;
    const savedScrollTop = existingContentBlocks.length ? existingContentBlocks.scrollTop() : 0;
    container.html(Mustache.render(template, displayData));
    reorderContentBlocks(container, contentBlockOrder);
    const nextContentBlocks = container.find('._JX_content_blocks');
    if (nextContentBlocks.length) {
      nextContentBlocks.scrollLeft(savedScrollLeft);
      nextContentBlocks.scrollTop(savedScrollTop);
    }

    commentPresentation.render({applyValue: true, restoreFocus: true});
    if (!shell.view().pinned) {
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
    } else if (state.linkedIssuesState?.open && state.linkedIssuesState.focusSearch) {
      restoreSelection(container.find('._JX_linked_issues_search_input')[0], {
        start: state.linkedIssuesState.searchSelectionStart,
        end: state.linkedIssuesState.searchSelectionEnd,
      });
    } else if (state.watchersState?.open && state.watchersState.focusSearch) {
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
    continuity.renderEditMentions();
    continuity.constrainPopovers();
    return {kind: 'committed'};
  }

  return {render};
}
