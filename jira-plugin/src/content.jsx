/*global chrome */
import size from 'lodash/size';
import debounce from 'lodash/debounce';
import regexEscape from 'escape-string-regexp';
import {waitForDocument} from 'src/utils';
import {sendMessage, storageGet, storageSet, storageLocalGet, storageLocalSet} from 'src/chrome';
import {snackBar} from 'src/snack';
import {createContentAttachmentHelpers} from 'src/content-attachment-helpers';
import {createContentFieldCapabilityHelpers} from 'src/content-field-capability-helpers';
import {createContentHistoryHelpers} from 'src/content-history-helpers';
import {createContentIssueLinkageHelpers} from 'src/content-issue-linkage-helpers';
import {
  buildIssueLinkCreatePayload,
  buildRelationshipOptions,
  createContentLinkedIssuesHelpers,
  createEmptyLinkedIssuesState,
  getLinkedIssueKeys,
  parseLinkedIssueKeys,
} from 'src/content-linked-issues-helpers';
import {createPopupProjectView} from 'src/popup-session/project-view';
import {createContentPeopleHelpers} from 'src/content-people-helpers';
import {createContentPopupStateHelpers} from 'src/content-popup-state-helpers';
import {createContentShellHelpers} from 'src/content-shell-helpers';
import {MENTION_CONTEXT_WINDOW} from 'src/comment-mention-constants';
import {createContentCommentHelpers} from 'src/content-comment-helpers';
import {positionMentionMenuAtCaret} from 'src/mention-menu-positioning';
import {buildEditOption, createPopupEditing} from 'src/popup-editing';
import {createPopupQuickActions} from 'src/popup-quick-actions';
import {createPopupCommentComposer} from 'src/popup-comment-composer';
import config, {buildTooltipLayoutFromDisplayFields} from 'options/config.js';
import {DEFAULT_THEME_MODE, syncDocumentTheme} from 'src/theme';
import {copyIssueReference} from 'src/issue-reference-copy';
import {installJiraInlineCopyButtons} from 'src/jira-inline-copy';
import {createBrowserMessageJiraAdapter} from 'src/browser-message-jira-adapter';
import {createBrowserAttachmentMediaAdapter} from 'src/browser-attachment-media-adapter';
import {createBrowserPopupSurface} from 'src/browser-popup-surface';
import {createCommentLifecycle} from 'src/comment-lifecycle';
import {createJiraFieldEditing} from 'src/jira-field-editing';
import {createPopupSession} from 'src/popup-session';
import {createBrowserPopupEvents} from 'src/popup-session/browser-popup-events';
import {createBrowserPopupRenderer} from 'src/popup-session/browser-popup-renderer';
import {createQuickViewIssueData} from 'src/quickview-issue-data';
import {snapshotToLegacyPopupState} from 'src/quickview-snapshot-legacy';
const {
  buildDescriptionEditorState,
  buildMediaSingleNodeFromAttachment,
  buildDescriptionSaveFieldValue,
  isRichTextDescriptionDocument,
} = require('src/description-rich-text');

waitForDocument(() => require('src/content.scss'));
waitForDocument(() => require('src/jira-inline-copy.scss'));

// ── Config ──────────────────────────────────────────────────────

const getInstanceUrl = async () => (await storageGet({
  instanceUrl: config.instanceUrl
})).instanceUrl;

const getConfig = async () => {
  const [resolvedConfig, storedTooltipLayout] = await Promise.all([
    storageGet(config),
    storageGet('tooltipLayout')
  ]);
  return {
    resolvedConfig,
    hasStoredTooltipLayout: !!storedTooltipLayout?.tooltipLayout
  };
};

const DEFAULT_COMMENT_SORT_ORDER = 'oldest';
const COMMENT_SORT_ORDER_STORAGE_KEY = 'jqv.commentSortOrder';

// ── Jira Key Matching ───────────────────────────────────────────

function buildRegexMatcher(regex) {
  return function (text) {
    const input = text || '';
    const result = [];
    let matches;
    while ((matches = regex.exec(input)) !== null) {
      result.push(matches[0]);
    }
    regex.lastIndex = 0;
    return result;
  };
}

const FALLBACK_JIRA_KEY_PATTERN = '\\b[A-Z][A-Z0-9]{1,14}[- ]\\d+\\b';

/**
 * Returns a function that will return an array of jira tickets for any given string
 * @param projectKeys project keys to match
 * @returns {Function}
 */
function buildJiraKeyMatcher(projectKeys) {
  const escapedKeys = (projectKeys || [])
    .filter(Boolean)
    .map(key => regexEscape(key));
  if (!escapedKeys.length) {
    return function () {
      return [];
    };
  }
  const projectMatches = escapedKeys.join('|');
  return buildRegexMatcher(new RegExp('(?:' + projectMatches + ')[- ]\\d+', 'ig'));
}

function buildFallbackJiraKeyMatcher() {
  return buildRegexMatcher(new RegExp(FALLBACK_JIRA_KEY_PATTERN, 'g'));
}

function normalizeJiraProjectsResponse(response) {
  if (Array.isArray(response)) {
    return response;
  }
  if (Array.isArray(response?.values)) {
    return response.values;
  }
  return [];
}

// ── Tips & Notifications ────────────────────────────────────────

if (!window.__JX_runtimeMessageListenerInstalled) {
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.action === 'message') {
      snackBar(msg.message);
    }
  });
  window.__JX_runtimeMessageListenerInstalled = true;
}

let ui_tips_shown_local = [];
const CONNECTION_ERROR_PATTERN = /(failed to fetch|networkerror|network request failed|load failed|err_|timed?\s*out)/i;
async function showTip(tipName, tipMessage) {
  if (ui_tips_shown_local.indexOf(tipName) !== -1) {
    return;
  }
  ui_tips_shown_local.push(tipName);
  const ui_tips_shown = (await storageGet({['ui_tips_shown']: []})).ui_tips_shown;
  if (ui_tips_shown.indexOf(tipName) === -1) {
    snackBar(tipMessage);
    ui_tips_shown.push(tipName);
    storageSet({'ui_tips_shown': ui_tips_shown});
  }
}

storageGet({'ui_tips_shown': []}).then(function ({ui_tips_shown}) {
  ui_tips_shown_local = ui_tips_shown;
});

// ── Jira transport ─────────────────────────────────────────────

const jira = createBrowserMessageJiraAdapter({sendMessage});
async function get(url) {
  return jira.read({path: url});
}

async function getImageDataUrl(url, mimeType = '') {
  return jira.image({url, mimeType});
}

  async function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('Could not read image blob'));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(blob);
    });
  }

async function requestJson(method, url, body, headers) {
  return jira.write({method, path: url, body, headers});
}
async function uploadAttachment(url, file) {
  return jira.upload({path: url, file});
}


// ── Connection Error Detection ──────────────────────────────────

function isJiraConnectionFailure(error) {
  const message = String(error?.message || error?.inner || error || '');
  return CONNECTION_ERROR_PATTERN.test(message);
}

function notifyJiraConnectionFailure(instanceUrl, error) {
  if (!isJiraConnectionFailure(error)) {
    return false;
  }

  let host = '';
  try {
    host = new URL(instanceUrl).hostname;
  } catch (ex) {
    host = '';
  }

  snackBar(`Could not reach Jira${host ? ` at ${host}` : ''}. Check your VPN or network connection.`, 1500);
  return true;
}

function formatPageDiagnosticError(error) {
  return error?.message || error?.inner || String(error || 'Unknown page diagnostic error');
}

async function checkLiveJiraReachability(instanceUrl) {
  const myselfUrl = `${instanceUrl}rest/api/2/myself`;
  try {
    const myself = await get(myselfUrl);
    return {
      displayName: myself?.displayName || myself?.name || myself?.username || 'You',
      requestUrl: myselfUrl
    };
  } catch (primaryError) {
    const sessionUrl = `${instanceUrl}rest/auth/1/session`;
    const session = await get(sessionUrl);
    const user = session?.user || {};
    return {
      displayName: user.displayName || user.name || user.username || 'Jira session available',
      requestUrl: sessionUrl
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// Main Content Script
// ═══════════════════════════════════════════════════════════════

async function mainAsyncLocal() {
  const $ = require('jquery');
  const draggable = require('jquery-ui/ui/widgets/draggable');

  // ── Initialization & State ──────────────────────────────────

  const {
    resolvedConfig: config,
    hasStoredTooltipLayout
  } = await getConfig();
  const INSTANCE_URL = config.instanceUrl;
  const storedCommentSortState = await storageLocalGet({
    [COMMENT_SORT_ORDER_STORAGE_KEY]: DEFAULT_COMMENT_SORT_ORDER
  }).catch(() => ({
    [COMMENT_SORT_ORDER_STORAGE_KEY]: DEFAULT_COMMENT_SORT_ORDER
  }));
  let commentSortOrderPreference = storedCommentSortState[COMMENT_SORT_ORDER_STORAGE_KEY] === 'newest'
    ? 'newest'
    : DEFAULT_COMMENT_SORT_ORDER;
  if (window.top === window && !window.__JX_pageDiagnosticsLogged) {
    window.__JX_pageDiagnosticsLogged = true;
    const extensionVersion = chrome.runtime?.getManifest?.()?.version || '';
    const extensionLabel = extensionVersion ? `extension loaded v${extensionVersion}` : 'extension loaded';
    console.info(`[Jira QuickView] ${extensionLabel}`, {
      version: extensionVersion,
      href: window.location.href
    });
    if (INSTANCE_URL) {
      checkLiveJiraReachability(INSTANCE_URL)
        .then(result => {
          console.info('[Jira QuickView] Jira reachable', {
            instanceUrl: INSTANCE_URL,
            displayName: result.displayName,
            requestUrl: result.requestUrl
          });
        })
        .catch(error => {
          console.error('[Jira QuickView] Jira unreachable', {
            instanceUrl: INSTANCE_URL,
            error: formatPageDiagnosticError(error),
            requestUrl: `${INSTANCE_URL}rest/api/2/myself`
          });
        });
    }
  }
  const displayFields = {
    issueType: true,
    status: true,
    priority: true,
    sprint: true,
    fixVersions: true,
    affects: true,
    environment: true,
    labels: true,
    epicParent: true,
    attachments: false,
    comments: true,
    description: true,
    children: true,
    reporter: true,
    assignee: true,
    pullRequests: true,
    timeTracking: true,
    ...(config.displayFields || {})
  };
  const tooltipLayout = hasStoredTooltipLayout
    ? config.tooltipLayout
    : buildTooltipLayoutFromDisplayFields(displayFields);
  const defaultContentBlocks = ['description', 'timeTracking', 'children', 'pullRequests', 'comments'];
  const layoutContentBlocks = [...(tooltipLayout.contentBlocks || defaultContentBlocks)];
  if (displayFields.description !== false && !layoutContentBlocks.includes('description')) {
    layoutContentBlocks.unshift('description');
  }
  const showChildren = layoutContentBlocks.includes('children');
  const showPullRequests = layoutContentBlocks.includes('pullRequests');
  const hoverDepth = config.hoverDepth || 'exact';
  const hoverModifierKey = config.hoverModifierKey || 'any';
  const customFields = normalizeCustomFields(config.customFields, tooltipLayout);
  installJiraInlineCopyButtons({
    document,
    instanceUrl: INSTANCE_URL,
    enabled: config.inlineCopyButtons !== false,
    copy: reference => copyIssueReferenceWithFeedback(reference)
      .catch(() => snackBar('There was an error!')),
  });
  let stopSyncDocumentTheme = syncDocumentTheme(document, config.themeMode || DEFAULT_THEME_MODE);
  let jiraProjects = [];
  let getJiraKeys = buildFallbackJiraKeyMatcher();

  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'sync' || !changes.themeMode) {
      return;
    }

    stopSyncDocumentTheme();
    stopSyncDocumentTheme = syncDocumentTheme(document, changes.themeMode.newValue || DEFAULT_THEME_MODE);
  });

  try {
    jiraProjects = normalizeJiraProjectsResponse(await get(await getInstanceUrl() + 'rest/api/2/project'));
  } catch (ex) {
    // Keep hover support alive offline; only notify on explicit hover fetch failures.
  }

  if (size(jiraProjects)) {
    getJiraKeys = buildJiraKeyMatcher(jiraProjects.map(function (project) {
      return project.key;
    }));
  }

  const annotationTemplate = await fetch(chrome.runtime.getURL('resources/annotation.html')).then(response => response.text());
  const loaderGifUrl = chrome.runtime.getURL('resources/ajax-loader.gif');
  const emptyDescriptionEditState = () => ({
    errorMessage: '',
    hadFocus: false,
    inputValue: '',
    mediaNodesByMarkup: {},
    open: false,
    originalInputValue: '',
    prefersRichText: false,
    saving: false,
    selectionEnd: 0,
    selectionStart: 0,
    statusKind: '',
    statusMessage: '',
    uploadSequence: 0,
    uploads: [],
  });
  const emptyWatchersState = () => ({
    open: false,
    loading: false,
    errorMessage: '',
    searchValue: '',
    searchLoading: false,
    searchRequestId: 0,
    watchers: [],
    searchResults: [],
    pendingAddIds: [],
    pendingRemoveIds: [],
    addFeedback: null,
    removeFeedback: null,
    focusSearch: false,
  });
  const emptyLinkedIssuesState = () => createEmptyLinkedIssuesState();
  let contentShellHelpers = null;
  const attachmentPresentation = createContentAttachmentHelpers({
    buildLinkHoverTitle,
  });
  const {
    buildHistoryAttachmentLookup,
    buildHistoryAttachmentView,
    buildPreviewAttachments,
    collectReferencedHistoryAttachmentNames,
    dedupeHistoryAttachments,
    normalizeHistoryAttachmentName,
  } = attachmentPresentation;
  const {
    buildAttachmentImagesByName,
    buildHistoryPreviewText,
    getMentionDisplayText,
    normalizeCommentImageReference,
    replaceMentionMarkupWithDisplayText,
    textToLinkedHtml,
  } = createContentCommentHelpers({
    mentionContextWindow: MENTION_CONTEXT_WINDOW,
    resolveMentionDisplayName: identity => resolveKnownJiraUserDisplayName(identity),
    escapeHtml,
    normalizeHistoryAttachmentName,
  });
  const quickViewIssueData = createQuickViewIssueData({
    customFields,
    instanceUrl: INSTANCE_URL,
    jira,
  });
  const jiraFieldEditing = createJiraFieldEditing({
    instanceUrl: INSTANCE_URL,
    issueData: quickViewIssueData,
    jira,
  });
  const commentLifecycle = createCommentLifecycle({
    attachmentMedia: createBrowserAttachmentMediaAdapter(),
    formatting: {
      normalizeHtml(html, options = {}) {
        return normalizeRichHtml(html, {
          attachmentLookup: buildHistoryAttachmentLookup(options.attachments || []),
          imageMaxHeight: options.imageMaxHeight,
        });
      },
    },
    instanceUrl: INSTANCE_URL,
    issueData: quickViewIssueData,
    jira,
  });

  function issueDataError(failure, fallbackMessage) {
    const message = failure?.message || fallbackMessage;
    const error = new Error(message);
    error.inner = message;
    return error;
  }

  async function getIssueSummary(issueKey) {
    if (!issueKey) {
      return null;
    }
    const outcome = await quickViewIssueData.openIssue({
      issueKey,
      requirements: {core: 'summary'},
    });
    if (!outcome.snapshot?.core) {
      throw issueDataError(outcome.failures?.core, 'Could not load issue summary');
    }
    return outcome.snapshot.core;
  }

  async function getIssueChangelog(issueKey) {
    const outcome = await quickViewIssueData.openIssue({
      issueKey,
      requirements: {history: true},
    });
    const history = outcome.snapshot?.sections?.history;
    if (!history || history.status === 'failed') {
      throw issueDataError(history?.failure || outcome.failures?.core, 'Could not load issue history');
    }
    return history.data || {histories: []};
  }
  const historyPresentation = createContentHistoryHelpers({
    areSameJiraUser,
    buildAttachmentImagesByName,
    buildHistoryAttachmentLookup,
    buildHistoryAttachmentView,
    buildHistoryPreviewText,
    buildLinkHoverTitle,
    collectReferencedHistoryAttachmentNames,
    dedupeHistoryAttachments,
    escapeHtml,
    fallbackJiraKeyPattern: FALLBACK_JIRA_KEY_PATTERN,
    instanceUrl: INSTANCE_URL,
    normalizeHistoryAttachmentName,
    normalizeIssueKey,
    normalizeRichHtml,
    textToLinkedHtml,
  });
  const {
    getEditableFieldCapability,
    getTransitionOptions,
    pickSprintFieldId,
  } = createContentFieldCapabilityHelpers({
    buildEditOption,
    issueData: quickViewIssueData,
  });
  const {resolveIssueLinkage} = createContentIssueLinkageHelpers({
    getIssueSummary,
    instanceUrl: INSTANCE_URL,
    issueData: quickViewIssueData,
  });
  const {
    getIssueLinkTypes,
    getLinkedIssueDetails,
    searchIssueLinkCandidates,
  } = createContentLinkedIssuesHelpers({
    issueData: quickViewIssueData,
  });
  let editSearchRequestCounter = 0;
  let watchersFeedbackTimeoutId = null;
  let linkedIssuesSearchTimeoutId = null;
  let actionNoticeTimeoutId = null;
  let descriptionStatusTimeoutId = null;
  let popupState = null;
  function buildPopupInteractionReset(overrides = {}) {
    return {
      actionLoadingKey: '',
      actionError: '',
      lastActionSuccess: '',
      changelogData: null,
      changelogLoading: false,
      editState: null,
      ...overrides,
    };
  }
  function applyPopupPresentation(currentState, presentation = {}) {
    const activePanel = presentation.activePanel || '';
    const watchersState = {
      ...emptyWatchersState(),
      ...currentState.watchersState,
      open: activePanel === 'watchers',
      focusSearch: activePanel === 'watchers' && !!currentState.watchersState?.focusSearch,
    };
    const linkedIssuesState = {
      ...emptyLinkedIssuesState(),
      ...currentState.linkedIssuesState,
      open: activePanel === 'linkedIssues',
      focusSearch: activePanel === 'linkedIssues' && !!currentState.linkedIssuesState?.focusSearch,
    };
    return {
      ...currentState,
      ...presentation,
      historyOpen: activePanel === 'history',
      watchersState,
      linkedIssuesState,
    };
  }
  const popupQuickActions = createPopupQuickActions({
    INSTANCE_URL,
    formatSprintActionLabel,
    getProjectSprintOptions,
    loadFieldContext: request => quickViewIssueData.loadFieldContext(request),
    loadViewer: async issueKey => {
      const activeIssueKey = issueKey || popupState?.issueData?.key || '';
      if (!activeIssueKey) {
        throw new Error('Issue key is required to load the Jira viewer');
      }
      const outcome = await quickViewIssueData.openIssue({
        issueKey: activeIssueKey,
        requirements: {viewer: true},
      });
      if (!outcome.snapshot?.viewer?.user) {
        throw new Error(outcome.snapshot?.viewer?.failure?.message || 'Could not load the Jira viewer');
      }
      return outcome.snapshot.viewer.user;
    },
    pickSprintFieldId,
    readSprintsFromIssue,
    requestJson,
  });
  const {
    buildQuickActionError,
    executeQuickAction,
    getCurrentUserInfo,
    resolveQuickActions,
  } = popupQuickActions;

  const popupSurface = createBrowserPopupSurface({
    async commitCurrent(frame, context) {
      if (!context.isCurrent() || !popupState || popupState.key !== frame.issueKey) return;
      popupState = applyPopupPresentation(popupState, frame.presentation);
      await popupRenderer.render(popupState, context);
    },
    async commitVisible(frame, context) {
      if (!context.isCurrent()) return;
      const legacySnapshot = snapshotToLegacyPopupState(frame.issueSnapshot);
      const issueData = legacySnapshot.issueData;
      let quickActions = [];
      try {
        quickActions = await resolveQuickActions(issueData);
      } catch (error) {
        quickActions = [];
      }
      if (!context.isCurrent()) return;
      const initialPopupState = applyPopupPresentation({
        key: frame.issueKey,
        issueSnapshot: legacySnapshot.issueSnapshot,
        issueData,
        children: legacySnapshot.children,
        childrenJql: legacySnapshot.childrenJql,
        childrenError: legacySnapshot.childrenError,
        pullRequests: legacySnapshot.pullRequests,
        pointerX: Number(frame.anchor?.x) || 0,
        pointerY: Number(frame.anchor?.y) || 0,
        quickActions,
        commentReactionState: legacySnapshot.commentReactionState,
        ...buildPopupInteractionReset(),
        descriptionEditState: createDescriptionEditState(issueData),
        watchersState: emptyWatchersState(),
        linkedIssuesState: emptyLinkedIssuesState(),
        timeTrackingEditState: createTimeTrackingEditState(issueData),
      }, frame.presentation);
      if (!context.isCurrent()) return;
      popupState = initialPopupState;
      await popupRenderer.render(initialPopupState, context);
    },
    async hidePopup() {
      await clearPopupSurface();
    },
    reportFailure(failure) {
      notifyJiraConnectionFailure(INSTANCE_URL, issueDataError(failure, 'Could not load issue'));
      lastHoveredKey = '';
    },
  });
  const popupSession = createPopupSession({
    issueData: quickViewIssueData,
    fieldEditing: jiraFieldEditing,
    comments: commentLifecycle,
    surface: popupSurface,
  });

  const {
    buildNextWatchersState,
    handleDraftAttachmentUploaded,
    refreshPopupIssueState,
    renderUpdatedPopupState,
  } = createContentPopupStateHelpers({
    buildPopupInteractionReset,
    clearActionNoticeTimer,
    createTimeTrackingEditState,
    emptyWatchersState,
    getPopupState: () => popupState,
    issueData: quickViewIssueData,
    normalizeHistoryAttachmentName,
    normalizeIssueAttachmentImage,
    renderIssuePopup,
    resolveQuickActions,
    scheduleActionNoticeClear,
    setPopupState: nextState => {
      popupState = nextState;
    },
    showPullRequests,
    snackBar,
  });

  const {
    buildNextMultiSelectState,
    buildNextTextEditState,
    filterEditOptions,
    getEditableFieldDefinition,
    mergeEditOptions,
    normalizeMultiSelectOptionIds,
    resolveSelectedEditOptions,
    submitFieldEdit,
    toggleMultiSelectOptionFromInput,
  } = createPopupEditing({
    buildEditFieldError,
    getPopupState: () => popupState,
    refreshPopupIssueState,
    renderIssuePopup,
    setPopupState: nextState => {
      popupState = nextState;
    },
  });

  const {
    discardCommentComposerDraft,
    getClipboardImageFiles,
    getCommentComposerElements,
    renderCommentMentionSuggestions,
    renderCommentUploads,
    restoreCommentComposerState,
    setCommentComposerError,
    syncCommentComposerState,
  } = createPopupCommentComposer({
    escapeHtml,
    getCommentLifecycleView: () => commentLifecycle.view(),
    getContainer: () => container,
    keepContainerVisible,
  });

  function currentPopupSessionId() {
    return popupSession.view().sessionId;
  }

  function renderCurrentPopup(reason = 'feature-changed') {
    return popupSession.dispatch({type: 'render', reason, issueSnapshot: popupState?.issueSnapshot});
  }

  function renderIssuePopup() {
    return renderCurrentPopup('popup-state-changed');
  }


  // ── URL & Image Handling ───────────────────────────────────

  function toAbsoluteJiraUrl(url) {
    if (!url) {
      return url;
    }
    try {
      return new URL(url, INSTANCE_URL).toString();
    } catch (ex) {
      return url;
    }
  }

  function isImageDataUrl(url) {
    return /^data:image\//i.test(String(url || '').trim());
  }

  function buildAttachmentProxyUrl(url) {
    const absoluteUrl = toAbsoluteJiraUrl(url);
    if (!absoluteUrl || isImageDataUrl(absoluteUrl)) {
      return absoluteUrl;
    }
    try {
      const parsedUrl = new URL(absoluteUrl);
      const instanceUrl = new URL(INSTANCE_URL);
      const isAttachmentApiUrl = parsedUrl.origin === instanceUrl.origin &&
        /^\/rest\/api\/(?:2|3)\/attachment\/(?:content|thumbnail)\//i.test(parsedUrl.pathname);
      if (!isAttachmentApiUrl) {
        return absoluteUrl;
      }
      parsedUrl.searchParams.set('redirect', 'false');
      return parsedUrl.toString();
    } catch (ex) {
      return absoluteUrl;
    }
  }

  async function getDisplayImageUrl(url, mimeType = '') {
    const absoluteUrl = toAbsoluteJiraUrl(url);
    if (!absoluteUrl) {
      return absoluteUrl;
    }
    if (isImageDataUrl(absoluteUrl)) {
      return absoluteUrl;
    }
    try {
      const imageUrl = new URL(absoluteUrl);
      const instanceUrl = new URL(INSTANCE_URL);
      if (imageUrl.origin !== instanceUrl.origin) {
        return absoluteUrl;
      }
    } catch (ex) {
      if (!absoluteUrl.startsWith(INSTANCE_URL)) {
        return absoluteUrl;
      }
    }
    const fetchUrl = buildAttachmentProxyUrl(absoluteUrl);
    try {
      return await getImageDataUrl(fetchUrl, mimeType);
    } catch (ex) {
      try {
        const response = await fetch(fetchUrl, {credentials: 'include'});
        if (response.ok) {
          const responseBlob = await response.blob();
          const effectiveMimeType = String(mimeType || responseBlob.type || response.headers.get('Content-Type') || '').trim().toLowerCase();
          if (effectiveMimeType.startsWith('image/')) {
            const normalizedBlob = responseBlob.type === effectiveMimeType
              ? responseBlob
              : new Blob([await responseBlob.arrayBuffer()], {type: effectiveMimeType});
            return blobToDataUrl(normalizedBlob);
          }
        }
      } catch (fallbackError) {
        // Ignore and fall back to the original URL below.
      }
      return absoluteUrl;
    }
  }

  function rememberDisplayImageUrl(url, dataUrl) {
    return isImageDataUrl(dataUrl) ? dataUrl : url;
  }

  async function resolveAttachmentDisplayImageUrl(mimeType, ...candidateUrls) {
    for (const candidateUrl of candidateUrls) {
      if (!candidateUrl) {
        continue;
      }
      try {
        const displayUrl = await getDisplayImageUrl(candidateUrl, mimeType);
        if (isImageDataUrl(displayUrl)) {
          return displayUrl;
        }
      } catch (ex) {
        // Ignore and keep trying the next candidate.
      }
    }
    return '';
  }

  async function normalizeIssueAttachmentImage(attachment) {
    if (!attachment || typeof attachment !== 'object') {
      return attachment;
    }
    const rawContentUrl = toAbsoluteJiraUrl(attachment.rawContentUrl || attachment.content);
    const rawThumbnailUrl = toAbsoluteJiraUrl(attachment.rawThumbnailUrl || attachment.thumbnail);
    const mimeType = String(attachment.mimeType || '').trim().toLowerCase();
    const existingInlineDataUrl = isImageDataUrl(attachment.inlineDataUrl)
      ? String(attachment.inlineDataUrl).trim()
      : (isImageDataUrl(attachment.displayContent) ? String(attachment.displayContent).trim() : '');
    const existingPreviewDataUrl = isImageDataUrl(attachment.previewDataUrl)
      ? String(attachment.previewDataUrl).trim()
      : '';
    const inlineDataUrl = existingInlineDataUrl
      || await resolveAttachmentDisplayImageUrl(mimeType, rawThumbnailUrl, rawContentUrl);
    const previewDataUrl = existingPreviewDataUrl
      || await resolveAttachmentDisplayImageUrl(mimeType, rawContentUrl, rawThumbnailUrl)
      || inlineDataUrl;
    attachment.rawContentUrl = rawContentUrl;
    attachment.rawThumbnailUrl = rawThumbnailUrl || rawContentUrl;
    attachment.content = rawContentUrl;
    attachment.inlineDataUrl = inlineDataUrl;
    attachment.previewDataUrl = previewDataUrl;
    attachment.displayContent = inlineDataUrl;
    attachment.previewDisplaySrc = previewDataUrl;
    attachment.thumbnail = inlineDataUrl;
    return attachment;
  }

  // ── Text & HTML Formatting ─────────────────────────────────

  function escapeHtml(input) {
    const node = document.createElement('div');
    node.textContent = input || '';
    return node.innerHTML;
  }

  function normalizeIssueKey(issueKey) {
    return String(issueKey || '').trim().replace(/\s+/g, '-').toUpperCase();
  }

  function resolveKnownJiraUserDisplayName(identity) {
    const normalizedIdentity = String(identity || '').replace(/^accountid:/i, '').trim();
    if (!normalizedIdentity) return '';
    const fields = popupState?.issueData?.fields || {};
    const users = [
      fields.reporter,
      fields.assignee,
      ...(fields.comment?.comments || []).map(comment => comment?.author),
      ...(popupState?.watchersState?.watchers || []),
      ...(popupState?.watchersState?.searchResults || []),
      ...(commentLifecycle.view().compose?.mention?.suggestions || []),
      ...(commentLifecycle.view().rowAction?.mention?.suggestions || []),
    ];
    Object.keys(fields).filter(key => key.startsWith('customfield_')).forEach(key => {
      users.push(...(Array.isArray(fields[key]) ? fields[key] : [fields[key]]));
    });
    const user = users.find(candidate => [candidate?.accountId, candidate?.name, candidate?.username, candidate?.key]
      .some(value => String(value || '').trim() === normalizedIdentity));
    return String(user?.displayName || user?.name || user?.username || user?.key || '').trim();
  }

  function replaceMentionTextNodes(rootNode) {
    if (!rootNode) {
      return;
    }
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node?.textContent || !/\[~([^[\]\r\n]+?)\]/.test(node.textContent)) {
          return NodeFilter.FILTER_SKIP;
        }
        const parentTag = String(node.parentElement?.tagName || '').toLowerCase();
        if (parentTag === 'script' || parentTag === 'style' || parentTag === 'textarea' || parentTag === 'code' || parentTag === 'pre') {
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const textNodes = [];
    let currentNode = walker.nextNode();
    while (currentNode) {
      textNodes.push(currentNode);
      currentNode = walker.nextNode();
    }

    textNodes.forEach(textNode => {
      const text = String(textNode.textContent || '');
      const matches = [...text.matchAll(/\[~([^[\]\r\n]+?)\]/g)];
      if (!matches.length) {
        return;
      }
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      matches.forEach(match => {
        const matchIndex = Number(match.index || 0);
        if (matchIndex > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, matchIndex)));
        }
        const mentionNode = document.createElement('span');
        mentionNode.className = '_JX_mention';
        mentionNode.textContent = getMentionDisplayText(match[1]);
        fragment.appendChild(mentionNode);
        lastIndex = matchIndex + match[0].length;
      });
      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      }
      textNode.parentNode?.replaceChild(fragment, textNode);
    });
  }

  function replaceAttachmentMarkupTextNodes(rootNode, attachmentLookup = null, imageMaxHeight = 100) {
    if (!rootNode || !attachmentLookup?.size) {
      return;
    }
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node?.textContent || !/!\s*([^!\r\n]+?)(?:\|[^!\r\n]*)?!/.test(node.textContent)) {
          return NodeFilter.FILTER_SKIP;
        }
        const parentTag = String(node.parentElement?.tagName || '').toLowerCase();
        if (parentTag === 'script' || parentTag === 'style' || parentTag === 'textarea' || parentTag === 'code' || parentTag === 'pre') {
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const textNodes = [];
    let currentNode = walker.nextNode();
    while (currentNode) {
      textNodes.push(currentNode);
      currentNode = walker.nextNode();
    }

    textNodes.forEach(textNode => {
      const text = String(textNode.textContent || '');
      const matches = [...text.matchAll(/!\s*([^!\r\n]+?)(?:\|[^!\r\n]*)?!/g)];
      if (!matches.length) {
        return;
      }
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      matches.forEach(match => {
        const matchIndex = Number(match.index || 0);
        if (matchIndex > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, matchIndex)));
        }
        const normalizedName = normalizeHistoryAttachmentName(normalizeCommentImageReference(match[1]));
        const attachmentView = normalizedName ? attachmentLookup.get(normalizedName) : null;
        if (attachmentView?.inlineDisplaySrc) {
          const imageNode = document.createElement('img');
          imageNode.className = '_JX_previewable';
          imageNode.setAttribute('src', attachmentView.inlineDisplaySrc);
          imageNode.setAttribute('alt', attachmentView.filename || normalizeCommentImageReference(match[1]));
          imageNode.setAttribute('data-jx-preview-src', attachmentView.previewDisplaySrc || attachmentView.inlineDisplaySrc);
          imageNode.style.maxHeight = `${Number(imageMaxHeight) || 100}px`;
          fragment.appendChild(imageNode);
        } else {
          fragment.appendChild(document.createTextNode(match[0]));
        }
        lastIndex = matchIndex + match[0].length;
      });
      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      }
      textNode.parentNode?.replaceChild(fragment, textNode);
    });
  }


  // ── HTML Sanitization ──────────────────────────────────────

  function sanitizeRichHtml(rawHtml) {
    const temp = document.createElement('div');
    temp.innerHTML = rawHtml || '';

    const blockedTags = [
      'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
      'form', 'input', 'button', 'textarea', 'select', 'svg', 'math'
    ];
    blockedTags.forEach(tagName => {
      Array.from(temp.querySelectorAll(tagName)).forEach(node => node.remove());
    });

    const elements = Array.from(temp.querySelectorAll('*'));
    elements.forEach(element => {
      Array.from(element.attributes).forEach(attribute => {
        const name = attribute.name.toLowerCase();
        const value = attribute.value || '';

        if (name.startsWith('on') || name === 'srcdoc' || name === 'style') {
          element.removeAttribute(attribute.name);
          return;
        }

        if (name === 'href') {
          const normalized = value.trim();
          if (/^(javascript|data):/i.test(normalized)) {
            element.removeAttribute(attribute.name);
          }
          return;
        }

        if (name === 'src') {
          const normalized = value.trim();
          const safeImageDataUrl = /^data:image\/(gif|png|jpeg|jpg|webp);/i.test(normalized);
          const safeHttpUrl = /^https?:/i.test(normalized);
          if (!safeImageDataUrl && !safeHttpUrl) {
            element.removeAttribute(attribute.name);
          }
          return;
        }
      });
    });

    return temp;
  }

  async function normalizeRichHtml(html, options = {}) {
    if (!html) {
      return '';
    }
    const {imageMaxHeight, attachmentLookup = null} = options;
    const temp = sanitizeRichHtml(html);

    replaceAttachmentMarkupTextNodes(temp, attachmentLookup, imageMaxHeight);

    const imageNodes = Array.from(temp.querySelectorAll('img[src]'));
    await Promise.all(imageNodes.map(async img => {
      const altText = normalizeHistoryAttachmentName(img.getAttribute('alt') || '');
      const linkedAttachment = altText && attachmentLookup?.get(altText)
        ? attachmentLookup.get(altText)
        : null;
      const linkedInlineSrc = linkedAttachment?.inlineDisplaySrc || linkedAttachment?.thumbnail || '';
      const linkedPreviewSrc = linkedAttachment?.previewDisplaySrc || linkedInlineSrc;
      const rawSourceUrl = img.getAttribute('src');
      const displaySrc = linkedInlineSrc || await getDisplayImageUrl(toAbsoluteJiraUrl(rawSourceUrl));
      if (displaySrc) {
        img.setAttribute('src', displaySrc);
        img.setAttribute('data-jx-preview-src', linkedPreviewSrc || displaySrc);
        img.classList.add('_JX_previewable');
      } else if (linkedAttachment) {
        img.remove();
      }
      if (imageMaxHeight) {
        img.style.maxHeight = `${imageMaxHeight}px`;
      }
    }));

    const anchorNodes = Array.from(temp.querySelectorAll('a[href]'));
    anchorNodes.forEach(anchor => {
      const href = anchor.getAttribute('href');
      const absoluteHref = toAbsoluteJiraUrl(href);
      if (absoluteHref) {
        anchor.setAttribute('href', absoluteHref);
      }
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
      anchor.setAttribute('title', buildLinkHoverTitle(
        'Open link',
        anchor.textContent || absoluteHref || href,
        absoluteHref || href
      ));
    });

    replaceMentionTextNodes(temp);

    return temp.innerHTML;
  }

  function createDescriptionEditState(issueData, overrides = {}) {
    const descriptionFieldValue = issueData?.fields?.description;
    const editorState = buildDescriptionEditorState(descriptionFieldValue);
    const inferredMediaNodesByMarkup = {
      ...buildDescriptionMediaNodesFromAttachments(editorState.text, issueData?.fields?.attachment),
      ...buildDescriptionMediaNodesFromRenderedHtml(issueData?.renderedFields?.description, issueData?.fields?.attachment),
      ...editorState.mediaNodesByMarkup,
    };
    const currentValue = editorState.text;
    return {
      ...emptyDescriptionEditState(),
      inputValue: currentValue,
      mediaNodesByMarkup: inferredMediaNodesByMarkup,
      originalInputValue: currentValue,
      prefersRichText: editorState.prefersRichText || isRichTextDescriptionDocument(descriptionFieldValue),
      selectionStart: currentValue.length,
      selectionEnd: currentValue.length,
      ...overrides
    };
  }

  function getDescriptionEditState() {
    return popupState?.descriptionEditState || createDescriptionEditState(popupState?.issueData);
  }

  function setDescriptionEditState(nextState) {
    if (!popupState) {
      return;
    }
    popupState = {
      ...popupState,
      descriptionEditState: nextState
    };
  }

  function clearDescriptionStatusTimer() {
    if (descriptionStatusTimeoutId) {
      clearTimeout(descriptionStatusTimeoutId);
      descriptionStatusTimeoutId = null;
    }
  }

  function scheduleDescriptionStatusClear(statusMessage) {
    clearDescriptionStatusTimer();
    if (!statusMessage) {
      return;
    }
    descriptionStatusTimeoutId = setTimeout(() => {
      descriptionStatusTimeoutId = null;
      const currentState = popupState?.descriptionEditState;
      if (!currentState || currentState.open || currentState.statusMessage !== statusMessage) {
        return;
      }
      setDescriptionEditState({
        ...currentState,
        statusKind: '',
        statusMessage: ''
      });
      renderIssuePopup(popupState).catch(() => {});
    }, 5000);
  }

  function buildDescriptionImageMarkup(fileName) {
    return `!${fileName}!`;
  }

  function extractDescriptionAttachmentId(url) {
    const source = String(url || '');
    if (!source) {
      return '';
    }
    const match = source.match(/\/attachment\/(?:content|thumbnail)\/([^/?#]+)/i)
      || source.match(/\/secure\/attachment\/([^/?#]+)/i);
    return match ? String(match[1] || '').trim() : '';
  }

  function getDescriptionImageMarkups(text) {
    return Array.from(String(text || '').matchAll(/!([^!\n]+)!/g))
      .map(match => buildDescriptionImageMarkup(String(match[1] || '').split('|')[0].trim()))
      .filter(Boolean);
  }

  function buildDescriptionMediaNodesFromAttachments(text, attachments = []) {
    const attachmentByMarkup = new Map(
      (Array.isArray(attachments) ? attachments : [])
        .filter(attachment => attachment?.filename || attachment?.fileName)
        .map(attachment => {
          const fileName = String(attachment.filename || attachment.fileName || '').trim();
          return [buildDescriptionImageMarkup(fileName), attachment];
        })
        .filter(([markup]) => markup !== '!!')
    );
    return getDescriptionImageMarkups(text).reduce((result, markup) => {
      const mediaNode = buildMediaSingleNodeFromAttachment(attachmentByMarkup.get(markup));
      if (mediaNode) {
        result[markup] = mediaNode;
      }
      return result;
    }, {});
  }

  function buildDescriptionMediaNodesFromRenderedHtml(html, attachments = []) {
    if (!html || typeof DOMParser === 'undefined') {
      return {};
    }
    const attachmentByName = new Map(
      (Array.isArray(attachments) ? attachments : [])
        .filter(attachment => attachment?.filename || attachment?.fileName)
        .map(attachment => [String(attachment.filename || attachment.fileName || '').trim(), attachment])
    );
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    return Array.from(doc.querySelectorAll('img')).reduce((result, image) => {
      const fileName = String(image.getAttribute('alt') || '').trim();
      if (!fileName) {
        return result;
      }
      const attachmentId = String(
        attachmentByName.get(fileName)?.id
        || extractDescriptionAttachmentId(image.getAttribute('src'))
        || ''
      ).trim();
      if (!attachmentId) {
        return result;
      }
      result[buildDescriptionImageMarkup(fileName)] = buildMediaSingleNodeFromAttachment({
        id: attachmentId,
        fileName,
        filename: fileName,
      });
      return result;
    }, {});
  }

  async function descriptionFileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('Could not read file'));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(file);
    });
  }

  function buildDescriptionUploadFileName(file, currentState = getDescriptionEditState()) {
    const mimeType = String(file?.type || '').toLowerCase();
    const extensionByMimeType = {
      'image/bmp': 'bmp',
      'image/gif': 'gif',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    };
    const extension = extensionByMimeType[mimeType] || 'png';
    const nextSequence = Number(currentState?.uploadSequence || 0) + 1;
    const timestamp = new Date().toISOString().replace(/[^\d]/g, '').slice(0, 14);
    return {
      fileName: `pasted-image-${timestamp}-${nextSequence}.${extension}`,
      uploadSequence: nextSequence,
    };
  }

  function updateDescriptionDraft(nextValue, selectionStart, selectionEnd) {
    if (!popupState?.descriptionEditState?.open) {
      return;
    }
    setDescriptionEditState({
      ...getDescriptionEditState(),
      errorMessage: '',
      inputValue: String(nextValue || ''),
      prefersRichText: getDescriptionEditState().prefersRichText,
      selectionStart: typeof selectionStart === 'number' ? selectionStart : String(nextValue || '').length,
      selectionEnd: typeof selectionEnd === 'number' ? selectionEnd : String(nextValue || '').length,
    });
    renderIssuePopup(popupState).catch(() => {});
  }

  function replaceDescriptionSelection(replacer) {
    const currentState = getDescriptionEditState();
    if (!currentState.open) {
      return;
    }
    const inputValue = String(currentState.inputValue || '');
    const selectionStart = Math.max(0, Number(currentState.selectionStart || 0));
    const selectionEnd = Math.max(selectionStart, Number(currentState.selectionEnd || selectionStart));
    const nextSelection = replacer({
      selectionEnd,
      selectionStart,
      selectedText: inputValue.slice(selectionStart, selectionEnd),
      value: inputValue,
    });
    if (!nextSelection || typeof nextSelection.value !== 'string') {
      return;
    }
    setDescriptionEditState({
      ...currentState,
      errorMessage: '',
      inputValue: nextSelection.value,
      prefersRichText: nextSelection.prefersRichText != null ? !!nextSelection.prefersRichText : currentState.prefersRichText,
      selectionStart: Number.isInteger(nextSelection.selectionStart) ? nextSelection.selectionStart : selectionStart,
      selectionEnd: Number.isInteger(nextSelection.selectionEnd) ? nextSelection.selectionEnd : selectionEnd,
    });
    renderIssuePopup(popupState).catch(() => {});
  }

  function wrapDescriptionSelectionLineByLine(text, prefix, suffix) {
    return String(text || '')
      .split('\n')
      .map(line => {
        if (!line.trim()) {
          return line;
        }
        const match = line.match(/^(\s*)(.*?)(\s*)$/);
        const leadingWhitespace = match?.[1] || '';
        const content = match?.[2] || '';
        const trailingWhitespace = match?.[3] || '';
        if (!content) {
          return line;
        }
        return `${leadingWhitespace}${prefix}${content}${suffix}${trailingWhitespace}`;
      })
      .join('\n');
  }

  function wrapDescriptionSelection(prefix, suffix, placeholder) {
    replaceDescriptionSelection(({value, selectedText, selectionStart, selectionEnd}) => {
      const isMultilineSelection = !!selectedText && selectedText.includes('\n');
      const content = selectedText
        ? (isMultilineSelection
            ? wrapDescriptionSelectionLineByLine(selectedText, prefix, suffix)
            : selectedText)
        : placeholder;
      const wrapperPrefix = selectedText
        ? (isMultilineSelection ? '' : prefix)
        : prefix;
      const wrapperSuffix = selectedText
        ? (isMultilineSelection ? '' : suffix)
        : suffix;
      const nextValue = value.slice(0, selectionStart) + wrapperPrefix + content + wrapperSuffix + value.slice(selectionEnd);
      const contentStart = selectionStart + wrapperPrefix.length;
      const contentEnd = contentStart + content.length;
      return {
        value: nextValue,
        selectionStart: selectedText ? selectionStart : contentStart,
        selectionEnd: selectedText ? (selectionStart + wrapperPrefix.length + content.length + wrapperSuffix.length) : contentEnd,
      };
    });
  }

  function prefixDescriptionSelectedLines(prefix) {
    replaceDescriptionSelection(({value, selectionStart, selectionEnd}) => {
      const lineStart = value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
      let lineEnd = value.indexOf('\n', selectionEnd);
      if (lineEnd === -1) {
        lineEnd = value.length;
      }
      const block = value.slice(lineStart, lineEnd);
      const nextBlock = block.split('\n').map(line => `${prefix}${line}`).join('\n');
      const nextValue = value.slice(0, lineStart) + nextBlock + value.slice(lineEnd);
      return {
        value: nextValue,
        selectionStart: lineStart,
        selectionEnd: lineStart + nextBlock.length,
      };
    });
  }

  function applyDescriptionFormatting(action) {
    switch (String(action || '')) {
      case 'bold':
        wrapDescriptionSelection('*', '*', 'bold text');
        return;
      case 'italic':
        wrapDescriptionSelection('_', '_', 'italic text');
        return;
      case 'underline':
        wrapDescriptionSelection('+', '+', 'underlined text');
        return;
      case 'bulletList':
        prefixDescriptionSelectedLines('* ');
        return;
      case 'numberList':
        prefixDescriptionSelectedLines('# ');
        return;
      case 'codeBlock':
        wrapDescriptionSelection('{noformat}\n', '\n{noformat}', 'code');
        return;
      default:
        break;
    }
  }

  async function deleteDescriptionDraftAttachment(attachmentId) {
    if (!attachmentId) {
      return;
    }
    try {
      await requestJson('DELETE', `${INSTANCE_URL}rest/api/2/attachment/${attachmentId}`);
    } catch (error) {
      console.warn('[Jira QuickView] Could not delete description draft attachment', {
        attachmentId,
        error: error?.message || String(error),
      });
    }
  }

  async function discardDescriptionEditStateSnapshot(stateSnapshot, options = {}) {
    const {deleteUploaded = true} = options;
    const uploads = Array.isArray(stateSnapshot?.uploads) ? stateSnapshot.uploads : [];
    uploads.forEach(item => {
      if (item?.previewUrl && item.previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(item.previewUrl);
      }
    });
    if (!deleteUploaded) {
      return;
    }
    await Promise.all(uploads
      .filter(item => item?.status === 'uploaded' && item.attachmentId)
      .map(item => deleteDescriptionDraftAttachment(item.attachmentId)));
  }

  function startDescriptionEdit() {
    if (!popupState?.issueData) {
      return;
    }
    pinContainer({showNotice: false});
    clearDescriptionStatusTimer();
    setDescriptionEditState(createDescriptionEditState(popupState.issueData, {open: true}));
    renderIssuePopup(popupState).catch(() => {});
  }

  async function cancelDescriptionEdit() {
    if (!popupState?.issueData) {
      return;
    }
    const currentState = getDescriptionEditState();
    const hadDraftUploads = Array.isArray(currentState.uploads) && currentState.uploads.length > 0;
    clearDescriptionStatusTimer();
    setDescriptionEditState({
      ...currentState,
      open: false,
      saving: false,
      statusKind: '',
      statusMessage: '',
    });
    await discardDescriptionEditStateSnapshot(currentState, {deleteUploaded: true});
    if (hadDraftUploads) {
      await refreshPopupIssueState('', {
        mutation: {kind: 'attachmentChanged'},
        preserveHistory: !!popupState?.historyOpen,
      });
    }
    if (!popupState?.issueData) {
      return;
    }
    setDescriptionEditState(createDescriptionEditState(popupState.issueData));
    renderIssuePopup(popupState).catch(() => {});
  }

  async function uploadDescriptionImage(file) {
    if (!popupState?.issueData?.key) {
      return;
    }
    const currentState = getDescriptionEditState();
    if (!currentState.open) {
      return;
    }
    const issueKey = popupState.issueData.key;
    const {fileName, uploadSequence} = buildDescriptionUploadFileName(file, currentState);
    const localId = `description-upload-${Date.now()}-${uploadSequence}`;
    const markup = buildDescriptionImageMarkup(fileName);
    const previewUrl = URL.createObjectURL(file);
    const displayUrl = await descriptionFileToDataUrl(file).catch(() => '');
    const nextUploads = [
      ...currentState.uploads,
      {
        attachmentId: '',
        contentUrl: '',
        displayUrl,
        errorMessage: '',
        fileName,
        localId,
        markup,
        previewUrl,
        status: 'uploading',
        thumbnailUrl: '',
      }
    ];
    const value = currentState.inputValue || '';
    const selectionStart = Number.isInteger(currentState.selectionStart) ? currentState.selectionStart : value.length;
    const selectionEnd = Number.isInteger(currentState.selectionEnd) ? currentState.selectionEnd : selectionStart;
    const beforeValue = value.slice(0, selectionStart);
    const afterValue = value.slice(selectionEnd);
    const prefix = beforeValue
      ? (beforeValue.endsWith('\n\n') ? '' : (beforeValue.endsWith('\n') ? '\n' : '\n\n'))
      : '';
    const suffix = afterValue
      ? (afterValue.startsWith('\n\n') ? '' : (afterValue.startsWith('\n') ? '\n' : '\n\n'))
      : '\n';
    const insertedText = `${prefix}${markup}${suffix}`;
    const nextInputValue = value.slice(0, selectionStart) + insertedText + value.slice(selectionEnd);
    const nextCaret = selectionStart + insertedText.length;
    setDescriptionEditState({
      ...currentState,
      errorMessage: '',
      inputValue: nextInputValue,
      selectionStart: nextCaret,
      selectionEnd: nextCaret,
      uploadSequence,
      uploads: nextUploads,
    });
    await renderIssuePopup(popupState);

    try {
      const uploadResult = await uploadAttachment(`${INSTANCE_URL}rest/api/2/issue/${issueKey}/attachments`, new File([file], fileName, {type: file.type || 'image/png'}));
      const uploadedAttachment = (Array.isArray(uploadResult) ? uploadResult : [uploadResult]).find(item => item && item.id);
      if (!uploadedAttachment) {
        throw new Error('Attachment upload failed');
      }
      const latestState = getDescriptionEditState();
      if (!popupState?.issueData || popupState.issueData.key !== issueKey || !latestState.open) {
        await deleteDescriptionDraftAttachment(uploadedAttachment.id);
        return;
      }
      const nextFileName = uploadedAttachment.filename || fileName;
      const nextMarkup = buildDescriptionImageMarkup(nextFileName);
      const nextInputValue = nextMarkup === markup
        ? latestState.inputValue
        : String(latestState.inputValue || '').replace(markup, nextMarkup);
      const nextUploadsState = latestState.uploads.map(item => {
        if (item.localId !== localId) {
          return item;
        }
        return {
          ...item,
          attachmentId: uploadedAttachment.id,
          contentUrl: toAbsoluteJiraUrl(uploadedAttachment.content),
          displayUrl,
          fileName: nextFileName,
          markup: nextMarkup,
          status: 'uploaded',
          thumbnailUrl: toAbsoluteJiraUrl(uploadedAttachment.thumbnail || uploadedAttachment.content),
        };
      });
      rememberDisplayImageUrl(toAbsoluteJiraUrl(uploadedAttachment.content), displayUrl);
      rememberDisplayImageUrl(toAbsoluteJiraUrl(uploadedAttachment.thumbnail || uploadedAttachment.content), displayUrl);
      setDescriptionEditState({
        ...latestState,
        inputValue: nextInputValue,
        uploads: nextUploadsState,
      });
      await handleDraftAttachmentUploaded({
        ...uploadedAttachment,
        content: toAbsoluteJiraUrl(uploadedAttachment.content),
        displayContent: displayUrl,
        thumbnail: displayUrl || toAbsoluteJiraUrl(uploadedAttachment.thumbnail || uploadedAttachment.content),
      });
      await renderIssuePopup(popupState);
    } catch (error) {
      const latestState = getDescriptionEditState();
      if (!latestState.open) {
        return;
      }
      setDescriptionEditState({
        ...latestState,
        errorMessage: error?.message || error?.inner || 'Could not upload pasted image',
        inputValue: String(latestState.inputValue || '').replace(markup, '').replace(/\n{3,}/g, '\n\n'),
        uploads: latestState.uploads.map(item => {
          if (item.localId !== localId) {
            return item;
          }
          return {
            ...item,
            errorMessage: error?.message || error?.inner || 'Upload failed',
            status: 'error',
          };
        }),
      });
      renderIssuePopup(popupState).catch(() => {});
    }
  }

  async function saveDescriptionEdit() {
    if (!popupState?.issueData) {
      return;
    }
    const currentState = getDescriptionEditState();
    if (!currentState.open || currentState.saving || currentState.uploads.some(item => item?.status === 'uploading')) {
      return;
    }
    const nextDescription = String(currentState.inputValue || '');
    if (nextDescription === String(currentState.originalInputValue || '')) {
      return;
    }
    const attachmentByMarkup = {};
    const issueAttachments = Array.isArray(popupState?.issueData?.fields?.attachment) ? popupState.issueData.fields.attachment : [];
    issueAttachments.forEach(attachment => {
      const fileName = String(attachment?.filename || '').trim();
      if (!fileName) {
        return;
      }
      attachmentByMarkup[buildDescriptionImageMarkup(fileName)] = attachment;
    });
    currentState.uploads.forEach(upload => {
      const fileName = String(upload?.fileName || '').trim();
      const attachmentId = String(upload?.attachmentId || '').trim();
      if (!fileName || !attachmentId) {
        return;
      }
      attachmentByMarkup[buildDescriptionImageMarkup(fileName)] = {
        fileName,
        filename: fileName,
        id: attachmentId,
      };
    });
    const saveValueResult = buildDescriptionSaveFieldValue(nextDescription, {
      attachmentByMarkup,
      mediaNodesByMarkup: currentState.mediaNodesByMarkup,
      preferRichText: !!currentState.prefersRichText,
    });
    if (saveValueResult.error) {
      setDescriptionEditState({
        ...currentState,
        errorMessage: saveValueResult.error,
        saving: false,
        statusKind: 'error',
        statusMessage: saveValueResult.error,
      });
      await renderIssuePopup(popupState);
      return;
    }

    clearDescriptionStatusTimer();
    setDescriptionEditState({
      ...currentState,
      errorMessage: '',
      saving: true,
      statusKind: 'info',
      statusMessage: 'Saving description...',
    });
    await renderIssuePopup(popupState);

    try {
      await requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${popupState.key}`, {
        fields: {
          description: saveValueResult.value,
        }
      });
      await refreshPopupIssueState('', {
        mutation: {kind: 'descriptionChanged'},
        preserveHistory: !!popupState?.historyOpen,
      });
      if (!popupState?.issueData) {
        return;
      }
      const successMessage = nextDescription.trim() ? 'Description updated' : 'Description cleared';
      setDescriptionEditState(createDescriptionEditState(popupState.issueData, {
        statusKind: 'success',
        statusMessage: successMessage,
      }));
      await renderIssuePopup(popupState);
      scheduleDescriptionStatusClear(successMessage);
    } catch (error) {
      const latestState = getDescriptionEditState();
      const errorMessage = buildEditFieldError(error);
      const displayError = /^HTTP \d+\b/i.test(errorMessage) ? 'Could not update description' : errorMessage;
      setDescriptionEditState({
        ...latestState,
        errorMessage: displayError,
        saving: false,
        statusKind: 'error',
        statusMessage: displayError,
      });
      await renderIssuePopup(popupState);
    }
  }

  // ── Comments ──────────────────────────────────────────────

  async function handleCommentReactionClick(commentId, emojiId) {
    if (!popupState?.issueData || !commentId || !emojiId) {
      return;
    }
    const sessionId = currentPopupSessionId();
    const pending = commentLifecycle.dispatch({type: 'toggleReaction', commentId, emojiId});
    await renderCurrentPopup('comment-reaction-pending');
    const outcome = await pending;
    if (outcome.sessionId !== sessionId || sessionId !== currentPopupSessionId()) {
      return;
    }
    if (outcome.refreshedSnapshot) {
      popupState = {...popupState, issueSnapshot: outcome.refreshedSnapshot};
    }
    await renderCurrentPopup('comment-reaction-complete');
    if (outcome.kind === 'unsupported') {
      snackBar(outcome.notice);
    }
  }

  async function handleCommentSave() {
    const commentIssueKey = commentLifecycle.view().issueKey;
    if (!commentIssueKey) {
      return;
    }

    const elements = getCommentComposerElements();
    const commentDraftText = String(elements.input.val() || '');
    const commentText = commentDraftText.trim();
    if (!commentText) {
      syncCommentComposerState();
      return;
    }
    if (commentLifecycle.view().compose?.uploads?.some(item => item.status === 'uploading')) {
      setCommentComposerError('Wait for image uploads to finish.');
      syncCommentComposerState();
      return;
    }

    commentLifecycle.dispatch({
      type: 'composeChanged',
      value: commentDraftText,
      selection: {
        start: typeof elements.input.get(0)?.selectionStart === 'number' ? elements.input.get(0).selectionStart : commentDraftText.length,
        end: typeof elements.input.get(0)?.selectionEnd === 'number' ? elements.input.get(0).selectionEnd : commentDraftText.length,
      },
    }).catch(() => {});
    const pendingSave = commentLifecycle.dispatch({
      type: 'saveNewComment',
      requirements: {history: !!popupState?.historyOpen},
    });
    elements.root.attr('data-saving', commentLifecycle.view().compose?.saving ? 'true' : 'false');
    setCommentComposerError(commentLifecycle.view().compose?.errorMessage || '');
    syncCommentComposerState();

    const outcome = await pendingSave;
    const isSameIssueStillVisible = popupState?.issueData?.key === commentIssueKey &&
      outcome.sessionId === currentPopupSessionId();
    elements.root.attr('data-saving', 'false');
    if (outcome.kind === 'mutationCommitted' && isSameIssueStillVisible) {
      if (outcome.refreshedSnapshot?.core) {
        const historySection = outcome.refreshedSnapshot.sections?.history;
        popupState = {
          ...popupState,
          issueSnapshot: outcome.refreshedSnapshot,
          issueData: outcome.refreshedSnapshot.core,
          changelogData: popupState.historyOpen && ['ready', 'empty', 'staleRetained'].includes(historySection?.status)
            ? historySection.data
            : popupState.changelogData,
          changelogLoading: false,
          lastActionSuccess: outcome.notice,
        };
      }
      elements.input.val('');
      setCommentComposerError('');
      await renderCurrentPopup('comment-save-complete');
      if (outcome.failure) {
        snackBar(outcome.notice);
      } else {
        scheduleActionNoticeClear(outcome.notice);
      }
      return;
    }
    if (outcome.kind === 'failed' && isSameIssueStillVisible) {
      setCommentComposerError(outcome.failure?.message || 'Could not save comment');
      syncCommentComposerState();
    }
  }

  async function handleCommentDiscard() {
    const elements = getCommentComposerElements();
    if (!elements.root.length || elements.root.attr('data-saving') === 'true') {
      return;
    }
    await commentLifecycle.dispatch({type: 'discardCompose', deleteUploaded: true});
    await discardCommentComposerDraft();
  }


  function getActiveCommentSession() {
    return commentLifecycle.view().rowAction || null;
  }

  function resetCommentEditMentionState() {
    commentLifecycle.dispatch({type: 'dismissMention', lane: 'edit'}).catch(() => {});
  }

  async function applyCommentRowActionOutcome(outcome) {
    const isCurrent = popupState?.key === outcome.issueKey && outcome.sessionId === currentPopupSessionId();
    if (!isCurrent) return;
    if (outcome.kind === 'mutationCommitted' && outcome.refreshedSnapshot?.core) {
      const historySection = outcome.refreshedSnapshot.sections?.history;
      popupState = {
        ...popupState,
        issueSnapshot: outcome.refreshedSnapshot,
        issueData: outcome.refreshedSnapshot.core,
        changelogData: popupState.historyOpen && ['ready', 'empty', 'staleRetained'].includes(historySection?.status)
          ? historySection.data
          : popupState.changelogData,
        changelogLoading: false,
        lastActionSuccess: outcome.notice,
      };
    }
    await renderCurrentPopup('comment-row-action-complete');
    if (outcome.kind === 'failed') snackBar(outcome.failure?.message || 'Comment operation failed');
    else if (outcome.failure) snackBar(outcome.notice);
    else if (outcome.kind === 'mutationCommitted') scheduleActionNoticeClear(outcome.notice);
  }

  function cancelCommentSession() {
    if (!commentLifecycle.view().rowAction) {
      return;
    }
    resetCommentEditMentionState();
    commentLifecycle.dispatch({type: 'cancelRowAction'}).then(() => {
      return renderCurrentPopup('comment-row-action-cancelled');
    }).catch(() => {});
  }

  function startCommentEdit(commentId) {
    if (!popupState?.issueData || !commentId) {
      return;
    }
    pinContainer({showNotice: false});
    resetCommentEditMentionState();
    commentLifecycle.dispatch({type: 'startEdit', commentId}).then(() => {
      return renderCurrentPopup('comment-edit-started');
    }).catch(() => {});
  }

  function moveCommentEditMentionSelection(delta) {
    commentLifecycle.dispatch({type: 'moveMention', lane: 'edit', delta}).then(() => {
      return renderCurrentPopup('comment-edit-mention-moved');
    }).catch(() => {});
  }

  function renderCommentEditMentionSuggestions() {
    container.find('._JX_comment_edit_mentions').attr('hidden', 'hidden').empty();
    const rowAction = commentLifecycle.view().rowAction;
    const commentEditMentionState = rowAction?.mention;
    const commentId = rowAction?.commentId || '';
    if (!commentEditMentionState?.visible || !commentId) {
      return;
    }
    const mentions = container.find(`._JX_comment_edit_mentions[data-comment-id="${commentId}"]`);
    const input = container.find(`._JX_comment_edit_input[data-comment-id="${commentId}"]`);
    const mentionsElement = mentions.get(0);
    const inputElement = input.get(0);
    if (!mentions.length) {
      return;
    }
    const positionSuggestions = (html) => {
      mentions.removeAttr('hidden').html(html);
      if (mentionsElement && inputElement) {
        positionMentionMenuAtCaret({
          caretIndex: typeof inputElement.selectionStart === 'number'
            ? inputElement.selectionStart
            : commentEditMentionState.range?.start,
          hostElement: input.closest('._JX_comment_editor').get(0),
          inputElement,
          menuElement: mentionsElement,
        });
      }
    };
    if (commentEditMentionState.loading) {
      positionSuggestions('<div class="_JX_comment_mentions_status">Searching people...</div>');
      return;
    }
    if (commentEditMentionState.errorMessage) {
      positionSuggestions(`<div class="_JX_comment_mentions_status">${escapeHtml(commentEditMentionState.errorMessage)}</div>`);
      return;
    }
    if (!commentEditMentionState.suggestions.length) {
      positionSuggestions('<div class="_JX_comment_mentions_status">No people found.</div>');
      return;
    }
    positionSuggestions(commentEditMentionState.suggestions.map((candidate, index) => {
      const selectedClass = index === commentEditMentionState.selectedIndex ? ' is-selected' : '';
      const secondary = candidate.secondaryText ? `<span class="_JX_comment_mention_secondary">${escapeHtml(candidate.secondaryText)}</span>` : '';
      return `
        <button class="_JX_comment_mention_option${selectedClass} _JX_comment_edit_mention_option" type="button" data-comment-id="${escapeHtml(commentId)}" data-mention-index="${index}">
          <span>
            <span class="_JX_comment_mention_primary">${escapeHtml(candidate.displayName)}</span>
            ${secondary}
          </span>
        </button>
      `;
    }).join(''));
  }

  function applyCommentEditMentionSelection(index) {
    const activeSession = getActiveCommentSession();
    if (!activeSession || activeSession.mode !== 'edit') {
      return;
    }
    commentLifecycle.dispatch({
      type: 'chooseMention',
      lane: 'edit',
      index,
    }).then(() => {
      return renderCurrentPopup('comment-edit-mention-chosen');
    }).catch(() => {});
  }

  function startCommentDeleteConfirm(commentId) {
    if (!popupState?.issueData || !commentId) {
      return;
    }
    resetCommentEditMentionState();
    commentLifecycle.dispatch({type: 'startDelete', commentId}).then(() => {
      return renderCurrentPopup('comment-delete-started');
    }).catch(() => {});
  }

  function updateCommentEditDraft(commentId, draft, selectionStart, selectionEnd) {
    const activeSession = getActiveCommentSession();
    if (!activeSession || activeSession.commentId !== String(commentId) || activeSession.mode !== 'edit') {
      return;
    }
    const pending = commentLifecycle.dispatch({
      type: 'editChanged',
      commentId,
      value: draft,
      selection: {start: selectionStart, end: selectionEnd},
    });
    renderCurrentPopup('comment-edit-changed').catch(() => {});
    pending.then(() => {
      return renderCurrentPopup('comment-edit-mention-updated');
    }).catch(() => {});
  }

  async function saveCommentEdit(commentId) {
    const activeSession = getActiveCommentSession();
    if (!popupState?.key || !activeSession || activeSession.commentId !== String(commentId) || activeSession.mode !== 'edit' || activeSession.saving) {
      return;
    }
    resetCommentEditMentionState();
    const pending = commentLifecycle.dispatch({
      type: 'saveEdit',
      commentId,
      requirements: {history: !!popupState?.historyOpen},
    });
    await renderCurrentPopup('comment-edit-saving');
    await applyCommentRowActionOutcome(await pending);
  }

  async function confirmCommentDelete(commentId) {
    const activeSession = getActiveCommentSession();
    if (!popupState?.key || !activeSession || activeSession.commentId !== String(commentId) || activeSession.mode !== 'delete' || activeSession.saving) {
      return;
    }

    const pending = commentLifecycle.dispatch({
      type: 'confirmDelete',
      commentId,
      requirements: {history: !!popupState?.historyOpen},
    });
    await renderCurrentPopup('comment-delete-saving');
    await applyCommentRowActionOutcome(await pending);
  }

  // ── Pull Requests & Dev Status ─────────────────────────────

  /***
   * Retrieve only the text that is directly owned by the node
   * @param node
   */
  function getShallowText(node) {
    const TEXT_NODE = 3;
    return $(node).contents().filter(function (i, n) {
      //TODO, not specific enough, need to evaluate getBoundingClientRect
      return n.nodeType === TEXT_NODE;
    }).text();
  }

  function normalizeSearchText(input, maxLength = 400) {
    return String(input || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }

  function isEditorOverlaySite() {
    const host = window.location.hostname.toLowerCase();
    return host === 'docs.google.com' ||
      host.endsWith('.sharepoint.com') ||
      host.endsWith('.office.com') ||
      host.endsWith('.officeapps.live.com') ||
      host.endsWith('.cloud.microsoft');
  }

  function isOfficeOverlaySite() {
    const host = window.location.hostname.toLowerCase();
    return host.endsWith('.sharepoint.com') ||
      host.endsWith('.office.com') ||
      host.endsWith('.officeapps.live.com') ||
      host.endsWith('.cloud.microsoft');
  }

  function getReferencedText(node, attributeName) {
    const ids = String(node?.getAttribute?.(attributeName) || '').trim().split(/\s+/).filter(Boolean);
    return ids.map(id => normalizeSearchText(document.getElementById(id)?.textContent || '')).filter(Boolean);
  }

  function getNodeSearchTexts(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      return [];
    }

    const texts = [
      getShallowText(node),
      node.textContent,
      node.innerText,
      node.getAttribute('aria-label'),
      node.getAttribute('title'),
      node.getAttribute('data-stringify-text'),
      node.getAttribute('data-tooltip'),
      node.getAttribute('data-value'),
      node.getAttribute('data-text'),
      node.getAttribute('data-contents'),
      node.value,
      node.placeholder
    ];

    texts.push(...getReferencedText(node, 'aria-labelledby'));
    texts.push(...getReferencedText(node, 'aria-describedby'));

    if (node.shadowRoot) {
      texts.push(node.shadowRoot.textContent);
    }

    if (node.href) {
      texts.push(getRelativeHref(node.href));
    }

    const dedupedTexts = [];
    const seen = new Set();
    texts.forEach(text => {
      const normalized = normalizeSearchText(text);
      if (!normalized || seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      dedupedTexts.push(normalized);
    });

    return dedupedTexts;
  }

  function getJiraKeysFromTexts(texts) {
    for (const text of texts) {
      const keys = getJiraKeys(text);
      if (size(keys)) {
        return keys;
      }
    }
    return [];
  }

  // ── Issue Data & Metadata ──────────────────────────────────

  async function getIssueWatchers(issueKey) {
    if (!issueKey) {
      return {
        isWatching: false,
        watchCount: 0,
        watchers: []
      };
    }
    const outcome = await quickViewIssueData.openIssue({issueKey, requirements: {watchers: true}});
    const section = outcome.snapshot?.sections?.watchers;
    if (!section || section.status === 'failed') {
      throw new Error(section?.failure?.message || outcome.failures?.core?.message || 'Could not load watchers');
    }
    return section.data || {isWatching: false, watchCount: 0, watchers: []};
  }

  async function searchWatcherCandidates(query) {
    const [outcome, currentUser] = await Promise.all([
      quickViewIssueData.search({purpose: 'watcher', query}),
      getCurrentUserInfo().catch(() => null),
    ]);
    if (outcome.kind !== 'loaded') {
      throw new Error(outcome.failure?.message || 'Could not search Jira users');
    }
    return normalizeWatcherUsers(outcome.items, currentUser);
  }

  function getWatcherIdentifierCandidates(user) {
    const candidates = [
      {type: 'accountId', value: user?.accountId || user?.rawValue?.accountId || ''},
      {type: 'name', value: user?.name || user?.rawValue?.name || ''},
      {type: 'key', value: user?.key || user?.rawValue?.key || ''}
    ];
    return candidates.filter((candidate, index, array) => {
      return candidate.value && array.findIndex(other => other.type === candidate.type && other.value === candidate.value) === index;
    });
  }

  async function addWatcher(issueKey, user) {
    const candidates = getWatcherIdentifierCandidates(user);
    let lastError;
    for (const candidate of candidates) {
      try {
        await requestJson('POST', `${INSTANCE_URL}rest/api/2/issue/${issueKey}/watchers`, candidate.value);
        return candidate;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Could not add watcher');
  }

  async function removeWatcher(issueKey, user) {
    const candidates = getWatcherIdentifierCandidates(user);
    let lastError;
    for (const candidate of candidates) {
      const queryKey = candidate.type === 'accountId'
        ? 'accountId'
        : (candidate.type === 'key' ? 'key' : 'username');
      try {
        await requestJson('DELETE', `${INSTANCE_URL}rest/api/2/issue/${issueKey}/watchers?${queryKey}=${encodeURIComponent(candidate.value)}`);
        return candidate;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Could not remove watcher');
  }

  function clearWatchersFeedbackTimer() {
    if (watchersFeedbackTimeoutId) {
      clearTimeout(watchersFeedbackTimeoutId);
      watchersFeedbackTimeoutId = null;
    }
  }

  function scheduleWatchersFeedbackClear() {
    clearWatchersFeedbackTimer();
    watchersFeedbackTimeoutId = setTimeout(() => {
      watchersFeedbackTimeoutId = null;
      if (!popupState?.watchersState) {
        return;
      }
      renderUpdatedPopupState(currentState => ({
        ...currentState,
        watchersState: buildNextWatchersState(currentState.watchersState, {
          addFeedback: null,
          removeFeedback: null,
        })
      })).catch(() => {});
    }, 5000);
  }

  function clearActionNoticeTimer() {
    if (actionNoticeTimeoutId) {
      clearTimeout(actionNoticeTimeoutId);
      actionNoticeTimeoutId = null;
    }
  }

  function scheduleActionNoticeClear(noticeText) {
    clearActionNoticeTimer();
    if (!noticeText) {
      return;
    }
    actionNoticeTimeoutId = setTimeout(() => {
      actionNoticeTimeoutId = null;
      if (!popupState?.lastActionSuccess || popupState.lastActionSuccess !== noticeText) {
        return;
      }
      renderUpdatedPopupState(currentState => ({
        ...currentState,
        lastActionSuccess: ''
      })).catch(() => {});
    }, 5000);
  }

  // ── Labels ────────────────────────────────────────────────

  function getCustomFieldRowFromLayout(fieldId, tooltipLayout) {
    const layoutKey = fieldId ? `custom_${fieldId}` : '';
    if (!layoutKey) {
      return null;
    }
    if (tooltipLayout?.row1?.includes(layoutKey)) {
      return 1;
    }
    if (tooltipLayout?.row2?.includes(layoutKey)) {
      return 2;
    }
    if (tooltipLayout?.row3?.includes(layoutKey)) {
      return 3;
    }
    return null;
  }

  function normalizeCustomFields(customFields, tooltipLayout) {
    if (!Array.isArray(customFields)) {
      return [];
    }
    const seen = {};
    return customFields
      .map(field => {
        const fieldId = String(field?.fieldId || '').trim();
        const rowFromLayout = getCustomFieldRowFromLayout(fieldId, tooltipLayout);
        const row = rowFromLayout || Math.min(3, Math.max(1, Number(field?.row) || 3));
        return {fieldId, row};
      })
      .filter(field => {
        if (!field.fieldId || seen[field.fieldId]) {
          return false;
        }
        seen[field.fieldId] = true;
        return true;
      });
  }

  function formatCustomFieldChip(fieldName, entry) {
    if (entry === undefined || entry === null) {
      return null;
    }
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      const textValue = String(entry);
      return buildFilterChip(fieldName ? `${fieldName}: ${textValue}` : textValue, `${fieldName} = ${encodeJqlValue(textValue)}`, {
        linkLabel: textValue
      });
    }
    const primaryText = entry.name || entry.value || entry.displayName || entry.id || entry.key;
    if (!primaryText) {
      return null;
    }
    const formattedValue = entry.key && (entry.name || entry.value)
      ? `[${entry.key}] ${entry.name || entry.value}`
      : String(primaryText);
    return buildFilterChip(fieldName ? `${fieldName}: ${formattedValue}` : formattedValue, `${fieldName} = ${encodeJqlValue(String(primaryText))}`, {
      linkLabel: String(primaryText)
    });
  }
  async function buildCustomFieldChips(issueData, customFields, state) {
    const names = issueData.names || {};
    const fields = issueData.fields || {};
    const chipsByRow = {1: [], 2: [], 3: []};
    for (const {fieldId, row} of customFields) {
      const rawValue = fields[fieldId];
      const fieldName = String(names[fieldId] || fieldId);
      const hasDisplayValue = Array.isArray(rawValue)
        ? rawValue.some(value => value !== undefined && value !== null && value !== '')
        : !(rawValue === undefined || rawValue === null || rawValue === '');
      const fieldOutcome = await jiraFieldEditing.dispatch({type: 'describeField', fieldId}).catch(() => null);
      const field = fieldOutcome?.field;
      if (field?.supported && (hasDisplayValue || field.visibleWhenEmpty)) {
        const baseChip = buildFilterChip(field.text, field.jqlClause, {linkLabel: field.linkLabel});
        chipsByRow[row].push(buildEditableFieldChip(fieldId, baseChip, state, {
          canEdit: field.editable,
          editTitle: `Edit ${fieldName}`
        }));
        continue;
      }
      if (!hasDisplayValue) {
        continue;
      }
      const entries = Array.isArray(rawValue) ? rawValue : [rawValue];
      entries.forEach(entry => {
        const chip = formatCustomFieldChip(fieldName, entry);
        if (chip && chip.text) {
          const nonEditableReason = getNonEditableFieldReason();
          chipsByRow[row].push({
            ...chip,
            chipTitle: appendTooltipText(chip.chipTitle || chip.linkTitle || '', nonEditableReason),
            linkTitle: appendTooltipText(chip.linkTitle || '', nonEditableReason)
          });
        }
      });
    }
    return chipsByRow;
  }

  // ── Sprints & Versions ─────────────────────────────────────

  function getIssueSprintEntries(issueData) {
    const names = issueData.names || {};
    const fields = issueData.fields || {};
    const sprintFieldIds = Object.keys(names).filter(fieldId => {
      return typeof names[fieldId] === 'string' && names[fieldId].toLowerCase().includes('sprint');
    });
    const sprintEntries = [];
    sprintFieldIds.forEach(fieldId => {
      const value = fields[fieldId];
      if (value === undefined || value === null) {
        return;
      }
      if (Array.isArray(value)) {
        sprintEntries.push(...value.filter(Boolean));
        return;
      }
      sprintEntries.push(value);
    });
    return sprintEntries;
  }

  function readSprintsFromIssue(issueData) {
    const sprintEntries = getIssueSprintEntries(issueData);
    const seen = {};
    const sprints = [];

    const pushSprint = (id, name, state) => {
      if (!name) {
        return;
      }
      const sprintId = id ? String(id) : '';
      const key = sprintId || `${name}__${state || ''}`;
      if (seen[key]) {
        return;
      }
      seen[key] = true;
      sprints.push({id: sprintId, name, state: state || ''});
    };

    sprintEntries.forEach(entry => {
      if (!entry) {
        return;
      }
      if (typeof entry === 'string') {
        const idMatch = entry.match(/id=([^,\]]+)/i);
        const nameMatch = entry.match(/name=([^,\]]+)/i);
        const stateMatch = entry.match(/state=([^,\]]+)/i);
        pushSprint(
          idMatch && idMatch[1] ? idMatch[1] : '',
          nameMatch && nameMatch[1] ? nameMatch[1] : entry,
          stateMatch && stateMatch[1]
        );
        return;
      }
      pushSprint(entry.id || '', entry.name || entry.goal || entry.id, entry.state);
    });
    return sprints;
  }

  // ── JQL & Display Utilities ────────────────────────────────

  function encodeJqlValue(value) {
    return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  function buildJqlUrl(jql) {
    return `${INSTANCE_URL}issues/?jql=${encodeURIComponent(jql)}`;
  }

  function buildViewAllIssuesTitle(valueText) {
    const normalizedValueText = String(valueText || '').trim();
    return normalizedValueText
      ? `View all "${normalizedValueText}" issues`
      : 'View matching issues';
  }

  function ensureTooltipSentence(text) {
    const normalizedText = String(text || '').trim();
    if (!normalizedText) {
      return '';
    }
    return /[.!?]$/.test(normalizedText)
      ? normalizedText
      : `${normalizedText}.`;
  }

  function buildLinkHoverTitle(actionText, detailText, url) {
    return [actionText, detailText]
      .map(part => ensureTooltipSentence(part))
      .filter(Boolean)
      .join('\n');
  }

  function appendTooltipText(baseText, extraText) {
    const parts = [ensureTooltipSentence(baseText), ensureTooltipSentence(extraText)].filter(Boolean);
    return parts.join('\n\n');
  }

  function getNonEditableFieldReason() {
    return 'Jira doesn\'t allow changing this field in the current issue state';
  }

  function constrainEditPopoversToViewport() {
    const viewportPadding = 8;
    container.find('._JX_edit_popover').each(function () {
      const popover = this;
      const anchor = popover.parentElement;
      if (!anchor) {
        return;
      }

      popover.style.position = '';
      popover.style.left = '';
      popover.style.right = '';
      popover.style.top = '';
      popover.style.width = '';
      popover.style.maxWidth = '';

      const maxWidth = Math.max(260, window.innerWidth - (viewportPadding * 2));
      const popoverWidth = Math.min(320, maxWidth);
      popover.style.maxWidth = `${maxWidth}px`;
      popover.style.width = `${popoverWidth}px`;

      const anchorRect = anchor.getBoundingClientRect();
      const fitsRight = anchorRect.left + popoverWidth <= window.innerWidth - viewportPadding;
      if (fitsRight) {
        popover.style.left = '0';
        popover.style.right = 'auto';
        return;
      }

      const fitsLeft = anchorRect.right - popoverWidth >= viewportPadding;
      if (fitsLeft) {
        popover.style.left = 'auto';
        popover.style.right = '0';
        return;
      }

      popover.style.left = `${Math.max(viewportPadding - anchorRect.left, 0)}px`;
      popover.style.right = 'auto';
    });
  }

  function scopeJqlToProject(projectKey, clause) {
    if (!projectKey || !clause) {
      return clause || '';
    }
    return `project = ${encodeJqlValue(projectKey)} AND ${clause}`;
  }

  // ── Chips & Activity Indicators ────────────────────────────

  function buildFilterChip(text, jql, extra = {}) {
    const linkUrl = jql ? buildJqlUrl(jql) : '';
    return {
      text,
      linkUrl,
      linkTitle: linkUrl ? buildLinkHoverTitle(extra.linkAction || buildViewAllIssuesTitle(extra.linkLabel || text), extra.linkDetail || '') : '',
      ...extra
    };
  }

  function buildLabelsChip(labels, projectKey) {
    const normalizedLabels = Array.isArray(labels)
      ? labels.map(label => String(label || '').trim()).filter(Boolean)
      : [];
    const dedupedLabels = normalizedLabels.filter((label, index, array) => array.indexOf(label) === index);
    const headerJql = dedupedLabels.length
      ? scopeJqlToProject(projectKey, `labels in (${dedupedLabels.map(encodeJqlValue).join(', ')})`)
      : '';

    return {
      text: `Labels: ${dedupedLabels.join(', ') || '--'}`,
      chipTitle: dedupedLabels.length ? `Labels: ${dedupedLabels.join(', ')}` : 'Labels: --',
      isLabelsComposite: true,
      labelsView: {
        headerText: 'Labels',
        headerLinkUrl: headerJql ? buildJqlUrl(headerJql) : '',
        headerLinkTitle: headerJql ? buildLinkHoverTitle('View issues with any listed label', dedupedLabels.join(', ')) : '',
        hasLabels: dedupedLabels.length > 0,
        labels: dedupedLabels.map((label, index) => ({
          text: label,
          linkUrl: buildJqlUrl(scopeJqlToProject(projectKey, `labels = ${encodeJqlValue(label)}`)),
          linkTitle: buildLinkHoverTitle('View issues with this label', label),
          showSeparator: index < dedupedLabels.length - 1
        }))
      }
    };
  }

  function areSameJiraUser(left, right) {
    if (!left || !right) {
      return false;
    }
    const leftIds = [left.accountId, left.name, left.username, left.key].filter(Boolean);
    const rightIds = [right.accountId, right.name, right.username, right.key].filter(Boolean);
    return leftIds.some(value => rightIds.includes(value));
  }


  function buildEditFieldError(error) {
    return error?.message || error?.inner || 'Update failed';
  }

  function readTimeTrackingValues(issueData) {
    const timeTracking = issueData?.fields?.timetracking || {};
    return {
      originalEstimate: String(timeTracking.originalEstimate || '').trim(),
      remainingEstimate: String(timeTracking.remainingEstimate || '').trim(),
      timeSpent: String(timeTracking.timeSpent || '').trim()
    };
  }

  function getTodayDateInputValue() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function buildWorklogStartedValue(dateValue) {
    const normalizedDate = String(dateValue || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
      return '';
    }
    const localDate = new Date(`${normalizedDate}T12:00:00`);
    if (Number.isNaN(localDate.getTime())) {
      return '';
    }
    const timezoneOffsetMinutes = -localDate.getTimezoneOffset();
    const sign = timezoneOffsetMinutes >= 0 ? '+' : '-';
    const absoluteOffsetMinutes = Math.abs(timezoneOffsetMinutes);
    const offsetHours = String(Math.floor(absoluteOffsetMinutes / 60)).padStart(2, '0');
    const offsetMinutes = String(absoluteOffsetMinutes % 60).padStart(2, '0');
    return `${normalizedDate}T12:00:00.000${sign}${offsetHours}${offsetMinutes}`;
  }

  function createTimeTrackingEditState(issueData, overrides = {}) {
    const values = readTimeTrackingValues(issueData);
    return {
      originalEstimateValue: values.originalEstimate,
      remainingEstimateValue: values.remainingEstimate,
      timeSpentValue: values.timeSpent,
      originalEstimateInput: values.originalEstimate,
      remainingEstimateInput: values.remainingEstimate,
      worklogAmountInput: '',
      worklogDescriptionInput: '',
      worklogDateInput: getTodayDateInputValue(),
      activeInputField: '',
      saving: false,
      errorMessage: '',
      ...overrides
    };
  }

  function normalizeTimeTrackingInput(value) {
    return String(value || '').trim();
  }

  function defaultHoursIfNoUnit(value) {
    if (!value) {
      return value;
    }
    return /[a-zA-Z]$/.test(value) ? value : `${value}h`;
  }

  function buildTimeTrackingSavePlan(timeTrackingState, options = {}) {
    const canEditEstimates = options.canEditEstimates !== false;
    const originalEstimateInput = normalizeTimeTrackingInput(timeTrackingState?.originalEstimateInput);
    const remainingEstimateInput = normalizeTimeTrackingInput(timeTrackingState?.remainingEstimateInput);
    const worklogAmountInput = normalizeTimeTrackingInput(timeTrackingState?.worklogAmountInput);
    const worklogDescriptionInput = normalizeTimeTrackingInput(timeTrackingState?.worklogDescriptionInput);
    const worklogDateInput = normalizeTimeTrackingInput(timeTrackingState?.worklogDateInput) || getTodayDateInputValue();
    const originalEstimateChanged = canEditEstimates && originalEstimateInput !== normalizeTimeTrackingInput(timeTrackingState?.originalEstimateValue);
    const remainingEstimateChanged = canEditEstimates && remainingEstimateInput !== normalizeTimeTrackingInput(timeTrackingState?.remainingEstimateValue);
    const estimateFields = {};
    const worklogStarted = buildWorklogStartedValue(worklogDateInput);
    const worklogPayload = worklogAmountInput ? {
      timeSpent: defaultHoursIfNoUnit(worklogAmountInput),
      ...(worklogDescriptionInput ? {comment: worklogDescriptionInput} : {}),
      ...(worklogStarted ? {started: worklogStarted} : {})
    } : null;

    if (originalEstimateChanged) {
      estimateFields.originalEstimate = defaultHoursIfNoUnit(originalEstimateInput);
    }
    if (remainingEstimateChanged) {
      estimateFields.remainingEstimate = defaultHoursIfNoUnit(remainingEstimateInput);
    }

    return {
      originalEstimateInput,
      remainingEstimateInput,
      worklogAmountInput,
      worklogDescriptionInput,
      worklogDateInput,
      worklogPayload,
      hasEstimateChanges: Object.keys(estimateFields).length > 0,
      hasWorklogChange: !!worklogPayload,
      hasChanges: Object.keys(estimateFields).length > 0 || !!worklogPayload,
      estimateFields
    };
  }

  function buildTimeTrackingErrorMessage(result) {
    const messages = [];
    if (result?.estimateError) {
      messages.push(`Estimates: ${buildEditFieldError(result.estimateError)}`);
    }
    if (result?.worklogError) {
      messages.push(`Log work: ${buildEditFieldError(result.worklogError)}`);
    }
    return messages.join(' ');
  }

  function buildTimeTrackingSuccessMessage(result) {
    if (result?.estimateSaved && result?.worklogSaved) {
      return 'Time tracking updated';
    }
    if (result?.estimateSaved) {
      return 'Estimates updated';
    }
    if (result?.worklogSaved) {
      return 'Work logged';
    }
    return '';
  }

  function buildTimeTrackingSectionPresentation(issueData, timeTrackingState, timeTrackingCapability) {
    const state = timeTrackingState || createTimeTrackingEditState(issueData);
    const canEditEstimates = !!timeTrackingCapability?.editable;
    const savePlan = buildTimeTrackingSavePlan(state, {canEditEstimates});
    const hasTimeTrackingSection = issueData?.fields?.timetracking !== undefined || canEditEstimates;

    if (!hasTimeTrackingSection) {
      return null;
    }

    return {
      canEditEstimates,
      hasChanges: savePlan.hasChanges,
      originalEstimateDisplay: state.originalEstimateValue || '--',
      originalEstimateInput: state.originalEstimateInput || '',
      remainingEstimateDisplay: state.remainingEstimateValue || '--',
      remainingEstimateInput: state.remainingEstimateInput || '',
      timeSpentDisplay: state.timeSpentValue || '--',
      worklogAmountInput: state.worklogAmountInput || '',
      worklogDescriptionInput: state.worklogDescriptionInput || '',
      worklogDateInput: state.worklogDateInput || getTodayDateInputValue(),
      saveButtonLabel: state.saving ? 'Saving...' : 'Save',
      saveDisabled: !!(state.saving || !savePlan.hasChanges),
      estimateInputsDisabled: !!(state.saving || !canEditEstimates),
      worklogInputDisabled: !!state.saving,
      showEstimateHint: !canEditEstimates,
      estimateHintText: 'Jira does not allow editing estimates on this issue right now.',
      errorMessage: state.errorMessage || ''
    };
  }

  // ── Edit Options & Multi-Select ────────────────────────────

  // ── Edit UI Presentation ───────────────────────────────────

  function getActiveFieldEditState(state = popupState) {
    return jiraFieldEditing.view().edit || state?.editState || null;
  }

  function buildActiveEditPresentation(fieldKey, state, options = {}) {
    const editState = getActiveFieldEditState(state);
    if (editState?.fieldKey !== fieldKey) {
      return null;
    }

    const isMultiSelect = editState.selectionMode === 'multi';
    const isTextEditor = editState.selectionMode === 'text';
    const selectedOptionIds = new Set(isMultiSelect
      ? normalizeMultiSelectOptionIds(editState.selectedOptionIds)
      : (editState.selectedOptionId === null || typeof editState.selectedOptionId === 'undefined'
          ? []
          : [String(editState.selectedOptionId)]));
    const visibleOptions = isTextEditor ? [] : filterEditOptions(editState.options, editState.inputValue);
    const selectableOptions = visibleOptions.filter(option => !option.isGroupLabel);
    const highlightedOption = selectableOptions.find(option => option.id === editState.highlightedOptionId) || selectableOptions[0];
    const filteredOptions = visibleOptions.map((option, optionIndex) => ({
      ...option,
      fieldKey,
      optionDomId: `jira-popup-edit-option-${fieldKey}-${optionIndex}`,
      isSelected: option.isGroupLabel ? false : selectedOptionIds.has(option.id),
      isHighlighted: !option.isGroupLabel && option.id === highlightedOption?.id,
      isMultiSelect,
      title: option.label
    }));
    const selectedValues = isMultiSelect
      ? (editState.selectedOptions || []).map(option => ({
          ...option,
          fieldKey,
          title: option.label,
          removeTitle: `Remove ${option.label}`,
          removeDisabled: !!editState.saving
        }))
      : [];
    const isSearchEditor = editState.editorType === 'user-search' || editState.editorType === 'issue-search' || editState.editorType === 'label-search' || editState.editorType === 'tempo-account-search';
    const inputDisabled = !!(editState.saving || (editState.loadingOptions && !isSearchEditor));
    const loadingText = editState.loadingOptions
      ? (isSearchEditor ? `Searching ${editState.label.toLowerCase()}...` : `Loading ${editState.label.toLowerCase()} values...`)
      : editState.saving
        ? `Saving ${editState.label.toLowerCase()}...`
        : '';

    return {
      fieldKey,
      isEditing: true,
      isRightAligned: options.isRightAligned || fieldKey === 'fixVersions' || fieldKey === 'versions',
      editLabel: editState.label,
      inputValue: editState.inputValue,
      highlightedOptionDomId: highlightedOption
        ? `jira-popup-edit-option-${fieldKey}-${visibleOptions.indexOf(highlightedOption)}`
        : '',
      inputPlaceholder: editState.inputPlaceholder || `Type to filter ${editState.label.toLowerCase()} values`,
      inputDisabled,
      useTextarea: editState.editorType === 'textarea',
      loadingText,
      options: filteredOptions,
      showDropdown: !isTextEditor,
      hasOptions: filteredOptions.length > 0,
      editEmptyText: editState.loadingOptions ? 'Loading values...' : (isTextEditor ? '' : 'No matching values'),
      editError: editState.errorMessage || '',
      isMultiSelect,
      showActionButtons: !!(editState.showActionButtons || isMultiSelect || isTextEditor),
      showSelectedValues: isMultiSelect && selectedValues.length > 0,
      selectedValues,
      saveDisabled: !!(editState.loadingOptions || editState.saving || !editState.hasChanges),
      discardDisabled: !!editState.saving
    };
  }

  function buildEditableFieldChip(fieldKey, baseChip, state, options = {}) {
    if (options.canEdit === false) {
      const nonEditableReason = options.nonEditableReason || getNonEditableFieldReason();
      return {
        ...baseChip,
        chipTitle: appendTooltipText(baseChip.chipTitle || baseChip.linkTitle || '', nonEditableReason),
        linkTitle: appendTooltipText(baseChip.linkTitle || '', nonEditableReason)
      };
    }
    const activeEdit = buildActiveEditPresentation(fieldKey, state, {
      isRightAligned: options.isRightAligned
    });
    if (activeEdit) {
      return {
        ...baseChip,
        ...activeEdit,
        isEditable: true,
        hideInlineEditButton: !!options.hideInlineEditButton,
        editTitle: 'Discard'
      };
    }
    return {
      ...baseChip,
      isEditable: true,
      hideInlineEditButton: !!options.hideInlineEditButton,
      fieldKey,
      editTitle: options.editTitle || `Edit ${baseChip.text}`
    };
  }

  // ── Avatars & User Display ─────────────────────────────────

  function compareSprintState(left, right) {
    const order = {
      active: 0,
      future: 1,
      closed: 2
    };
    return (order[String(left || '').toLowerCase()] ?? 99) - (order[String(right || '').toLowerCase()] ?? 99);
  }

  function formatSprintActionLabel(sprint) {
    const sprintName = String(sprint?.name || '').trim();
    const sprintState = String(sprint?.state || '').toLowerCase();
    const stateSuffix = sprintState === 'active'
      ? ' (ACTIVE)'
      : (sprintState === 'future' ? ' (NEXT)' : '');
    return `Move to Sprint ${sprintName}${stateSuffix}`.trim();
  }

  async function getProjectSprintOptions(issueData) {
    if (!issueData?.key) {
      return {
        activeSprints: [],
        upcomingSprint: null
      };
    }
    try {
      const sprintContext = await quickViewIssueData.loadFieldContext({
        issueKey: issueData.key,
        fieldId: 'sprint',
        includeOptions: true,
      });
      const sortedSprints = sprintContext.context?.options || [];
      const activeSprints = sortedSprints.filter(sprint => String(sprint?.state || '').toLowerCase() === 'active');
      const upcomingSprint = sortedSprints.find(sprint => String(sprint?.state || '').toLowerCase() === 'future') || null;
      return {
        activeSprints,
        upcomingSprint
      };
    } catch (error) {
      return {
        activeSprints: [],
        upcomingSprint: null
      };
    }
  }

  // ── Quick Actions ──────────────────────────────────────────

  const people = createContentPeopleHelpers({
    areSameJiraUser,
    buildEditOption,
  });
  const {
    buildUserView,
    normalizeAssignableUsers,
    normalizeWatcherUsers,
  } = people;

  const {buildPopupDisplayData} = createPopupProjectView({
    attachments: attachmentPresentation,
    buildActiveEditPresentation,
    buildCustomFieldChips,
    buildEditableFieldChip,
    buildFilterChip,
    buildLabelsChip,
    buildLinkHoverTitle,
    buildTimeTrackingSectionPresentation,
    comments: commentLifecycle,
    configuration: {
      customFields,
      displayFields,
      instanceUrl: INSTANCE_URL,
      layoutContentBlocks,
      loaderGifUrl,
      showPullRequests,
      tooltipLayout,
    },
    encodeJqlValue,
    getEditableFieldCapability,
    getTransitionOptions,
    issueData: quickViewIssueData,
    history: historyPresentation,
    normalizeRichHtml,
    people,
    quickActions: popupQuickActions,
    readSprintsFromIssue,
    resolveIssueLinkage,
    scopeJqlToProject,
  });


  // ── Popup Data & Rendering ─────────────────────────────────
  // ── Popup Positioning ──────────────────────────────────────
  function getRelativeHref(href) {
    const documentHref = document.location.href.split('#')[0];
    if (href.startsWith(documentHref)) {
      return href.slice(documentHref.length);
    }
    return href;
  }

  function clampContainerPosition(left, top) {
    if (!contentShellHelpers) {
      return {left, top};
    }
    return contentShellHelpers.clampContainerPosition(left, top);
  }

  function keepContainerVisible() {
    if (!contentShellHelpers) {
      return;
    }
    contentShellHelpers.keepContainerVisible();
  }

  function computeVisibleContainerPosition(pointerX, pointerY) {
    if (!contentShellHelpers) {
      return {left: pointerX, top: pointerY};
    }
    return contentShellHelpers.computeVisibleContainerPosition(pointerX, pointerY);
  }

  // ── Popup Rendering & State ────────────────────────────────
  let hideTimeOut;
  let hoverDelayTimeout;
  let containerPinned = false;
  let lastHoveredKey = '';
  const container = $('<div class="_JX_container" data-testid="jira-popup-root">');
  const previewOverlay = $(`
    <div class="_JX_preview_overlay" data-testid="jira-popup-preview-overlay">
      <img class="_JX_preview_image" data-testid="jira-popup-preview-image" />
    </div>
  `);
  $(document.body).append(container);
  $(document.body).append(previewOverlay);
  contentShellHelpers = createContentShellHelpers({
    container,
    previewOverlay,
    getDisplayImageUrl,
    isContainerPinned: () => containerPinned,
    clearHideTimeout: () => clearTimeout(hideTimeOut),
    pinContainer,
  });
  const popupRenderer = createBrowserPopupRenderer({
    comments: commentLifecycle,
    container,
    contentBlockOrder: layoutContentBlocks,
    continuity: {
      constrainPopovers: constrainEditPopoversToViewport,
      renderComposeMentions: renderCommentMentionSuggestions,
      renderEditMentions: renderCommentEditMentionSuggestions,
      renderUploads: renderCommentUploads,
      restoreComposer: restoreCommentComposerState,
      syncComposer: syncCommentComposerState,
    },
    fieldEditing: {view: getActiveFieldEditState},
    position: {
      compute: computeVisibleContainerPosition,
      isPinned: () => containerPinned,
    },
    projectState: buildPopupDisplayData,
    template: annotationTemplate,
  });
  async function runWatcherSearch(queryText, requestId) {
    const normalizedQuery = String(queryText || '').trim();
    try {
      const results = normalizedQuery ? await searchWatcherCandidates(normalizedQuery) : [];
      if (!popupState?.watchersState?.open || popupState.watchersState.searchRequestId !== requestId) {
        return;
      }
      await renderUpdatedPopupState(currentState => ({
        ...currentState,
        watchersState: buildNextWatchersState(currentState.watchersState, {
          searchLoading: false,
          searchResults: results,
        })
      }));
    } catch (error) {
      if (!popupState?.watchersState?.open || popupState.watchersState.searchRequestId !== requestId) {
        return;
      }
      await renderUpdatedPopupState(currentState => ({
        ...currentState,
        watchersState: buildNextWatchersState(currentState.watchersState, {
          searchLoading: false,
          errorMessage: buildEditFieldError(error),
        })
      }));
    }
  }

  async function openWatchersPanel() {
    if (!popupState?.issueData?.key) {
      return;
    }
    const issueKey = popupState.issueData.key;
    popupState = {
      ...popupState,
      watchersState: buildNextWatchersState(popupState.watchersState, {
        loading: true,
        errorMessage: '',
        addFeedback: null,
        removeFeedback: null,
        focusSearch: true,
      }),
    };
    const opened = await popupSession.dispatch({type: 'open-panel', panel: 'watchers'});
    if (opened.presentation?.activePanel !== 'watchers' || popupState?.issueData?.key !== issueKey) return;

    try {
      const watcherData = await getIssueWatchers(issueKey);
      if (!popupState?.watchersState?.open || popupState.issueData?.key !== issueKey) {
        return;
      }
      await renderUpdatedPopupState(currentState => ({
        ...currentState,
        watchersState: buildNextWatchersState(currentState.watchersState, {
          loading: false,
          errorMessage: '',
          watchers: watcherData.watchers,
        })
      }));
    } catch (error) {
      if (!popupState?.watchersState?.open || popupState.issueData?.key !== issueKey) {
        return;
      }
      await renderUpdatedPopupState(currentState => ({
        ...currentState,
        watchersState: buildNextWatchersState(currentState.watchersState, {
          loading: false,
          errorMessage: buildEditFieldError(error),
        })
      }));
    }
  }

  function resetWatchersPanelState() {
    clearWatchersFeedbackTimer();
    popupState = {
      ...popupState,
      watchersState: buildNextWatchersState(popupState?.watchersState, {
        loading: false,
        errorMessage: '',
        searchValue: '',
        searchLoading: false,
        searchRequestId: 0,
        searchResults: [],
        pendingAddIds: [],
        pendingRemoveIds: [],
        addFeedback: null,
        removeFeedback: null,
        focusSearch: false,
      }),
    };
  }

  function closeWatchersPanel() {
    if (!popupState?.watchersState?.open) return;
    resetWatchersPanelState();
    popupSession.dispatch({type: 'close-panel', panel: 'watchers'}).catch(() => {});
  }

  function closeHistoryFlyout() {
    if (!popupState?.historyOpen) {
      return;
    }
    popupSession.dispatch({type: 'close-panel', panel: 'history'}).catch(() => {});
  }

  async function toggleHistoryFlyout() {
    if (!popupState?.issueData?.key) return;
    const issueKey = popupState.issueData.key;
    const opening = !popupState.historyOpen;
    const shouldLoad = opening && !popupState.changelogData && !popupState.changelogLoading;
    if (opening && popupState.watchersState?.open) resetWatchersPanelState();
    if (shouldLoad) popupState = {...popupState, changelogLoading: true};
    const outcome = await popupSession.dispatch({type: 'toggle-panel', panel: 'history'});
    if (outcome.presentation?.activePanel !== 'history' || !shouldLoad) return;
    try {
      const changelog = await getIssueChangelog(issueKey);
      if (!popupState || popupState.key !== issueKey) return;
      popupState = {...popupState, changelogData: changelog, changelogLoading: false};
    } catch (error) {
      if (!popupState || popupState.key !== issueKey) return;
      popupState = {...popupState, changelogData: {histories: []}, changelogLoading: false};
    }
    if (popupState.historyOpen) await renderCurrentPopup('history-loaded');
  }

  function updateWatchersSearch(nextValue) {
    if (!popupState?.watchersState?.open) {
      return;
    }
    const searchValue = String(nextValue || '');
    if (!searchValue.trim()) {
      renderUpdatedPopupState(currentState => ({
        ...currentState,
        watchersState: buildNextWatchersState(currentState.watchersState, {
          searchValue,
          searchLoading: false,
          searchRequestId: 0,
          searchResults: [],
          errorMessage: '',
          focusSearch: true,
        })
      })).catch(() => {});
      return;
    }
    const searchRequestId = popupState.watchersState.searchRequestId + 1;
    renderUpdatedPopupState(currentState => ({
      ...currentState,
      watchersState: buildNextWatchersState(currentState.watchersState, {
        searchValue,
        searchLoading: true,
        searchRequestId,
        errorMessage: '',
        focusSearch: true,
      })
    })).then(() => {
      runWatcherSearch(searchValue, searchRequestId).catch(() => {});
    }).catch(() => {});
  }

  async function addWatcherFromPanel(watcherId) {
    const watcherState = popupState?.watchersState;
    if (!popupState?.issueData?.key || !watcherState) {
      return;
    }
    const user = (watcherState.searchResults || []).find(candidate => candidate.id === watcherId);
    if (!user || watcherState.pendingAddIds.includes(watcherId)) {
      return;
    }

    await renderUpdatedPopupState(currentState => ({
      ...currentState,
      watchersState: buildNextWatchersState(currentState.watchersState, {
        pendingAddIds: [...new Set([...(currentState.watchersState?.pendingAddIds || []), watcherId])],
        errorMessage: '',
        addFeedback: null,
      })
    }));

    try {
      await addWatcher(popupState.issueData.key, user);
      await refreshPopupIssueState('', {
        mutation: {kind: 'watchersChanged'},
        refreshWatchersPanel: true,
        scheduleWatchersFeedbackReset: true,
        scheduleWatchersFeedbackClear,
        nextWatchersStateChanges: {
          addFeedback: {
            id: watcherId,
            message: `${user.displayName} added to watchers`,
            toneClass: '_JX_watchers_feedback_row_success'
          },
        }
      });
    } catch (error) {
      await renderUpdatedPopupState(currentState => ({
        ...currentState,
        watchersState: buildNextWatchersState(currentState.watchersState, {
          pendingAddIds: (currentState.watchersState?.pendingAddIds || []).filter(id => id !== watcherId),
          errorMessage: '',
          addFeedback: {
            id: watcherId,
            message: buildEditFieldError(error),
            toneClass: '_JX_watchers_feedback_row_error'
          },
          focusSearch: true,
        })
      }));
      scheduleWatchersFeedbackClear();
    }
  }

  async function removeWatcherFromPanel(watcherId) {
    const watcherState = popupState?.watchersState;
    if (!popupState?.issueData?.key || !watcherState) {
      return;
    }
    const user = (watcherState.watchers || []).find(candidate => candidate.id === watcherId);
    if (!user || watcherState.pendingRemoveIds.includes(watcherId)) {
      return;
    }

    await renderUpdatedPopupState(currentState => ({
      ...currentState,
      watchersState: buildNextWatchersState(currentState.watchersState, {
        pendingRemoveIds: [...new Set([...(currentState.watchersState?.pendingRemoveIds || []), watcherId])],
        errorMessage: '',
        removeFeedback: null,
      })
    }));

    try {
      await removeWatcher(popupState.issueData.key, user);
      await refreshPopupIssueState('', {
        mutation: {kind: 'watchersChanged'},
        refreshWatchersPanel: true,
        scheduleWatchersFeedbackReset: true,
        scheduleWatchersFeedbackClear,
        nextWatchersStateChanges: {
          removeFeedback: {
            id: watcherId,
            message: `${user.displayName} removed from watchers`,
            toneClass: '_JX_watchers_feedback_row_neutral'
          },
        }
      });
    } catch (error) {
      await renderUpdatedPopupState(currentState => ({
        ...currentState,
        watchersState: buildNextWatchersState(currentState.watchersState, {
          pendingRemoveIds: (currentState.watchersState?.pendingRemoveIds || []).filter(id => id !== watcherId),
          errorMessage: '',
          removeFeedback: {
            id: watcherId,
            message: buildEditFieldError(error),
            toneClass: '_JX_watchers_feedback_row_error'
          },
        })
      }));
      scheduleWatchersFeedbackClear();
    }
  }

  function buildNextLinkedIssuesState(currentState = emptyLinkedIssuesState(), changes = {}) {
    return {
      ...emptyLinkedIssuesState(),
      ...currentState,
      ...changes,
    };
  }

  async function openLinkedIssuesPanel() {
    if (!popupState?.issueData?.key) {
      return;
    }
    const issueKey = popupState.issueData.key;
    popupState = {
      ...popupState,
      linkedIssuesState: buildNextLinkedIssuesState(popupState.linkedIssuesState, {
        loading: true,
        errorMessage: '',
        feedbackMessage: '',
        focusSearch: true,
      }),
    };
    const opened = await popupSession.dispatch({type: 'open-panel', panel: 'linkedIssues'});
    if (opened.presentation?.activePanel !== 'linkedIssues' || popupState?.issueData?.key !== issueKey) return;

    const [linkTypesResult, detailsResult] = await Promise.allSettled([
      getIssueLinkTypes(issueKey),
      getLinkedIssueDetails(popupState.issueData),
    ]);
    if (!popupState?.linkedIssuesState?.open || popupState.issueData?.key !== issueKey) {
      return;
    }
    const linkTypes = linkTypesResult.status === 'fulfilled' ? linkTypesResult.value : [];
    const relationshipOptions = buildRelationshipOptions(linkTypes);
    await renderUpdatedPopupState(currentState => ({
      ...currentState,
      linkedIssuesState: buildNextLinkedIssuesState(currentState.linkedIssuesState, {
        loading: false,
        linkTypes,
        relationshipId: currentState.linkedIssuesState?.relationshipId || relationshipOptions[0]?.id || '',
        issueDetailsByKey: detailsResult.status === 'fulfilled' ? detailsResult.value : {},
        errorMessage: linkTypesResult.status === 'rejected' ? buildEditFieldError(linkTypesResult.reason) : '',
        focusSearch: true,
      }),
    }));
  }

  function closeLinkedIssuesPanel() {
    if (!popupState?.linkedIssuesState?.open) {
      return;
    }
    if (linkedIssuesSearchTimeoutId) {
      clearTimeout(linkedIssuesSearchTimeoutId);
      linkedIssuesSearchTimeoutId = null;
    }
    popupState = {
      ...popupState,
      linkedIssuesState: buildNextLinkedIssuesState(popupState.linkedIssuesState, {
        loading: false,
        errorMessage: '',
        feedbackMessage: '',
        searchValue: '',
        searchLoading: false,
        searchRequestId: (popupState.linkedIssuesState?.searchRequestId || 0) + 1,
        searchResults: [],
        selectedIssues: [],
        pendingAddKeys: [],
        pendingRemoveIds: [],
        confirmingRemoveId: '',
        focusSearch: false,
      }),
    };
    popupSession.dispatch({type: 'close-panel', panel: 'linkedIssues'}).catch(() => {});
  }

  async function runLinkedIssuesSearch(query, requestId) {
    try {
      const excludedKeys = [
        ...getLinkedIssueKeys(popupState?.issueData),
        ...(popupState?.linkedIssuesState?.selectedIssues || []).map(issue => issue.key),
      ];
      const results = await searchIssueLinkCandidates(query, popupState.issueData, excludedKeys);
      if (!popupState?.linkedIssuesState?.open || popupState.linkedIssuesState.searchRequestId !== requestId) {
        return;
      }
      await renderUpdatedPopupState(currentState => ({
        ...currentState,
        linkedIssuesState: buildNextLinkedIssuesState(currentState.linkedIssuesState, {
          searchLoading: false,
          searchResults: results,
          errorMessage: '',
          focusSearch: true,
        }),
      }));
    } catch (error) {
      if (!popupState?.linkedIssuesState?.open || popupState.linkedIssuesState.searchRequestId !== requestId) {
        return;
      }
      await renderUpdatedPopupState(currentState => ({
        ...currentState,
        linkedIssuesState: buildNextLinkedIssuesState(currentState.linkedIssuesState, {
          searchLoading: false,
          searchResults: [],
          errorMessage: buildEditFieldError(error),
          focusSearch: true,
        }),
      }));
    }
  }

  function updateLinkedIssuesSearch(nextValue, selectionStart, selectionEnd) {
    if (!popupState?.linkedIssuesState?.open) {
      return;
    }
    if (linkedIssuesSearchTimeoutId) {
      clearTimeout(linkedIssuesSearchTimeoutId);
      linkedIssuesSearchTimeoutId = null;
    }
    const searchValue = String(nextValue || '');
    const shouldSearch = searchValue.trim().length >= 2;
    const searchRequestId = popupState.linkedIssuesState.searchRequestId + 1;
    renderUpdatedPopupState(currentState => ({
      ...currentState,
      linkedIssuesState: buildNextLinkedIssuesState(currentState.linkedIssuesState, {
        searchValue,
        searchSelectionStart: Number.isInteger(selectionStart) ? selectionStart : searchValue.length,
        searchSelectionEnd: Number.isInteger(selectionEnd) ? selectionEnd : searchValue.length,
        searchLoading: shouldSearch,
        searchRequestId,
        searchResults: [],
        errorMessage: '',
        feedbackMessage: '',
        focusSearch: true,
      }),
    })).then(() => {
      if (!shouldSearch) {
        return;
      }
      linkedIssuesSearchTimeoutId = setTimeout(() => {
        linkedIssuesSearchTimeoutId = null;
        runLinkedIssuesSearch(searchValue, searchRequestId).catch(() => {});
      }, 180);
    }).catch(() => {});
  }

  function selectLinkedIssueCandidate(issueKey) {
    const linkedState = popupState?.linkedIssuesState;
    if (!linkedState?.open) {
      return;
    }
    const issue = (linkedState.searchResults || []).find(candidate => candidate.key === issueKey);
    if (!issue || (linkedState.selectedIssues || []).some(candidate => candidate.key === issue.key)) {
      return;
    }
    renderUpdatedPopupState(currentState => ({
      ...currentState,
      linkedIssuesState: buildNextLinkedIssuesState(currentState.linkedIssuesState, {
        selectedIssues: [...(currentState.linkedIssuesState?.selectedIssues || []), issue],
        searchValue: '',
        searchLoading: false,
        searchResults: [],
        errorMessage: '',
        focusSearch: true,
      }),
    })).catch(() => {});
  }

  function selectLinkedIssueKeys(issueKeys) {
    const linkedState = popupState?.linkedIssuesState;
    if (!linkedState?.open) {
      return false;
    }
    const excludedKeys = new Set([
      String(popupState.issueData?.key || '').toUpperCase(),
      ...getLinkedIssueKeys(popupState.issueData),
      ...(linkedState.selectedIssues || []).map(issue => issue.key),
    ]);
    const nextIssues = (issueKeys || [])
      .filter(issueKey => !excludedKeys.has(issueKey))
      .map(issueKey => ({key: issueKey, summary: issueKey}));
    if (!nextIssues.length) {
      return false;
    }
    if (linkedIssuesSearchTimeoutId) {
      clearTimeout(linkedIssuesSearchTimeoutId);
      linkedIssuesSearchTimeoutId = null;
    }
    renderUpdatedPopupState(currentState => ({
      ...currentState,
      linkedIssuesState: buildNextLinkedIssuesState(currentState.linkedIssuesState, {
        selectedIssues: [...(currentState.linkedIssuesState?.selectedIssues || []), ...nextIssues],
        searchValue: '',
        searchLoading: false,
        searchRequestId: (currentState.linkedIssuesState?.searchRequestId || 0) + 1,
        searchResults: [],
        errorMessage: '',
        feedbackMessage: '',
        focusSearch: true,
      }),
    })).catch(() => {});
    return true;
  }

  function commitLinkedIssueInput(value, force = false) {
    const issueKeys = parseLinkedIssueKeys(value);
    const hasKeyDelimiter = /[,;\n]/.test(String(value || ''));
    if (!issueKeys.length || (!force && issueKeys.length < 2 && !hasKeyDelimiter)) {
      return false;
    }
    return selectLinkedIssueKeys(issueKeys);
  }

  function removeLinkedIssueToken(issueKey) {
    if (!popupState?.linkedIssuesState?.open) {
      return;
    }
    renderUpdatedPopupState(currentState => ({
      ...currentState,
      linkedIssuesState: buildNextLinkedIssuesState(currentState.linkedIssuesState, {
        selectedIssues: (currentState.linkedIssuesState?.selectedIssues || []).filter(issue => issue.key !== issueKey),
        focusSearch: true,
      }),
    })).catch(() => {});
  }

  async function refreshLinkedIssuesAfterMutation(stateChanges = {}) {
    const issueKey = popupState?.issueData?.key;
    if (!issueKey) {
      return;
    }
    await refreshPopupIssueState('', {mutation: {kind: 'linksChanged'}});
    if (!popupState?.issueData || popupState.issueData.key !== issueKey) {
      return;
    }
    const linkedSection = popupState.issueSnapshot?.sections?.linkedIssues;
    const issueDetailsByKey = linkedSection?.detailsByKey || {};
    await renderUpdatedPopupState(currentState => ({
      ...currentState,
      linkedIssuesState: buildNextLinkedIssuesState(currentState.linkedIssuesState, {
        loading: false,
        issueDetailsByKey,
        pendingAddKeys: [],
        pendingRemoveIds: [],
        confirmingRemoveId: '',
        focusSearch: false,
        ...stateChanges,
      }),
    }));
  }

  async function addSelectedLinkedIssues() {
    const linkedState = popupState?.linkedIssuesState;
    const issueKey = popupState?.issueData?.key;
    if (!issueKey || !linkedState?.open || !(linkedState.selectedIssues || []).length || linkedState.pendingAddKeys?.length) {
      return;
    }
    const relationship = buildRelationshipOptions(linkedState.linkTypes)
      .find(option => option.id === linkedState.relationshipId);
    if (!relationship) {
      return;
    }
    const selectedIssues = linkedState.selectedIssues.slice();
    const pendingAddKeys = selectedIssues.map(issue => issue.key);
    await renderUpdatedPopupState(currentState => ({
      ...currentState,
      linkedIssuesState: buildNextLinkedIssuesState(currentState.linkedIssuesState, {
        pendingAddKeys,
        errorMessage: '',
        feedbackMessage: '',
        focusSearch: false,
      }),
    }));

    const settled = await Promise.allSettled(selectedIssues.map(issue => {
      const payload = buildIssueLinkCreatePayload(issueKey, relationship, issue.key);
      return requestJson('POST', `${INSTANCE_URL}rest/api/2/issueLink`, payload);
    }));
    const succeeded = selectedIssues.filter((issue, index) => settled[index].status === 'fulfilled');
    const failed = selectedIssues.filter((issue, index) => settled[index].status === 'rejected');
    const firstFailure = settled.find(result => result.status === 'rejected');
    const feedbackMessage = succeeded.length
      ? `${succeeded.length} linked issue${succeeded.length === 1 ? '' : 's'} added.`
      : '';
    const errorMessage = failed.length
      ? `Could not link ${failed.map(issue => issue.key).join(', ')}. ${buildEditFieldError(firstFailure.reason)}`
      : '';
    if (succeeded.length) {
      await refreshLinkedIssuesAfterMutation({
        selectedIssues: failed,
        errorMessage,
        feedbackMessage,
      });
      return;
    }
    await renderUpdatedPopupState(currentState => ({
      ...currentState,
      linkedIssuesState: buildNextLinkedIssuesState(currentState.linkedIssuesState, {
        pendingAddKeys: [],
        errorMessage,
        feedbackMessage: '',
        focusSearch: true,
      }),
    }));
  }

  function setLinkedIssueRemoveConfirmation(linkId) {
    if (!popupState?.linkedIssuesState?.open) {
      return;
    }
    renderUpdatedPopupState(currentState => ({
      ...currentState,
      linkedIssuesState: buildNextLinkedIssuesState(currentState.linkedIssuesState, {
        confirmingRemoveId: linkId,
        errorMessage: '',
        feedbackMessage: '',
        focusSearch: false,
      }),
    })).catch(() => {});
  }

  async function confirmLinkedIssueRemoval(linkId) {
    const linkedState = popupState?.linkedIssuesState;
    if (!linkedState?.open || linkedState.pendingRemoveIds?.includes(linkId)) {
      return;
    }
    const link = (popupState.issueData?.fields?.issuelinks || []).find(candidate => String(candidate?.id || '') === linkId);
    const linkedIssueKey = String((link?.outwardIssue || link?.inwardIssue)?.key || 'linked issue');
    await renderUpdatedPopupState(currentState => ({
      ...currentState,
      linkedIssuesState: buildNextLinkedIssuesState(currentState.linkedIssuesState, {
        pendingRemoveIds: [...new Set([...(currentState.linkedIssuesState?.pendingRemoveIds || []), linkId])],
        confirmingRemoveId: '',
        errorMessage: '',
        feedbackMessage: '',
        focusSearch: false,
      }),
    }));
    try {
      await requestJson('DELETE', `${INSTANCE_URL}rest/api/2/issueLink/${encodeURIComponent(linkId)}`);
      await refreshLinkedIssuesAfterMutation({
        feedbackMessage: `Link to ${linkedIssueKey} removed.`,
        errorMessage: '',
      });
    } catch (error) {
      await renderUpdatedPopupState(currentState => ({
        ...currentState,
        linkedIssuesState: buildNextLinkedIssuesState(currentState.linkedIssuesState, {
          pendingRemoveIds: (currentState.linkedIssuesState?.pendingRemoveIds || []).filter(id => id !== linkId),
          errorMessage: buildEditFieldError(error),
          feedbackMessage: '',
          focusSearch: false,
        }),
      }));
    }
  }
  // ── Field Editing ─────────────────────────────────────────
  async function handleQuickAction(actionKey) {
    if (!popupState?.issueData || popupState.actionLoadingKey) {
      return;
    }
    const action = (popupState.quickActions || []).find(candidate => candidate.key === actionKey);
    if (!action) {
      return;
    }

    popupState = {
      ...popupState,
      actionLoadingKey: action.key,
      actionError: '',
      lastActionSuccess: '',
    };
    const closed = await popupSession.dispatch({type: 'close-actions'});
    if (closed.kind === 'ignored') await renderCurrentPopup('quick-action-started');

    try {
      const successMessage = await executeQuickAction(action, popupState.issueData);
      await refreshPopupIssueState(successMessage, {
        mutation: {kind: 'quickAction', action: action.key},
      });
    } catch (error) {
      await renderUpdatedPopupState(currentState => ({
        ...currentState,
        actionLoadingKey: '',
        actionError: buildQuickActionError(error),
        lastActionSuccess: '',
      }));
    }
  }
  function attachJiraFieldEditingToPopup() {
    if (!popupState?.issueSnapshot?.core) return false;
    const sessionId = currentPopupSessionId();
    if (!sessionId) return false;
    jiraFieldEditing.attach({
      sessionId,
      issueSnapshot: popupState.issueSnapshot,
      requirements: {
        children: showChildren,
        history: !!popupState.historyOpen,
        linkedIssues: !!popupState.linkedIssuesState?.open,
        pullRequests: showPullRequests,
        reactions: true,
        watchers: !!popupState.watchersState?.open,
      },
    });
    return true;
  }

  function isDeepFieldEdit(fieldKey) {
    return String(fieldKey || '').startsWith('customfield_') ||
      customFields.some(field => field.fieldId === fieldKey) ||
      ['assignee', 'environment', 'fixVersions', 'issuetype', 'labels', 'parentLink', 'priority', 'sprint', 'status', 'summary', 'versions'].includes(fieldKey);
  }

  async function dispatchJiraFieldEditing(intent) {
    const popupKey = popupState?.key || '';
    const pendingOutcome = jiraFieldEditing.dispatch(intent);
    if (popupState?.key === popupKey) await renderCurrentPopup('field-edit-pending');
    const fieldOutcome = await pendingOutcome;
    if (!popupState || popupState.key !== popupKey || fieldOutcome.sessionId !== currentPopupSessionId()) return fieldOutcome;
    if (fieldOutcome.refreshedSnapshot?.core) {
      const legacySnapshot = snapshotToLegacyPopupState(fieldOutcome.refreshedSnapshot);
      let quickActions = [];
      try {
        quickActions = await resolveQuickActions(legacySnapshot.issueData);
      } catch (error) {
        quickActions = [];
      }
      if (!popupState || popupState.key !== popupKey) return fieldOutcome;
      popupState = {
        ...popupState,
        issueSnapshot: legacySnapshot.issueSnapshot,
        issueData: legacySnapshot.issueData,
        children: legacySnapshot.children,
        childrenJql: legacySnapshot.childrenJql,
        childrenError: legacySnapshot.childrenError,
        pullRequests: legacySnapshot.pullRequests,
        commentReactionState: legacySnapshot.commentReactionState,
        quickActions,
        editState: null,
        actionError: '',
        lastActionSuccess: fieldOutcome.notice || '',
      };
      await renderCurrentPopup('field-edit-complete');
      if (fieldOutcome.notice) scheduleActionNoticeClear(fieldOutcome.notice);
      return fieldOutcome;
    }
    await renderCurrentPopup('field-edit-updated');
    return fieldOutcome;
  }

  async function runSearchOptionsForActiveEdit(fieldKey, queryText, requestId) {
    if (!popupState?.editState || popupState.editState.fieldKey !== fieldKey) {
      return;
    }
    try {
      const definition = await getEditableFieldDefinition(fieldKey, popupState.issueData);
      if (!definition?.searchOptions) {
        return;
      }
      const options = await definition.searchOptions(queryText);
      if (!popupState?.editState || popupState.editState.fieldKey !== fieldKey || popupState.editState.searchRequestId !== requestId) {
        return;
      }
      const mergedOptions = popupState.editState.editorType === 'user-search' || popupState.editState.editorType === 'issue-search' || popupState.editState.editorType === 'tempo-account-search'
        ? mergeEditOptions(options, popupState.editState.options)
        : options;
      popupState = {
        ...popupState,
        editState: {
          ...popupState.editState,
          options: mergedOptions,
          highlightedOptionId: null,
          loadingOptions: false,
          errorMessage: ''
        }
      };
      await renderIssuePopup(popupState);
    } catch (error) {
      if (!popupState?.editState || popupState.editState.fieldKey !== fieldKey || popupState.editState.searchRequestId !== requestId) {
        return;
      }
      popupState = {
        ...popupState,
        editState: {
          ...popupState.editState,
          loadingOptions: false,
          errorMessage: buildEditFieldError(error)
        }
      };
      await renderIssuePopup(popupState);
    }
  }

  const triggerSearchOptionsForActiveEdit = debounce((fieldKey, queryText, requestId) => {
    runSearchOptionsForActiveEdit(fieldKey, queryText, requestId).catch(() => {});
  }, 220);

  async function startFieldEdit(fieldKey) {
    if (!popupState?.issueData) {
      return;
    }
    if (isDeepFieldEdit(fieldKey)) {
      if (popupState.editState) {
        popupState = {...popupState, editState: null};
      }
      if (!attachJiraFieldEditingToPopup()) return;
      await dispatchJiraFieldEditing({
        type: 'begin',
        fieldId: fieldKey,
        configured: customFields.some(field => field.fieldId === fieldKey),
      });
      return;
    }
    if (jiraFieldEditing.view().edit) await dispatchJiraFieldEditing({type: 'cancel'});
    if (popupState.editState?.fieldKey === fieldKey) {
      return;
    }
    const definition = await getEditableFieldDefinition(fieldKey, popupState.issueData);
    if (!definition) {
      return;
    }
    const isMultiSelect = definition.selectionMode === 'multi';
    const initialValue = isMultiSelect
      ? (definition.initialInputValue ?? definition.currentText ?? '')
      : (definition.initialInputValue ?? '');
    const currentSelections = Array.isArray(definition.currentSelections) ? definition.currentSelections : [];
    popupState = {
      ...popupState,
      editState: {
        fieldKey,
        label: definition.label,
        editorType: definition.editorType || (isMultiSelect ? 'multi-select' : 'single-select'),
        selectionMode: definition.selectionMode || 'single',
        inputValue: initialValue,
        originalInputValue: initialValue,
        inputPlaceholder: definition.inputPlaceholder || `Type to filter ${definition.label.toLowerCase()} values`,
        options: [],
        selectedOptionId: isMultiSelect ? null : definition.currentOptionId,
        selectedOptionIds: isMultiSelect ? normalizeMultiSelectOptionIds(currentSelections.map(option => option.id)) : [],
        selectedOptions: isMultiSelect ? currentSelections : [],
        originalOptionIds: isMultiSelect ? normalizeMultiSelectOptionIds(currentSelections.map(option => option.id)) : [],
        hasChanges: false,
        loadingOptions: true,
        saving: false,
        errorMessage: '',
        showActionButtons: !!definition.showActionButtons,
        searchRequestId: 0,
        highlightedOptionId: null,
        selectionStart: initialValue.length,
        selectionEnd: initialValue.length
      }
    };
    await renderIssuePopup(popupState);

    try {
      const options = await definition.loadOptions();
      if (!popupState?.editState || popupState.editState.fieldKey !== fieldKey) {
        return;
      }
      if (popupState.editState.selectionMode === 'multi') {
        popupState = {
          ...popupState,
          editState: buildNextMultiSelectState(popupState.editState, {
            options,
            loadingOptions: false
          })
        };
      } else if (popupState.editState.selectionMode === 'text') {
        popupState = {
          ...popupState,
          editState: buildNextTextEditState(popupState.editState, {
            options,
            loadingOptions: false,
            selectionStart: popupState.editState.inputValue.length,
            selectionEnd: popupState.editState.inputValue.length
          })
        };
      } else {
        const nextInputValue = popupState.editState.inputValue || '';
        popupState = {
          ...popupState,
          editState: {
            ...popupState.editState,
            inputValue: nextInputValue,
            options,
            loadingOptions: false,
            selectionStart: nextInputValue.length,
            selectionEnd: nextInputValue.length
          }
        };
      }
      await renderIssuePopup(popupState);

      const shouldTriggerInitialSearch = popupState?.editState?.fieldKey === fieldKey &&
        (popupState.editState.editorType === 'user-search' || popupState.editState.editorType === 'issue-search' || popupState.editState.editorType === 'tempo-account-search') &&
        !(definition.skipInitialEmptySearch && !String(popupState.editState.inputValue || '').trim());
      if (shouldTriggerInitialSearch) {
        const searchRequestId = ++editSearchRequestCounter;
        popupState = {
          ...popupState,
          editState: {
            ...popupState.editState,
            loadingOptions: true,
            searchRequestId
          }
        };
        await renderIssuePopup(popupState);
        triggerSearchOptionsForActiveEdit(fieldKey, popupState.editState.inputValue, searchRequestId);
      }
    } catch (error) {
      const errorMessage = buildEditFieldError(error);
      if (!popupState?.editState || popupState.editState.fieldKey !== fieldKey) {
        return;
      }
      popupState = {
        ...popupState,
        editState: popupState.editState.selectionMode === 'multi'
          ? buildNextMultiSelectState(popupState.editState, {
              loadingOptions: false,
              errorMessage
            })
          : popupState.editState.selectionMode === 'text'
            ? buildNextTextEditState(popupState.editState, {
                loadingOptions: false,
                errorMessage
              })
          : {
              ...popupState.editState,
              loadingOptions: false,
              errorMessage
            }
      };
      await renderIssuePopup(popupState);
      snackBar(errorMessage);
    }
  }

  function cancelFieldEdit() {
    if (jiraFieldEditing.view().edit) {
      dispatchJiraFieldEditing({type: 'cancel'}).catch(() => {});
      return;
    }
    if (!popupState?.editState) {
      return;
    }
    popupState = {
      ...popupState,
      editState: null
    };
    renderIssuePopup(popupState).catch(() => {});
  }

  function updateFieldEditInput(nextValue, selectionStart, selectionEnd) {
    if (!popupState?.editState) {
      return;
    }
    const normalizedValue = String(nextValue || '');
    if (popupState.editState.selectionMode === 'multi') {
      popupState = {
        ...popupState,
        editState: buildNextMultiSelectState(popupState.editState, {
          inputValue: normalizedValue,
          highlightedOptionId: null,
          errorMessage: '',
          selectionStart,
          selectionEnd
        })
      };
      renderIssuePopup(popupState).catch(() => {});

      return;
    }
    if (popupState.editState.selectionMode === 'text') {
      popupState = {
        ...popupState,
        editState: buildNextTextEditState(popupState.editState, {
          inputValue: normalizedValue,
          errorMessage: '',
          selectionStart,
          selectionEnd
        })
      };
      renderIssuePopup(popupState).catch(() => {});
      return;
    }
    const exactOption = (popupState.editState.options || []).find(option => {
      return option.label.toLowerCase() === normalizedValue.trim().toLowerCase();
    });
    let nextInputValue = normalizedValue;
    let nextSelectionStart = selectionStart;
    let nextSelectionEnd = selectionEnd;
    let nextSelectedOptionId = exactOption ? exactOption.id : null;

    const canAutoComplete = popupState.editState.editorType !== 'user-search' &&
      popupState.editState.editorType !== 'issue-search' &&
      popupState.editState.editorType !== 'tempo-account-search' &&
      popupState.editState.editorType !== 'multi-select' &&
      typeof selectionStart === 'number' &&
      typeof selectionEnd === 'number' &&
      selectionStart === selectionEnd &&
      selectionEnd === normalizedValue.length &&
      normalizedValue.length > 0;

    if (canAutoComplete && !exactOption) {
      const prefixOption = (popupState.editState.options || []).find(option => {
        return option.label.toLowerCase().startsWith(normalizedValue.toLowerCase());
      });
      if (prefixOption) {
        nextInputValue = prefixOption.label;
        nextSelectedOptionId = prefixOption.id;
        nextSelectionStart = normalizedValue.length;
        nextSelectionEnd = prefixOption.label.length;
      }
    }

    popupState = {
      ...popupState,
      editState: {
        ...popupState.editState,
        inputValue: nextInputValue,
        selectedOptionId: nextSelectedOptionId,
        highlightedOptionId: null,
        errorMessage: '',
        selectionStart: nextSelectionStart,
        selectionEnd: nextSelectionEnd
      }
    };
    renderIssuePopup(popupState).catch(() => {});

    if (popupState.editState.editorType === 'user-search' || popupState.editState.editorType === 'issue-search' || popupState.editState.editorType === 'tempo-account-search') {
      const searchRequestId = ++editSearchRequestCounter;
      popupState = {
        ...popupState,
        editState: {
          ...popupState.editState,
          loadingOptions: true,
          searchRequestId
        }
      };
      renderIssuePopup(popupState).catch(() => {});
      triggerSearchOptionsForActiveEdit(popupState.editState.fieldKey, normalizedValue, searchRequestId);
    }
  }

  function getHighlightedFieldEditOption(editState) {
    if (!editState || editState.selectionMode === 'text') {
      return null;
    }
    const selectableOptions = filterEditOptions(editState.options, editState.inputValue)
      .filter(option => !option?.isGroupLabel);
    return selectableOptions.find(option => option.id === editState.highlightedOptionId) || selectableOptions[0] || null;
  }

  function moveFieldEditHighlight(fieldKey, direction) {
    if (!popupState?.editState || popupState.editState.fieldKey !== fieldKey || popupState.editState.selectionMode === 'text') {
      return false;
    }
    const selectableOptions = filterEditOptions(popupState.editState.options, popupState.editState.inputValue)
      .filter(option => !option?.isGroupLabel);
    if (!selectableOptions.length) {
      return false;
    }
    const currentOption = getHighlightedFieldEditOption(popupState.editState);
    const currentIndex = selectableOptions.findIndex(option => option.id === currentOption?.id);
    const nextIndex = currentIndex === -1
      ? (direction > 0 ? 0 : selectableOptions.length - 1)
      : Math.max(0, Math.min(selectableOptions.length - 1, currentIndex + direction));
    popupState = {
      ...popupState,
      editState: {
        ...popupState.editState,
        highlightedOptionId: selectableOptions[nextIndex].id,
        errorMessage: ''
      }
    };
    renderIssuePopup(popupState).catch(() => {});
    return true;
  }

  function selectFieldEditOption(optionId) {
    const fieldView = jiraFieldEditing.view().edit;
    if (fieldView && fieldView.options?.some(option => option.id === String(optionId || ''))) {
      dispatchJiraFieldEditing({type: 'selectOption', editId: fieldView.editId, optionId}).catch(() => {});
      return;
    }
    if (!popupState?.editState) {
      return;
    }
    const option = (popupState.editState.options || []).find(candidate => candidate.id === optionId);
    if (!option) {
      return;
    }
    if (popupState.editState.selectionMode === 'multi') {
      const selectedOptionIds = normalizeMultiSelectOptionIds(popupState.editState.selectedOptionIds);
      const nextSelectedOptionIds = selectedOptionIds.includes(option.id)
        ? selectedOptionIds.filter(candidateId => candidateId !== option.id)
        : [...selectedOptionIds, option.id];
      popupState = {
        ...popupState,
        editState: buildNextMultiSelectState(popupState.editState, {
          selectedOptionIds: nextSelectedOptionIds,
          highlightedOptionId: option.id,
          errorMessage: ''
        })
      };
      renderIssuePopup(popupState).catch(() => {});
      return;
    }
    popupState = {
      ...popupState,
      editState: {
        ...popupState.editState,
        inputValue: option.label,
        selectedOptionId: option.id,
        highlightedOptionId: option.id,
        loadingOptions: false,
        searchRequestId: ++editSearchRequestCounter,
        errorMessage: '',
        selectionStart: option.label.length,
        selectionEnd: option.label.length
      }
    };
    renderIssuePopup(popupState).catch(() => {});
  }


  function updateTimeTrackingEditState(changes = {}) {
    if (!popupState?.issueData) {
      return;
    }
    const currentState = popupState.timeTrackingEditState || createTimeTrackingEditState(popupState.issueData);
    popupState = {
      ...popupState,
      timeTrackingEditState: {
        ...currentState,
        ...changes
      }
    };
    renderIssuePopup(popupState).catch(() => {});
  }

  async function saveTimeTrackingEdit() {
    if (!popupState?.issueData) {
      return;
    }
    const issueData = popupState.issueData;
    const issueKey = issueData.key;
    const timeTrackingCapability = await getEditableFieldCapability(issueData, 'timetracking').catch(() => ({editable: false}));
    const currentState = popupState.timeTrackingEditState || createTimeTrackingEditState(issueData);
    const savePlan = buildTimeTrackingSavePlan(currentState, {
      canEditEstimates: !!timeTrackingCapability?.editable
    });
    if (!savePlan.hasChanges || currentState.saving) {
      return;
    }

    popupState = {
      ...popupState,
      timeTrackingEditState: {
        ...currentState,
        saving: true,
        errorMessage: ''
      }
    };
    await renderIssuePopup(popupState);

    const requestPlans = [];
    if (savePlan.hasEstimateChanges) {
      requestPlans.push({
        key: 'estimate',
        run: () => requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueKey}`, {
          fields: {
            timetracking: savePlan.estimateFields
          }
        })
      });
    }
    if (savePlan.hasWorklogChange) {
      requestPlans.push({
        key: 'worklog',
        run: () => requestJson('POST', `${INSTANCE_URL}rest/api/2/issue/${issueKey}/worklog?adjustEstimate=leave`, savePlan.worklogPayload)
      });
    }

    const settled = await Promise.all(requestPlans.map(plan => plan.run().then(
      value => ({key: plan.key, status: 'fulfilled', value}),
      reason => ({key: plan.key, status: 'rejected', reason})
    )));

    const result = {
      estimateSaved: settled.some(entry => entry.key === 'estimate' && entry.status === 'fulfilled'),
      worklogSaved: settled.some(entry => entry.key === 'worklog' && entry.status === 'fulfilled'),
      estimateError: settled.find(entry => entry.key === 'estimate' && entry.status === 'rejected')?.reason,
      worklogError: settled.find(entry => entry.key === 'worklog' && entry.status === 'rejected')?.reason
    };
    const errorMessage = buildTimeTrackingErrorMessage(result);
    const successMessage = buildTimeTrackingSuccessMessage(result);

    if (result.estimateSaved || result.worklogSaved) {
      try {
        const issueOutcome = await quickViewIssueData.refreshAfterMutation({
          issueKey,
          priorSnapshot: popupState.issueSnapshot,
          mutation: {kind: 'timeChanged'},
          requirements: {pullRequests: showPullRequests},
        });
        if (!issueOutcome.snapshot?.core) {
          throw issueDataError(issueOutcome.failures?.core, 'Could not refresh issue');
        }
        const refreshedIssueData = issueOutcome.snapshot.core;
        const pullRequestSection = issueOutcome.snapshot.sections?.pullRequests;
        const refreshedPullRequests = Array.isArray(pullRequestSection?.items) ? pullRequestSection.items : [];

        let quickActions = [];
        try {
          quickActions = await resolveQuickActions(refreshedIssueData);
        } catch (ex) {
          quickActions = [];
        }

        if (!popupState || popupState.key !== issueKey) {
          return;
        }

        const refreshedTimeTrackingValues = readTimeTrackingValues(refreshedIssueData);
        const refreshedTimeTrackingState = createTimeTrackingEditState(refreshedIssueData, {
          originalEstimateInput: result.estimateSaved ? refreshedTimeTrackingValues.originalEstimate : currentState.originalEstimateInput,
          remainingEstimateInput: result.estimateSaved ? refreshedTimeTrackingValues.remainingEstimate : currentState.remainingEstimateInput,
          worklogAmountInput: result.worklogSaved ? '' : currentState.worklogAmountInput,
          worklogDescriptionInput: result.worklogSaved ? '' : currentState.worklogDescriptionInput,
          worklogDateInput: result.worklogSaved ? getTodayDateInputValue() : currentState.worklogDateInput,
          saving: false,
          errorMessage
        });

        await renderUpdatedPopupState(currentPopupState => ({
          ...currentPopupState,
          issueSnapshot: issueOutcome.snapshot,
          issueData: refreshedIssueData,
          pullRequests: refreshedPullRequests,
          quickActions,
          ...buildPopupInteractionReset(),
          timeTrackingEditState: refreshedTimeTrackingState,
        }));

        if (successMessage) {
          snackBar(errorMessage ? `${successMessage}. ${errorMessage}` : successMessage);
        }
        return;
      } catch (refreshError) {
        popupState = {
          ...popupState,
          timeTrackingEditState: {
            ...currentState,
            saving: false,
            errorMessage: errorMessage || 'Saved changes but failed to refresh the popup'
          }
        };
        await renderIssuePopup(popupState);
        snackBar(successMessage ? `${successMessage}. Refresh failed.` : 'Saved changes but failed to refresh the popup');
        return;
      }
    }

    popupState = {
      ...popupState,
      timeTrackingEditState: {
        ...currentState,
        saving: false,
        errorMessage: errorMessage || 'Time tracking update failed'
      }
    };
    await renderIssuePopup(popupState);
    snackBar(errorMessage || 'Time tracking update failed');
  }
  new draggable({
    handle: '._JX_title, ._JX_status',
    cancel: 'a, button, input, textarea, img, ._JX_description, ._JX_comments, ._JX_comment_body, ._JX_description_text, ._JX_related_table, ._JX_history_flyout, ._JX_watchers_panel, ._JX_linked_issues_panel'
  }, container);
  
  // ── Clipboard & Copy ──────────────────────────────────────
  async function copyIssueReferenceWithFeedback(reference) {
    const result = await copyIssueReference(reference);
    snackBar(result === 'text' ? 'Copied as text' : 'Copied!');
  }

  // ── Event Handlers ────────────────────────────────────────
  $(document.body).on('click', '._JX_open_options', function (e) {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({action: 'openOptionsPage'});
  });

  $(document.body).on('click', '._JX_copy_link', function (e) {
    e.preventDefault();
    copyIssueReferenceWithFeedback({
      key: e.currentTarget.getAttribute('data-ticket') || '',
      summary: e.currentTarget.getAttribute('data-title') || '',
      url: e.currentTarget.getAttribute('data-url') || e.currentTarget.getAttribute('href') || '',
    }).catch(() => snackBar('There was an error!'));
  });

  $(document.body).on('click', '._JX_close_button', function (e) {
    e.preventDefault();
    e.stopPropagation();
    hideContainer();
    passiveCancel(200);
  });

  function pinContainer(options = {}) {
    const {showNotice = true} = options;
    if (containerPinned || !container.html()) {
      clearTimeout(hideTimeOut);
      return false;
    }
    const scrollingElement = document.scrollingElement || document.documentElement;
    if (showNotice) {
      snackBar('Ticket Pinned! Hit esc to close !');
    }
    container.addClass('container-pinned');
    const position = container.position();
    container.css({
      left: position.left - scrollingElement.scrollLeft,
      top: position.top - scrollingElement.scrollTop,
    });
    containerPinned = true;
    clearTimeout(hideTimeOut);
    return true;
  }

  $(document.body).on('click', '._JX_pin_button', function (e) {
    e.preventDefault();
    e.stopPropagation();
    pinContainer();
  });

  async function handlePopupPresentationIntent(intent) {
    if (intent.type === 'toggle-actions' || intent.type === 'sort-children' || intent.type === 'sort-pull-requests') {
      return popupSession.dispatch(intent);
    }
    if (intent.type === 'toggle-comment-sort') {
      const outcome = await popupSession.dispatch(intent);
      const nextCommentSortOrder = outcome.presentation?.commentSortOrder;
      if (!nextCommentSortOrder) return outcome;
      commentSortOrderPreference = nextCommentSortOrder;
      storageLocalSet({[COMMENT_SORT_ORDER_STORAGE_KEY]: nextCommentSortOrder}).catch(() => {});
      return outcome;
    }
    if (intent.type === 'toggle-watchers') {
      if (popupState?.watchersState?.open) return closeWatchersPanel();
      return openWatchersPanel();
    }
    if (intent.type === 'close-watchers') return closeWatchersPanel();
    if (intent.type === 'toggle-linkedIssues') {
      if (popupState?.linkedIssuesState?.open) return closeLinkedIssuesPanel();
      return openLinkedIssuesPanel();
    }
    if (intent.type === 'close-linkedIssues') return closeLinkedIssuesPanel();
    if (intent.type === 'toggle-history') return toggleHistoryFlyout();
    if (intent.type === 'close-history') return closeHistoryFlyout();
    return {kind: 'ignored', reason: 'unsupported-presentation-intent'};
  }

  const popupEvents = createBrowserPopupEvents({
    root: $(document.body),
    emit: handlePopupPresentationIntent,
  });
  popupEvents.install();

  $(document.body).on('click', '._JX_watchers_search_result', function (e) {
    e.preventDefault();
    e.stopPropagation();
    addWatcherFromPanel(e.currentTarget.getAttribute('data-watcher-id') || '').catch(() => {});
  });

  $(document.body).on('click', '._JX_watchers_remove', function (e) {
    if ($(e.currentTarget).closest('._JX_linked_issues_panel').length) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    removeWatcherFromPanel(e.currentTarget.getAttribute('data-watcher-id') || '').catch(() => {});
  });

  $(document.body).on('input', '._JX_watchers_search_input', function (e) {
    e.stopPropagation();
    updateWatchersSearch(e.currentTarget.value);
  });

  $(document.body).on('change', '._JX_linked_issues_type_select', function (e) {
    e.stopPropagation();
    renderUpdatedPopupState(currentState => ({
      ...currentState,
      linkedIssuesState: buildNextLinkedIssuesState(currentState.linkedIssuesState, {
        relationshipId: e.currentTarget.value,
        feedbackMessage: '',
        errorMessage: '',
        focusSearch: true,
      }),
    })).catch(() => {});
  });

  $(document.body).on('input', '._JX_linked_issues_search_input', function (e) {
    e.stopImmediatePropagation();
    if (commitLinkedIssueInput(e.currentTarget.value)) {
      return;
    }
    updateLinkedIssuesSearch(
      e.currentTarget.value,
      e.currentTarget.selectionStart,
      e.currentTarget.selectionEnd
    );
  });

  $(document.body).on('keydown', '._JX_linked_issues_search_input', function (e) {
    e.stopImmediatePropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      closeLinkedIssuesPanel();
      return;
    }
    if (e.key === 'Enter' && popupState?.linkedIssuesState?.searchResults?.length) {
      e.preventDefault();
      if (commitLinkedIssueInput(e.currentTarget.value, true)) {
        return;
      }
      selectLinkedIssueCandidate(popupState.linkedIssuesState.searchResults[0].key);
      return;
    }
    if (e.key === 'Enter' && commitLinkedIssueInput(e.currentTarget.value, true)) {
      e.preventDefault();
    }
  });

  $(document.body).on('click', '._JX_linked_issues_search_result', function (e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    selectLinkedIssueCandidate(e.currentTarget.getAttribute('data-issue-key') || '');
  });

  $(document.body).on('click', '._JX_linked_issues_token_remove', function (e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    removeLinkedIssueToken(e.currentTarget.getAttribute('data-issue-key') || '');
  });

  $(document.body).on('click', '._JX_linked_issues_add', function (e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    addSelectedLinkedIssues().catch(() => {});
  });

  $(document.body).on('click', '._JX_linked_issues_remove', function (e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    setLinkedIssueRemoveConfirmation(e.currentTarget.getAttribute('data-link-id') || '');
  });

  $(document.body).on('click', '._JX_linked_issues_remove_cancel', function (e) {
    e.preventDefault();
    e.stopPropagation();
    setLinkedIssueRemoveConfirmation('');
  });

  $(document.body).on('click', '._JX_linked_issues_remove_confirm', function (e) {
    e.preventDefault();
    e.stopPropagation();
    confirmLinkedIssueRemoval(e.currentTarget.getAttribute('data-link-id') || '').catch(() => {});
  });

  $(document.body).on('click', '._JX_action_item', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const actionKey = e.currentTarget.getAttribute('data-action-key');
    handleQuickAction(actionKey).catch(() => {});
  });

  $(document.body).on('click', function (e) {
    if (!popupState?.actionsOpen) {
      return;
    }
    if ($(e.target).closest('._JX_actions').length) {
      return;
    }
    popupSession.dispatch({type: 'close-actions'}).catch(() => {});
  });

    $(document.body).on('mousedown', function (e) {
      if (!popupState?.watchersState?.open) {
        return;
      }
      if ($(e.target).closest('._JX_watchers_group, ._JX_history_toggle, ._JX_linked_issues_group').length) {
        return;
      }
      closeWatchersPanel();
  });

  $(document.body).on('mousedown', function (e) {
    if (!popupState?.linkedIssuesState?.open) {
      return;
    }
    if ($(e.target).closest('._JX_linked_issues_group, ._JX_history_toggle, ._JX_watchers_group').length) {
      return;
    }
    closeLinkedIssuesPanel();
  });

  $(document.body).on('click', function (e) {
    if (!popupState?.historyOpen) {
      return;
    }
    if ($(e.target).closest('._JX_history_flyout').length || $(e.target).closest('._JX_history_toggle').length) {
      return;
    }
    closeHistoryFlyout();
  });

  $(document.body).on('click', function (e) {
    if (!container.html() || containerPinned) {
      return;
    }
    if ($(e.target).closest('._JX_container').length) {
      return;
    }
    hideContainer();
  });

  $(document.body).on('click', '._JX_field_chip_edit', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const fieldKey = e.currentTarget.getAttribute('data-field-key') || '';
    if (getActiveFieldEditState()?.fieldKey === fieldKey) {
      cancelFieldEdit();
      return;
    }
    startFieldEdit(fieldKey).catch(() => {});
  });

  $(document.body).on('click', '._JX_edit_cancel, ._JX_edit_discard', function (e) {
    if ($(e.currentTarget).closest('._JX_linked_issues_panel').length) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    cancelFieldEdit();
  });

  $(document.body).on('click', '._JX_edit_save', function (e) {
    if ($(e.currentTarget).closest('._JX_linked_issues_panel').length) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const fieldKey = e.currentTarget.getAttribute('data-field-key') || '';
    const fieldView = jiraFieldEditing.view().edit;
    if (fieldView?.fieldKey === fieldKey) {
      dispatchJiraFieldEditing({type: 'save', editId: fieldView.editId}).catch(() => {});
      return;
    }
    submitFieldEdit(fieldKey).catch(() => {});
  });

  $(document.body).on('click', '._JX_edit_option', function (e) {
    if ($(e.currentTarget).closest('._JX_linked_issues_panel').length) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    selectFieldEditOption(e.currentTarget.getAttribute('data-option-id'));
  });

  $(document.body).on('click', '._JX_edit_selected_remove', function (e) {
    if ($(e.currentTarget).closest('._JX_linked_issues_panel').length) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (popupState?.editState?.saving) {
      return;
    }
    selectFieldEditOption(e.currentTarget.getAttribute('data-option-id'));
  });

  $(document.body).on('input', '._JX_edit_input', function (e) {
    if ($(e.currentTarget).closest('._JX_linked_issues_panel').length) {
      return;
    }
    e.stopPropagation();
    const fieldKey = e.currentTarget.getAttribute('data-field-key') || '';
    const fieldView = jiraFieldEditing.view().edit;
    if (fieldView?.fieldKey === fieldKey) {
      dispatchJiraFieldEditing({
        type: 'inputChanged',
        editId: fieldView.editId,
        value: e.currentTarget.value,
        selection: {start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd},
      }).catch(() => {});
      return;
    }
    updateFieldEditInput(e.currentTarget.value, e.currentTarget.selectionStart, e.currentTarget.selectionEnd);
  });

  $(document.body).on('keydown', '._JX_edit_input', function (e) {
    if ($(e.currentTarget).closest('._JX_linked_issues_panel').length) {
      return;
    }
    e.stopPropagation();
    const fieldKey = e.currentTarget.getAttribute('data-field-key') || '';
    const fieldView = jiraFieldEditing.view().edit;
    if (fieldView?.fieldKey === fieldKey && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) {
      if (e.key === 'Enter' && fieldView.selectionMode === 'text' && fieldView.editorType === 'textarea' && !(e.ctrlKey || e.metaKey)) {
        return;
      }
      e.preventDefault();
      dispatchJiraFieldEditing({
        type: 'key',
        editId: fieldView.editId,
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
      }).catch(() => {});
      return;
    }
    const editState = popupState?.editState;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && editState?.fieldKey === fieldKey && editState.selectionMode !== 'text') {
      e.preventDefault();
      moveFieldEditHighlight(fieldKey, e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter') {
      if (editState?.fieldKey === fieldKey && editState.selectionMode === 'text' && editState.editorType === 'textarea' && !(e.ctrlKey || e.metaKey)) {
        return;
      }
      e.preventDefault();
      if (editState?.fieldKey === fieldKey && editState.selectionMode === 'multi') {
        if (e.ctrlKey || e.metaKey) {
          submitFieldEdit(fieldKey).catch(() => {});
        } else {
          toggleMultiSelectOptionFromInput(fieldKey, getHighlightedFieldEditOption(editState)?.id);
        }
      } else if (editState?.fieldKey === fieldKey && editState.selectionMode !== 'text') {
        const highlightedOption = getHighlightedFieldEditOption(editState);
        if (!highlightedOption) {
          submitFieldEdit(fieldKey).catch(() => {});
          return;
        }
        selectFieldEditOption(highlightedOption.id);
        submitFieldEdit(fieldKey).catch(() => {});
      } else {
        submitFieldEdit(fieldKey).catch(() => {});
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelFieldEdit();
    }
  });

  $(document.body).on('mousedown', function (e) {
    if (!getActiveFieldEditState()) {
      return;
    }
    if ($(e.target).closest('._JX_edit_popover, ._JX_field_chip_edit').length) {
      return;
    }
    if ($(e.target).closest('._JX_container').length === 0) {
      cancelFieldEdit();
      return;
    }
    if ($(e.target).closest('._JX_field_chip_editable_group').length === 0 && $(e.target).closest('._JX_edit_popover').length === 0 && $(e.target).closest('._JX_title_summary_slot').length === 0) {
      cancelFieldEdit();
    }
  });

  function renderCommentComposeLifecycleView({applyValue = false} = {}) {
    const composeView = commentLifecycle.view().compose;
    const elements = getCommentComposerElements();
    const inputElement = elements.input.get(0);
    if (!composeView || !inputElement) {
      renderCommentMentionSuggestions();
      return;
    }
    if (applyValue && inputElement.value !== composeView.value) {
      elements.input.val(composeView.value);
    }
    setCommentComposerError(composeView.errorMessage || '');
    if (applyValue) {
      inputElement.focus();
      inputElement.setSelectionRange(composeView.selection.start, composeView.selection.end);
    }
    renderCommentMentionSuggestions();
    syncCommentComposerState();
  }

  function syncCommentComposeLifecycle(inputElement) {
    const value = inputElement?.value || '';
    const selectionStart = typeof inputElement?.selectionStart === 'number' ? inputElement.selectionStart : value.length;
    const selectionEnd = typeof inputElement?.selectionEnd === 'number' ? inputElement.selectionEnd : value.length;
    const sessionId = currentPopupSessionId();
    const pending = commentLifecycle.dispatch({
      type: 'composeChanged',
      value,
      selection: {start: selectionStart, end: selectionEnd},
    });
    renderCommentComposeLifecycleView();
    pending.then(outcome => {
      if (outcome.sessionId === sessionId && sessionId === currentPopupSessionId()) {
        renderCommentComposeLifecycleView();
      }
    }).catch(() => {});
  }

  $(document.body).on('input', '._JX_comment_input', function () {
    syncCommentComposeLifecycle(this);
  });

  $(document.body).on('focusin', '._JX_comment_input', function () {
    commentLifecycle.dispatch({type: 'composeFocusChanged', focused: true}).catch(() => {});
    pinContainer({showNotice: false});
  });

  $(document.body).on('click select', '._JX_comment_input', function () {
    syncCommentComposeLifecycle(this);
  });

  $(document.body).on('keyup', '._JX_comment_input', function (e) {
    if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].indexOf(e.key) === -1) {
      syncCommentComposeLifecycle(this);
    }
  });

  $(document.body).on('scroll', '._JX_comment_input', function () {
    if (commentLifecycle.view().compose?.mention?.visible) {
      renderCommentMentionSuggestions();
    }
  });

  $(document.body).on('input', '._JX_comment_edit_input', function (e) {
    e.stopPropagation();
    const commentId = e.currentTarget.getAttribute('data-comment-id') || '';
    updateCommentEditDraft(
      commentId,
      e.currentTarget.value,
      e.currentTarget.selectionStart,
      e.currentTarget.selectionEnd
    );
  });

  $(document.body).on('paste', '._JX_comment_input', function (e) {
    const imageFiles = getClipboardImageFiles(e);
    if (!imageFiles.length || !commentLifecycle.view().issueKey) {
      return;
    }
    e.preventDefault();
    imageFiles.forEach(file => {
      const sessionId = currentPopupSessionId();
      const pending = commentLifecycle.dispatch({type: 'imagePasted', file});
      renderCommentComposeLifecycleView({applyValue: true});
      renderCommentUploads();
      pending.then(async outcome => {
        if (outcome.sessionId !== sessionId || sessionId !== currentPopupSessionId()) {
          return;
        }
        if (outcome.kind === 'attachmentUploaded' && outcome.uploadedAttachment) {
          await handleDraftAttachmentUploaded(outcome.uploadedAttachment);
        }
        renderCommentComposeLifecycleView({applyValue: true});
        renderCommentUploads();
      }).catch(() => {});
    });
  });

  $(document.body).on('click', '._JX_comment_upload_retry', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const localId = e.currentTarget.getAttribute('data-upload-id') || '';
    const sessionId = currentPopupSessionId();
    const pending = commentLifecycle.dispatch({type: 'retryUpload', localId});
    renderCommentComposeLifecycleView({applyValue: true});
    renderCommentUploads();
    pending.then(async outcome => {
      if (outcome.sessionId !== sessionId || sessionId !== currentPopupSessionId()) {
        return;
      }
      if (outcome.kind === 'attachmentUploaded' && outcome.uploadedAttachment) {
        await handleDraftAttachmentUploaded(outcome.uploadedAttachment);
      }
      renderCommentComposeLifecycleView({applyValue: true});
      renderCommentUploads();
    }).catch(() => {});
  });

  $(document.body).on('keydown', '._JX_comment_input', function (e) {
    const mentionView = commentLifecycle.view().compose?.mention;
    if (e.key === 'Escape' && mentionView?.visible) {
      e.preventDefault();
      commentLifecycle.dispatch({type: 'dismissMention', lane: 'compose'}).catch(() => {});
      renderCommentComposeLifecycleView();
      return;
    }

    if (!mentionView?.visible || !mentionView.suggestions.length) {
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      commentLifecycle.dispatch({type: 'moveMention', lane: 'compose', delta: 1}).catch(() => {});
      renderCommentComposeLifecycleView();
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      commentLifecycle.dispatch({type: 'moveMention', lane: 'compose', delta: -1}).catch(() => {});
      renderCommentComposeLifecycleView();
      return;
    }

    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      commentLifecycle.dispatch({type: 'chooseMention', lane: 'compose', index: mentionView.selectedIndex}).catch(() => {});
      renderCommentComposeLifecycleView({applyValue: true});
    }
  });

  $(document.body).on('mousedown', '._JX_comment_compose ._JX_comment_mention_option', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const index = Number(e.currentTarget.getAttribute('data-mention-index'));
    if (Number.isNaN(index)) {
      return;
    }
    commentLifecycle.dispatch({type: 'chooseMention', lane: 'compose', index}).catch(() => {});
    renderCommentComposeLifecycleView({applyValue: true});
  });

  $(document.body).on('mousedown', '._JX_comment_edit_mention_option', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const index = Number(e.currentTarget.getAttribute('data-mention-index'));
    if (Number.isNaN(index)) {
      return;
    }
    applyCommentEditMentionSelection(index);
  });

  $(document.body).on('mousedown', function (e) {
    if ($(e.target).closest('._JX_comment_compose').length) {
      return;
    }
    if (commentLifecycle.view().compose?.mention?.visible) {
      commentLifecycle.dispatch({type: 'dismissMention', lane: 'compose'}).catch(() => {});
      renderCommentComposeLifecycleView();
    }
  });

  $(document.body).on('mousedown', function (e) {
    if ($(e.target).closest('._JX_comment_editor').length) {
      return;
    }
    if (!commentLifecycle.view().rowAction?.mention?.visible) {
      return;
    }
    resetCommentEditMentionState();
    renderCurrentPopup('comment-edit-mention-dismissed').catch(() => {});
  });

  $(document.body).on('click', '._JX_comment_save', function (e) {
    e.preventDefault();
    handleCommentSave().catch(() => {});
  });

  $(document.body).on('click', '._JX_comment_discard', function (e) {
    e.preventDefault();
    handleCommentDiscard().catch(() => {});
  });

  $(document.body).on('click', '._JX_comment_reaction_button, ._JX_comment_reaction_pill', function (e) {
    e.preventDefault();
    const commentId = e.currentTarget.getAttribute('data-comment-id');
    const emojiId = e.currentTarget.getAttribute('data-emoji-id');
    handleCommentReactionClick(commentId, emojiId).catch(() => {});
  });

  $(document.body).on('toggle', '._JX_comment_reaction_dropdown', function (e) {
    if (!this.open) {
      return;
    }
    container.find('._JX_comment_reaction_dropdown[open]').each(function () {
      if (this !== e.currentTarget) {
        this.open = false;
      }
    });
  });

  $(document.body).on('click', '._JX_comment_edit_button', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const commentId = e.currentTarget.getAttribute('data-comment-id') || '';
    startCommentEdit(commentId);
  });

  $(document.body).on('click', '._JX_comment_delete_button', function (e) {
    e.preventDefault();
    e.stopPropagation();
    startCommentDeleteConfirm(e.currentTarget.getAttribute('data-comment-id') || '');
  });

  $(document.body).on('click', '._JX_comment_edit_cancel, ._JX_comment_delete_cancel', function (e) {
    e.preventDefault();
    e.stopPropagation();
    cancelCommentSession();
  });

  $(document.body).on('click', '._JX_comment_edit_save', function (e) {
    e.preventDefault();
    e.stopPropagation();
    saveCommentEdit(e.currentTarget.getAttribute('data-comment-id') || '').catch(() => {});
  });

  $(document.body).on('click', '._JX_comment_delete_confirm', function (e) {
    e.preventDefault();
    e.stopPropagation();
    confirmCommentDelete(e.currentTarget.getAttribute('data-comment-id') || '').catch(() => {});
  });

  $(document.body).on('keydown', '._JX_comment_edit_input', function (e) {
    e.stopPropagation();
    const commentId = e.currentTarget.getAttribute('data-comment-id') || '';
    const commentEditMentionState = commentLifecycle.view().rowAction?.mention;
    if (commentEditMentionState?.visible && commentLifecycle.view().rowAction?.commentId === commentId) {
      if (e.key === 'Escape') {
        e.preventDefault();
        resetCommentEditMentionState();
        renderCurrentPopup('comment-edit-mention-dismissed').catch(() => {});
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveCommentEditMentionSelection(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveCommentEditMentionSelection(-1);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applyCommentEditMentionSelection(commentEditMentionState.selectedIndex);
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelCommentSession();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      saveCommentEdit(commentId).catch(() => {});
    }
  });

  $(document.body).on('click keyup select', '._JX_comment_edit_input', function () {
    const commentId = this.getAttribute('data-comment-id') || '';
    const activeSession = getActiveCommentSession();
    if (!activeSession || activeSession.commentId !== commentId || activeSession.mode !== 'edit') {
      return;
    }
    commentLifecycle.dispatch({
      type: 'editChanged',
      commentId,
      value: this.value || '',
      selection: {
        start: typeof this.selectionStart === 'number' ? this.selectionStart : (this.value || '').length,
        end: typeof this.selectionEnd === 'number' ? this.selectionEnd : (this.value || '').length,
      },
    }).then(renderCommentEditMentionSuggestions).catch(() => {});
  });

  $(document.body).on('scroll', '._JX_comment_edit_input', function () {
    if (commentLifecycle.view().rowAction?.mention?.visible) {
      renderCommentEditMentionSuggestions();
    }
  });

  $(document.body).on('click', '._JX_description_edit_button', function (e) {
    e.preventDefault();
    e.stopPropagation();
    startDescriptionEdit();
  });

  $(document.body).on('click', '._JX_description_cancel', function (e) {
    e.preventDefault();
    e.stopPropagation();
    cancelDescriptionEdit().catch(() => {});
  });

  $(document.body).on('click', '._JX_description_save', function (e) {
    e.preventDefault();
    e.stopPropagation();
    saveDescriptionEdit().catch(() => {});
  });

  $(document.body).on('input', '._JX_description_input', function (e) {
    e.stopPropagation();
    updateDescriptionDraft(
      e.currentTarget.value,
      e.currentTarget.selectionStart,
      e.currentTarget.selectionEnd
    );
  });

  $(document.body).on('click keyup select', '._JX_description_input', function () {
    const currentState = getDescriptionEditState();
    if (!currentState.open) {
      return;
    }
    setDescriptionEditState({
      ...currentState,
      hadFocus: true,
      selectionStart: typeof this.selectionStart === 'number' ? this.selectionStart : (this.value || '').length,
      selectionEnd: typeof this.selectionEnd === 'number' ? this.selectionEnd : (this.value || '').length,
    });
  });

  $(document.body).on('keydown', '._JX_description_input', function (e) {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelDescriptionEdit().catch(() => {});
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      saveDescriptionEdit().catch(() => {});
    }
  });

  $(document.body).on('paste', '._JX_description_input', function (e) {
    const imageFiles = getClipboardImageFiles(e);
    if (!imageFiles.length || !popupState?.issueData?.key || !popupState?.descriptionEditState?.open) {
      return;
    }
    e.preventDefault();
    imageFiles.forEach(file => {
      uploadDescriptionImage(file).catch(() => {});
    });
  });

  $(document.body).on('mousedown', '._JX_description_toolbar_button', function (e) {
    e.preventDefault();
    e.stopPropagation();
    applyDescriptionFormatting(e.currentTarget.getAttribute('data-description-format'));
  });

  $(document.body).on('input', '._JX_time_tracking_input', function (e) {
    e.stopPropagation();
    const fieldKey = e.currentTarget.getAttribute('data-time-tracking-field') || '';
    if (!fieldKey) {
      return;
    }
    updateTimeTrackingEditState({
      [fieldKey]: e.currentTarget.value,
      activeInputField: fieldKey,
      selectionStart: e.currentTarget.selectionStart,
      selectionEnd: e.currentTarget.selectionEnd,
      errorMessage: ''
    });
  });

  $(document.body).on('click', '._JX_time_tracking_save', function (e) {
    e.preventDefault();
    e.stopPropagation();
    saveTimeTrackingEdit().catch(() => {});
  });

  // ── Image Preview ─────────────────────────────────────────
  function closePreviewOverlay() {
    if (!contentShellHelpers) {
      return;
    }
    contentShellHelpers.closePreviewOverlay();
  }

  async function openPreviewOverlay(imageUrl) {
    if (!contentShellHelpers) {
      return;
    }
    await contentShellHelpers.openPreviewOverlay(imageUrl);
  }

  previewOverlay.on('click', function (e) {
    e.stopPropagation();
    if (e.target === previewOverlay[0]) {
      e.preventDefault();
      closePreviewOverlay();
    }
  });

  $(document.body).on('click', '._JX_previewable', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const source = e.currentTarget.getAttribute('data-jx-preview-src') || e.currentTarget.getAttribute('src');
    openPreviewOverlay(source).catch(() => {});
  });

  $(document.body).on('click', '._JX_thumb', function (e) {
    if ($(e.target).closest('img._JX_previewable').length) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const source = e.currentTarget.getAttribute('data-preview-src') || e.currentTarget.getAttribute('data-url');
    openPreviewOverlay(source).catch(() => {});
  });

  $(document.body).on('click', '._JX_history_attachment_preview', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const source = e.currentTarget.getAttribute('data-jx-preview-src');
    openPreviewOverlay(source).catch(() => {});
  });

  // ── Container Lifecycle ────────────────────────────────────
  function clearPopupSurface() {
    lastHoveredKey = '';
    clearWatchersFeedbackTimer();
    clearDescriptionStatusTimer();
    closePreviewOverlay();
    const descriptionStateSnapshot = popupState?.descriptionEditState;
    popupState = null;
    discardCommentComposerDraft().catch(() => {});
    discardDescriptionEditStateSnapshot(descriptionStateSnapshot, {deleteUploaded: true}).catch(() => {});
    containerPinned = false;
    container.html('').css({
      left: -5000,
      top: -5000,
      position: 'absolute',
    }).removeClass('container-pinned');

    passiveCancel(0);
  }

  function hideContainer(reason = 'explicit') {
    popupSession.close({reason}).catch(() => {
      clearPopupSurface();
    });
  }

  $(document.body).on('keydown', function (e) {
    // TODO: escape not captured in google docs
    const ESCAPE_KEY_CODE = 27;
    if (e.keyCode === ESCAPE_KEY_CODE) {
      if (previewOverlay.hasClass('is-open')) {
        closePreviewOverlay();
        return;
      }
      if (popupState?.historyOpen) {
        closeHistoryFlyout();
        return;
      }
      if (popupState?.descriptionEditState?.open) {
        cancelDescriptionEdit().catch(() => {});
        return;
      }
      hideContainer();
      passiveCancel(200);
    }
  });

  // ── Hover Detection & Script Bootstrap ─────────────────────
  let hoverCooldownActive = false;
  let hoverCooldownTimeoutId = null;

  function passiveCancel(cooldown) {
    hoverCooldownActive = true;
    clearTimeout(hoverCooldownTimeoutId);
    hoverCooldownTimeoutId = setTimeout(function () {
      hoverCooldownActive = false;
    }, cooldown);
  }

  container.on('dragstop', () => {
    pinContainer();
  });
  function extractKeysFromNode(node) {
    let keys = getJiraKeysFromTexts(getNodeSearchTexts(node));
    if (!size(keys) && node.children.length < 10) {
      const fullText = normalizeSearchText(node.textContent || '');
      if (fullText.length < 200) {
        keys = getJiraKeys(fullText);
      }
    }
    return keys;
  }

  function detectJiraKeysAtPoint(element) {
    let keys = extractKeysFromNode(element);
    if (!size(keys) && element.parentElement && element.parentElement.href) {
      keys = getJiraKeys(getRelativeHref(element.parentElement.href));
    }
    if (hoverDepth === 'exact') {
      return keys;
    }
    const maxAncestors = hoverDepth === 'deep' ? 5 : 1;
    if (!size(keys)) {
      let ancestor = element.parentElement;
      for (let i = 0; i < maxAncestors && ancestor && !size(keys); i++) {
        if (ancestor === document.body) break;
        keys = getJiraKeysFromTexts(getNodeSearchTexts(ancestor));
        if (!size(keys) && ancestor.children.length < 20) {
          const ancestorText = normalizeSearchText(ancestor.textContent || '');
          if (ancestorText.length < 300) {
            keys = getJiraKeys(ancestorText);
          }
        }
        ancestor = ancestor.parentElement;
      }
    }
    return keys;
  }

  function detectLayeredJiraKeysFromPoint(clientX, clientY) {
    if (!isEditorOverlaySite() || typeof document.elementsFromPoint !== 'function') {
      return [];
    }

    const elementsAtPoint = document.elementsFromPoint(clientX, clientY).filter(Boolean);

    for (const element of elementsAtPoint) {
      if (!element || element === container[0] || $.contains(container[0], element)) {
        continue;
      }

      const keys = detectJiraKeysAtPoint(element);
      if (size(keys)) {
        return keys;
      }
    }

    return [];
  }

  let currentPointer = {
    clientX: Number.NaN,
    clientY: Number.NaN,
    pageX: Number.NaN,
    pageY: Number.NaN,
  };

  document.addEventListener('mousemove', function (e) {
    currentPointer = {
      clientX: e.clientX,
      clientY: e.clientY,
      pageX: e.pageX,
      pageY: e.pageY,
    };
  }, {passive: true});

  function isTypingTarget(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }
    if (node.matches('input, textarea, select')) {
      return true;
    }
    if (node.closest('input, textarea, select, [role="textbox"]')) {
      return true;
    }
    if (node.isContentEditable) {
      return true;
    }
    const editableAncestor = node.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
    return !!editableAncestor;
  }

  function isModifierSatisfied(e) {
    if (hoverModifierKey === 'alt') return e.altKey;
    if (hoverModifierKey === 'ctrl') return e.ctrlKey;
    if (hoverModifierKey === 'shift') return e.shiftKey;
    if (hoverModifierKey === 'any') return e.altKey || e.ctrlKey || e.shiftKey;
    return true;
  }

  function getUniqueResolvedKeys(keys) {
    return Array.from(new Set((Array.isArray(keys) ? keys : [])
      .map(key => String(key || '').replace(' ', '-').trim())
      .filter(Boolean)));
  }

  function getSingleResolvedKey(keys) {
    const uniqueKeys = getUniqueResolvedKeys(keys);
    return uniqueKeys.length === 1 ? uniqueKeys[0] : '';
  }

  function getKeyMatches(text) {
    return Array.from(String(text || '').matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/g)).map(match => ({
      key: match[0].replace(' ', '-'),
      start: match.index || 0,
      end: (match.index || 0) + match[0].length,
    }));
  }

  function getKeyAtTextOffset(text, offset) {
    if (!Number.isFinite(offset)) {
      return '';
    }
    const matches = getKeyMatches(text);
    const directMatch = matches.find(match => offset >= match.start && offset <= match.end);
    return directMatch ? directMatch.key : '';
  }

  function getVisibleKeyInTextNodeAtPoint(textNode, clientX, clientY) {
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
      return '';
    }

    const matches = getKeyMatches(textNode.textContent || '');
    for (const match of matches) {
      try {
        const range = document.createRange();
        range.setStart(textNode, match.start);
        range.setEnd(textNode, match.end);
        const rects = Array.from(range.getClientRects ? range.getClientRects() : []);
        if (rects.some(rect => isPointInsideRect(clientX, clientY, rect, 0))) {
          return match.key;
        }
      } catch (error) {
        // Ignore transient DOM/range failures while the host page updates.
      }
    }

    return '';
  }

  function getPreciseKeyAtClientPoint(clientX, clientY) {
    let pointNode = null;
    let pointOffset = null;

    if (typeof document.caretPositionFromPoint === 'function') {
      const caretPosition = document.caretPositionFromPoint(clientX, clientY);
      pointNode = caretPosition?.offsetNode || null;
      pointOffset = caretPosition?.offset ?? null;
    } else if (typeof document.caretRangeFromPoint === 'function') {
      const caretRange = document.caretRangeFromPoint(clientX, clientY);
      pointNode = caretRange?.startContainer || null;
      pointOffset = caretRange?.startOffset ?? null;
    }

    if (pointNode?.nodeType === Node.TEXT_NODE) {
      return getVisibleKeyInTextNodeAtPoint(pointNode, clientX, clientY);
    }

    return '';
  }

  function isPointInsideRect(clientX, clientY, rect, padding = 0) {
    if (!rect) {
      return false;
    }
    return clientX >= rect.left - padding && clientX <= rect.right + padding &&
      clientY >= rect.top - padding && clientY <= rect.bottom + padding;
  }

  function findVisibleKeyInElementAtPoint(rootElement, clientX, clientY) {
    if (!rootElement || rootElement.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const walker = document.createTreeWalker(rootElement, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return /\b[A-Z][A-Z0-9]+-\d+\b/.test(node.textContent || '')
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      }
    });

    let textNode = walker.nextNode();
    while (textNode) {
      const matches = getKeyMatches(textNode.textContent || '');
      for (const match of matches) {
        try {
          const range = document.createRange();
          range.setStart(textNode, match.start);
          range.setEnd(textNode, match.end);
          const rects = Array.from(range.getClientRects ? range.getClientRects() : []);
          if (rects.some(rect => isPointInsideRect(clientX, clientY, rect, 1))) {
            return match.key;
          }
        } catch (error) {
          // Ignore transient DOM/range failures while the host page updates.
        }
      }
      textNode = walker.nextNode();
    }

    return '';
  }

  function getStrictKeyAtClientPoint(clientX, clientY) {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      return '';
    }

    const preciseKey = getPreciseKeyAtClientPoint(clientX, clientY);
    if (preciseKey) {
      return preciseKey;
    }

    if (!isOfficeOverlaySite() && typeof document.elementsFromPoint === 'function') {
      const layeredElements = document.elementsFromPoint(clientX, clientY).filter(Boolean);
      for (const layeredElement of layeredElements) {
        if (!layeredElement || layeredElement === container[0] || $.contains(container[0], layeredElement)) {
          continue;
        }
        const layeredKey = findVisibleKeyInElementAtPoint(layeredElement, clientX, clientY);
        if (layeredKey) {
          return layeredKey;
        }
      }
      return '';
    }

    const element = document.elementFromPoint(clientX, clientY);
    if (!element || element === container[0] || $.contains(container[0], element)) {
      return '';
    }
    return findVisibleKeyInElementAtPoint(element, clientX, clientY);
  }

  function resolveKeyAtClientPoint(clientX, clientY) {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      return '';
    }
    const element = document.elementFromPoint(clientX, clientY);
    if (!element) {
      return '';
    }
    let keys = detectJiraKeysAtPoint(element);
    if (!size(keys)) {
      keys = detectLayeredJiraKeysFromPoint(clientX, clientY);
    }
    return size(keys) ? keys[0].replace(' ', '-') : '';
  }

  function resolveModifierKeyAtClientPoint(clientX, clientY) {
    const strictKey = getStrictKeyAtClientPoint(clientX, clientY);
    if (strictKey) {
      return strictKey;
    }
    return resolveKeyAtClientPoint(clientX, clientY);
  }

  function isTypingTargetBlockingModifierTrigger(clientX, clientY) {
    const activeElement = document.activeElement;
    if (!isTypingTarget(activeElement)) {
      return false;
    }
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      return true;
    }
    const hoveredElement = document.elementFromPoint(clientX, clientY);
    if (!hoveredElement) {
      return true;
    }
    return hoveredElement === activeElement || activeElement.contains(hoveredElement);
  }

  function fetchAndShowPopup(key, pointerX, pointerY) {
    if (popupState?.key && popupState.key !== key && popupState.descriptionEditState?.open) {
      clearDescriptionStatusTimer();
      discardDescriptionEditStateSnapshot(popupState.descriptionEditState, {deleteUploaded: true}).catch(() => {});
    }
    popupSession.activate({
      issueKey: key,
      anchor: {x: pointerX, y: pointerY},
      activation: hoverModifierKey === 'none' ? 'hover' : 'modifier',
      preferences: {commentSortOrder: commentSortOrderPreference},
      requirements: {
        children: showChildren,
        pullRequests: showPullRequests,
        reactions: true,
        viewer: true,
      },
    }).catch(error => {
      notifyJiraConnectionFailure(INSTANCE_URL, error);
      lastHoveredKey = '';
    });
  }

  function triggerPopupForKey(key, pointerX, pointerY, immediate) {
    clearTimeout(hoverDelayTimeout);
    lastHoveredKey = key;
    if (immediate) {
      fetchAndShowPopup(key, pointerX, pointerY);
    } else {
      hoverDelayTimeout = setTimeout(function () {
        fetchAndShowPopup(key, pointerX, pointerY);
      }, 250);
    }
  }

  if (hoverModifierKey !== 'none') {
    document.addEventListener('keydown', function (e) {
      if (containerPinned || isTypingTargetBlockingModifierTrigger(currentPointer.clientX, currentPointer.clientY)) {
        return;
      }
      if (isModifierSatisfied(e)) {
        const currentKey = resolveModifierKeyAtClientPoint(currentPointer.clientX, currentPointer.clientY);
        if (currentKey) {
          const pointerX = Number.isFinite(currentPointer.pageX) ? currentPointer.pageX : 0;
          const pointerY = Number.isFinite(currentPointer.pageY) ? currentPointer.pageY : 0;
          triggerPopupForKey(currentKey, pointerX, pointerY, true);
        }
      }
    });
  }

  $(document.body).on('mousemove', debounce(function (e) {
    if (e.buttons || hoverCooldownActive) {
      return;
    }
    currentPointer = {
      clientX: e.clientX,
      clientY: e.clientY,
      pageX: e.pageX,
      pageY: e.pageY,
    };
    if (previewOverlay.hasClass('is-open')) {
      clearTimeout(hideTimeOut);
      return;
    }
    const element = document.elementFromPoint(e.clientX, e.clientY);
    const isOverContainer = element === container[0] || $.contains(container[0], element);
    let isInPaddedZone = false;
    if (!isOverContainer && container.html()) {
      const rect = container[0].getBoundingClientRect();
      const margin = 40;
      isInPaddedZone = e.clientX >= rect.left - margin && e.clientX <= rect.right + margin &&
          e.clientY >= rect.top - margin && e.clientY <= rect.bottom + margin;
    }
    if (isOverContainer) {
      showTip('tooltip_drag', 'Tip: You can pin the tooltip by dragging the title !');
      return;
    }
    if (isInPaddedZone) {
      clearTimeout(hideTimeOut);
      return;
    }
    if (!containerPinned && container.html()) {
      clearTimeout(hoverDelayTimeout);
      lastHoveredKey = '';
      hideTimeOut = setTimeout(hideContainer, 250);
      return;
    }
    if (element) {
      if (hoverModifierKey !== 'none') {
        const resolvedKey = resolveModifierKeyAtClientPoint(e.clientX, e.clientY);
        if (!resolvedKey) {
          return;
        }
        if (!isModifierSatisfied(e)) {
          clearTimeout(hideTimeOut);
          return;
        }
        clearTimeout(hideTimeOut);
        triggerPopupForKey(resolvedKey, e.pageX, e.pageY, true);
        return;
      }

      let keys = detectJiraKeysAtPoint(element);
      if (!size(keys)) {
        keys = detectLayeredJiraKeysFromPoint(e.clientX, e.clientY);
      }

      if (size(keys)) {
        const key = keys[0].replace(' ', '-');
        clearTimeout(hideTimeOut);
        triggerPopupForKey(key, e.pageX, e.pageY, false);
      }
    }
  }, 100));
}

if (!window.__JX__script_injected__) {
  waitForDocument(mainAsyncLocal);
}

window.__JX__script_injected__ = true;
