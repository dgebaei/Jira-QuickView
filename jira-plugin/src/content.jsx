/*global chrome */
import size from 'lodash/size';
import debounce from 'lodash/debounce';
import regexEscape from 'escape-string-regexp';
import Mustache from 'mustache';
import {waitForDocument} from 'src/utils';
import {sendMessage, storageGet, storageSet} from 'src/chrome';
import {snackBar} from 'src/snack';
import {createPopupEditing} from 'src/popup-editing';
import {createPopupQuickActions} from 'src/popup-quick-actions';
import {createPopupCommentComposer} from 'src/popup-comment-composer';
import config from 'options/config.js';
import {DEFAULT_THEME_MODE, syncDocumentTheme} from 'src/theme';

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
  return getFieldIdsByFilter(instanceUrl, field => {
    const name = (field.name || '').toLowerCase();
    const schemaCustom = ((field.schema && field.schema.custom) || '').toLowerCase();
    const schemaType = ((field.schema && field.schema.type) || '').toLowerCase();
    return name.includes('sprint') ||
      schemaCustom.includes('gh-sprint') ||
      schemaType === 'sprint';
  });
}

function getEpicLinkFieldIds(instanceUrl) {
  return getFieldIdsByFilter(instanceUrl, field => {
    const name = (field.name || '').toLowerCase();
    const schemaCustom = ((field.schema && field.schema.custom) || '').toLowerCase();
    return name === 'epic link' || name === 'epic' || schemaCustom.includes('gh-epic-link');
  });
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
  return buildRegexMatcher(/\b[A-Z][A-Z0-9]{1,14}[- ]\d+\b/g);
}

// ── Tips & Notifications ────────────────────────────────────────

chrome.runtime.onMessage.addListener(function (msg) {
  if (msg.action === 'message') {
    snackBar(msg.message);
  }
});

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

async function getImageDataUrl(url) {
  return unwrapResponse(await sendMessage({action: 'getImageDataUrl', url}));
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

// ═══════════════════════════════════════════════════════════════
// Main Content Script
// ═══════════════════════════════════════════════════════════════

async function mainAsyncLocal() {
  const $ = require('jquery');
  const draggable = require('jquery-ui/ui/widgets/draggable');

  // ── Initialization & State ──────────────────────────────────

  const config = await getConfig();
  const INSTANCE_URL = config.instanceUrl;
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
    contentBlocks: ['description', 'timeTracking', 'pullRequests', 'comments'],
    people: ['reporter', 'assignee']
  };
  const layoutContentBlocks = (tooltipLayout.contentBlocks || ['description', 'timeTracking', 'pullRequests', 'comments'])
    .filter(k => displayFields[k] !== false);
  const showPullRequests = layoutContentBlocks.includes('pullRequests');
  const hoverDepth = config.hoverDepth || 'exact';
  const hoverModifierKey = config.hoverModifierKey || 'any';
  const customFields = normalizeCustomFields(config.customFields);
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
    jiraProjects = await get(await getInstanceUrl() + 'rest/api/2/project');
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
  const pullRequestCache = new Map();
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
  let labelSuggestionSupportPromise = null;
  let editSearchRequestCounter = 0;
  let labelSearchTimeoutId = null;
  let watchersFeedbackTimeoutId = null;
  let popupState = null;
  let activeCommentContext = null;
  let commentMentionState = emptyCommentMentionState();
  let commentMentionRequestId = 0;
  let commentUploadState = emptyCommentUploadState();
  let commentUploadSessionId = 0;
  let commentUploadSequence = 0;
  let commentComposerDraftValue = '';
  let commentComposerErrorMessage = '';
  let commentComposerHadFocus = false;
  let commentComposerSelectionStart = 0;
  let commentComposerSelectionEnd = 0;


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
    searchParentCandidates,
    setPopupState: nextState => {
      popupState = nextState;
    },
  });

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
    applyCommentMentionSelection,
    buildOptimisticCommentBodyHtml,
    captureCommentComposerDraft,
    clearCommentUploads,
    discardCommentComposerDraft,
    getClipboardImageFiles,
    getCommentComposerElements,
    getUploadedCommentAttachments,
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
    keepContainerVisible,
    requestJson,
    setActiveCommentContext: nextValue => { activeCommentContext = nextValue; },
    setCommentComposerErrorMessage: nextValue => { commentComposerErrorMessage = nextValue; },
    setCommentComposerHadFocus: nextValue => { commentComposerHadFocus = nextValue; },
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

  async function getDisplayImageUrl(url) {
    const absoluteUrl = toAbsoluteJiraUrl(url);
    if (!absoluteUrl || !absoluteUrl.startsWith(INSTANCE_URL)) {
      return absoluteUrl;
    }
    if (imageProxyCache[absoluteUrl]) {
      return imageProxyCache[absoluteUrl];
    }
    try {
      const dataUrl = await getImageDataUrl(absoluteUrl);
      imageProxyCache[absoluteUrl] = dataUrl;
      return dataUrl;
    } catch (ex) {
      return absoluteUrl;
    }
  }

  async function normalizeIssueImages(issueData) {
    const imageLoads = [];

    const maybeNormalizeAvatar = field => {
      const avatarUrl = field && field.avatarUrls && field.avatarUrls['48x48'];
      if (avatarUrl) {
        imageLoads.push(
          getDisplayImageUrl(avatarUrl).then(src => {
            field.avatarUrls['48x48'] = src;
          })
        );
      }
    };

    const maybeNormalizeIcon = field => {
      if (field && field.iconUrl) {
        imageLoads.push(
          getDisplayImageUrl(field.iconUrl).then(src => {
            field.iconUrl = src;
          })
        );
      }
    };

    maybeNormalizeAvatar(issueData.fields.reporter);
    maybeNormalizeAvatar(issueData.fields.assignee);
    maybeNormalizeIcon(issueData.fields.issuetype);
    maybeNormalizeIcon(issueData.fields.status);
    maybeNormalizeIcon(issueData.fields.priority);

    // Normalize comment author avatars
    (issueData.fields.comment?.comments || []).forEach(comment => {
      maybeNormalizeAvatar(comment.author);
    });

    // Normalize custom field user avatars
    Object.keys(issueData.fields || {}).forEach(fieldKey => {
      if (!fieldKey.startsWith('customfield_')) {
        return;
      }
      const fieldValue = issueData.fields[fieldKey];
      if (fieldValue && typeof fieldValue === 'object' && fieldValue.avatarUrls) {
        maybeNormalizeAvatar(fieldValue);
      }
      if (Array.isArray(fieldValue)) {
        fieldValue.forEach(entry => {
          if (entry && typeof entry === 'object' && entry.avatarUrls) {
            maybeNormalizeAvatar(entry);
          }
        });
      }
    });

    (issueData.fields.attachment || []).forEach(attachment => {
      attachment.content = toAbsoluteJiraUrl(attachment.content);
      attachment.thumbnail = toAbsoluteJiraUrl(attachment.thumbnail) || attachment.content;
      if (attachment.thumbnail) {
        imageLoads.push(
          getDisplayImageUrl(attachment.thumbnail).then(src => {
            attachment.thumbnail = src;
          })
        );
      }
    });

    await Promise.all(imageLoads);
  }

  // ── Text & HTML Formatting ─────────────────────────────────

  function escapeHtml(input) {
    const node = document.createElement('div');
    node.textContent = input || '';
    return node.innerHTML;
  }

  function getMentionDisplayText(rawValue) {
    const normalized = String(rawValue || '')
      .trim()
      .replace(/^accountid:/i, '');
    return normalized ? `@${normalized}` : '@mention';
  }

  function textToLinkedHtml(input, options = {}) {
    const {attachmentImagesByName = {}} = options;
    const mentionHtml = [];
    const inputWithMentions = String(input || '').replace(/\[~([^[\]\r\n]+?)\]/g, function (match, mentionValue) {
      const placeholderIndex = mentionHtml.length;
      mentionHtml.push(`<span class="_JX_mention">${escapeHtml(getMentionDisplayText(mentionValue))}</span>`);
      return `__JX_COMMENT_MENTION_${placeholderIndex}__`;
    });
    const imageHtml = [];
    const inputWithImages = inputWithMentions.replace(/!([^!\r\n]+)!/g, function (match, imageName) {
      const normalizedName = String(imageName || '').trim();
      const imageMarkup = attachmentImagesByName[normalizedName];
      if (!imageMarkup) {
        return match;
      }
      const placeholderIndex = imageHtml.length;
      imageHtml.push(imageMarkup);
      return `__JX_COMMENT_IMAGE_${placeholderIndex}__`;
    });
    const escaped = escapeHtml(inputWithImages);
    const withLinks = escaped.replace(
      /(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    return withLinks
      .replace(/__JX_COMMENT_IMAGE_(\d+)__/g, function (match, index) {
        return imageHtml[Number(index)] || '';
      })
      .replace(/__JX_COMMENT_MENTION_(\d+)__/g, function (match, index) {
        return mentionHtml[Number(index)] || '';
      })
      .replace(/\n/g, '<br/>');
  }

  function formatRelativeDate(created) {
    const createdAt = new Date(created);
    if (Number.isNaN(createdAt.getTime())) {
      return '--';
    }
    const diffMs = Date.now() - createdAt.getTime();
    const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
    if (diffMs >= 0 && diffMs < twoDaysMs) {
      const minuteMs = 60 * 1000;
      const hourMs = 60 * minuteMs;
      const dayMs = 24 * hourMs;
      if (diffMs < hourMs) {
        const minutes = Math.max(1, Math.floor(diffMs / minuteMs));
        return `${minutes}m ago`;
      }
      if (diffMs < dayMs) {
        const hours = Math.max(1, Math.floor(diffMs / hourMs));
        return `${hours}h ago`;
      }
      const days = Math.max(1, Math.floor(diffMs / dayMs));
      return `${days}d ago`;
    }
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(createdAt);
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
    const {imageMaxHeight} = options;
    const temp = sanitizeRichHtml(html);

    const imageNodes = Array.from(temp.querySelectorAll('img[src]'));
    await Promise.all(imageNodes.map(async img => {
      const src = img.getAttribute('src');
      const absoluteSrc = toAbsoluteJiraUrl(src);
      const displaySrc = await getDisplayImageUrl(absoluteSrc);
      const resolvedSrc = displaySrc || absoluteSrc || src;
      if (resolvedSrc) {
        img.setAttribute('src', resolvedSrc);
        img.setAttribute('data-jx-preview-src', resolvedSrc);
        img.classList.add('_JX_previewable');
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

    return temp.innerHTML;
  }

  // ── Comments ──────────────────────────────────────────────

  async function buildCommentsForDisplay(issueData, commentSession = null, reactionState = popupState?.commentReactionState) {
    const issueKey = issueData?.key || '';
    const comments = [...(issueData.fields.comment?.comments || [])].sort((a, b) => {
      return new Date(a.created).getTime() - new Date(b.created).getTime();
    });
    const renderedById = {};
    const currentUser = await getCurrentUserInfo().catch(() => null);
    ((issueData.renderedFields?.comment?.comments) || []).forEach(comment => {
      if (comment && comment.id) {
        renderedById[comment.id] = comment.body;
      }
    });

    return Promise.all(comments.map(async comment => {
      const rendered = renderedById[comment.id];
      const baseHtml = rendered || textToLinkedHtml(comment.body || '');
      const bodyHtml = await normalizeRichHtml(baseHtml, {imageMaxHeight: 100});
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


  function updateCommentActivityCount(delta) {
    const activityItem = container.find('._JX_activity_item').eq(1);
    if (!activityItem.length) {
      return;
    }
    const countNode = activityItem.find('strong');
    const currentCount = Number(countNode.text()) || 0;
    const nextCount = Math.max(0, currentCount + delta);
    countNode.text(String(nextCount));
    activityItem.attr('title', `${nextCount} comments`);
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

  async function appendCommentToPopup(savedComment, commentText, uploadedAttachments = []) {
    const commentsRoot = container.find('._JX_comments');
    if (!commentsRoot.length) {
      return;
    }

    commentsRoot.find('._JX_comments_empty').remove();
    container.find('._JX_empty_body').remove();
    const issueKey = activeCommentContext?.issueKey || popupState?.issueData?.key || '';
    const issueSummary = popupState?.issueData?.fields?.summary || '';
    const currentUser = await getCurrentUserInfo().catch(() => ({displayName: 'You'}));
    const bodyHtml = await buildOptimisticCommentBodyHtml(commentText || '', uploadedAttachments);
    const commentId = String(savedComment?.id || '');
    const commentPermalink = buildCommentPermalink(issueKey, commentId);
    const commentLinkTitleText = `[${issueKey}] ${issueSummary}`.trim();
    const reactionUi = buildCommentReactionUi(commentId);
    const authorUser = savedComment?.author || currentUser;
    const authorView = buildUserView(authorUser);
    const authorAvatarHtml = authorView.avatarUrl
      ? `<img class="_JX_comment_author_avatar" src="${escapeHtml(authorView.avatarUrl)}" alt="">`
      : `<span class="_JX_comment_author_avatar _JX_comment_author_avatar_placeholder">${escapeHtml(authorView.initials)}</span>`;
    const commentHtml = `
      <div class="_JX_comment" data-comment-id="${escapeHtml(commentId)}">
        <div class="_JX_comment_meta">
          <span class="_JX_comment_meta_main">${authorAvatarHtml}<span class="_JX_comment_author">${escapeHtml(authorView.displayName || 'You')}</span> | <a class="_JX_comment_time" href="${escapeHtml(commentPermalink)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(buildLinkHoverTitle('Open comment in Jira', commentLinkTitleText, commentPermalink))}">Just now</a><button class="_JX_comment_meta_icon_button _JX_copy_link" type="button" title="${escapeHtml(buildLinkHoverTitle('Copy comment link', commentLinkTitleText, commentPermalink))}" aria-label="${escapeHtml(buildLinkHoverTitle('Copy comment link', commentLinkTitleText, commentPermalink))}" data-url="${escapeHtml(commentPermalink)}" data-ticket="${escapeHtml(issueKey)}" data-title="${escapeHtml(commentLinkTitleText)}"><svg width="14" height="14" viewBox="0 0 24 24" focusable="false" role="presentation"><g fill="currentColor"><path d="M10 19h8V8h-8v11zM8 7.992C8 6.892 8.902 6 10.009 6h7.982C19.101 6 20 6.893 20 7.992v11.016c0 1.1-.902 1.992-2.009 1.992H10.01A2.001 2.001 0 0 1 8 19.008V7.992z"></path><path d="M5 16V4.992C5 3.892 5.902 3 7.009 3H15v13H5zm2 0h8V5H7v11z"></path></g></svg></button></span>
          <span class="_JX_comment_meta_actions">
            <button class="_JX_comment_meta_button _JX_comment_edit_button" type="button" data-comment-id="${escapeHtml(commentId)}">Edit</button>
            <button class="_JX_comment_meta_button _JX_comment_delete_button" type="button" data-comment-id="${escapeHtml(commentId)}">Delete</button>
          </span>
          ${reactionUi.hasReactionOptions ? `
            <div class="_JX_comment_reactions">
              <div class="_JX_comment_reaction_bar">
                ${reactionUi.reactionPills.map(pill => `
                  <button class="_JX_comment_reaction_pill${pill.reacted ? ' is-reacted' : ''}${pill.pending ? ' is-pending' : ''}" type="button" data-comment-id="${escapeHtml(pill.commentId)}" data-emoji-id="${escapeHtml(pill.emojiId)}" title="${escapeHtml(pill.title)}" aria-label="${escapeHtml(pill.title)}" ${pill.disabledAttr}>
                    <span class="_JX_comment_reaction_emoji" aria-hidden="true">${escapeHtml(pill.emoji)}</span>
                    <span class="_JX_comment_reaction_count">${pill.count}</span>
                  </button>
                `).join('')}
                <details class="_JX_comment_reaction_dropdown">
                  <summary class="_JX_comment_reaction_more" aria-label="Add reaction" title="Add reaction">
                    <svg class="_JX_comment_reaction_more_icon" width="16" height="16" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                      <path fill="currentColor" d="M12 2.75c5.11 0 9.25 4.14 9.25 9.25S17.11 21.25 12 21.25 2.75 17.11 2.75 12 6.89 2.75 12 2.75zm0 1.5A7.75 7.75 0 1 0 19.75 12 7.75 7.75 0 0 0 12 4.25zm-2.5 6.5a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2zm5 0a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2zm-5.04 4.03a.75.75 0 0 1 1.05.11 1.93 1.93 0 0 0 2.98 0 .75.75 0 0 1 1.16.95 3.43 3.43 0 0 1-5.3 0 .75.75 0 0 1 .11-1.06z"></path>
                      <path fill="currentColor" d="M18.5 4.5a.75.75 0 0 1 .75.75V7h1.75a.75.75 0 0 1 0 1.5h-1.75v1.75a.75.75 0 0 1-1.5 0V8.5H16a.75.75 0 0 1 0-1.5h1.75V5.25a.75.75 0 0 1 .75-.75z"></path>
                    </svg>
                  </summary>
                  <div class="_JX_comment_reaction_menu">
                    ${reactionUi.menuReactionOptions.map(option => `
                      <button class="_JX_comment_reaction_button${option.isReacted ? ' is-reacted' : ''}${option.isPending ? ' is-pending' : ''}" type="button" data-comment-id="${escapeHtml(option.commentId)}" data-emoji-id="${escapeHtml(option.emojiId)}" title="${escapeHtml(option.title)}" aria-label="${escapeHtml(option.title)}" ${option.disabledAttr}>
                        <span class="_JX_comment_reaction_emoji" aria-hidden="true">${escapeHtml(option.emoji)}</span>
                      </button>
                    `).join('')}
                  </div>
                </details>
              </div>
            </div>
          ` : ''}
        </div>
        <div class="_JX_comment_body">${bodyHtml}</div>
      </div>
    `;

    const commentList = commentsRoot.find('._JX_comment_list');
    if (commentList.length) {
      commentList.append(commentHtml);
    } else {
      commentsRoot.append(`<div class="_JX_comment_list">${commentHtml}</div>`);
    }
    updateCommentActivityCount(1);
  }

  async function handleCommentSave() {
    if (!activeCommentContext?.issueKey) {
      return;
    }

    resetCommentMentionState();
    const elements = getCommentComposerElements();
    const commentText = elements.input.val().trim();
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
      const uploadedAttachments = getUploadedCommentAttachments();
      const savedComment = await requestJson('POST', `${INSTANCE_URL}rest/api/2/issue/${activeCommentContext.issueKey}/comment`, {
        body: commentText
      });
      await appendCommentToPopup(savedComment, commentText, uploadedAttachments);
      elements.input.val('');
      commentComposerDraftValue = '';
      commentComposerHadFocus = false;
      commentComposerSelectionStart = 0;
      commentComposerSelectionEnd = 0;
      await clearCommentUploads({deleteUploaded: false});
      elements.root.attr('data-saving', 'false');
      setCommentComposerError('');
      syncCommentComposerState();
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
    setCommentSession({
      commentId: String(commentId),
      draft: String(commentBody || ''),
      error: '',
      mode: 'edit',
      selectionEnd: String(commentBody || '').length,
      selectionStart: String(commentBody || '').length,
      saving: false
    });
    renderIssuePopup(popupState).catch(() => {});
  }

  function startCommentDeleteConfirm(commentId) {
    if (!popupState?.issueData || !commentId) {
      return;
    }
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
    const nextDraft = String(activeSession.draft || '');
    if (!nextDraft.trim()) {
      setCommentSession({...activeSession, error: 'Comment cannot be empty.'});
      await renderIssuePopup(popupState);
      return;
    }

    setCommentSession({...activeSession, draft: nextDraft, error: '', saving: true});
    await renderIssuePopup(popupState);

    try {
      await requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${popupState.key}/comment/${commentId}`, {
        body: nextDraft
      });
      await refreshPopupIssueState('Comment updated');
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
      await refreshPopupIssueState('Comment deleted');
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

  // ── Caching ───────────────────────────────────────────────

  async function getCachedValue(cache, key, buildValue) {
    const existing = cache.get(key);
    if (existing && (Date.now() - existing.createdAt) < cacheTtlMs) {
      return existing.value;
    }

    const value = await buildValue();
    cache.set(key, {
      createdAt: Date.now(),
      value
    });
    return value;
  }

  // ── Issue Data & Metadata ──────────────────────────────────

  async function getIssueMetaData(issueKey) {
    return getCachedValue(issueCache, issueKey, async () => {
      const [sprintFieldIds, epicLinkFieldIds] = await Promise.all([
        getSprintFieldIds(INSTANCE_URL),
        getEpicLinkFieldIds(INSTANCE_URL)
      ]);
      const fields = [
        'description',
        'id',
        'project',
        'reporter',
        'assignee',
        'summary',
        'timetracking',
        'attachment',
        'comment',
        'issuetype',
        'status',
        'priority',
        'labels',
        'environment',
        'versions',
        'parent',
        'fixVersions',
        'watches',
        ...sprintFieldIds,
        ...epicLinkFieldIds,
        ...customFields.map(({fieldId}) => fieldId)
      ];
      return get(INSTANCE_URL + 'rest/api/2/issue/' + issueKey + '?fields=' + fields.join(',') + '&expand=renderedFields,names');
    });
  }

  async function getIssueEditMeta(issueKey) {
    if (!issueKey) {
      return {fields: {}};
    }
    return getCachedValue(editMetaCache, issueKey, async () => {
      const data = await get(`${INSTANCE_URL}rest/api/2/issue/${issueKey}/editmeta`);
      return {
        fields: data?.fields || {}
      };
    });
  }

  async function getEditableFieldCapability(issueData, fieldKey) {
    if (!issueData?.key || !fieldKey) {
      return {
        editable: false,
        operations: [],
        allowedValues: []
      };
    }
    const editMeta = await getIssueEditMeta(issueData.key);
    const names = issueData.names || {};
    let resolvedFieldKey = fieldKey;
    if (fieldKey === 'sprint') {
      const sprintFieldIds = await getSprintFieldIds(INSTANCE_URL);
      resolvedFieldKey = pickSprintFieldId(issueData, sprintFieldIds);
    }
    const editMetaField = editMeta.fields?.[resolvedFieldKey];
    const schemaCustom = String(editMetaField?.schema?.custom || '').toLowerCase();
    const schemaType = String(editMetaField?.schema?.type || '').toLowerCase();
    const displayName = String(names[resolvedFieldKey] || editMetaField?.name || '').toLowerCase();
    const looksLikeSprint = fieldKey === 'sprint' ||
      schemaCustom.includes('gh-sprint') ||
      schemaType === 'sprint' ||
      displayName.includes('sprint');
    if (!editMetaField || (fieldKey === 'sprint' && !looksLikeSprint)) {
      return {
        editable: false,
        fieldKey: resolvedFieldKey,
        operations: [],
        allowedValues: []
      };
    }
    return {
      editable: true,
      fieldKey: resolvedFieldKey,
      fieldMeta: editMetaField,
      operations: Array.isArray(editMetaField.operations) ? editMetaField.operations : [],
      allowedValues: Array.isArray(editMetaField.allowedValues) ? editMetaField.allowedValues : []
    };
  }

  async function getTransitionOptions(issueKey) {
    if (!issueKey) {
      return [];
    }
    return getCachedValue(transitionOptionsCache, issueKey, async () => {
      const response = await get(`${INSTANCE_URL}rest/api/2/issue/${issueKey}/transitions`);
      const transitions = Array.isArray(response?.transitions) ? response.transitions : [];
      return transitions
        .filter(transition => transition?.id && transition?.to?.name)
        .map(transition => {
          const targetName = transition.to?.name || '';
          const transitionName = transition.name && transition.name !== targetName
            ? transition.name
            : '';
          const label = transitionName
            ? `${transitionName} -> ${targetName}`
            : targetName;
          const metaText = transitionName || '';
          return buildEditOption(transition.id, label, {
            iconUrl: transition.to?.iconUrl || '',
            metaText,
            searchText: `${label} ${targetName} ${transitionName}`,
            transitionName,
            targetStatusName: targetName
          });
        });
    });
  }

  // ── Assignee Search ────────────────────────────────────────

  function normalizeAssignableUsers(users) {
    const uniqueById = new Map();
    (Array.isArray(users) ? users : []).forEach(user => {
      const view = buildUserView(user);
      const id = view.accountId || view.name || view.key;
      if (!id || uniqueById.has(id)) {
        return;
      }
      const option = buildEditOption(id, view.displayName || id, {
        avatarUrl: view.avatarUrl,
        initials: view.initials,
        metaText: view.emailAddress || view.name || view.key || '',
        searchText: `${view.displayName} ${view.name} ${view.key} ${view.emailAddress}`,
        rawValue: {
          accountId: view.accountId,
          name: view.name,
          key: view.key
        }
      });
      if (option.id && option.label) {
        uniqueById.set(id, option);
      }
    });
    return [...uniqueById.values()];
  }

  async function proxyUserAvatars(users) {
    const beforeUrls = new Map();
    (users || []).forEach(user => {
      const url = user?.avatarUrls?.['48x48'];
      if (url) beforeUrls.set(user, url);
    });
    await Promise.all((users || []).map(user => {
      const url = user?.avatarUrls?.['48x48'];
      if (!url) return Promise.resolve();
      return getDisplayImageUrl(url).then(src => { user.avatarUrls['48x48'] = src; }).catch(() => {});
    }));
    // Propagate shared-avatar status from raw URLs to their proxied data URIs
    for (const [user, rawUrl] of beforeUrls) {
      const proxiedUrl = user?.avatarUrls?.['48x48'];
      if (proxiedUrl && proxiedUrl !== rawUrl && sharedAvatarUrls.has(rawUrl)) {
        sharedAvatarUrls.add(proxiedUrl);
      }
    }
    return users;
  }

  async function fetchAssignableUsers(query, issueData) {
    const issueKey = issueData?.key || '';
    const projectKey = String(issueKey).split('-')[0];
    const encodedQuery = encodeURIComponent(String(query || '').trim());
    const encodedIssueKey = encodeURIComponent(issueKey);
    const encodedProjectKey = encodeURIComponent(projectKey);
    const urls = [
      `${INSTANCE_URL}rest/api/2/user/assignable/search?issueKey=${encodedIssueKey}&maxResults=20&query=${encodedQuery}`,
      `${INSTANCE_URL}rest/api/2/user/assignable/search?issueKey=${encodedIssueKey}&maxResults=20&username=${encodedQuery}`,
      `${INSTANCE_URL}rest/api/2/user/assignable/search?project=${encodedProjectKey}&maxResults=20&query=${encodedQuery}`,
      `${INSTANCE_URL}rest/api/2/user/assignable/search?project=${encodedProjectKey}&maxResults=20&username=${encodedQuery}`
    ].filter(url => !url.includes('issueKey=&') && !url.includes('project=&'));

    let lastError;
    for (const url of urls) {
      try {
        const response = await get(url);
        if (Array.isArray(response)) {
          detectSharedAvatarUrls(response);
          return proxyUserAvatars(response);
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) {
      throw lastError;
    }
    return [];
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
    const urls = [
      `${INSTANCE_URL}rest/api/2/user/search?username=${encodedQuery}&maxResults=20`,
      `${INSTANCE_URL}rest/api/2/user/search?query=${encodedQuery}&maxResults=20`,
      `${INSTANCE_URL}rest/api/2/user/picker?query=${encodedQuery}&maxResults=20`
    ];
    let lastError;
    for (const url of urls) {
      try {
        const response = await get(url);
        const users = Array.isArray(response)
          ? response
          : response?.users || response?.items || [];
        if (Array.isArray(users)) {
          detectSharedAvatarUrls(users);
          await proxyUserAvatars(users);
          return normalizeAssignableUsers(users);
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) {
      throw lastError;
    }
    return [];
  }

  async function searchUserPicker(query) {
    const normalizedQuery = String(query || '').trim().toLowerCase();
    return getCachedValue(userPickerSearchCache, normalizedQuery, () => fetchUserPickerResults(normalizedQuery));
  }

  function getJiraUserIdentityCandidates(user) {
    return [user?.accountId, user?.name, user?.username, user?.key]
      .map(value => String(value || '').trim())
      .filter((value, index, array) => value && array.indexOf(value) === index);
  }

  function buildWatcherUserView(user, currentUser = null) {
    const view = buildUserView(user);
    const displayName = view.displayName || 'Unknown user';
    const identityCandidates = getJiraUserIdentityCandidates(user);
    const id = identityCandidates[0] || '';
    return {
      id,
      accountId: view.accountId,
      name: view.name,
      key: view.key,
      displayName,
      avatarUrl: view.avatarUrl,
      initials: view.initials,
      metaText: view.emailAddress || view.name || view.key || '',
      titleText: `Watcher: ${displayName}`,
      isCurrentUser: areSameJiraUser(user, currentUser),
      rawValue: {
        accountId: view.accountId,
        name: view.name,
        key: view.key,
      }
    };
  }

  function buildClearUserOption(label = 'Clear value') {
    return buildEditOption('__clear__', label, {
      metaText: 'Remove the current user',
      rawValue: null,
    });
  }

  function compareWatcherUsers(left, right) {
    if (!!left?.isCurrentUser !== !!right?.isCurrentUser) {
      return left?.isCurrentUser ? -1 : 1;
    }

    const displayNameComparison = String(left?.displayName || '').localeCompare(
      String(right?.displayName || ''),
      undefined,
      {sensitivity: 'base'}
    );
    if (displayNameComparison !== 0) {
      return displayNameComparison;
    }

    return String(left?.id || '').localeCompare(String(right?.id || ''), undefined, {sensitivity: 'base'});
  }

  function normalizeWatcherUsers(users, currentUser = null) {
    const uniqueById = new Map();
    (Array.isArray(users) ? users : []).forEach(user => {
      const watcher = buildWatcherUserView(user, currentUser);
      if (watcher.id && !uniqueById.has(watcher.id)) {
        uniqueById.set(watcher.id, watcher);
      }
    });
    return [...uniqueById.values()].sort(compareWatcherUsers);
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

  function buildWatchersPanelView(state) {
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

  async function getIssueSummary(issueKey) {
    if (!issueKey) {
      return null;
    }
    return getCachedValue(issueCache, `summary__${issueKey}`, async () => {
      const data = await get(`${INSTANCE_URL}rest/api/2/issue/${issueKey}?fields=summary`);
      return {
        key: issueKey,
        summary: data?.fields?.summary || issueKey
      };
    });
  }

  // ── Issue Linkage & Hierarchy ──────────────────────────────

  function extractIssueKeyFromLinkageValue(value) {
    if (!value) {
      return '';
    }
    if (typeof value === 'string') {
      return value.trim();
    }
    if (typeof value === 'object') {
      return String(value.key || value.value || value.id || '').trim();
    }
    return '';
  }

  function findEpicLinkFieldId(issueData, editMeta) {
    const names = issueData?.names || {};
    const editMetaFields = editMeta?.fields || {};
    const fromNames = Object.keys(names).find(fieldId => {
      const fieldName = String(names[fieldId] || '').toLowerCase();
      return fieldName === 'epic link' || fieldName === 'epic';
    });
    if (fromNames) {
      return fromNames;
    }
    return Object.keys(editMetaFields).find(fieldId => {
      const fieldName = String(editMetaFields[fieldId]?.name || '').toLowerCase();
      return fieldName === 'epic link' || fieldName === 'epic';
    }) || '';
  }

  async function resolveIssueLinkage(issueData) {
    if (!issueData?.key) {
      return {
        mode: '',
        label: 'Parent',
        editable: false,
        fieldKey: '',
        currentLink: null
      };
    }
    const editMeta = await getIssueEditMeta(issueData.key).catch(() => ({fields: {}}));
    const parentValue = issueData?.fields?.parent;
    const parentFieldMeta = editMeta.fields?.parent;
    if (parentValue?.key || parentFieldMeta) {
      const currentKey = parentValue?.key || '';
      const currentSummary = parentValue?.fields?.summary || currentKey;
      return {
        mode: 'parent',
        label: 'Parent',
        editable: !!parentFieldMeta,
        fieldKey: 'parent',
        currentLink: currentKey
          ? {
              key: currentKey,
              summary: currentSummary,
              url: `${INSTANCE_URL}browse/${currentKey}`
            }
          : null
      };
    }

    const epicFieldId = findEpicLinkFieldId(issueData, editMeta);
    const epicKey = extractIssueKeyFromLinkageValue(issueData?.fields?.[epicFieldId]);
    if (!epicFieldId && !epicKey) {
      return {
        mode: '',
        label: 'Parent',
        editable: false,
        fieldKey: '',
        currentLink: null
      };
    }
    let epicSummary = epicKey;
    if (epicKey) {
      try {
        const epicSummaryData = await getIssueSummary(epicKey);
        epicSummary = epicSummaryData?.summary || epicKey;
      } catch (error) {
        epicSummary = epicKey;
      }
    }
    return {
      mode: 'epicLink',
      label: 'Epic',
      editable: !!editMeta.fields?.[epicFieldId],
      fieldKey: epicFieldId,
      currentLink: epicKey
        ? {
            key: epicKey,
            summary: epicSummary,
            url: `${INSTANCE_URL}browse/${epicKey}`
          }
        : null
    };
  }

  function buildIssueSearchOption(issue, extra = {}) {
    const issueKey = String(issue?.key || '').trim();
    const issueSummary = String(issue?.fields?.summary || issue?.summary || issueKey).trim();
    const statusName = issue?.fields?.status?.name || '';
    return buildEditOption(issueKey, `[${issueKey}] ${issueSummary}`.trim(), {
      id: issueKey,
      iconUrl: issue?.fields?.issuetype?.iconUrl || issue?.issuetype?.iconUrl || '',
      metaText: statusName,
      rawValue: {
        key: issueKey,
        summary: issueSummary
      },
      searchText: `${issueKey} ${issueSummary} ${statusName}`,
      ...extra
    });
  }

  function buildIssueSearchCacheKey(query, issueData, mode) {
    const projectKey = String(issueData?.key || '').split('-')[0];
    return `${projectKey}__${mode}__${String(query || '').trim().toLowerCase()}`;
  }

  function getRecentIssueSearchOptions(issueData, mode) {
    const projectKey = String(issueData?.key || '').split('-')[0];
    return issueSearchRecentCache.get(`${projectKey}__${mode}`) || [];
  }

  function setRecentIssueSearchOptions(issueData, mode, options) {
    const projectKey = String(issueData?.key || '').split('-')[0];
    if (!projectKey || !mode) {
      return;
    }
    issueSearchRecentCache.set(`${projectKey}__${mode}`, (Array.isArray(options) ? options : []).slice(0, 30));
  }

  function buildSafeIssueSearchClauses(query, projectKey) {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) {
      return [];
    }

    const clauses = [];
    const tokenClauses = normalizedQuery
      .split(/[^A-Za-z0-9]+/)
      .map(token => token.trim())
      .filter(token => token.length >= 2)
      .slice(0, 4)
      .map(token => {
        const escapedToken = token
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"');
        return `summary ~ \"${escapedToken}*\"`;
      });

    if (tokenClauses.length === 1) {
      clauses.push(tokenClauses[0]);
    } else if (tokenClauses.length > 1) {
      clauses.push(`(${tokenClauses.join(' AND ')})`);
    }

    if (/^\d+$/.test(normalizedQuery)) {
      clauses.push(`key = ${encodeJqlValue(`${projectKey}-${normalizedQuery}`)}`);
    } else if (/^[A-Z][A-Z0-9_]*-\d+$/i.test(normalizedQuery)) {
      clauses.push(`key = ${encodeJqlValue(normalizedQuery.toUpperCase())}`);
    }

    return clauses;
  }

  async function searchParentCandidates(query, issueData, linkageMode) {
    const issueKey = String(issueData?.key || '').trim();
    const projectKey = issueKey.split('-')[0];
    if (!issueKey || !projectKey) {
      return [];
    }
    const normalizedQuery = String(query || '').trim();
    const cacheKey = buildIssueSearchCacheKey(normalizedQuery, issueData, linkageMode || 'linkage');
    return getCachedValue(issueSearchCache, cacheKey, async () => {
      const escapedIssueKey = encodeJqlValue(issueKey);
      const isEpicLinkMode = linkageMode === 'epicLink';
      const jqlParts = [`key != ${escapedIssueKey}`];
      if (!isEpicLinkMode) {
        const escapedProjectKey = encodeJqlValue(projectKey);
        jqlParts.unshift(`project = ${escapedProjectKey}`);
      }
      const searchClauses = buildSafeIssueSearchClauses(normalizedQuery, projectKey);
      if (searchClauses.length) {
        jqlParts.push(`(${searchClauses.join(' OR ')})`);
      }
      const jql = `${jqlParts.join(' AND ')} ORDER BY updated DESC`;
      let response;
      try {
        response = await get(`${INSTANCE_URL}rest/api/2/search?maxResults=20&fields=summary,issuetype,status&jql=${encodeURIComponent(jql)}`);
      } catch (error) {
        const errorText = String(error?.message || error?.inner || error || '');
        if (!errorText.includes('410')) {
          throw error;
        }
        response = await get(`${INSTANCE_URL}rest/api/3/search/jql?maxResults=20&fields=summary,issuetype,status&jql=${encodeURIComponent(jql)}`);
      }
      const issues = Array.isArray(response?.issues) ? response.issues : [];
      const options = issues
        .map(issue => buildIssueSearchOption(issue))
        .filter(option => option.id);
      setRecentIssueSearchOptions(issueData, linkageMode || 'linkage', options);
      return options;
    });
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
    const clearUserOption = isUserField ? buildClearUserOption(`Clear ${fieldName}`) : null;

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

  function normalizeCustomFields(customFields) {
    if (!Array.isArray(customFields)) {
      return [];
    }
    const seen = {};
    return customFields
      .map(field => {
        const fieldId = String(field?.fieldId || '').trim();
        const row = Math.min(3, Math.max(1, Number(field?.row) || 3));
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


  function buildActivityIndicators(attachments, commentsTotal, pullRequestsTotal) {
    const attachmentCount = Array.isArray(attachments) ? attachments.length : 0;
    const commentCount = Number(commentsTotal) || 0;
    const pullRequestCount = Number(pullRequestsTotal) || 0;
    return [
      {icon: '📎', count: attachmentCount, label: 'Attachments'},
      {icon: '💬', count: commentCount, label: 'Comments'},
      {icon: '🔀', count: pullRequestCount, label: 'Pull requests'}
    ].map(item => ({
      ...item,
      title: item.count + ' ' + item.label.toLowerCase()
    }));
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

  function buildPreviewAttachments(attachments) {
    return (attachments || [])
      .filter(attachment => {
        return !!attachment &&
          typeof attachment.mimeType === 'string' &&
          attachment.mimeType.toLowerCase().startsWith('image') &&
          !!attachment.thumbnail;
      })
      .map(attachment => ({
        ...attachment,
        linkTitle: buildLinkHoverTitle('Open attachment', attachment.filename || 'Attachment', attachment.content)
      }));
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

  const sharedAvatarUrls = new Set();

  function detectSharedAvatarUrls(users) {
    if (!Array.isArray(users) || users.length < 2) {
      return;
    }
    const urlCounts = new Map();
    for (const user of users) {
      const url = user?.avatarUrls?.['48x48'] || '';
      if (url) {
        urlCounts.set(url, (urlCounts.get(url) || 0) + 1);
      }
    }
    for (const [url, count] of urlCounts) {
      if (count >= 2) {
        sharedAvatarUrls.add(url);
      }
    }
  }

  function buildUserView(user) {
    const displayName = user?.displayName || user?.name || user?.username || user?.emailAddress || '';
    const rawAvatarUrl = user?.avatarUrls?.['48x48'] || '';
    const useInitials = isLikelyDefaultAvatar(user, rawAvatarUrl);
    return {
      displayName,
      avatarUrl: useInitials ? '' : rawAvatarUrl,
      initials: getUserInitials(displayName, '--'),
      accountId: user?.accountId || '',
      name: user?.name || user?.username || '',
      key: user?.key || '',
      emailAddress: user?.emailAddress || '',
    };
  }

  function getUserInitials(displayName, fallbackInitials = '--') {
    const tokens = String(displayName || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!tokens.length) {
      return fallbackInitials;
    }
    if (tokens.length === 1) {
      return tokens[0].slice(0, 2).toUpperCase();
    }
    return `${tokens[0][0] || ''}${tokens[tokens.length - 1][0] || ''}`.toUpperCase();
  }

  function isLikelyDefaultAvatar(user, avatarUrl) {
    if (!avatarUrl) {
      return true;
    }
    if (user?.isDefaultAvatar === true) {
      return true;
    }
    const JIRA_DEFAULT_AVATAR_DATA_URI = 'data:image/svg+xml;base64,PHN2ZyBpZD0iV2Fyc3R3YV8xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+CiAgPHN0eWxlPgogICAgLnN0MHtmaWxsOiNjMWM3ZDB9CiAgPC9zdHlsZT4KICA8cGF0aCBjbGFzcz0ic3QwIiBkPSJNMTIgMjRDNS40IDI0IDAgMTguNiAwIDEyUzUuNCAwIDEyIDBzMTIgNS40IDEyIDEyLTUuNCAxMi0xMiAxMnoiLz4KICA8cGF0aCBkPSJNMTkuNSAxMmMwLS45LS42LTEuNy0xLjUtMS45LS4yLTMuMS0yLjgtNS42LTYtNS42UzYuMiA3IDYgMTAuMWMtLjkuMi0xLjUgMS0xLjUgMS45IDAgMSAuNyAxLjggMS43IDIgLjYgMi44IDMgNS41IDUuOCA1LjVzNS4yLTIuNyA1LjgtNS41YzEtLjIgMS43LTEgMS43LTJ6IiBmaWxsPSIjZjRmNWY3Ii8+CiAgPHBhdGggY2xhc3M9InN0MCIgZD0iTTEyIDE2LjljLTEgMC0yLS43LTIuMy0xLjYtLjEtLjMgMC0uNS4zLS42LjMtLjEuNSAwIC42LjMuMi42LjggMSAxLjQgMSAuNiAwIDEuMi0uNCAxLjQtMSAuMS0uMy40LS40LjYtLjMuMy4xLjQuNC4zLjYtLjMuOS0xLjMgMS42LTIuMyAxLjZ6Ii8+Cjwvc3ZnPg==';
    const normalizedUrl = String(avatarUrl || '').toLowerCase();
    if (avatarUrl === JIRA_DEFAULT_AVATAR_DATA_URI ||
      normalizedUrl.includes('defaultavatar') ||
      normalizedUrl.includes('/avatar.png') ||
      normalizedUrl.includes('avatar/default') ||
      normalizedUrl.includes('initials=')) {
      return true;
    }
    // Jira Server system default: /secure/useravatar?avatarId=NNN (no ownerId)
    if (/\buseravatar\b/.test(normalizedUrl) && !normalizedUrl.includes('ownerid=')) {
      return true;
    }
    // URL seen by multiple distinct users is a shared default
    if (avatarUrl && sharedAvatarUrls.has(avatarUrl)) {
      return true;
    }
    return false;
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
    const issueUrl = `${INSTANCE_URL}browse/${issueKey}`;
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

  function pickSprintFieldId(issueData, sprintFieldIds) {
    const populatedFieldId = (sprintFieldIds || []).find(fieldId => {
      const value = issueData?.fields?.[fieldId];
      return Array.isArray(value) ? value.length > 0 : !!value;
    });
    return populatedFieldId || sprintFieldIds?.[0] || '';
  }

  // ── Quick Actions ──────────────────────────────────────────


  // ── Popup Data & Rendering ─────────────────────────────────

  async function buildPopupDisplayData(state) {
    const {key, issueData, pullRequests, actionLoadingKey, actionError, lastActionSuccess, actionsOpen, quickActions} = state;
    const normalizedDescription = await normalizeRichHtml(issueData.renderedFields.description, {
      imageMaxHeight: 180
    });
    const commentsForDisplay = await buildCommentsForDisplay(issueData, state.commentSession, state.commentReactionState);
    const fixVersions = issueData.fields.fixVersions || [];
    const affectsVersions = issueData.fields.versions || [];
    const sprints = readSprintsFromIssue(issueData);
    const commentsTotal = commentsForDisplay.length;
    const attachments = issueData.fields.attachment || [];
    const previewAttachments = buildPreviewAttachments(attachments);
    const labels = issueData.fields.labels || [];
    const linkageData = await resolveIssueLinkage(issueData);
    const issueTypeName = issueData.fields.issuetype?.name;
    const statusName = issueData.fields.status?.name;
    const priorityName = issueData.fields.priority?.name;
    const projectKey = key.split('-')[0];
    const [issueTypeCapability, priorityCapability, assigneeCapability, transitionOptions, sprintCapability, affectsCapability, fixVersionsCapability, labelsCapability, environmentCapability, labelSuggestionSupport, summaryCapability, timeTrackingCapability, customFieldChips] = await Promise.all([
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
      getEditableFieldCapability(issueData, 'timetracking').catch(() => ({editable: false})),
      buildCustomFieldChips(issueData, customFields, state)
    ]);
    const statusEditable = Array.isArray(transitionOptions) && transitionOptions.length > 0;
    const issueTypeEditable = !!issueTypeCapability?.editable && normalizeIssueTypeOptions(issueTypeCapability.allowedValues || [], issueData.fields.issuetype).length > 1;
    const priorityEditable = !!priorityCapability?.editable;
    const assigneeEditable = !!assigneeCapability?.editable;
    const labelsEditable = !!labelsCapability?.editable && !!labelSuggestionSupport;
    const environmentEditable = !!environmentCapability?.editable && (environmentCapability.operations || []).includes('set');
    const summaryEditable = !!summaryCapability?.editable && (summaryCapability.operations || []).includes('set');

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
            priorityName || 'No priority',
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
            `Affects: ${formatVersionText(affectsVersions) || '--'}`,
            singleAffectsVersion ? `${scopeJqlToProject(projectKey, `affectedVersion = ${encodeJqlValue(singleAffectsVersion)}`)}` : '',
            {linkLabel: singleAffectsVersion}
          ), state, {
            canEdit: !!affectsCapability?.editable,
            isRightAligned: true
          });
        case 'fixVersions':
          return buildEditableFieldChip('fixVersions', buildFilterChip(
            `Fix version: ${formatVersionText(fixVersions) || '--'}`,
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

    const singleLabel = labels.length === 1 ? labels[0] : '';
    const environmentText = formatEnvironmentDisplayText(issueData.fields.environment);
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

    const copyTicketMeta = ticket => ({
      copyUrl: ticket.url,
      copyTicket: ticket.key,
      copyTitle: ticket.summary
    });

    const issueUrl = INSTANCE_URL + 'browse/' + key;
    const showAttachments = layoutContentBlocks.includes('attachments');
    const showComments = layoutContentBlocks.includes('comments');
    const showTimeTracking = layoutContentBlocks.includes('timeTracking');
    const visibleCommentsTotal = showComments ? commentsTotal : 0;
    const visibleAttachments = showAttachments ? previewAttachments : [];
    const quickActionData = buildQuickActionViewData(actionsOpen, actionLoadingKey, quickActions);
    const reporterView = displayFields.reporter && issueData.fields.reporter
      ? buildUserAvatarView(issueData.fields.reporter, 'Reporter', '--')
      : null;
    const assigneeView = displayFields.assignee
      ? buildAssigneeAvatarView(state, issueData, assigneeEditable)
      : null;
    const titleView = buildTitleView(state, issueData, summaryEditable);
    const watches = issueData.fields.watches || {};
    const watcherCount = Number.isFinite(Number(watches.watchCount)) ? Number(watches.watchCount) : 0;
    const watchersPanel = buildWatchersPanelView(state);
    const timeTrackingSection = showTimeTracking ? buildTimeTrackingSectionPresentation(issueData, state.timeTrackingEditState, timeTrackingCapability) : null;
    const displayData = {
      urlTitle: titleView.urlTitle,
      ticketKey: titleView.ticketKey,
      ticketTitle: titleView.ticketTitle,
      url: titleView.url,
      urlHoverTitle: titleView.urlHoverTitle,
      ...copyTicketMeta({
        key,
        summary: issueData.fields.summary,
        url: issueUrl
      }),
      prs: [],
      description: layoutContentBlocks.includes('description') ? normalizedDescription : '',
      hasBodyContent: true,
      emptyBodyText: (!normalizedDescription && visibleAttachments.length === 0 && visibleCommentsTotal === 0)
        ? 'No description, attachments or comments.'
        : '',
      attachments,
      previewAttachments: visibleAttachments,
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
      row1Chips,
      row2Chips,
      row3Chips,
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
      actionNoticeText: actionError || lastActionSuccess,
      actionNoticeClass: actionError ? '_JX_action_notice_error' : '_JX_action_notice_success',
      hasActionNotice: !!(actionError || lastActionSuccess),
      ...quickActionData
    };
    if (issueData.fields.comment?.comments?.[0]?.id) {
      displayData.commentUrl = `${displayData.url}#comment-${issueData.fields.comment.comments[0].id}`;
    }
    if (showPullRequests && size(pullRequests)) {
      const filteredPullRequests = pullRequests.filter(pr => {
        return pr && pr.url !== location.href;
      });
      displayData.prs = filteredPullRequests.map(pr => {
        return {
          id: pr.id,
          url: pr.url,
          linkUrl: pr.url,
          linkTitle: buildLinkHoverTitle('Open pull request', formatPullRequestTitle(pr), pr.url),
          title: formatPullRequestTitle(pr),
          status: pr.status,
          authorName: formatPullRequestAuthor(pr),
          branchText: formatPullRequestBranch(pr)
        };
      });
    }
    displayData.activityIndicators = buildActivityIndicators(
      displayFields.attachments ? attachments : [],
      visibleCommentsTotal,
      displayData.prs.length
    );
    displayData.hasRow1Meta = !!displayData.watchersTrigger || displayData.activityIndicators.length > 0;
    displayData.hasPrimaryStatusRow = row1Chips.length > 0 || displayData.hasRow1Meta;
    return displayData;
  }
  // ── Popup Positioning ──────────────────────────────────────
  function getRelativeHref(href) {
    const documentHref = document.location.href.split('#')[0];
    if (href.startsWith(documentHref)) {
      return href.slice(documentHref.length);
    }
    return href;
  }

  function clampContainerPosition(left, top) {
    const margin = 8;
    const width = container.outerWidth() || 0;
    const height = container.outerHeight() || 0;
    const viewportLeft = window.scrollX + margin;
    const viewportTop = window.scrollY + margin;
    const viewportRight = window.scrollX + window.innerWidth - margin;
    const viewportBottom = window.scrollY + window.innerHeight - margin;
    const maxLeft = Math.max(viewportLeft, viewportRight - width);
    const maxTop = Math.max(viewportTop, viewportBottom - height);

    return {
      left: Math.min(Math.max(left, viewportLeft), maxLeft),
      top: Math.min(Math.max(top, viewportTop), maxTop)
    };
  }

  function keepContainerVisible() {
    if (containerPinned || !container.html()) {
      return;
    }
    const currentLeft = Number.parseFloat(container.css('left'));
    const currentTop = Number.parseFloat(container.css('top'));
    const fallbackLeft = window.scrollX + 8;
    const fallbackTop = window.scrollY + 8;
    container.css(clampContainerPosition(
      Number.isFinite(currentLeft) ? currentLeft : fallbackLeft,
      Number.isFinite(currentTop) ? currentTop : fallbackTop
    ));
  }

  function computeVisibleContainerPosition(pointerX, pointerY) {
    const preferredLeft = pointerX + 20;
    const preferredTop = pointerY + 25;
    const width = container.outerWidth() || 0;
    const height = container.outerHeight() || 0;
    const viewportRight = window.scrollX + window.innerWidth - 8;
    const viewportBottom = window.scrollY + window.innerHeight - 8;

    let left = preferredLeft;
    let top = preferredTop;

    if (left + width > viewportRight) {
      left = pointerX - width - 15;
    }

    if (top + height > viewportBottom) {
      top = pointerY - height - 15;
    }

    return clampContainerPosition(left, top);
  }

  // ── Popup Rendering & State ────────────────────────────────
  const container = $('<div class="_JX_container" data-testid="jira-popup-root">');
  const previewOverlay = $(`
    <div class="_JX_preview_overlay">
      <img class="_JX_preview_image" />
    </div>
  `);
  $(document.body).append(container);
  $(document.body).append(previewOverlay);
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
    constrainEditPopoversToViewport();
  }
  function invalidatePopupCaches() {
    if (!popupState?.key) {
      return;
    }
    issueCache.delete(popupState.key);
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

  function updatePopupState(nextStateOrUpdater) {
    popupState = typeof nextStateOrUpdater === 'function'
      ? nextStateOrUpdater(popupState)
      : nextStateOrUpdater;
    return popupState;
  }

  function buildPopupInteractionReset(overrides = {}) {
    return {
      actionLoadingKey: '',
      actionError: '',
      lastActionSuccess: '',
      actionsOpen: false,
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

  async function renderUpdatedPopupState(nextStateOrUpdater) {
    const nextState = updatePopupState(nextStateOrUpdater);
    await renderIssuePopup(nextState);
    return nextState;
  }

  async function refreshPopupIssueState(successMessage = '', options = {}) {
    if (!popupState?.key) {
      return;
    }
    const {showSnackBar = false, nextTimeTrackingEditState, refreshWatchersPanel = false, nextWatchersStateChanges = {}, scheduleWatchersFeedbackReset = false} = options;
    const popupKey = popupState.key;
    const shouldRefreshWatchersPanel = !!(refreshWatchersPanel || popupState?.watchersState?.open);
    invalidatePopupCaches();
    const [refreshedIssueData, refreshedWatcherData] = await Promise.all([
      getIssueMetaData(popupKey),
      shouldRefreshWatchersPanel ? getIssueWatchers(popupKey).catch(() => null) : Promise.resolve(null)
    ]);
    await normalizeIssueImages(refreshedIssueData);

    let refreshedPullRequests = [];
    if (showPullRequests) {
      try {
        const pullRequestResponse = await getPullRequestDataCached(refreshedIssueData.id);
        refreshedPullRequests = normalizePullRequests(pullRequestResponse);
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

    if (!popupState || popupState.key !== popupKey) {
      return;
    }

    await renderUpdatedPopupState(currentState => ({
      ...currentState,
      issueData: refreshedIssueData,
      pullRequests: refreshedPullRequests,
      quickActions,
      ...buildPopupInteractionReset({
        lastActionSuccess: showSnackBar ? '' : successMessage,
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
    if (scheduleWatchersFeedbackReset) {
      scheduleWatchersFeedbackClear();
    }
    if (showSnackBar && successMessage) {
      snackBar(successMessage);
    }
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

      if (popupState?.editState?.fieldKey === fieldKey && (popupState.editState.editorType === 'user-search' || popupState.editState.editorType === 'issue-search' || popupState.editState.editorType === 'tempo-account-search')) {
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
    cancel: 'a, button, input, textarea, img, ._JX_description, ._JX_comments, ._JX_comment_body, ._JX_description_text, ._JX_related_pr'
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

  $(document.body).on('click', '._JX_pin_button', function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (!containerPinned) {
      snackBar('Ticket Pinned! Hit esc to close !');
      container.addClass('container-pinned');
      const position = container.position();
      container.css({
        left: position.left - document.scrollingElement.scrollLeft,
        top: position.top - document.scrollingElement.scrollTop,
      });
      containerPinned = true;
      clearTimeout(hideTimeOut);
    }
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

  $(document.body).on('click', '._JX_watchers_trigger', function (e) {
    e.preventDefault();
    e.stopPropagation();
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

  $(document.body).on('click keyup select', '._JX_comment_input', function () {
    commentComposerSelectionStart = typeof this.selectionStart === 'number' ? this.selectionStart : (this.value || '').length;
    commentComposerSelectionEnd = typeof this.selectionEnd === 'number' ? this.selectionEnd : (this.value || '').length;
  });

  $(document.body).on('input', '._JX_comment_edit_input', function (e) {
    e.stopPropagation();
    updateCommentEditDraft(
      e.currentTarget.getAttribute('data-comment-id') || '',
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

  $(document.body).on('click', '._JX_comment_mention_option', function (e) {
    e.preventDefault();
    const index = Number(e.currentTarget.getAttribute('data-mention-index'));
    if (Number.isNaN(index)) {
      return;
    }
    applyCommentMentionSelection(index);
  });

  $(document.body).on('mousedown', function (e) {
    if ($(e.target).closest('._JX_comment_compose').length) {
      return;
    }
    resetCommentMentionState();
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
    previewOverlay.removeClass('is-open');
    previewOverlay.find('img').attr('src', '');
  }

  async function openPreviewOverlay(imageUrl) {
    if (!imageUrl) {
      return;
    }
    const displaySrc = await getDisplayImageUrl(imageUrl);
    previewOverlay.find('img').attr('src', displaySrc || imageUrl);
    previewOverlay.addClass('is-open');
  }

  previewOverlay.on('click', function (e) {
    if (e.target === previewOverlay[0]) {
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

  // ── Container Lifecycle ────────────────────────────────────
  function hideContainer() {
    lastHoveredKey = '';
    clearWatchersFeedbackTimer();
    popupState = null;
    discardCommentComposerDraft().catch(() => {});
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

  let hideTimeOut;
  let hoverDelayTimeout;
  let containerPinned = false;
  let lastHoveredKey = '';
  container.on('dragstop', () => {
    if (!containerPinned) {
      snackBar('Ticket Pinned! Hit esc to close !');
      container.addClass('container-pinned');
      const position = container.position();
      container.css({
        left: position.left - document.scrollingElement.scrollLeft,
        top: position.top - document.scrollingElement.scrollTop,
      });
      containerPinned = true;
      clearTimeout(hideTimeOut);
    }
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

  let pendingHover = null;

  function isModifierSatisfied(e) {
    if (hoverModifierKey === 'alt') return e.altKey;
    if (hoverModifierKey === 'ctrl') return e.ctrlKey;
    if (hoverModifierKey === 'shift') return e.shiftKey;
    if (hoverModifierKey === 'any') return e.altKey || e.ctrlKey || e.shiftKey;
    return true;
  }

  function fetchAndShowPopup(key, pointerX, pointerY) {
    (async function (cancelToken) {
      const issueData = await getIssueMetaData(key);
      await normalizeIssueImages(issueData);
      let pullRequests = [];
      if (showPullRequests) {
        try {
          const pullRequestResponse = await getPullRequestDataCached(issueData.id);
          pullRequests = normalizePullRequests(pullRequestResponse);
        } catch (ex) {
          console.log('[Jira HotLinker] Pull request fetch failed', {
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
        pullRequests,
        pointerX,
        pointerY,
        quickActions,
        commentReactionState,
        ...buildPopupInteractionReset(),
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
    pendingHover = null;
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
      if (!pendingHover || containerPinned) {
        return;
      }
      if (isModifierSatisfied(e)) {
        triggerPopupForKey(pendingHover.key, pendingHover.pointerX, pendingHover.pointerY, true);
      }
    });
  }

  $(document.body).on('mousemove', debounce(function (e) {
    if (e.buttons || cancelToken.cancel) {
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
      pendingHover = null;
      clearTimeout(hoverDelayTimeout);
      lastHoveredKey = '';
      hideTimeOut = setTimeout(hideContainer, 250);
      return;
    }
    if (element) {
      let keys = detectJiraKeysAtPoint(element);
      if (!size(keys)) {
        keys = detectLayeredJiraKeysFromPoint(e.clientX, e.clientY);
      }

      if (size(keys)) {
        const key = keys[0].replace(' ', '-');

        if (hoverModifierKey !== 'none' && !isModifierSatisfied(e)) {
          pendingHover = {key, pointerX: e.pageX, pointerY: e.pageY};
          return;
        }
        pendingHover = null;

        clearTimeout(hideTimeOut);
        triggerPopupForKey(key, e.pageX, e.pageY, hoverModifierKey !== 'none');
      }
    }
  }, 100));
}

if (!window.__JX__script_injected__) {
  waitForDocument(mainAsyncLocal);
}

window.__JX__script_injected__ = true;
