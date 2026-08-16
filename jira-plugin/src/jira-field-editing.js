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

function buildAllowedValueOption(value) {
  const label = String(value?.name || value?.value || '');
  return {
    id: String(value?.id || value?.value || ''),
    label,
    iconUrl: value?.iconUrl || '',
    metaText: value?.description || '',
    rawValue: copyValue(value),
    searchText: `${label} ${value?.description || ''}`.trim().toLowerCase(),
  };
}

function mergeOptions(primary, secondary) {
  const seen = new Set();
  return [...primary, ...secondary].filter(option => {
    if (!option.id || !option.label || seen.has(option.id)) return false;
    seen.add(option.id);
    return true;
  });
}

function normalizeOptionIds(optionIds) {
  return [...new Set((Array.isArray(optionIds) ? optionIds : [])
    .map(optionId => String(optionId || '').trim())
    .filter(Boolean))];
}

function areSameOptionIds(left, right) {
  const leftIds = normalizeOptionIds(left).sort();
  const rightIds = normalizeOptionIds(right).sort();
  return leftIds.length === rightIds.length && leftIds.every((optionId, index) => optionId === rightIds[index]);
}

function resolveOptions(optionIds, options, fallbackOptions = []) {
  const optionsById = new Map();
  [...fallbackOptions, ...options].forEach(option => {
    if (option?.id) optionsById.set(String(option.id), option);
  });
  return normalizeOptionIds(optionIds).map(optionId => optionsById.get(optionId)).filter(Boolean);
}

function compareVersionOptions(left, right) {
  const sortName = option => String(option?.name || '').trim().replace(/^v(?=\d)/i, '');
  return sortName(right).localeCompare(sortName(left), undefined, {numeric: true, sensitivity: 'base'});
}

function sprintEntries(issue) {
  const names = issue?.names || {};
  const fields = issue?.fields || {};
  return Object.keys(names)
    .filter(fieldId => String(names[fieldId] || '').toLowerCase().includes('sprint'))
    .flatMap(fieldId => Array.isArray(fields[fieldId]) ? fields[fieldId] : [fields[fieldId]])
    .filter(Boolean);
}

function readSprints(issue) {
  const seen = new Set();
  return sprintEntries(issue).map(entry => {
    if (typeof entry !== 'string') {
      return {id: String(entry?.id || ''), name: entry?.name || entry?.goal || String(entry?.id || ''), state: entry?.state || ''};
    }
    const read = name => entry.match(new RegExp(`${name}=([^,\\]]+)`, 'i'))?.[1] || '';
    return {id: read('id'), name: read('name') || entry, state: read('state')};
  }).filter(sprint => {
    const key = sprint.id || `${sprint.name}::${sprint.state}`;
    if (!sprint.name || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readSprintBoardRefs(issue) {
  const projectKey = String(issue?.key || '').split('-')[0];
  const seen = new Set();
  const refs = [];
  sprintEntries(issue).forEach(entry => {
    const ids = [];
    if (typeof entry === 'string') {
      ['rapidViewId', 'boardId', 'originBoardId'].forEach(name => {
        const value = entry.match(new RegExp(`${name}=([^,\\]]+)`, 'i'))?.[1];
        if (value) ids.push(value);
      });
    } else {
      ids.push(entry?.rapidViewId, entry?.boardId, entry?.originBoardId, entry?.board?.id, entry?.rapidView?.id);
    }
    ids.forEach(id => {
      const value = String(id || '').trim();
      if (!value || seen.has(value)) return;
      seen.add(value);
      refs.push({
        id: value,
        name: String(entry?.board?.name || entry?.rapidView?.name || ''),
        projectKey,
      });
    });
  });
  return refs;
}

function compareBoardRefs(left, right, issueProjectKey) {
  const leftIsLocal = String(left?.projectKey || '') === issueProjectKey;
  const rightIsLocal = String(right?.projectKey || '') === issueProjectKey;
  if (leftIsLocal !== rightIsLocal) return leftIsLocal ? -1 : 1;
  const nameOrder = String(left?.name || '').localeCompare(String(right?.name || ''), undefined, {numeric: true, sensitivity: 'base'});
  return nameOrder || String(left?.id || '').localeCompare(String(right?.id || ''), undefined, {numeric: true, sensitivity: 'base'});
}

function sprintGroupMeta(sprint, issue, issueBoardIds) {
  const projectKey = String(issue?.key || '').split('-')[0];
  const projectName = String(issue?.fields?.project?.name || '').trim();
  const boardRefs = Array.isArray(sprint?.boardRefs) ? sprint.boardRefs : [];
  const preferredBoard = boardRefs.slice().sort((left, right) => compareBoardRefs(left, right, projectKey))[0] || null;
  const boardId = String(preferredBoard?.id || '').trim();
  const boardProjectKey = String(preferredBoard?.projectKey || '').trim();
  return {
    groupKey: boardId ? `board:${boardId}` : '__other_boards__',
    groupLabel: preferredBoard?.name || (boardProjectKey ? `${boardProjectKey} board` : (projectName || projectKey || 'Other boards')),
    groupSortKey: boardRefs.some(ref => issueBoardIds.has(String(ref?.id || ''))) ? '0' : '1',
  };
}

function groupOptions(options, {hideSingleGroup = false} = {}) {
  const ungrouped = options.filter(option => !option.groupKey);
  const groups = new Map();
  options.filter(option => option.groupKey).forEach(option => {
    const group = groups.get(option.groupKey) || {
      key: option.groupKey,
      label: option.groupLabel || option.groupKey,
      sortKey: option.groupSortKey || '9',
      options: [],
    };
    group.options.push(option);
    groups.set(group.key, group);
  });
  const sortedGroups = [...groups.values()].sort((left, right) => {
    const rank = String(left.sortKey).localeCompare(String(right.sortKey), undefined, {numeric: true, sensitivity: 'base'});
    return rank || String(left.label).localeCompare(String(right.label), undefined, {numeric: true, sensitivity: 'base'});
  });
  const showLabels = !(hideSingleGroup && sortedGroups.length <= 1);
  return [
    ...ungrouped,
    ...sortedGroups.flatMap(group => showLabels ? [{
      id: `__group__${group.key}`,
      isGroupLabel: true,
      label: group.label,
      searchText: String(group.label).toLowerCase(),
    }, ...group.options] : group.options),
  ];
}

function buildSprintOptions(issue, sprints) {
  const stateOrder = {active: 0, future: 1, closed: 2};
  const issueBoardIds = new Set(readSprintBoardRefs(issue).map(board => board.id));
  const options = (Array.isArray(sprints) ? sprints : [])
    .filter(sprint => sprint?.id && sprint?.name && String(sprint.state || '').toLowerCase() !== 'closed')
    .slice()
    .sort((left, right) => {
      const stateDelta = (stateOrder[String(left?.state || '').toLowerCase()] ?? 99) -
        (stateOrder[String(right?.state || '').toLowerCase()] ?? 99);
      return stateDelta || String(left.name).localeCompare(String(right.name));
    })
    .map(sprint => {
      const state = String(sprint.state || '').toUpperCase();
      const label = state ? `${sprint.name} (${state})` : sprint.name;
      return {
        id: String(sprint.id),
        label,
        rawValue: copyValue(sprint),
        searchText: label.toLowerCase(),
        ...sprintGroupMeta(sprint, issue, issueBoardIds),
      };
    });
  return [
    {id: '', label: 'No sprint', rawValue: null, searchText: 'no sprint'},
    ...groupOptions(options, {hideSingleGroup: true}),
  ];
}

function buildUserOption(user) {
  const id = String(user?.accountId || user?.name || user?.key || '');
  const label = String(user?.displayName || user?.name || user?.key || '');
  return {
    id,
    label,
    avatarUrl: user?.avatarUrls?.['48x48'] || '',
    metaText: user?.name || user?.key || '',
    rawValue: {
      accountId: user?.accountId || '',
      name: user?.name || '',
      key: user?.key || '',
    },
    searchText: `${label} ${user?.name || ''} ${user?.key || ''}`.trim().toLowerCase(),
  };
}

function unassignedOption(metaText = 'Clear assignee') {
  return {
    id: '__unassigned__',
    label: 'Unassigned',
    metaText,
    rawValue: null,
    searchText: `unassigned ${metaText}`.toLowerCase(),
  };
}

function currentAssigneeOption(issue) {
  const assignee = issue?.fields?.assignee;
  return assignee ? buildUserOption(assignee) : null;
}

function buildAssigneeOptions(issue, assignees = [], people = [], baseline = []) {
  const currentOption = currentAssigneeOption(issue);
  const fixedOptions = [unassignedOption(), ...(currentOption ? [currentOption] : [])];
  return mergeOptions(
    fixedOptions,
    mergeOptions(
      assignees.map(buildUserOption),
      mergeOptions(people.map(buildUserOption), baseline)
    )
  );
}

function detectAssigneeIdentifier(issue, preferredIdentifier) {
  if (preferredIdentifier) return preferredIdentifier;
  const assignee = issue?.fields?.assignee;
  if (assignee?.accountId) return 'accountId';
  if (assignee?.name) return 'name';
  if (assignee?.key) return 'key';
  return 'accountId';
}

function assigneeWriteCandidates(selectedOption, issue, preferredIdentifier) {
  const rawValue = selectedOption?.rawValue || {};
  const isUnassigned = selectedOption?.id === '__unassigned__';
  const payloads = {
    accountId: isUnassigned ? {accountId: null} : (rawValue.accountId ? {accountId: rawValue.accountId} : null),
    name: isUnassigned ? {name: null} : (rawValue.name ? {name: rawValue.name} : null),
    key: isUnassigned ? {key: null} : (rawValue.key ? {key: rawValue.key} : null),
  };
  const preferred = detectAssigneeIdentifier(issue, preferredIdentifier);
  return [preferred, 'accountId', 'name', 'key']
    .filter((identifier, index, identifiers) => identifier && identifiers.indexOf(identifier) === index)
    .filter(identifier => payloads[identifier])
    .map(identifier => ({identifier, body: payloads[identifier]}));
}

export function createJiraFieldEditing(options = {}) {
  const jira = options.jira;
  const issueData = options.issueData;
  const instanceUrl = normalizeInstanceUrl(options.instanceUrl);
  if (!jira || typeof jira.write !== 'function') {
    throw new Error('JiraFieldEditing requires a Jira adapter');
  }
  if (!issueData || typeof issueData.loadFieldContext !== 'function' || typeof issueData.refreshAfterMutation !== 'function' || typeof issueData.search !== 'function') {
    throw new Error('JiraFieldEditing requires QuickViewIssueData');
  }

  let generation = 0;
  let editSequence = 0;
  let searchSequence = 0;
  let session = null;
  let edit = null;
  let resolvedFieldId = '';
  let preferredAssigneeIdentifier = '';

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
      resolvedFieldId = '';
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
    resolvedFieldId = '';
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

  function visibleSelectableOptions() {
    return visibleOptions().filter(option => !option.isGroupLabel);
  }

  async function begin(intent) {
    if (!session || !intent.fieldId) return outcome('ignored');
    if (edit?.fieldKey === intent.fieldId) return outcome('ignored', {editId: edit.editId});
    if (!['assignee', 'fixVersions', 'issuetype', 'priority', 'sprint', 'status', 'summary', 'versions'].includes(intent.fieldId)) return outcome('ignored');
    const capturedSession = session;
    const editId = `${capturedSession.sessionId}:edit-${++editSequence}`;
    resolvedFieldId = '';
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
      includeOptions: ['fixVersions', 'sprint', 'versions'].includes(intent.fieldId),
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
    } else if (intent.fieldId === 'status') {
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
    } else if (intent.fieldId === 'assignee') {
      if (!context?.editable) {
        const failure = fieldOutcome.failures?.fieldContext || fieldOutcome.failures?.editMeta || null;
        edit = null;
        return outcome('ignored', {editId, failure});
      }
      const currentOption = currentAssigneeOption(capturedSession.issueSnapshot.core);
      edit = {
        ...edit,
        editorType: 'user-search',
        fieldKey: 'assignee',
        label: 'Assignee',
        selectionMode: 'single',
        inputPlaceholder: 'Search assignable users',
        options: [],
        selectedOptionId: currentOption?.id || '__unassigned__',
        selectedOptions: currentOption ? [currentOption] : [unassignedOption('No assignee')],
        showActionButtons: false,
        loadingOptions: true,
        searchRequestId: ++searchSequence,
        status: 'loadingOptions',
      };
      const assigneeOutcome = await issueData.search({
        purpose: 'assignee',
        issueKey: capturedSession.issueKey,
        query: '',
        signal: intent.signal,
      });
      if (!isCurrent(capturedSession, editId)) {
        return outcome('ignored', {editId, issueKey: capturedSession.issueKey, sessionId: capturedSession.sessionId});
      }
      if (assigneeOutcome.kind !== 'loaded') {
        const failure = assigneeOutcome.failure || normalizeFailure(new Error('Could not search assignable users'));
        edit = {...edit, errorMessage: failure.message, loadingOptions: false, status: 'failed'};
        return outcome('failed', {editId, failure});
      }
      edit = {
        ...edit,
        options: buildAssigneeOptions(capturedSession.issueSnapshot.core, assigneeOutcome.items),
        loadingOptions: false,
        status: 'editing',
      };
    } else if (intent.fieldId === 'sprint') {
      if (!context?.editable || !context.fieldId || fieldOutcome.failures?.options) {
        const failure = fieldOutcome.failures?.options || fieldOutcome.failures?.fieldContext || fieldOutcome.failures?.editMeta || null;
        edit = null;
        return outcome('ignored', {editId, failure});
      }
      const currentSprints = readSprints(capturedSession.issueSnapshot.core);
      const currentSprint = currentSprints.length === 1 ? currentSprints[0] : null;
      const sprintOptions = buildSprintOptions(capturedSession.issueSnapshot.core, context.options);
      resolvedFieldId = context.fieldId;
      edit = {
        ...edit,
        editorType: 'single-select',
        fieldKey: 'sprint',
        label: 'Sprint',
        selectionMode: 'single',
        inputPlaceholder: 'Type to filter Sprint values',
        options: sprintOptions,
        selectedOptionId: currentSprint?.id || null,
        selectedOptions: currentSprint ? [{
          id: currentSprint.id,
          label: currentSprint.state ? `${currentSprint.name} (${String(currentSprint.state).toUpperCase()})` : currentSprint.name,
          rawValue: copyValue(currentSprint),
        }] : [],
        showActionButtons: false,
        loadingOptions: false,
        status: 'editing',
      };
    } else if (['fixVersions', 'versions'].includes(intent.fieldId)) {
      const fieldId = intent.fieldId;
      const currentValues = Array.isArray(capturedSession.issueSnapshot.core?.fields?.[fieldId])
        ? capturedSession.issueSnapshot.core.fields[fieldId]
        : [];
      const currentOptions = currentValues
        .filter(value => value?.id && value?.name)
        .map(buildAllowedValueOption);
      const availableOptions = (context?.options || [])
        .filter(value => value?.id && value?.name)
        .slice()
        .sort(compareVersionOptions)
        .map(buildAllowedValueOption);
      const versionOptions = mergeOptions(availableOptions, currentOptions);
      if (!context?.editable || fieldOutcome.failures?.options) {
        const failure = fieldOutcome.failures?.options || fieldOutcome.failures?.fieldContext || fieldOutcome.failures?.editMeta || null;
        edit = null;
        return outcome('ignored', {editId, failure});
      }
      const selectedOptionIds = normalizeOptionIds(currentOptions.map(option => option.id));
      edit = {
        ...edit,
        editorType: 'multi-select',
        fieldKey: fieldId,
        label: fieldId === 'fixVersions' ? 'Fix version' : 'Affects version',
        selectionMode: 'multi',
        inputPlaceholder: `Type to filter ${fieldId === 'fixVersions' ? 'fix' : 'affected'} versions`,
        options: versionOptions,
        selectedOptionId: null,
        selectedOptionIds,
        originalOptionIds: [...selectedOptionIds],
        selectedOptions: currentOptions,
        showActionButtons: true,
        loadingOptions: false,
        status: 'editing',
      };
    } else {
      const fieldId = intent.fieldId;
      const currentValue = capturedSession.issueSnapshot.core?.fields?.[fieldId] || null;
      const currentIsSubtask = currentValue?.subtask === true;
      const allowedOptions = (context?.allowedValues || [])
        .filter(value => value?.id && value?.name)
        .filter(value => {
          if (fieldId !== 'issuetype' || typeof value.subtask !== 'boolean' || typeof currentValue?.subtask !== 'boolean') return true;
          return value.subtask === currentIsSubtask;
        })
        .map(buildAllowedValueOption);
      const currentOption = currentValue?.id && currentValue?.name
        ? buildAllowedValueOption(currentValue)
        : null;
      const options = fieldId === 'issuetype'
        ? mergeOptions(currentOption ? [currentOption] : [], allowedOptions)
        : allowedOptions;
      const minimumOptions = fieldId === 'issuetype' ? 2 : 1;
      if (!context?.editable || options.length < minimumOptions) {
        const failure = fieldOutcome.failures?.fieldContext || fieldOutcome.failures?.editMeta || null;
        edit = null;
        return outcome('ignored', {editId, failure});
      }
      edit = {
        ...edit,
        editorType: 'single-select',
        fieldKey: fieldId,
        label: fieldId === 'issuetype' ? 'Issue type' : 'Priority',
        selectionMode: 'single',
        inputPlaceholder: `Type to filter ${fieldId === 'issuetype' ? 'issue type' : 'priority'} values`,
        options,
        selectedOptionId: currentOption?.id || null,
        selectedOptions: currentOption ? [currentOption] : [],
        showActionButtons: false,
        loadingOptions: false,
        status: 'editing',
      };
    }
    return outcome('changed', {editId});
  }

  async function inputChanged(intent) {
    if (!matchesEdit(intent) || edit.saving) return outcome('ignored');
    const typedValue = String(intent.value || '');
    let inputValue = typedValue;
    let start = Number.isInteger(intent.selection?.start) ? intent.selection.start : inputValue.length;
    let end = Number.isInteger(intent.selection?.end) ? intent.selection.end : start;
    let selectedOptionId = edit.selectedOptionId || null;
    if (edit.editorType === 'user-search' && session) {
      const capturedSession = session;
      const editId = edit.editId;
      const requestId = ++searchSequence;
      const baselineOptions = edit.options;
      const exactOption = baselineOptions.find(option => option.label.toLowerCase() === typedValue.trim().toLowerCase());
      edit = {
        ...edit,
        inputValue: typedValue,
        selectedOptionId: exactOption?.id || null,
        selectedOptions: exactOption ? [exactOption] : [],
        highlightedOptionId: null,
        hasChanges: !!exactOption,
        loadingOptions: true,
        errorMessage: '',
        searchRequestId: requestId,
        selectionStart: start,
        selectionEnd: end,
        status: 'loadingOptions',
      };
      const [assigneeOutcome, peopleOutcome] = await Promise.all([
        issueData.search({purpose: 'assignee', issueKey: capturedSession.issueKey, query: typedValue, signal: intent.signal}),
        issueData.search({purpose: 'userPicker', query: typedValue, signal: intent.signal}),
      ]);
      if (!isCurrent(capturedSession, editId) || edit.searchRequestId !== requestId) {
        return outcome('ignored', {editId, issueKey: capturedSession.issueKey, sessionId: capturedSession.sessionId});
      }
      edit = {
        ...edit,
        options: buildAssigneeOptions(
          capturedSession.issueSnapshot.core,
          assigneeOutcome.kind === 'loaded' ? assigneeOutcome.items : [],
          peopleOutcome.kind === 'loaded' ? peopleOutcome.items : [],
          baselineOptions
        ),
        loadingOptions: false,
        status: 'editing',
      };
      return outcome('changed');
    }
    if (edit.selectionMode === 'multi') {
      edit = {
        ...edit,
        inputValue,
        highlightedOptionId: null,
        errorMessage: '',
        selectionStart: start,
        selectionEnd: end,
        status: 'editing',
      };
      return outcome('changed');
    }
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
    const options = visibleSelectableOptions();
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
    resolvedFieldId = '';
    return outcome('cancelled', {editId});
  }

  async function selectOption(intent) {
    if (!matchesEdit(intent) || edit.loadingOptions || edit.saving) return outcome('ignored');
    const selectedOption = edit.options.find(option => option.id === String(intent.optionId || ''));
    if (!selectedOption || selectedOption.isGroupLabel) return outcome('ignored');
    if (edit.selectionMode === 'multi') {
      const selectedOptionIds = normalizeOptionIds(edit.selectedOptionIds);
      const nextSelectedOptionIds = selectedOptionIds.includes(selectedOption.id)
        ? selectedOptionIds.filter(optionId => optionId !== selectedOption.id)
        : [...selectedOptionIds, selectedOption.id];
      edit = {
        ...edit,
        errorMessage: '',
        hasChanges: !areSameOptionIds(nextSelectedOptionIds, edit.originalOptionIds),
        highlightedOptionId: selectedOption.id,
        inputValue: '',
        selectedOptionIds: nextSelectedOptionIds,
        selectedOptions: resolveOptions(nextSelectedOptionIds, edit.options, edit.selectedOptions),
        selectionStart: 0,
        selectionEnd: 0,
        status: 'editing',
      };
      return outcome('changed');
    }
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
    let writeCandidates = null;
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
    } else if (['issuetype', 'priority'].includes(edit.fieldKey)) {
      const selectedValue = edit.options.find(option => option.id === edit.selectedOptionId);
      if (!selectedValue) {
        const failure = normalizeFailure(new Error(`Pick ${edit.fieldKey === 'issuetype' ? 'an issue type' : 'a priority'} before saving`));
        edit = {...edit, errorMessage: failure.message, status: 'failed'};
        return outcome('failed', {editId, failure});
      }
      notice = `${edit.fieldKey === 'issuetype' ? 'Issue type' : 'Priority'} set to ${selectedValue.label}`;
      writeRequest = {
        method: 'PUT',
        path: `${instanceUrl}rest/api/2/issue/${encodeURIComponent(capturedSession.issueKey)}`,
        body: {fields: {[edit.fieldKey]: {id: selectedValue.id}}},
      };
    } else if (edit.fieldKey === 'assignee') {
      const selectedAssignee = edit.options.find(option => option.id === edit.selectedOptionId);
      if (!selectedAssignee) {
        const failure = normalizeFailure(new Error('Pick an assignee before saving'));
        edit = {...edit, errorMessage: failure.message, status: 'failed'};
        return outcome('failed', {editId, failure});
      }
      writeCandidates = assigneeWriteCandidates(
        selectedAssignee,
        capturedSession.issueSnapshot.core,
        preferredAssigneeIdentifier
      );
      if (!writeCandidates.length) {
        const failure = normalizeFailure(new Error('Could not build assignee payload'));
        edit = {...edit, errorMessage: failure.message, status: 'failed'};
        return outcome('failed', {editId, failure});
      }
      notice = selectedAssignee.id === '__unassigned__'
        ? 'Assignee cleared'
        : `Assignee set to ${selectedAssignee.label}`;
      writeCandidates = writeCandidates.map(candidate => ({
        ...candidate,
        method: 'PUT',
        path: `${instanceUrl}rest/api/2/issue/${encodeURIComponent(capturedSession.issueKey)}/assignee`,
      }));
    } else if (['fixVersions', 'versions'].includes(edit.fieldKey)) {
      const selectedValues = resolveOptions(edit.selectedOptionIds, edit.options, edit.selectedOptions);
      notice = edit.fieldKey === 'fixVersions'
        ? (selectedValues.length ? 'Fix versions updated' : 'Fix versions cleared')
        : (selectedValues.length ? 'Affects versions updated' : 'Affects versions cleared');
      writeRequest = {
        method: 'PUT',
        path: `${instanceUrl}rest/api/2/issue/${encodeURIComponent(capturedSession.issueKey)}`,
        body: {fields: {[edit.fieldKey]: selectedValues.map(value => ({id: value.id}))}},
      };
    } else if (edit.fieldKey === 'sprint') {
      const selectedSprint = edit.options.find(option => !option.isGroupLabel && option.id === String(edit.selectedOptionId ?? ''));
      if (!selectedSprint || !resolvedFieldId) {
        const failure = normalizeFailure(new Error('Could not resolve the Sprint field'));
        edit = {...edit, errorMessage: failure.message, status: 'failed'};
        return outcome('failed', {editId, failure});
      }
      notice = selectedSprint.id ? `Sprint set to ${selectedSprint.label}` : 'Sprint cleared';
      writeRequest = {
        method: 'PUT',
        path: `${instanceUrl}rest/api/2/issue/${encodeURIComponent(capturedSession.issueKey)}`,
        body: {fields: {[resolvedFieldId]: selectedSprint.id ? (Number(selectedSprint.id) || selectedSprint.id) : null}},
      };
    } else {
      return outcome('ignored', {editId});
    }
    const writeAlreadySucceeded = edit.writeSucceeded === true;
    edit = {...edit, errorMessage: '', saving: true, status: 'saving'};

    if (!writeAlreadySucceeded) {
      try {
        if (writeCandidates) {
          let lastError = null;
          let successfulIdentifier = '';
          for (const candidate of writeCandidates) {
            try {
              await jira.write({
                method: candidate.method,
                path: candidate.path,
                body: candidate.body,
                signal: intent.signal,
              });
              successfulIdentifier = candidate.identifier;
              break;
            } catch (error) {
              lastError = error;
            }
          }
          if (!successfulIdentifier) throw lastError || new Error('Could not update assignee');
          preferredAssigneeIdentifier = successfulIdentifier;
        } else {
          await jira.write({
            ...writeRequest,
            signal: intent.signal,
          });
        }
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
    resolvedFieldId = '';
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
        if (edit?.selectionMode === 'multi') {
          if (intent.ctrlKey || intent.metaKey) return save(intent);
          const optionId = edit?.highlightedOptionId || visibleSelectableOptions()[0]?.id;
          return optionId ? selectOption({...intent, optionId}) : outcome('ignored');
        }
        if (edit?.selectionMode !== 'text') {
          const optionId = edit?.selectedOptionId || edit?.highlightedOptionId || visibleSelectableOptions()[0]?.id;
          const selected = await selectOption({...intent, optionId: edit?.highlightedOptionId || optionId});
          if (edit?.editorType !== 'transition-select' && selected.kind === 'changed') {
            return save(intent);
          }
          return selected;
        }
        return save(intent);
      }
    }
    return outcome('ignored');
  }

  return {attach, detach, dispatch, view};
}
