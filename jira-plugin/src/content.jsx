/*global chrome */
import size from 'lodash/size';
import debounce from 'lodash/debounce';
import regexEscape from 'escape-string-regexp';
import Mustache from 'mustache';
import {waitForDocument} from 'src/utils';
import {sendMessage, storageGet, storageSet, storageLocalGet, storageLocalSet} from 'src/chrome';
import {snackBar} from 'src/snack';
import {createContentAttachmentHelpers} from 'src/content-attachment-helpers';
import {createContentFieldCapabilityHelpers} from 'src/content-field-capability-helpers';
import {createContentHistoryHelpers} from 'src/content-history-helpers';
import {createContentIssueDataHelpers} from 'src/content-issue-data-helpers';
import {createContentIssueLinkageHelpers} from 'src/content-issue-linkage-helpers';
import {createContentDisplayHelpers} from 'src/content-display-helpers';
import {createContentPeopleHelpers} from 'src/content-people-helpers';
import {createContentPopupStateHelpers} from 'src/content-popup-state-helpers';
import {createContentShellHelpers} from 'src/content-shell-helpers';
import {MENTION_CONTEXT_WINDOW} from 'src/comment-mention-constants';
import {createContentCommentHelpers} from 'src/content-comment-helpers';
import {positionMentionMenuAtCaret} from 'src/mention-menu-positioning';
import {createPopupEditing} from 'src/popup-editing';
import {createPopupQuickActions} from 'src/popup-quick-actions';
import {createPopupCommentComposer} from 'src/popup-comment-composer';
import {buildJiraSearchRequestUrls, isEpicLinkField, isParentLinkField, isSprintField} from 'src/jira-issue-helpers';
import config from 'options/config.js';
import {DEFAULT_THEME_MODE, syncDocumentTheme} from 'src/theme';
const {
  buildDescriptionEditorState,
  buildMediaSingleNodeFromAttachment,
  buildDescriptionSaveFieldValue,
  isRichTextDescriptionDocument,
} = require('src/description-rich-text');

waitForDocument(() => require('src/content.scss'));

// ── Config ──────────────────────────────────────────────────────

const getInstanceUrl = async () => (await storageGet({
  instanceUrl: config.instanceUrl
})).instanceUrl;

const getConfig = async () => (await storageGet(config));

// ── Field ID Resolution ─────────────────────────────────────────

let allFieldsPromise;

function getAllFields(instanceUrl) {
  if (!allFieldsPromise) {
    allFieldsPromise = get(instanceUrl + 'rest/api/2/field')
      .then(fields => (Array.isArray(fields) ? fields : []))
      .catch(() => []);
  }
  return allFieldsPromise;
}

function getFieldIdsByFilter(instanceUrl, filterFn) {
  return getAllFields(instanceUrl).then(fields => fields.filter(filterFn).map(field => field.id));
}

function getSprintFieldIds(instanceUrl) {
  return getFieldIdsByFilter(instanceUrl, isSprintField);
}

function getEpicLinkFieldIds(instanceUrl) {
  return getFieldIdsByFilter(instanceUrl, isEpicLinkField);
}

function getParentLinkFieldIds(instanceUrl) {
  return getFieldIdsByFilter(instanceUrl, isParentLinkField);
}

const DEFAULT_CHILDREN_SORT = Object.freeze({
  column: 'key',
  direction: 'asc'
});

const DEFAULT_PULL_REQUESTS_SORT = Object.freeze({
  column: 'title',
  direction: 'asc'
});

const DEFAULT_COMMENT_SORT_ORDER = 'oldest';
const COMMENT_SORT_ORDER_STORAGE_KEY = 'jqv.commentSortOrder';

function normalizeChildrenSort(sort) {
  const column = ['type', 'key', 'status', 'assignee'].includes(sort?.column)
    ? sort.column
    : DEFAULT_CHILDREN_SORT.column;
  const direction = sort?.direction === 'desc'
    ? 'desc'
    : DEFAULT_CHILDREN_SORT.direction;
  return {column, direction};
}

function toggleChildrenSort(sort, column) {
  const currentSort = normalizeChildrenSort(sort);
  if (currentSort.column === column) {
    return {
      column,
      direction: currentSort.direction === 'asc' ? 'desc' : 'asc'
    };
  }
  return {
    column,
    direction: 'asc'
  };
}

function normalizePullRequestsSort(sort) {
  const column = ['title', 'author', 'branch', 'status'].includes(sort?.column)
    ? sort.column
    : DEFAULT_PULL_REQUESTS_SORT.column;
  const direction = sort?.direction === 'desc'
    ? 'desc'
    : DEFAULT_PULL_REQUESTS_SORT.direction;
  return {column, direction};
}

function togglePullRequestsSort(sort, column) {
  const currentSort = normalizePullRequestsSort(sort);
  if (currentSort.column === column) {
    return {
      column,
      direction: currentSort.direction === 'asc' ? 'desc' : 'asc'
    };
  }
  return {
    column,
    direction: 'asc'
  };
}

function normalizeCommentSortOrder(sortOrder) {
  return sortOrder === 'newest'
    ? 'newest'
    : DEFAULT_COMMENT_SORT_ORDER;
}

function toggleCommentSortOrder(sortOrder) {
  return normalizeCommentSortOrder(sortOrder) === 'newest'
    ? 'oldest'
    : 'newest';
}

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
  const COMMENT_REACTION_OPTIONS = [
  {emoji: '👍', emojiId: '1f44d', label: 'thumbs up'},
  {emoji: '👎', emojiId: '1f44e', label: 'thumbs down'},
  {emoji: '🔥', emojiId: '1f525', label: 'fire'},
  {emoji: '😍', emojiId: '1f60d', label: 'heart eyes'},
  {emoji: '😂', emojiId: '1f602', label: 'joy'},
  {emoji: '😢', emojiId: '1f622', label: 'cry'}
];

function emptyCommentReactionState() {
  return {
    byCommentId: {},
    supported: true
  };
}

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

// ── Network / API ───────────────────────────────────────────────

function unwrapResponse(response, defaultError = 'Request failed') {
  if (Object.prototype.hasOwnProperty.call(response, 'result')) {
    return response.result;
  }
  const err = new Error(response.error || defaultError);
  err.inner = response.error;
  throw err;
}

async function get(url) {
  return unwrapResponse(await sendMessage({action: 'get', url: url}));
}

  async function getImageDataUrl(url, mimeType = '') {
    return unwrapResponse(await sendMessage({action: 'getImageDataUrl', url, mimeType}));
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
  return unwrapResponse(await sendMessage({action: 'requestJson', method, url, body, headers}));
}
async function uploadAttachment(url, file) {
  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
  const response = await sendMessage({
    action: 'uploadAttachment',
    bytes,
    contentType: file.type,
    fileName: file.name,
    url
  });
  return unwrapResponse(response, 'Attachment upload failed');
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

  const config = await getConfig();
  const INSTANCE_URL = config.instanceUrl;
  const storedCommentSortState = await storageLocalGet({
    [COMMENT_SORT_ORDER_STORAGE_KEY]: DEFAULT_COMMENT_SORT_ORDER
  }).catch(() => ({
    [COMMENT_SORT_ORDER_STORAGE_KEY]: DEFAULT_COMMENT_SORT_ORDER
  }));
  let commentSortOrderPreference = normalizeCommentSortOrder(
    storedCommentSortState[COMMENT_SORT_ORDER_STORAGE_KEY]
  );
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
  const tooltipLayout = config.tooltipLayout || {
    row1: ['issueType', 'status', 'priority'],
    row2: ['epicParent', 'sprint', 'affects', 'fixVersions'],
    row3: ['environment', 'labels'],
    contentBlocks: ['description', 'timeTracking', 'children', 'pullRequests', 'comments'],
    people: ['reporter', 'assignee']
  };
  const defaultContentBlocks = ['description', 'timeTracking', 'children', 'pullRequests', 'comments'];
  const layoutContentBlocks = (tooltipLayout.contentBlocks || defaultContentBlocks)
    .filter(k => displayFields[k] !== false);
  if (displayFields.description !== false && !layoutContentBlocks.includes('description')) {
    layoutContentBlocks.unshift('description');
  }
  const showChildren = layoutContentBlocks.includes('children');
  const showPullRequests = layoutContentBlocks.includes('pullRequests');
  const hoverDepth = config.hoverDepth || 'exact';
  const hoverModifierKey = config.hoverModifierKey || 'any';
  const customFields = normalizeCustomFields(config.customFields, tooltipLayout);
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
  const imageProxyCache = {};
  const cacheTtlMs = 60 * 1000;
  const issueCache = new Map();
  const childIssueCache = new Map();
  const pullRequestCache = new Map();
  const changelogCache = new Map();
  const fieldOptionsCache = new Map();
  const emptyCommentMentionState = () => ({
    error: '',
    loading: false,
    query: '',
    range: null,
    selectedIndex: 0,
    suggestions: [],
    visible: false
  });
  const emptyCommentUploadState = () => ({
    items: []
  });
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
  const projectSprintOptionsPromises = new Map();
  const editMetaCache = new Map();
  const transitionOptionsCache = new Map();
  const assigneeSearchCache = new Map();
  const genericUserSearchCache = new Map();
  const assigneeLocalOptionsCache = new Map();
  const watcherListCache = new Map();
  const watcherSearchCache = new Map();
  const issueSearchCache = new Map();
  const issueSearchRecentCache = new Map();
  const labelSuggestionCache = new Map();
  const labelLocalOptionsCache = new Map();
  const tempoAccountSearchCache = new Map();
  const userPickerSearchCache = new Map();
  const userPickerLocalOptionsCache = new Map();
  const jiraUserDisplayNameCache = new Map();
  const userSearchStrategyState = {
    assignable: '',
    people: '',
  };
  const sharedAvatarUrls = new Set();
  let contentShellHelpers = null;
  const {
    buildHistoryAttachmentLookup,
    buildHistoryAttachmentView,
    buildPreviewAttachments,
    collectReferencedHistoryAttachmentNames,
    dedupeHistoryAttachments,
    normalizeHistoryAttachmentName,
  } = createContentAttachmentHelpers({
    buildLinkHoverTitle,
  });
  const {
    buildAttachmentImagesByName,
    buildDraftMentionMapping,
    buildEditableCommentDraft,
    buildHistoryPreviewText,
    formatRelativeDate,
    getMentionDisplayText,
    normalizeCommentImageReference,
    replaceMentionMarkupWithDisplayText,
    restoreEditableCommentMentions,
    textToLinkedHtml,
  } = createContentCommentHelpers({
    mentionContextWindow: MENTION_CONTEXT_WINDOW,
    jiraUserDisplayNameCache,
    escapeHtml,
    normalizeHistoryAttachmentName,
  });
  const {
    getCachedValue,
    getIssueChangelog,
    getIssueMetaData,
    getIssueSummary,
    setCachedValue,
  } = createContentIssueDataHelpers({
    cacheTtlMs,
    changelogCache,
    customFields,
    get,
    getEpicLinkFieldIds,
    getSprintFieldIds,
    instanceUrl: INSTANCE_URL,
    issueCache,
  });
  const {formatChangelogForDisplay} = createContentHistoryHelpers({
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
    getIssueEditMeta,
    getTransitionOptions,
    pickSprintFieldId,
  } = createContentFieldCapabilityHelpers({
    editMetaCache,
    get,
    getBuildEditOption: () => buildEditOption,
    getAllFields,
    getCachedValue,
    getSprintFieldIds,
    instanceUrl: INSTANCE_URL,
    transitionOptionsCache,
  });
  const {
    getRecentIssueSearchOptions,
    resolveIssueLinkage,
    searchParentCandidates,
  } = createContentIssueLinkageHelpers({
    encodeJqlValue,
    get,
    getBuildEditOption: () => buildEditOption,
    getCachedValue,
    getIssueEditMeta: () => getIssueEditMeta,
    getIssueSummary,
    instanceUrl: INSTANCE_URL,
    issueSearchCache,
    issueSearchRecentCache,
  });
  let labelSuggestionSupportPromise = null;
  let editSearchRequestCounter = 0;
  let labelSearchTimeoutId = null;
  let watchersFeedbackTimeoutId = null;
  let actionNoticeTimeoutId = null;
  let descriptionStatusTimeoutId = null;
  let popupState = null;
  let activeCommentContext = null;
  let commentMentionState = emptyCommentMentionState();
  let commentComposerMentionMappings = [];
  let commentMentionRequestId = 0;
  let commentEditMentionState = {...emptyCommentMentionState(), commentId: ''};
  let commentEditMentionRequestId = 0;
  let commentUploadState = emptyCommentUploadState();
  let commentUploadSessionId = 0;
  let commentUploadSequence = 0;
  let commentComposerDraftValue = '';
  let commentComposerErrorMessage = '';
  let commentComposerHadFocus = false;
  let commentComposerSelectionStart = 0;
  let commentComposerSelectionEnd = 0;
  const {
    buildQuickActionError,
    buildQuickActionViewData,
    executeQuickAction,
    getCurrentUserInfo,
    resolveQuickActions,
  } = createPopupQuickActions({
    INSTANCE_URL,
    formatSprintActionLabel,
    get,
    getProjectSprintOptions,
    getSprintFieldIds,
    pickSprintFieldId,
    readSprintsFromIssue,
    requestJson,
  });

  const {
    buildNextWatchersState,
    buildPopupInteractionReset,
    handleDraftAttachmentUploaded,
    invalidatePopupCaches,
    refreshPopupIssueState,
    renderUpdatedPopupState,
  } = createContentPopupStateHelpers({
    assigneeLocalOptionsCache,
    assigneeSearchCache,
    changelogCache,
    clearActionNoticeTimer,
    createTimeTrackingEditState,
    editMetaCache,
    emptyWatchersState,
    getIssueChangelog,
    getIssueMetaData,
    getIssueWatchers,
    getPopupState: () => popupState,
    getPullRequestDataCached,
    issueCache,
    issueSearchCache,
    labelLocalOptionsCache,
    normalizeHistoryAttachmentName,
    normalizeIssueAttachmentImage,
    normalizeIssueImages,
    normalizePullRequests,
    normalizePullRequestImages,
    pullRequestCache,
    renderIssuePopup,
    resolveQuickActions,
    scheduleActionNoticeClear,
    setPopupState: nextState => {
      popupState = nextState;
    },
    sharedAvatarUrls,
    showPullRequests,
    snackBar,
    tempoAccountSearchCache,
    transitionOptionsCache,
    userPickerLocalOptionsCache,
    userPickerSearchCache,
    watcherListCache,
    watcherSearchCache,
  });

  const {
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
  } = createPopupEditing({
    INSTANCE_URL,
    assigneeLocalOptionsCache,
    buildEditFieldError,
    compareSprintState,
    fieldOptionsCache,
    formatSprintOptionLabel,
    formatSprintText,
    formatVersionText,
    get,
    getCachedValue,
    getCustomFieldEditorDefinition,
    getEditableFieldCapability,
    getLabelSuggestions,
    getPopupState: () => popupState,
    getRecentIssueSearchOptions,
    getSprintFieldIds,
    getTransitionOptions,
    hasLabelSuggestionSupport,
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
    searchUserPicker,
    searchParentCandidates,
    setPopupState: nextState => {
      popupState = nextState;
    },
  });

  const {
    applyCommentMentionSelection,
    captureCommentComposerDraft,
    clearCommentUploads,
    discardCommentComposerDraft,
    getClipboardImageFiles,
    getCommentComposerElements,
    hasCommentUploadInFlight,
    moveCommentMentionSelection,
    renderCommentMentionSuggestions,
    renderCommentUploads,
    resetCommentMentionState,
    restoreCommentComposerDraft,
    restoreCommentComposerState,
    setCommentComposerError,
    syncCommentComposerState,
    syncCommentMentionSuggestions,
    uploadPastedImage,
  } = createPopupCommentComposer({
    INSTANCE_URL,
    emptyCommentMentionState,
    emptyCommentUploadState,
    escapeHtml,
    get,
    getActiveCommentContext: () => activeCommentContext,
    getCommentComposerErrorMessage: () => commentComposerErrorMessage,
    getCommentComposerHadFocus: () => commentComposerHadFocus,
    getCommentComposerMentionMappings: () => commentComposerMentionMappings,
    getCommentComposerSelectionEnd: () => commentComposerSelectionEnd,
    getCommentComposerSelectionStart: () => commentComposerSelectionStart,
    getCommentComposerDraftValue: () => commentComposerDraftValue,
    getCommentMentionRequestId: () => commentMentionRequestId,
    getCommentMentionState: () => commentMentionState,
    getCommentUploadSequence: () => commentUploadSequence,
    getCommentUploadSessionId: () => commentUploadSessionId,
    getCommentUploadState: () => commentUploadState,
    getContainer: () => container,
    getDisplayImageUrl,
    rememberDisplayImageUrl,
    onAttachmentUploaded: handleDraftAttachmentUploaded,
    keepContainerVisible,
    requestJson,
    restoreEditableCommentMentions,
    setActiveCommentContext: nextValue => { activeCommentContext = nextValue; },
    setCommentComposerErrorMessage: nextValue => { commentComposerErrorMessage = nextValue; },
    setCommentComposerHadFocus: nextValue => { commentComposerHadFocus = nextValue; },
    setCommentComposerMentionMappings: nextValue => { commentComposerMentionMappings = nextValue; },
    setCommentComposerSelectionEnd: nextValue => { commentComposerSelectionEnd = nextValue; },
    setCommentComposerSelectionStart: nextValue => { commentComposerSelectionStart = nextValue; },
    setCommentComposerDraftValue: nextValue => { commentComposerDraftValue = nextValue; },
    setCommentMentionRequestId: nextValue => { commentMentionRequestId = nextValue; },
    setCommentMentionState: nextValue => { commentMentionState = nextValue; },
    setCommentUploadSequence: nextValue => { commentUploadSequence = nextValue; },
    setCommentUploadSessionId: nextValue => { commentUploadSessionId = nextValue; },
    setCommentUploadState: nextValue => { commentUploadState = nextValue; },
    setPopupState: nextValue => { popupState = nextValue; },
    textToLinkedHtml,
    toAbsoluteJiraUrl,
    uploadAttachment,
  });


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

  function buildDisplayImageCacheKeys(url) {
    const absoluteUrl = toAbsoluteJiraUrl(url);
    if (!absoluteUrl) {
      return [];
    }
    const proxyUrl = buildAttachmentProxyUrl(absoluteUrl);
    return [...new Set([absoluteUrl, proxyUrl].filter(Boolean))];
  }

  function getCachedDisplayImageUrl(url) {
    const cacheKeys = buildDisplayImageCacheKeys(url);
    for (const cacheKey of cacheKeys) {
      const cachedUrl = imageProxyCache[cacheKey];
      if (isImageDataUrl(cachedUrl)) {
        return cachedUrl;
      }
    }
    return '';
  }

  function cacheDisplayImageUrl(dataUrl, ...urls) {
    if (!isImageDataUrl(dataUrl)) {
      return;
    }
    urls.forEach(url => {
      buildDisplayImageCacheKeys(url).forEach(cacheKey => {
        imageProxyCache[cacheKey] = dataUrl;
      });
    });
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
    const cachedDataUrl = getCachedDisplayImageUrl(absoluteUrl);
    if (cachedDataUrl) {
      return cachedDataUrl;
    }
    const fetchUrl = buildAttachmentProxyUrl(absoluteUrl);
    try {
      const dataUrl = await getImageDataUrl(fetchUrl, mimeType);
      cacheDisplayImageUrl(dataUrl, absoluteUrl, fetchUrl);
      return dataUrl;
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
            const dataUrl = await blobToDataUrl(normalizedBlob);
            cacheDisplayImageUrl(dataUrl, absoluteUrl, fetchUrl);
            return dataUrl;
          }
        }
      } catch (fallbackError) {
        // Ignore and fall back to the original URL below.
      }
      return absoluteUrl;
    }
  }

  function rememberDisplayImageUrl(url, dataUrl) {
    cacheDisplayImageUrl(dataUrl, url);
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

  function queueAvatarNormalization(imageLoads, field) {
    const avatarUrl = field?.avatarUrls?.['48x48'] || field?.avatarUrl || '';
    if (!avatarUrl) {
      return;
    }
    imageLoads.push(
      getDisplayImageUrl(avatarUrl).then(src => {
        if (!field || typeof field !== 'object') {
          return;
        }
        field.avatarUrls = field.avatarUrls || {};
        field.avatarUrls['48x48'] = src;
        field.avatarUrl = src;
      })
    );
  }

  function queueIconNormalization(imageLoads, field) {
    if (!field?.iconUrl) {
      return;
    }
    imageLoads.push(
      getDisplayImageUrl(field.iconUrl).then(src => {
        field.iconUrl = src;
      })
    );
  }

  async function normalizeIssueImages(issueData) {
    const imageLoads = [];

    queueAvatarNormalization(imageLoads, issueData.fields.reporter);
    queueAvatarNormalization(imageLoads, issueData.fields.assignee);
    queueIconNormalization(imageLoads, issueData.fields.issuetype);
    queueIconNormalization(imageLoads, issueData.fields.status);
    queueIconNormalization(imageLoads, issueData.fields.priority);

    // Normalize comment author avatars
    (issueData.fields.comment?.comments || []).forEach(comment => {
      queueAvatarNormalization(imageLoads, comment.author);
    });

    // Normalize custom field user avatars
    Object.keys(issueData.fields || {}).forEach(fieldKey => {
      if (!fieldKey.startsWith('customfield_')) {
        return;
      }
      const fieldValue = issueData.fields[fieldKey];
      if (fieldValue && typeof fieldValue === 'object' && fieldValue.avatarUrls) {
        queueAvatarNormalization(imageLoads, fieldValue);
      }
      if (Array.isArray(fieldValue)) {
        fieldValue.forEach(entry => {
          if (entry && typeof entry === 'object' && entry.avatarUrls) {
            queueAvatarNormalization(imageLoads, entry);
          }
        });
      }
    });

    (issueData.fields.attachment || []).forEach(attachment => {
      imageLoads.push(normalizeIssueAttachmentImage(attachment));
    });

    await Promise.all(imageLoads);
  }

  async function normalizeChildIssueImages(childIssues) {
    const imageLoads = [];
    (Array.isArray(childIssues) ? childIssues : []).forEach(issue => {
      queueIconNormalization(imageLoads, issue?.fields?.issuetype);
      queueAvatarNormalization(imageLoads, issue?.fields?.assignee);
    });
    await Promise.all(imageLoads);
  }

  async function normalizePullRequestImages(pullRequests) {
    const imageLoads = [];
    (Array.isArray(pullRequests) ? pullRequests : []).forEach(pr => {
      queueAvatarNormalization(imageLoads, pr?.author);
    });
    await Promise.all(imageLoads);
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

  function cacheKnownJiraUser(user) {
    if (!user || typeof user !== 'object') {
      return;
    }
    const displayName = String(user.displayName || user.name || user.username || user.key || user.emailAddress || '').trim();
    if (!displayName) {
      return;
    }
    [user.accountId, user.name, user.username, user.key]
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .forEach(identity => {
        jiraUserDisplayNameCache.set(identity, displayName);
      });
  }

  function cacheKnownJiraUsers(users) {
    (Array.isArray(users) ? users : []).forEach(cacheKnownJiraUser);
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
      await refreshPopupIssueState('', {preserveHistory: !!popupState?.historyOpen});
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
      await refreshPopupIssueState('', {preserveHistory: !!popupState?.historyOpen});
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

  async function buildCommentsForDisplay(
    issueData,
    commentSession = null,
    reactionState = popupState?.commentReactionState,
    commentSortOrder = popupState?.commentSortOrder
  ) {
    const issueKey = issueData?.key || '';
    const normalizedCommentSortOrder = normalizeCommentSortOrder(commentSortOrder);
    const comments = [...(issueData.fields.comment?.comments || [])].sort((a, b) => {
      const leftTimestamp = new Date(a.created).getTime();
      const rightTimestamp = new Date(b.created).getTime();
      return normalizedCommentSortOrder === 'newest'
        ? rightTimestamp - leftTimestamp
        : leftTimestamp - rightTimestamp;
    });
    const renderedById = {};
    const attachmentLookup = buildHistoryAttachmentLookup(issueData?.fields?.attachment || []);
    const attachmentImagesByName = buildAttachmentImagesByName(attachmentLookup, 100);
    const currentUser = await getCurrentUserInfo().catch(() => null);
    cacheKnownJiraUser(currentUser);
    cacheKnownJiraUser(issueData?.fields?.reporter);
    cacheKnownJiraUser(issueData?.fields?.assignee);
    cacheKnownJiraUsers(comments.map(comment => comment?.author).filter(Boolean));
    ((issueData.renderedFields?.comment?.comments) || []).forEach(comment => {
      if (comment && comment.id) {
        renderedById[comment.id] = comment.body;
      }
    });

    return Promise.all(comments.map(async comment => {
      const rendered = renderedById[comment.id];
      const baseHtml = rendered || textToLinkedHtml(comment.body || '', {attachmentImagesByName});
      const bodyHtml = await normalizeRichHtml(baseHtml, {imageMaxHeight: 100, attachmentLookup});
      const commentId = String(comment.id || '');
      const isOwnedByCurrentUser = areSameJiraUser(comment.author, currentUser);
      const isEditing = commentSession?.commentId === commentId && commentSession.mode === 'edit';
      const isDeleteConfirming = commentSession?.commentId === commentId && commentSession.mode === 'delete';
      const sessionError = commentSession?.commentId === commentId ? (commentSession.error || '') : '';
      const editDraft = commentSession?.commentId === commentId
        ? String(commentSession.draft ?? comment.body ?? '')
        : String(comment.body || '');
      const hasEditDraft = !!editDraft.trim();
      const commentPermalink = buildCommentPermalink(issueKey, commentId);
      const commentLinkTitleText = `[${issueKey}] ${issueData?.fields?.summary || ''}`.trim();
      const reactionUi = buildCommentReactionUi(commentId, reactionState);
      const authorView = buildUserView(comment.author);
      return {
        id: commentId,
        author: authorView.displayName || 'Unknown',
        authorAvatarUrl: authorView.avatarUrl,
        authorInitials: authorView.initials,
        authorIdentity: {
          accountId: comment.author?.accountId || '',
          key: comment.author?.key || '',
          name: comment.author?.name || comment.author?.username || '',
          username: comment.author?.username || comment.author?.name || ''
        },
        created: formatRelativeDate(comment.created),
        commentPermalink,
        commentLinkTitle: buildLinkHoverTitle('Open comment in Jira', commentLinkTitleText, commentPermalink),
        commentCopyTitle: buildLinkHoverTitle('Copy comment link', commentLinkTitleText, commentPermalink),
        commentCopyLabel: commentLinkTitleText,
        bodyHtml,
        bodyRaw: String(comment.body || ''),
        isOwnedByCurrentUser,
        showCommentActions: isOwnedByCurrentUser,
        isEditing,
        isDeleteConfirming,
        commentActionBusy: !!commentSession?.saving && commentSession?.commentId === commentId,
        commentActionError: sessionError,
        showCommentDefaultActions: isOwnedByCurrentUser && !isEditing && !isDeleteConfirming,
        showCommentEditHeaderActions: isOwnedByCurrentUser && isEditing,
        showCommentDeleteHeaderActions: isOwnedByCurrentUser && isDeleteConfirming,
        commentEditDraft: editDraft,
        commentEditSaveDisabled: !hasEditDraft || (!!commentSession?.saving && commentSession?.commentId === commentId),
        commentEditCancelDisabled: !!commentSession?.saving && commentSession?.commentId === commentId,
        commentDeleteCancelDisabled: !!commentSession?.saving && commentSession?.commentId === commentId,
        commentDeleteConfirmDisabled: !!commentSession?.saving && commentSession?.commentId === commentId,
        commentEditSaveText: !!commentSession?.saving && commentSession?.commentId === commentId ? 'Saving...' : 'Save',
        commentDeleteConfirmText: !!commentSession?.saving && commentSession?.commentId === commentId ? 'Deleting...' : 'Yes',
        commentDeleteCancelText: 'No',
        reactionError: getCommentReactionError(commentId, reactionState),
        ...reactionUi
      };
    }));
  }

  function normalizeCommentReactionState(state) {
    if (state && typeof state === 'object') {
      return {
        byCommentId: state.byCommentId || {},
        supported: state.supported !== false
      };
    }
    return emptyCommentReactionState();
  }

  function getCommentReactionEntry(commentId, emojiId, reactionState = popupState?.commentReactionState) {
    const normalizedState = normalizeCommentReactionState(reactionState);
    return normalizedState.byCommentId?.[String(commentId)]?.[emojiId] || {};
  }

  function getCommentReactionError(commentId, reactionState = popupState?.commentReactionState) {
    const reactionEntry = getCommentReactionEntry(commentId, '__comment__', reactionState);
    return reactionEntry.error || '';
  }

  function buildCommentReactionOptions(commentId, reactionState = popupState?.commentReactionState) {
    const normalizedState = normalizeCommentReactionState(reactionState);
    if (!normalizedState.supported || !commentId) {
      return {pills: [], menuOptions: []};
    }
    const pills = [];
    const menuOptions = [];
    for (const option of COMMENT_REACTION_OPTIONS) {
      const entry = getCommentReactionEntry(commentId, option.emojiId, normalizedState);
      const count = Number(entry.count) || 0;
      const reacted = !!entry.reacted;
      const pending = !!entry.pending;
      menuOptions.push({
        commentId,
        emoji: option.emoji,
        emojiId: option.emojiId,
        label: option.label,
        title: pending ? `${option.label}...` : option.label,
        isReacted: reacted,
        isPending: pending,
        disabledAttr: pending ? 'disabled' : ''
      });
      if (count > 0) {
        pills.push({
          commentId,
          emoji: option.emoji,
          emojiId: option.emojiId,
          count,
          reacted,
          pending,
          title: pending ? `${option.label}...` : `${option.label} (${count})`,
          disabledAttr: pending ? 'disabled' : ''
        });
      }
    }
    return {pills, menuOptions};
  }

  function buildCommentReactionUi(commentId, reactionState = popupState?.commentReactionState) {
    const {pills, menuOptions} = buildCommentReactionOptions(commentId, reactionState);
    return {
      hasReactionOptions: menuOptions.length > 0,
      reactionPills: pills,
      hasReactionPills: pills.length > 0,
      menuReactionOptions: menuOptions
    };
  }


  function getCommentMentionMarkup(candidate) {
    const username = candidate?.name || candidate?.username || '';
    if (username) {
      return `[~${username}]`;
    }
    const accountId = candidate?.accountId || '';
    if (accountId) {
      return `[~accountid:${accountId}]`;
    }
    return '';
  }

  async function searchCommentMentionCandidates(query) {
    const response = await get(`${INSTANCE_URL}rest/api/2/user/picker?query=${encodeURIComponent(query)}`);
    const rawCandidates = Array.isArray(response)
      ? response
      : response?.users || response?.items || [];
    cacheKnownJiraUsers(rawCandidates);
    const seen = new Set();
    return rawCandidates
      .map(candidate => {
        const mentionMarkup = getCommentMentionMarkup(candidate);
        if (!mentionMarkup || seen.has(mentionMarkup)) {
          return null;
        }
        seen.add(mentionMarkup);
        const displayName = candidate?.displayName || candidate?.name || candidate?.username || candidate?.emailAddress || 'Unknown user';
        const username = candidate?.name || candidate?.username || '';
        const secondaryText = (username && username !== displayName)
          ? `@${username}`
          : ((candidate?.emailAddress && candidate.emailAddress !== displayName) ? candidate.emailAddress : '');
        return {
          displayName,
          mentionMarkup,
          secondaryText
        };
      })
      .filter(Boolean)
      .slice(0, 6);
  }

  function getActiveTextMentionRange(inputElement) {
    if (!inputElement) {
      return null;
    }
    const value = inputElement.value || '';
    const caretStart = typeof inputElement.selectionStart === 'number' ? inputElement.selectionStart : value.length;
    const caretEnd = typeof inputElement.selectionEnd === 'number' ? inputElement.selectionEnd : caretStart;
    if (caretStart !== caretEnd) {
      return null;
    }
    const beforeCaret = value.slice(0, caretStart);
    const mentionMatch = beforeCaret.match(/(^|[\s(])@([^\s@]{1,50})$/);
    if (!mentionMatch) {
      return null;
    }
    let end = caretEnd;
    while (end < value.length && !/\s/.test(value.charAt(end))) {
      end += 1;
    }
    return {end, query: mentionMatch[2], start: caretStart - mentionMatch[2].length - 1};
  }


  function setCommentReactionEntry(commentId, emojiId, changes) {
    if (!popupState) {
      return;
    }
    const normalizedCommentId = String(commentId || '');
    const normalizedEmojiId = String(emojiId || '');
    const currentState = normalizeCommentReactionState(popupState.commentReactionState);
    const currentCommentState = currentState.byCommentId[normalizedCommentId] || {};
    const currentEntry = currentCommentState[normalizedEmojiId] || {};
    popupState = {
      ...popupState,
      commentReactionState: {
        ...currentState,
        byCommentId: {
          ...currentState.byCommentId,
          [normalizedCommentId]: {
            ...currentCommentState,
            [normalizedEmojiId]: {
              ...currentEntry,
              ...changes
            }
          }
        }
      }
    };
  }

  function disableCommentReactions() {
    if (!popupState) {
      return;
    }
    popupState = {
      ...popupState,
      commentReactionState: {
        ...normalizeCommentReactionState(popupState.commentReactionState),
        supported: false
      }
    };
  }

  function isCommentReactionUnsupportedError(error) {
    const message = String(error?.message || error?.inner || error || '');
    return /http\s+(401|403|404|405)\b/i.test(message) || /forbidden|not found|method not allowed/i.test(message);
  }

  async function fetchCommentReactions(commentIds) {
    return requestJson('POST', `${INSTANCE_URL}rest/internal/2/reactions/view`, {
      commentIds: commentIds.map(id => Number(id))
    }, {
      'X-Atlassian-Token': 'no-check'
    });
  }

  async function addCommentReaction(commentId, emojiId) {
    return requestJson('POST', `${INSTANCE_URL}rest/internal/2/reactions`, {
      commentId: String(commentId),
      emojiId
    }, {
      'X-Atlassian-Token': 'no-check'
    });
  }

  async function deleteCommentReaction(commentId, emojiId) {
    return requestJson('DELETE', `${INSTANCE_URL}rest/internal/2/reactions?commentId=${encodeURIComponent(commentId)}&emojiId=${encodeURIComponent(emojiId)}`, undefined, {
      'X-Atlassian-Token': 'no-check'
    });
  }

  function buildInitialReactionState(serverReactions) {
    const byCommentId = {};
    if (Array.isArray(serverReactions)) {
      for (const entry of serverReactions) {
        const commentId = String(entry.commentId || '');
        const emojiId = entry.emojiId || '';
        if (!commentId || !emojiId) continue;
        if (!byCommentId[commentId]) {
          byCommentId[commentId] = {};
        }
        byCommentId[commentId][emojiId] = {
          count: Number(entry.count) || 0,
          reacted: !!entry.reacted,
          pending: false
        };
      }
    }
    return {byCommentId, supported: true};
  }

  async function handleCommentReactionClick(commentId, emojiId) {
    if (!popupState?.issueData || !commentId || !emojiId) {
      return;
    }
    const currentEntry = getCommentReactionEntry(commentId, emojiId);
    if (currentEntry.pending) {
      return;
    }

    const wasReacted = !!currentEntry.reacted;
    const oldCount = Number(currentEntry.count) || 0;

    setCommentReactionEntry(commentId, '__comment__', {error: ''});
    setCommentReactionEntry(commentId, emojiId, {
      count: wasReacted ? Math.max(0, oldCount - 1) : oldCount + 1,
      reacted: !wasReacted,
      pending: true
    });
    await renderIssuePopup(popupState);

    try {
      if (wasReacted) {
        await deleteCommentReaction(commentId, emojiId);
      } else {
        await addCommentReaction(commentId, emojiId);
      }
      setCommentReactionEntry(commentId, emojiId, {pending: false});
      await renderIssuePopup(popupState);
    } catch (error) {
      if (!wasReacted && isCommentReactionUnsupportedError(error)) {
        disableCommentReactions();
        await renderIssuePopup(popupState);
        snackBar('Comment reactions are not available in this Jira context');
        return;
      }
      setCommentReactionEntry(commentId, emojiId, {
        count: oldCount,
        reacted: wasReacted,
        pending: false
      });
      if (!wasReacted) {
        setCommentReactionEntry(commentId, '__comment__', {
          error: error?.message || error?.inner || 'Could not update reaction'
        });
      }
      await renderIssuePopup(popupState);
    }
  }

  function addSavedCommentToPopupState(savedComment, commentText, fallbackAuthor = null) {
    if (!popupState?.issueData?.fields) {
      return;
    }
    const nextComment = {
      ...savedComment,
      id: String(savedComment?.id || ''),
      body: commentText || savedComment?.body || '',
      author: savedComment?.author || fallbackAuthor || null,
      created: savedComment?.created || new Date().toISOString(),
    };
    const existingComments = Array.isArray(popupState.issueData.fields.comment?.comments)
      ? popupState.issueData.fields.comment.comments
      : [];
    const nextComments = [
      ...existingComments.filter(comment => String(comment?.id || '') !== nextComment.id),
      nextComment,
    ];
    popupState = {
      ...popupState,
      issueData: {
        ...popupState.issueData,
        fields: {
          ...popupState.issueData.fields,
          comment: {
            ...(popupState.issueData.fields.comment || {}),
            comments: nextComments,
          }
        }
      }
    };
  }

  async function handleCommentSave() {
    const commentIssueKey = activeCommentContext?.issueKey || '';
    if (!commentIssueKey) {
      return;
    }

    resetCommentMentionState();
    const elements = getCommentComposerElements();
    const commentDraftText = String(elements.input.val() || '');
    const commentText = commentDraftText.trim();
    commentComposerDraftValue = commentText;
    if (!commentText) {
      syncCommentComposerState();
      return;
    }
    if (hasCommentUploadInFlight()) {
      setCommentComposerError('Wait for image uploads to finish.');
      syncCommentComposerState();
      return;
    }

    elements.root.attr('data-saving', 'true');
    setCommentComposerError('');
    syncCommentComposerState();

    try {
      const currentUser = await getCurrentUserInfo().catch(() => ({displayName: 'You'}));
      const requestBody = restoreEditableCommentMentions(commentText, commentComposerMentionMappings);
      const savedComment = await requestJson('POST', `${INSTANCE_URL}rest/api/2/issue/${commentIssueKey}/comment`, {
        body: requestBody
      });
      const isSameIssueStillVisible = popupState?.issueData?.key === commentIssueKey;
      changelogCache.delete(commentIssueKey);
      if (isSameIssueStillVisible) {
        addSavedCommentToPopupState(savedComment, requestBody, currentUser);
        setCachedValue(issueCache, commentIssueKey, popupState?.issueData);
        elements.input.val('');
        elements.root.attr('data-saving', 'false');
        commentComposerDraftValue = '';
        commentComposerMentionMappings = [];
        commentComposerHadFocus = false;
        commentComposerSelectionStart = 0;
        commentComposerSelectionEnd = 0;
        await clearCommentUploads({deleteUploaded: false});
        setCommentComposerError('');
        await renderIssuePopup(popupState);
      } else {
        issueCache.delete(commentIssueKey);
      }
      if (isSameIssueStillVisible && popupState?.historyOpen) {
        await refreshPopupIssueState('Comment added', {preserveHistory: true});
      }
    } catch (error) {
      elements.root.attr('data-saving', 'false');
      setCommentComposerError(error?.message || error?.inner || 'Could not save comment');
      syncCommentComposerState();
    }
  }

  async function handleCommentDiscard() {
    const elements = getCommentComposerElements();
    if (!elements.root.length || elements.root.attr('data-saving') === 'true') {
      return;
    }
    await discardCommentComposerDraft();
  }


  function getActiveCommentSession() {
    return popupState?.commentSession || null;
  }

  function resetCommentEditMentionState() {
    commentEditMentionRequestId += 1;
    debouncedLoadCommentEditMentionSuggestions.cancel();
    commentEditMentionState = {...emptyCommentMentionState(), commentId: ''};
  }

  function setCommentSession(nextSession) {
    if (!popupState) {
      return;
    }
    popupState = {
      ...popupState,
      commentSession: nextSession
    };
  }

  function cancelCommentSession() {
    if (!popupState?.commentSession) {
      return;
    }
    resetCommentEditMentionState();
    setCommentSession(null);
    renderIssuePopup(popupState).catch(() => {});
  }

  function getIssueCommentById(commentId) {
    const normalizedCommentId = String(commentId || '');
    return (popupState?.issueData?.fields?.comment?.comments || []).find(comment => String(comment?.id || '') === normalizedCommentId) || null;
  }

  function startCommentEdit(commentId, commentBody) {
    if (!popupState?.issueData || !commentId) {
      return;
    }
    pinContainer({showNotice: false});
    resetCommentEditMentionState();
    const {draft, mentionMappings} = buildEditableCommentDraft(commentBody);
    setCommentSession({
      commentId: String(commentId),
      draft,
      error: '',
      mentionMappings,
      mode: 'edit',
      selectionEnd: draft.length,
      selectionStart: draft.length,
      saving: false
    });
    renderIssuePopup(popupState).catch(() => {});
  }

  async function loadCommentEditMentionSuggestions(commentId, mention) {
    const requestId = ++commentEditMentionRequestId;
    try {
      const suggestions = await searchCommentMentionCandidates(mention.query);
      if (requestId !== commentEditMentionRequestId) {
        return;
      }
      commentEditMentionState = {
        commentId: String(commentId || ''),
        error: '',
        loading: false,
        query: mention.query,
        range: mention,
        selectedIndex: 0,
        suggestions,
        visible: true,
      };
    } catch (error) {
      if (requestId !== commentEditMentionRequestId) {
        return;
      }
      commentEditMentionState = {
        commentId: String(commentId || ''),
        error: 'Could not load people.',
        loading: false,
        query: mention.query,
        range: mention,
        selectedIndex: 0,
        suggestions: [],
        visible: true,
      };
    }
    renderIssuePopup(popupState).catch(() => {});
  }

  const debouncedLoadCommentEditMentionSuggestions = debounce((commentId, mention) => {
    loadCommentEditMentionSuggestions(commentId, mention).catch(() => {});
  }, 150);

  function syncCommentEditMentionSuggestions(inputElement, commentId) {
    const mention = getActiveTextMentionRange(inputElement);
    if (!mention || !commentId) {
      if (commentEditMentionState.visible) {
        resetCommentEditMentionState();
        renderIssuePopup(popupState).catch(() => {});
      }
      return;
    }
    commentEditMentionState = {
      commentId: String(commentId),
      error: '',
      loading: true,
      query: mention.query,
      range: mention,
      selectedIndex: 0,
      suggestions: [],
      visible: true,
    };
    renderIssuePopup(popupState).catch(() => {});
    debouncedLoadCommentEditMentionSuggestions(commentId, mention);
  }

  function moveCommentEditMentionSelection(delta) {
    if (!commentEditMentionState.visible || !commentEditMentionState.suggestions.length) {
      return;
    }
    const suggestionsTotal = commentEditMentionState.suggestions.length;
    commentEditMentionState = {
      ...commentEditMentionState,
      selectedIndex: (commentEditMentionState.selectedIndex + delta + suggestionsTotal) % suggestionsTotal,
    };
    renderIssuePopup(popupState).catch(() => {});
  }

  function renderCommentEditMentionSuggestions() {
    container.find('._JX_comment_edit_mentions').attr('hidden', 'hidden').empty();
    if (!commentEditMentionState.visible || !commentEditMentionState.commentId) {
      return;
    }
    const mentions = container.find(`._JX_comment_edit_mentions[data-comment-id="${commentEditMentionState.commentId}"]`);
    const input = container.find(`._JX_comment_edit_input[data-comment-id="${commentEditMentionState.commentId}"]`);
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
    if (commentEditMentionState.error) {
      positionSuggestions(`<div class="_JX_comment_mentions_status">${escapeHtml(commentEditMentionState.error)}</div>`);
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
        <button class="_JX_comment_mention_option${selectedClass} _JX_comment_edit_mention_option" type="button" data-comment-id="${escapeHtml(commentEditMentionState.commentId)}" data-mention-index="${index}">
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
    const suggestionState = commentEditMentionState;
    const candidate = suggestionState.suggestions[index];
    const mentionRange = suggestionState.range;
    if (!activeSession || activeSession.mode !== 'edit' || !candidate || !mentionRange) {
      return;
    }
    const displayText = `@${candidate.displayName || candidate.name || candidate.username || 'mention'}`;
    const nextDraft = String(activeSession.draft || '').slice(0, mentionRange.start) + `${displayText} ` + String(activeSession.draft || '').slice(mentionRange.end);
    setCommentSession({
      ...activeSession,
      draft: nextDraft,
      error: '',
      mentionMappings: [
        ...(Array.isArray(activeSession.mentionMappings) ? activeSession.mentionMappings : []),
        buildDraftMentionMapping(nextDraft, mentionRange.start, displayText, candidate.mentionMarkup),
      ],
      selectionStart: mentionRange.start + displayText.length + 1,
      selectionEnd: mentionRange.start + displayText.length + 1,
    });
    resetCommentEditMentionState();
    renderIssuePopup(popupState).catch(() => {});
  }

  function startCommentDeleteConfirm(commentId) {
    if (!popupState?.issueData || !commentId) {
      return;
    }
    resetCommentEditMentionState();
    setCommentSession({
      commentId: String(commentId),
      draft: '',
      error: '',
      mode: 'delete',
      saving: false
    });
    renderIssuePopup(popupState).catch(() => {});
  }

  function updateCommentEditDraft(commentId, draft, selectionStart, selectionEnd) {
    const activeSession = getActiveCommentSession();
    if (!activeSession || activeSession.commentId !== String(commentId) || activeSession.mode !== 'edit') {
      return;
    }
    setCommentSession({
      ...activeSession,
      draft: String(draft || ''),
      error: '',
      selectionEnd,
      selectionStart
    });
    renderIssuePopup(popupState).catch(() => {});
  }

  async function saveCommentEdit(commentId) {
    const activeSession = getActiveCommentSession();
    if (!popupState?.key || !activeSession || activeSession.commentId !== String(commentId) || activeSession.mode !== 'edit' || activeSession.saving) {
      return;
    }
    resetCommentEditMentionState();
    const nextDraft = String(activeSession.draft || '');
    if (!nextDraft.trim()) {
      setCommentSession({...activeSession, error: 'Comment cannot be empty.'});
      await renderIssuePopup(popupState);
      return;
    }

    setCommentSession({...activeSession, draft: nextDraft, error: '', saving: true});
    await renderIssuePopup(popupState);

    try {
      const requestBody = restoreEditableCommentMentions(nextDraft, activeSession.mentionMappings);
      await requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${popupState.key}/comment/${commentId}`, {
        body: requestBody
      });
      await refreshPopupIssueState('Comment updated', {preserveHistory: !!popupState?.historyOpen});
    } catch (error) {
      const errorMessage = error?.message || error?.inner || 'Could not update comment';
      const latestSession = getActiveCommentSession();
      if (!latestSession || latestSession.commentId !== String(commentId) || latestSession.mode !== 'edit') {
        return;
      }
      setCommentSession({...latestSession, error: errorMessage, saving: false});
      await renderIssuePopup(popupState);
      snackBar(errorMessage);
    }
  }

  async function confirmCommentDelete(commentId) {
    const activeSession = getActiveCommentSession();
    if (!popupState?.key || !activeSession || activeSession.commentId !== String(commentId) || activeSession.mode !== 'delete' || activeSession.saving) {
      return;
    }

    setCommentSession({...activeSession, error: '', saving: true});
    await renderIssuePopup(popupState);

    try {
      await requestJson('DELETE', `${INSTANCE_URL}rest/api/2/issue/${popupState.key}/comment/${commentId}`);
      await refreshPopupIssueState('Comment deleted', {preserveHistory: !!popupState?.historyOpen});
    } catch (error) {
      const errorMessage = error?.message || error?.inner || 'Could not delete comment';
      const latestSession = getActiveCommentSession();
      if (!latestSession || latestSession.commentId !== String(commentId) || latestSession.mode !== 'delete') {
        return;
      }
      setCommentSession({...latestSession, error: errorMessage, saving: false});
      await renderIssuePopup(popupState);
      snackBar(errorMessage);
    }
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

  function getPullRequestData(issueId, applicationType) {
    return get(INSTANCE_URL + 'rest/dev-status/1.0/issue/detail?issueId=' + issueId + '&applicationType=gitlabselfmanaged&dataType=pullrequest');
  }

  function getPullRequestSummaryData(issueId) {
    return get(`${INSTANCE_URL}rest/dev-status/1.0/issue/summary?issueId=${issueId}`);
  }

  function encodeChildIssueJqlValue(value) {
    return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  function buildCustomFieldIssueSearchClause(fieldId, issueKey) {
    const match = String(fieldId || '').match(/^customfield_(\d+)$/i);
    if (!match?.[1]) {
      return '';
    }
    return `cf[${match[1]}] = ${encodeChildIssueJqlValue(issueKey)}`;
  }

  async function searchIssuesByJql(jql, fields = []) {
    let response = null;
    let lastError = null;
    const requestUrls = buildJiraSearchRequestUrls(INSTANCE_URL, {
      maxResults: 100,
      fields,
      jql,
    });

    for (const requestUrl of requestUrls) {
      try {
        response = await get(requestUrl);
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!response) {
      throw lastError || new Error('Issue search failed');
    }

    return Array.isArray(response?.issues)
      ? response.issues.filter(Boolean)
      : [];
  }

  function dedupeIssuesByKey(issues) {
    const seenKeys = new Set();
    return (Array.isArray(issues) ? issues : []).filter(issue => {
      const issueKey = String(issue?.key || '').trim();
      if (!issueKey || seenKeys.has(issueKey)) {
        return false;
      }
      seenKeys.add(issueKey);
      return true;
    });
  }

  async function getChildIssues(issueData) {
    const issueKey = String(issueData?.key || '').trim();
    if (!issueKey) {
      return [];
    }

    return getCachedValue(childIssueCache, issueKey, async () => {
      const searchFields = ['summary', 'issuetype', 'status', 'assignee'];
      let directSearchError = null;
      let directChildren = [];

      try {
        directChildren = await searchIssuesByJql(`parent = ${encodeChildIssueJqlValue(issueKey)}`, searchFields);
      } catch (error) {
        directSearchError = error;
      }

      if (directChildren.length) {
        return dedupeIssuesByKey(directChildren);
      }

      const [epicLinkFieldIds, parentLinkFieldIds] = await Promise.all([
        getEpicLinkFieldIds(INSTANCE_URL).catch(() => []),
        getParentLinkFieldIds(INSTANCE_URL).catch(() => []),
      ]);
      const fallbackJqls = [...epicLinkFieldIds, ...parentLinkFieldIds]
        .map(fieldId => buildCustomFieldIssueSearchClause(fieldId, issueKey))
        .filter(Boolean);

      if (!fallbackJqls.length) {
        if (directSearchError) {
          throw directSearchError;
        }
        return [];
      }

      const fallbackChildren = [];
      let fallbackSearchError = null;
      let fallbackSucceeded = false;
      for (const jql of fallbackJqls) {
        try {
          fallbackChildren.push(...(await searchIssuesByJql(jql, searchFields)));
          fallbackSucceeded = true;
        } catch (error) {
          fallbackSearchError = error;
        }
      }

      if (!fallbackSucceeded && directSearchError) {
        throw directSearchError;
      }
      if (!fallbackSucceeded && fallbackSearchError) {
        throw fallbackSearchError;
      }

      return dedupeIssuesByKey(fallbackChildren);
    });
  }

  async function probeDevStatusEndpoints(issueId) {
    const probes = [
      {label: '1.0 summary', url: `${INSTANCE_URL}rest/dev-status/1.0/issue/summary?issueId=${issueId}`},
      {label: 'latest summary', url: `${INSTANCE_URL}rest/dev-status/latest/issue/summary?issueId=${issueId}`},
      {label: '1.0 details none', url: `${INSTANCE_URL}rest/dev-status/1.0/issue/detail?issueId=${issueId}&dataType=pullrequest`},
      {label: 'latest details none', url: `${INSTANCE_URL}rest/dev-status/latest/issue/detail?issueId=${issueId}&dataType=pullrequest`},
      {label: '1.0 details gitlabselfmanaged', url: `${INSTANCE_URL}rest/dev-status/1.0/issue/detail?issueId=${issueId}&applicationType=gitlabselfmanaged&dataType=pullrequest`},
      {label: 'latest details gitlabselfmanaged', url: `${INSTANCE_URL}rest/dev-status/latest/issue/detail?issueId=${issueId}&applicationType=gitlabselfmanaged&dataType=pullrequest`}
    ];

    const settled = await Promise.allSettled(probes.map(async probe => {
      const response = await get(probe.url);
      return {
        label: probe.label,
        url: probe.url,
        ok: true,
        topLevelKeys: Object.keys(response || {}),
        hasSummary: Array.isArray(response?.summary),
        hasDetail: Array.isArray(response?.detail),
        summaryCount: Array.isArray(response?.summary) ? response.summary.length : null,
        detailCount: Array.isArray(response?.detail) ? response.detail.length : null
      };
    }));
    return settled.map((result, i) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      return {
        label: probes[i].label,
        url: probes[i].url,
        ok: false,
        error: result.reason?.message || String(result.reason)
      };
    });
  }

  // ── Issue Data & Metadata ──────────────────────────────────

  // ── Assignee Search ────────────────────────────────────────

  function extractArrayUserResults(response) {
    return Array.isArray(response) ? response : null;
  }

  function normalizeJiraUserRecord(user) {
    if (!user || typeof user !== 'object') {
      return null;
    }
    const candidate = user.user && typeof user.user === 'object'
      ? user.user
      : user;
    const avatarUrl48 = candidate?.avatarUrls?.['48x48'] || candidate?.avatarUrl || '';
    return {
      ...candidate,
      accountId: candidate?.accountId || candidate?.id || '',
      name: candidate?.name || candidate?.username || candidate?.userName || '',
      key: candidate?.key || candidate?.userKey || '',
      displayName: candidate?.displayName || candidate?.name || candidate?.username || candidate?.emailAddress || '',
      emailAddress: candidate?.emailAddress || candidate?.email || '',
      avatarUrls: candidate?.avatarUrls || (avatarUrl48 ? {'48x48': avatarUrl48} : {}),
    };
  }

  function normalizeJiraUserRecords(users) {
    return (Array.isArray(users) ? users : [])
      .map(normalizeJiraUserRecord)
      .filter(Boolean);
  }

  function extractPickerUserResults(response) {
    if (Array.isArray(response)) {
      return response;
    }
    if (Array.isArray(response?.users)) {
      return response.users;
    }
    if (Array.isArray(response?.items)) {
      return response.items;
    }
    return null;
  }

  function extractInternalAssigneeUsers(response) {
    if (Array.isArray(response)) {
      return response;
    }
    if (Array.isArray(response?.users)) {
      return response.users;
    }
    if (Array.isArray(response?.items)) {
      return response.items;
    }
    if (Array.isArray(response?.results)) {
      return response.results;
    }
    if (Array.isArray(response?.values)) {
      return response.values;
    }
    return null;
  }

  function buildOrderedUserSearchStrategies(strategyType, strategies) {
    const preferredKey = String(userSearchStrategyState[strategyType] || '').trim();
    const strategyList = Array.isArray(strategies) ? strategies.filter(Boolean) : [];
    if (!preferredKey) {
      return strategyList;
    }
    const preferredStrategy = strategyList.find(strategy => strategy?.key === preferredKey);
    if (!preferredStrategy) {
      return strategyList;
    }
    return [
      preferredStrategy,
      ...strategyList.filter(strategy => strategy?.key !== preferredKey),
    ];
  }

  async function fetchUsersBySearchStrategy(strategyType, strategies) {
    const orderedStrategies = buildOrderedUserSearchStrategies(strategyType, strategies);
    let lastError;
    for (const strategy of orderedStrategies) {
      try {
        const response = await get(strategy.url);
        const users = strategy.extractUsers(response);
        if (!Array.isArray(users)) {
          throw new Error(`Unexpected response for ${strategy.key}`);
        }
        userSearchStrategyState[strategyType] = strategy.key;
        return users;
      } catch (error) {
        lastError = error;
      }
    }
    userSearchStrategyState[strategyType] = '';
    if (lastError) {
      throw lastError;
    }
    return [];
  }

  async function fetchAssignableUsers(query, issueData) {
    const issueKey = issueData?.key || '';
    const projectKey = String(issueKey).split('-')[0];
    const normalizedQuery = String(query || '').trim();
    const encodedQuery = encodeURIComponent(normalizedQuery);
    const encodedIssueKey = encodeURIComponent(issueKey);
    const encodedProjectKey = encodeURIComponent(projectKey);
    const strategies = [
      issueKey
        ? {
            key: 'internal-assignee',
            url: `${INSTANCE_URL}rest/internal/2/users/assignee?issueKey=${encodedIssueKey}&maxResults=100&query=${encodedQuery}`,
            extractUsers: extractInternalAssigneeUsers,
          }
        : null,
      issueKey
        ? {
            key: 'issue-query',
            url: `${INSTANCE_URL}rest/api/2/user/assignable/search?issueKey=${encodedIssueKey}&maxResults=20&query=${encodedQuery}`,
            extractUsers: extractArrayUserResults,
          }
        : null,
      projectKey
        ? {
            key: 'project-query',
            url: `${INSTANCE_URL}rest/api/2/user/assignable/search?project=${encodedProjectKey}&maxResults=20&query=${encodedQuery}`,
            extractUsers: extractArrayUserResults,
          }
        : null,
      issueKey
        ? {
            key: 'issue-username',
            url: `${INSTANCE_URL}rest/api/2/user/assignable/search?issueKey=${encodedIssueKey}&maxResults=20&username=${encodedQuery}`,
            extractUsers: extractArrayUserResults,
          }
        : null,
      projectKey
        ? {
            key: 'project-username',
            url: `${INSTANCE_URL}rest/api/2/user/assignable/search?project=${encodedProjectKey}&maxResults=20&username=${encodedQuery}`,
            extractUsers: extractArrayUserResults,
          }
        : null,
    ].filter(Boolean);
    const users = normalizeJiraUserRecords(await fetchUsersBySearchStrategy('assignable', strategies));
    detectSharedAvatarUrls(users);
    return proxyUserAvatars(users);
  }

  async function searchAssignableUsers(query, issueData) {
    const issueKey = issueData?.key || '';
    if (!issueKey) {
      return [];
    }
    const normalizedQuery = String(query || '').trim().toLowerCase();
    const cacheKey = `${issueKey}__${normalizedQuery}`;
    return getCachedValue(assigneeSearchCache, cacheKey, async () => {
      const users = await fetchAssignableUsers(normalizedQuery, issueData);
      return normalizeAssignableUsers(users);
    });
  }

  async function fetchUserPickerResults(query) {
    const encodedQuery = encodeURIComponent(query);
    const users = normalizeJiraUserRecords(await fetchUsersBySearchStrategy('people', [
      {
        key: 'picker-query',
        url: `${INSTANCE_URL}rest/api/2/user/picker?query=${encodedQuery}`,
        extractUsers: extractPickerUserResults,
      },
      {
        key: 'search-query',
        url: `${INSTANCE_URL}rest/api/2/user/search?query=${encodedQuery}&maxResults=20`,
        extractUsers: extractArrayUserResults,
      },
      {
        key: 'search-username',
        url: `${INSTANCE_URL}rest/api/2/user/search?username=${encodedQuery}&maxResults=20`,
        extractUsers: extractArrayUserResults,
      }
    ]));
    detectSharedAvatarUrls(users);
    await proxyUserAvatars(users);
    return normalizeAssignableUsers(users);
  }

  async function searchUserPicker(query) {
    const normalizedQuery = String(query || '').trim().toLowerCase();
    return getCachedValue(userPickerSearchCache, normalizedQuery, () => fetchUserPickerResults(normalizedQuery));
  }

  function buildClearUserOption(label = 'Clear value') {
    return buildEditOption('__clear__', label, {
      metaText: 'Remove the current user',
      rawValue: null,
    });
  }


  async function getIssueWatchers(issueKey) {
    if (!issueKey) {
      return {
        isWatching: false,
        watchCount: 0,
        watchers: []
      };
    }
    return getCachedValue(watcherListCache, issueKey, async () => {
      const [response, currentUser] = await Promise.all([
        get(`${INSTANCE_URL}rest/api/2/issue/${issueKey}/watchers`),
        getCurrentUserInfo().catch(() => null)
      ]);
      const rawWatchers = response?.watchers || [];
      detectSharedAvatarUrls(rawWatchers);
      await proxyUserAvatars(rawWatchers);
      const normalizedWatchers = normalizeWatcherUsers(rawWatchers, currentUser);
      const responseWatchCount = Number(response?.watchCount);
      return {
        isWatching: typeof response?.isWatching === 'boolean'
          ? response.isWatching
          : normalizedWatchers.some(watcher => watcher.isCurrentUser),
        watchCount: Number.isFinite(responseWatchCount) ? responseWatchCount : normalizedWatchers.length,
        watchers: normalizedWatchers
      };
    });
  }

  async function searchWatcherCandidates(query) {
    const normalizedQuery = String(query || '').trim();
    const cacheKey = normalizedQuery.toLowerCase();
    return getCachedValue(watcherSearchCache, cacheKey, async () => {
      const [response, currentUser] = await Promise.all([
        get(`${INSTANCE_URL}rest/api/2/user/picker?query=${encodeURIComponent(normalizedQuery)}`),
        getCurrentUserInfo().catch(() => null)
      ]);
      const rawUsers = Array.isArray(response)
        ? response
        : response?.users || response?.items || [];
      return normalizeWatcherUsers(rawUsers, currentUser);
    });
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

  async function searchGenericUsers(query) {
    const normalizedQuery = String(query || '').trim().toLowerCase();
    const cacheKey = `picker__${normalizedQuery}`;
    return getCachedValue(genericUserSearchCache, cacheKey, async () => {
      const response = await get(`${INSTANCE_URL}rest/api/2/user/picker?query=${encodeURIComponent(normalizedQuery)}`);
      const users = Array.isArray(response)
        ? response
        : response?.users || response?.items || [];
      return normalizeAssignableUsers(users);
    });
  }

  async function loadCustomUserFieldOptions(fieldId, issueData, currentSelections, query = '') {
    const normalizedQuery = String(query || '').trim();
    const [assignableResults, pickerResults] = await Promise.all([
      searchAssignableUsers(normalizedQuery, issueData).catch(() => []),
      searchGenericUsers(normalizedQuery).catch(() => [])
    ]);
    const baseline = userPickerLocalOptionsCache.get(fieldId) || currentSelections;
    const merged = mergeEditOptions(
      currentSelections,
      mergeEditOptions(assignableResults, mergeEditOptions(pickerResults, baseline))
    );
    userPickerLocalOptionsCache.set(fieldId, merged);
    return merged;
  }
  function getPullRequestDataCached(issueId, applicationType) {
    const cacheKey = `${issueId}__${applicationType}`;
    return getCachedValue(pullRequestCache, cacheKey, () => {
      return getPullRequestData(issueId, applicationType);
    });
  }

  function getPullRequestSummaryDataCached(issueId) {
    return getCachedValue(pullRequestCache, `summary__${issueId}`, () => {
      return getPullRequestSummaryData(issueId);
    });
  }

  function normalizePullRequests(response) {
    if (Array.isArray(response)) {
      return response.filter(Boolean);
    }

    const detailEntries = Array.isArray(response?.detail)
      ? response.detail
      : Array.isArray(response?.details)
        ? response.details
        : response ? [response] : [];

    return detailEntries
      .flatMap(entry => {
        if (Array.isArray(entry?.pullRequests)) {
          return entry.pullRequests;
        }
        if (Array.isArray(entry?.pullrequests)) {
          return entry.pullrequests;
        }
        if (Array.isArray(entry?.pullRequest)) {
          return entry.pullRequest;
        }
        return [];
      })
      .filter(Boolean);
  }

  function summarizePullRequestDebugResponse(response) {
    const detail = Array.isArray(response?.detail) ? response.detail : [];
    return {
      detailCount: detail.length,
      details: detail.map(entry => ({
        applicationType: entry?.applicationType || '',
        objectName: entry?.objectName || '',
        repoCount: Array.isArray(entry?.repositories) ? entry.repositories.length : 0,
        pullRequestCount: Array.isArray(entry?.pullRequests) ? entry.pullRequests.length : 0,
        pullRequests: (entry?.pullRequests || []).map(pr => ({
          id: pr?.id,
          name: pr?.name,
          url: pr?.url,
          status: pr?.status
        }))
      }))
    };
  }

  function summarizePullRequestSummaryResponse(response) {
    const summary = Array.isArray(response?.summary) ? response.summary : [];
    return {
      summaryCount: summary.length,
      summary: summary.map(entry => ({
        applicationType: entry?.applicationType || '',
        dataType: entry?.dataType || '',
        branchCount: entry?.branch?.overall?.count ?? entry?.branches?.overall?.count ?? null,
        repositoryCount: entry?.repository?.overall?.count ?? entry?.repositories?.overall?.count ?? null,
        commitCount: entry?.commit?.overall?.count ?? entry?.commits?.overall?.count ?? null,
        pullRequestCount: entry?.pullrequest?.overall?.count ?? entry?.pullRequest?.overall?.count ?? entry?.pullrequests?.overall?.count ?? null,
        reviewCount: entry?.review?.overall?.count ?? entry?.reviews?.overall?.count ?? null,
        buildCount: entry?.build?.overall?.count ?? entry?.builds?.overall?.count ?? null,
        deploymentCount: entry?.deployment?.overall?.count ?? entry?.deployments?.overall?.count ?? null,
        overall: entry?.overall || null,
        rawKeys: Object.keys(entry || {})
      }))
    };
  }

  // ── Labels ────────────────────────────────────────────────

  function stripSimpleHtml(value) {
    return String(value || '').replace(/<[^>]+>/g, '');
  }

  function buildLabelOption(label, extra = {}) {
    const normalizedLabel = String(label || '').trim();
    const normalizedMetaText = String(extra.metaText || '').trim();
    return buildEditOption(normalizedLabel, normalizedLabel, {
      ...extra,
      metaText: normalizedMetaText && normalizedMetaText !== normalizedLabel ? normalizedMetaText : '',
      rawValue: normalizedLabel,
    });
  }

  function normalizeLabelSuggestionPayload(payload) {
    if (Array.isArray(payload)) {
      return payload
        .map(entry => {
          if (typeof entry === 'string') {
            return buildLabelOption(entry);
          }
          return buildLabelOption(entry?.label || entry?.value || entry?.name || stripSimpleHtml(entry?.html || entry?.displayName || ''), {
            metaText: stripSimpleHtml(entry?.html || entry?.displayName || '')
          });
        })
        .filter(option => option.id);
    }
    if (Array.isArray(payload?.results)) {
      return payload.results
        .map(entry => buildLabelOption(entry?.value || stripSimpleHtml(entry?.displayName || ''), {
          metaText: stripSimpleHtml(entry?.displayName || '')
        }))
        .filter(option => option.id);
    }
    if (Array.isArray(payload?.suggestions)) {
      return payload.suggestions
        .map(entry => buildLabelOption(entry?.label || stripSimpleHtml(entry?.html || ''), {
          metaText: stripSimpleHtml(entry?.html || '')
        }))
        .filter(option => option.id);
    }
    return [];
  }

  async function fetchLabelSuggestions(queryText) {
    const normalizedQuery = String(queryText || '').trim();
    const response = await get(`${INSTANCE_URL}rest/api/2/jql/autocompletedata/suggestions?fieldName=labels&fieldValue=${encodeURIComponent(normalizedQuery)}`);
    return normalizeLabelSuggestionPayload(response);
  }

  async function getLabelSuggestions(queryText = '') {
    const rawQuery = String(queryText || '').trim();
    const cacheKey = rawQuery.toLowerCase();
    return getCachedValue(labelSuggestionCache, cacheKey, async () => {
      return fetchLabelSuggestions(rawQuery);
    });
  }

  async function hasLabelSuggestionSupport() {
    if (!labelSuggestionSupportPromise) {
      labelSuggestionSupportPromise = getLabelSuggestions('')
        .then(() => true)
        .catch(() => false);
    }
    return labelSuggestionSupportPromise;
  }

  // ── Custom Fields ──────────────────────────────────────────

  function getCustomFieldPrimitive(entry) {
    if (entry === undefined || entry === null) {
      return '';
    }
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      return String(entry);
    }
    if (entry.accountId || entry.avatarUrls || entry.emailAddress) {
      return String(entry.displayName || entry.name || entry.value || entry.key || entry.id || '');
    }
    return String(entry.name || entry.value || entry.displayName || entry.key || entry.id || '');
  }

  function buildCustomFieldOption(fieldName, entry) {
    const label = getCustomFieldPrimitive(entry);
    if (!label) {
      return null;
    }
    if (entry && typeof entry === 'object' && (entry.accountId || entry.avatarUrls || entry.emailAddress)) {
      const view = buildUserView(entry);
      const id = view.accountId || view.name || view.key;
      if (!id) {
        return null;
      }
      return buildEditOption(id, label, {
        avatarUrl: view.avatarUrl,
        initials: view.initials,
        metaText: view.emailAddress || view.name || view.key || '',
        rawValue: entry
      });
    }
    const optionId = String(entry?.id || entry?.value || entry?.name || entry?.key || label).trim();
    if (!optionId) {
      return null;
    }
    const metaText = entry?.description || entry?.child?.value || '';
    return buildEditOption(optionId, label, {
      iconUrl: entry?.iconUrl || '',
      metaText,
      rawValue: entry
    });
  }

  function buildCustomFieldValueText(fieldName, value) {
    if (Array.isArray(value)) {
      const parts = value.map(entry => getCustomFieldPrimitive(entry)).filter(Boolean);
      return `${fieldName}: ${parts.join(', ') || '--'}`;
    }
    const primitive = getCustomFieldPrimitive(value);
    return `${fieldName}: ${primitive || '--'}`;
  }

  function buildUserFieldOption(user) {
    const optionId = String(user?.accountId || user?.name || user?.key || '').trim();
    const label = String(user?.displayName || user?.name || user?.key || '').trim();
    if (!optionId || !label) {
      return null;
    }
    return buildEditOption(optionId, label, {
      avatarUrl: user?.avatarUrls?.['48x48'] || '',
      metaText: user?.emailAddress || user?.name || user?.key || '',
      rawValue: {
        accountId: user?.accountId || '',
        displayName: user?.displayName || label,
        name: user?.name || '',
        key: user?.key || '',
      }
    });
  }

  function buildUserFieldPayloadCandidates(rawUser) {
    if (!rawUser) {
      return [];
    }
    const candidates = [];
    const accountId = String(rawUser.accountId || '').trim();
    const name = String(rawUser.name || '').trim();
    const key = String(rawUser.key || '').trim();
    if (accountId) {
      candidates.push({accountId});
    }
    if (name) {
      candidates.push({name});
    }
    if (key) {
      candidates.push({key});
    }
    return candidates;
  }

  async function saveUserCustomFieldSelection(issueData, fieldId, selectedOptions, isMultiValue) {
    if (!issueData?.key || !fieldId) {
      throw new Error('Missing issue key or field id');
    }

    if (isMultiValue) {
      const fieldValue = selectedOptions
        .map(option => buildUserFieldPayloadCandidates(option?.rawValue || option)[0])
        .filter(Boolean);
      await requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
        fields: {
          [fieldId]: fieldValue
        }
      });
      return;
    }

    const selectedOption = selectedOptions[0];
    if (!selectedOption) {
      await requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
        fields: {
          [fieldId]: null
        }
      });
      return;
    }

    const payloadCandidates = buildUserFieldPayloadCandidates(selectedOption.rawValue || selectedOption);
    let lastError = null;
    for (const payload of payloadCandidates) {
      try {
        await requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
          fields: {
            [fieldId]: payload
          }
        });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Could not update user field');
  }

  function buildCustomFieldJqlOperand(value, supportDescriptor, fieldMeta) {
    if (value === undefined || value === null || value === '') {
      return '';
    }
    if (isTempoAccountField(fieldMeta)) {
      const accountId = value?.id || value;
      return String(accountId || '').trim();
    }
    if (supportDescriptor?.valueKind === 'user') {
      return String(value?.accountId || value?.key || value?.name || value?.displayName || '').trim();
    }
    if (supportDescriptor?.valueKind === 'primitive') {
      return encodeJqlValue(String(value));
    }
    const comparableValue = value?.value || value?.name || value?.displayName || value?.key || value?.id;
    return comparableValue ? encodeJqlValue(String(comparableValue)) : '';
  }

  function buildCustomFieldChipData(fieldId, fieldName, rawValue, fieldMeta, supportDescriptor) {
    const currentValues = Array.isArray(rawValue) ? rawValue.filter(value => value !== undefined && value !== null && value !== '') : [rawValue].filter(value => value !== undefined && value !== null && value !== '');
    const jqlValues = currentValues
      .map(value => buildCustomFieldJqlOperand(value, supportDescriptor, fieldMeta))
      .filter(Boolean);
    const jqlClause = !jqlValues.length
      ? ''
      : jqlValues.length === 1
        ? `${fieldName} = ${jqlValues[0]}`
        : `${fieldName} in (${jqlValues.join(', ')})`;
    const linkLabel = Array.isArray(rawValue)
      ? currentValues.map(entry => getCustomFieldPrimitive(entry)).filter(Boolean).join(', ')
      : getCustomFieldPrimitive(rawValue);
    return buildFilterChip(buildCustomFieldValueText(fieldName, rawValue), jqlClause, {
      linkLabel
    });
  }

  function isTempoAccountField(fieldMeta) {
    const schemaType = String(fieldMeta?.schema?.type || '').toLowerCase();
    const schemaCustom = String(fieldMeta?.schema?.custom || '').toLowerCase();
    return schemaType === 'account' || schemaCustom.includes('tempo-accounts');
  }

  function buildTempoAccountOption(account) {
    const id = account?.id;
    const key = String(account?.key || '').trim();
    const name = String(account?.name || key || '').trim();
    if (!id || !name) {
      return null;
    }
    const customerName = String(account?.customer?.name || '').trim();
    const categoryName = String(account?.category?.name || '').trim();
    const metaText = [key, customerName, categoryName].filter(Boolean).join(' | ');
    return buildEditOption(String(id), name, {
      metaText,
      searchText: `${name} ${key} ${customerName} ${categoryName}`,
      rawValue: account
    });
  }

  async function searchTempoAccounts(queryText, issueData) {
    const projectId = String(issueData?.fields?.project?.id || '').trim();
    if (!projectId) {
      return [];
    }
    const normalizedQuery = String(queryText || '').trim();
    const cacheKey = `${projectId}__${normalizedQuery.toLowerCase()}`;
    return getCachedValue(tempoAccountSearchCache, cacheKey, async () => {
      const tqlQuery = `status=OPEN AND (project=${projectId} OR project=GLOBAL)`;
      const url = `${INSTANCE_URL}rest/tempo-accounts/1/account/search?tqlQuery=${encodeURIComponent(tqlQuery)}&query=${encodeURIComponent(normalizedQuery)}&limit=15&offset=0`;
      const response = await get(url);
      const accounts = Array.isArray(response?.accounts) ? response.accounts : [];
      return accounts
        .map(buildTempoAccountOption)
        .filter(Boolean);
    });
  }

  async function saveTempoAccountSelection(issueData, fieldId, selectedOptions) {
    const selectedOption = selectedOptions[0];
    if (!selectedOption?.id) {
      throw new Error('Pick an account before saving');
    }
    const accountId = Number(selectedOption.id);
    const accountKey = String(selectedOption?.rawValue?.key || '').trim();
    const payloadCandidates = [
      {fields: {[fieldId]: {id: accountId}}},
      {fields: {[fieldId]: accountId}},
      {fields: {[fieldId]: {id: String(selectedOption.id)}}},
      ...(accountKey ? [{fields: {[fieldId]: {key: accountKey}}}] : [])
    ];

    let lastError;
    for (const payload of payloadCandidates) {
      try {
        await requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, payload);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Could not update account');
  }

  function getCustomFieldSupportDescriptor(fieldMeta) {
    const schemaType = String(fieldMeta?.schema?.type || '').toLowerCase();
    const itemType = String(fieldMeta?.schema?.items || '').toLowerCase();
    const schemaCustom = String(fieldMeta?.schema?.custom || '').toLowerCase();

    if (schemaCustom.includes('cascadingselect')) {
      return null;
    }

    if (schemaType === 'option') {
      return {
        selectionMode: 'single',
        valueKind: 'option'
      };
    }

    if (schemaType === 'string') {
      return {
        selectionMode: 'single',
        valueKind: 'primitive'
      };
    }

    if (schemaType === 'user') {
      return {
        selectionMode: 'single',
        valueKind: 'user'
      };
    }

    if (schemaType === 'array' && itemType === 'option') {
      return {
        selectionMode: 'multi',
        valueKind: 'option'
      };
    }

    if (schemaType === 'array' && itemType === 'string') {
      return {
        selectionMode: 'multi',
        valueKind: 'primitive'
      };
    }

    if (schemaType === 'array' && itemType === 'user') {
      return {
        selectionMode: 'multi',
        valueKind: 'user'
      };
    }

    return null;
  }

  function getPrimitiveCustomFieldEditorType(fieldMeta) {
    const schemaCustom = String(fieldMeta?.schema?.custom || '').toLowerCase();
    return schemaCustom.includes('textarea') ? 'textarea' : 'text';
  }

  function isSupportedCustomFieldAllowedValue(entry, supportDescriptor) {
    if (!supportDescriptor) {
      return false;
    }
    if (supportDescriptor.valueKind === 'primitive') {
      return typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean';
    }
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    if (supportDescriptor.valueKind === 'user') {
      return !!(entry.accountId || entry.name || entry.key || entry.displayName);
    }
    return !!(entry.id || entry.value || entry.name);
  }

  function buildCustomFieldSaveValue(rawValue, supportDescriptor) {
    if (rawValue === undefined || rawValue === null) {
      return rawValue;
    }
    if (supportDescriptor?.valueKind === 'primitive') {
      return rawValue;
    }
    if (supportDescriptor?.valueKind === 'user' && rawValue && typeof rawValue === 'object') {
      if (rawValue.accountId) {
        return {accountId: String(rawValue.accountId)};
      }
      if (rawValue.name) {
        return {name: String(rawValue.name)};
      }
      if (rawValue.key) {
        return {key: String(rawValue.key)};
      }
    }
    if (typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      return rawValue;
    }
    if (rawValue.id) {
      return {id: String(rawValue.id)};
    }
    if (rawValue.value) {
      return {value: rawValue.value};
    }
    if (rawValue.name) {
      return {name: rawValue.name};
    }
    if (rawValue.key) {
      return {key: rawValue.key};
    }
    return rawValue;
  }

  function normalizeIssueTypeOptions(allowedIssueTypes, currentIssueType) {
    const currentIsSubtask = currentIssueType?.subtask === true;
    return (Array.isArray(allowedIssueTypes) ? allowedIssueTypes : [])
      .filter(issueType => issueType?.id && issueType?.name)
      .filter(issueType => {
        if (typeof issueType?.subtask !== 'boolean' || typeof currentIssueType?.subtask !== 'boolean') {
          return true;
        }
        return issueType.subtask === currentIsSubtask;
      })
      .map(issueType => buildEditOption(issueType.id, issueType.name, {
        iconUrl: issueType.iconUrl || '',
        metaText: issueType.description || '',
        rawValue: issueType
      }));
  }

  async function getCustomFieldEditorDefinition(fieldId, issueData) {
    const capability = await getEditableFieldCapability(issueData, fieldId);
    const fieldMeta = capability.fieldMeta;
    const fieldName = String(issueData?.names?.[fieldId] || fieldMeta?.name || fieldId);
    const schemaType = String(fieldMeta?.schema?.type || '').toLowerCase();
    const itemType = String(fieldMeta?.schema?.items || '').toLowerCase();

    if (capability.editable && fieldMeta && isTempoAccountField(fieldMeta)) {
      const currentAccount = issueData?.fields?.[fieldId];
      const currentOption = currentAccount
        ? buildTempoAccountOption(currentAccount)
        : null;
      return {
        fieldKey: fieldId,
        editorType: 'tempo-account-search',
        label: fieldName,
        fieldMeta,
        supportDescriptor: {selectionMode: 'single', valueKind: 'tempo-account'},
        selectionMode: 'single',
        currentText: currentAccount ? buildCustomFieldValueText(fieldName, currentAccount) : `${fieldName}: --`,
        currentOptionId: currentOption?.id || null,
        currentSelections: currentOption ? [currentOption] : [],
        initialInputValue: '',
        inputPlaceholder: 'Search accounts',
        loadOptions: async () => mergeEditOptions(currentOption ? [currentOption] : [], await searchTempoAccounts('', issueData)),
        searchOptions: query => searchTempoAccounts(query, issueData),
        save: selectedOptions => saveTempoAccountSelection(issueData, fieldId, selectedOptions),
        successMessage: selectedOptions => {
          const selectedOption = selectedOptions[0];
          return selectedOption?.label
            ? `${fieldName} set to ${selectedOption.label}`
            : `${fieldName} updated`;
        }
      };
    }

    if (capability.editable && fieldMeta && (schemaType === 'user' || (schemaType === 'array' && itemType === 'user'))) {
      const operations = capability.operations || [];
      if (!operations.includes('set')) {
        return null;
      }

      const isMultiValue = schemaType === 'array' && itemType === 'user';
      const currentValue = issueData?.fields?.[fieldId];
      const currentEntries = isMultiValue
        ? (Array.isArray(currentValue) ? currentValue : [])
        : (currentValue ? [currentValue] : []);
      const currentSelections = currentEntries
        .map(buildUserFieldOption)
        .filter(Boolean);
      return {
        fieldKey: fieldId,
        editorType: 'user-search',
        label: fieldName,
        fieldMeta,
        supportDescriptor: {selectionMode: isMultiValue ? 'multi' : 'single', valueKind: 'user'},
        selectionMode: isMultiValue ? 'multi' : 'single',
        currentText: buildCustomFieldValueText(fieldName, currentValue),
        currentOptionId: !isMultiValue && currentSelections[0] ? currentSelections[0].id : null,
        currentSelections,
        initialInputValue: '',
        inputPlaceholder: 'Search users',
        loadOptions: async () => loadCustomUserFieldOptions(fieldId, issueData, currentSelections),
        searchOptions: async query => loadCustomUserFieldOptions(fieldId, issueData, currentSelections, query),
        save: selectedOptions => saveUserCustomFieldSelection(issueData, fieldId, selectedOptions, isMultiValue),
        successMessage: selectedOptions => {
          if (!selectedOptions.length) {
            return `${fieldName} cleared`;
          }
          return isMultiValue
            ? `${fieldName} updated`
            : `${fieldName} set to ${selectedOptions[0].label}`;
        }
      };
    }

    return getSupportedCustomFieldDefinition(fieldId, issueData);
  }

  async function getSupportedCustomFieldDefinition(fieldId, issueData) {
    const capability = await getEditableFieldCapability(issueData, fieldId);
    const fieldMeta = capability.fieldMeta;
    const fieldName = String(issueData?.names?.[fieldId] || fieldMeta?.name || fieldId);
    if (!capability.editable || !fieldMeta) {
      return null;
    }

    const supportDescriptor = getCustomFieldSupportDescriptor(fieldMeta);
    if (!supportDescriptor) {
      return null;
    }

    const operations = capability.operations || [];
    const isMultiValue = supportDescriptor.selectionMode === 'multi';
    const currentValue = issueData?.fields?.[fieldId];
    const currentEntries = isMultiValue
      ? (Array.isArray(currentValue) ? currentValue : [])
      : (currentValue ? [currentValue] : []);
    const currentSelections = currentEntries
      .map(entry => buildCustomFieldOption(fieldName, entry))
      .filter(Boolean);
    const allowedOptions = (Array.isArray(capability.allowedValues) ? capability.allowedValues : [])
      .filter(entry => isSupportedCustomFieldAllowedValue(entry, supportDescriptor))
      .map(entry => buildCustomFieldOption(fieldName, entry))
      .filter(Boolean);
    const allOptions = mergeEditOptions(currentSelections, allowedOptions);

    if (!allOptions.length && supportDescriptor.valueKind !== 'user') {
      return null;
    }

    if (isMultiValue && !operations.includes('set')) {
      return null;
    }
    if (!isMultiValue && !operations.includes('set')) {
      return null;
    }

    const isUserField = supportDescriptor.valueKind === 'user';
    const isPrimitiveField = supportDescriptor.valueKind === 'primitive';
    const clearUserOption = isUserField ? buildClearUserOption(`Clear ${fieldName}`) : null;

    if (isPrimitiveField && !isMultiValue) {
      const currentInputValue = currentValue === undefined || currentValue === null
        ? ''
        : String(currentValue);
      const editorType = getPrimitiveCustomFieldEditorType(fieldMeta);
      return {
        fieldKey: fieldId,
        editorType,
        label: fieldName,
        fieldMeta,
        supportDescriptor,
        selectionMode: 'text',
        currentText: buildCustomFieldValueText(fieldName, currentValue),
        currentOptionId: null,
        currentSelections,
        initialInputValue: currentInputValue,
        inputPlaceholder: editorType === 'textarea' ? `Enter ${fieldName.toLowerCase()}` : `Type ${fieldName.toLowerCase()}`,
        showActionButtons: true,
        loadOptions: async () => [],
        save: (selectedOptions, editState) => {
          const nextValue = String(editState?.inputValue || '');
          const hasValue = nextValue.trim().length > 0;
          return requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
            fields: {
              [fieldId]: hasValue ? nextValue : null
            }
          });
        },
        successMessage: (selectedOptions, editState) => {
          const nextValue = String(editState?.inputValue || '').trim();
          return nextValue ? `${fieldName} updated` : `${fieldName} cleared`;
        }
      };
    }

    if (isPrimitiveField && isMultiValue) {
      return null;
    }

    return {
      fieldKey: fieldId,
      editorType: isUserField ? 'user-search' : (isMultiValue ? 'multi-select' : 'single-select'),
      label: fieldName,
      fieldMeta,
      supportDescriptor,
      selectionMode: isMultiValue ? 'multi' : 'single',
      currentText: buildCustomFieldValueText(fieldName, currentValue),
      currentOptionId: !isMultiValue && currentSelections[0] ? currentSelections[0].id : null,
      currentSelections,
      initialInputValue: isMultiValue ? '' : '',
      inputPlaceholder: isUserField ? 'Search users' : undefined,
      loadOptions: async () => isUserField ? mergeEditOptions([clearUserOption], currentSelections) : allOptions,
      searchOptions: isUserField ? (async query => {
        const [pickerResults, assignableResults] = await Promise.all([
          searchUserPicker(query),
          searchAssignableUsers(query, issueData).catch(() => [])
        ]);
        const baseline = userPickerLocalOptionsCache.get(fieldId) || currentSelections;
        const merged = mergeEditOptions(pickerResults, mergeEditOptions(assignableResults, baseline));
        userPickerLocalOptionsCache.set(fieldId, merged);
        return mergeEditOptions([clearUserOption], merged);
      }) : undefined,
      save: selectedOptions => {
        const fieldValue = isMultiValue
          ? selectedOptions.map(option => buildCustomFieldSaveValue(option.rawValue, supportDescriptor))
          : buildCustomFieldSaveValue(selectedOptions[0]?.rawValue, supportDescriptor);
        return requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
          fields: {
            [fieldId]: isMultiValue ? fieldValue : (fieldValue ?? null)
          }
        });
      },
      successMessage: selectedOptions => selectedOptions[0]?.id === '__clear__'
        ? `${fieldName} cleared`
        : `${fieldName} updated`
    };
  }

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
      const supportedDefinition = await getCustomFieldEditorDefinition(fieldId, issueData).catch(() => null);
      const hasDisplayValue = Array.isArray(rawValue)
        ? rawValue.some(value => value !== undefined && value !== null && value !== '')
        : !(rawValue === undefined || rawValue === null || rawValue === '');
      if (supportedDefinition) {
        const baseChip = hasDisplayValue
          ? buildCustomFieldChipData(fieldId, fieldName, rawValue, supportedDefinition.fieldMeta, supportedDefinition.supportDescriptor)
          : buildFilterChip(`${fieldName}: --`, '');
        chipsByRow[row].push(buildEditableFieldChip(fieldId, baseChip, state, {
          canEdit: true,
          editTitle: `Edit ${fieldName}`
        }));
        continue;
      }
      if (!hasDisplayValue) {
        chipsByRow[row].push(buildEditableFieldChip(fieldId, buildFilterChip(`${fieldName}: --`, ''), state, {
          canEdit: false
        }));
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

  function readSprintBoardRefsFromIssue(issueData) {
    const projectKey = String(issueData?.key || '').split('-')[0];
    const seen = new Set();
    const boardRefs = [];

    getIssueSprintEntries(issueData).forEach(entry => {
      const candidateBoardIds = [];
      if (typeof entry === 'string') {
        ['rapidViewId', 'boardId', 'originBoardId'].forEach(fieldName => {
          const match = entry.match(new RegExp(`${fieldName}=([^,\\]]+)`, 'i'));
          if (match && match[1]) {
            candidateBoardIds.push(match[1]);
          }
        });
      } else {
        candidateBoardIds.push(
          entry.rapidViewId,
          entry.boardId,
          entry.originBoardId,
          entry.board?.id,
          entry.rapidView?.id
        );
      }

      candidateBoardIds.forEach(candidateId => {
        const boardId = String(candidateId || '').trim();
        if (!boardId || seen.has(boardId)) {
          return;
        }
        seen.add(boardId);
        boardRefs.push({
          id: boardId,
          name: String(entry?.board?.name || entry?.rapidView?.name || ''),
          projectKey
        });
      });
    });

    return boardRefs;
  }

  function formatFixVersionText(fixVersions) {
    return (fixVersions || [])
      .map(version => version.name)
      .filter(Boolean)
      .join(', ');
  }

  function formatVersionText(versions) {
    return formatFixVersionText(versions);
  }

  function formatEnvironmentDisplayText(environment) {
    const normalizedText = String(environment || '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalizedText) {
      return '--';
    }
    return normalizedText.length > 120
      ? `${normalizedText.slice(0, 117).trimEnd()}...`
      : normalizedText;
  }

  function getVisibleSprintsForDisplay(sprints) {
    const sprintList = Array.isArray(sprints) ? sprints : [];
    const activeSprints = sprintList.filter(sprint => String(sprint?.state || '').toLowerCase() === 'active');
    return activeSprints.length
      ? activeSprints
      : (sprintList.every(sprint => String(sprint?.state || '').toLowerCase() === 'closed')
          ? sprintList.slice(-1)
          : sprintList);
  }

  function formatSprintText(sprints) {
    const visibleSprints = getVisibleSprintsForDisplay(sprints);
    return visibleSprints
      .map(sprint => sprint.state ? `${sprint.name} (${sprint.state})` : sprint.name)
      .filter(Boolean)
      .join(', ');
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

  function buildCommentPermalink(issueKey, commentId) {
    if (!issueKey || !commentId) {
      return '';
    }
    return `${INSTANCE_URL}browse/${issueKey}?focusedCommentId=${commentId}&page=com.atlassian.jira.plugin.system.issuetabpanels:comment-tabpanel#comment-${commentId}`;
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

  // ── Pull Request Display ───────────────────────────────────

  function formatPullRequestTitle(pr) {
    const id = pr?.id || pr?.number || pr?.key || '';
    const title = pr?.name || pr?.title || 'Untitled pull request';
    return id ? '[' + id + '] ' + title : title;
  }

  function formatPullRequestAuthor(pr) {
    return pr?.author?.name || pr?.author?.displayName || pr?.author?.username || pr?.author?.email || '--';
  }

  function formatPullRequestBranch(pr) {
    const source = pr?.source?.branch || pr?.sourceBranch || pr?.fromRef?.displayId || pr?.fromRef?.id || pr?.source?.displayId || '';
    const target = pr?.destination?.branch || pr?.targetBranch || pr?.toRef?.displayId || pr?.toRef?.id || pr?.destination?.displayId || '';
    if (source && target) {
      return source + ' --> ' + target;
    }
    return source || target || '--';
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

  function formatSprintOptionLabel(sprint) {
    if (!sprint) {
      return '';
    }
    return sprint.state ? `${sprint.name} (${String(sprint.state).toUpperCase()})` : sprint.name;
  }


  // ── Edit UI Presentation ───────────────────────────────────


  function buildActiveEditPresentation(fieldKey, state, options = {}) {
    const editState = state?.editState;
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
    const filteredOptions = isTextEditor ? [] : filterEditOptions(editState.options, editState.inputValue).map(option => ({
      ...option,
      fieldKey,
      isSelected: option.isGroupLabel ? false : selectedOptionIds.has(option.id),
      isMultiSelect,
      title: option.label
    }));
    const selectedValues = isMultiSelect
      ? (editState.selectedOptions || []).map(option => ({
          ...option,
          title: option.label
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

  async function getCandidateSprintBoards(issueData) {
    const projectKey = String(issueData?.key || '').split('-')[0];
    return mergeSprintBoards(projectKey, await getProjectSprintBoards(issueData), readSprintBoardRefsFromIssue(issueData));
  }

  async function getProjectSprintOptions(issueData) {
    const projectKey = String(issueData?.key || '').split('-')[0];
    if (!projectKey) {
      return {
        activeSprints: [],
        upcomingSprint: null
      };
    }
    const issueBoardIdsKey = readSprintBoardRefsFromIssue(issueData)
      .map(board => String(board.id || ''))
      .filter(Boolean)
      .sort()
      .join(',');
    const cacheKey = `${projectKey}__${issueBoardIdsKey}`;
    if (projectSprintOptionsPromises.has(cacheKey)) {
      return projectSprintOptionsPromises.get(cacheKey);
    }

    const sprintPromise = (async () => {
      const sprintFieldIds = await getSprintFieldIds(INSTANCE_URL);
      if (!sprintFieldIds.length) {
        return {
          activeSprints: [],
          upcomingSprint: null
        };
      }

      const boards = await getCandidateSprintBoards(issueData);
      if (!boards.length) {
        return {
          activeSprints: [],
          upcomingSprint: null
        };
      }

      const sprintMap = new Map();
      const sprintResponses = await Promise.allSettled(boards.map(board => {
        return get(`${INSTANCE_URL}rest/agile/1.0/board/${board.id}/sprint?state=active,future&maxResults=50`)
          .then(response => ({board, response}));
      }));

      sprintResponses.forEach(result => {
        if (result.status !== 'fulfilled') {
          return;
        }
        const board = result.value?.board || {};
        const sprints = Array.isArray(result.value?.response?.values) ? result.value.response.values : [];
        sprints.forEach(sprint => {
          if (!sprint?.id || !sprint?.name) {
            return;
          }
          const sprintId = String(sprint.id);
          const existingSprint = sprintMap.get(sprintId);
          const boardRefs = Array.isArray(existingSprint?.boardRefs) ? existingSprint.boardRefs.slice() : [];
          const boardRefKey = String(board.id || '');
          if (boardRefKey && !boardRefs.some(ref => String(ref.id) === boardRefKey)) {
            boardRefs.push({
              id: board.id,
              name: board.name || '',
              projectKey: board.projectKey || projectKey
            });
          }
          sprintMap.set(sprintId, {
            ...(existingSprint || {}),
            ...sprint,
            boardRefs
          });
        });
      });

      readSprintsFromIssue(issueData).forEach(sprint => {
        if (!sprint?.id || !sprint?.name) {
          return;
        }
        const sprintId = String(sprint.id);
        if (sprintMap.has(sprintId)) {
          return;
        }
        sprintMap.set(sprintId, {
          ...sprint,
          boardRefs: []
        });
      });

      const sortedSprints = [...sprintMap.values()].sort((left, right) => {
        const stateOrder = compareSprintState(left?.state, right?.state);
        if (stateOrder !== 0) {
          return stateOrder;
        }
        return String(left?.name || '').localeCompare(String(right?.name || ''));
      });

      const activeSprints = sortedSprints.filter(sprint => String(sprint?.state || '').toLowerCase() === 'active');
      const upcomingSprint = sortedSprints.find(sprint => String(sprint?.state || '').toLowerCase() === 'future') || null;

      return {
        activeSprints,
        upcomingSprint
      };
    })().catch(error => {
      projectSprintOptionsPromises.delete(cacheKey);
      return {
        activeSprints: [],
        upcomingSprint: null
      };
    });

    projectSprintOptionsPromises.set(cacheKey, sprintPromise);
    return sprintPromise;
  }

  function buildDefaultActivityIndicators() {
    return [
      {
        iconHtml: '<span class="_JX_history_toggle_icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" focusable="false" role="presentation"><circle cx="12" cy="12" r="8.25" fill="none" stroke="currentColor" stroke-width="1.75"></circle><path d="M12 7.75v4.6l3.1 1.9" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"></path></svg></span>',
        label: 'History',
        isHistory: true,
        clickable: true,
        title: 'View change history',
        ariaLabel: 'View change history'
      }
    ].map(item => ({
      ...item,
      title: item.title || (item.hasCount ? item.count + ' ' + item.label.toLowerCase() : item.label),
      ariaLabel: item.ariaLabel || item.title || item.label
    }));
  }

  // ── Quick Actions ──────────────────────────────────────────

  const {
    buildUserView,
    detectSharedAvatarUrls,
    normalizeAssignableUsers,
    normalizeWatcherUsers,
    proxyUserAvatars,
  } = createContentPeopleHelpers({
    areSameJiraUser,
    buildEditOption,
    cacheKnownJiraUser,
    cacheKnownJiraUsers,
    getDisplayImageUrl,
    sharedAvatarUrls,
  });

  const {buildPopupDisplayData} = createContentDisplayHelpers({
    buildActivityIndicatorsDefault: buildDefaultActivityIndicators,
    buildActiveEditPresentation,
    buildHistoryAttachmentLookup,
    buildCommentsForDisplay,
    buildCustomFieldChips,
    buildEditableFieldChip,
    buildFilterChip,
    buildLabelsChip,
    buildLinkHoverTitle,
    buildQuickActionViewData,
    buildTimeTrackingSectionPresentation,
    buildUserView,
    customFields,
    displayFields,
    emptyWatchersState,
    encodeJqlValue,
    formatChangelogForDisplay,
    formatEnvironmentDisplayText,
    formatFixVersionText,
    formatPullRequestAuthor,
    formatPullRequestBranch,
    formatPullRequestTitle,
    formatSprintText,
    getEditableFieldCapability,
    getTransitionOptions,
    getVisibleSprintsForDisplay,
    hasLabelSuggestionSupport,
    instanceUrl: INSTANCE_URL,
    layoutContentBlocks,
    loaderGifUrl,
    normalizeCommentSortOrder,
    normalizeIssueTypeOptions,
    normalizeRichHtml,
    readSprintsFromIssue,
    resolveIssueLinkage,
    scopeJqlToProject,
    showPullRequests,
    tooltipLayout,
    buildPreviewAttachments,
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
  async function renderIssuePopup(state) {
    if (!state?.issueData) {
      return;
    }
    const commentComposerDraft = state.key === activeCommentContext?.issueKey
      ? captureCommentComposerDraft()
      : null;
    const displayData = await buildPopupDisplayData(state);
    if (state !== popupState) {
      return;
    }
    if (activeCommentContext?.issueKey && activeCommentContext.issueKey !== state.key) {
      discardCommentComposerDraft().catch(() => {});
    }
    const existingCommentInput = container.find('._JX_comment_input');
    if (existingCommentInput.length) {
      commentComposerDraftValue = existingCommentInput.val() || '';
      const existingCommentInputElement = existingCommentInput.get(0);
      if (existingCommentInputElement) {
        commentComposerHadFocus = document.activeElement === existingCommentInputElement;
        commentComposerSelectionStart = typeof existingCommentInputElement.selectionStart === 'number' ? existingCommentInputElement.selectionStart : commentComposerDraftValue.length;
        commentComposerSelectionEnd = typeof existingCommentInputElement.selectionEnd === 'number' ? existingCommentInputElement.selectionEnd : commentComposerDraftValue.length;
      }
    }
    const existingContentBlocks = container.find('._JX_content_blocks');
    const savedScrollLeft = existingContentBlocks.length ? existingContentBlocks.scrollLeft() : 0;
    const savedScrollTop = existingContentBlocks.length ? existingContentBlocks.scrollTop() : 0;
    container.html(Mustache.render(annotationTemplate, displayData));
    const contentBlocksContainer = container.find('._JX_content_blocks');
    if (contentBlocksContainer.length) {
      const blocks = contentBlocksContainer.children('[data-content-block]');
      const order = layoutContentBlocks;
      blocks.sort((a, b) => {
        const ai = order.indexOf(a.getAttribute('data-content-block'));
        const bi = order.indexOf(b.getAttribute('data-content-block'));
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });
      contentBlocksContainer.prepend(blocks);
    }
    activeCommentContext = displayFields.comments ? {issueKey: state.key, issueId: state.issueData.id} : null;
    const nextContentBlocks = container.find('._JX_content_blocks');
    if (nextContentBlocks.length) {
      nextContentBlocks.scrollLeft(savedScrollLeft);
      nextContentBlocks.scrollTop(savedScrollTop);
    }
    restoreCommentComposerDraft(commentComposerDraft);
    restoreCommentComposerState();
    renderCommentUploads();
    renderCommentMentionSuggestions();
    syncCommentComposerState();
    if (!containerPinned) {
      container.css(computeVisibleContainerPosition(state.pointerX, state.pointerY));
    }
    if (state.editState?.fieldKey) {
      const input = container.find('._JX_edit_input')[0];
      if (input) {
        input.focus();
        const maxIndex = input.value.length;
        const selectionStart = Math.min(maxIndex, Number.isInteger(state.editState.selectionStart) ? state.editState.selectionStart : maxIndex);
        const selectionEnd = Math.min(maxIndex, Number.isInteger(state.editState.selectionEnd) ? state.editState.selectionEnd : maxIndex);
        input.setSelectionRange(selectionStart, selectionEnd);
      }
      } else if (state.timeTrackingEditState?.activeInputField) {
        const input = container.find(`._JX_time_tracking_input[data-time-tracking-field="${state.timeTrackingEditState.activeInputField}"]`)[0];
        if (input) {
          input.focus();
        if (typeof input.setSelectionRange === 'function' && input.type !== 'date') {
          const maxIndex = input.value.length;
          const selectionStart = Math.min(maxIndex, Number.isInteger(state.timeTrackingEditState.selectionStart) ? state.timeTrackingEditState.selectionStart : maxIndex);
          const selectionEnd = Math.min(maxIndex, Number.isInteger(state.timeTrackingEditState.selectionEnd) ? state.timeTrackingEditState.selectionEnd : maxIndex);
          input.setSelectionRange(selectionStart, selectionEnd);
          }
        }
      } else if (state.descriptionEditState?.open) {
        const input = container.find('._JX_description_input')[0];
        if (input) {
          const nextValue = String(state.descriptionEditState.inputValue || '');
          if (input.value !== nextValue) {
            input.value = nextValue;
          }
          input.focus();
          const maxIndex = input.value.length;
          const selectionStart = Math.min(maxIndex, Number.isInteger(state.descriptionEditState.selectionStart) ? state.descriptionEditState.selectionStart : maxIndex);
          const selectionEnd = Math.min(maxIndex, Number.isInteger(state.descriptionEditState.selectionEnd) ? state.descriptionEditState.selectionEnd : maxIndex);
          input.setSelectionRange(selectionStart, selectionEnd);
        }
      } else if (state.watchersState?.open && state.watchersState.focusSearch) {
        const input = container.find('._JX_watchers_search_input')[0];
        if (input) {
          input.focus();
          const maxIndex = input.value.length;
          input.setSelectionRange(maxIndex, maxIndex);
        }
      }
    if (state.commentSession?.mode === 'edit' && state.commentSession.commentId) {
      const commentInput = container.find(`._JX_comment_edit_input[data-comment-id="${state.commentSession.commentId}"]`)[0];
      if (commentInput) {
        commentInput.focus();
        const maxIndex = commentInput.value.length;
        const selectionStart = Math.min(maxIndex, Number.isInteger(state.commentSession.selectionStart) ? state.commentSession.selectionStart : maxIndex);
        const selectionEnd = Math.min(maxIndex, Number.isInteger(state.commentSession.selectionEnd) ? state.commentSession.selectionEnd : maxIndex);
        commentInput.setSelectionRange(selectionStart, selectionEnd);
      }
    }
    renderCommentEditMentionSuggestions();
    constrainEditPopoversToViewport();
  }
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
    await renderUpdatedPopupState(currentState => ({
      ...currentState,
      watchersState: buildNextWatchersState(currentState.watchersState, {
        open: true,
        loading: true,
        errorMessage: '',
        addFeedback: null,
        removeFeedback: null,
        focusSearch: true,
      })
    }));

    try {
      const watcherData = await getIssueWatchers(popupState.issueData.key);
      if (!popupState?.watchersState?.open) {
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
      if (!popupState?.watchersState?.open) {
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

  function closeWatchersPanel() {
    if (!popupState?.watchersState?.open) {
      return;
    }
    clearWatchersFeedbackTimer();
    renderUpdatedPopupState(currentState => ({
      ...currentState,
      watchersState: buildNextWatchersState(currentState.watchersState, {
        open: false,
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
      })
    })).catch(() => {});
  }

  function closeHistoryFlyout() {
    if (!popupState?.historyOpen) {
      return;
    }
    popupState = {
      ...popupState,
      historyOpen: false
    };
    renderIssuePopup(popupState).catch(() => {});
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
  // ── Field Editing ─────────────────────────────────────────
  async function handleQuickAction(actionKey) {
    if (!popupState?.issueData || popupState.actionLoadingKey) {
      return;
    }
    const action = (popupState.quickActions || []).find(candidate => candidate.key === actionKey);
    if (!action) {
      return;
    }

    await renderUpdatedPopupState(currentState => ({
      ...currentState,
      actionsOpen: false,
      actionLoadingKey: action.key,
      actionError: '',
      lastActionSuccess: '',
    }));

    try {
      const successMessage = await executeQuickAction(action, popupState.issueData);
      await refreshPopupIssueState(successMessage);
    } catch (error) {
      await renderUpdatedPopupState(currentState => ({
        ...currentState,
        actionLoadingKey: '',
        actionError: buildQuickActionError(error),
        lastActionSuccess: '',
      }));
    }
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

  function scheduleLabelSearchOptionsForActiveEdit(fieldKey, queryText, requestId) {
    if (labelSearchTimeoutId) {
      clearTimeout(labelSearchTimeoutId);
    }
    labelSearchTimeoutId = setTimeout(() => {
      labelSearchTimeoutId = null;
      runSearchOptionsForActiveEdit(fieldKey, queryText, requestId).catch(() => {});
    }, 180);
  }
  async function startFieldEdit(fieldKey) {
    if (!popupState?.issueData) {
      return;
    }
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
          errorMessage: '',
          selectionStart,
          selectionEnd
        })
      };
      renderIssuePopup(popupState).catch(() => {});

      if (popupState.editState.editorType === 'label-search') {
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
        scheduleLabelSearchOptionsForActiveEdit(popupState.editState.fieldKey, normalizedValue, searchRequestId);
      }
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
      popupState.editState.editorType !== 'label-search' &&
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
        errorMessage: '',
        selectionStart: nextSelectionStart,
        selectionEnd: nextSelectionEnd
      }
    };
    renderIssuePopup(popupState).catch(() => {});

    if (popupState.editState.editorType === 'user-search' || popupState.editState.editorType === 'issue-search' || popupState.editState.editorType === 'label-search' || popupState.editState.editorType === 'tempo-account-search') {
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
      if (popupState.editState.editorType === 'label-search') {
        scheduleLabelSearchOptionsForActiveEdit(popupState.editState.fieldKey, normalizedValue, searchRequestId);
      } else {
        triggerSearchOptionsForActiveEdit(popupState.editState.fieldKey, normalizedValue, searchRequestId);
      }
    }
  }

  function selectFieldEditOption(optionId) {
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
        errorMessage: '',
        selectionStart: option.label.length,
        selectionEnd: option.label.length
      }
    };
    renderIssuePopup(popupState).catch(() => {});
    if (popupState.editState.editorType === 'transition-select') {
      submitFieldEdit(popupState.editState.fieldKey).catch(() => {});
    }
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
        invalidatePopupCaches();
        const refreshedIssueData = await getIssueMetaData(issueKey);
        await normalizeIssueImages(refreshedIssueData);

        let refreshedPullRequests = [];
        if (showPullRequests) {
          try {
            const pullRequestResponse = await getPullRequestDataCached(refreshedIssueData.id);
            refreshedPullRequests = normalizePullRequests(pullRequestResponse);
            await normalizePullRequestImages(refreshedPullRequests).catch(() => {});
          } catch (ex) {
            refreshedPullRequests = [];
          }
        }

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
    cancel: 'a, button, input, textarea, img, ._JX_description, ._JX_comments, ._JX_comment_body, ._JX_description_text, ._JX_related_table, ._JX_history_flyout, ._JX_watchers_panel'
  }, container);
  
  // ── Clipboard & Copy ──────────────────────────────────────
  function buildPrettyLinkPayload(sourceElement) {
    const url = sourceElement?.getAttribute('data-url') || sourceElement?.getAttribute('href') || '';
    const ticket = sourceElement?.getAttribute('data-ticket') || '';
    const title = sourceElement?.getAttribute('data-title') || '';
    const label = `[${ticket}] ${title}`.trim();
    const link = document.createElement('a');
    link.href = url;
    link.textContent = label;
    return {
      html: link.outerHTML,
      text: url
    };
  }

  function copyPrettyLinkFallback(html, text) {
    return new Promise((resolve, reject) => {
      const onCopy = event => {
        event.preventDefault();
        event.clipboardData.setData('text/html', html);
        event.clipboardData.setData('text/plain', text);
      };
      document.addEventListener('copy', onCopy, {once: true});
      const success = document.execCommand('copy');
      if (!success) {
        reject(new Error('Copy command failed'));
        return;
      }
      resolve();
    });
  }

  async function copyPrettyLink(sourceElement) {
    const {html, text} = buildPrettyLinkPayload(sourceElement);
    try {
      if (navigator.clipboard && window.ClipboardItem && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([html], {type: 'text/html'}),
            'text/plain': new Blob([text], {type: 'text/plain'})
          })
        ]);
        snackBar('Copied!');
        return;
      }
    } catch (ex) {
      // fall through to fallback copy path
    }

    try {
      await copyPrettyLinkFallback(html, text);
      snackBar('Copied!');
    } catch (ex) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        snackBar('Copied as text');
      } else {
        snackBar('There was an error!');
      }
    }
  }

  // ── Event Handlers ────────────────────────────────────────
  $(document.body).on('click', '._JX_open_options', function (e) {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({action: 'openOptionsPage'});
  });

  $(document.body).on('click', '._JX_copy_link', function (e) {
    e.preventDefault();
    copyPrettyLink(e.currentTarget).catch(() => snackBar('There was an error!'));
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

  $(document.body).on('click', '._JX_actions_toggle', function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (!popupState) {
      return;
    }
    popupState = {
      ...popupState,
      actionsOpen: !popupState.actionsOpen
    };
    renderIssuePopup(popupState).catch(() => {});
  });

  $(document.body).on('click', '._JX_children_sort', function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (!popupState) {
      return;
    }
    const column = e.currentTarget.getAttribute('data-sort-column') || '';
    popupState = {
      ...popupState,
      childrenSort: toggleChildrenSort(popupState.childrenSort, column)
    };
    renderIssuePopup(popupState).catch(() => {});
  });

  $(document.body).on('click', '._JX_pr_sort', function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (!popupState) {
      return;
    }
    const column = e.currentTarget.getAttribute('data-sort-column') || '';
    popupState = {
      ...popupState,
      pullRequestsSort: togglePullRequestsSort(popupState.pullRequestsSort, column)
    };
    renderIssuePopup(popupState).catch(() => {});
  });

  $(document.body).on('click', '._JX_comment_sort_toggle', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const nextCommentSortOrder = toggleCommentSortOrder(popupState?.commentSortOrder);
    commentSortOrderPreference = nextCommentSortOrder;
    if (popupState) {
      popupState = {
        ...popupState,
        commentSortOrder: nextCommentSortOrder
      };
      renderIssuePopup(popupState).catch(() => {});
    }
    storageLocalSet({
      [COMMENT_SORT_ORDER_STORAGE_KEY]: nextCommentSortOrder
    }).catch(() => {});
  });

  $(document.body).on('click', '._JX_watchers_trigger', function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (popupState?.historyOpen) {
      popupState = {
        ...popupState,
        historyOpen: false
      };
    }
    if (popupState?.watchersState?.open) {
      closeWatchersPanel();
      return;
    }
    openWatchersPanel().catch(() => {});
  });

  $(document.body).on('click', '._JX_watchers_close', function (e) {
    e.preventDefault();
    e.stopPropagation();
    closeWatchersPanel();
  });

  $(document.body).on('click', '._JX_watchers_search_result', function (e) {
    e.preventDefault();
    e.stopPropagation();
    addWatcherFromPanel(e.currentTarget.getAttribute('data-watcher-id') || '').catch(() => {});
  });

  $(document.body).on('click', '._JX_watchers_remove', function (e) {
    e.preventDefault();
    e.stopPropagation();
    removeWatcherFromPanel(e.currentTarget.getAttribute('data-watcher-id') || '').catch(() => {});
  });

  $(document.body).on('input', '._JX_watchers_search_input', function (e) {
    e.stopPropagation();
    updateWatchersSearch(e.currentTarget.value);
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
    popupState = {
      ...popupState,
      actionsOpen: false
    };
    renderIssuePopup(popupState).catch(() => {});
  });

    $(document.body).on('mousedown', function (e) {
      if (!popupState?.watchersState?.open) {
        return;
      }
      if ($(e.target).closest('._JX_watchers_group').length) {
        return;
      }
      closeWatchersPanel();
  });

  $(document.body).on('click', '._JX_history_toggle', function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (!popupState) {
      return;
    }
    if (popupState.watchersState?.open) {
      closeWatchersPanel();
    }
    const nextOpen = !popupState.historyOpen;
    popupState = {
      ...popupState,
      historyOpen: nextOpen
    };
    if (nextOpen && !popupState.changelogData && !popupState.changelogLoading) {
      popupState.changelogLoading = true;
      renderIssuePopup(popupState).catch(() => {});
      const issueKey = popupState.key;
      getIssueChangelog(issueKey).then(changelog => {
        if (!popupState || popupState.key !== issueKey) {
          return;
        }
        popupState = {
          ...popupState,
          changelogData: changelog,
          changelogLoading: false
        };
        if (popupState.historyOpen) {
          renderIssuePopup(popupState).catch(() => {});
        }
      }).catch(() => {
        if (!popupState || popupState.key !== issueKey) {
          return;
        }
        popupState = {
          ...popupState,
          changelogData: {histories: []},
          changelogLoading: false
        };
        renderIssuePopup(popupState).catch(() => {});
      });
    } else {
      renderIssuePopup(popupState).catch(() => {});
    }
  });

  $(document.body).on('click', '._JX_history_close', function (e) {
    e.preventDefault();
    e.stopPropagation();
    closeHistoryFlyout();
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
    if (popupState?.editState?.fieldKey === fieldKey) {
      cancelFieldEdit();
      return;
    }
    startFieldEdit(fieldKey).catch(() => {});
  });

  $(document.body).on('click', '._JX_edit_cancel, ._JX_edit_discard', function (e) {
    e.preventDefault();
    e.stopPropagation();
    cancelFieldEdit();
  });

  $(document.body).on('click', '._JX_edit_save', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const fieldKey = e.currentTarget.getAttribute('data-field-key') || '';
    submitFieldEdit(fieldKey).catch(() => {});
  });

  $(document.body).on('click', '._JX_edit_option', function (e) {
    e.preventDefault();
    e.stopPropagation();
    selectFieldEditOption(e.currentTarget.getAttribute('data-option-id'));
  });

  $(document.body).on('input', '._JX_edit_input', function (e) {
    e.stopPropagation();
    updateFieldEditInput(e.currentTarget.value, e.currentTarget.selectionStart, e.currentTarget.selectionEnd);
  });

  $(document.body).on('keydown', '._JX_edit_input', function (e) {
    e.stopPropagation();
    const fieldKey = e.currentTarget.getAttribute('data-field-key') || '';
    const editState = popupState?.editState;
    if (e.key === 'Enter') {
      if (editState?.fieldKey === fieldKey && editState.selectionMode === 'text' && editState.editorType === 'textarea' && !(e.ctrlKey || e.metaKey)) {
        return;
      }
      e.preventDefault();
      if (editState?.fieldKey === fieldKey && editState.selectionMode === 'multi') {
        if (e.ctrlKey || e.metaKey) {
          submitFieldEdit(fieldKey).catch(() => {});
        } else {
          toggleMultiSelectOptionFromInput(fieldKey);
        }
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
    if (!popupState?.editState) {
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

  $(document.body).on('input', '._JX_comment_input', function () {
    commentComposerDraftValue = this.value || '';
    commentComposerSelectionStart = typeof this.selectionStart === 'number' ? this.selectionStart : commentComposerDraftValue.length;
    commentComposerSelectionEnd = typeof this.selectionEnd === 'number' ? this.selectionEnd : commentComposerDraftValue.length;
    syncCommentComposerState();
    syncCommentMentionSuggestions(this);
  });

  $(document.body).on('focusin', '._JX_comment_input', function () {
    commentComposerHadFocus = true;
    pinContainer({showNotice: false});
  });

  $(document.body).on('click keyup select', '._JX_comment_input', function () {
    commentComposerSelectionStart = typeof this.selectionStart === 'number' ? this.selectionStart : (this.value || '').length;
    commentComposerSelectionEnd = typeof this.selectionEnd === 'number' ? this.selectionEnd : (this.value || '').length;
  });

  $(document.body).on('scroll', '._JX_comment_input', function () {
    if (commentMentionState.visible) {
      renderCommentMentionSuggestions();
    }
  });

  $(document.body).on('input', '._JX_comment_edit_input', function (e) {
    e.stopPropagation();
    const commentId = e.currentTarget.getAttribute('data-comment-id') || '';
    syncCommentEditMentionSuggestions(e.currentTarget, commentId);
    updateCommentEditDraft(
      commentId,
      e.currentTarget.value,
      e.currentTarget.selectionStart,
      e.currentTarget.selectionEnd
    );
  });

  $(document.body).on('paste', '._JX_comment_input', function (e) {
    const imageFiles = getClipboardImageFiles(e);
    if (!imageFiles.length || !activeCommentContext?.issueKey) {
      return;
    }
    e.preventDefault();
    imageFiles.forEach(file => {
      uploadPastedImage(file).catch(() => {});
    });
  });

  $(document.body).on('click', '._JX_comment_input', function () {
    syncCommentMentionSuggestions(this);
  });

  $(document.body).on('keyup', '._JX_comment_input', function (e) {
    if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].indexOf(e.key) !== -1) {
      return;
    }
    syncCommentMentionSuggestions(this);
  });

  $(document.body).on('keydown', '._JX_comment_input', function (e) {
    if (e.key === 'Escape' && commentMentionState.visible) {
      e.preventDefault();
      resetCommentMentionState();
      return;
    }

    if (!commentMentionState.visible || !commentMentionState.suggestions.length) {
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveCommentMentionSelection(1);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveCommentMentionSelection(-1);
      return;
    }

    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      applyCommentMentionSelection(commentMentionState.selectedIndex);
    }
  });

  $(document.body).on('mousedown', '._JX_comment_compose ._JX_comment_mention_option', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const index = Number(e.currentTarget.getAttribute('data-mention-index'));
    if (Number.isNaN(index)) {
      return;
    }
    applyCommentMentionSelection(index);
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
    resetCommentMentionState();
  });

  $(document.body).on('mousedown', function (e) {
    if ($(e.target).closest('._JX_comment_editor').length) {
      return;
    }
    if (!commentEditMentionState.visible) {
      return;
    }
    resetCommentEditMentionState();
    renderIssuePopup(popupState).catch(() => {});
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
    startCommentEdit(commentId, getIssueCommentById(commentId)?.body || '');
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
    if (commentEditMentionState.visible && commentEditMentionState.commentId === commentId) {
      if (e.key === 'Escape') {
        e.preventDefault();
        resetCommentEditMentionState();
        renderIssuePopup(popupState).catch(() => {});
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

  $(document.body).on('click', '._JX_comment_edit_input', function () {
    syncCommentEditMentionSuggestions(this, this.getAttribute('data-comment-id') || '');
  });

  $(document.body).on('keyup', '._JX_comment_edit_input', function (e) {
    if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].indexOf(e.key) !== -1) {
      return;
    }
    syncCommentEditMentionSuggestions(this, this.getAttribute('data-comment-id') || '');
  });

  $(document.body).on('click keyup select', '._JX_comment_edit_input', function () {
    const commentId = this.getAttribute('data-comment-id') || '';
    const activeSession = getActiveCommentSession();
    if (!activeSession || activeSession.commentId !== commentId || activeSession.mode !== 'edit') {
      return;
    }
    setCommentSession({
      ...activeSession,
      selectionStart: typeof this.selectionStart === 'number' ? this.selectionStart : (this.value || '').length,
      selectionEnd: typeof this.selectionEnd === 'number' ? this.selectionEnd : (this.value || '').length,
    });
  });

  $(document.body).on('scroll', '._JX_comment_edit_input', function () {
    if (commentEditMentionState.visible) {
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
  function hideContainer() {
    lastHoveredKey = '';
    clearWatchersFeedbackTimer();
    clearDescriptionStatusTimer();
    closePreviewOverlay();
    const descriptionStateSnapshot = popupState?.descriptionEditState;
    popupState = null;
    discardCommentComposerDraft().catch(() => {});
    discardDescriptionEditStateSnapshot(descriptionStateSnapshot, {deleteUploaded: true}).catch(() => {});
    activeCommentContext = null;
    resetCommentMentionState();
    containerPinned = false;
    container.html('').css({
      left: -5000,
      top: -5000,
      position: 'absolute',
    }).removeClass('container-pinned');

    passiveCancel(0);
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
        popupState = {
          ...popupState,
          historyOpen: false
        };
        renderIssuePopup(popupState).catch(() => {});
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
  let cancelToken = {};

  function passiveCancel(cooldown) {
    // does not actually cancel xhr calls
    cancelToken.cancel = true;
    setTimeout(function () {
      cancelToken = {};
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
    (async function (cancelToken) {
      const issueData = await getIssueMetaData(key);
      await normalizeIssueImages(issueData);
      let children = [];
      let childrenError = '';
      if (showChildren) {
        try {
          children = await getChildIssues(issueData);
          await normalizeChildIssueImages(children).catch(() => {});
        } catch (ex) {
          console.log('[Jira QuickView] Child issue fetch failed', {
            issueKey: key,
            error: ex?.message || String(ex)
          });
          childrenError = buildEditFieldError(ex);
        }
      }
      let pullRequests = [];
      if (showPullRequests) {
        try {
          const pullRequestResponse = await getPullRequestDataCached(issueData.id);
          pullRequests = normalizePullRequests(pullRequestResponse);
          await normalizePullRequestImages(pullRequests).catch(() => {});
        } catch (ex) {
          console.log('[Jira QuickView] Pull request fetch failed', {
            issueKey: key,
            issueId: issueData.id,
            error: ex?.message || String(ex)
          });
        }
      }

      if (cancelToken.cancel) {
        return;
      }
      let quickActions = [];
      try {
        quickActions = await resolveQuickActions(issueData);
      } catch (ex) {
        quickActions = [];
      }

      let commentReactionState = emptyCommentReactionState();
      const commentIds = (issueData.fields.comment?.comments || [])
        .map(c => c.id)
        .filter(Boolean);
      if (commentIds.length > 0) {
        try {
          const serverReactions = await fetchCommentReactions(commentIds);
          commentReactionState = buildInitialReactionState(serverReactions);
        } catch (ex) {
          // Reactions may not be supported; fall back to empty state
        }
      }

      await renderUpdatedPopupState({
        key,
        issueData,
        children,
        childrenError,
        childrenSort: DEFAULT_CHILDREN_SORT,
        commentSortOrder: commentSortOrderPreference,
        pullRequestsSort: DEFAULT_PULL_REQUESTS_SORT,
        pullRequests,
        pointerX,
        pointerY,
        quickActions,
        commentReactionState,
        ...buildPopupInteractionReset(),
        descriptionEditState: createDescriptionEditState(issueData),
        watchersState: emptyWatchersState(),
        timeTrackingEditState: createTimeTrackingEditState(issueData),
      });
    })(cancelToken).catch((error) => {
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
    if (e.buttons || cancelToken.cancel) {
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
