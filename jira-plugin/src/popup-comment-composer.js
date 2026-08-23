import {positionMentionMenuAtCaret} from 'src/mention-menu-positioning';

export function createPopupCommentComposer(deps) {
  const {
    escapeHtml,
    getCommentComposerErrorMessage,
    getCommentComposerHadFocus,
    getCommentComposerSelectionEnd,
    getCommentComposerSelectionStart,
    getCommentComposerDraftValue,
    getCommentLifecycleView,
    getContainer,
    keepContainerVisible,
    setCommentComposerErrorMessage,
    setCommentComposerHadFocus,
    setCommentComposerSelectionEnd,
    setCommentComposerSelectionStart,
    setCommentComposerDraftValue,
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

  function captureCommentComposerDraft() {
    const {root, input, error} = getCommentComposerElements();
    const inputElement = input.get(0);
    if (!root.length || !inputElement) {
      return null;
    }
    return {
      errorText: error.text() || '',
      hadFocus: document.activeElement === inputElement,
      saving: root.attr('data-saving') === 'true',
      selectionEnd: typeof inputElement.selectionEnd === 'number' ? inputElement.selectionEnd : (input.val() || '').length,
      selectionStart: typeof inputElement.selectionStart === 'number' ? inputElement.selectionStart : (input.val() || '').length,
      value: input.val() || '',
    };
  }

  function setCommentComposerError(message) {
    setCommentComposerErrorMessage(message || '');
    const {error} = getCommentComposerElements();
    if (!error.length) {
      return;
    }
    error.text(message || '');
  }

  function restoreCommentComposerDraft(draft) {
    if (!draft) {
      return;
    }
    const {root, input} = getCommentComposerElements();
    const inputElement = input.get(0);
    if (!root.length || !inputElement) {
      return;
    }
    input.val(draft.value || '');
    root.attr('data-saving', draft.saving ? 'true' : 'false');
    setCommentComposerError(draft.errorText || '');
    const nextValue = String(draft.value || '');
    const maxIndex = nextValue.length;
    const selectionStart = Math.min(maxIndex, Number.isInteger(draft.selectionStart) ? draft.selectionStart : maxIndex);
    const selectionEnd = Math.min(maxIndex, Number.isInteger(draft.selectionEnd) ? draft.selectionEnd : maxIndex);
    if (!draft.saving) {
      if (draft.hadFocus) {
        inputElement.focus();
      }
      inputElement.setSelectionRange(selectionStart, selectionEnd);
    }
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
    setCommentComposerDraftValue('');
    setCommentComposerHadFocus(false);
    setCommentComposerSelectionStart(0);
    setCommentComposerSelectionEnd(0);
    const {input} = getCommentComposerElements();
    if (input.length) {
      input.val('');
    }
    setCommentComposerError('');
    syncCommentComposerState();
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
    const isSaving = elements.root.attr('data-saving') === 'true';
    const uploadsView = getCommentLifecycleView().compose?.uploads || [];
    const hasUploadsInFlight = uploadsView.some(item => item.status === 'uploading');
    const hasText = !!elements.input.val().trim();
    const hasDraftUploads = uploadsView.length > 0;
    elements.input.prop('disabled', isSaving);
    elements.save.prop('disabled', !hasText || isSaving || hasUploadsInFlight).text(isSaving ? 'Saving...' : (hasUploadsInFlight ? 'Uploading...' : 'Save'));
    elements.discard.prop('disabled', (!hasText && !hasDraftUploads) || isSaving);
  }

  function restoreCommentComposerState() {
    const elements = getCommentComposerElements();
    if (!elements.root.length) {
      return;
    }
    if (elements.input.val() !== getCommentComposerDraftValue()) {
      elements.input.val(getCommentComposerDraftValue());
    }
    setCommentComposerError(getCommentComposerErrorMessage());
    const inputElement = elements.input.get(0);
    if (inputElement && getCommentComposerHadFocus()) {
      inputElement.focus();
      const maxIndex = inputElement.value.length;
      inputElement.setSelectionRange(
        Math.min(maxIndex, Number.isInteger(getCommentComposerSelectionStart()) ? getCommentComposerSelectionStart() : maxIndex),
        Math.min(maxIndex, Number.isInteger(getCommentComposerSelectionEnd()) ? getCommentComposerSelectionEnd() : maxIndex)
      );
    }
  }

  return {
    getCommentComposerElements,
    captureCommentComposerDraft,
    discardCommentComposerDraft,
    getClipboardImageFiles,
    renderCommentMentionSuggestions,
    renderCommentUploads,
    restoreCommentComposerDraft,
    restoreCommentComposerState,
    setCommentComposerError,
    syncCommentComposerState,
  };
}
