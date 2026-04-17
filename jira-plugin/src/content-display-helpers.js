export function createContentDisplayHelpers(options) {
  const buildActivityIndicatorsDefault = options?.buildActivityIndicatorsDefault;
  const buildHistoryAttachmentLookup = options?.buildHistoryAttachmentLookup;
  const buildCommentsForDisplay = options?.buildCommentsForDisplay;
  const buildCustomFieldChips = options?.buildCustomFieldChips;
  const buildEditableFieldChip = options?.buildEditableFieldChip;
  const buildFilterChip = options?.buildFilterChip;
  const buildLabelsChip = options?.buildLabelsChip;
  const buildLinkHoverTitle = options?.buildLinkHoverTitle;
  const buildQuickActionViewData = options?.buildQuickActionViewData;
  const buildTimeTrackingSectionPresentation = options?.buildTimeTrackingSectionPresentation;
  const buildUserView = options?.buildUserView;
  const buildActiveEditPresentation = options?.buildActiveEditPresentation;
  const displayFields = options?.displayFields || {};
  const encodeJqlValue = options?.encodeJqlValue;
  const formatFixVersionText = options?.formatFixVersionText;
  const formatPullRequestAuthor = options?.formatPullRequestAuthor;
  const formatPullRequestBranch = options?.formatPullRequestBranch;
  const formatPullRequestTitle = options?.formatPullRequestTitle;
  const formatSprintText = options?.formatSprintText;
  const getEditableFieldCapability = options?.getEditableFieldCapability;
  const getTransitionOptions = options?.getTransitionOptions;
  const getVisibleSprintsForDisplay = options?.getVisibleSprintsForDisplay;
  const hasLabelSuggestionSupport = options?.hasLabelSuggestionSupport;
  const instanceUrl = options?.instanceUrl || '';
  const layoutContentBlocks = options?.layoutContentBlocks || [];
  const loaderGifUrl = options?.loaderGifUrl || '';
  const normalizeIssueTypeOptions = options?.normalizeIssueTypeOptions;
  const normalizeCommentSortOrder = options?.normalizeCommentSortOrder || (value => value === 'newest' ? 'newest' : 'oldest');
  const normalizeRichHtml = options?.normalizeRichHtml;
  const readSprintsFromIssue = options?.readSprintsFromIssue;
  const resolveIssueLinkage = options?.resolveIssueLinkage;
  const scopeJqlToProject = options?.scopeJqlToProject;
  const showPullRequests = !!options?.showPullRequests;
  const tooltipLayout = options?.tooltipLayout || {};

  function normalizeSecondaryStatusChip(chip) {
    if (!chip) {
      return chip;
    }
    return {
      ...chip,
      renderLinkTitle: chip.linkTitle || chip.chipTitle || '',
      renderContentTitle: chip.chipTitle || chip.linkTitle || '',
    };
  }

  function buildAttachmentChips(attachments) {
    const totals = {
      image: 0,
      pdf: 0,
      doc: 0,
      other: 0
    };

    (attachments || []).forEach(attachment => {
      const mimeType = (attachment.mimeType || '').toLowerCase();
      if (mimeType.startsWith('image/')) {
        totals.image += 1;
      } else if (mimeType === 'application/pdf') {
        totals.pdf += 1;
      } else if (
        mimeType.includes('word') ||
        mimeType.includes('excel') ||
        mimeType.includes('powerpoint') ||
        mimeType.includes('officedocument') ||
        mimeType.includes('msword') ||
        mimeType.includes('opendocument') ||
        mimeType.includes('rtf') ||
        mimeType.startsWith('text/')
      ) {
        totals.doc += 1;
      } else {
        totals.other += 1;
      }
    });

    const chips = [];
    if (totals.image) chips.push({icon: '🖼️', count: totals.image});
    if (totals.pdf) chips.push({icon: '📕', count: totals.pdf});
    if (totals.doc) chips.push({icon: '📝', count: totals.doc});
    if (totals.other) chips.push({icon: '📎', count: totals.other});
    return chips;
  }

  function buildActivityIndicators() {
    if (typeof buildActivityIndicatorsDefault === 'function') {
      return buildActivityIndicatorsDefault();
    }
    return [];
  }

  function buildWatchersPanelView(state) {
    const emptyWatchersState = options?.emptyWatchersState;
    const watcherState = state?.watchersState || emptyWatchersState();
    const watchers = Array.isArray(watcherState.watchers) ? watcherState.watchers : [];
    const pendingAddIds = new Set(watcherState.pendingAddIds || []);
    const pendingRemoveIds = new Set(watcherState.pendingRemoveIds || []);
    const watcherIds = new Set(watchers.map(watcher => watcher.id));
    const addFeedback = watcherState.addFeedback;
    const removeFeedback = watcherState.removeFeedback;
    const searchResults = (watcherState.searchResults || [])
      .filter(result => result?.id && !watcherIds.has(result.id))
      .map(result => ({
        ...result,
        isPending: pendingAddIds.has(result.id),
        disabledAttr: pendingAddIds.has(result.id) ? 'disabled' : ''
      }));
    return {
      isOpen: !!watcherState.open,
      isLoading: !!watcherState.loading,
      loadingText: watcherState.loading ? 'Loading watchers...' : '',
      errorMessage: watcherState.errorMessage || '',
      searchValue: watcherState.searchValue || '',
      searchLoading: !!watcherState.searchLoading,
      searchHintText: watcherState.searchValue
        ? ''
        : 'Start typing to find users.',
      watchers: watchers.map(watcher => ({
        ...watcher,
        hasAvatar: !!watcher.avatarUrl,
        pendingRemove: pendingRemoveIds.has(watcher.id),
        pendingAction: pendingRemoveIds.has(watcher.id) ? 'Removing...' : '',
        removeDisabled: pendingRemoveIds.has(watcher.id) ? 'disabled' : ''
      })),
      hasWatchers: watchers.length > 0,
      emptyText: watcherState.loading ? '' : 'No watchers yet.',
      searchResults,
      hasSearchSection: searchResults.length > 0 || !!addFeedback,
      hasSearchResults: searchResults.length > 0,
      searchFeedback: addFeedback,
      hasSearchFeedback: !!addFeedback,
      showSearchEmpty: !!(watcherState.searchValue && !watcherState.searchLoading && searchResults.length === 0 && !addFeedback),
      searchEmptyText: 'No matching users.',
      hasWatcherSectionContent: watchers.length > 0 || !!removeFeedback,
      watcherFeedback: removeFeedback,
      hasWatcherFeedback: !!removeFeedback,
    };
  }

  function buildUserAvatarView(user, titlePrefix, fallbackInitials = '--') {
    const view = buildUserView(user);
    return {
      avatarUrl: view.avatarUrl,
      initials: view.displayName ? view.initials : fallbackInitials,
      displayName: view.displayName,
      titleText: `${titlePrefix}: ${view.displayName || 'Unknown'}`
    };
  }

  function buildAssigneeAvatarView(state, issueData, canEditAssignee) {
    const assignee = issueData?.fields?.assignee;
    const displayName = assignee?.displayName || 'Unassigned';
    const baseAvatarView = assignee
      ? buildUserAvatarView(assignee, 'Assignee', '--')
      : {
          avatarUrl: '',
          initials: '--',
          displayName,
          titleText: 'Assignee: Unassigned'
        };
    const activeEdit = buildActiveEditPresentation('assignee', state);
    return {
      ...baseAvatarView,
      displayName,
      placeholderText: assignee ? '' : 'Unassigned',
      isEditable: !!canEditAssignee,
      editTitle: activeEdit ? 'Discard' : (assignee ? 'Edit assignee' : 'Assign issue'),
      ...(activeEdit || {})
    };
  }

  function buildTitleView(state, issueData, canEditTitle) {
    const issueKey = String(issueData?.key || '');
    const summary = String(issueData?.fields?.summary || '');
    const issueUrl = `${instanceUrl}browse/${issueKey}`;
    const activeEdit = buildActiveEditPresentation('summary', state);
    return {
      ticketKey: issueKey,
      ticketTitle: summary,
      keyPrefix: `[${issueKey}]`,
      url: issueUrl,
      urlTitle: `[${issueKey}] ${summary}`,
      urlHoverTitle: buildLinkHoverTitle('Open issue in Jira', `[${issueKey}] ${summary}`, issueUrl),
      isEditable: !!canEditTitle,
      editTitle: activeEdit ? 'Discard title changes' : 'Edit issue title',
      ...(activeEdit || {})
    };
  }

  function compareNaturalText(left, right) {
    return String(left || '').localeCompare(String(right || ''), undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  }

  function buildRelatedUserCellView(user, titlePrefix, emptyLabel = '--') {
    if (user) {
      const view = buildUserAvatarView(user, titlePrefix, '--');
      const displayName = view.displayName || emptyLabel;
      return {
        avatarUrl: view.avatarUrl,
        initials: view.initials || '--',
        displayName,
        titleText: `${titlePrefix}: ${displayName}`
      };
    }
    return {
      avatarUrl: '',
      initials: '--',
      displayName: emptyLabel,
      titleText: `${titlePrefix}: ${emptyLabel}`
    };
  }

  function normalizeChildrenSortState(sort) {
    return {
      column: ['type', 'key', 'status', 'assignee'].includes(sort?.column)
        ? sort.column
        : 'key',
      direction: sort?.direction === 'desc'
        ? 'desc'
        : 'asc'
    };
  }

  function normalizePullRequestsSortState(sort) {
    return {
      column: ['title', 'author', 'branch', 'status'].includes(sort?.column)
        ? sort.column
        : 'title',
      direction: sort?.direction === 'desc'
        ? 'desc'
        : 'asc'
    };
  }

  function buildRelatedTableSortHeader(sort, column, label, sortLabel = label) {
    const isActive = sort.column === column;
    const isAscendingActive = isActive && sort.direction === 'asc';
    const isDescendingActive = isActive && sort.direction === 'desc';
    const nextDirection = isActive && sort.direction === 'asc' ? 'desc' : 'asc';
    return {
      column,
      label,
      ariaSort: isActive
        ? (sort.direction === 'asc' ? 'ascending' : 'descending')
        : 'none',
      isActive,
      isAscendingActive,
      isDescendingActive,
      title: `Sort by ${String(sortLabel || label).toLowerCase()} ${nextDirection === 'asc' ? 'ascending' : 'descending'}`
    };
  }

  function compareChildrenRows(left, right, column, direction) {
    let result = 0;
    switch (column) {
      case 'type':
        result = compareNaturalText(left?.issueTypeName, right?.issueTypeName);
        break;
      case 'status':
        result = compareNaturalText(left?.statusText, right?.statusText);
        break;
      case 'assignee':
        result = compareNaturalText(left?.assigneeView?.displayName, right?.assigneeView?.displayName);
        break;
      case 'key':
      default:
        result = compareNaturalText(left?.issueKey, right?.issueKey);
        break;
    }
    if (result !== 0) {
      return direction === 'desc' ? result * -1 : result;
    }
    return compareNaturalText(left?.issueKey, right?.issueKey);
  }

  function comparePullRequestRows(left, right, column, direction) {
    let result = 0;
    switch (column) {
      case 'author':
        result = compareNaturalText(left?.authorView?.displayName, right?.authorView?.displayName);
        break;
      case 'branch':
        result = compareNaturalText(left?.branchText, right?.branchText);
        break;
      case 'status':
        result = compareNaturalText(left?.statusText, right?.statusText);
        break;
      case 'title':
      default:
        result = compareNaturalText(left?.sortTitleText, right?.sortTitleText);
        break;
    }
    if (result !== 0) {
      return direction === 'desc' ? result * -1 : result;
    }
    return compareNaturalText(left?.title, right?.title);
  }

  async function buildPopupDisplayData(state) {
    const {
      key,
      issueData,
      children,
      childrenError,
      childrenSort,
      commentSortOrder,
      pullRequests,
      pullRequestsSort,
      actionLoadingKey,
      actionError,
      lastActionSuccess,
      actionsOpen,
      quickActions,
      historyOpen,
      changelogData,
      changelogLoading,
    } = state;
    const descriptionAttachmentLookup = buildHistoryAttachmentLookup(issueData.fields.attachment || []);
    const normalizedDescription = await normalizeRichHtml(issueData.renderedFields.description, {
      attachmentLookup: descriptionAttachmentLookup,
      imageMaxHeight: 180
    });
    const normalizedCommentSortOrder = normalizeCommentSortOrder(commentSortOrder);
    const commentsForDisplay = await buildCommentsForDisplay(
      issueData,
      state.commentSession,
      state.commentReactionState,
      normalizedCommentSortOrder
    );
    const fixVersions = issueData.fields.fixVersions || [];
    const affectsVersions = issueData.fields.versions || [];
    const sprints = readSprintsFromIssue(issueData);
    const commentsTotal = commentsForDisplay.length;
    const attachments = issueData.fields.attachment || [];
    const previewAttachments = options?.buildPreviewAttachments(attachments);
    const labels = issueData.fields.labels || [];
    const linkageData = await resolveIssueLinkage(issueData);
    const issueTypeName = issueData.fields.issuetype?.name;
    const statusName = issueData.fields.status?.name;
    const priorityName = issueData.fields.priority?.name;
    const projectKey = key.split('-')[0];
    const [
      issueTypeCapability,
      priorityCapability,
      assigneeCapability,
      transitionOptions,
      sprintCapability,
      affectsCapability,
      fixVersionsCapability,
      labelsCapability,
      environmentCapability,
      labelSuggestionSupport,
      summaryCapability,
      descriptionCapability,
      timeTrackingCapability,
      customFieldChips,
    ] = await Promise.all([
      displayFields.issueType ? getEditableFieldCapability(issueData, 'issuetype') : Promise.resolve({editable: false, allowedValues: []}),
      displayFields.priority ? getEditableFieldCapability(issueData, 'priority') : Promise.resolve({editable: false}),
      displayFields.assignee ? getEditableFieldCapability(issueData, 'assignee') : Promise.resolve({editable: false}),
      displayFields.status ? getTransitionOptions(issueData.key).catch(() => []) : Promise.resolve([]),
      displayFields.sprint ? getEditableFieldCapability(issueData, 'sprint') : Promise.resolve({editable: false}),
      displayFields.affects ? getEditableFieldCapability(issueData, 'versions') : Promise.resolve({editable: false}),
      displayFields.fixVersions ? getEditableFieldCapability(issueData, 'fixVersions') : Promise.resolve({editable: false}),
      displayFields.labels ? getEditableFieldCapability(issueData, 'labels') : Promise.resolve({editable: false}),
      displayFields.environment ? getEditableFieldCapability(issueData, 'environment') : Promise.resolve({editable: false, operations: []}),
      displayFields.labels ? hasLabelSuggestionSupport() : Promise.resolve(false),
      getEditableFieldCapability(issueData, 'summary').catch(() => ({editable: false, operations: []})),
      getEditableFieldCapability(issueData, 'description').catch(() => ({editable: false, operations: []})),
      getEditableFieldCapability(issueData, 'timetracking').catch(() => ({editable: false})),
      buildCustomFieldChips(issueData, options?.customFields || [], state)
    ]);
    const statusEditable = Array.isArray(transitionOptions) && transitionOptions.length > 0;
    const issueTypeEditable = !!issueTypeCapability?.editable && normalizeIssueTypeOptions(issueTypeCapability.allowedValues || [], issueData.fields.issuetype).length > 1;
    const priorityEditable = !!priorityCapability?.editable;
    const assigneeEditable = !!assigneeCapability?.editable;
    const labelsEditable = !!labelsCapability?.editable && !!labelSuggestionSupport;
    const environmentEditable = !!environmentCapability?.editable && (environmentCapability.operations || []).includes('set');
    const summaryEditable = !!summaryCapability?.editable && (summaryCapability.operations || []).includes('set');
    const descriptionEditable = !!descriptionCapability?.editable && (descriptionCapability.operations || []).includes('set');

    const layoutRow1 = tooltipLayout?.row1 || ['issueType', 'status', 'priority'];
    const layoutRow2 = tooltipLayout?.row2 || ['epicParent', 'sprint', 'affects', 'fixVersions'];
    const layoutRow3 = tooltipLayout?.row3 || ['environment', 'labels'];

    const singleAffectsVersion = affectsVersions.length === 1 ? affectsVersions[0]?.name : '';
    const singleFixVersion = fixVersions.length === 1 ? fixVersions[0]?.name : '';
    const visibleSprints = getVisibleSprintsForDisplay(sprints);
    const sprintClauses = visibleSprints
      .map(sprint => sprint?.id
        ? `sprint = ${sprint.id}`
        : (sprint?.name ? `sprint = ${encodeJqlValue(sprint.name)}` : ''))
      .filter(Boolean);
    const sprintJql = sprintClauses.length
      ? scopeJqlToProject(
          projectKey,
          sprintClauses.length === 1 ? sprintClauses[0] : `(${sprintClauses.join(' OR ')})`
        )
      : '';

    const buildRow1Chip = (fieldKey) => {
      switch (fieldKey) {
        case 'issueType':
          return buildEditableFieldChip('issuetype', buildFilterChip(
            issueTypeName || 'No type',
            issueTypeName ? `${scopeJqlToProject(projectKey, `issuetype = ${encodeJqlValue(issueTypeName)}`)}` : '',
            {iconUrl: issueData.fields.issuetype?.iconUrl || '', linkLabel: issueTypeName}
          ), state, {
            canEdit: issueTypeEditable,
            editTitle: 'Edit issue type'
          });
        case 'status':
          return buildEditableFieldChip('status', buildFilterChip(
            statusName || 'No status',
            statusName ? `${scopeJqlToProject(projectKey, `status = ${encodeJqlValue(statusName)}`)}` : '',
            {iconUrl: issueData.fields.status?.iconUrl || '', linkLabel: statusName}
          ), state, {
            canEdit: statusEditable,
            editTitle: 'Change status'
          });
        case 'priority':
          return buildEditableFieldChip('priority', buildFilterChip(
            `Priority: ${priorityName || '--'}`,
            priorityName ? `${scopeJqlToProject(projectKey, `priority = ${encodeJqlValue(priorityName)}`)}` : '',
            {iconUrl: issueData.fields.priority?.iconUrl || '', linkLabel: priorityName}
          ), state, {
            canEdit: priorityEditable,
            editTitle: 'Edit priority'
          });
        case 'epicParent':
          return buildEditableFieldChip('parentLink', {
            text: linkageData?.currentLink
              ? `${linkageData.label}: [${linkageData.currentLink.key}] ${linkageData.currentLink.summary}`
              : `${linkageData?.label || 'Parent'}: --`,
            linkUrl: linkageData?.currentLink?.url || '',
            linkTitle: linkageData?.currentLink
              ? buildLinkHoverTitle(
                  linkageData.mode === 'epicLink' ? 'View epic issue' : 'View parent issue',
                  `[${linkageData.currentLink.key}] ${linkageData.currentLink.summary}`
                )
              : ''
          }, state, {
            canEdit: !!linkageData?.editable,
            editTitle: linkageData?.mode === 'epicLink' ? 'Edit epic link' : 'Edit parent'
          });
        default:
          return null;
      }
    };

    const buildRow2Chip = (fieldKey) => {
      switch (fieldKey) {
        case 'sprint':
          return buildEditableFieldChip('sprint', buildFilterChip(
            `Sprint: ${formatSprintText(sprints) || '--'}`,
            sprintJql,
            {linkLabel: visibleSprints.length > 1 ? 'listed sprints' : (formatSprintText(sprints) || '')}
          ), state, {
            canEdit: !!sprintCapability?.editable
          });
        case 'affects':
          return buildEditableFieldChip('versions', buildFilterChip(
            `Affects: ${formatFixVersionText(affectsVersions) || '--'}`,
            singleAffectsVersion ? `${scopeJqlToProject(projectKey, `affectedVersion = ${encodeJqlValue(singleAffectsVersion)}`)}` : '',
            {linkLabel: singleAffectsVersion}
          ), state, {
            canEdit: !!affectsCapability?.editable,
            isRightAligned: true
          });
        case 'fixVersions':
          return buildEditableFieldChip('fixVersions', buildFilterChip(
            `Fix version: ${formatFixVersionText(fixVersions) || '--'}`,
            singleFixVersion ? `${scopeJqlToProject(projectKey, `fixVersion = ${encodeJqlValue(singleFixVersion)}`)}` : '',
            {linkLabel: singleFixVersion}
          ), state, {
            canEdit: !!fixVersionsCapability?.editable,
            isRightAligned: true
          });
        default:
          return null;
      }
    };

    const environmentText = options?.formatEnvironmentDisplayText(issueData.fields.environment);
    const environmentTooltip = String(issueData.fields.environment || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();

    const buildRow3Chip = (fieldKey) => {
      switch (fieldKey) {
        case 'environment':
          return buildEditableFieldChip('environment', buildFilterChip(
            `Environment: ${environmentText}`,
            '',
            {
              chipTitle: environmentTooltip ? `Environment: ${environmentTooltip}` : 'Environment: --',
              truncateText: true
            }
          ), state, {
            canEdit: environmentEditable,
            editTitle: 'Edit environment'
          });
        case 'labels':
          return buildEditableFieldChip('labels', buildLabelsChip(labels, projectKey), state, {
            canEdit: labelsEditable,
            editTitle: 'Edit labels'
          });
        default:
          return null;
      }
    };

    const row1Chips = layoutRow1.map(buildRow1Chip).filter(Boolean).concat(customFieldChips[1]);
    const row2Chips = layoutRow2.map(buildRow2Chip).filter(Boolean).concat(customFieldChips[2]);
    const row3Chips = layoutRow3.map(buildRow3Chip).filter(Boolean).concat(customFieldChips[3]);
    const secondaryStatusRows = [
      {
        rowClass: '',
        chips: row2Chips.map(normalizeSecondaryStatusChip).filter(Boolean),
      },
      {
        rowClass: '_JX_status_row_lower',
        chips: row3Chips.map(normalizeSecondaryStatusChip).filter(Boolean),
      }
    ].filter(row => row.chips.length > 0);
    const maxMetaFieldsPerRow = Math.max(row2Chips.length, row3Chips.length);

    const issueUrl = instanceUrl + 'browse/' + key;
    const showDescription = displayFields.description !== false;
    const showAttachments = layoutContentBlocks.includes('attachments');
    const showChildren = layoutContentBlocks.includes('children');
    const showComments = layoutContentBlocks.includes('comments');
    const showTimeTracking = layoutContentBlocks.includes('timeTracking');
    const visibleCommentsTotal = showComments ? commentsTotal : 0;
    const visibleAttachments = showAttachments ? previewAttachments : [];
    const normalizedChildrenSort = normalizeChildrenSortState(childrenSort);
    const normalizedPullRequestsSort = normalizePullRequestsSortState(pullRequestsSort);
    const childIssues = Array.isArray(children) ? children.filter(Boolean) : [];
    const childRows = childIssues
      .map(child => {
        const issueKey = String(child?.key || '').trim();
        const summary = String(child?.fields?.summary || issueKey || '');
        const url = issueKey ? `${instanceUrl}browse/${issueKey}` : '';
        return {
          id: child?.id || issueKey,
          issueKey,
          summary,
          issueUrl: url,
          issueLinkTitle: issueKey
            ? buildLinkHoverTitle('Open issue in Jira', `[${issueKey}] ${summary}`, url)
            : '',
          issueTypeIconUrl: child?.fields?.issuetype?.iconUrl || '',
          issueTypeName: child?.fields?.issuetype?.name || '--',
          issueTypeTitle: `Issue type: ${child?.fields?.issuetype?.name || '--'}`,
          statusText: child?.fields?.status?.name || '--',
          assigneeView: buildRelatedUserCellView(child?.fields?.assignee, 'Assignee', 'Unassigned')
        };
      })
      .filter(row => row.issueKey)
      .sort((left, right) => compareChildrenRows(left, right, normalizedChildrenSort.column, normalizedChildrenSort.direction));
    const childSectionError = String(childrenError || '').trim();
    const childrenSortHeaders = [
      buildRelatedTableSortHeader(normalizedChildrenSort, 'type', 'Type'),
      buildRelatedTableSortHeader(normalizedChildrenSort, 'key', 'Key / Summary', 'key'),
      buildRelatedTableSortHeader(normalizedChildrenSort, 'status', 'Status'),
      buildRelatedTableSortHeader(normalizedChildrenSort, 'assignee', 'Assignee')
    ];
    const prSortHeaders = [
      buildRelatedTableSortHeader(normalizedPullRequestsSort, 'title', 'Title'),
      buildRelatedTableSortHeader(normalizedPullRequestsSort, 'author', 'Author'),
      buildRelatedTableSortHeader(normalizedPullRequestsSort, 'branch', 'Branch'),
      buildRelatedTableSortHeader(normalizedPullRequestsSort, 'status', 'Status')
    ];
    const quickActionData = buildQuickActionViewData(actionsOpen, actionLoadingKey, quickActions);
    const reporterView = displayFields.reporter && issueData.fields.reporter
      ? buildUserAvatarView(issueData.fields.reporter, 'Reporter', '--')
      : null;
    const assigneeView = displayFields.assignee
      ? buildAssigneeAvatarView(state, issueData, assigneeEditable)
      : null;
    const titleView = buildTitleView(state, issueData, summaryEditable);
    const titleStatusText = titleView.isEditing && titleView.fieldKey === 'summary' ? titleView.loadingText : '';
    const watches = issueData.fields.watches || {};
    const watcherCount = Number.isFinite(Number(watches.watchCount)) ? Number(watches.watchCount) : 0;
    const watchersPanel = buildWatchersPanelView(state);
    const timeTrackingSection = showTimeTracking ? buildTimeTrackingSectionPresentation(issueData, state.timeTrackingEditState, timeTrackingCapability) : null;
    const rawDescription = typeof issueData?.fields?.description === 'string' ? issueData.fields.description : '';
    const descriptionState = state.descriptionEditState || null;
    const descriptionHasChanges = String(descriptionState?.inputValue || '') !== String(descriptionState?.originalInputValue || '');
    const descriptionUploads = Array.isArray(descriptionState?.uploads) ? descriptionState.uploads : [];
    const descriptionHasUploadsInFlight = descriptionUploads.some(item => item?.status === 'uploading');
    const descriptionSection = showDescription ? {
      bodyHtml: normalizedDescription || '',
      canEdit: descriptionEditable,
      cancelDisabledAttr: descriptionState?.saving ? 'disabled' : '',
      draftValue: String(descriptionState?.inputValue ?? rawDescription ?? ''),
      editButtonLabel: normalizedDescription ? '' : 'Edit',
      editButtonTitle: normalizedDescription ? 'Edit description' : 'Add description',
      emptyText: 'No description yet.',
      hasContent: !!normalizedDescription,
      hasStatusMessage: !!descriptionState?.statusMessage,
      hasUploads: descriptionUploads.length > 0,
      inputPlaceholder: 'Add a description',
      isEditing: !!descriptionState?.open,
      saveDisabledAttr: (!descriptionHasChanges || !!descriptionState?.saving || descriptionHasUploadsInFlight) ? 'disabled' : '',
      saveText: descriptionState?.saving ? 'Saving...' : (descriptionHasUploadsInFlight ? 'Uploading...' : 'Save'),
      showEditButton: descriptionEditable && !descriptionState?.open,
      showEmptyEditButton: descriptionEditable && !descriptionState?.open && !normalizedDescription,
      statusClass: descriptionState?.statusKind === 'error'
        ? '_JX_description_status_error'
        : (descriptionState?.statusKind === 'success' ? '_JX_description_status_success' : '_JX_description_status_info'),
      statusMessage: descriptionState?.statusMessage || '',
      toolbarButtons: [
        {action: 'bold', label: 'B', title: 'Bold'},
        {action: 'italic', label: 'I', title: 'Italic'},
        {action: 'underline', label: 'U', title: 'Underline'},
        {action: 'bulletList', label: '• List', title: 'Bullet list'},
        {action: 'numberList', label: '1. List', title: 'Numbered list'},
        {action: 'codeBlock', label: '{ }', title: 'Code block'},
      ],
      uploads: descriptionUploads.map(item => ({
        fileName: item.fileName,
        previewUrl: item.previewUrl || item.displayUrl || '',
        stateClass: item.status === 'error' ? ' is-error' : '',
        statusText: item.status === 'uploading'
          ? 'Uploading to Jira...'
          : (item.status === 'uploaded' ? 'Attached to issue' : (item.errorMessage || 'Upload failed')),
      })),
    } : null;
    const displayData = {
      urlTitle: titleView.urlTitle,
      ticketKey: titleView.ticketKey,
      ticketTitle: titleView.ticketTitle,
      url: titleView.url,
      urlHoverTitle: titleView.urlHoverTitle,
      copyUrl: issueUrl,
      copyTicket: key,
      copyTitle: issueData.fields.summary,
      childrenRows: [],
      childrenSortHeaders,
      childrenErrorText: childSectionError,
      hasChildrenError: !!childSectionError,
      hasChildrenRows: childRows.length > 0,
      showChildrenSection: showChildren && (childRows.length > 0 || !!childSectionError),
      prs: [],
      prSortHeaders,
      description: showDescription ? normalizedDescription : '',
      descriptionSection,
      hasBodyContent: true,
      emptyBodyText: (!normalizedDescription && visibleAttachments.length === 0 && visibleCommentsTotal === 0)
        ? 'No description, attachments or comments.'
        : '',
      attachments,
      previewAttachments: visibleAttachments,
      commentSortToggleAriaPressed: normalizedCommentSortOrder === 'newest' ? 'true' : 'false',
      commentSortToggleLabel: normalizedCommentSortOrder === 'newest' ? 'Newest first' : 'Oldest first',
      commentSortToggleIsNewest: normalizedCommentSortOrder === 'newest',
      commentSortToggleIsOldest: normalizedCommentSortOrder !== 'newest',
      commentSortToggleTitle: normalizedCommentSortOrder === 'newest'
        ? 'Switch to oldest comments first'
        : 'Switch to newest comments first',
      commentsForDisplay: showComments ? commentsForDisplay : [],
      showCommentsSection: showComments || commentsForDisplay.length > 0,
      showCommentComposer: showComments,
      issuetype: issueData.fields.issuetype,
      status: issueData.fields.status,
      priority: issueData.fields.priority,
      issueTypeText: displayFields.issueType ? (issueTypeName || 'No type') : '',
      statusText: displayFields.status ? (statusName || 'No status') : '',
      sprintText: displayFields.sprint ? (formatSprintText(sprints) || 'No sprint') : '',
      fixVersionText: displayFields.fixVersions ? (formatFixVersionText(fixVersions) || 'No fix version') : '',
      useWideAnnotation: maxMetaFieldsPerRow > 3,
      row1Chips,
      row2Chips,
      row3Chips,
      secondaryStatusRows,
      timeTrackingSection,
      hasComments: visibleCommentsTotal > 0,
      commentsTotal: visibleCommentsTotal,
      attachmentChips: displayFields.attachments ? buildAttachmentChips(attachments) : [],
      reporter: displayFields.reporter ? issueData.fields.reporter : null,
      reporterView,
      assignee: displayFields.assignee ? issueData.fields.assignee : null,
      assigneeView,
      titleView,
      watchersTrigger: {
        count: watcherCount,
        title: watcherCount === 1 ? '1 watcher' : `${watcherCount} watchers`,
        watchingTitle: watches.isWatching ? 'You are watching this issue.' : 'You are not watching this issue.',
        isWatching: !!watches.isWatching,
        isOpen: watchersPanel.isOpen,
        isLoading: watchersPanel.isLoading,
        hasCount: true,
      },
      watchersPanel,
      commentUrl: issueUrl,
      hasFieldSummary: row1Chips.length > 0 || row2Chips.length > 0 || row3Chips.length > 0,
      activityIndicators: [],
      loaderGifUrl,
      actionNoticeText: titleStatusText || actionError || lastActionSuccess,
      actionNoticeClass: titleStatusText
        ? '_JX_action_notice_info'
        : (actionError ? '_JX_action_notice_error' : '_JX_action_notice_success'),
      hasActionNotice: !!(titleStatusText || actionError || lastActionSuccess),
      ...quickActionData
    };
    if (issueData.fields.comment?.comments?.[0]?.id) {
      displayData.commentUrl = `${displayData.url}#comment-${issueData.fields.comment.comments[0].id}`;
    }
    if (displayData.showChildrenSection) {
      displayData.childrenRows = childRows;
    }
    if (showPullRequests && Array.isArray(pullRequests) && pullRequests.length) {
      const filteredPullRequests = pullRequests.filter(pr => pr && pr.url !== location.href);
      displayData.prs = filteredPullRequests
        .map(pr => ({
          id: pr.id,
          url: pr.url,
          linkUrl: pr.url,
          linkTitle: buildLinkHoverTitle('Open pull request', formatPullRequestTitle(pr), pr.url),
          title: formatPullRequestTitle(pr),
          sortTitleText: pr?.name || pr?.title || formatPullRequestTitle(pr),
          status: pr.status,
          statusText: pr.status || '--',
          authorView: buildRelatedUserCellView(pr?.author, 'Author', formatPullRequestAuthor(pr)),
          branchText: formatPullRequestBranch(pr)
        }))
        .sort((left, right) => comparePullRequestRows(left, right, normalizedPullRequestsSort.column, normalizedPullRequestsSort.direction));
    }
    displayData.activityIndicators = buildActivityIndicators();
    displayData.hasRow1Meta = !!displayData.watchersTrigger || displayData.activityIndicators.length > 0;
    displayData.hasPrimaryStatusRow = row1Chips.length > 0 || displayData.hasRow1Meta;
    displayData.historyOpen = !!historyOpen;
    displayData.changelogLoading = !!changelogLoading;
    displayData.changelogEntries = historyOpen ? await options?.formatChangelogForDisplay(changelogData, issueData) : [];
    displayData.hasChangelogEntries = historyOpen && displayData.changelogEntries.length > 0;
    displayData.showChangelogEmpty = historyOpen && !changelogLoading && displayData.changelogEntries.length === 0;
    return displayData;
  }

  return {
    buildPopupDisplayData,
  };
}
