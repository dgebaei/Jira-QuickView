/*global chrome */
import size from 'lodash/size';
import debounce from 'lodash/debounce';
import regexEscape from 'escape-string-regexp';
import Mustache from 'mustache';
import {waitForDocument} from 'src/utils';
import {sendMessage, storageGet, storageSet} from 'src/chrome';
import {snackBar} from 'src/snack';
import config from 'options/config.js';

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

async function requestJson(method, url, body) {
  return unwrapResponse(await sendMessage({action: 'requestJson', method, url, body}));
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
    labels: true,
    epicParent: true,
    attachments: true,
    comments: true,
    description: true,
    reporter: true,
    assignee: true,
    pullRequests: true,
    ...(config.displayFields || {})
  };
  const hoverDepth = config.hoverDepth || 'shallow';
  const hoverModifierKey = config.hoverModifierKey || 'none';
  const customFields = normalizeCustomFields(config.customFields);
  let jiraProjects = [];
  let getJiraKeys = buildFallbackJiraKeyMatcher();
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
  let currentUserPromise;
  const projectSprintOptionsPromises = new Map();
  const editMetaCache = new Map();
  const transitionOptionsCache = new Map();
  const assigneeSearchCache = new Map();
  const assigneeLocalOptionsCache = new Map();
  const issueSearchCache = new Map();
  const issueSearchRecentCache = new Map();
  const labelSuggestionCache = new Map();
  const labelLocalOptionsCache = new Map();
  const tempoAccountSearchCache = new Map();
  let labelSuggestionSupportPromise = null;
  let preferredAssigneeIdentifier = '';
  let editSearchRequestCounter = 0;
  let labelSearchTimeoutId = null;
  let popupState = null;
  let activeCommentContext = null;
  let commentMentionState = emptyCommentMentionState();
  let commentMentionRequestId = 0;
  let commentUploadState = emptyCommentUploadState();
  let commentUploadSessionId = 0;
  let commentUploadSequence = 0;


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

  async function buildCommentsForDisplay(issueData) {
    const comments = [...(issueData.fields.comment?.comments || [])].sort((a, b) => {
      return new Date(a.created).getTime() - new Date(b.created).getTime();
    });
    const renderedById = {};
    ((issueData.renderedFields?.comment?.comments) || []).forEach(comment => {
      if (comment && comment.id) {
        renderedById[comment.id] = comment.body;
      }
    });

    return Promise.all(comments.map(async comment => {
      const rendered = renderedById[comment.id];
      const baseHtml = rendered || textToLinkedHtml(comment.body || '');
      const bodyHtml = await normalizeRichHtml(baseHtml, {imageMaxHeight: 100});
      return {
        author: comment.author?.displayName || 'Unknown',
        created: formatRelativeDate(comment.created),
        bodyHtml
      };
    }));
  }

  async function getCurrentUserInfo() {
    if (currentUserPromise) {
      return currentUserPromise;
    }

    currentUserPromise = (async () => {
      try {
        const myself = await get(INSTANCE_URL + 'rest/api/2/myself');
        return {
          displayName: myself?.displayName || myself?.name || myself?.username || 'You'
        };
      } catch (primaryError) {
        const session = await get(INSTANCE_URL + 'rest/auth/1/session');
        const user = session?.user || {};
        return {
          displayName: user.displayName || user.name || user.username || 'You'
        };
      }
    })().catch(error => {
      currentUserPromise = null;
      throw error;
    });

    return currentUserPromise;
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

  function getCommentComposerElements() {
    return {
      root: container.find('._JX_comment_compose'),
      input: container.find('._JX_comment_input'),
      mentions: container.find('._JX_comment_mentions'),
      uploads: container.find('._JX_comment_uploads'),
      save: container.find('._JX_comment_save'),
      discard: container.find('._JX_comment_discard'),
      error: container.find('._JX_comment_error')
    };
  }

  function hasCommentUploadInFlight() {
    return commentUploadState.items.some(item => item.status === 'uploading');
  }

  function getUploadedCommentAttachments() {
    return commentUploadState.items.filter(item => item.status === 'uploaded' && item.attachmentId);
  }

  function renderCommentUploads() {
    const {uploads} = getCommentComposerElements();
    if (!uploads.length) {
      return;
    }

    if (!commentUploadState.items.length) {
      uploads.attr('hidden', 'hidden').empty();
      keepContainerVisible();
      return;
    }

    uploads.removeAttr('hidden').html(commentUploadState.items.map(item => {
      const stateClass = item.status === 'error' ? ' is-error' : '';
      const statusText = item.status === 'uploading'
        ? 'Uploading to Jira...'
        : (item.status === 'uploaded' ? 'Attached to issue' : (item.errorMessage || 'Upload failed'));
      const previewHtml = item.previewUrl
        ? `<img class="_JX_comment_upload_preview" src="${escapeHtml(item.previewUrl)}" alt="${escapeHtml(item.fileName)}" />`
        : '<span class="_JX_comment_upload_preview"></span>';
      return `
        <div class="_JX_comment_upload${stateClass}">
          ${previewHtml}
          <span>
            <span class="_JX_comment_upload_name">${escapeHtml(item.fileName)}</span>
            <span class="_JX_comment_upload_status">${escapeHtml(statusText)}</span>
          </span>
        </div>
      `;
    }).join(''));
    keepContainerVisible();
  }

  function updateCommentUploadItem(localId, updater) {
    const nextItems = commentUploadState.items.map(item => {
      if (item.localId !== localId) {
        return item;
      }
      return typeof updater === 'function' ? updater(item) : {...item, ...updater};
    });
    commentUploadState = {items: nextItems};
    renderCommentUploads();
    syncCommentComposerState();
  }

  function buildPastedImageFileName(file) {
    const mimeType = String(file?.type || '').toLowerCase();
    const extensionByMimeType = {
      'image/bmp': 'bmp',
      'image/gif': 'gif',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp'
    };
    const extension = extensionByMimeType[mimeType] || 'png';
    commentUploadSequence += 1;
    const timestamp = new Date().toISOString().replace(/[^\d]/g, '').slice(0, 14);
    return `pasted-image-${timestamp}-${commentUploadSequence}.${extension}`;
  }

  function buildCommentImageMarkup(fileName) {
    return `!${fileName}!`;
  }

  function replaceCommentInputText(searchValue, replaceValue = '') {
    const {input} = getCommentComposerElements();
    const inputElement = input.get(0);
    if (!inputElement || !searchValue) {
      return false;
    }
    const currentValue = inputElement.value || '';
    const nextValue = currentValue.replace(searchValue, replaceValue).replace(/\n{3,}/g, '\n\n');
    if (nextValue === currentValue) {
      return false;
    }
    input.val(nextValue);
    const caretPosition = Math.min(nextValue.length, (typeof inputElement.selectionStart === 'number' ? inputElement.selectionStart : nextValue.length));
    inputElement.setSelectionRange(caretPosition, caretPosition);
    return true;
  }

  function insertCommentInputText(text) {
    const {input} = getCommentComposerElements();
    const inputElement = input.get(0);
    if (!inputElement) {
      return false;
    }
    const value = inputElement.value || '';
    const selectionStart = typeof inputElement.selectionStart === 'number' ? inputElement.selectionStart : value.length;
    const selectionEnd = typeof inputElement.selectionEnd === 'number' ? inputElement.selectionEnd : selectionStart;
    const prefix = selectionStart > 0 && value.charAt(selectionStart - 1) !== '\n' ? '\n' : '';
    const suffix = selectionEnd < value.length
      ? (value.charAt(selectionEnd) !== '\n' ? '\n' : '')
      : '\n';
    const insertedText = `${prefix}${text}${suffix}`;
    const nextValue = value.slice(0, selectionStart) + insertedText + value.slice(selectionEnd);
    input.val(nextValue);
    inputElement.focus();
    const caretPosition = selectionStart + insertedText.length;
    inputElement.setSelectionRange(caretPosition, caretPosition);
    return true;
  }

  function revokeCommentUploadPreview(item) {
    if (item?.previewUrl && item.previewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(item.previewUrl);
    }
  }

  async function deleteCommentDraftAttachment(attachmentId) {
    if (!attachmentId) {
      return;
    }
    try {
      await requestJson('DELETE', `${INSTANCE_URL}rest/api/2/attachment/${attachmentId}`);
    } catch (error) {
      console.warn('[Jira HotLinker] Could not delete draft attachment', {
        attachmentId,
        error: error?.message || String(error)
      });
    }
  }

  async function clearCommentUploads(options = {}) {
    const {deleteUploaded = false} = options;
    const previousItems = commentUploadState.items;
    commentUploadSessionId += 1;
    commentUploadState = emptyCommentUploadState();
    renderCommentUploads();
    syncCommentComposerState();
    previousItems.forEach(revokeCommentUploadPreview);
    if (deleteUploaded) {
      await Promise.all(previousItems.map(item => deleteCommentDraftAttachment(item.attachmentId)));
    }
  }

  async function discardCommentComposerDraft(options = {}) {
    const {deleteUploaded = true} = options;
    resetCommentMentionState();
    const {input} = getCommentComposerElements();
    if (input.length) {
      input.val('');
    }
    setCommentComposerError('');
    await clearCommentUploads({deleteUploaded});
    syncCommentComposerState();
  }

  async function buildOptimisticCommentBodyHtml(commentText, uploadedAttachments = []) {
    const attachmentImagesByName = {};
    for (const attachment of uploadedAttachments) {
      if (!attachment?.fileName) {
        continue;
      }
      const imageUrl = attachment.thumbnailUrl || attachment.contentUrl;
      if (!imageUrl) {
        continue;
      }
      const displaySrc = await getDisplayImageUrl(imageUrl).catch(() => imageUrl);
      const previewSrc = attachment.contentUrl || imageUrl;
      attachmentImagesByName[attachment.fileName] = `<img class="_JX_previewable" src="${escapeHtml(displaySrc || imageUrl)}" data-jx-preview-src="${escapeHtml(previewSrc)}" alt="${escapeHtml(attachment.fileName)}" style="max-height: 100px;" />`;
    }
    return textToLinkedHtml(commentText || '', {attachmentImagesByName});
  }

  async function uploadPastedImage(file) {
    if (!activeCommentContext?.issueKey) {
      return;
    }

    const issueKey = activeCommentContext.issueKey;
    const fileName = buildPastedImageFileName(file);
    const markup = buildCommentImageMarkup(fileName);
    const localId = `upload-${Date.now()}-${commentUploadSequence}`;
    const previewUrl = URL.createObjectURL(file);
    const sessionId = commentUploadSessionId;
    commentUploadState = {
      items: [...commentUploadState.items, {
        attachmentId: '',
        contentUrl: '',
        errorMessage: '',
        fileName,
        localId,
        markup,
        previewUrl,
        status: 'uploading',
        thumbnailUrl: ''
      }]
    };
    renderCommentUploads();
    insertCommentInputText(markup);
    setCommentComposerError('');
    syncCommentComposerState();

    try {
      const uploadResult = await uploadAttachment(`${INSTANCE_URL}rest/api/2/issue/${issueKey}/attachments`, new File([file], fileName, {type: file.type || 'image/png'}));
      const uploadedAttachment = (Array.isArray(uploadResult) ? uploadResult : [uploadResult]).find(item => item && item.id);
      if (!uploadedAttachment) {
        throw new Error('Attachment upload failed');
      }

      if (sessionId !== commentUploadSessionId || activeCommentContext?.issueKey !== issueKey) {
        await deleteCommentDraftAttachment(uploadedAttachment.id);
        return;
      }

      const nextFileName = uploadedAttachment.filename || fileName;
      const nextMarkup = buildCommentImageMarkup(nextFileName);
      if (nextMarkup !== markup) {
        replaceCommentInputText(markup, nextMarkup);
      }
      updateCommentUploadItem(localId, {
        attachmentId: uploadedAttachment.id,
        contentUrl: toAbsoluteJiraUrl(uploadedAttachment.content),
        errorMessage: '',
        fileName: nextFileName,
        markup: nextMarkup,
        status: 'uploaded',
        thumbnailUrl: toAbsoluteJiraUrl(uploadedAttachment.thumbnail || uploadedAttachment.content)
      });
    } catch (error) {
      if (sessionId !== commentUploadSessionId) {
        return;
      }
      replaceCommentInputText(markup, '');
      updateCommentUploadItem(localId, {
        errorMessage: error?.message || error?.inner || 'Upload failed',
        status: 'error'
      });
      setCommentComposerError(error?.message || error?.inner || 'Could not upload pasted image');
    }
  }

  function getClipboardImageFiles(event) {
    const clipboardData = event?.originalEvent?.clipboardData || event?.clipboardData;
    if (!clipboardData) {
      return [];
    }

    const items = Array.from(clipboardData.items || []);
    const itemFiles = items
      .filter(item => item && item.kind === 'file' && String(item.type || '').toLowerCase().startsWith('image/'))
      .map(item => item.getAsFile())
      .filter(Boolean);
    if (itemFiles.length) {
      return itemFiles;
    }
    return Array.from(clipboardData.files || []).filter(file => String(file?.type || '').toLowerCase().startsWith('image/'));
  }

  function renderCommentMentionSuggestions() {
    const {mentions} = getCommentComposerElements();
    if (!mentions.length) {
      return;
    }

    if (!commentMentionState.visible) {
      mentions.attr('hidden', 'hidden').empty();
      keepContainerVisible();
      return;
    }

    if (commentMentionState.loading) {
      mentions.removeAttr('hidden').html('<div class="_JX_comment_mentions_status">Searching people...</div>');
      keepContainerVisible();
      return;
    }

    if (commentMentionState.error) {
      mentions.removeAttr('hidden').html(`<div class="_JX_comment_mentions_status">${escapeHtml(commentMentionState.error)}</div>`);
      keepContainerVisible();
      return;
    }

    if (!commentMentionState.suggestions.length) {
      mentions.removeAttr('hidden').html('<div class="_JX_comment_mentions_status">No people found.</div>');
      keepContainerVisible();
      return;
    }

    mentions.removeAttr('hidden').html(commentMentionState.suggestions.map(function (candidate, index) {
      const selectedClass = index === commentMentionState.selectedIndex ? ' is-selected' : '';
      const secondary = candidate.secondaryText
        ? `<span class="_JX_comment_mention_secondary">${escapeHtml(candidate.secondaryText)}</span>`
        : '';
      return `
        <button class="_JX_comment_mention_option${selectedClass}" type="button" data-mention-index="${index}">
          <span>
            <span class="_JX_comment_mention_primary">${escapeHtml(candidate.displayName)}</span>
            ${secondary}
          </span>
        </button>
      `;
    }).join(''));
    keepContainerVisible();
  }

  function resetCommentMentionState() {
    commentMentionRequestId += 1;
    debouncedLoadCommentMentionSuggestions.cancel();
    commentMentionState = emptyCommentMentionState();
    renderCommentMentionSuggestions();
  }

  function getActiveCommentMention(inputElement) {
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

    return {
      end,
      query: mentionMatch[2],
      start: caretStart - mentionMatch[2].length - 1
    };
  }

  async function loadCommentMentionSuggestions(mention) {
    const requestId = ++commentMentionRequestId;
    try {
      const suggestions = await searchCommentMentionCandidates(mention.query);
      if (requestId !== commentMentionRequestId) {
        return;
      }

      commentMentionState = {
        error: '',
        loading: false,
        query: mention.query,
        range: mention,
        selectedIndex: 0,
        suggestions,
        visible: true
      };
    } catch (error) {
      if (requestId !== commentMentionRequestId) {
        return;
      }

      commentMentionState = {
        error: 'Could not load people.',
        loading: false,
        query: mention.query,
        range: mention,
        selectedIndex: 0,
        suggestions: [],
        visible: true
      };
    }

    renderCommentMentionSuggestions();
  }

  const debouncedLoadCommentMentionSuggestions = debounce(function (mention) {
    loadCommentMentionSuggestions(mention).catch(() => {});
  }, 150);

  function syncCommentMentionSuggestions(inputElement) {
    const mention = getActiveCommentMention(inputElement);
    if (!mention) {
      resetCommentMentionState();
      return;
    }

    commentMentionState = {
      error: '',
      loading: true,
      query: mention.query,
      range: mention,
      selectedIndex: 0,
      suggestions: [],
      visible: true
    };
    renderCommentMentionSuggestions();
    debouncedLoadCommentMentionSuggestions(mention);
  }

  function moveCommentMentionSelection(delta) {
    if (!commentMentionState.visible || !commentMentionState.suggestions.length) {
      return;
    }
    const suggestionsTotal = commentMentionState.suggestions.length;
    const nextIndex = (commentMentionState.selectedIndex + delta + suggestionsTotal) % suggestionsTotal;
    commentMentionState = {
      ...commentMentionState,
      selectedIndex: nextIndex
    };
    renderCommentMentionSuggestions();
  }

  function applyCommentMentionSelection(index) {
    const {input} = getCommentComposerElements();
    const inputElement = input.get(0);
    const candidate = commentMentionState.suggestions[index];
    const mentionRange = commentMentionState.range;
    if (!inputElement || !candidate || !mentionRange) {
      return;
    }

    const nextValue = inputElement.value.slice(0, mentionRange.start) +
      `${candidate.mentionMarkup} ` +
      inputElement.value.slice(mentionRange.end);
    input.val(nextValue);
    inputElement.focus();
    const caretPosition = mentionRange.start + candidate.mentionMarkup.length + 1;
    inputElement.setSelectionRange(caretPosition, caretPosition);
    resetCommentMentionState();
    syncCommentComposerState();
  }

  function syncCommentComposerState() {
    const elements = getCommentComposerElements();
    if (!elements.root.length) {
      return;
    }
    const isSaving = elements.root.attr('data-saving') === 'true';
    const hasUploadsInFlight = hasCommentUploadInFlight();
    const hasText = !!elements.input.val().trim();
    const hasDraftUploads = commentUploadState.items.length > 0;
    elements.input.prop('disabled', isSaving);
    elements.save.prop('disabled', !hasText || isSaving || hasUploadsInFlight).text(isSaving ? 'Saving...' : (hasUploadsInFlight ? 'Uploading...' : 'Save'));
    elements.discard.prop('disabled', (!hasText && !hasDraftUploads) || isSaving);
  }

  function setCommentComposerError(message) {
    const {error} = getCommentComposerElements();
    if (!error.length) {
      return;
    }
    error.text(message || '');
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

  async function appendCommentToPopup(commentText, uploadedAttachments = []) {
    const commentsRoot = container.find('._JX_comments');
    if (!commentsRoot.length) {
      return;
    }

    commentsRoot.find('._JX_comments_empty').remove();
    container.find('._JX_empty_body').remove();
    const currentUser = await getCurrentUserInfo().catch(() => ({displayName: 'You'}));
    const bodyHtml = await buildOptimisticCommentBodyHtml(commentText || '', uploadedAttachments);
    const commentHtml = `
      <div class="_JX_comment">
        <div class="_JX_comment_meta">
          <span class="_JX_comment_author">${escapeHtml(currentUser.displayName || 'You')}</span> | <span class="_JX_comment_time">Just now</span>
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
      await requestJson('POST', `${INSTANCE_URL}rest/api/2/issue/${activeCommentContext.issueKey}/comment`, {
        body: commentText
      });
      await appendCommentToPopup(commentText, uploadedAttachments);
      elements.input.val('');
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
        'attachment',
        'comment',
        'issuetype',
        'status',
        'priority',
        'labels',
        'versions',
        'parent',
        'fixVersions',
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
      const option = buildEditOption(
        user?.accountId || user?.name || user?.key,
        user?.displayName || user?.name || user?.key || '',
        {
          avatarUrl: user?.avatarUrls?.['48x48'] || '',
          metaText: user?.emailAddress || user?.name || user?.key || '',
          searchText: `${user?.displayName || ''} ${user?.name || ''} ${user?.key || ''} ${user?.emailAddress || ''}`,
          rawValue: {
            accountId: user?.accountId || '',
            name: user?.name || '',
            key: user?.key || ''
          }
        }
      );
      if (option.id && option.label && !uniqueById.has(option.id)) {
        uniqueById.set(option.id, option);
      }
    });
    return [...uniqueById.values()];
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
          return response;
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
      const response = await get(`${INSTANCE_URL}rest/api/2/search?maxResults=20&fields=summary,issuetype,status&jql=${encodeURIComponent(jql)}`);
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
    return String(entry.name || entry.value || entry.displayName || entry.key || entry.id || '');
  }

  function buildCustomFieldOption(fieldName, entry) {
    const label = getCustomFieldPrimitive(entry);
    if (!label) {
      return null;
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
    return !!(entry.id || entry.value || entry.name);
  }

  function buildCustomFieldSaveValue(rawValue, supportDescriptor) {
    if (rawValue === undefined || rawValue === null) {
      return rawValue;
    }
    if (supportDescriptor?.valueKind === 'primitive') {
      return rawValue;
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
    if (!capability.editable || !fieldMeta || !Array.isArray(capability.allowedValues) || !capability.allowedValues.length) {
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
    const allowedOptions = capability.allowedValues
      .filter(entry => isSupportedCustomFieldAllowedValue(entry, supportDescriptor))
      .map(entry => buildCustomFieldOption(fieldName, entry))
      .filter(Boolean);
    const allOptions = mergeEditOptions(currentSelections, allowedOptions);

    if (!allOptions.length) {
      return null;
    }

    if (isMultiValue && !operations.includes('set')) {
      return null;
    }
    if (!isMultiValue && !operations.includes('set')) {
      return null;
    }

    return {
      fieldKey: fieldId,
      editorType: isMultiValue ? 'multi-select' : 'single-select',
      label: fieldName,
      fieldMeta,
      supportDescriptor,
      selectionMode: isMultiValue ? 'multi' : 'single',
      currentText: buildCustomFieldValueText(fieldName, currentValue),
      currentOptionId: !isMultiValue && currentSelections[0] ? currentSelections[0].id : null,
      currentSelections,
      initialInputValue: isMultiValue ? '' : '',
      loadOptions: async () => allOptions,
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
      successMessage: () => `${fieldName} updated`
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
      if (rawValue === undefined || rawValue === null || rawValue === '') {
        continue;
      }
      const fieldName = String(names[fieldId] || fieldId);
      const supportedDefinition = await getCustomFieldEditorDefinition(fieldId, issueData).catch(() => null);
      if (supportedDefinition) {
        chipsByRow[row].push(buildEditableFieldChip(fieldId, buildCustomFieldChipData(
          fieldId,
          fieldName,
          rawValue,
          supportedDefinition.fieldMeta,
          supportedDefinition.supportDescriptor
        ), state, {
          canEdit: true,
          editTitle: `Edit ${fieldName}`
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

  function buildQuickActionError(error) {
    return error?.message || error?.inner || 'Action failed';
  }

  // ── User & Quick Actions ───────────────────────────────────

  function areSameJiraUser(left, right) {
    if (!left || !right) {
      return false;
    }
    const leftIds = [left.accountId, left.name, left.username, left.key].filter(Boolean);
    const rightIds = [right.accountId, right.name, right.username, right.key].filter(Boolean);
    return leftIds.some(value => rightIds.includes(value));
  }

  async function getCurrentUserInfo() {
    if (currentUserPromise) {
      return currentUserPromise;
    }

    currentUserPromise = (async () => {
      try {
        const myself = await get(INSTANCE_URL + 'rest/api/2/myself');
        return {
          accountId: myself?.accountId || '',
          name: myself?.name || myself?.username || myself?.key || '',
          username: myself?.username || myself?.name || '',
          key: myself?.key || '',
          displayName: myself?.displayName || myself?.name || myself?.username || 'You'
        };
      } catch (primaryError) {
        const session = await get(INSTANCE_URL + 'rest/auth/1/session');
        const user = session?.user || {};
        return {
          accountId: '',
          name: user.name || user.username || user.key || '',
          username: user.username || user.name || '',
          key: user.key || '',
          displayName: user.displayName || user.name || user.username || 'You'
        };
      }
    })().catch(error => {
      currentUserPromise = null;
      throw error;
    });

    return currentUserPromise;
  }

  function buildAssignPayload(user) {
    if (user?.accountId) {
      return {accountId: user.accountId};
    }
    if (user?.name) {
      return {name: user.name};
    }
    if (user?.key) {
      return {key: user.key};
    }
    throw new Error('Could not resolve the current Jira user');
  }

  async function getAvailableTransitions(issueKey) {
    const response = await get(`${INSTANCE_URL}rest/api/2/issue/${issueKey}/transitions`);
    return Array.isArray(response?.transitions) ? response.transitions : [];
  }

  // ── Status Transitions ─────────────────────────────────────

  function isInProgressStatusCategory(statusCategory) {
    const key = String(statusCategory?.key || '').toLowerCase();
    const name = String(statusCategory?.name || '').toLowerCase();
    return key === 'indeterminate' || name.includes('in progress');
  }

  function buildTransitionActionLabel(transition) {
    const transitionName = String(transition?.name || '').trim();
    const targetName = String(transition?.to?.name || '').trim();
    const normalizedTransitionName = transitionName.toLowerCase();

    if (
      normalizedTransitionName.includes('start') ||
      normalizedTransitionName.includes('progress') ||
      normalizedTransitionName.includes('begin') ||
      normalizedTransitionName.includes('resume')
    ) {
      return transitionName || 'Start progress';
    }

    if (targetName) {
      return `Move to ${targetName}`;
    }

    return transitionName || 'Start progress';
  }

  function findStartProgressTransition(transitions) {
    const candidates = Array.isArray(transitions) ? transitions.filter(Boolean) : [];
    return candidates.find(transition => {
      const transitionName = String(transition?.name || '').toLowerCase();
      const targetName = String(transition?.to?.name || '').toLowerCase();
      return isInProgressStatusCategory(transition?.to?.statusCategory) ||
        targetName.includes('in progress') ||
        transitionName.includes('start progress') ||
        transitionName.includes('start work') ||
        transitionName.includes('begin progress') ||
        transitionName.includes('begin work') ||
        transitionName.includes('resume progress');
    }) || null;
  }

  function buildEditFieldError(error) {
    return error?.message || error?.inner || 'Update failed';
  }

  // ── Edit Options & Multi-Select ────────────────────────────

  function buildEditOption(id, label, extra = {}) {
    const normalizedLabel = String(label || '');
    const normalizedSearchText = [
      normalizedLabel,
      String(extra.searchText || ''),
      String(extra.metaText || '')
    ]
      .join(' ')
      .trim()
      .toLowerCase();
    const option = {
      id: id === '' ? '' : String(id || ''),
      label: normalizedLabel,
      ...extra
    };
    option.searchText = normalizedSearchText;
    return option;
  }

  function formatSprintOptionLabel(sprint) {
    if (!sprint) {
      return '';
    }
    return sprint.state ? `${sprint.name} (${String(sprint.state).toUpperCase()})` : sprint.name;
  }

  function normalizeFixVersionSortName(name) {
    return String(name || '').trim().replace(/^v(?=\d)/i, '');
  }

  function compareFixVersionOptions(left, right) {
    return normalizeFixVersionSortName(right?.name).localeCompare(normalizeFixVersionSortName(left?.name), undefined, {
      numeric: true,
      sensitivity: 'base'
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
      hasChanges: !areSameOptionIds(selectedOptionIds, originalOptionIds)
    };
  }

  // ── Field Option Retrieval ─────────────────────────────────

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

  async function getFixVersionOptions(issueData) {
    return getProjectVersionOptions(issueData, 'fixVersions');
  }

  async function getAffectsVersionOptions(issueData) {
    return getProjectVersionOptions(issueData, 'versions');
  }

  async function getCandidateSprintBoards(issueData) {
    const projectKey = String(issueData?.key || '').split('-')[0];
    const boardsById = new Map();
    const addBoard = board => {
      const boardId = String(board?.id || '').trim();
      if (!boardId) {
        return;
      }
      const existingBoard = boardsById.get(boardId) || {};
      boardsById.set(boardId, {
        ...existingBoard,
        ...board,
        id: boardId,
        name: String(board?.name || existingBoard.name || ''),
        projectKey: String(board?.projectKey || existingBoard.projectKey || projectKey)
      });
    };

    if (projectKey) {
      const boardResponse = await get(`${INSTANCE_URL}rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&maxResults=50`).catch(() => null);
      const projectBoards = Array.isArray(boardResponse?.values) ? boardResponse.values : [];
      projectBoards.forEach(addBoard);
    }

    readSprintBoardRefsFromIssue(issueData).forEach(addBoard);
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
    return getCachedValue(fieldOptionsCache, `sprint__${projectKey}__${issueBoardIdsKey}`, async () => {
      const boards = await getCandidateSprintBoards(issueData);
      const sprintMap = new Map();
      const sprintResponses = await Promise.allSettled(boards.map(board => {
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
        if (sprint?.id && sprint?.name && !sprintMap.has(String(sprint.id))) {
          sprintMap.set(String(sprint.id), sprint);
        }
      });

      const options = [...sprintMap.values()]
        .sort((left, right) => {
          const stateOrder = compareSprintState(left?.state, right?.state);
          if (stateOrder !== 0) {
            return stateOrder;
          }
          return String(left?.name || '').localeCompare(String(right?.name || ''));
        })
        .map(sprint => buildEditOption(sprint.id, formatSprintOptionLabel(sprint), {rawValue: sprint}));

      return [buildEditOption('', 'No sprint'), ...options];
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
        : rawValue.key ? {key: rawValue.key} : null
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

  // ── Field Editor Definitions ───────────────────────────────

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
        save: selectedOptions => {
          return requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
            fields: {
              versions: selectedOptions.map(option => ({id: option.id}))
            }
          });
        },
        successMessage: selectedOptions => selectedOptions.length ? 'Affects versions updated' : 'Affects versions cleared'
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
        save: selectedOptions => {
          return requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
            fields: {
              fixVersions: selectedOptions.map(option => ({id: option.id}))
            }
          });
        },
        successMessage: selectedOptions => selectedOptions.length ? 'Fix versions updated' : 'Fix versions cleared'
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
              [sprintFieldId]: option.id ? (Number(option.id) || option.id) : []
            }
          });
        },
        successMessage: selectedOptions => {
          const option = selectedOptions[0] || buildEditOption('', 'No sprint');
          return option.id ? `Sprint set to ${option.label}` : 'Sprint cleared';
        }
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
          ? [buildEditOption(currentPriority.id, currentPriority.name, {
              iconUrl: currentPriority.iconUrl || ''
            })]
          : [],
        initialInputValue: '',
        loadOptions: async () => {
          return allowedPriorities
            .filter(priority => priority?.id && priority?.name)
            .map(priority => buildEditOption(priority.id, priority.name, {
              iconUrl: priority.iconUrl || ''
            }));
        },
        save: selectedOptions => {
          const selectedPriority = selectedOptions[0];
          if (!selectedPriority?.id) {
            throw new Error('Pick a priority before saving');
          }
          return requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
            fields: {
              priority: {id: selectedPriority.id}
            }
          });
        },
        successMessage: selectedOptions => {
          const selectedPriority = selectedOptions[0];
          return selectedPriority?.label
            ? `Priority set to ${selectedPriority.label}`
            : 'Priority updated';
        }
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
            rawValue: currentIssueType
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
              issuetype: {id: selectedIssueType.id}
            }
          });
        },
        successMessage: selectedOptions => {
          const selectedIssueType = selectedOptions[0];
          return selectedIssueType?.label
            ? `Issue type set to ${selectedIssueType.label}`
            : 'Issue type updated';
        }
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
            transition: {id: selectedTransition.id}
          });
        },
        successMessage: selectedOptions => {
          const selectedTransition = selectedOptions[0];
          if (selectedTransition?.targetStatusName) {
            return `Status moved to ${selectedTransition.targetStatusName}`;
          }
          return 'Status updated';
        }
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
              key: currentAssignee.key || ''
            }
          })
        : null;
      return {
        fieldKey,
        editorType: 'user-search',
        label: 'Assignee',
        selectionMode: 'single',
        currentText: currentAssignee?.displayName || 'Unassigned',
        currentOptionId: currentOption?.id || '__unassigned__',
        currentSelections: currentOption ? [currentOption] : [buildEditOption('__unassigned__', 'Unassigned', {
          metaText: 'No assignee'
        })],
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
            .filter((option, index, options) => {
              return option?.id && options.findIndex(candidate => candidate.id === option.id) === index;
            });
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
        }
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
              summary: currentLink.summary || currentLink.key
            }
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
          return mergeEditOptions(
            [currentOption].filter(Boolean),
            mergeEditOptions(searchedOptions, recentOptions)
          );
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
                parent: {key: selectedIssueKey}
              }
            });
          }
          if (!linkage.fieldKey) {
            throw new Error('Could not resolve Epic Link field');
          }
          return requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
            fields: {
              [linkage.fieldKey]: selectedIssueKey
            }
          });
        },
        successMessage: selectedOptions => {
          const selectedOption = selectedOptions[0];
          const selectedIssueKey = selectedOption?.rawValue?.key || selectedOption?.id || '';
          return selectedIssueKey
            ? `${linkage.label} set to ${selectedIssueKey}`
            : `${linkage.label} updated`;
        }
      };
    }

    if (fieldKey === 'labels') {
      const capability = await getEditableFieldCapability(issueData, 'labels');
      const suggestionSupport = await hasLabelSuggestionSupport();
      if (!capability.editable || !suggestionSupport) {
        return null;
      }
      const currentLabels = (issueData?.fields?.labels || []).filter(Boolean);
      const currentSelections = currentLabels.map(label => buildLabelOption(label));
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
              labels: nextLabels
            }
          });
        },
        successMessage: () => 'Labels updated'
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

  // ── Edit UI Presentation ───────────────────────────────────

  function filterEditOptions(options, inputValue) {
    const normalizedInput = String(inputValue || '').trim().toLowerCase();
    const list = Array.isArray(options) ? options : [];
    const filtered = normalizedInput
      ? list.filter(option => option.searchText.includes(normalizedInput))
      : list;
    return filtered;
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

  function buildActiveEditPresentation(fieldKey, state, options = {}) {
    const editState = state?.editState;
    if (editState?.fieldKey !== fieldKey) {
      return null;
    }

    const isMultiSelect = editState.selectionMode === 'multi';
    const selectedOptionIds = new Set(isMultiSelect
      ? normalizeMultiSelectOptionIds(editState.selectedOptionIds)
      : (editState.selectedOptionId === null || typeof editState.selectedOptionId === 'undefined'
          ? []
          : [String(editState.selectedOptionId)]));
    const filteredOptions = filterEditOptions(editState.options, editState.inputValue).map(option => ({
      ...option,
      fieldKey,
      isSelected: selectedOptionIds.has(option.id),
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
      loadingText,
      options: filteredOptions,
      hasOptions: filteredOptions.length > 0,
      editEmptyText: editState.loadingOptions ? 'Loading values...' : 'No matching values',
      editError: editState.errorMessage || '',
      isMultiSelect,
      showActionButtons: isMultiSelect,
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

  function getUserInitials(displayName, fallbackInitials = 'NA') {
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
    return avatarUrl === JIRA_DEFAULT_AVATAR_DATA_URI ||
      normalizedUrl.includes('defaultavatar') ||
      normalizedUrl.includes('/avatar.png') ||
      normalizedUrl.includes('avatar/default') ||
      normalizedUrl.includes('initials=');
  }

  function buildUserAvatarView(user, titlePrefix, fallbackInitials = 'NA') {
    const displayName = user?.displayName || '';
    const avatarUrl = user?.avatarUrls?.['48x48'] || '';
    const useInitials = isLikelyDefaultAvatar(user, avatarUrl);
    return {
      avatarUrl: useInitials ? '' : avatarUrl,
      initials: getUserInitials(displayName, fallbackInitials),
      displayName,
      titleText: `${titlePrefix}: ${displayName || 'Unknown'}`
    };
  }

  function buildAssigneeAvatarView(state, issueData, canEditAssignee) {
    const assignee = issueData?.fields?.assignee;
    const displayName = assignee?.displayName || 'Unassigned';
    const baseAvatarView = assignee
      ? buildUserAvatarView(assignee, 'Assignee', 'NA')
      : {
          avatarUrl: '',
          initials: 'NA',
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

  async function resolveQuickActions(issueData) {

    const actionResults = await Promise.allSettled([
      getCurrentUserInfo(),
      getAvailableTransitions(issueData.key),
      getProjectSprintOptions(issueData),
      getSprintFieldIds(INSTANCE_URL)
    ]);

    const currentUser = actionResults[0].status === 'fulfilled' ? actionResults[0].value : null;
    const transitions = actionResults[1].status === 'fulfilled' ? actionResults[1].value : [];
    const sprintOptions = actionResults[2].status === 'fulfilled' ? actionResults[2].value : {activeSprints: [], upcomingSprint: null};
    const sprintFieldIds = actionResults[3].status === 'fulfilled' ? actionResults[3].value : [];
    const actions = [];

    if (currentUser && !areSameJiraUser(issueData.fields.assignee, currentUser)) {
      actions.push({
        key: 'assign-to-me',
        label: 'Assign to me',
        successMessage: 'Assigned to you',
        payload: buildAssignPayload(currentUser)
      });
    }

    const startProgressTransition = findStartProgressTransition(transitions);
    if (startProgressTransition) {
      actions.push({
        key: 'start-progress',
        label: buildTransitionActionLabel(startProgressTransition),
        successMessage: `Moved to ${startProgressTransition.to?.name || startProgressTransition.name}`,
        transitionId: startProgressTransition.id
      });
    }

    const sprintFieldId = pickSprintFieldId(issueData, sprintFieldIds);
    const existingSprints = readSprintsFromIssue(issueData)
      .map(sprint => String(sprint.id || ''))
      .filter(Boolean);
    const sprintCandidates = [
      ...(Array.isArray(sprintOptions.activeSprints) ? sprintOptions.activeSprints : []),
      ...(sprintOptions.upcomingSprint ? [sprintOptions.upcomingSprint] : [])
    ].filter(sprint => sprint?.id && !existingSprints.includes(String(sprint.id)));
    const seenSprintIds = new Set();
    sprintCandidates.forEach(sprint => {
      const sprintId = String(sprint.id);
      if (seenSprintIds.has(sprintId) || !sprintFieldId) {
        return;
      }
      seenSprintIds.add(sprintId);
      actions.push({
        key: `move-to-sprint-${sprintId}`,
        kind: 'move-to-sprint',
        label: formatSprintActionLabel(sprint),
        successMessage: `Moved to Sprint ${sprint.name}`,
        sprintId,
        sprintFieldId
      });
    });

    return actions;
  }

  async function executeQuickAction(action, issueData) {
    if (!action) {
      throw new Error('Action is unavailable');
    }

    if (action.key === 'assign-to-me') {
      await requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}/assignee`, action.payload);
      return action.successMessage;
    }

    if (action.key === 'start-progress') {
      await requestJson('POST', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}/transitions`, {
        transition: {id: action.transitionId}
      });
      return action.successMessage;
    }

    if (action.kind === 'move-to-sprint') {
      await requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
        fields: {
          [action.sprintFieldId]: action.sprintId
        }
      });
      return action.successMessage;
    }

    throw new Error('Unknown action');
  }

  function buildQuickActionViewData(actionsOpen, actionLoadingKey, quickActions) {
    const sourceActions = Array.isArray(quickActions) ? quickActions : [];
    const firstSprintActionIndex = sourceActions.findIndex(action => action?.kind === 'move-to-sprint');
    const actions = sourceActions.map((action, index) => ({
      ...action,
      showDividerBefore: firstSprintActionIndex > 0 && index === firstSprintActionIndex,
      disabled: actionLoadingKey && actionLoadingKey !== action.key,
      disabledAttr: actionLoadingKey && actionLoadingKey !== action.key ? 'disabled' : '',
      isLoading: actionLoadingKey === action.key,
      labelText: actionLoadingKey === action.key ? `${action.label}...` : action.label
    }));
    return {
      hasQuickActions: actions.length > 0,
      actionsOpen: actionsOpen && actions.length > 0,
      quickActions: actions
    };
  }

  // ── Popup Data & Rendering ─────────────────────────────────

  async function buildPopupDisplayData(state) {
    const {key, issueData, pullRequests, actionLoadingKey, actionError, lastActionSuccess, actionsOpen, quickActions} = state;
    const normalizedDescription = await normalizeRichHtml(issueData.renderedFields.description, {
      imageMaxHeight: 180
    });
    const commentsForDisplay = await buildCommentsForDisplay(issueData);
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
    const [issueTypeCapability, priorityCapability, assigneeCapability, transitionOptions, sprintCapability, affectsCapability, fixVersionsCapability, labelsCapability, labelSuggestionSupport, customFieldChips] = await Promise.all([
      displayFields.issueType ? getEditableFieldCapability(issueData, 'issuetype') : Promise.resolve({editable: false, allowedValues: []}),
      displayFields.priority ? getEditableFieldCapability(issueData, 'priority') : Promise.resolve({editable: false}),
      displayFields.assignee ? getEditableFieldCapability(issueData, 'assignee') : Promise.resolve({editable: false}),
      displayFields.status ? getTransitionOptions(issueData.key).catch(() => []) : Promise.resolve([]),
      displayFields.sprint ? getEditableFieldCapability(issueData, 'sprint') : Promise.resolve({editable: false}),
      displayFields.affects ? getEditableFieldCapability(issueData, 'versions') : Promise.resolve({editable: false}),
      displayFields.fixVersions ? getEditableFieldCapability(issueData, 'fixVersions') : Promise.resolve({editable: false}),
      displayFields.labels ? getEditableFieldCapability(issueData, 'labels') : Promise.resolve({editable: false}),
      displayFields.labels ? hasLabelSuggestionSupport() : Promise.resolve(false),
      buildCustomFieldChips(issueData, customFields, state)
    ]);
    const statusEditable = Array.isArray(transitionOptions) && transitionOptions.length > 0;
    const issueTypeEditable = !!issueTypeCapability?.editable && normalizeIssueTypeOptions(issueTypeCapability.allowedValues || [], issueData.fields.issuetype).length > 1;
    const priorityEditable = !!priorityCapability?.editable;
    const assigneeEditable = !!assigneeCapability?.editable;
    const labelsEditable = !!labelsCapability?.editable && !!labelSuggestionSupport;

    const row1Chips = [
      displayFields.issueType ? buildEditableFieldChip('issuetype', buildFilterChip(
        issueTypeName || 'No type',
        issueTypeName ? `${scopeJqlToProject(projectKey, `issuetype = ${encodeJqlValue(issueTypeName)}`)}` : '',
        {iconUrl: issueData.fields.issuetype?.iconUrl || '', linkLabel: issueTypeName}
      ), state, {
        canEdit: issueTypeEditable,
        editTitle: 'Edit issue type'
      }) : null,
      displayFields.status ? buildEditableFieldChip('status', buildFilterChip(
        statusName || 'No status',
        statusName ? `${scopeJqlToProject(projectKey, `status = ${encodeJqlValue(statusName)}`)}` : '',
        {iconUrl: issueData.fields.status?.iconUrl || '', linkLabel: statusName}
      ), state, {
        canEdit: statusEditable,
        editTitle: 'Change status'
      }) : null,
      displayFields.priority ? buildEditableFieldChip('priority', buildFilterChip(
        priorityName || 'No priority',
        priorityName ? `${scopeJqlToProject(projectKey, `priority = ${encodeJqlValue(priorityName)}`)}` : '',
        {iconUrl: issueData.fields.priority?.iconUrl || '', linkLabel: priorityName}
      ), state, {
        canEdit: priorityEditable,
        editTitle: 'Edit priority'
      }) : null,
      displayFields.epicParent ? buildEditableFieldChip('parentLink', {
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
      }) : null,
      ...customFieldChips[1]
    ].filter(Boolean);

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
    const row2Chips = [
      displayFields.sprint ? buildEditableFieldChip('sprint', buildFilterChip(
        `Sprint: ${formatSprintText(sprints) || '--'}`,
        sprintJql,
        {linkLabel: visibleSprints.length > 1 ? 'listed sprints' : (formatSprintText(sprints) || '')}
      ), state, {
        canEdit: !!sprintCapability?.editable
      }) : null,
      displayFields.affects ? buildEditableFieldChip('versions', buildFilterChip(
        `Affects: ${formatVersionText(affectsVersions) || '--'}`,
        singleAffectsVersion ? `${scopeJqlToProject(projectKey, `affectedVersion = ${encodeJqlValue(singleAffectsVersion)}`)}` : '',
        {linkLabel: singleAffectsVersion}
      ), state, {
        canEdit: !!affectsCapability?.editable,
        isRightAligned: true
      }) : null,
      displayFields.fixVersions ? buildEditableFieldChip('fixVersions', buildFilterChip(
        `Fix version: ${formatVersionText(fixVersions) || '--'}`,
        singleFixVersion ? `${scopeJqlToProject(projectKey, `fixVersion = ${encodeJqlValue(singleFixVersion)}`)}` : '',
        {linkLabel: singleFixVersion}
      ), state, {
        canEdit: !!fixVersionsCapability?.editable,
        isRightAligned: true
      }) : null,
      ...customFieldChips[2]
    ].filter(Boolean);

    const row3Chips = [
      displayFields.labels ? buildEditableFieldChip('labels', buildLabelsChip(labels, projectKey), state, {
        canEdit: labelsEditable,
        editTitle: 'Edit labels'
      }) : null,
      ...customFieldChips[3]
    ].filter(Boolean);

    const copyTicketMeta = ticket => ({
      copyUrl: ticket.url,
      copyTicket: ticket.key,
      copyTitle: ticket.summary
    });

    const issueUrl = INSTANCE_URL + 'browse/' + key;
    const visibleCommentsTotal = displayFields.comments ? commentsTotal : 0;
    const visibleAttachments = displayFields.attachments ? previewAttachments : [];
    const quickActionData = buildQuickActionViewData(actionsOpen, actionLoadingKey, quickActions);
    const reporterView = displayFields.reporter && issueData.fields.reporter
      ? buildUserAvatarView(issueData.fields.reporter, 'Reporter', 'NA')
      : null;
    const assigneeView = displayFields.assignee
      ? buildAssigneeAvatarView(state, issueData, assigneeEditable)
      : null;
    const displayData = {
      urlTitle: `[${key}] ${issueData.fields.summary}`,
      ticketKey: key,
      ticketTitle: issueData.fields.summary,
      url: issueUrl,
      urlHoverTitle: buildLinkHoverTitle('Open issue in Jira', `[${key}] ${issueData.fields.summary}`, issueUrl),
      ...copyTicketMeta({
        key,
        summary: issueData.fields.summary,
        url: issueUrl
      }),
      prs: [],
      description: displayFields.description ? normalizedDescription : '',
      hasBodyContent: true,
      emptyBodyText: (!normalizedDescription && visibleAttachments.length === 0 && visibleCommentsTotal === 0)
        ? 'No description, attachments or comments.'
        : '',
      attachments,
      previewAttachments: visibleAttachments,
      commentsForDisplay: displayFields.comments ? commentsForDisplay : [],
      showCommentsSection: displayFields.comments || commentsForDisplay.length > 0,
      showCommentComposer: displayFields.comments,
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
      hasComments: visibleCommentsTotal > 0,
      commentsTotal: visibleCommentsTotal,
      attachmentChips: displayFields.attachments ? buildAttachmentChips(attachments) : [],
      reporter: displayFields.reporter ? issueData.fields.reporter : null,
      reporterView,
      assignee: displayFields.assignee ? issueData.fields.assignee : null,
      assigneeView,
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
    if (displayFields.pullRequests && size(pullRequests)) {
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
  const container = $('<div class="_JX_container">');
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
    const displayData = await buildPopupDisplayData(state);
    if (state !== popupState) {
      return;
    }
    if (activeCommentContext?.issueKey && activeCommentContext.issueKey !== state.key) {
      discardCommentComposerDraft().catch(() => {});
    }
    container.html(Mustache.render(annotationTemplate, displayData));
    activeCommentContext = displayFields.comments ? {issueKey: state.key, issueId: state.issueData.id} : null;
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
    }
    constrainEditPopoversToViewport();
  }
  function invalidatePopupCaches() {
    if (!popupState?.key) {
      return;
    }
    issueCache.delete(popupState.key);
    editMetaCache.delete(popupState.key);
    transitionOptionsCache.delete(popupState.key);
    assigneeLocalOptionsCache.delete(popupState.key);
    labelLocalOptionsCache.delete(popupState.key);
    tempoAccountSearchCache.clear();
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
  async function refreshPopupIssueState(successMessage = '', options = {}) {
    if (!popupState?.key) {
      return;
    }
    const {showSnackBar = false} = options;
    const popupKey = popupState.key;
    invalidatePopupCaches();
    const refreshedIssueData = await getIssueMetaData(popupKey);
    await normalizeIssueImages(refreshedIssueData);

    let refreshedPullRequests = [];
    if (displayFields.pullRequests) {
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

    popupState = {
      ...popupState,
      issueData: refreshedIssueData,
      pullRequests: refreshedPullRequests,
      quickActions,
      actionLoadingKey: '',
      actionError: '',
      lastActionSuccess: showSnackBar ? '' : successMessage,
      actionsOpen: false,
      editState: null
    };
    await renderIssuePopup(popupState);
    if (showSnackBar && successMessage) {
      snackBar(successMessage);
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
      actionsOpen: false,
      actionLoadingKey: action.key,
      actionError: '',
      lastActionSuccess: ''
    };
    await renderIssuePopup(popupState);

    try {
      const successMessage = await executeQuickAction(action, popupState.issueData);
      await refreshPopupIssueState(successMessage);
    } catch (error) {
      popupState = {
        ...popupState,
        actionLoadingKey: '',
        actionError: buildQuickActionError(error),
        lastActionSuccess: ''
      };
      await renderIssuePopup(popupState);
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

      if (popupState?.editState?.fieldKey === fieldKey && (popupState.editState.editorType === 'user-search' || popupState.editState.editorType === 'issue-search' || popupState.editState.editorType === 'label-search' || popupState.editState.editorType === 'tempo-account-search')) {
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
        if (popupState.editState.editorType !== 'label-search') {
          triggerSearchOptionsForActiveEdit(fieldKey, popupState.editState.inputValue, searchRequestId);
        }
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

  function resolveSelectedEditOptions(editState) {
    if (!editState) {
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

  function toggleMultiSelectOptionFromInput(fieldKey) {
    if (!popupState?.editState || popupState.editState.fieldKey !== fieldKey || popupState.editState.selectionMode !== 'multi') {
      return;
    }
    const normalizedInput = String(popupState.editState.inputValue || '').trim().toLowerCase();
    if (!normalizedInput) {
      return;
    }
    const exactOption = (popupState.editState.options || []).find(option => option.label.toLowerCase() === normalizedInput);
    if (!exactOption) {
      return;
    }
    selectFieldEditOption(exactOption.id);
  }

  async function submitFieldEdit(fieldKey) {
    if (!popupState?.editState || popupState.editState.fieldKey !== fieldKey || popupState.editState.loadingOptions || popupState.editState.saving) {
      return;
    }
    const definition = await getEditableFieldDefinition(fieldKey, popupState.issueData);
    if (!definition) {
      return;
    }
    const selectedOptions = resolveSelectedEditOptions(popupState.editState);
    if (popupState.editState.selectionMode === 'multi') {
      if (!popupState.editState.hasChanges) {
        return;
      }
    } else if (!selectedOptions.length) {
      const errorMessage = 'Pick an existing value from the dropdown before pressing Enter';
      popupState = {
        ...popupState,
        editState: {
          ...popupState.editState,
          errorMessage
        }
      };
      await renderIssuePopup(popupState);
      snackBar(errorMessage);
      return;
    }

    popupState = {
      ...popupState,
      editState: popupState.editState.selectionMode === 'multi'
        ? buildNextMultiSelectState(popupState.editState, {
            saving: true,
            errorMessage: ''
          })
        : {
            ...popupState.editState,
            saving: true,
            errorMessage: ''
          }
    };
    await renderIssuePopup(popupState);

    try {
      await definition.save(selectedOptions);
      await refreshPopupIssueState(definition.successMessage(selectedOptions));
    } catch (error) {
      const errorMessage = buildEditFieldError(error);
      if (!popupState?.editState || popupState.editState.fieldKey !== fieldKey) {
        return;
      }
      popupState = {
        ...popupState,
        editState: popupState.editState.selectionMode === 'multi'
          ? buildNextMultiSelectState(popupState.editState, {
              saving: false,
              errorMessage
            })
          : {
              ...popupState.editState,
              saving: false,
              errorMessage
            }
      };
      await renderIssuePopup(popupState);
      snackBar(errorMessage);
    }
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
    if ($(e.target).closest('._JX_field_chip_editable_group').length === 0 && $(e.target).closest('._JX_edit_popover').length === 0) {
      cancelFieldEdit();
    }
  });

  $(document.body).on('input', '._JX_comment_input', function () {
    syncCommentComposerState();
    syncCommentMentionSuggestions(this);
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
    let keys = getJiraKeys(getShallowText(node));
    if (!size(keys) && node.children.length < 10) {
      const fullText = (node.textContent || '');
      if (fullText.length < 200) {
        keys = getJiraKeys(fullText);
      }
    }
    if (!size(keys) && node.href) {
      keys = getJiraKeys(getRelativeHref(node.href));
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
        keys = getJiraKeys(getShallowText(ancestor));
        if (!size(keys) && ancestor.children.length < 20) {
          const ancestorText = (ancestor.textContent || '');
          if (ancestorText.length < 300) {
            keys = getJiraKeys(ancestorText);
          }
        }
        if (!size(keys) && ancestor.href) {
          keys = getJiraKeys(getRelativeHref(ancestor.href));
        }
        ancestor = ancestor.parentElement;
      }
    }
    return keys;
  }

  let pendingHover = null;

  function isModifierSatisfied(e) {
    if (hoverModifierKey === 'alt') return e.altKey;
    if (hoverModifierKey === 'ctrl') return e.ctrlKey;
    if (hoverModifierKey === 'shift') return e.shiftKey;
    return true;
  }

  function fetchAndShowPopup(key, pointerX, pointerY) {
    (async function (cancelToken) {
      const issueData = await getIssueMetaData(key);
      await normalizeIssueImages(issueData);
      let pullRequests = [];
      if (displayFields.pullRequests) {
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

      popupState = {
        key,
        issueData,
        pullRequests,
        pointerX,
        pointerY,
        quickActions,
        actionsOpen: false,
        actionLoadingKey: '',
        actionError: '',
        lastActionSuccess: '',
        editState: null
      };
      await renderIssuePopup(popupState);
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
      }, 400);
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
    if (!isOverContainer && container.html()) {
      const rect = container[0].getBoundingClientRect();
      const margin = 40;
      if (e.clientX >= rect.left - margin && e.clientX <= rect.right + margin &&
          e.clientY >= rect.top - margin && e.clientY <= rect.bottom + margin) {
        return;
      }
    }
    if (isOverContainer) {
      showTip('tooltip_drag', 'Tip: You can pin the tooltip by dragging the title !');
      return;
    }
    if (element) {
      const keys = detectJiraKeysAtPoint(element);

      if (size(keys)) {
        const key = keys[0].replace(' ', '-');

        if (hoverModifierKey !== 'none' && !isModifierSatisfied(e)) {
          pendingHover = {key, pointerX: e.pageX, pointerY: e.pageY};
          return;
        }
        pendingHover = null;

        clearTimeout(hideTimeOut);
        if (lastHoveredKey === key && container.html()) {
          if (popupState) {
            popupState = {
              ...popupState,
              pointerX: e.pageX,
              pointerY: e.pageY
            };
          }
          if (!containerPinned) {
            container.css(computeVisibleContainerPosition(e.pageX, e.pageY));
          }
          return;
        }
        triggerPopupForKey(key, e.pageX, e.pageY, hoverModifierKey !== 'none');
      } else if (!containerPinned) {
        pendingHover = null;
        clearTimeout(hoverDelayTimeout);
        lastHoveredKey = '';
        hideTimeOut = setTimeout(hideContainer, 250);
      }
    }
  }, 100));
}

if (!window.__JX__script_injected__) {
  waitForDocument(mainAsyncLocal);
}

window.__JX__script_injected__ = true;

