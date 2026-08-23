import {positionMentionMenuAtCaret} from 'src/mention-menu-positioning';

export function createPopupCommentComposer(deps) {
  const {
    INSTANCE_URL,
    emptyCommentUploadState,
    escapeHtml,
    getActiveCommentContext,
    getCommentComposerErrorMessage,
    getCommentComposerHadFocus,
    getCommentComposerSelectionEnd,
    getCommentComposerSelectionStart,
    getCommentComposerDraftValue,
    getCommentLifecycleView,
    getCommentUploadSequence,
    getCommentUploadSessionId,
    getCommentUploadState,
    getContainer,
    getDisplayImageUrl,
    rememberDisplayImageUrl,
    onAttachmentUploaded,
    keepContainerVisible,
    requestJson,
    setCommentComposerErrorMessage,
    setCommentComposerHadFocus,
    setCommentComposerSelectionEnd,
    setCommentComposerSelectionStart,
    setCommentComposerDraftValue,
    setCommentUploadSequence,
    setCommentUploadSessionId,
    setCommentUploadState,
    setPopupState,
    textToLinkedHtml,
    toAbsoluteJiraUrl,
    uploadAttachment,
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

  function hasCommentUploadInFlight() {
    return getCommentUploadState().items.some(item => item.status === 'uploading');
  }

  function getUploadedCommentAttachments() {
    return getCommentUploadState().items.filter(item => item.status === 'uploaded' && item.attachmentId);
  }

  function renderCommentUploads() {
    const {uploads} = getCommentComposerElements();
    if (!uploads.length) {
      return;
    }

    const commentUploadState = getCommentUploadState();
    if (!commentUploadState.items.length) {
      uploads.attr('hidden', 'hidden').empty();
      keepContainerVisible();
      return;
    }

    uploads.removeAttr('hidden').html(commentUploadState.items.map(item => {
      const stateClass = item.status === 'error' ? ' is-error' : '';
      const statusText = item.status === 'uploading'
        ? 'Uploading to Jira...'
        : (item.status === 'uploaded' ? 'Attached to issue' : (item.errorMessage || 'Upload failed'));
      const previewHtml = item.previewUrl
        ? `<img class="_JX_comment_upload_preview" src="${escapeHtml(item.previewUrl)}" alt="${escapeHtml(item.fileName)}" />`
        : '<span class="_JX_comment_upload_preview"></span>';
      return `
        <div class="_JX_comment_upload${stateClass}">
          ${previewHtml}
          <span>
            <span class="_JX_comment_upload_name">${escapeHtml(item.fileName)}</span>
            <span class="_JX_comment_upload_status">${escapeHtml(statusText)}</span>
          </span>
        </div>
      `;
    }).join(''));
    keepContainerVisible();
  }

  function updateCommentUploadItem(localId, updater) {
    const nextItems = getCommentUploadState().items.map(item => {
      if (item.localId !== localId) {
        return item;
      }
      return typeof updater === 'function' ? updater(item) : {...item, ...updater};
    });
    setCommentUploadState({items: nextItems});
    renderCommentUploads();
    syncCommentComposerState();
  }

  function buildPastedImageFileName(file) {
    const mimeType = String(file?.type || '').toLowerCase();
    const extensionByMimeType = {
      'image/bmp': 'bmp',
      'image/gif': 'gif',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    };
    const extension = extensionByMimeType[mimeType] || 'png';
    setCommentUploadSequence(getCommentUploadSequence() + 1);
    const timestamp = new Date().toISOString().replace(/[^\d]/g, '').slice(0, 14);
    return `pasted-image-${timestamp}-${getCommentUploadSequence()}.${extension}`;
  }

  function buildCommentImageMarkup(fileName) {
    return `!${fileName}!`;
  }

  function replaceCommentInputText(searchValue, replaceValue = '') {
    const {input} = getCommentComposerElements();
    const inputElement = input.get(0);
    if (!inputElement || !searchValue) {
      return false;
    }
    const currentValue = inputElement.value || '';
    const nextValue = currentValue.replace(searchValue, replaceValue).replace(/\n{3,}/g, '\n\n');
    if (nextValue === currentValue) {
      return false;
    }
    input.val(nextValue);
    setCommentComposerDraftValue(nextValue);
    const caretPosition = Math.min(nextValue.length, (typeof inputElement.selectionStart === 'number' ? inputElement.selectionStart : nextValue.length));
    inputElement.setSelectionRange(caretPosition, caretPosition);
    return true;
  }

  function insertCommentInputText(text) {
    const {input} = getCommentComposerElements();
    const inputElement = input.get(0);
    if (!inputElement) {
      return false;
    }
    const value = inputElement.value || '';
    const selectionStart = typeof inputElement.selectionStart === 'number' ? inputElement.selectionStart : value.length;
    const selectionEnd = typeof inputElement.selectionEnd === 'number' ? inputElement.selectionEnd : selectionStart;
    const prefix = selectionStart > 0 && value.charAt(selectionStart - 1) !== '\n' ? '\n' : '';
    const suffix = selectionEnd < value.length ? (value.charAt(selectionEnd) !== '\n' ? '\n' : '') : '\n';
    const insertedText = `${prefix}${text}${suffix}`;
    const nextValue = value.slice(0, selectionStart) + insertedText + value.slice(selectionEnd);
    input.val(nextValue);
    setCommentComposerDraftValue(nextValue);
    inputElement.focus();
    const caretPosition = selectionStart + insertedText.length;
    inputElement.setSelectionRange(caretPosition, caretPosition);
    return true;
  }

  function revokeCommentUploadPreview(item) {
    if (item?.previewUrl && item.previewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(item.previewUrl);
    }
  }

  async function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('Could not read file'));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(file);
    });
  }

  async function deleteCommentDraftAttachment(attachmentId) {
    if (!attachmentId) {
      return;
    }
    try {
      await requestJson('DELETE', `${INSTANCE_URL}rest/api/2/attachment/${attachmentId}`);
    } catch (error) {
      console.warn('[Jira QuickView] Could not delete draft attachment', {
        attachmentId,
        error: error?.message || String(error),
      });
    }
  }

  async function clearCommentUploads(options = {}) {
    const {deleteUploaded = false} = options;
    const previousItems = getCommentUploadState().items;
    setCommentUploadSessionId(getCommentUploadSessionId() + 1);
    setCommentUploadState(emptyCommentUploadState());
    renderCommentUploads();
    syncCommentComposerState();
    previousItems.forEach(revokeCommentUploadPreview);
    if (deleteUploaded) {
      await Promise.all(previousItems.map(item => deleteCommentDraftAttachment(item.attachmentId)));
    }
  }

  async function discardCommentComposerDraft(options = {}) {
    const {deleteUploaded = true} = options;
    setCommentComposerDraftValue('');
    setCommentComposerHadFocus(false);
    setCommentComposerSelectionStart(0);
    setCommentComposerSelectionEnd(0);
    const {input} = getCommentComposerElements();
    if (input.length) {
      input.val('');
    }
    setCommentComposerError('');
    await clearCommentUploads({deleteUploaded});
    syncCommentComposerState();
  }

  async function buildOptimisticCommentBodyHtml(commentText, uploadedAttachments = []) {
    const attachmentImagesByName = {};
    for (const attachment of uploadedAttachments) {
      if (!attachment?.fileName) {
        continue;
      }
      const imageUrl = attachment.displayUrl || attachment.thumbnailUrl || attachment.contentUrl;
      if (!imageUrl) {
        continue;
      }
      const displaySrc = await getDisplayImageUrl(imageUrl).catch(() => imageUrl);
      const previewSrc = attachment.displayUrl || attachment.contentUrl || imageUrl;
      attachmentImagesByName[attachment.fileName] = `<img class="_JX_previewable" src="${escapeHtml(displaySrc || imageUrl)}" data-jx-preview-src="${escapeHtml(previewSrc)}" alt="${escapeHtml(attachment.fileName)}" style="max-height: 100px;" />`;
    }
    return textToLinkedHtml(commentText || '', {attachmentImagesByName});
  }

  async function uploadPastedImage(file) {
    const activeCommentContext = getActiveCommentContext();
    if (!activeCommentContext?.issueKey) {
      return;
    }

    const issueKey = activeCommentContext.issueKey;
    const fileName = buildPastedImageFileName(file);
    const markup = buildCommentImageMarkup(fileName);
    const localId = `upload-${Date.now()}-${getCommentUploadSequence()}`;
    const previewUrl = URL.createObjectURL(file);
    const previewDataUrl = await fileToDataUrl(file).catch(() => '');
    const sessionId = getCommentUploadSessionId();
    setCommentUploadState({
      items: [...getCommentUploadState().items, {
        attachmentId: '',
        contentUrl: '',
        displayUrl: previewDataUrl,
        errorMessage: '',
        fileName,
        localId,
        markup,
        previewUrl,
        status: 'uploading',
        thumbnailUrl: '',
      }],
    });
    renderCommentUploads();
    insertCommentInputText(markup);
    setCommentComposerError('');
    syncCommentComposerState();

    try {
      const uploadResult = await uploadAttachment(`${INSTANCE_URL}rest/api/2/issue/${issueKey}/attachments`, new File([file], fileName, {type: file.type || 'image/png'}));
      const uploadedAttachment = (Array.isArray(uploadResult) ? uploadResult : [uploadResult]).find(item => item && item.id);
      if (!uploadedAttachment) {
        throw new Error('Attachment upload failed');
      }

      if (sessionId !== getCommentUploadSessionId() || getActiveCommentContext()?.issueKey !== issueKey) {
        await deleteCommentDraftAttachment(uploadedAttachment.id);
        return;
      }

      const nextFileName = uploadedAttachment.filename || fileName;
      const nextMarkup = buildCommentImageMarkup(nextFileName);
      if (nextMarkup !== markup) {
        replaceCommentInputText(markup, nextMarkup);
      }
      updateCommentUploadItem(localId, {
        attachmentId: uploadedAttachment.id,
        contentUrl: toAbsoluteJiraUrl(uploadedAttachment.content),
        displayUrl: previewDataUrl,
        errorMessage: '',
        fileName: nextFileName,
        markup: nextMarkup,
        status: 'uploaded',
        thumbnailUrl: toAbsoluteJiraUrl(uploadedAttachment.thumbnail || uploadedAttachment.content),
      });
      rememberDisplayImageUrl(toAbsoluteJiraUrl(uploadedAttachment.content), previewDataUrl);
      rememberDisplayImageUrl(toAbsoluteJiraUrl(uploadedAttachment.thumbnail || uploadedAttachment.content), previewDataUrl);
      await onAttachmentUploaded?.({
        ...uploadedAttachment,
        content: toAbsoluteJiraUrl(uploadedAttachment.content),
        displayContent: previewDataUrl,
        thumbnail: previewDataUrl || toAbsoluteJiraUrl(uploadedAttachment.thumbnail || uploadedAttachment.content),
      });
    } catch (error) {
      if (sessionId !== getCommentUploadSessionId()) {
        return;
      }
      replaceCommentInputText(markup, '');
      updateCommentUploadItem(localId, {
        errorMessage: error?.message || error?.inner || 'Upload failed',
        status: 'error',
      });
      setCommentComposerError(error?.message || error?.inner || 'Could not upload pasted image');
    }
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
    const hasUploadsInFlight = hasCommentUploadInFlight();
    const hasText = !!elements.input.val().trim();
    const hasDraftUploads = getCommentUploadState().items.length > 0;
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
    buildOptimisticCommentBodyHtml,
    clearCommentUploads,
    getCommentComposerElements,
    getUploadedCommentAttachments,
    hasCommentUploadInFlight,
    captureCommentComposerDraft,
    discardCommentComposerDraft,
    getClipboardImageFiles,
    renderCommentMentionSuggestions,
    renderCommentUploads,
    restoreCommentComposerDraft,
    restoreCommentComposerState,
    setCommentComposerError,
    syncCommentComposerState,
    uploadPastedImage,
  };
}
