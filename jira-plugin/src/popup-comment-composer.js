import {positionMentionMenuAtCaret} from 'src/mention-menu-positioning';

export function createPopupCommentComposer(deps) {
  const {
    escapeHtml,
    getCommentLifecycleView,
    getContainer,
    keepContainerVisible,
  } = deps;

  function getCommentComposerElements() {
    const container = getContainer();
    return {
      root: container.find('._JX_comment_compose'),
      input: container.find('._JX_comment_input'),
      mentions: container.find('._JX_comment_mentions'),
      uploads: container.find('._JX_comment_uploads'),
      save: container.find('._JX_comment_save'),
      discard: container.find('._JX_comment_discard'),
      error: container.find('._JX_comment_error'),
    };
  }

  function setCommentComposerError(message) {
    const {error} = getCommentComposerElements();
    if (!error.length) {
      return;
    }
    error.text(message || '');
  }

  function renderCommentUploads() {
    const {uploads} = getCommentComposerElements();
    if (!uploads.length) {
      return;
    }

    const uploadsView = getCommentLifecycleView().compose?.uploads || [];
    if (!uploadsView.length) {
      uploads.attr('hidden', 'hidden').empty();
      keepContainerVisible();
      return;
    }

    uploads.removeAttr('hidden').html(uploadsView.map(item => {
      const stateClass = item.status === 'error' ? ' is-error' : '';
      const statusText = item.status === 'uploading'
        ? 'Uploading to Jira...'
        : (item.status === 'uploaded' ? 'Attached to issue' : (item.errorMessage || 'Upload failed'));
      const previewHtml = item.previewUrl
        ? `<img class="_JX_comment_upload_preview" src="${escapeHtml(item.previewUrl)}" alt="${escapeHtml(item.fileName)}" />`
        : '<span class="_JX_comment_upload_preview"></span>';
      const retryHtml = item.canRetry
        ? `<button class="_JX_comment_upload_retry" type="button" data-upload-id="${escapeHtml(item.localId)}">Retry</button>`
        : '';
      return `
        <div class="_JX_comment_upload${stateClass}" data-upload-id="${escapeHtml(item.localId)}">
          ${previewHtml}
          <span>
            <span class="_JX_comment_upload_name">${escapeHtml(item.fileName)}</span>
            <span class="_JX_comment_upload_status">${escapeHtml(statusText)}</span>
            ${retryHtml}
          </span>
        </div>
      `;
    }).join(''));
    keepContainerVisible();
  }

  async function discardCommentComposerDraft() {
    restoreCommentComposerState();
  }

  function getClipboardImageFiles(event) {
    const clipboardData = event?.originalEvent?.clipboardData || event?.clipboardData;
    if (!clipboardData) {
      return [];
    }
    const items = Array.from(clipboardData.items || []);
    const itemFiles = items
      .filter(item => item && item.kind === 'file' && String(item.type || '').toLowerCase().startsWith('image/'))
      .map(item => item.getAsFile())
      .filter(Boolean);
    if (itemFiles.length) {
      return itemFiles;
    }
    return Array.from(clipboardData.files || []).filter(file => String(file?.type || '').toLowerCase().startsWith('image/'));
  }

  function renderCommentMentionSuggestions() {
    const {input, mentions} = getCommentComposerElements();
    const mentionsElement = mentions.get(0);
    const inputElement = input.get(0);
    if (!mentions.length || !mentionsElement) {
      return;
    }
    const positionSuggestions = (html) => {
      mentions.removeAttr('hidden').html(html);
      if (inputElement) {
        positionMentionMenuAtCaret({
          caretIndex: typeof inputElement.selectionStart === 'number'
            ? inputElement.selectionStart
            : getCommentLifecycleView().compose?.mention?.range?.start,
          hostElement: input.closest('._JX_comment_input_wrap').get(0),
          inputElement,
          menuElement: mentionsElement,
        });
      }
      keepContainerVisible();
    };
    const commentMentionState = getCommentLifecycleView().compose?.mention || {
      visible: false,
      loading: false,
      errorMessage: '',
      suggestions: [],
      selectedIndex: 0,
    };
    if (!commentMentionState.visible) {
      mentions.attr('hidden', 'hidden').empty();
      keepContainerVisible();
      return;
    }
    if (commentMentionState.loading) {
      positionSuggestions('<div class="_JX_comment_mentions_status">Searching people...</div>');
      return;
    }
    if (commentMentionState.errorMessage) {
      positionSuggestions(`<div class="_JX_comment_mentions_status">${escapeHtml(commentMentionState.errorMessage)}</div>`);
      return;
    }
    if (!commentMentionState.suggestions.length) {
      positionSuggestions('<div class="_JX_comment_mentions_status">No people found.</div>');
      return;
    }
    positionSuggestions(commentMentionState.suggestions.map((candidate, index) => {
      const selectedClass = index === commentMentionState.selectedIndex ? ' is-selected' : '';
      const secondary = candidate.secondaryText ? `<span class="_JX_comment_mention_secondary">${escapeHtml(candidate.secondaryText)}</span>` : '';
      return `
        <button class="_JX_comment_mention_option${selectedClass}" type="button" data-mention-index="${index}">
          <span>
            <span class="_JX_comment_mention_primary">${escapeHtml(candidate.displayName)}</span>
            ${secondary}
          </span>
        </button>
      `;
    }).join(''));
  }

  function syncCommentComposerState() {
    const elements = getCommentComposerElements();
    if (!elements.root.length) {
      return;
    }
    const composeView = getCommentLifecycleView().compose;
    if (!composeView) return;
    const isSaving = !!composeView.saving;
    const uploadsView = composeView.uploads || [];
    const hasUploadsInFlight = uploadsView.some(item => item.status === 'uploading');
    const hasDraftUploads = uploadsView.length > 0;
    elements.root.attr('data-saving', isSaving ? 'true' : 'false');
    elements.input.prop('disabled', isSaving);
    elements.save.prop('disabled', !composeView.canSave).text(isSaving ? 'Saving...' : (hasUploadsInFlight ? 'Uploading...' : 'Save'));
    elements.discard.prop('disabled', (!composeView.value.trim() && !hasDraftUploads) || isSaving);
  }

  function restoreCommentComposerState() {
    const elements = getCommentComposerElements();
    if (!elements.root.length) {
      return;
    }
    const composeView = getCommentLifecycleView().compose;
    if (!composeView) return;
    if (elements.input.val() !== composeView.value) elements.input.val(composeView.value);
    setCommentComposerError(composeView.errorMessage);
    syncCommentComposerState();
    const inputElement = elements.input.get(0);
    if (inputElement && composeView.focused && !composeView.saving) {
      inputElement.focus();
      const maxIndex = inputElement.value.length;
      inputElement.setSelectionRange(
        Math.min(maxIndex, Number.isInteger(composeView.selection?.start) ? composeView.selection.start : maxIndex),
        Math.min(maxIndex, Number.isInteger(composeView.selection?.end) ? composeView.selection.end : maxIndex)
      );
    }
  }

  return {
    getCommentComposerElements,
    discardCommentComposerDraft,
    getClipboardImageFiles,
    renderCommentMentionSuggestions,
    renderCommentUploads,
    restoreCommentComposerState,
    setCommentComposerError,
    syncCommentComposerState,
  };
}
