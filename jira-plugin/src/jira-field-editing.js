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

function normalizeFailure(error, fallback = 'Field edit failed') {
  return {
    message: String(error?.message || error?.inner || error || fallback),
    name: String(error?.name || 'Error'),
  };
}

function issueKeyOf(snapshot) {
  return String(snapshot?.issueKey || snapshot?.core?.key || '').trim();
}

function buildTransitionOptions(transitions) {
  return (Array.isArray(transitions) ? transitions : [])
    .filter(transition => transition?.id && transition?.to?.name)
    .map(transition => {
      const targetStatusName = String(transition.to.name);
      const transitionName = transition.name && transition.name !== targetStatusName
        ? String(transition.name)
        : '';
      const label = transitionName ? `${transitionName} -> ${targetStatusName}` : targetStatusName;
      return {
        id: String(transition.id),
        label,
        iconUrl: transition.to?.iconUrl || '',
        metaText: transitionName,
        searchText: `${label} ${targetStatusName} ${transitionName}`.trim().toLowerCase(),
        targetStatusName,
        transitionName,
      };
    });
}

export function createJiraFieldEditing(options = {}) {
  const jira = options.jira;
  const issueData = options.issueData;
  const instanceUrl = normalizeInstanceUrl(options.instanceUrl);
  if (!jira || typeof jira.write !== 'function') {
    throw new Error('JiraFieldEditing requires a Jira adapter');
  }
  if (!issueData || typeof issueData.loadFieldContext !== 'function' || typeof issueData.refreshAfterMutation !== 'function') {
    throw new Error('JiraFieldEditing requires QuickViewIssueData');
  }

  let generation = 0;
  let editSequence = 0;
  let session = null;
  let edit = null;

  function view() {
    return {
      sessionId: session?.sessionId || '',
      issueKey: session?.issueKey || '',
      edit: copyValue(edit),
    };
  }

  function outcome(kind, details = {}) {
    return {
      kind,
      sessionId: details.sessionId || session?.sessionId || '',
      issueKey: details.issueKey || session?.issueKey || '',
      editId: details.editId || edit?.editId || '',
      view: view(),
      refreshedSnapshot: details.refreshedSnapshot || null,
      notice: details.notice || '',
      failure: details.failure || null,
    };
  }

  function attach({sessionId, issueSnapshot, requirements = {}} = {}) {
    const normalizedSessionId = String(sessionId || '').trim();
    const issueKey = issueKeyOf(issueSnapshot);
    if (!normalizedSessionId || !issueKey || !issueSnapshot?.core) {
      throw new Error('JiraFieldEditing.attach requires a session id and issue snapshot');
    }
    const sameSession = session?.sessionId === normalizedSessionId && session?.issueKey === issueKey;
    if (!sameSession) {
      generation += 1;
      edit = null;
    }
    session = {
      generation,
      issueKey,
      issueSnapshot,
      requirements: copyValue(requirements || {}),
      sessionId: normalizedSessionId,
    };
    return view();
  }

  function detach({sessionId} = {}) {
    if (sessionId && session?.sessionId !== sessionId) return view();
    generation += 1;
    session = null;
    edit = null;
    return view();
  }

  function isCurrent(capturedSession, editId = '') {
    return !!session && session.generation === capturedSession.generation &&
      session.sessionId === capturedSession.sessionId && session.issueKey === capturedSession.issueKey &&
      (!editId || edit?.editId === editId);
  }

  function matchesEdit(intent) {
    return !!edit && (!intent.editId || intent.editId === edit.editId);
  }

  function visibleOptions() {
    const query = String(edit?.inputValue || '').trim().toLowerCase();
    if (!query) return edit?.options || [];
    return (edit?.options || []).filter(option => {
      return String(option.searchText || option.label || '').toLowerCase().includes(query);
    });
  }

  async function begin(intent) {
    if (!session || !intent.fieldId) return outcome('ignored');
    if (edit?.fieldKey === intent.fieldId) return outcome('ignored', {editId: edit.editId});
    if (!['status', 'summary'].includes(intent.fieldId)) return outcome('ignored');
    const capturedSession = session;
    const editId = `${capturedSession.sessionId}:edit-${++editSequence}`;
    edit = {
      editId,
      fieldKey: String(intent.fieldId),
      label: intent.fieldId === 'summary' ? 'Issue title' : String(intent.fieldId),
      editorType: 'text',
      selectionMode: 'text',
      inputValue: '',
      originalInputValue: '',
      inputPlaceholder: 'Loading field…',
      options: [],
      selectedOptions: [],
      hasChanges: false,
      loadingOptions: true,
      saving: false,
      errorMessage: '',
      showActionButtons: true,
      highlightedOptionId: null,
      selectionStart: 0,
      selectionEnd: 0,
      status: 'loadingDefinition',
      writeSucceeded: false,
    };

    const fieldOutcome = await issueData.loadFieldContext({
      issueKey: capturedSession.issueKey,
      fieldId: intent.fieldId,
      includeTransitions: intent.fieldId === 'status',
      signal: intent.signal,
    });
    if (!isCurrent(capturedSession, editId)) {
      return outcome('ignored', {
        editId,
        issueKey: capturedSession.issueKey,
        sessionId: capturedSession.sessionId,
      });
    }
    const context = fieldOutcome.context;
    if (intent.fieldId === 'summary') {
      const operations = context?.operations || [];
      if (!context?.editable || !operations.includes('set')) {
        const failure = fieldOutcome.failure || fieldOutcome.failures?.fieldContext || fieldOutcome.failures?.editMeta || null;
        edit = null;
        return outcome('ignored', {editId, failure});
      }
      const currentSummary = String(capturedSession.issueSnapshot.core?.fields?.summary || '');
      edit = {
        ...edit,
        inputValue: currentSummary,
        originalInputValue: currentSummary,
        inputPlaceholder: 'Enter a new issue title',
        loadingOptions: false,
        selectionStart: currentSummary.length,
        selectionEnd: currentSummary.length,
        status: 'editing',
      };
    } else {
      const transitions = buildTransitionOptions(context?.transitions);
      if (!transitions.length) {
        const failure = fieldOutcome.failures?.transitions || fieldOutcome.failures?.fieldContext || null;
        edit = null;
        return outcome('ignored', {editId, failure});
      }
      edit = {
        ...edit,
        editorType: 'transition-select',
        fieldKey: 'status',
        label: 'Status transition',
        selectionMode: 'single',
        inputPlaceholder: 'Type to filter transitions',
        options: transitions,
        selectedOptionId: null,
        showActionButtons: false,
        loadingOptions: false,
        status: 'editing',
      };
    }
    return outcome('changed', {editId});
  }

  function inputChanged(intent) {
    if (!matchesEdit(intent) || edit.saving) return outcome('ignored');
    const typedValue = String(intent.value || '');
    let inputValue = typedValue;
    let start = Number.isInteger(intent.selection?.start) ? intent.selection.start : inputValue.length;
    let end = Number.isInteger(intent.selection?.end) ? intent.selection.end : start;
    let selectedOptionId = edit.selectedOptionId || null;
    if (edit.selectionMode !== 'text') {
      const normalizedValue = typedValue.trim().toLowerCase();
      const exactOption = edit.options.find(option => option.label.toLowerCase() === normalizedValue);
      selectedOptionId = exactOption?.id || null;
      const canAutoComplete = !exactOption && normalizedValue && start === end && end === typedValue.length;
      const prefixOption = canAutoComplete
        ? edit.options.find(option => option.label.toLowerCase().startsWith(normalizedValue))
        : null;
      if (prefixOption) {
        inputValue = prefixOption.label;
        selectedOptionId = prefixOption.id;
        start = typedValue.length;
        end = prefixOption.label.length;
      }
    }
    edit = {
      ...edit,
      inputValue,
      selectedOptionId,
      selectedOptions: selectedOptionId ? edit.options.filter(option => option.id === selectedOptionId) : [],
      highlightedOptionId: null,
      hasChanges: edit.selectionMode === 'text'
        ? inputValue !== edit.originalInputValue
        : !!selectedOptionId,
      errorMessage: '',
      selectionStart: start,
      selectionEnd: end,
      status: 'editing',
    };
    return outcome('changed');
  }

  function moveHighlight(intent, delta) {
    if (!matchesEdit(intent) || edit.selectionMode === 'text' || edit.saving) return outcome('ignored');
    const options = visibleOptions();
    if (!options.length) return outcome('ignored');
    const currentIndex = Math.max(0, options.findIndex(option => option.id === edit.highlightedOptionId));
    const nextIndex = Math.max(0, Math.min(options.length - 1, currentIndex + delta));
    edit = {...edit, errorMessage: '', highlightedOptionId: options[nextIndex].id};
    return outcome('changed');
  }

  function cancel(intent) {
    if (!matchesEdit(intent) || edit.saving) return outcome('ignored');
    const editId = edit.editId;
    edit = null;
    return outcome('cancelled', {editId});
  }

  async function selectOption(intent) {
    if (!matchesEdit(intent) || edit.loadingOptions || edit.saving) return outcome('ignored');
    const selectedOption = edit.options.find(option => option.id === String(intent.optionId || ''));
    if (!selectedOption) return outcome('ignored');
    edit = {
      ...edit,
      errorMessage: '',
      hasChanges: true,
      highlightedOptionId: selectedOption.id,
      inputValue: selectedOption.label,
      selectedOptionId: selectedOption.id,
      selectedOptions: [selectedOption],
      selectionStart: selectedOption.label.length,
      selectionEnd: selectedOption.label.length,
      status: 'editing',
    };
    if (edit.editorType === 'transition-select') {
      return save({...intent, type: 'save'});
    }
    return outcome('changed');
  }

  async function save(intent) {
    if (!matchesEdit(intent) || edit.loadingOptions || edit.saving || !session) return outcome('ignored');
    const capturedSession = session;
    const editId = edit.editId;
    if (!edit.hasChanges) return outcome('ignored', {editId});
    let writeRequest;
    let notice;
    if (edit.fieldKey === 'summary') {
      const nextSummary = String(edit.inputValue || '').trim();
      if (!nextSummary) {
        const failure = normalizeFailure(new Error('Issue title cannot be empty'));
        edit = {...edit, errorMessage: failure.message, status: 'failed'};
        return outcome('failed', {editId, failure});
      }
      notice = 'Issue title updated';
      writeRequest = {
        method: 'PUT',
        path: `${instanceUrl}rest/api/2/issue/${encodeURIComponent(capturedSession.issueKey)}`,
        body: {fields: {summary: nextSummary}},
      };
    } else if (edit.fieldKey === 'status') {
      const selectedTransition = edit.options.find(option => option.id === edit.selectedOptionId);
      if (!selectedTransition) {
        const failure = normalizeFailure(new Error('Pick a transition before saving'));
        edit = {...edit, errorMessage: failure.message, status: 'failed'};
        return outcome('failed', {editId, failure});
      }
      notice = selectedTransition.targetStatusName
        ? `Status moved to ${selectedTransition.targetStatusName}`
        : 'Status updated';
      writeRequest = {
        method: 'POST',
        path: `${instanceUrl}rest/api/2/issue/${encodeURIComponent(capturedSession.issueKey)}/transitions`,
        body: {transition: {id: selectedTransition.id}},
      };
    } else {
      return outcome('ignored', {editId});
    }
    const writeAlreadySucceeded = edit.writeSucceeded === true;
    edit = {...edit, errorMessage: '', saving: true, status: 'saving'};

    if (!writeAlreadySucceeded) {
      try {
        await jira.write({
          ...writeRequest,
          signal: intent.signal,
        });
      } catch (error) {
        if (!isCurrent(capturedSession, editId)) {
          return outcome('ignored', {editId, issueKey: capturedSession.issueKey, sessionId: capturedSession.sessionId});
        }
        const failure = normalizeFailure(error);
        edit = {...edit, errorMessage: failure.message, saving: false, status: 'failed'};
        return outcome('failed', {editId, failure});
      }
    }
    if (!isCurrent(capturedSession, editId)) {
      return outcome('ignored', {editId, issueKey: capturedSession.issueKey, sessionId: capturedSession.sessionId});
    }

    const refreshOutcome = await issueData.refreshAfterMutation({
      issueKey: capturedSession.issueKey,
      priorSnapshot: capturedSession.issueSnapshot,
      mutation: {kind: 'fieldChanged', fieldId: edit.fieldKey},
      requirements: capturedSession.requirements,
      signal: intent.signal,
    });
    if (!isCurrent(capturedSession, editId)) {
      return outcome('ignored', {editId, issueKey: capturedSession.issueKey, sessionId: capturedSession.sessionId});
    }
    if (!refreshOutcome.snapshot?.core) {
      const failure = normalizeFailure(refreshOutcome.failures?.core?.message || 'The field was saved, but Jira could not refresh the issue');
      edit = {
        ...edit,
        errorMessage: failure.message,
        saving: false,
        status: 'failed',
        writeSucceeded: true,
      };
      return outcome('savedButRefreshFailed', {editId, failure, notice});
    }
    session = {...session, issueSnapshot: refreshOutcome.snapshot};
    edit = null;
    return outcome('saved', {
      editId,
      notice,
      refreshedSnapshot: refreshOutcome.snapshot,
    });
  }

  async function dispatch(intent = {}) {
    if (intent.type === 'begin') return begin(intent);
    if (intent.type === 'inputChanged') return inputChanged(intent);
    if (intent.type === 'cancel') return cancel(intent);
    if (intent.type === 'selectOption') return selectOption(intent);
    if (intent.type === 'save') return save(intent);
    if (intent.type === 'key') {
      if (intent.key === 'Escape') return cancel(intent);
      if (intent.key === 'ArrowDown') return moveHighlight(intent, 1);
      if (intent.key === 'ArrowUp') return moveHighlight(intent, -1);
      if (intent.key === 'Enter') {
        if (edit?.selectionMode !== 'text') {
          const optionId = edit?.selectedOptionId || edit?.highlightedOptionId || visibleOptions()[0]?.id;
          return selectOption({...intent, optionId});
        }
        return save(intent);
      }
    }
    return outcome('ignored');
  }

  return {attach, detach, dispatch, view};
}
