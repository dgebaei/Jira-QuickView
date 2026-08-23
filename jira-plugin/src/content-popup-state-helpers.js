export function createContentPopupStateHelpers(options) {
  const clearActionNoticeTimer = options?.clearActionNoticeTimer;
  const buildPopupInteractionReset = options?.buildPopupInteractionReset;
  const createTimeTrackingEditState = options?.createTimeTrackingEditState;
  const emptyWatchersState = options?.emptyWatchersState;
  const getPopupState = options?.getPopupState;
  const issueData = options?.issueData;
  const normalizeHistoryAttachmentName = options?.normalizeHistoryAttachmentName;
  const normalizeIssueAttachmentImage = options?.normalizeIssueAttachmentImage;
  const renderIssuePopup = options?.renderIssuePopup;
  const resolveQuickActions = options?.resolveQuickActions;
  const scheduleActionNoticeClear = options?.scheduleActionNoticeClear;
  const setPopupState = options?.setPopupState;
  const showPullRequests = options?.showPullRequests;
  const snackBar = options?.snackBar;

  function buildNextWatchersState(currentState = emptyWatchersState(), changes = {}) {
    return {
      ...emptyWatchersState(),
      ...currentState,
      ...changes,
    };
  }

  async function renderUpdatedPopupState(nextStateOrUpdater, renderOptions = {}) {
    const currentState = getPopupState();
    const nextState = typeof nextStateOrUpdater === 'function'
      ? nextStateOrUpdater(currentState)
      : nextStateOrUpdater;
    if (typeof renderOptions.isCurrent === 'function' && !renderOptions.isCurrent()) {
      return currentState;
    }
    setPopupState(nextState);
    await renderIssuePopup(nextState, renderOptions);
    return nextState;
  }

  async function refreshPopupIssueState(successMessage = '', refreshOptions = {}) {
    const popupState = getPopupState();
    if (!popupState?.key) {
      return;
    }
    const {
      showSnackBar = false,
      nextTimeTrackingEditState,
      refreshWatchersPanel = false,
      nextWatchersStateChanges = {},
      scheduleWatchersFeedbackReset = false,
      preserveHistory = false,
      scheduleWatchersFeedbackClear = null,
    } = refreshOptions;
    const popupKey = popupState.key;
    const shouldRefreshWatchersPanel = !!(refreshWatchersPanel || popupState?.watchersState?.open);
    const shouldKeepHistoryOpen = !!(preserveHistory && popupState?.historyOpen);

    const issueOutcome = await issueData.refreshAfterMutation({
      issueKey: popupKey,
      priorSnapshot: popupState.issueSnapshot,
      mutation: refreshOptions.mutation || {kind: 'issueChanged'},
      requirements: {
        history: shouldKeepHistoryOpen,
        linkedIssues: !!popupState?.linkedIssuesState?.open,
        pullRequests: showPullRequests,
        watchers: shouldRefreshWatchersPanel,
      },
    });
    if (!issueOutcome.snapshot?.core) {
      const message = issueOutcome.failures?.core?.message || 'Could not refresh issue';
      const error = new Error(message);
      error.inner = message;
      throw error;
    }
    const refreshedIssueData = issueOutcome.snapshot.core;
    const historySection = issueOutcome.snapshot.sections?.history;
    const refreshedChangelog = shouldKeepHistoryOpen && ['ready', 'empty'].includes(historySection?.status)
      ? historySection.data
      : {histories: []};
    const pullRequestSection = issueOutcome.snapshot.sections?.pullRequests;
    const refreshedPullRequests = Array.isArray(pullRequestSection?.items) ? pullRequestSection.items : [];
    const watcherSection = issueOutcome.snapshot.sections?.watchers;
    const refreshedWatcherData = ['ready', 'empty', 'staleRetained'].includes(watcherSection?.status)
      ? watcherSection.data
      : null;

    let quickActions = [];
    try {
      quickActions = await resolveQuickActions(refreshedIssueData);
    } catch (error) {
      quickActions = [];
    }

    const currentPopupState = getPopupState();
    if (!currentPopupState || currentPopupState.key !== popupKey) {
      return;
    }

    clearActionNoticeTimer();

    await renderUpdatedPopupState(currentState => ({
      ...currentState,
      issueSnapshot: issueOutcome.snapshot,
      issueData: refreshedIssueData,
      pullRequests: refreshedPullRequests,
      quickActions,
      ...buildPopupInteractionReset({
        lastActionSuccess: showSnackBar ? '' : successMessage,
        historyOpen: shouldKeepHistoryOpen,
        changelogData: shouldKeepHistoryOpen ? (refreshedChangelog || {histories: []}) : null,
        changelogLoading: false,
      }),
      timeTrackingEditState: nextTimeTrackingEditState || createTimeTrackingEditState(refreshedIssueData),
      watchersState: refreshedWatcherData
        ? buildNextWatchersState(currentState.watchersState, {
            loading: false,
            errorMessage: '',
            watchers: refreshedWatcherData.watchers,
            pendingAddIds: [],
            pendingRemoveIds: [],
            searchResults: (currentState.watchersState?.searchResults || []).filter(result => {
              return !refreshedWatcherData.watchers.some(watcher => watcher.id === result.id);
            }),
            focusSearch: !!currentState.watchersState?.open,
            ...nextWatchersStateChanges,
          })
        : currentState.watchersState,
    }));

    if (scheduleWatchersFeedbackReset && typeof scheduleWatchersFeedbackClear === 'function') {
      scheduleWatchersFeedbackClear();
    }
    if (!showSnackBar && successMessage) {
      scheduleActionNoticeClear(successMessage);
    }
    if (showSnackBar && successMessage) {
      snackBar(successMessage);
    }
  }

  async function handleDraftAttachmentUploaded(uploadedAttachment) {
    const popupState = getPopupState();
    const popupKey = popupState?.key;
    const currentIssueData = popupState?.issueData;
    if (!popupKey || !currentIssueData?.fields || !uploadedAttachment) {
      return;
    }

    const normalizedAttachment = await normalizeIssueAttachmentImage({...uploadedAttachment});
    const issueOutcome = await issueData.refreshAfterMutation({
      issueKey: popupKey,
      priorSnapshot: popupState.issueSnapshot,
      mutation: {kind: 'attachmentChanged'},
      requirements: {history: !!popupState?.historyOpen},
    });
    const historySection = issueOutcome.snapshot?.sections?.history;
    const refreshedChangelog = popupState?.historyOpen && ['ready', 'empty'].includes(historySection?.status)
      ? historySection.data
      : popupState?.changelogData;

    const currentPopupState = getPopupState();
    if (!currentPopupState || currentPopupState.key !== popupKey) {
      return;
    }

    await renderUpdatedPopupState(currentState => {
      const existingAttachments = Array.isArray(currentState?.issueData?.fields?.attachment)
        ? currentState.issueData.fields.attachment
        : [];
      const normalizedFileName = normalizeHistoryAttachmentName(normalizedAttachment.filename);
      const nextAttachments = [
        ...existingAttachments.filter(attachment => {
          const sameId = normalizedAttachment.id && attachment?.id && String(attachment.id) === String(normalizedAttachment.id);
          const sameName = normalizedFileName &&
            normalizeHistoryAttachmentName(attachment?.filename) === normalizedFileName;
          return !(sameId || sameName);
        }),
        normalizedAttachment,
      ];
      return {
        ...currentState,
        issueSnapshot: issueOutcome.snapshot || currentState.issueSnapshot,
        issueData: {
          ...currentState.issueData,
          fields: {
            ...currentState.issueData.fields,
            attachment: nextAttachments,
          }
        },
        changelogData: refreshedChangelog || currentState.changelogData,
        changelogLoading: false,
      };
    });
  }

  return {
    buildNextWatchersState,
    handleDraftAttachmentUploaded,
    refreshPopupIssueState,
    renderUpdatedPopupState,
  };
}
