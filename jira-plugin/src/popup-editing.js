export function createPopupEditing(deps) {
  const {
    INSTANCE_URL,
    assigneeLocalOptionsCache,
    buildEditFieldError,
    compareSprintState,
    formatSprintOptionLabel,
    formatSprintText,
    formatVersionText,
    get,
    getCachedValue,
    getEditableFieldCapability,
    getLabelSuggestions,
    getRecentIssueSearchOptions,
    getSprintFieldIds,
    getTransitionOptions,
    hasLabelSuggestionSupport,
    fieldOptionsCache,
    labelLocalOptionsCache,
    normalizeIssueTypeOptions,
    pickSprintFieldId,
    readSprintBoardRefsFromIssue,
    readSprintsFromIssue,
    refreshPopupIssueState,
    renderIssuePopup,
    requestJson,
    resolveIssueLinkage,
    searchAssignableUsers,
    searchParentCandidates,
    getCustomFieldEditorDefinition,
    getPopupState,
    setPopupState,
  } = deps;

  let preferredAssigneeIdentifier = '';

  function buildEditOption(id, label, extra = {}) {
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

  function normalizeFixVersionSortName(name) {
    return String(name || '').trim().replace(/^v(?=\d)/i, '');
  }

  function compareFixVersionOptions(left, right) {
    return normalizeFixVersionSortName(right?.name).localeCompare(normalizeFixVersionSortName(left?.name), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
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

  function compareBoardRefs(left, right, issueProjectKey = '') {
    const normalizedIssueProjectKey = String(issueProjectKey || '').trim();
    const leftProjectKey = String(left?.projectKey || '').trim();
    const rightProjectKey = String(right?.projectKey || '').trim();
    const leftMatchesProject = normalizedIssueProjectKey && leftProjectKey === normalizedIssueProjectKey;
    const rightMatchesProject = normalizedIssueProjectKey && rightProjectKey === normalizedIssueProjectKey;
    if (leftMatchesProject !== rightMatchesProject) {
      return leftMatchesProject ? -1 : 1;
    }
    const nameOrder = String(left?.name || '').localeCompare(String(right?.name || ''), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
    if (nameOrder !== 0) {
      return nameOrder;
    }
    return String(left?.id || '').localeCompare(String(right?.id || ''), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  }

  function pickPreferredSprintBoardRef(sprint, issueProjectKey = '') {
    const boardRefs = Array.isArray(sprint?.boardRefs) ? sprint.boardRefs : [];
    const sortedBoardRefs = boardRefs.slice().sort((left, right) => compareBoardRefs(left, right, issueProjectKey));
    return sortedBoardRefs[0] || null;
  }

  function getSprintBoardGroupMeta(sprint, issueData, issueBoardIds = []) {
    const projectName = String(issueData?.fields?.project?.name || '').trim();
    const projectKey = String(issueData?.key || '').split('-')[0];
    const preferredBoardRef = pickPreferredSprintBoardRef(sprint, projectKey);
    const boardId = String(preferredBoardRef?.id || '').trim();
    const boardName = String(preferredBoardRef?.name || '').trim();
    const boardProjectKey = String(preferredBoardRef?.projectKey || '').trim();
    const issueBoardIdSet = new Set((Array.isArray(issueBoardIds) ? issueBoardIds : []).map(id => String(id || '')).filter(Boolean));
    const isIssueBoard = Array.isArray(sprint?.boardRefs)
      ? sprint.boardRefs.some(ref => issueBoardIdSet.has(String(ref?.id || '')))
      : false;

    return {
      groupKey: boardId ? `board:${boardId}` : '__other_boards__',
      groupLabel: boardName || (boardProjectKey ? `${boardProjectKey} board` : (projectName || projectKey || 'Other boards')),
      sortKey: isIssueBoard ? '0' : '1',
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

  async function getProjectVersionOptions(issueData, cacheKey) {
    const projectKey = String(issueData?.key || '').split('-')[0];
    if (!projectKey) {
      return [];
    }
    return getCachedValue(fieldOptionsCache, `${cacheKey}__${projectKey}`, async () => {
      const versions = await get(`${INSTANCE_URL}rest/api/2/project/${encodeURIComponent(projectKey)}/versions`);
      return (Array.isArray(versions) ? versions : [])
        .filter(version => version?.name && !version?.archived)
        .sort(compareFixVersionOptions)
        .map(version => buildEditOption(version.id, version.name, {rawValue: version}));
    });
  }

  function getFixVersionOptions(issueData) {
    return getProjectVersionOptions(issueData, 'fixVersions');
  }

  function getAffectsVersionOptions(issueData) {
    return getProjectVersionOptions(issueData, 'versions');
  }

  async function getProjectSprintBoards(issueData) {
    const projectKey = String(issueData?.key || '').split('-')[0];
    if (!projectKey) {
      return [];
    }
    const boardResponse = await get(`${INSTANCE_URL}rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&maxResults=50`).catch(() => null);
    const projectBoards = Array.isArray(boardResponse?.values) ? boardResponse.values : [];
    return projectBoards
      .map(board => ({
        ...board,
        id: String(board?.id || '').trim(),
        name: String(board?.name || '').trim(),
        projectKey: String(board?.projectKey || projectKey),
      }))
      .filter(board => !!board.id);
  }

  function mergeSprintBoards(projectKey, ...boardLists) {
    const boardsById = new Map();
    boardLists.flat().forEach(board => {
      const boardId = String(board?.id || '').trim();
      if (!boardId) {
        return;
      }
      const existingBoard = boardsById.get(boardId) || {};
      boardsById.set(boardId, {
        ...existingBoard,
        ...board,
        id: boardId,
        name: String(board?.name || existingBoard.name || '').trim(),
        projectKey: String(board?.projectKey || existingBoard.projectKey || projectKey),
      });
    });
    return [...boardsById.values()];
  }

  async function getSprintOptions(issueData) {
    const projectKey = String(issueData?.key || '').split('-')[0];
    if (!projectKey) {
      return [];
    }
    const sprintFieldIds = await getSprintFieldIds(INSTANCE_URL);
    if (!sprintFieldIds.length) {
      return [];
    }
    const issueBoardIdsKey = readSprintBoardRefsFromIssue(issueData)
      .map(board => String(board.id || ''))
      .filter(Boolean)
      .sort()
      .join(',');
    const issueBoardIds = issueBoardIdsKey ? issueBoardIdsKey.split(',').filter(Boolean) : [];
    return getCachedValue(fieldOptionsCache, `sprint__${projectKey}__${issueBoardIdsKey}`, async () => {
      const projectBoards = await getProjectSprintBoards(issueData);
      const baselineBoards = mergeSprintBoards(projectKey, projectBoards);
      const sprintMap = new Map();
      const sprintResponses = await Promise.allSettled(baselineBoards.map(board => {
        return get(`${INSTANCE_URL}rest/agile/1.0/board/${board.id}/sprint?state=active,future&maxResults=50`)
          .then(response => ({board, response}));
      }));

      sprintResponses.forEach(result => {
        if (result.status !== 'fulfilled') {
          return;
        }
        const sprints = Array.isArray(result.value?.response?.values) ? result.value.response.values : [];
        sprints.forEach(sprint => {
          if (!sprint?.id || !sprint?.name) {
            return;
          }
          const sprintId = String(sprint.id);
          const existingSprint = sprintMap.get(sprintId);
          const boardRefs = Array.isArray(existingSprint?.boardRefs) ? existingSprint.boardRefs.slice() : [];
          const board = result.value?.board || {};
          const boardRefKey = String(board.id || '');
          if (boardRefKey && !boardRefs.some(ref => String(ref.id) === boardRefKey)) {
            boardRefs.push({
              id: board.id,
              name: board.name || '',
              projectKey: board.projectKey || projectKey,
            });
          }
          sprintMap.set(sprintId, {
            ...(existingSprint || {}),
            ...sprint,
            boardRefs,
          });
        });
      });

      const currentSprints = readSprintsFromIssue(issueData);
      const currentOpenSprints = currentSprints.filter(sprint => String(sprint?.state || '').toLowerCase() !== 'closed');
      if (currentOpenSprints.length) {
        const referencedBoards = readSprintBoardRefsFromIssue(issueData);
        const extraBoards = mergeSprintBoards(
          projectKey,
          referencedBoards.filter(board => !baselineBoards.some(projectBoard => String(projectBoard.id) === String(board.id)))
        );
        if (extraBoards.length) {
          const extraSprintResponses = await Promise.allSettled(extraBoards.map(board => {
            return get(`${INSTANCE_URL}rest/agile/1.0/board/${board.id}/sprint?state=active,future&maxResults=50`)
              .then(response => ({board, response}));
          }));

          extraSprintResponses.forEach(result => {
            if (result.status !== 'fulfilled') {
              return;
            }
            const sprints = Array.isArray(result.value?.response?.values) ? result.value.response.values : [];
            sprints.forEach(sprint => {
              if (!sprint?.id || !sprint?.name) {
                return;
              }
              const sprintId = String(sprint.id);
              if (!currentOpenSprints.some(currentSprint => String(currentSprint?.id || '') === sprintId)) {
                return;
              }
              const existingSprint = sprintMap.get(sprintId);
              const boardRefs = Array.isArray(existingSprint?.boardRefs) ? existingSprint.boardRefs.slice() : [];
              const board = result.value?.board || {};
              const boardRefKey = String(board.id || '');
              if (boardRefKey && !boardRefs.some(ref => String(ref.id) === boardRefKey)) {
                boardRefs.push({
                  id: board.id,
                  name: board.name || '',
                  projectKey: board.projectKey || projectKey,
                });
              }
              sprintMap.set(sprintId, {
                ...(existingSprint || {}),
                ...sprint,
                boardRefs,
              });
            });
          });
        }
      }

      const groupedSprintOptions = [...sprintMap.values()]
        .filter(sprint => String(sprint?.state || '').toLowerCase() !== 'closed')
        .sort((left, right) => {
          const stateOrder = compareSprintState(left?.state, right?.state);
          if (stateOrder !== 0) {
            return stateOrder;
          }
          return String(left?.name || '').localeCompare(String(right?.name || ''));
        })
        .map(sprint => {
          const groupMeta = getSprintBoardGroupMeta(sprint, issueData, issueBoardIds);
          return buildEditOption(sprint.id, formatSprintOptionLabel(sprint), {
            groupKey: groupMeta.groupKey,
            groupLabel: groupMeta.groupLabel,
            groupSortKey: groupMeta.sortKey,
            rawValue: sprint,
          });
        });

      return [
        buildEditOption('', 'No sprint'),
        ...buildGroupedOptionList(groupedSprintOptions, {
          hideSingleGroup: true,
          preferredGroupKey: '',
        }),
      ];
    });
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

  async function getEditableFieldDefinition(fieldKey, issueData) {
    if (fieldKey === 'versions') {
      const capability = await getEditableFieldCapability(issueData, fieldKey);
      if (!capability.editable) {
        return null;
      }
      const currentVersions = issueData?.fields?.versions || [];
      return {
        fieldKey,
        editorType: 'multi-select',
        label: 'Affects version',
        selectionMode: 'multi',
        currentText: formatVersionText(currentVersions),
        currentSelections: currentVersions
          .filter(version => version?.id && version?.name)
          .map(version => buildEditOption(version.id, version.name, {rawValue: version})),
        initialInputValue: '',
        loadOptions: () => getAffectsVersionOptions(issueData),
        save: selectedOptions => requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
          fields: {
            versions: selectedOptions.map(option => ({id: option.id})),
          },
        }),
        successMessage: selectedOptions => selectedOptions.length ? 'Affects versions updated' : 'Affects versions cleared',
      };
    }

    if (fieldKey === 'fixVersions') {
      const capability = await getEditableFieldCapability(issueData, fieldKey);
      if (!capability.editable) {
        return null;
      }
      const currentFixVersions = issueData?.fields?.fixVersions || [];
      return {
        fieldKey,
        editorType: 'multi-select',
        label: 'Fix version',
        selectionMode: 'multi',
        currentText: formatVersionText(currentFixVersions),
        currentSelections: currentFixVersions
          .filter(version => version?.id && version?.name)
          .map(version => buildEditOption(version.id, version.name, {rawValue: version})),
        initialInputValue: '',
        loadOptions: () => getFixVersionOptions(issueData),
        save: selectedOptions => requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
          fields: {
            fixVersions: selectedOptions.map(option => ({id: option.id})),
          },
        }),
        successMessage: selectedOptions => selectedOptions.length ? 'Fix versions updated' : 'Fix versions cleared',
      };
    }

    if (fieldKey === 'sprint') {
      const capability = await getEditableFieldCapability(issueData, fieldKey);
      if (!capability.editable) {
        return null;
      }
      const currentSprints = readSprintsFromIssue(issueData);
      return {
        fieldKey,
        editorType: 'single-select',
        label: 'Sprint',
        selectionMode: 'single',
        currentText: formatSprintText(currentSprints),
        currentOptionId: currentSprints.length === 1 ? String(currentSprints[0]?.id || '') : null,
        currentSelections: currentSprints.length === 1
          ? [buildEditOption(currentSprints[0]?.id, formatSprintOptionLabel(currentSprints[0]), {rawValue: currentSprints[0]})]
          : [],
        initialInputValue: '',
        loadOptions: () => getSprintOptions(issueData),
        save: async selectedOptions => {
          const option = selectedOptions[0] || buildEditOption('', 'No sprint');
          const sprintFieldId = pickSprintFieldId(issueData, await getSprintFieldIds(INSTANCE_URL));
          if (!sprintFieldId) {
            throw new Error('Could not resolve the Sprint field');
          }
          await requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
            fields: {
              [sprintFieldId]: option.id ? (Number(option.id) || option.id) : [],
            },
          });
        },
        successMessage: selectedOptions => {
          const option = selectedOptions[0] || buildEditOption('', 'No sprint');
          return option.id ? `Sprint set to ${option.label}` : 'Sprint cleared';
        },
      };
    }

    if (fieldKey === 'priority') {
      const capability = await getEditableFieldCapability(issueData, 'priority');
      const allowedPriorities = capability.allowedValues || [];
      if (!capability.editable || !allowedPriorities.length) {
        return null;
      }
      const currentPriority = issueData?.fields?.priority;
      return {
        fieldKey,
        editorType: 'single-select',
        label: 'Priority',
        selectionMode: 'single',
        currentText: currentPriority?.name || '',
        currentOptionId: currentPriority?.id ? String(currentPriority.id) : null,
        currentSelections: currentPriority?.id && currentPriority?.name
          ? [buildEditOption(currentPriority.id, currentPriority.name, {iconUrl: currentPriority.iconUrl || ''})]
          : [],
        initialInputValue: '',
        loadOptions: async () => allowedPriorities
          .filter(priority => priority?.id && priority?.name)
          .map(priority => buildEditOption(priority.id, priority.name, {iconUrl: priority.iconUrl || ''})),
        save: selectedOptions => {
          const selectedPriority = selectedOptions[0];
          if (!selectedPriority?.id) {
            throw new Error('Pick a priority before saving');
          }
          return requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
            fields: {
              priority: {id: selectedPriority.id},
            },
          });
        },
        successMessage: selectedOptions => {
          const selectedPriority = selectedOptions[0];
          return selectedPriority?.label ? `Priority set to ${selectedPriority.label}` : 'Priority updated';
        },
      };
    }

    if (fieldKey === 'issuetype') {
      const capability = await getEditableFieldCapability(issueData, 'issuetype');
      const currentIssueType = issueData?.fields?.issuetype;
      const issueTypeOptions = normalizeIssueTypeOptions(capability.allowedValues || [], currentIssueType);
      const currentOption = currentIssueType?.id && currentIssueType?.name
        ? buildEditOption(currentIssueType.id, currentIssueType.name, {
            iconUrl: currentIssueType.iconUrl || '',
            metaText: currentIssueType.description || '',
            rawValue: currentIssueType,
          })
        : null;
      const allOptions = mergeEditOptions(currentOption ? [currentOption] : [], issueTypeOptions);
      if (!capability.editable || allOptions.length < 2) {
        return null;
      }
      return {
        fieldKey,
        editorType: 'single-select',
        label: 'Issue type',
        selectionMode: 'single',
        currentText: currentIssueType?.name || '',
        currentOptionId: currentOption?.id || null,
        currentSelections: currentOption ? [currentOption] : [],
        initialInputValue: '',
        loadOptions: async () => allOptions,
        save: selectedOptions => {
          const selectedIssueType = selectedOptions[0];
          if (!selectedIssueType?.id) {
            throw new Error('Pick an issue type before saving');
          }
          return requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
            fields: {
              issuetype: {id: selectedIssueType.id},
            },
          });
        },
        successMessage: selectedOptions => {
          const selectedIssueType = selectedOptions[0];
          return selectedIssueType?.label ? `Issue type set to ${selectedIssueType.label}` : 'Issue type updated';
        },
      };
    }

    if (fieldKey === 'status') {
      const transitions = await getTransitionOptions(issueData?.key);
      if (!transitions.length) {
        return null;
      }
      return {
        fieldKey,
        editorType: 'transition-select',
        label: 'Status transition',
        selectionMode: 'single',
        currentText: issueData?.fields?.status?.name || '',
        currentOptionId: null,
        currentSelections: [],
        initialInputValue: '',
        inputPlaceholder: 'Type to filter transitions',
        loadOptions: () => transitions,
        save: selectedOptions => {
          const selectedTransition = selectedOptions[0];
          if (!selectedTransition?.id) {
            throw new Error('Pick a transition before saving');
          }
          return requestJson('POST', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}/transitions`, {
            transition: {id: selectedTransition.id},
          });
        },
        successMessage: selectedOptions => {
          const selectedTransition = selectedOptions[0];
          if (selectedTransition?.targetStatusName) {
            return `Status moved to ${selectedTransition.targetStatusName}`;
          }
          return 'Status updated';
        },
      };
    }

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
        loadOptions: async () => {
          const searchedOptions = await searchAssignableUsers('', issueData);
          const options = [buildEditOption('__unassigned__', 'Unassigned', {metaText: 'Clear assignee'})];
          if (currentOption && !options.find(option => option.id === currentOption.id)) {
            options.push(currentOption);
          }
          searchedOptions.forEach(option => {
            if (!options.find(existing => existing.id === option.id)) {
              options.push(option);
            }
          });
          assigneeLocalOptionsCache.set(issueData.key, options.filter(option => option.id !== '__unassigned__'));
          return options;
        },
        searchOptions: async query => {
          const localBaselineOptions = assigneeLocalOptionsCache.get(issueData.key) || [];
          const searchedOptions = await searchAssignableUsers(query, issueData);
          const mergedOptions = [buildEditOption('__unassigned__', 'Unassigned', {metaText: 'Clear assignee'}), ...searchedOptions, ...localBaselineOptions]
            .filter((option, index, options) => option?.id && options.findIndex(candidate => candidate.id === option.id) === index);
          assigneeLocalOptionsCache.set(issueData.key, mergedOptions.filter(option => option.id !== '__unassigned__'));
          return mergedOptions;
        },
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
      const currentOption = currentLink
        ? buildEditOption(currentLink.key, `[${currentLink.key}] ${currentLink.summary || currentLink.key}`, {
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
          return mergeEditOptions([currentOption].filter(Boolean), mergeEditOptions(searchedOptions, recentOptions));
        },
        searchOptions: query => searchParentCandidates(query, issueData, linkage.mode),
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
          labelLocalOptionsCache.set(issueData.key, mergedOptions);
          return mergedOptions;
        },
        searchOptions: async query => {
          const normalizedQuery = String(query || '').trim();
          const localBaselineOptions = labelLocalOptionsCache.get(issueData.key) || [];
          const searchedOptions = await getLabelSuggestions(normalizedQuery);
          const popupState = getPopupState();
          const mergedOptions = normalizedQuery
            ? searchedOptions
            : mergeEditOptions(currentSelections, mergeEditOptions(searchedOptions, mergeEditOptions(localBaselineOptions, popupState?.editState?.options || [])));
          labelLocalOptionsCache.set(issueData.key, mergedOptions);
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

    if (String(fieldKey || '').startsWith('customfield_')) {
      const customFieldDefinition = await getCustomFieldEditorDefinition(fieldKey, issueData);
      if (customFieldDefinition) {
        return customFieldDefinition;
      }
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
      await refreshPopupIssueState(definition.successMessage(selectedOptions, submittedEditState));
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
  };
}
