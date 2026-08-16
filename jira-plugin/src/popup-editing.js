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
    hasLabelSuggestionSupport,
    refreshPopupIssueState,
    renderIssuePopup,
    requestJson,
    getCustomFieldEditorDefinition,
    getPopupState,
    setPopupState,
  } = deps;

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

  async function getEditableFieldDefinition(fieldKey, issueData) {
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
