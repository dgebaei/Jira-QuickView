export function createContentPopupStateHelpers(options) {
  const assigneeLocalOptionsCache = options?.assigneeLocalOptionsCache;
  const assigneeSearchCache = options?.assigneeSearchCache;
  const clearActionNoticeTimer = options?.clearActionNoticeTimer;
  const createTimeTrackingEditState = options?.createTimeTrackingEditState;
  const editMetaCache = options?.editMetaCache;
  const emptyWatchersState = options?.emptyWatchersState;
  const getIssueWatchers = options?.getIssueWatchers;
  const getPopupState = options?.getPopupState;
  const getPullRequestDataCached = options?.getPullRequestDataCached;
  const issueData = options?.issueData;
  const issueSearchCache = options?.issueSearchCache;
  const labelLocalOptionsCache = options?.labelLocalOptionsCache;
  const normalizeHistoryAttachmentName = options?.normalizeHistoryAttachmentName;
  const normalizeIssueAttachmentImage = options?.normalizeIssueAttachmentImage;
  const normalizeIssueImages = options?.normalizeIssueImages;
  const normalizePullRequests = options?.normalizePullRequests;
  const normalizePullRequestImages = options?.normalizePullRequestImages;
  const pullRequestCache = options?.pullRequestCache;
  const renderIssuePopup = options?.renderIssuePopup;
  const resolveQuickActions = options?.resolveQuickActions;
  const scheduleActionNoticeClear = options?.scheduleActionNoticeClear;
  const setPopupState = options?.setPopupState;
  const sharedAvatarUrls = options?.sharedAvatarUrls;
  const showPullRequests = options?.showPullRequests;
  const snackBar = options?.snackBar;
  const tempoAccountSearchCache = options?.tempoAccountSearchCache;
  const transitionOptionsCache = options?.transitionOptionsCache;
  const userPickerLocalOptionsCache = options?.userPickerLocalOptionsCache;
  const userPickerSearchCache = options?.userPickerSearchCache;
  const watcherListCache = options?.watcherListCache;
  const watcherSearchCache = options?.watcherSearchCache;

  function invalidatePopupCaches(popupState = getPopupState()) {
    if (!popupState?.key) {
      return;
    }
    watcherListCache.delete(popupState.key);
    editMetaCache.delete(popupState.key);
    transitionOptionsCache.delete(popupState.key);
    assigneeLocalOptionsCache.delete(popupState.key);
    labelLocalOptionsCache.delete(popupState.key);
    tempoAccountSearchCache.clear();
    userPickerSearchCache.clear();
    userPickerLocalOptionsCache.clear();
    sharedAvatarUrls.clear();
    watcherSearchCache.clear();
    issueSearchCache.clear();
    [...assigneeSearchCache.keys()].forEach(cacheKey => {
      if (String(cacheKey).startsWith(`${popupState.key}__`)) {
        assigneeSearchCache.delete(cacheKey);
      }
    });
    if (popupState.issueData?.id) {
      const issueId = String(popupState.issueData.id);
      [...pullRequestCache.keys()].forEach(cacheKey => {
        if (String(cacheKey).includes(issueId)) {
          pullRequestCache.delete(cacheKey);
        }
      });
    }
  }

  function buildPopupInteractionReset(overrides = {}) {
    return {
      actionLoadingKey: '',
      actionError: '',
      lastActionSuccess: '',
      actionsOpen: false,
      historyOpen: false,
      changelogData: null,
      changelogLoading: false,
      editState: null,
      commentSession: null,
      ...overrides,
    };
  }

  function buildNextWatchersState(currentState = emptyWatchersState(), changes = {}) {
    return {
      ...emptyWatchersState(),
      ...currentState,
      ...changes,
    };
  }

  async function renderUpdatedPopupState(nextStateOrUpdater) {
    const currentState = getPopupState();
    const nextState = typeof nextStateOrUpdater === 'function'
      ? nextStateOrUpdater(currentState)
      : nextStateOrUpdater;
    setPopupState(nextState);
    await renderIssuePopup(nextState);
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

    invalidatePopupCaches(popupState);

    const [issueOutcome, refreshedWatcherData] = await Promise.all([
      issueData.refreshAfterMutation({
        issueKey: popupKey,
        mutation: refreshOptions.mutation || {kind: 'issueChanged'},
        requirements: {history: shouldKeepHistoryOpen},
      }),
      shouldRefreshWatchersPanel ? getIssueWatchers(popupKey).catch(() => null) : Promise.resolve(null),
    ]);
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
    await normalizeIssueImages(refreshedIssueData);

    let refreshedPullRequests = [];
    if (showPullRequests) {
      try {
        const pullRequestResponse = await getPullRequestDataCached(refreshedIssueData.id);
        refreshedPullRequests = normalizePullRequests(pullRequestResponse);
        if (typeof normalizePullRequestImages === 'function') {
          await normalizePullRequestImages(refreshedPullRequests).catch(() => {});
        }
      } catch (error) {
        refreshedPullRequests = [];
      }
    }

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
    buildPopupInteractionReset,
    handleDraftAttachmentUploaded,
    invalidatePopupCaches,
    refreshPopupIssueState,
    renderUpdatedPopupState,
  };
}
