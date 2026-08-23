import {createCommentFormatting} from 'src/comment-lifecycle/comment-formatting';

function copyValue(value) {
  if (Array.isArray(value)) return value.map(copyValue);
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce((copy, [key, entry]) => {
      copy[key] = copyValue(entry);
      return copy;
    }, {});
  }
  return value;
}

const COMMENT_REACTION_OPTIONS = [
  {emoji: '👍', emojiId: '1f44d', label: 'thumbs up'},
  {emoji: '👎', emojiId: '1f44e', label: 'thumbs down'},
  {emoji: '🔥', emojiId: '1f525', label: 'fire'},
  {emoji: '😍', emojiId: '1f60d', label: 'heart eyes'},
  {emoji: '😂', emojiId: '1f602', label: 'joy'},
  {emoji: '😢', emojiId: '1f622', label: 'cry'},
];

function normalizeInstanceUrl(value) {
  const instanceUrl = String(value || '').trim();
  return instanceUrl && !instanceUrl.endsWith('/') ? `${instanceUrl}/` : instanceUrl;
}

function toAbsoluteUrl(value, instanceUrl) {
  if (!value) return '';
  try {
    return new URL(String(value), instanceUrl).toString();
  } catch (error) {
    return String(value);
  }
}

function normalizeFailure(error, fallback = 'Comment operation failed') {
  return {
    name: String(error?.name || 'Error'),
    message: String(error?.message || error?.inner || error || fallback),
  };
}

function normalizeSelection(selection, value) {
  const maxIndex = String(value || '').length;
  const start = Number.isInteger(selection?.start) ? selection.start : maxIndex;
  const end = Number.isInteger(selection?.end) ? selection.end : start;
  return {
    start: Math.max(0, Math.min(maxIndex, start)),
    end: Math.max(0, Math.min(maxIndex, end)),
  };
}

function emptyComposeState() {
  return {
    value: '',
    mentionMappings: [],
    selection: {start: 0, end: 0},
    focused: false,
    saving: false,
    errorMessage: '',
    mention: emptyMentionState(),
    uploads: [],
  };
}

function pastedImageExtension(file) {
  const extensionByMimeType = {
    'image/bmp': 'bmp',
    'image/gif': 'gif',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };
  return extensionByMimeType[String(file?.type || '').toLowerCase()] || 'png';
}

function uploadTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  const usableDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return usableDate.toISOString().replace(/[^\d]/g, '').slice(0, 14);
}

function insertImageMarkup(value, selection, markup) {
  const text = String(value || '');
  const normalizedSelection = normalizeSelection(selection, text);
  const prefix = normalizedSelection.start > 0 && text.charAt(normalizedSelection.start - 1) !== '\n' ? '\n' : '';
  const suffix = normalizedSelection.end < text.length
    ? (text.charAt(normalizedSelection.end) !== '\n' ? '\n' : '')
    : '\n';
  const insertedText = `${prefix}${markup}${suffix}`;
  const nextValue = text.slice(0, normalizedSelection.start) + insertedText + text.slice(normalizedSelection.end);
  const caret = normalizedSelection.start + insertedText.length;
  return {value: nextValue, selection: {start: caret, end: caret}};
}

function replaceFirstMarkup(value, searchValue, replaceValue = '') {
  const text = String(value || '');
  const index = text.indexOf(searchValue);
  if (index === -1) return {value: text, delta: 0};
  const nextValue = (text.slice(0, index) + replaceValue + text.slice(index + searchValue.length)).replace(/\n{3,}/g, '\n\n');
  return {value: nextValue, delta: replaceValue.length - searchValue.length};
}

function removeMarkupLine(value, markup) {
  const text = String(value || '');
  const index = text.indexOf(markup);
  if (index === -1) return text;
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const newlineIndex = text.indexOf('\n', index + markup.length);
  const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
  if (text.slice(lineStart, lineEnd).trim() === markup) {
    return text.slice(0, lineStart) + text.slice(newlineIndex === -1 ? lineEnd : lineEnd + 1);
  }
  return replaceFirstMarkup(text, markup, '').value;
}

function emptyMentionState() {
  return {
    visible: false,
    loading: false,
    errorMessage: '',
    query: '',
    range: null,
    selectedIndex: 0,
    suggestions: [],
    requestId: 0,
  };
}

function activeMention(value, selection) {
  const text = String(value || '');
  const normalizedSelection = normalizeSelection(selection, text);
  if (normalizedSelection.start !== normalizedSelection.end) return null;
  const beforeCaret = text.slice(0, normalizedSelection.start);
  const match = beforeCaret.match(/(^|[\s(])@([^\s@]{1,50})$/);
  if (!match) return null;
  let end = normalizedSelection.end;
  while (end < text.length && !/\s/.test(text.charAt(end))) end += 1;
  return {start: normalizedSelection.start - match[2].length - 1, end, query: match[2]};
}

function mentionCandidate(user) {
  const username = String(user?.name || user?.username || '').trim();
  const accountId = String(user?.accountId || '').trim();
  const mentionMarkup = username ? `[~${username}]` : (accountId ? `[~accountid:${accountId}]` : '');
  if (!mentionMarkup) return null;
  const displayName = String(user?.displayName || username || user?.emailAddress || 'Unknown user');
  return {
    displayName,
    displayText: `@${displayName}`,
    mentionMarkup,
    secondaryText: username && username !== displayName
      ? `@${username}`
      : ((user?.emailAddress && user.emailAddress !== displayName) ? String(user.emailAddress) : ''),
  };
}

function mentionCandidates(users) {
  const seen = new Set();
  return (Array.isArray(users) ? users : []).map(mentionCandidate).filter(candidate => {
    if (!candidate || seen.has(candidate.mentionMarkup)) return false;
    seen.add(candidate.mentionMarkup);
    return true;
  }).slice(0, 6);
}

function reactionStateFromSnapshot(issueSnapshot, fallback = null) {
  const section = issueSnapshot?.sections?.reactions;
  if (!section || !['ready', 'empty'].includes(section.status)) {
    return fallback || {byCommentId: {}, errorsByCommentId: {}, supported: section?.supported !== false};
  }
  return {
    byCommentId: copyValue(section.byCommentId || {}),
    errorsByCommentId: {},
    supported: section.supported !== false,
  };
}

function reactionEntry(reactions, commentId, emojiId) {
  return reactions?.byCommentId?.[String(commentId)]?.[String(emojiId)] || {};
}

function projectReactionComment(reactions, commentId) {
  if (!reactions.supported) return {errorMessage: '', pills: [], menuOptions: []};
  const pills = [];
  const menuOptions = COMMENT_REACTION_OPTIONS.map(option => {
    const entry = reactionEntry(reactions, commentId, option.emojiId);
    const count = Number(entry.count) || 0;
    const reacted = !!entry.reacted;
    const pending = !!entry.pending;
    if (count > 0) {
      pills.push({
        commentId,
        emoji: option.emoji,
        emojiId: option.emojiId,
        count,
        reacted,
        pending,
        title: pending ? `${option.label}...` : `${option.label} (${count})`,
        disabledAttr: pending ? 'disabled' : '',
      });
    }
    return {
      commentId,
      emoji: option.emoji,
      emojiId: option.emojiId,
      label: option.label,
      title: pending ? `${option.label}...` : option.label,
      isReacted: reacted,
      isPending: pending,
      disabledAttr: pending ? 'disabled' : '',
    };
  });
  return {
    errorMessage: reactions.errorsByCommentId[String(commentId)] || '',
    pills,
    menuOptions,
  };
}

function isUnsupportedReactionFailure(error) {
  const message = String(error?.message || error?.inner || error || '');
  return /http\s+(401|403|404|405)\b/i.test(message) || /forbidden|not found|method not allowed/i.test(message);
}

export function createCommentLifecycle(options = {}) {
  const jira = options.jira;
  const issueData = options.issueData;
  if (!jira || typeof jira.write !== 'function') throw new Error('CommentLifecycle requires a Jira adapter');
  if (!issueData || typeof issueData.refreshAfterMutation !== 'function') {
    throw new Error('CommentLifecycle requires QuickViewIssueData');
  }

  const instanceUrl = normalizeInstanceUrl(options.instanceUrl);
  const scheduler = options.scheduler && typeof options.scheduler.wait === 'function'
    ? options.scheduler
    : {wait: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))};
  const clock = typeof options.clock === 'function' ? options.clock : () => new Date();
  const commentFormatting = createCommentFormatting({
    clock,
    formatting: options.formatting,
    instanceUrl,
  });
  const attachmentMedia = options.attachmentMedia || {createPreview: () => '', revokePreview() {}};
  let generation = 0;
  let uploadSequence = 0;
  let state = null;
  const activeOperations = {compose: null, composeMention: null, rowAction: null, rowMention: null};
  const reactionOperations = new Map();

  function isCurrent(identity) {
    return !!state && state.sessionId === identity.sessionId && state.issueKey === identity.issueKey && state.generation === identity.generation;
  }

  function identityOf(currentState = state) {
    return currentState ? {
      sessionId: currentState.sessionId,
      issueKey: currentState.issueKey,
      generation: currentState.generation,
    } : {sessionId: '', issueKey: '', generation};
  }

  function outcome(kind, details = {}, identity = identityOf()) {
    return {
      kind,
      ...identity,
      ...details,
      view: view(),
    };
  }

  async function refreshCommentViews(identity = identityOf()) {
    const commentViews = await commentFormatting.projectComments(state?.issueSnapshot);
    if (!isCurrent(identity)) return false;
    state.commentViews = commentViews;
    return true;
  }

  async function attach({sessionId, issueSnapshot} = {}) {
    const previousUploads = state?.compose?.uploads || [];
    Object.values(activeOperations).forEach(controller => controller?.abort());
    reactionOperations.forEach(controller => controller.abort());
    reactionOperations.clear();
    activeOperations.compose = null;
    activeOperations.composeMention = null;
    activeOperations.rowAction = null;
    activeOperations.rowMention = null;
    releaseUploads(previousUploads, {deleteUploaded: true}).catch(() => {});
    const issueKey = String(issueSnapshot?.issueKey || issueSnapshot?.core?.key || '').trim();
    generation += 1;
    state = {
      sessionId: String(sessionId || ''),
      issueKey,
      generation,
      issueSnapshot: copyValue(issueSnapshot || null),
      commentViews: [],
      compose: emptyComposeState(),
      reactions: reactionStateFromSnapshot(issueSnapshot),
      rowAction: null,
    };
    const identity = identityOf();
    if (!await refreshCommentViews(identity)) return outcome('ignored', {}, identity);
    return outcome('attached');
  }

  function detach({sessionId} = {}) {
    if (!state || (sessionId && String(sessionId) !== state.sessionId)) return outcome('ignored');
    const detachedIdentity = identityOf();
    const detachedUploads = state.compose.uploads;
    Object.values(activeOperations).forEach(controller => controller?.abort());
    reactionOperations.forEach(controller => controller.abort());
    reactionOperations.clear();
    activeOperations.compose = null;
    activeOperations.composeMention = null;
    activeOperations.rowAction = null;
    activeOperations.rowMention = null;
    generation += 1;
    state = null;
    releaseUploads(detachedUploads, {deleteUploaded: true}).catch(() => {});
    return outcome('detached', {}, detachedIdentity);
  }

  function projectMention(mention) {
    return {
      visible: mention.visible,
      loading: mention.loading,
      errorMessage: mention.errorMessage,
      query: mention.query,
      range: copyValue(mention.range),
      selectedIndex: mention.selectedIndex,
      suggestions: copyValue(mention.suggestions),
    };
  }

  function projectCommentView(comment) {
    const commentId = String(comment.id || '');
    const rowAction = state.rowAction?.commentId === commentId ? state.rowAction : null;
    const isEditing = rowAction?.mode === 'edit';
    const isDeleteConfirming = rowAction?.mode === 'delete';
    const editDraft = rowAction ? String(rowAction.draft ?? comment.bodyRaw ?? '') : String(comment.bodyRaw || '');
    const busy = !!rowAction?.saving;
    const reactionUi = projectReactionComment(state.reactions, commentId);
    return {
      ...comment,
      commentActionBusy: busy,
      commentActionError: rowAction?.errorMessage || '',
      commentDeleteCancelDisabled: busy,
      commentDeleteCancelText: 'No',
      commentDeleteConfirmDisabled: busy,
      commentDeleteConfirmText: busy ? 'Deleting...' : 'Yes',
      commentEditCancelDisabled: busy,
      commentEditDraft: editDraft,
      commentEditSaveDisabled: !editDraft.trim() || busy,
      commentEditSaveText: busy ? 'Saving...' : 'Save',
      hasReactionOptions: reactionUi.menuOptions.length > 0,
      hasReactionPills: reactionUi.pills.length > 0,
      isDeleteConfirming,
      isEditing,
      menuReactionOptions: reactionUi.menuOptions,
      reactionError: reactionUi.errorMessage,
      reactionPills: reactionUi.pills,
      showCommentDefaultActions: comment.isOwnedByCurrentUser && !isEditing && !isDeleteConfirming,
      showCommentDeleteHeaderActions: comment.isOwnedByCurrentUser && isDeleteConfirming,
      showCommentEditHeaderActions: comment.isOwnedByCurrentUser && isEditing,
    };
  }

  function view() {
    if (!state) return {sessionId: '', issueKey: '', generation, comments: [], compose: null, reactions: {supported: false, byCommentId: {}}, rowAction: null, protectFromAutoHide: false};
    const compose = state.compose;
    const commentIds = new Set([
      ...(state.issueSnapshot?.core?.fields?.comment?.comments || []).map(comment => String(comment?.id || '')).filter(Boolean),
      ...Object.keys(state.reactions.byCommentId || {}),
    ]);
    const reactionsByCommentId = {};
    commentIds.forEach(commentId => {
      reactionsByCommentId[commentId] = projectReactionComment(state.reactions, commentId);
    });
    return {
      sessionId: state.sessionId,
      issueKey: state.issueKey,
      generation: state.generation,
      comments: state.commentViews.map(projectCommentView),
      compose: {
        value: compose.value,
        selection: copyValue(compose.selection),
        focused: compose.focused,
        saving: compose.saving,
        errorMessage: compose.errorMessage,
        canSave: !!compose.value.trim() && !compose.saving && !compose.uploads.some(upload => upload.status === 'uploading'),
        mention: projectMention(compose.mention),
        uploads: compose.uploads.map(upload => ({
          attachmentId: upload.attachmentId,
          canRetry: upload.status === 'error',
          contentUrl: upload.contentUrl,
          displayUrl: upload.displayUrl,
          errorMessage: upload.errorMessage,
          fileName: upload.fileName,
          localId: upload.localId,
          previewUrl: upload.previewUrl,
          status: upload.status,
          thumbnailUrl: upload.thumbnailUrl,
        })),
      },
      reactions: {
        supported: state.reactions.supported,
        byCommentId: reactionsByCommentId,
      },
      rowAction: state.rowAction ? {
        commentId: state.rowAction.commentId,
        mode: state.rowAction.mode,
        draft: state.rowAction.draft,
        selection: copyValue(state.rowAction.selection),
        saving: state.rowAction.saving,
        errorMessage: state.rowAction.errorMessage,
        canSave: state.rowAction.mode === 'edit' && !!state.rowAction.draft.trim() && !state.rowAction.saving,
        mention: projectMention(state.rowAction.mention),
      } : null,
      protectFromAutoHide: !!compose.value || compose.saving || !!compose.uploads.length || !!state.rowAction,
    };
  }

  function setReactionEntry(commentId, emojiId, changes) {
    const normalizedCommentId = String(commentId);
    const normalizedEmojiId = String(emojiId);
    const currentComment = state.reactions.byCommentId[normalizedCommentId] || {};
    state.reactions = {
      ...state.reactions,
      byCommentId: {
        ...state.reactions.byCommentId,
        [normalizedCommentId]: {
          ...currentComment,
          [normalizedEmojiId]: {...(currentComment[normalizedEmojiId] || {}), ...changes},
        },
      },
    };
  }

  function setReactionError(commentId, message) {
    state.reactions = {
      ...state.reactions,
      errorsByCommentId: {...state.reactions.errorsByCommentId, [String(commentId)]: String(message || '')},
    };
  }

  async function toggleReaction(intent) {
    const commentId = String(intent.commentId || '');
    const emojiId = String(intent.emojiId || '');
    if (!state?.reactions?.supported || !commentId || !COMMENT_REACTION_OPTIONS.some(option => option.emojiId === emojiId)) {
      return outcome('ignored');
    }
    const current = reactionEntry(state.reactions, commentId, emojiId);
    if (current.pending) return outcome('ignored');
    const identity = identityOf();
    const operationKey = `${commentId}:${emojiId}`;
    const controller = new AbortController();
    reactionOperations.get(operationKey)?.abort();
    reactionOperations.set(operationKey, controller);
    const wasReacted = !!current.reacted;
    const oldCount = Number(current.count) || 0;
    setReactionError(commentId, '');
    setReactionEntry(commentId, emojiId, {
      count: wasReacted ? Math.max(0, oldCount - 1) : oldCount + 1,
      reacted: !wasReacted,
      pending: true,
    });
    try {
      await jira.write(wasReacted ? {
        method: 'DELETE',
        path: `${instanceUrl}rest/internal/2/reactions?commentId=${encodeURIComponent(commentId)}&emojiId=${encodeURIComponent(emojiId)}`,
        headers: {'X-Atlassian-Token': 'no-check'},
        signal: controller.signal,
      } : {
        method: 'POST',
        path: `${instanceUrl}rest/internal/2/reactions`,
        body: {commentId, emojiId},
        headers: {'X-Atlassian-Token': 'no-check'},
        signal: controller.signal,
      });
      if (!isCurrent(identity)) return outcome('ignored', {}, identity);
      const mutation = {kind: 'reactionChanged', commentIds: [commentId]};
      const refreshed = await issueData.refreshAfterMutation({
        issueKey: identity.issueKey,
        priorSnapshot: copyValue(state.issueSnapshot),
        mutation,
        requirements: {reactions: true},
        signal: controller.signal,
      });
      if (!isCurrent(identity)) return outcome('ignored', {}, identity);
      state.issueSnapshot = copyValue(refreshed.snapshot || state.issueSnapshot);
      state.reactions = reactionStateFromSnapshot(refreshed.snapshot, state.reactions);
      setReactionEntry(commentId, emojiId, {pending: false});
      reactionOperations.delete(operationKey);
      const failure = refreshed.failures?.reactions || null;
      return outcome('mutationCommitted', {
        mutation,
        refreshedSnapshot: copyValue(refreshed.snapshot || null),
        failure: copyValue(failure),
        notice: failure ? 'Reaction updated; refresh unavailable' : 'Reaction updated',
        writeCommitted: true,
      }, identity);
    } catch (error) {
      if (!isCurrent(identity)) return outcome('ignored', {}, identity);
      reactionOperations.delete(operationKey);
      if (!wasReacted && isUnsupportedReactionFailure(error)) {
        state.reactions = {...state.reactions, supported: false};
        return outcome('unsupported', {notice: 'Comment reactions are not available in this Jira context'}, identity);
      }
      const failure = normalizeFailure(error, 'Could not update reaction');
      setReactionEntry(commentId, emojiId, {count: oldCount, reacted: wasReacted, pending: false});
      setReactionError(commentId, failure.message);
      return outcome('failed', {failure}, identity);
    }
  }

  async function deleteUploadedAttachment(attachmentId) {
    if (!attachmentId) return null;
    try {
      await jira.write({
        method: 'DELETE',
        path: `${instanceUrl}rest/api/2/attachment/${encodeURIComponent(attachmentId)}`,
      });
      return null;
    } catch (error) {
      return normalizeFailure(error, 'Could not delete draft attachment');
    }
  }

  async function releaseUploads(uploads, {deleteUploaded = false} = {}) {
    const items = Array.isArray(uploads) ? uploads : [];
    const previewFailures = [];
    items.forEach(item => {
      if (!item.previewUrl) return;
      try {
        attachmentMedia.revokePreview(item.previewUrl);
      } catch (error) {
        previewFailures.push(normalizeFailure(error, 'Could not release attachment preview'));
      }
    });
    if (!deleteUploaded) return previewFailures;
    const failures = await Promise.all(items
      .filter(item => item.attachmentId)
      .map(item => deleteUploadedAttachment(item.attachmentId)));
    return [...previewFailures, ...failures.filter(Boolean)];
  }

  function uploadItem(localId) {
    return state?.compose?.uploads?.find(item => item.localId === localId) || null;
  }

  function updateUpload(localId, changes) {
    if (!state) return;
    state.compose = {
      ...state.compose,
      uploads: state.compose.uploads.map(item => item.localId === localId ? {...item, ...changes} : item),
    };
  }

  function renamedUploadFile(file, fileName) {
    if (typeof File === 'function') {
      return new File([file], fileName, {type: file?.type || 'image/png'});
    }
    return {...file, name: fileName};
  }

  async function runUpload(localId, identity, {insertMarkup = false} = {}) {
    let item = uploadItem(localId);
    if (!item || !isCurrent(identity)) return outcome('ignored', {}, identity);
    if (insertMarkup && !state.compose.value.includes(item.markup)) {
      const inserted = insertImageMarkup(state.compose.value, state.compose.selection, item.markup);
      state.compose = {...state.compose, ...inserted};
    }
    updateUpload(localId, {attachmentId: '', errorMessage: '', status: 'uploading'});
    state.compose = {...state.compose, errorMessage: ''};
    item = uploadItem(localId);
    try {
      const result = await jira.upload({
        path: `${instanceUrl}rest/api/2/issue/${encodeURIComponent(identity.issueKey)}/attachments`,
        file: renamedUploadFile(item.file, item.fileName),
      });
      const attachment = (Array.isArray(result) ? result : [result]).find(candidate => candidate?.id);
      if (!attachment) throw new Error('Attachment upload failed');
      if (!isCurrent(identity) || !uploadItem(localId)) {
        await deleteUploadedAttachment(String(attachment.id));
        return outcome('ignored', {}, identity);
      }
      const currentItem = uploadItem(localId);
      const nextFileName = String(attachment.filename || currentItem.fileName);
      const nextMarkup = `!${nextFileName}!`;
      if (nextMarkup !== currentItem.markup) {
        const replaced = replaceFirstMarkup(state.compose.value, currentItem.markup, nextMarkup);
        const selection = normalizeSelection({
          start: state.compose.selection.start + replaced.delta,
          end: state.compose.selection.end + replaced.delta,
        }, replaced.value);
        state.compose = {...state.compose, value: replaced.value, selection};
      }
      const uploadedAttachment = {
        ...copyValue(attachment),
        id: String(attachment.id),
        filename: nextFileName,
        content: toAbsoluteUrl(attachment.content, instanceUrl),
        thumbnail: toAbsoluteUrl(attachment.thumbnail || attachment.content, instanceUrl),
        displayContent: currentItem.previewUrl,
      };
      updateUpload(localId, {
        attachmentId: uploadedAttachment.id,
        contentUrl: uploadedAttachment.content,
        errorMessage: '',
        fileName: nextFileName,
        markup: nextMarkup,
        status: 'uploaded',
        thumbnailUrl: uploadedAttachment.thumbnail,
      });
      return outcome('attachmentUploaded', {uploadedAttachment}, identity);
    } catch (error) {
      if (!isCurrent(identity) || !uploadItem(localId)) return outcome('ignored', {}, identity);
      const currentItem = uploadItem(localId);
      const nextValue = removeMarkupLine(state.compose.value, currentItem.markup);
      const failure = normalizeFailure(error, 'Could not upload pasted image');
      state.compose = {
        ...state.compose,
        value: nextValue,
        selection: normalizeSelection(state.compose.selection, nextValue),
        errorMessage: failure.message,
      };
      updateUpload(localId, {errorMessage: failure.message, status: 'error'});
      return outcome('failed', {failure}, identity);
    }
  }

  function startImageUpload(file) {
    if (!file || !state?.issueKey) return outcome('ignored');
    const identity = identityOf();
    uploadSequence += 1;
    const fileName = `pasted-image-${uploadTimestamp(clock())}-${uploadSequence}.${pastedImageExtension(file)}`;
    const markup = `!${fileName}!`;
    const localId = `upload-${uploadSequence}`;
    const previewUrl = String(attachmentMedia.createPreview(file) || '');
    const inserted = insertImageMarkup(state.compose.value, state.compose.selection, markup);
    state.compose = {
      ...state.compose,
      ...inserted,
      errorMessage: '',
      uploads: [...state.compose.uploads, {
        attachmentId: '',
        contentUrl: '',
        displayUrl: previewUrl,
        errorMessage: '',
        file,
        fileName,
        localId,
        markup,
        previewUrl,
        status: 'uploading',
        thumbnailUrl: '',
      }],
    };
    return runUpload(localId, identity);
  }

  async function discardCompose(intent) {
    const uploads = state.compose.uploads;
    state.compose = emptyComposeState();
    const cleanupFailures = await releaseUploads(uploads, {deleteUploaded: intent.deleteUploaded !== false});
    return outcome('changed', {cleanupFailures});
  }

  function mentionLane(lane) {
    if (lane === 'compose') return state?.compose || null;
    if (lane === 'edit' && state?.rowAction?.mode === 'edit') return state.rowAction;
    return null;
  }

  function setLaneMention(lane, mention) {
    if (lane === 'compose' && state) state.compose = {...state.compose, mention};
    if (lane === 'edit' && state?.rowAction?.mode === 'edit') state.rowAction = {...state.rowAction, mention};
  }

  function laneValue(lane) {
    const laneState = mentionLane(lane);
    return lane === 'compose' ? laneState?.value : laneState?.draft;
  }

  function laneOperationName(lane) {
    return lane === 'compose' ? 'composeMention' : 'rowMention';
  }

  async function syncMention(lane) {
    const laneState = mentionLane(lane);
    if (!laneState) return outcome('ignored');
    const mention = activeMention(laneValue(lane), laneState.selection);
    const operationName = laneOperationName(lane);
    if (!mention) {
      activeOperations[operationName]?.abort();
      activeOperations[operationName] = null;
      setLaneMention(lane, emptyMentionState());
      return outcome('changed');
    }
    const identity = identityOf();
    const requestId = (laneState.mention?.requestId || 0) + 1;
    const controller = new AbortController();
    activeOperations[operationName]?.abort();
    activeOperations[operationName] = controller;
    setLaneMention(lane, {
      ...emptyMentionState(),
      visible: true,
      loading: true,
      query: mention.query,
      range: mention,
      requestId,
    });
    await scheduler.wait(150);
    const latestLane = mentionLane(lane);
    if (!isCurrent(identity) || latestLane?.mention?.requestId !== requestId) return outcome('ignored', {}, identity);
    let search;
    try {
      search = await issueData.search({
        purpose: 'userPicker',
        issueKey: identity.issueKey,
        query: mention.query,
        signal: controller.signal,
      });
    } catch (error) {
      search = {kind: 'failed', failure: normalizeFailure(error, 'Could not search Jira users')};
    }
    const currentLane = mentionLane(lane);
    if (!isCurrent(identity) || currentLane?.mention?.requestId !== requestId) return outcome('ignored', {}, identity);
    const failure = search.kind === 'failed' ? search.failure : null;
    setLaneMention(lane, {
      ...currentLane.mention,
      loading: false,
      errorMessage: failure ? 'Could not load people.' : '',
      suggestions: failure ? [] : mentionCandidates(search.items),
      selectedIndex: 0,
    });
    activeOperations[operationName] = null;
    return outcome('changed');
  }

  function moveMention(lane, delta) {
    const laneState = mentionLane(lane);
    const mention = laneState?.mention;
    if (!mention?.visible || !mention.suggestions.length) return outcome('ignored');
    const selectedIndex = (mention.selectedIndex + Number(delta || 0) + mention.suggestions.length) % mention.suggestions.length;
    setLaneMention(lane, {...mention, selectedIndex});
    return outcome('changed');
  }

  function chooseMention(lane, index) {
    const laneState = mentionLane(lane);
    const mention = laneState?.mention;
    const candidate = mention?.suggestions?.[Number.isInteger(index) ? index : mention?.selectedIndex];
    if (!candidate || !mention?.range) return outcome('ignored');
    const value = String(laneValue(lane) || '');
    const nextValue = value.slice(0, mention.range.start) + `${candidate.displayText} ` + value.slice(mention.range.end);
    const selection = {
      start: mention.range.start + candidate.displayText.length + 1,
      end: mention.range.start + candidate.displayText.length + 1,
    };
    const mapping = {
      displayText: candidate.displayText,
      markup: candidate.mentionMarkup,
      start: mention.range.start,
      beforeContext: nextValue.slice(Math.max(0, mention.range.start - 24), mention.range.start),
      afterContext: nextValue.slice(mention.range.start + candidate.displayText.length,
        mention.range.start + candidate.displayText.length + 24),
    };
    if (lane === 'compose') {
      state.compose = {
        ...state.compose,
        value: nextValue,
        selection,
        mentionMappings: [...state.compose.mentionMappings, mapping],
        mention: emptyMentionState(),
      };
    } else {
      state.rowAction = {
        ...state.rowAction,
        draft: nextValue,
        selection,
        mentionMappings: [...state.rowAction.mentionMappings, mapping],
        mention: emptyMentionState(),
      };
    }
    activeOperations[laneOperationName(lane)]?.abort();
    activeOperations[laneOperationName(lane)] = null;
    return outcome('changed');
  }

  async function saveNewComment(intent) {
    if (!state?.issueKey || state.compose.saving || !state.compose.value.trim() || state.compose.uploads.some(upload => upload.status === 'uploading')) {
      return outcome('ignored');
    }
    const identity = identityOf();
    const priorSnapshot = copyValue(state.issueSnapshot);
    const value = state.compose.value.trim();
    const body = commentFormatting.restoreMentionMarkup(value, state.compose.mentionMappings);
    const controller = new AbortController();
    activeOperations.compose?.abort();
    activeOperations.compose = controller;
    state.compose = {...state.compose, value, saving: true, errorMessage: ''};
    try {
      await jira.write({
        method: 'POST',
        path: `${instanceUrl}rest/api/2/issue/${encodeURIComponent(identity.issueKey)}/comment`,
        body: {body},
        signal: controller.signal,
      });
      if (!isCurrent(identity)) return outcome('ignored', {}, identity);
      const mutation = {kind: 'commentChanged'};
      const refreshed = await issueData.refreshAfterMutation({
        issueKey: identity.issueKey,
        priorSnapshot,
        mutation,
        requirements: {...copyValue(intent.requirements || {}), reactions: true, viewer: true},
        signal: controller.signal,
      });
      if (!isCurrent(identity)) return outcome('ignored', {}, identity);
      state.issueSnapshot = copyValue(refreshed.snapshot || state.issueSnapshot);
      if (refreshed.snapshot?.core && !await refreshCommentViews(identity)) return outcome('ignored', {}, identity);
      const completedUploads = state.compose.uploads;
      state.compose = emptyComposeState();
      await releaseUploads(completedUploads, {deleteUploaded: false});
      activeOperations.compose = null;
      const refreshFailure = !refreshed.snapshot?.core
        ? copyValue(refreshed.failures?.core || {name: 'Error', message: 'Could not refresh issue'})
        : null;
      return outcome('mutationCommitted', {
        mutation,
        notice: refreshFailure ? 'Comment added; refresh unavailable' : 'Comment added',
        refreshedSnapshot: copyValue(refreshed.snapshot || null),
        refreshKind: refreshed.kind,
        failure: refreshFailure,
        writeCommitted: true,
      }, identity);
    } catch (error) {
      if (!isCurrent(identity)) return outcome('ignored', {}, identity);
      const failure = normalizeFailure(error, 'Could not save comment');
      state.compose = {...state.compose, saving: false, errorMessage: failure.message};
      activeOperations.compose = null;
      return outcome('failed', {failure}, identity);
    }
  }

  function issueComment(commentId) {
    const normalizedId = String(commentId || '');
    return (state?.issueSnapshot?.core?.fields?.comment?.comments || [])
      .find(comment => String(comment?.id || '') === normalizedId) || null;
  }

  async function commitRowAction(intent, {method, body, notice}) {
    const rowAction = state?.rowAction;
    const commentId = String(intent.commentId || '');
    if (!rowAction || rowAction.commentId !== commentId || rowAction.saving) return outcome('ignored');
    if (rowAction.mode === 'edit' && !rowAction.draft.trim()) {
      state.rowAction = {...rowAction, errorMessage: 'Comment cannot be empty.'};
      return outcome('failed', {failure: {name: 'Error', message: 'Comment cannot be empty.'}});
    }
    const identity = identityOf();
    const priorSnapshot = copyValue(state.issueSnapshot);
    const controller = new AbortController();
    activeOperations.rowAction?.abort();
    activeOperations.rowAction = controller;
    state.rowAction = {...rowAction, saving: true, errorMessage: ''};
    const mutation = {kind: 'commentChanged'};
    try {
      await jira.write({
        method,
        path: `${instanceUrl}rest/api/2/issue/${encodeURIComponent(identity.issueKey)}/comment/${encodeURIComponent(commentId)}`,
        body,
        signal: controller.signal,
      });
      if (!isCurrent(identity)) return outcome('ignored', {}, identity);
      const refreshed = await issueData.refreshAfterMutation({
        issueKey: identity.issueKey,
        priorSnapshot,
        mutation,
        requirements: {...copyValue(intent.requirements || {}), reactions: true, viewer: true},
        signal: controller.signal,
      });
      if (!isCurrent(identity)) return outcome('ignored', {}, identity);
      state.issueSnapshot = copyValue(refreshed.snapshot || state.issueSnapshot);
      if (refreshed.snapshot?.core && !await refreshCommentViews(identity)) return outcome('ignored', {}, identity);
      state.rowAction = null;
      activeOperations.rowAction = null;
      const refreshFailure = !refreshed.snapshot?.core
        ? copyValue(refreshed.failures?.core || {name: 'Error', message: 'Could not refresh issue'})
        : null;
      return outcome('mutationCommitted', {
        mutation,
        notice: refreshFailure ? `${notice}; refresh unavailable` : notice,
        refreshedSnapshot: copyValue(refreshed.snapshot || null),
        refreshKind: refreshed.kind,
        failure: refreshFailure,
        writeCommitted: true,
      }, identity);
    } catch (error) {
      if (!isCurrent(identity)) return outcome('ignored', {}, identity);
      const failure = normalizeFailure(error);
      state.rowAction = {...state.rowAction, saving: false, errorMessage: failure.message};
      activeOperations.rowAction = null;
      return outcome('failed', {failure}, identity);
    }
  }

  async function dispatch(intent = {}) {
    if (!state) return outcome('ignored');
    if (intent.type === 'composeChanged') {
      const value = String(intent.value || '');
      state.compose = {
        ...state.compose,
        value,
        selection: normalizeSelection(intent.selection, value),
        errorMessage: '',
      };
      return syncMention('compose');
    }
    if (intent.type === 'composeFocusChanged') {
      state.compose = {...state.compose, focused: !!intent.focused};
      return outcome('changed');
    }
    if (intent.type === 'saveNewComment') return saveNewComment(intent);
    if (intent.type === 'toggleReaction') return toggleReaction(intent);
    if (intent.type === 'imagePasted') return startImageUpload(intent.file);
    if (intent.type === 'retryUpload') {
      const item = uploadItem(String(intent.localId || ''));
      if (!item || item.status !== 'error') return outcome('ignored');
      return runUpload(item.localId, identityOf(), {insertMarkup: true});
    }
    if (intent.type === 'discardCompose') return discardCompose(intent);
    if (intent.type === 'startEdit') {
      const comment = issueComment(intent.commentId);
      if (!comment) return outcome('ignored');
      const editable = commentFormatting.buildEditableDraft(comment.body, state.issueSnapshot);
      state.rowAction = {
        commentId: String(comment.id),
        mode: 'edit',
        draft: editable.draft,
        mentionMappings: editable.mentionMappings,
        selection: {start: editable.draft.length, end: editable.draft.length},
        saving: false,
        errorMessage: '',
        mention: emptyMentionState(),
      };
      return outcome('changed');
    }
    if (intent.type === 'editChanged') {
      const commentId = String(intent.commentId || '');
      if (!state.rowAction || state.rowAction.mode !== 'edit' || state.rowAction.commentId !== commentId || state.rowAction.saving) {
        return outcome('ignored');
      }
      const draft = String(intent.value || '');
      state.rowAction = {
        ...state.rowAction,
        draft,
        selection: normalizeSelection(intent.selection, draft),
        errorMessage: '',
      };
      return syncMention('edit');
    }
    if (intent.type === 'saveEdit') {
      const rowAction = state.rowAction;
      const body = rowAction?.mode === 'edit'
        ? {body: commentFormatting.restoreMentionMarkup(rowAction.draft, rowAction.mentionMappings)}
        : undefined;
      return commitRowAction(intent, {method: 'PUT', body, notice: 'Comment updated'});
    }
    if (intent.type === 'startDelete') {
      if (!issueComment(intent.commentId)) return outcome('ignored');
      state.rowAction = {
        commentId: String(intent.commentId),
        mode: 'delete',
        draft: '',
        mentionMappings: [],
        selection: {start: 0, end: 0},
        saving: false,
        errorMessage: '',
        mention: emptyMentionState(),
      };
      return outcome('changed');
    }
    if (intent.type === 'confirmDelete') {
      if (state.rowAction?.mode !== 'delete') return outcome('ignored');
      return commitRowAction(intent, {method: 'DELETE', body: undefined, notice: 'Comment deleted'});
    }
    if (intent.type === 'cancelRowAction') {
      activeOperations.rowAction?.abort();
      activeOperations.rowAction = null;
      state.rowAction = null;
      return outcome('changed');
    }
    if (intent.type === 'moveMention') return moveMention(intent.lane, intent.delta);
    if (intent.type === 'chooseMention') return chooseMention(intent.lane, intent.index);
    if (intent.type === 'dismissMention') {
      const laneState = mentionLane(intent.lane);
      if (!laneState) return outcome('ignored');
      activeOperations[laneOperationName(intent.lane)]?.abort();
      activeOperations[laneOperationName(intent.lane)] = null;
      setLaneMention(intent.lane, emptyMentionState());
      return outcome('changed');
    }
    return outcome('ignored');
  }

  return {attach, detach, dispatch, view};
}
