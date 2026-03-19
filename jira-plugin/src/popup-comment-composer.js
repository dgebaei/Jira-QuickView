import debounce from 'lodash/debounce';

export function createPopupCommentComposer(deps) {
  const {
    INSTANCE_URL,
    emptyCommentMentionState,
    emptyCommentUploadState,
    escapeHtml,
    get,
    getActiveCommentContext,
    getCommentComposerErrorMessage,
    getCommentComposerHadFocus,
    getCommentComposerSelectionEnd,
    getCommentComposerSelectionStart,
    getCommentComposerDraftValue,
    getCommentMentionRequestId,
    getCommentMentionState,
    getCommentUploadSequence,
    getCommentUploadSessionId,
    getCommentUploadState,
    getContainer,
    getDisplayImageUrl,
    keepContainerVisible,
    requestJson,
    setCommentComposerErrorMessage,
    setCommentComposerHadFocus,
    setCommentComposerSelectionEnd,
    setCommentComposerSelectionStart,
    setCommentComposerDraftValue,
    setCommentMentionRequestId,
    setCommentMentionState,
    setCommentUploadSequence,
    setCommentUploadSessionId,
    setCommentUploadState,
    setPopupState,
    textToLinkedHtml,
    toAbsoluteJiraUrl,
    uploadAttachment,
  } = deps;

  function getCommentMentionMarkup(candidate) {
    const username = candidate?.name || candidate?.username || '';
    if (username) {
      return `[~${username}]`;
    }
    const accountId = candidate?.accountId || '';
    if (accountId) {
      return `[~accountid:${accountId}]`;
    }
    return '';
  }

  async function searchCommentMentionCandidates(query) {
    const response = await get(`${INSTANCE_URL}rest/api/2/user/picker?query=${encodeURIComponent(query)}`);
    const rawCandidates = Array.isArray(response)
      ? response
      : response?.users || response?.items || [];
    const seen = new Set();
    return rawCandidates
      .map(candidate => {
        const mentionMarkup = getCommentMentionMarkup(candidate);
        if (!mentionMarkup || seen.has(mentionMarkup)) {
          return null;
        }
        seen.add(mentionMarkup);
        const displayName = candidate?.displayName || candidate?.name || candidate?.username || candidate?.emailAddress || 'Unknown user';
        const username = candidate?.name || candidate?.username || '';
        const secondaryText = (username && username !== displayName)
          ? `@${username}`
          : ((candidate?.emailAddress && candidate.emailAddress !== displayName) ? candidate.emailAddress : '');
        return {
          displayName,
          mentionMarkup,
          secondaryText,
        };
      })
      .filter(Boolean)
      .slice(0, 6);
  }

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

  async function deleteCommentDraftAttachment(attachmentId) {
    if (!attachmentId) {
      return;
    }
    try {
      await requestJson('DELETE', `${INSTANCE_URL}rest/api/2/attachment/${attachmentId}`);
    } catch (error) {
      console.warn('[Jira HotLinker] Could not delete draft attachment', {
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
    resetCommentMentionState();
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
      const imageUrl = attachment.thumbnailUrl || attachment.contentUrl;
      if (!imageUrl) {
        continue;
      }
      const displaySrc = await getDisplayImageUrl(imageUrl).catch(() => imageUrl);
      const previewSrc = attachment.contentUrl || imageUrl;
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
    const sessionId = getCommentUploadSessionId();
    setCommentUploadState({
      items: [...getCommentUploadState().items, {
        attachmentId: '',
        contentUrl: '',
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
        errorMessage: '',
        fileName: nextFileName,
        markup: nextMarkup,
        status: 'uploaded',
        thumbnailUrl: toAbsoluteJiraUrl(uploadedAttachment.thumbnail || uploadedAttachment.content),
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
    const {mentions} = getCommentComposerElements();
    if (!mentions.length) {
      return;
    }
    const commentMentionState = getCommentMentionState();
    if (!commentMentionState.visible) {
      mentions.attr('hidden', 'hidden').empty();
      keepContainerVisible();
      return;
    }
    if (commentMentionState.loading) {
      mentions.removeAttr('hidden').html('<div class="_JX_comment_mentions_status">Searching people...</div>');
      keepContainerVisible();
      return;
    }
    if (commentMentionState.error) {
      mentions.removeAttr('hidden').html(`<div class="_JX_comment_mentions_status">${escapeHtml(commentMentionState.error)}</div>`);
      keepContainerVisible();
      return;
    }
    if (!commentMentionState.suggestions.length) {
      mentions.removeAttr('hidden').html('<div class="_JX_comment_mentions_status">No people found.</div>');
      keepContainerVisible();
      return;
    }
    mentions.removeAttr('hidden').html(commentMentionState.suggestions.map((candidate, index) => {
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
    keepContainerVisible();
  }

  function resetCommentMentionState() {
    setCommentMentionRequestId(getCommentMentionRequestId() + 1);
    debouncedLoadCommentMentionSuggestions.cancel();
    setCommentMentionState(emptyCommentMentionState());
    renderCommentMentionSuggestions();
  }

  function getActiveCommentMention(inputElement) {
    if (!inputElement) {
      return null;
    }
    const value = inputElement.value || '';
    const caretStart = typeof inputElement.selectionStart === 'number' ? inputElement.selectionStart : value.length;
    const caretEnd = typeof inputElement.selectionEnd === 'number' ? inputElement.selectionEnd : caretStart;
    if (caretStart !== caretEnd) {
      return null;
    }
    const beforeCaret = value.slice(0, caretStart);
    const mentionMatch = beforeCaret.match(/(^|[\s(])@([^\s@]{1,50})$/);
    if (!mentionMatch) {
      return null;
    }
    let end = caretEnd;
    while (end < value.length && !/\s/.test(value.charAt(end))) {
      end += 1;
    }
    return {end, query: mentionMatch[2], start: caretStart - mentionMatch[2].length - 1};
  }

  async function loadCommentMentionSuggestions(mention) {
    const requestId = getCommentMentionRequestId() + 1;
    setCommentMentionRequestId(requestId);
    try {
      const suggestions = await searchCommentMentionCandidates(mention.query);
      if (requestId !== getCommentMentionRequestId()) {
        return;
      }
      setCommentMentionState({error: '', loading: false, query: mention.query, range: mention, selectedIndex: 0, suggestions, visible: true});
    } catch (error) {
      if (requestId !== getCommentMentionRequestId()) {
        return;
      }
      setCommentMentionState({error: 'Could not load people.', loading: false, query: mention.query, range: mention, selectedIndex: 0, suggestions: [], visible: true});
    }
    renderCommentMentionSuggestions();
  }

  const debouncedLoadCommentMentionSuggestions = debounce(function (mention) {
    loadCommentMentionSuggestions(mention).catch(() => {});
  }, 150);

  function syncCommentMentionSuggestions(inputElement) {
    const mention = getActiveCommentMention(inputElement);
    if (!mention) {
      resetCommentMentionState();
      return;
    }
    setCommentMentionState({error: '', loading: true, query: mention.query, range: mention, selectedIndex: 0, suggestions: [], visible: true});
    renderCommentMentionSuggestions();
    debouncedLoadCommentMentionSuggestions(mention);
  }

  function moveCommentMentionSelection(delta) {
    const commentMentionState = getCommentMentionState();
    if (!commentMentionState.visible || !commentMentionState.suggestions.length) {
      return;
    }
    const suggestionsTotal = commentMentionState.suggestions.length;
    const nextIndex = (commentMentionState.selectedIndex + delta + suggestionsTotal) % suggestionsTotal;
    setCommentMentionState({...commentMentionState, selectedIndex: nextIndex});
    renderCommentMentionSuggestions();
  }

  function applyCommentMentionSelection(index) {
    const {input} = getCommentComposerElements();
    const inputElement = input.get(0);
    const commentMentionState = getCommentMentionState();
    const candidate = commentMentionState.suggestions[index];
    const mentionRange = commentMentionState.range;
    if (!inputElement || !candidate || !mentionRange) {
      return;
    }
    const nextValue = inputElement.value.slice(0, mentionRange.start) + `${candidate.mentionMarkup} ` + inputElement.value.slice(mentionRange.end);
    input.val(nextValue);
    setCommentComposerDraftValue(nextValue);
    inputElement.focus();
    const caretPosition = mentionRange.start + candidate.mentionMarkup.length + 1;
    inputElement.setSelectionRange(caretPosition, caretPosition);
    resetCommentMentionState();
    syncCommentComposerState();
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
    applyCommentMentionSelection,
    captureCommentComposerDraft,
    discardCommentComposerDraft,
    getClipboardImageFiles,
    renderCommentMentionSuggestions,
    renderCommentUploads,
    resetCommentMentionState,
    restoreCommentComposerDraft,
    restoreCommentComposerState,
    setCommentComposerError,
    syncCommentComposerState,
    syncCommentMentionSuggestions,
    uploadPastedImage,
    moveCommentMentionSelection,
  };
}
