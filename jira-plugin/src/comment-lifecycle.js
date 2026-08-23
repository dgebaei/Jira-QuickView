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

function normalizeInstanceUrl(value) {
  const instanceUrl = String(value || '').trim();
  return instanceUrl && !instanceUrl.endsWith('/') ? `${instanceUrl}/` : instanceUrl;
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

function countSharedPrefixLength(left, right) {
  const leftText = String(left || '');
  const rightText = String(right || '');
  const maxLength = Math.min(leftText.length, rightText.length);
  let index = 0;
  while (index < maxLength && leftText[index] === rightText[index]) index += 1;
  return index;
}

function countSharedSuffixLength(left, right) {
  const leftText = String(left || '');
  const rightText = String(right || '');
  const maxLength = Math.min(leftText.length, rightText.length);
  let index = 0;
  while (index < maxLength && leftText[leftText.length - 1 - index] === rightText[rightText.length - 1 - index]) index += 1;
  return index;
}

function restoreMentionMarkup(draftText, mentionMappings = []) {
  const sourceText = String(draftText || '');
  const replacements = [];
  let searchFloor = 0;
  (Array.isArray(mentionMappings) ? mentionMappings : []).filter(mapping => mapping?.displayText && mapping?.markup).forEach(mapping => {
    const displayText = String(mapping.displayText);
    let bestMatch = null;
    let nextIndex = Math.max(0, searchFloor);
    while (nextIndex <= sourceText.length) {
      const matchIndex = sourceText.indexOf(displayText, nextIndex);
      if (matchIndex === -1) break;
      const beforeContext = String(mapping.beforeContext || '');
      const afterContext = String(mapping.afterContext || '');
      const beforeSample = sourceText.slice(Math.max(0, matchIndex - beforeContext.length), matchIndex);
      const afterStart = matchIndex + displayText.length;
      const afterSample = sourceText.slice(afterStart, afterStart + afterContext.length);
      const contextScore = countSharedSuffixLength(beforeSample, beforeContext) + countSharedPrefixLength(afterSample, afterContext);
      const preferredStart = Number.isFinite(Number(mapping.start)) ? Number(mapping.start) : matchIndex;
      const candidate = {
        start: matchIndex,
        end: afterStart,
        markup: String(mapping.markup),
        contextScore,
        distanceScore: Math.abs(matchIndex - preferredStart),
      };
      if (!bestMatch || candidate.contextScore > bestMatch.contextScore ||
        (candidate.contextScore === bestMatch.contextScore && candidate.distanceScore < bestMatch.distanceScore)) {
        bestMatch = candidate;
      }
      nextIndex = matchIndex + displayText.length;
    }
    if (!bestMatch || (!bestMatch.contextScore && (mapping.beforeContext || mapping.afterContext))) return;
    replacements.push(bestMatch);
    searchFloor = bestMatch.end;
  });
  if (!replacements.length) return sourceText;
  let restored = '';
  let cursor = 0;
  replacements.forEach(replacement => {
    restored += sourceText.slice(cursor, replacement.start);
    restored += replacement.markup;
    cursor = replacement.end;
  });
  return restored + sourceText.slice(cursor);
}

function knownJiraUsers(issueSnapshot) {
  const users = [];
  const seenObjects = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object' || seenObjects.has(value)) return;
    seenObjects.add(value);
    if (value.displayName && (value.accountId || value.name || value.username || value.key)) users.push(value);
    if (Array.isArray(value)) value.forEach(visit);
    else Object.values(value).forEach(visit);
  }
  visit(issueSnapshot?.core?.fields || {});
  return users;
}

function mentionDisplayText(rawValue, issueSnapshot) {
  const normalized = String(rawValue || '').trim();
  const identity = normalized.replace(/^accountid:/i, '');
  const user = knownJiraUsers(issueSnapshot).find(candidate => [candidate.accountId, candidate.name, candidate.username, candidate.key]
    .some(value => String(value || '').trim() === identity || String(value || '').trim() === normalized));
  const displayName = String(user?.displayName || user?.name || user?.username || user?.key || identity).trim();
  return displayName ? `@${displayName}` : '@mention';
}

function buildEditableDraft(rawText, issueSnapshot) {
  const sourceText = String(rawText || '');
  const mentionMappings = [];
  const mentionPattern = /\[~([^[\]\r\n]+?)\]/g;
  let draft = '';
  let lastIndex = 0;
  let match = mentionPattern.exec(sourceText);
  while (match) {
    draft += sourceText.slice(lastIndex, match.index);
    const displayText = mentionDisplayText(match[1], issueSnapshot);
    const start = draft.length;
    draft += displayText;
    mentionMappings.push({displayText, markup: match[0], start});
    lastIndex = match.index + match[0].length;
    match = mentionPattern.exec(sourceText);
  }
  draft += sourceText.slice(lastIndex);
  mentionMappings.forEach(mapping => {
    const end = mapping.start + mapping.displayText.length;
    mapping.beforeContext = draft.slice(Math.max(0, mapping.start - 24), mapping.start);
    mapping.afterContext = draft.slice(end, end + 24);
  });
  return {draft, mentionMappings};
}

function emptyComposeState() {
  return {
    value: '',
    mentionMappings: [],
    selection: {start: 0, end: 0},
    focused: false,
    saving: false,
    errorMessage: '',
  };
}

export function createCommentLifecycle(options = {}) {
  const jira = options.jira;
  const issueData = options.issueData;
  if (!jira || typeof jira.write !== 'function') throw new Error('CommentLifecycle requires a Jira adapter');
  if (!issueData || typeof issueData.refreshAfterMutation !== 'function') {
    throw new Error('CommentLifecycle requires QuickViewIssueData');
  }

  const instanceUrl = normalizeInstanceUrl(options.instanceUrl);
  let generation = 0;
  let state = null;
  const activeOperations = {compose: null, rowAction: null};

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

  function attach({sessionId, issueSnapshot} = {}) {
    Object.values(activeOperations).forEach(controller => controller?.abort());
    activeOperations.compose = null;
    activeOperations.rowAction = null;
    const issueKey = String(issueSnapshot?.issueKey || issueSnapshot?.core?.key || '').trim();
    generation += 1;
    state = {
      sessionId: String(sessionId || ''),
      issueKey,
      generation,
      issueSnapshot: copyValue(issueSnapshot || null),
      compose: emptyComposeState(),
      rowAction: null,
    };
    return outcome('attached');
  }

  function detach({sessionId} = {}) {
    if (!state || (sessionId && String(sessionId) !== state.sessionId)) return outcome('ignored');
    const detachedIdentity = identityOf();
    Object.values(activeOperations).forEach(controller => controller?.abort());
    activeOperations.compose = null;
    activeOperations.rowAction = null;
    generation += 1;
    state = null;
    return outcome('detached', {}, detachedIdentity);
  }

  function view() {
    if (!state) return {sessionId: '', issueKey: '', generation, compose: null, rowAction: null, protectFromAutoHide: false};
    const compose = state.compose;
    return {
      sessionId: state.sessionId,
      issueKey: state.issueKey,
      generation: state.generation,
      compose: {
        value: compose.value,
        selection: copyValue(compose.selection),
        focused: compose.focused,
        saving: compose.saving,
        errorMessage: compose.errorMessage,
        canSave: !!compose.value.trim() && !compose.saving,
      },
      rowAction: state.rowAction ? {
        commentId: state.rowAction.commentId,
        mode: state.rowAction.mode,
        draft: state.rowAction.draft,
        selection: copyValue(state.rowAction.selection),
        saving: state.rowAction.saving,
        errorMessage: state.rowAction.errorMessage,
        canSave: state.rowAction.mode === 'edit' && !!state.rowAction.draft.trim() && !state.rowAction.saving,
      } : null,
      protectFromAutoHide: !!compose.value || compose.saving || !!state.rowAction,
    };
  }

  async function saveNewComment(intent) {
    if (!state?.issueKey || state.compose.saving || !state.compose.value.trim()) return outcome('ignored');
    const identity = identityOf();
    const priorSnapshot = copyValue(state.issueSnapshot);
    const value = state.compose.value.trim();
    const body = restoreMentionMarkup(value, state.compose.mentionMappings);
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
        requirements: copyValue(intent.requirements || {}),
        signal: controller.signal,
      });
      if (!isCurrent(identity)) return outcome('ignored', {}, identity);
      state.issueSnapshot = copyValue(refreshed.snapshot || state.issueSnapshot);
      state.compose = emptyComposeState();
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
        requirements: copyValue(intent.requirements || {}),
        signal: controller.signal,
      });
      if (!isCurrent(identity)) return outcome('ignored', {}, identity);
      state.issueSnapshot = copyValue(refreshed.snapshot || state.issueSnapshot);
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
        mentionMappings: copyValue(intent.mentionMappings || state.compose.mentionMappings),
        errorMessage: '',
      };
      return outcome('changed');
    }
    if (intent.type === 'composeFocusChanged') {
      state.compose = {...state.compose, focused: !!intent.focused};
      return outcome('changed');
    }
    if (intent.type === 'saveNewComment') return saveNewComment(intent);
    if (intent.type === 'discardCompose') {
      state.compose = emptyComposeState();
      return outcome('changed');
    }
    if (intent.type === 'startEdit') {
      const comment = issueComment(intent.commentId);
      if (!comment) return outcome('ignored');
      const editable = buildEditableDraft(comment.body, state.issueSnapshot);
      state.rowAction = {
        commentId: String(comment.id),
        mode: 'edit',
        draft: editable.draft,
        mentionMappings: editable.mentionMappings,
        selection: {start: editable.draft.length, end: editable.draft.length},
        saving: false,
        errorMessage: '',
      };
      return outcome('changed');
    }
    if (intent.type === 'editChanged') {
      const commentId = String(intent.commentId || '');
      if (!state.rowAction || state.rowAction.mode !== 'edit' || state.rowAction.commentId !== commentId || state.rowAction.saving) {
        return outcome('ignored');
      }
      const draft = String(intent.value || '');
      const insertedMention = intent.insertedMention;
      const nextMentionMappings = insertedMention?.displayText && insertedMention?.markup
        ? [...state.rowAction.mentionMappings, {
            displayText: String(insertedMention.displayText),
            markup: String(insertedMention.markup),
            start: Number(insertedMention.start) || 0,
            beforeContext: draft.slice(Math.max(0, (Number(insertedMention.start) || 0) - 24), Number(insertedMention.start) || 0),
            afterContext: draft.slice((Number(insertedMention.start) || 0) + String(insertedMention.displayText).length,
              (Number(insertedMention.start) || 0) + String(insertedMention.displayText).length + 24),
          }]
        : copyValue(intent.mentionMappings || state.rowAction.mentionMappings);
      state.rowAction = {
        ...state.rowAction,
        draft,
        mentionMappings: nextMentionMappings,
        selection: normalizeSelection(intent.selection, draft),
        errorMessage: '',
      };
      return outcome('changed');
    }
    if (intent.type === 'saveEdit') {
      const rowAction = state.rowAction;
      const body = rowAction?.mode === 'edit'
        ? {body: restoreMentionMarkup(rowAction.draft, rowAction.mentionMappings)}
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
    return outcome('ignored');
  }

  return {attach, detach, dispatch, view};
}
