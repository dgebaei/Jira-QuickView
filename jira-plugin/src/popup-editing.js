export function buildEditOption(id, label, extra = {}) {
  const normalizedLabel = String(label || '');
  const normalizedSearchText = [
    normalizedLabel,
    String(extra.searchText || ''),
    String(extra.metaText || ''),
  ]
    .join(' ')
    .trim()
    .toLowerCase();
  const option = {
    id: id === '' ? '' : String(id || ''),
    label: normalizedLabel,
    ...extra,
  };
  option.searchText = normalizedSearchText;
  return option;
}

export function createPopupEditing(deps) {
  const {
    INSTANCE_URL,
    buildEditFieldError,
    getEditableFieldCapability,
    getLabelSuggestions,
    getRecentIssueSearchOptions,
    hasLabelSuggestionSupport,
    refreshPopupIssueState,
    renderIssuePopup,
    requestJson,
    resolveIssueLinkage,
    searchAssignableUsers,
    searchUserPicker,
    searchParentCandidates,
    getCustomFieldEditorDefinition,
    getPopupState,
    setPopupState,
  } = deps;

  let preferredAssigneeIdentifier = '';

  function mergeEditOptions(primaryOptions, fallbackOptions) {
    const mergedOptions = [];
    const seen = new Set();
    [...(Array.isArray(primaryOptions) ? primaryOptions : []), ...(Array.isArray(fallbackOptions) ? fallbackOptions : [])]
      .forEach(option => {
        const optionId = String(option?.id || '');
        if (!optionId || seen.has(optionId)) {
          return;
        }
        seen.add(optionId);
        mergedOptions.push(option);
      });
    return mergedOptions;
  }

  function normalizeMultiSelectOptionIds(optionIds) {
    return [...new Set((Array.isArray(optionIds) ? optionIds : [])
      .map(optionId => String(optionId || '').trim())
      .filter(Boolean))];
  }

  function areSameOptionIds(left, right) {
    const leftIds = normalizeMultiSelectOptionIds(left).sort();
    const rightIds = normalizeMultiSelectOptionIds(right).sort();
    if (leftIds.length !== rightIds.length) {
      return false;
    }
    return leftIds.every((optionId, index) => optionId === rightIds[index]);
  }

  function resolveMultiSelectOptions(optionIds, options, fallbackOptions = []) {
    const optionMap = new Map();
    (Array.isArray(fallbackOptions) ? fallbackOptions : []).forEach(option => {
      const optionId = String(option?.id || '').trim();
      if (optionId) {
        optionMap.set(optionId, option);
      }
    });
    (Array.isArray(options) ? options : []).forEach(option => {
      const optionId = String(option?.id || '').trim();
      if (optionId) {
        optionMap.set(optionId, option);
      }
    });
    return normalizeMultiSelectOptionIds(optionIds)
      .map(optionId => optionMap.get(optionId))
      .filter(Boolean);
  }

  function buildNextMultiSelectState(editState, changes = {}) {
    const selectedOptionIds = normalizeMultiSelectOptionIds(changes.selectedOptionIds ?? editState.selectedOptionIds);
    const originalOptionIds = normalizeMultiSelectOptionIds(changes.originalOptionIds ?? editState.originalOptionIds);
    const options = changes.options ?? editState.options;
    const selectedOptions = resolveMultiSelectOptions(
      selectedOptionIds,
      options,
      changes.selectedOptions ?? editState.selectedOptions
    );
    return {
      ...editState,
      ...changes,
      options,
      selectedOptionIds,
      selectedOptions,
      originalOptionIds,
      hasChanges: !areSameOptionIds(selectedOptionIds, originalOptionIds),
    };
  }

  function buildNextTextEditState(editState, changes = {}) {
    const inputValue = String(changes.inputValue ?? editState.inputValue ?? '');
    const originalInputValue = String(changes.originalInputValue ?? editState.originalInputValue ?? '');
    return {
      ...editState,
      ...changes,
      inputValue,
      originalInputValue,
      hasChanges: inputValue !== originalInputValue,
    };
  }

  function buildGroupedOptionList(options, optionsConfig = {}) {
    const list = Array.isArray(options) ? options : [];
    const includeUngrouped = optionsConfig.includeUngrouped !== false;
    const ungroupedOptions = includeUngrouped
      ? list.filter(option => !option?.groupKey)
      : [];
    const groupedOptions = list.filter(option => option?.groupKey);
    const groups = new Map();

    groupedOptions.forEach(option => {
      const groupKey = String(option.groupKey || '').trim();
      if (!groupKey) {
        return;
      }
      const existingGroup = groups.get(groupKey) || {
        key: groupKey,
        label: String(option.groupLabel || groupKey),
        sortKey: String(option.groupSortKey || '9'),
        options: [],
      };
      existingGroup.sortKey = String(option.groupSortKey || existingGroup.sortKey || '9');
      existingGroup.options.push(option);
      groups.set(groupKey, existingGroup);
    });

    const preferredGroupKey = String(optionsConfig.preferredGroupKey || '').trim();
    const sortedGroups = [...groups.values()].sort((left, right) => {
      if (preferredGroupKey) {
        if (left.key === preferredGroupKey && right.key !== preferredGroupKey) {
          return -1;
        }
        if (right.key === preferredGroupKey && left.key !== preferredGroupKey) {
          return 1;
        }
      }
      const sortKeyOrder = String(left.sortKey || '9').localeCompare(String(right.sortKey || '9'), undefined, {
        numeric: true,
        sensitivity: 'base',
      });
      if (sortKeyOrder !== 0) {
        return sortKeyOrder;
      }
      return String(left.label || left.key).localeCompare(String(right.label || right.key), undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });

    const showGroupLabels = !(optionsConfig.hideSingleGroup && sortedGroups.length <= 1);

    return [
      ...ungroupedOptions,
      ...sortedGroups.flatMap(group => showGroupLabels
        ? [
            {
              id: `__group__${group.key}`,
              isGroupLabel: true,
              label: group.label,
              searchText: String(group.label || '').toLowerCase(),
            },
            ...group.options,
          ]
        : group.options),
    ];
  }

  function detectAssigneeIdentifier(issueData) {
    if (preferredAssigneeIdentifier) {
      return preferredAssigneeIdentifier;
    }
    const assignee = issueData?.fields?.assignee;
    if (assignee?.accountId) {
      return 'accountId';
    }
    if (assignee?.name) {
      return 'name';
    }
    if (assignee?.key) {
      return 'key';
    }
    return 'accountId';
  }

  function buildAssigneePayloadCandidates(selectedOption, issueData) {
    const preferredIdentifier = detectAssigneeIdentifier(issueData);
    const rawValue = selectedOption?.rawValue || {};
    const isUnassigned = selectedOption?.id === '__unassigned__';
    const payloadsByIdentifier = {
      accountId: isUnassigned
        ? {accountId: null}
        : rawValue.accountId ? {accountId: rawValue.accountId} : null,
      name: isUnassigned
        ? {name: null}
        : rawValue.name ? {name: rawValue.name} : null,
      key: isUnassigned
        ? {key: null}
        : rawValue.key ? {key: rawValue.key} : null,
    };
    const identifierOrder = [preferredIdentifier, 'accountId', 'name', 'key']
      .filter((value, index, array) => value && array.indexOf(value) === index);
    return identifierOrder
      .map(identifier => ({identifier, payload: payloadsByIdentifier[identifier]}))
      .filter(entry => entry.payload);
  }

  async function saveAssigneeSelection(issueData, selectedOptions) {
    const selectedOption = selectedOptions[0];
    if (!selectedOption) {
      throw new Error('Pick an assignee before saving');
    }
    const payloadCandidates = buildAssigneePayloadCandidates(selectedOption, issueData);
    if (!payloadCandidates.length) {
      throw new Error('Could not build assignee payload');
    }
    const assigneeUrl = `${INSTANCE_URL}rest/api/2/issue/${issueData.key}/assignee`;
    let lastError;
    for (const candidate of payloadCandidates) {
      try {
        await requestJson('PUT', assigneeUrl, candidate.payload);
        preferredAssigneeIdentifier = candidate.identifier;
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Could not update assignee');
  }

  async function loadAssigneeOptions(issueData, currentOption) {
    const assignableOptions = await searchAssignableUsers('', issueData);
    const options = mergeEditOptions(
      [buildEditOption('__unassigned__', 'Unassigned', {metaText: 'Clear assignee'})],
      mergeEditOptions(currentOption ? [currentOption] : [], assignableOptions)
    );
    return options;
  }

  async function searchAssigneeOptions(issueData, currentOption, query = '') {
    const baselineOptions = getPopupState()?.editState?.options || [];
    const [assignableOptions, pickerOptions] = await Promise.all([
      searchAssignableUsers(query, issueData).catch(() => []),
      searchUserPicker(query).catch(() => []),
    ]);
    const mergedOptions = mergeEditOptions(
      [buildEditOption('__unassigned__', 'Unassigned', {metaText: 'Clear assignee'})],
      mergeEditOptions(
        currentOption ? [currentOption] : [],
        mergeEditOptions(assignableOptions, mergeEditOptions(pickerOptions, baselineOptions))
      )
    );
    return mergedOptions;
  }

  async function getEditableFieldDefinition(fieldKey, issueData) {
    if (fieldKey === 'assignee') {
      const capability = await getEditableFieldCapability(issueData, 'assignee');
      if (!capability.editable) {
        return null;
      }
      const currentAssignee = issueData?.fields?.assignee;
      const currentOption = currentAssignee
        ? buildEditOption(currentAssignee.accountId || currentAssignee.name || currentAssignee.key, currentAssignee.displayName || currentAssignee.name || currentAssignee.key, {
            avatarUrl: currentAssignee.avatarUrls?.['48x48'] || '',
            metaText: currentAssignee.name || currentAssignee.key || '',
            rawValue: {
              accountId: currentAssignee.accountId || '',
              name: currentAssignee.name || '',
              key: currentAssignee.key || '',
            },
          })
        : null;
      return {
        fieldKey,
        editorType: 'user-search',
        label: 'Assignee',
        selectionMode: 'single',
        currentText: currentAssignee?.displayName || 'Unassigned',
        currentOptionId: currentOption?.id || '__unassigned__',
        currentSelections: currentOption ? [currentOption] : [buildEditOption('__unassigned__', 'Unassigned', {metaText: 'No assignee'})],
        initialInputValue: '',
        inputPlaceholder: 'Search assignable users',
        skipInitialEmptySearch: true,
        loadOptions: () => loadAssigneeOptions(issueData, currentOption),
        searchOptions: query => searchAssigneeOptions(issueData, currentOption, query),
        save: selectedOptions => saveAssigneeSelection(issueData, selectedOptions),
        successMessage: selectedOptions => {
          const selectedOption = selectedOptions[0];
          if (!selectedOption || selectedOption.id === '__unassigned__') {
            return 'Assignee cleared';
          }
          return `Assignee set to ${selectedOption.label}`;
        },
      };
    }

    if (fieldKey === 'parentLink') {
      const linkage = await resolveIssueLinkage(issueData);
      if (!linkage?.editable || !linkage.mode) {
        return null;
      }
      const currentLink = linkage.currentLink;
      const projectKey = String(issueData?.key || '').split('-')[0];
      const currentLinkProjectKey = String(currentLink?.key || '').split('-')[0];
      const currentLinkIsLocal = currentLinkProjectKey === projectKey;
      const currentOption = currentLink
        ? buildEditOption(currentLink.key, `[${currentLink.key}] ${currentLink.summary || currentLink.key}`, {
            groupKey: currentLinkIsLocal ? `project:${projectKey}` : '__other_projects__',
            groupLabel: currentLinkIsLocal ? `${projectKey} project` : 'Other projects',
            groupSortKey: currentLinkIsLocal ? '0' : '1',
            rawValue: {
              key: currentLink.key,
              summary: currentLink.summary || currentLink.key,
            },
          })
        : null;
      return {
        fieldKey,
        editorType: 'issue-search',
        label: linkage.label,
        selectionMode: 'single',
        currentText: currentLink ? `[${currentLink.key}] ${currentLink.summary || currentLink.key}` : `${linkage.label}: none`,
        currentOptionId: currentOption?.id || null,
        currentSelections: currentOption ? [currentOption] : [],
        initialInputValue: '',
        inputPlaceholder: 'Search issues by key or summary',
        loadOptions: async () => {
          const recentOptions = getRecentIssueSearchOptions(issueData, linkage.mode);
          const searchedOptions = await searchParentCandidates('', issueData, linkage.mode).catch(() => []);
          return buildGroupedOptionList(
            mergeEditOptions([currentOption].filter(Boolean), mergeEditOptions(searchedOptions, recentOptions))
          );
        },
        searchOptions: async query => buildGroupedOptionList(
          await searchParentCandidates(query, issueData, linkage.mode)
        ),
        save: selectedOptions => {
          const selectedOption = selectedOptions[0];
          const selectedIssueKey = selectedOption?.rawValue?.key || selectedOption?.id;
          if (!selectedIssueKey) {
            throw new Error(`Pick a ${linkage.label.toLowerCase()} issue before saving`);
          }
          if (linkage.mode === 'parent') {
            return requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
              fields: {
                parent: {key: selectedIssueKey},
              },
            });
          }
          if (!linkage.fieldKey) {
            throw new Error('Could not resolve Epic Link field');
          }
          return requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
            fields: {
              [linkage.fieldKey]: selectedIssueKey,
            },
          });
        },
        successMessage: selectedOptions => {
          const selectedOption = selectedOptions[0];
          const selectedIssueKey = selectedOption?.rawValue?.key || selectedOption?.id || '';
          return selectedIssueKey ? `${linkage.label} set to ${selectedIssueKey}` : `${linkage.label} updated`;
        },
      };
    }

    if (fieldKey === 'labels') {
      const capability = await getEditableFieldCapability(issueData, 'labels');
      const suggestionSupport = await hasLabelSuggestionSupport();
      if (!capability.editable || !suggestionSupport) {
        return null;
      }
      const currentLabels = (issueData?.fields?.labels || []).filter(Boolean);
      const currentSelections = currentLabels.map(label => buildEditOption(label, label, {
        searchText: label,
      }));
      return {
        fieldKey,
        editorType: 'label-search',
        label: 'Labels',
        selectionMode: 'multi',
        currentText: `Labels: ${currentLabels.join(', ') || '--'}`,
        currentOptionId: null,
        currentSelections,
        initialInputValue: '',
        inputPlaceholder: 'Search existing labels',
        loadOptions: async () => {
          const baselineSuggestions = await getLabelSuggestions('').catch(() => []);
          const mergedOptions = mergeEditOptions(currentSelections, baselineSuggestions);
          return mergedOptions;
        },
        searchOptions: async query => {
          const normalizedQuery = String(query || '').trim();
          const localBaselineOptions = getPopupState()?.editState?.options || [];
          const searchedOptions = await getLabelSuggestions(normalizedQuery);
          const popupState = getPopupState();
          const mergedOptions = normalizedQuery
            ? searchedOptions
            : mergeEditOptions(currentSelections, mergeEditOptions(searchedOptions, mergeEditOptions(localBaselineOptions, popupState?.editState?.options || [])));
          return mergedOptions;
        },
        save: selectedOptions => {
          const nextLabels = selectedOptions.map(option => option.id).filter(Boolean);
          return requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
            fields: {
              labels: nextLabels,
            },
          });
        },
        successMessage: () => 'Labels updated',
      };
    }

    if (fieldKey === 'summary') {
      const capability = await getEditableFieldCapability(issueData, 'summary');
      const operations = capability.operations || [];
      if (!capability.editable || !operations.includes('set')) {
        return null;
      }
      const currentSummary = String(issueData?.fields?.summary || '');
      return {
        fieldKey,
        editorType: 'text',
        label: 'Issue title',
        selectionMode: 'text',
        currentText: currentSummary,
        currentSelections: [],
        initialInputValue: currentSummary,
        inputPlaceholder: 'Enter a new issue title',
        showActionButtons: true,
        loadOptions: async () => [],
        save: (selectedOptions, editState) => {
          const nextSummary = String(editState?.inputValue || '').trim();
          if (!nextSummary) {
            throw new Error('Issue title cannot be empty');
          }
          return requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
            fields: {
              summary: nextSummary,
            },
          });
        },
        successMessage: () => 'Issue title updated',
      };
    }

    if (fieldKey === 'environment') {
      const capability = await getEditableFieldCapability(issueData, 'environment');
      const operations = capability.operations || [];
      if (!capability.editable || !operations.includes('set')) {
        return null;
      }
      const currentEnvironment = String(issueData?.fields?.environment || '');
      return {
        fieldKey,
        editorType: 'textarea',
        label: 'Environment',
        selectionMode: 'text',
        currentText: currentEnvironment,
        currentSelections: [],
        initialInputValue: currentEnvironment,
        inputPlaceholder: 'Describe the environment',
        showActionButtons: true,
        loadOptions: async () => [],
        save: (selectedOptions, editState) => {
          const nextEnvironment = String(editState?.inputValue || '');
          return requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
            fields: {
              environment: nextEnvironment.trim() ? nextEnvironment : null,
            },
          });
        },
        successMessage: (selectedOptions, editState) => {
          const nextEnvironment = String(editState?.inputValue || '').trim();
          return nextEnvironment ? 'Environment updated' : 'Environment cleared';
        },
      };
    }

    const fieldEditorDefinition = await getCustomFieldEditorDefinition(fieldKey, issueData);
    if (fieldEditorDefinition) {
      return fieldEditorDefinition;
    }

    return null;
  }

  function filterEditOptions(options, inputValue) {
    const normalizedInput = String(inputValue || '').trim().toLowerCase();
    const list = Array.isArray(options) ? options : [];
    const visibleOptions = normalizedInput
      ? list.filter(option => !option?.isGroupLabel && option.searchText.includes(normalizedInput))
      : list.filter(option => !option?.isGroupLabel);

    const visibleOptionKeys = new Set(visibleOptions.map(option => `${String(option?.id || '')}::${String(option?.label || '')}`));
    const groupedResult = [];
    let pendingGroupLabel = null;

    list.forEach(option => {
      if (option?.isGroupLabel) {
        pendingGroupLabel = option;
        return;
      }
      if (!visibleOptionKeys.has(`${String(option?.id || '')}::${String(option?.label || '')}`)) {
        return;
      }
      if (pendingGroupLabel) {
        groupedResult.push(pendingGroupLabel);
        pendingGroupLabel = null;
      }
      groupedResult.push(option);
    });

    return groupedResult;
  }

  function resolveSelectedEditOptions(editState) {
    if (!editState) {
      return [];
    }
    if (editState.selectionMode === 'text') {
      return [];
    }
    if (editState.selectionMode === 'multi') {
      return Array.isArray(editState.selectedOptions) ? editState.selectedOptions : [];
    }
    if (editState.selectedOptionId !== null && typeof editState.selectedOptionId !== 'undefined') {
      const selectedOption = (editState.options || []).find(option => option.id === editState.selectedOptionId);
      if (selectedOption) {
        return [selectedOption];
      }
    }
    const normalizedInput = String(editState.inputValue || '').trim().toLowerCase();
    if (!normalizedInput) {
      return [];
    }
    const exactOption = (editState.options || []).find(option => option.label.toLowerCase() === normalizedInput);
    return exactOption ? [exactOption] : [];
  }

  function toggleMultiSelectOptionFromInput(fieldKey, preferredOptionId = null) {
    const popupState = getPopupState();
    if (!popupState?.editState || popupState.editState.fieldKey !== fieldKey || popupState.editState.selectionMode !== 'multi') {
      return false;
    }

    const visibleOptions = filterEditOptions(popupState.editState.options, popupState.editState.inputValue)
      .filter(option => !option?.isGroupLabel);
    const nextOption = visibleOptions.find(option => option.id === preferredOptionId) || visibleOptions[0];
    if (!nextOption?.id) {
      return false;
    }

    const selectedOptionIds = normalizeMultiSelectOptionIds(popupState.editState.selectedOptionIds);
    const nextSelectedOptionIds = selectedOptionIds.includes(nextOption.id)
      ? selectedOptionIds.filter(candidateId => candidateId !== nextOption.id)
      : [...selectedOptionIds, nextOption.id];

    setPopupState({
      ...popupState,
      editState: buildNextMultiSelectState(popupState.editState, {
        selectedOptionIds: nextSelectedOptionIds,
        highlightedOptionId: nextOption.id,
        errorMessage: '',
      }),
    });
    renderIssuePopup(getPopupState()).catch(() => {});
    return true;
  }

  async function submitFieldEdit(fieldKey) {
    const popupState = getPopupState();
    if (!popupState?.editState || popupState.editState.fieldKey !== fieldKey || popupState.editState.loadingOptions || popupState.editState.saving) {
      return;
    }
    const definition = await getEditableFieldDefinition(fieldKey, popupState.issueData);
    if (!definition) {
      return;
    }
    const selectedOptions = resolveSelectedEditOptions(popupState.editState);
    if (popupState.editState.selectionMode === 'multi' || popupState.editState.selectionMode === 'text') {
      if (!popupState.editState.hasChanges) {
        return;
      }
    } else if (!selectedOptions.length) {
      const errorMessage = 'Pick an existing value from the dropdown before pressing Enter';
      setPopupState({
        ...popupState,
        editState: {
          ...popupState.editState,
          errorMessage,
        },
      });
      await renderIssuePopup(getPopupState());
      return;
    }

    setPopupState({
      ...popupState,
      editState: popupState.editState.selectionMode === 'multi'
        ? buildNextMultiSelectState(popupState.editState, {saving: true, errorMessage: ''})
        : popupState.editState.selectionMode === 'text'
          ? buildNextTextEditState(popupState.editState, {saving: true, errorMessage: ''})
          : {
              ...popupState.editState,
              saving: true,
              errorMessage: '',
            },
    });
    await renderIssuePopup(getPopupState());

    try {
      const submittedEditState = getPopupState().editState;
      await definition.save(selectedOptions, submittedEditState);
      await refreshPopupIssueState(definition.successMessage(selectedOptions, submittedEditState), {
        mutation: {kind: 'fieldChanged', fieldId: definition.fieldKey || fieldKey},
      });
    } catch (error) {
      const currentPopupState = getPopupState();
      const errorMessage = buildEditFieldError(error);
      if (!currentPopupState?.editState || currentPopupState.editState.fieldKey !== fieldKey) {
        return;
      }
      setPopupState({
        ...currentPopupState,
        editState: currentPopupState.editState.selectionMode === 'multi'
          ? buildNextMultiSelectState(currentPopupState.editState, {saving: false, errorMessage})
          : currentPopupState.editState.selectionMode === 'text'
            ? buildNextTextEditState(currentPopupState.editState, {saving: false, errorMessage})
            : {
                ...currentPopupState.editState,
                saving: false,
                errorMessage,
              },
      });
      await renderIssuePopup(getPopupState());
    }
  }

  return {
    buildEditOption,
    buildNextMultiSelectState,
    buildNextTextEditState,
    filterEditOptions,
    getEditableFieldDefinition,
    mergeEditOptions,
    normalizeMultiSelectOptionIds,
    resolveSelectedEditOptions,
    submitFieldEdit,
    toggleMultiSelectOptionFromInput,
  };
}
