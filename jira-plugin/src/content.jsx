/*global chrome */
import size from 'lodash/size';
import debounce from 'lodash/debounce';
import regexEscape from 'escape-string-regexp';
import {waitForDocument} from 'src/utils';
import {sendMessage, storageGet, storageSet, storageLocalGet, storageLocalSet} from 'src/chrome';
import {snackBar} from 'src/snack';
import {createContentAttachmentHelpers} from 'src/content-attachment-helpers';
import {createContentHistoryHelpers} from 'src/content-history-helpers';
import {createPopupProjectView} from 'src/popup-session/project-view';
import {createContentPeopleHelpers} from 'src/content-people-helpers';
import {MENTION_CONTEXT_WINDOW} from 'src/comment-mention-constants';
import {createContentCommentHelpers} from 'src/content-comment-helpers';
import {positionMentionMenuAtCaret} from 'src/mention-menu-positioning';
import {createPopupQuickActions} from 'src/popup-quick-actions';
import config, {buildTooltipLayoutFromDisplayFields} from 'options/config.js';
import {DEFAULT_THEME_MODE, syncDocumentTheme} from 'src/theme';
import {copyIssueReference} from 'src/issue-reference-copy';
import {installJiraInlineCopyButtons} from 'src/jira-inline-copy';
import {createBrowserMessageJiraAdapter} from 'src/browser-message-jira-adapter';
import {createBrowserAttachmentMediaAdapter} from 'src/browser-attachment-media-adapter';
import {createBrowserPopupSurface} from 'src/browser-popup-surface';
import {createCommentLifecycle} from 'src/comment-lifecycle';
import {createJiraFieldEditing} from 'src/jira-field-editing';
import {createLinkedIssueLifecycle} from 'src/linked-issue-lifecycle';
import {createPopupSession} from 'src/popup-session';
import {createBrowserPopupEvents} from 'src/popup-session/browser-popup-events';
import {createBrowserCommentPresentation} from 'src/popup-session/browser-comment-presentation';
import {createBrowserPopupRenderer} from 'src/popup-session/browser-popup-renderer';
import {createBrowserPopupShell} from 'src/popup-session/browser-popup-shell';
import {createBrowserPopupModel} from 'src/popup-session/browser-popup-model';
import {createQuickViewIssueData} from 'src/quickview-issue-data';
import {createWatcherLifecycle} from 'src/watcher-lifecycle';
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
    attachments: true,
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
  const defaultContentBlocks = ['description', 'timeTracking', 'children', 'pullRequests', 'attachments', 'comments'];
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
  let commentPresentation = null;
  let popupShell = null;
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
  let descriptionStatusTimeoutId = null;
  const currentPopupState = () => popupModel.view();

  async function refreshPopupIssueState(successMessage = '', refreshOptions = {}) {
    const currentPopup = currentPopupState();
    if (!currentPopup?.key) return;
    const {
      showSnackBar = false,
      nextTimeTrackingEditState,
      preserveHistory = false,
    } = refreshOptions;
    const popupKey = currentPopup.key;
    const priorSnapshot = currentPopup.issueSnapshot;
    const shouldKeepHistoryOpen = !!(preserveHistory && currentPopup.historyOpen);
    const issueOutcome = await quickViewIssueData.refreshAfterMutation({
      issueKey: popupKey,
      priorSnapshot,
      mutation: refreshOptions.mutation || {kind: 'issueChanged'},
      requirements: {
        history: shouldKeepHistoryOpen,
        linkedIssues: !!linkedIssueLifecycle.view().open,
        pullRequests: showPullRequests,
      },
    });
    if (!issueOutcome.snapshot?.core) {
      const message = issueOutcome.failures?.core?.message || 'Could not refresh issue';
      const error = new Error(message);
      error.inner = message;
      throw error;
    }
    if (currentPopupState()?.key !== popupKey) return;
    popupModel.dispatch({
      type: 'timeTrackingChanged',
      state: nextTimeTrackingEditState || createTimeTrackingEditState(issueOutcome.snapshot.core),
    });
    await popupSession.dispatch({
      type: 'render',
      reason: 'issue-refreshed',
      issueSnapshot: issueOutcome.snapshot,
      notice: showSnackBar ? '' : successMessage,
    });
    if (showSnackBar && successMessage) snackBar(successMessage);
  }

  async function handleDraftAttachmentUploaded(uploadedAttachment) {
    const attachmentPopupState = currentPopupState();
    const popupKey = attachmentPopupState?.key;
    const currentIssueData = attachmentPopupState?.issueData;
    if (!popupKey || !currentIssueData?.fields || !uploadedAttachment) return;
    const normalizedAttachment = await normalizeIssueAttachmentImage({...uploadedAttachment});
    const issueOutcome = await quickViewIssueData.refreshAfterMutation({
      issueKey: popupKey,
      priorSnapshot: attachmentPopupState.issueSnapshot,
      mutation: {kind: 'attachmentChanged'},
      requirements: {history: !!attachmentPopupState.historyOpen},
    });
    if (currentPopupState()?.key !== popupKey) return;
    if (issueOutcome.snapshot?.core) {
      await popupSession.dispatch({type: 'render', reason: 'attachment-refreshed', issueSnapshot: issueOutcome.snapshot});
    }
    popupModel.dispatch({type: 'attachmentUploaded', attachment: normalizedAttachment});
    await renderCurrentPopup('attachment-normalized');
  }
  const people = createContentPeopleHelpers({
    areSameJiraUser,
  });
  const {
    buildUserView,
    normalizeAssignableUsers,
    normalizeWatcherUsers,
  } = people;
  const popupQuickActions = createPopupQuickActions({
    INSTANCE_URL,
    formatSprintActionLabel,
    getProjectSprintOptions,
    issueData: quickViewIssueData,
    jira,
    loadFieldContext: request => quickViewIssueData.loadFieldContext(request),
    loadViewer: getCurrentUserInfo,
    readSprintsFromIssue,
  });
  const watcherLifecycle = createWatcherLifecycle({
    instanceUrl: INSTANCE_URL,
    issueData: quickViewIssueData,
    jira,
    loadViewer: getCurrentUserInfo,
    normalizeUsers: normalizeWatcherUsers,
  });
  const linkedIssueLifecycle = createLinkedIssueLifecycle({
    instanceUrl: INSTANCE_URL,
    issueData: quickViewIssueData,
    jira,
  });
  const popupModel = createBrowserPopupModel({
    createDescriptionState: createDescriptionEditState,
    createTimeTrackingState: createTimeTrackingEditState,
    renderProjection(state, context) {
      return popupRenderer.render(state, context);
    },
  });

  const popupSurface = createBrowserPopupSurface({
    commitCurrent(frame, context) {
      return popupModel.commit(frame, context);
    },
    commitLoading(frame, context) {
      return popupRenderer.renderLoading(frame, context);
    },
    commitVisible(frame, context) {
      return popupModel.commit(frame, context, {opening: true});
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
    quickActions: popupQuickActions,
    watchers: watcherLifecycle,
    linkedIssues: linkedIssueLifecycle,
    surface: popupSurface,
  });

  function currentPopupSessionId() {
    return popupSession.view().sessionId;
  }

  function renderCurrentPopup(reason = 'feature-changed', details = {}) {
    return popupSession.dispatch({type: 'render', reason, issueSnapshot: currentPopupState()?.issueSnapshot, ...details});
  }

  function renderIssuePopup(_state, renderOptions = {}) {
    const details = {...renderOptions};
    const reason = details.reason || 'popup-state-changed';
    delete details.isCurrent;
    delete details.reason;
    return renderCurrentPopup(reason, details);
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
    const fields = currentPopupState()?.issueData?.fields || {};
    const users = [
      fields.reporter,
      fields.assignee,
      ...(fields.comment?.comments || []).map(comment => comment?.author),
      ...(watcherLifecycle.view().watchers || []),
      ...(watcherLifecycle.view().searchResults || []),
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
    return currentPopupState()?.descriptionEditState || createDescriptionEditState(currentPopupState()?.issueData);
  }

  function setDescriptionEditState(nextState) {
    if (!currentPopupState()) {
      return;
    }
    popupModel.dispatch({type: 'descriptionChanged', state: nextState});
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
      const currentState = currentPopupState()?.descriptionEditState;
      if (!currentState || currentState.open || currentState.statusMessage !== statusMessage) {
        return;
      }
      setDescriptionEditState({
        ...currentState,
        statusKind: '',
        statusMessage: ''
      });
      renderIssuePopup(currentPopupState()).catch(() => {});
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
    if (!currentPopupState()?.descriptionEditState?.open) {
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
    renderIssuePopup(currentPopupState()).catch(() => {});
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
    renderIssuePopup(currentPopupState()).catch(() => {});
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
    const popupView = currentPopupState();
    if (!popupView?.issueData) {
      return;
    }
    popupShell?.dispatch({type: 'pin', announce: false}).catch(() => {});
    clearDescriptionStatusTimer();
    setDescriptionEditState(createDescriptionEditState(popupView.issueData, {open: true}));
    renderIssuePopup(popupView).catch(() => {});
  }

  async function cancelDescriptionEdit() {
    const popupView = currentPopupState();
    if (!popupView?.issueData) {
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
        preserveHistory: !!currentPopupState()?.historyOpen,
      });
    }
    const refreshedPopupView = currentPopupState();
    if (!refreshedPopupView?.issueData) {
      return;
    }
    setDescriptionEditState(createDescriptionEditState(refreshedPopupView.issueData));
    renderIssuePopup(refreshedPopupView).catch(() => {});
  }

  async function uploadDescriptionImage(file) {
    const popupView = currentPopupState();
    if (!popupView?.issueData?.key) {
      return;
    }
    const currentState = getDescriptionEditState();
    if (!currentState.open) {
      return;
    }
    const issueKey = popupView.issueData.key;
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
    await renderIssuePopup(currentPopupState());

    try {
      const uploadResult = await uploadAttachment(`${INSTANCE_URL}rest/api/2/issue/${issueKey}/attachments`, new File([file], fileName, {type: file.type || 'image/png'}));
      const uploadedAttachment = (Array.isArray(uploadResult) ? uploadResult : [uploadResult]).find(item => item && item.id);
      if (!uploadedAttachment) {
        throw new Error('Attachment upload failed');
      }
      const latestState = getDescriptionEditState();
      if (currentPopupState()?.issueData?.key !== issueKey || !latestState.open) {
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
      await renderIssuePopup(currentPopupState());
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
      renderIssuePopup(currentPopupState()).catch(() => {});
    }
  }

  async function saveDescriptionEdit() {
    const popupView = currentPopupState();
    if (!popupView?.issueData) {
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
    const issueAttachments = Array.isArray(popupView.issueData?.fields?.attachment) ? popupView.issueData.fields.attachment : [];
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
      await renderIssuePopup(currentPopupState());
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
    await renderIssuePopup(currentPopupState());

    try {
      await requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${popupView.key}`, {
        fields: {
          description: saveValueResult.value,
        }
      });
      await refreshPopupIssueState('', {
        mutation: {kind: 'descriptionChanged'},
        preserveHistory: !!currentPopupState()?.historyOpen,
      });
      const refreshedPopupView = currentPopupState();
      if (!refreshedPopupView?.issueData) {
        return;
      }
      const successMessage = nextDescription.trim() ? 'Description updated' : 'Description cleared';
      setDescriptionEditState(createDescriptionEditState(refreshedPopupView.issueData, {
        statusKind: 'success',
        statusMessage: successMessage,
      }));
      await renderIssuePopup(refreshedPopupView);
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
      await renderIssuePopup(currentPopupState());
    }
  }

  // ── Comments ──────────────────────────────────────────────

  async function handleCommentReactionClick(commentId, emojiId) {
    if (!currentPopupState()?.issueData || !commentId || !emojiId) {
      return;
    }
    const sessionId = currentPopupSessionId();
    const pending = commentLifecycle.dispatch({type: 'toggleReaction', commentId, emojiId});
    await renderCurrentPopup('comment-reaction-pending');
    const outcome = await pending;
    if (outcome.sessionId !== sessionId || sessionId !== currentPopupSessionId()) {
      return;
    }
    await popupSession.dispatch({
      type: 'render',
      reason: 'comment-reaction-complete',
      issueSnapshot: outcome.refreshedSnapshot || currentPopupState()?.issueSnapshot,
    });
    if (outcome.kind === 'unsupported') {
      snackBar(outcome.notice);
    }
  }

  async function handleCommentSave() {
    const commentIssueKey = commentLifecycle.view().issueKey;
    if (!commentIssueKey) {
      return;
    }

    const capturedCompose = commentPresentation.capture();
    const commentDraftText = capturedCompose.value;
    const commentText = commentDraftText.trim();
    if (!commentText) {
      commentPresentation.render();
      return;
    }
    if (commentLifecycle.view().compose?.uploads?.some(item => item.status === 'uploading')) {
      commentPresentation.showError('Wait for image uploads to finish.');
      return;
    }

    commentLifecycle.dispatch({
      type: 'composeChanged',
      value: commentDraftText,
      selection: capturedCompose.selection,
    }).catch(() => {});
    const pendingSave = commentLifecycle.dispatch({
      type: 'saveNewComment',
      requirements: {history: !!currentPopupState()?.historyOpen},
    });
    commentPresentation.render();

    const outcome = await pendingSave;
    const isSameIssueStillVisible = currentPopupState()?.issueData?.key === commentIssueKey &&
      outcome.sessionId === currentPopupSessionId();
    if (outcome.kind === 'mutationCommitted' && isSameIssueStillVisible) {
      await popupSession.dispatch({
        type: 'render',
        reason: 'comment-save-complete',
        issueSnapshot: outcome.refreshedSnapshot || currentPopupState()?.issueSnapshot,
        notice: outcome.notice,
      });
      if (outcome.failure) {
        snackBar(outcome.notice);
      }
      return;
    }
    if (outcome.kind === 'failed' && isSameIssueStillVisible) {
      commentPresentation.render({applyValue: true, restoreFocus: true});
    }
  }

  async function handleCommentDiscard() {
    const capturedCompose = commentPresentation.capture();
    if (!capturedCompose.present || capturedCompose.saving) {
      return;
    }
    await commentLifecycle.dispatch({type: 'discardCompose', deleteUploaded: true});
    commentPresentation.render({applyValue: true});
  }


  function getActiveCommentSession() {
    return commentLifecycle.view().rowAction || null;
  }

  function resetCommentEditMentionState() {
    commentLifecycle.dispatch({type: 'dismissMention', lane: 'edit'}).catch(() => {});
  }

  async function applyCommentRowActionOutcome(outcome) {
    const isCurrent = currentPopupState()?.key === outcome.issueKey && outcome.sessionId === currentPopupSessionId();
    if (!isCurrent) return;
    await popupSession.dispatch({
      type: 'render',
      reason: 'comment-row-action-complete',
      issueSnapshot: outcome.refreshedSnapshot || currentPopupState()?.issueSnapshot,
      ...(outcome.kind === 'mutationCommitted' ? {notice: outcome.notice} : {}),
    });
    if (outcome.kind === 'failed') snackBar(outcome.failure?.message || 'Comment operation failed');
    else if (outcome.failure) snackBar(outcome.notice);
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
    if (!currentPopupState()?.issueData || !commentId) {
      return;
    }
    popupShell?.dispatch({type: 'pin', announce: false}).catch(() => {});
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
    if (!currentPopupState()?.issueData || !commentId) {
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
    if (!currentPopupState()?.key || !activeSession || activeSession.commentId !== String(commentId) || activeSession.mode !== 'edit' || activeSession.saving) {
      return;
    }
    resetCommentEditMentionState();
    const pending = commentLifecycle.dispatch({
      type: 'saveEdit',
      commentId,
      requirements: {history: !!currentPopupState()?.historyOpen},
    });
    await renderCurrentPopup('comment-edit-saving');
    await applyCommentRowActionOutcome(await pending);
  }

  async function confirmCommentDelete(commentId) {
    const activeSession = getActiveCommentSession();
    if (!currentPopupState()?.key || !activeSession || activeSession.commentId !== String(commentId) || activeSession.mode !== 'delete' || activeSession.saving) {
      return;
    }

    const pending = commentLifecycle.dispatch({
      type: 'confirmDelete',
      commentId,
      requirements: {history: !!currentPopupState()?.historyOpen},
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

  async function getCurrentUserInfo(issueKey = '') {
    const activeIssueKey = issueKey || currentPopupState()?.issueData?.key || '';
    if (!activeIssueKey) throw new Error('Issue key is required to load the Jira viewer');
    const outcome = await quickViewIssueData.openIssue({
      issueKey: activeIssueKey,
      requirements: {viewer: true},
    });
    if (!outcome.snapshot?.viewer?.user) {
      throw new Error(outcome.snapshot?.viewer?.failure?.message || 'Could not load the Jira viewer');
    }
    return outcome.snapshot.viewer.user;
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
      const fieldOutcome = await jiraFieldEditing.dispatch({
        type: 'describeField',
        fieldId,
        configured: true,
      }).catch(() => null);
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

  function getActiveFieldEditState() {
    return jiraFieldEditing.view().edit || null;
  }

  function buildActiveEditPresentation(fieldKey, state, options = {}) {
    const editState = getActiveFieldEditState(state);
    if (editState?.fieldKey !== fieldKey) {
      return null;
    }

    const isMultiSelect = editState.selectionMode === 'multi';
    const isTextEditor = editState.selectionMode === 'text';
    const selectedOptionIds = new Set(isMultiSelect
      ? editState.selectedOptionIds || []
      : (editState.selectedOptionId === null || typeof editState.selectedOptionId === 'undefined'
          ? []
          : [String(editState.selectedOptionId)]));
    const visibleOptions = isTextEditor ? [] : (editState.visibleOptions || []);
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
    fieldEditing: jiraFieldEditing,
    issueData: quickViewIssueData,
    history: historyPresentation,
    normalizeRichHtml,
    people,
    readSprintsFromIssue,
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

  // ── Popup Rendering & State ────────────────────────────────
  let hoverDelayTimeout;
  let lastHoveredKey = '';
  const container = $('<div class="_JX_container" data-testid="jira-popup-root">');
  const previewOverlay = $(`
    <div class="_JX_preview_overlay" data-testid="jira-popup-preview-overlay">
      <img class="_JX_preview_image" data-testid="jira-popup-preview-image" />
    </div>
  `);
  $(document.body).append(container);
  $(document.body).append(previewOverlay);
  popupShell = createBrowserPopupShell({
    announce: snackBar,
    close: ({reason}) => hideContainer(reason),
    container,
    media: {displayUrl: getDisplayImageUrl},
    previewOverlay,
  });
  commentPresentation = createBrowserCommentPresentation({
    comments: commentLifecycle,
    container,
    shell: popupShell,
  });
  const popupRenderer = createBrowserPopupRenderer({
    comments: commentLifecycle,
    commentPresentation,
    container,
    contentBlockOrder: layoutContentBlocks,
    continuity: {
      constrainPopovers: constrainEditPopoversToViewport,
      renderEditMentions: renderCommentEditMentionSuggestions,
    },
    fieldEditing: {view: getActiveFieldEditState},
    shell: popupShell,
    projectState: buildPopupDisplayData,
    template: annotationTemplate,
  });
  // ── Field Editing ─────────────────────────────────────────
  function attachJiraFieldEditingToPopup() {
    const popupView = currentPopupState();
    if (!popupView?.issueSnapshot?.core) return false;
    const sessionId = currentPopupSessionId();
    if (!sessionId) return false;
    jiraFieldEditing.attach({
      sessionId,
      issueSnapshot: popupView.issueSnapshot,
      requirements: {
        children: showChildren,
        history: !!popupView.historyOpen,
        linkedIssues: !!linkedIssueLifecycle.view().open,
        pullRequests: showPullRequests,
        reactions: true,
        watchers: !!watcherLifecycle.view().open,
      },
    });
    return true;
  }

  async function dispatchJiraFieldEditing(intent) {
    const popupKey = currentPopupState()?.key || '';
    const pendingOutcome = jiraFieldEditing.dispatch(intent);
    if (currentPopupState()?.key === popupKey) await renderCurrentPopup('field-edit-pending');
    const fieldOutcome = await pendingOutcome;
    if (currentPopupState()?.key !== popupKey || fieldOutcome.sessionId !== currentPopupSessionId()) return fieldOutcome;
    if (fieldOutcome.refreshedSnapshot?.core) {
      await popupSession.dispatch({
        type: 'render',
        reason: 'field-edit-complete',
        issueSnapshot: fieldOutcome.refreshedSnapshot,
        notice: fieldOutcome.notice || '',
      });
      return fieldOutcome;
    }
    await renderCurrentPopup('field-edit-updated');
    return fieldOutcome;
  }

  async function startFieldEdit(fieldKey) {
    if (!currentPopupState()?.issueData || !attachJiraFieldEditingToPopup()) return;
    await dispatchJiraFieldEditing({
      type: 'begin',
      fieldId: fieldKey,
      configured: customFields.some(field => field.fieldId === fieldKey),
    });
  }

  function cancelFieldEdit() {
    if (jiraFieldEditing.view().edit) dispatchJiraFieldEditing({type: 'cancel'}).catch(() => {});
  }

  function selectFieldEditOption(optionId) {
    const fieldView = jiraFieldEditing.view().edit;
    if (fieldView && fieldView.options?.some(option => option.id === String(optionId || ''))) {
      dispatchJiraFieldEditing({type: 'selectOption', editId: fieldView.editId, optionId}).catch(() => {});
    }
  }


  function updateTimeTrackingEditState(changes = {}) {
    const popupView = currentPopupState();
    if (!popupView?.issueData) {
      return;
    }
    const currentState = popupView.timeTrackingEditState || createTimeTrackingEditState(popupView.issueData);
    popupModel.dispatch({
      type: 'timeTrackingChanged',
      state: {...currentState, ...changes},
    });
    renderIssuePopup(currentPopupState()).catch(() => {});
  }

  async function saveTimeTrackingEdit() {
    const popupView = currentPopupState();
    if (!popupView?.issueData) {
      return;
    }
    const issueData = popupView.issueData;
    const issueKey = issueData.key;
    const timeTrackingOutcome = await jiraFieldEditing.dispatch({type: 'describeField', fieldId: 'timetracking'});
    const timeTrackingCapability = timeTrackingOutcome.field || {editable: false};
    const currentState = popupView.timeTrackingEditState || createTimeTrackingEditState(issueData);
    const savePlan = buildTimeTrackingSavePlan(currentState, {
      canEditEstimates: !!timeTrackingCapability?.editable
    });
    if (!savePlan.hasChanges || currentState.saving) {
      return;
    }

    popupModel.dispatch({
      type: 'timeTrackingChanged',
      state: {...currentState, saving: true, errorMessage: ''},
    });
    await renderIssuePopup(currentPopupState());

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
          priorSnapshot: currentPopupState()?.issueSnapshot,
          mutation: {kind: 'timeChanged'},
          requirements: {pullRequests: showPullRequests},
        });
        if (!issueOutcome.snapshot?.core) {
          throw issueDataError(issueOutcome.failures?.core, 'Could not refresh issue');
        }
        const refreshedIssueData = issueOutcome.snapshot.core;
        if (currentPopupState()?.key !== issueKey) {
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

        popupModel.dispatch({type: 'timeTrackingChanged', state: refreshedTimeTrackingState});
        await popupSession.dispatch({
          type: 'render',
          reason: 'time-tracking-save-complete',
          issueSnapshot: issueOutcome.snapshot,
        });

        if (successMessage) {
          snackBar(errorMessage ? `${successMessage}. ${errorMessage}` : successMessage);
        }
        return;
      } catch (refreshError) {
        popupModel.dispatch({
          type: 'timeTrackingChanged',
          state: {
            ...currentState,
            saving: false,
            errorMessage: errorMessage || 'Saved changes but failed to refresh the popup'
          },
        });
        await renderIssuePopup(currentPopupState());
        snackBar(successMessage ? `${successMessage}. Refresh failed.` : 'Saved changes but failed to refresh the popup');
        return;
      }
    }

    popupModel.dispatch({
      type: 'timeTrackingChanged',
      state: {
        ...currentState,
        saving: false,
        errorMessage: errorMessage || 'Time tracking update failed'
      },
    });
    await renderIssuePopup(currentPopupState());
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

  async function handlePopupPresentationIntent(intent) {
    if (intent.type === 'toggle-actions' || intent.type === 'sort-children' || intent.type === 'sort-pull-requests') {
      return popupSession.dispatch(intent);
    }
    if (intent.type === 'execute-quick-action') {
      return popupSession.dispatch({
        ...intent,
        requirements: {
          history: !!currentPopupState()?.historyOpen,
          linkedIssues: !!linkedIssueLifecycle.view().open,
          pullRequests: showPullRequests,
          watchers: !!watcherLifecycle.view().open,
        },
      });
    }
    if (intent.type === 'toggle-comment-sort') {
      const outcome = await popupSession.dispatch(intent);
      const nextCommentSortOrder = outcome.presentation?.commentSortOrder;
      if (!nextCommentSortOrder) return outcome;
      commentSortOrderPreference = nextCommentSortOrder;
      storageLocalSet({[COMMENT_SORT_ORDER_STORAGE_KEY]: nextCommentSortOrder}).catch(() => {});
      return outcome;
    }
    if (['toggle-watchers', 'close-watchers', 'dismiss-watchers', 'search-watchers'].includes(intent.type)) {
      return popupSession.dispatch(intent);
    }
    if (intent.type === 'add-watcher' || intent.type === 'remove-watcher') {
      return popupSession.dispatch({
        ...intent,
        requirements: {
          history: !!currentPopupState()?.historyOpen,
          linkedIssues: !!linkedIssueLifecycle.view().open,
          pullRequests: showPullRequests,
          watchers: true,
        },
      });
    }
    if (['toggle-linkedIssues', 'close-linkedIssues', 'dismiss-linkedIssues'].includes(intent.type)) {
      return popupSession.dispatch(intent);
    }
    if (intent.type.startsWith('linked-')) {
      return popupSession.dispatch({
        ...intent,
        requirements: {
          history: !!currentPopupState()?.historyOpen,
          linkedIssues: true,
          pullRequests: showPullRequests,
          watchers: !!watcherLifecycle.view().open,
        },
      });
    }
    if (['toggle-history', 'close-history', 'dismiss-history'].includes(intent.type)) {
      return popupSession.dispatch(intent);
    }
    if (intent.type === 'dismiss-actions') return popupSession.dispatch({type: 'close-actions'});
    if (intent.type === 'pin') return popupShell.dispatch({type: 'pin', announce: true});
    if (intent.type === 'pin-after-drag') return popupShell.dispatch({type: 'pin', announce: true});
    if (intent.type === 'open-preview' || intent.type === 'close-preview') return popupShell.dispatch(intent);
    if (intent.type === 'close-popup') {
      return hideContainer();
    }
    if (intent.type === 'dismiss-popup') {
      if (!container.html() || popupShell.view().pinned) return {kind: 'ignored', reason: 'popup-not-dismissible'};
      return hideContainer();
    }
    if (intent.type === 'escape') {
      if (popupShell.view().previewOpen) return popupShell.dispatch({type: 'close-preview'});
      if (currentPopupState()?.historyOpen) return popupSession.dispatch({type: 'close-history'});
      if (linkedIssueLifecycle.view().open) return popupSession.dispatch({type: 'close-linkedIssues'});
      if (currentPopupState()?.descriptionEditState?.open) return cancelDescriptionEdit();
      return hideContainer();
    }
    return {kind: 'ignored', reason: 'unsupported-presentation-intent'};
  }

  const popupEvents = createBrowserPopupEvents({
    root: $(document.body),
    emit: handlePopupPresentationIntent,
  });
  popupEvents.install();

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
    }
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
    }
  });

  $(document.body).on('keydown', '._JX_edit_input', function (e) {
    if ($(e.currentTarget).closest('._JX_linked_issues_panel').length) {
      return;
    }
    e.stopPropagation();
    const fieldKey = e.currentTarget.getAttribute('data-field-key') || '';
    const fieldView = jiraFieldEditing.view().edit;
    if (fieldView?.fieldKey !== fieldKey || !['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) return;
    if (e.key === 'Enter' && fieldView.selectionMode === 'text' && fieldView.editorType === 'textarea' && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    dispatchJiraFieldEditing({
      type: 'key',
      editId: fieldView.editId,
      key: e.key,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
    }).catch(() => {});
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
    commentPresentation.render({applyValue, restoreFocus: applyValue});
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
    popupShell.dispatch({type: 'pin', announce: false}).catch(() => {});
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
      commentPresentation.render();
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
    const imageFiles = commentPresentation.clipboardImages(e);
    if (!imageFiles.length || !commentLifecycle.view().issueKey) {
      return;
    }
    e.preventDefault();
    imageFiles.forEach(file => {
      const sessionId = currentPopupSessionId();
      const pending = commentLifecycle.dispatch({type: 'imagePasted', file});
      renderCommentComposeLifecycleView({applyValue: true});
      pending.then(async outcome => {
        if (outcome.sessionId !== sessionId || sessionId !== currentPopupSessionId()) {
          return;
        }
        if (outcome.kind === 'attachmentUploaded' && outcome.uploadedAttachment) {
          await handleDraftAttachmentUploaded(outcome.uploadedAttachment);
        }
        renderCommentComposeLifecycleView({applyValue: true});
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
    pending.then(async outcome => {
      if (outcome.sessionId !== sessionId || sessionId !== currentPopupSessionId()) {
        return;
      }
      if (outcome.kind === 'attachmentUploaded' && outcome.uploadedAttachment) {
        await handleDraftAttachmentUploaded(outcome.uploadedAttachment);
      }
      renderCommentComposeLifecycleView({applyValue: true});
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
    const imageFiles = commentPresentation.clipboardImages(e);
    if (!imageFiles.length || !currentPopupState()?.issueData?.key || !currentPopupState()?.descriptionEditState?.open) {
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

  // ── Container Lifecycle ────────────────────────────────────
  async function clearPopupSurface() {
    lastHoveredKey = '';
    clearDescriptionStatusTimer();
    const descriptionStateSnapshot = currentPopupState()?.descriptionEditState;
    popupModel.close();
    discardDescriptionEditStateSnapshot(descriptionStateSnapshot, {deleteUploaded: true}).catch(() => {});
    await popupShell.dispatch({type: 'clear'});

    passiveCancel(0);
  }

  function hideContainer(reason = 'explicit') {
    return popupSession.close({reason}).catch(() => clearPopupSurface());
  }

  // ── Hover Detection & Script Bootstrap ─────────────────────
  function passiveCancel(cooldown) {
    popupShell.dispatch({type: 'begin-cooldown', delay: cooldown}).catch(() => {});
  }

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

  function fetchAndShowPopup(key, pointerX, pointerY, activation = '') {
    const popupView = currentPopupState();
    if (popupView?.key && popupView.key !== key && popupView.descriptionEditState?.open) {
      clearDescriptionStatusTimer();
      discardDescriptionEditStateSnapshot(popupView.descriptionEditState, {deleteUploaded: true}).catch(() => {});
    }
    return popupSession.activate({
      issueKey: key,
      anchor: {x: pointerX, y: pointerY},
      activation: activation || (hoverModifierKey === 'none' ? 'hover' : 'modifier'),
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

  function triggerPopupForKey(key, pointerX, pointerY, immediate, activation = '') {
    clearTimeout(hoverDelayTimeout);
    lastHoveredKey = key;
    if (immediate) {
      fetchAndShowPopup(key, pointerX, pointerY, activation);
    } else {
      hoverDelayTimeout = setTimeout(function () {
        fetchAndShowPopup(key, pointerX, pointerY, activation);
      }, 250);
    }
  }

  function getClickedIssueLink(target) {
    if (!config.openQuickViewOnClick || !target?.closest) return null;
    const link = target.closest('a[href]');
    if (!link || link.closest('._JX_container') || link.hasAttribute('download')) return null;
    let linkUrl;
    let jiraOrigin;
    try {
      linkUrl = new URL(link.href, document.location.href);
      jiraOrigin = new URL(INSTANCE_URL).origin;
    } catch (error) {
      return null;
    }
    if (linkUrl.origin !== jiraOrigin) return null;
    const keyMatch = linkUrl.pathname.match(/\/(?:browse|issues)\/([A-Z][A-Z0-9]{1,14}-\d+)(?:\/|$)/i);
    if (!keyMatch) return null;
    return {key: keyMatch[1].toUpperCase(), link};
  }

  if (config.openQuickViewOnClick) {
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const clickedIssue = getClickedIssueLink(e.target);
      if (!clickedIssue) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = clickedIssue.link.getBoundingClientRect();
      const pointerX = Number.isFinite(e.pageX) && e.pageX > 0
        ? e.pageX
        : rect.left + window.scrollX + (rect.width / 2);
      const pointerY = Number.isFinite(e.pageY) && e.pageY > 0
        ? e.pageY
        : rect.top + window.scrollY + rect.height;
      triggerPopupForKey(clickedIssue.key, pointerX, pointerY, true, 'click');
    }, true);
  }

  if (hoverModifierKey !== 'none') {
    document.addEventListener('keydown', function (e) {
      if (popupShell.view().pinned || isTypingTargetBlockingModifierTrigger(currentPointer.clientX, currentPointer.clientY)) {
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
    if (e.buttons || popupShell.view().cooldownActive) {
      return;
    }
    currentPointer = {
      clientX: e.clientX,
      clientY: e.clientY,
      pageX: e.pageX,
      pageY: e.pageY,
    };
    if (popupShell.view().previewOpen) {
      popupShell.dispatch({type: 'cancel-hide'}).catch(() => {});
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
      popupShell.dispatch({type: 'cancel-hide'}).catch(() => {});
      return;
    }
    if (!popupShell.view().pinned && container.html()) {
      clearTimeout(hoverDelayTimeout);
      lastHoveredKey = '';
      popupShell.dispatch({type: 'schedule-hide', delay: 250, reason: 'pointer-exit'}).catch(() => {});
      return;
    }
    if (element) {
      if (hoverModifierKey !== 'none') {
        const resolvedKey = resolveModifierKeyAtClientPoint(e.clientX, e.clientY);
        if (!resolvedKey) {
          return;
        }
        if (!isModifierSatisfied(e)) {
          popupShell.dispatch({type: 'cancel-hide'}).catch(() => {});
          return;
        }
        popupShell.dispatch({type: 'cancel-hide'}).catch(() => {});
        triggerPopupForKey(resolvedKey, e.pageX, e.pageY, true);
        return;
      }

      let keys = detectJiraKeysAtPoint(element);
      if (!size(keys)) {
        keys = detectLayeredJiraKeysFromPoint(e.clientX, e.clientY);
      }

      if (size(keys)) {
        const key = keys[0].replace(' ', '-');
        popupShell.dispatch({type: 'cancel-hide'}).catch(() => {});
        triggerPopupForKey(key, e.pageX, e.pageY, false);
      }
    }
  }, 100));
}

if (!window.__JX__script_injected__) {
  waitForDocument(mainAsyncLocal);
}

window.__JX__script_injected__ = true;
