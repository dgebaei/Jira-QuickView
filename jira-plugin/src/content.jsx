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

const getInstanceUrl = async () => (await storageGet({
  instanceUrl: config.instanceUrl
})).instanceUrl;

const getConfig = async () => (await storageGet(config));
let sprintFieldIdsPromise;

async function getSprintFieldIds(instanceUrl) {
  if (sprintFieldIdsPromise) {
    return sprintFieldIdsPromise;
  }
  sprintFieldIdsPromise = get(instanceUrl + 'rest/api/2/field')
    .then(fields => {
      if (!Array.isArray(fields)) {
        return [];
      }
      return fields
        .filter(field => {
          const name = (field.name || '').toLowerCase();
          const schemaCustom = ((field.schema && field.schema.custom) || '').toLowerCase();
          const schemaType = ((field.schema && field.schema.type) || '').toLowerCase();
          return name.includes('sprint') ||
            schemaCustom.includes('gh-sprint') ||
            schemaType === 'sprint';
        })
        .map(field => field.id);
    })
    .catch(() => []);
  return sprintFieldIdsPromise;
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
  const jiraTicketRegex = new RegExp('(?:' + projectMatches + ')[- ]\\d+', 'ig');

  return function (text) {
    let matches;
    const result = [];

    while ((matches = jiraTicketRegex.exec(text)) !== null) {
      result.push(matches[0]);
    }
    return result;
  };
}

function buildFallbackJiraKeyMatcher() {
  const jiraTicketRegex = /\b[A-Z][A-Z0-9]{1,14}[- ]\d+\b/g;

  return function (text) {
    let matches;
    const result = [];
    const input = text || '';

    while ((matches = jiraTicketRegex.exec(input)) !== null) {
      result.push(matches[0]);
    }
    jiraTicketRegex.lastIndex = 0;
    return result;
  };
}

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

async function get(url) {
  const response = await sendMessage({action: 'get', url: url});
  if (response.result) {
    return response.result;
  } else if (response.error) {
    const err = new Error(response.error);
    err.inner = response.error;
    throw err;
  }
}

async function getImageDataUrl(url) {
  const response = await sendMessage({action: 'getImageDataUrl', url});
  if (response.result) {
    return response.result;
  } else if (response.error) {
    const err = new Error(response.error);
    err.inner = response.error;
    throw err;
  }
}
async function requestJson(method, url, body) {
  const response = await sendMessage({action: 'requestJson', method, url, body});
  if (Object.prototype.hasOwnProperty.call(response, 'result')) {
    return response.result;
  }
  const err = new Error(response.error || 'Request failed');
  err.inner = response.error;
  throw err;
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
  if (Object.prototype.hasOwnProperty.call(response, 'result')) {
    return response.result;
  }
  const err = new Error(response.error || 'Attachment upload failed');
  err.inner = response.error;
  throw err;
}

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

async function mainAsyncLocal() {
  const $ = require('jquery');
  const draggable = require('jquery-ui/ui/widgets/draggable');

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
  let activeCommentContext = null;
  let commentMentionState = emptyCommentMentionState();
  let commentMentionRequestId = 0;
  let commentUploadState = emptyCommentUploadState();
  let commentUploadSessionId = 0;
  let commentUploadSequence = 0;

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
    });

    return temp.innerHTML;
  }

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

    const result = [];
    for (const comment of comments) {
      const rendered = renderedById[comment.id];
      const baseHtml = rendered || textToLinkedHtml(comment.body || '');
      const bodyHtml = await normalizeRichHtml(baseHtml, {imageMaxHeight: 100});
      result.push({
        author: comment.author?.displayName || 'Unknown',
        created: formatRelativeDate(comment.created),
        bodyHtml
      });
    }
    return result;
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

    const results = [];
    for (const probe of probes) {
      try {
        const response = await get(probe.url);
        results.push({
          label: probe.label,
          url: probe.url,
          ok: true,
          topLevelKeys: Object.keys(response || {}),
          hasSummary: Array.isArray(response?.summary),
          hasDetail: Array.isArray(response?.detail),
          summaryCount: Array.isArray(response?.summary) ? response.summary.length : null,
          detailCount: Array.isArray(response?.detail) ? response.detail.length : null
        });
      } catch (ex) {
        results.push({
          label: probe.label,
          url: probe.url,
          ok: false,
          error: ex?.message || String(ex)
        });
      }
    }
    return results;
  }

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

  async function getIssueMetaData(issueKey) {
    return getCachedValue(issueCache, issueKey, async () => {
      const sprintFieldIds = await getSprintFieldIds(INSTANCE_URL);
      const fields = [
        'description',
        'id',
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
        ...customFields.map(({fieldId}) => fieldId)
      ];
      return get(INSTANCE_URL + 'rest/api/2/issue/' + issueKey + '?fields=' + fields.join(',') + '&expand=renderedFields,names');
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

  async function readEpicOrParent(issueData) {
    const parent = issueData.fields?.parent;
    if (parent && parent.key) {
      return {
        key: parent.key,
        summary: parent.fields?.summary || parent.key,
        url: `${INSTANCE_URL}browse/${parent.key}`
      };
    }

    const names = issueData.names || {};
    const fields = issueData.fields || {};
    const epicFieldId = Object.keys(names).find(fieldId => {
      const name = String(names[fieldId] || '').toLowerCase();
      return name === 'epic link' || name === 'epic';
    });
    const epicKey = epicFieldId ? fields[epicFieldId] : null;
    if (!epicKey || typeof epicKey !== 'string') {
      return null;
    }
    try {
      const epic = await getIssueSummary(epicKey);
      return {
        key: epic.key,
        summary: epic.summary || epic.key,
        url: `${INSTANCE_URL}browse/${epic.key}`
      };
    } catch (ex) {
      return {
        key: epicKey,
        summary: epicKey,
        url: `${INSTANCE_URL}browse/${epicKey}`
      };
    }
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
      return {
        text: fieldName ? `${fieldName}: ${textValue}` : textValue,
        linkUrl: ''
      };
    }
    const primaryText = entry.name || entry.value || entry.displayName || entry.id || entry.key;
    if (!primaryText) {
      return null;
    }
    const formattedValue = entry.key && (entry.name || entry.value)
      ? `[${entry.key}] ${entry.name || entry.value}`
      : String(primaryText);
    return {
      text: fieldName ? `${fieldName}: ${formattedValue}` : formattedValue,
      linkUrl: ''
    };
  }
  function buildCustomFieldChips(issueData, customFields) {
    const names = issueData.names || {};
    const fields = issueData.fields || {};
    const chipsByRow = {1: [], 2: [], 3: []};
    customFields.forEach(({fieldId, row}) => {
      const rawValue = fields[fieldId];
      if (rawValue === undefined || rawValue === null || rawValue === '') {
        return;
      }
      const fieldName = String(names[fieldId] || fieldId);
      const entries = Array.isArray(rawValue) ? rawValue : [rawValue];
      entries.forEach(entry => {
        const chip = formatCustomFieldChip(fieldName, entry);
        if (chip && chip.text) {
          chipsByRow[row].push(chip);
        }
      });
    });
    return chipsByRow;
  }

  function readSprintsFromIssue(issueData) {
    const names = issueData.names || {};
    const fields = issueData.fields || {};
    const sprintFieldIds = Object.keys(names).filter(fieldId => {
      return typeof names[fieldId] === 'string' && names[fieldId].toLowerCase().includes('sprint');
    });
    const sprintValues = sprintFieldIds
      .map(fieldId => fields[fieldId])
      .filter(value => value !== undefined && value !== null);
    const seen = {};
    const sprints = [];

    const pushSprint = (name, state) => {
      if (!name) {
        return;
      }
      const key = `${name}__${state || ''}`;
      if (seen[key]) {
        return;
      }
      seen[key] = true;
      sprints.push({name, state: state || ''});
    };

    sprintValues.forEach(value => {
      const entries = Array.isArray(value) ? value : [value];
      entries.forEach(entry => {
        if (!entry) {
          return;
        }
        if (typeof entry === 'string') {
          const nameMatch = entry.match(/name=([^,\]]+)/i);
          const stateMatch = entry.match(/state=([^,\]]+)/i);
          pushSprint(nameMatch && nameMatch[1] ? nameMatch[1] : entry, stateMatch && stateMatch[1]);
          return;
        }
        pushSprint(entry.name || entry.goal || entry.id, entry.state);
      });
    });
    return sprints;
  }

  function formatFixVersionText(fixVersions) {
    return (fixVersions || [])
      .map(version => version.name)
      .filter(Boolean)
      .join(', ');
  }

  function formatSprintText(sprints) {
    return (sprints || [])
      .map(sprint => sprint.state ? `${sprint.name} (${sprint.state})` : sprint.name)
      .filter(Boolean)
      .join(', ');
  }

  function encodeJqlValue(value) {
    return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  function buildJqlUrl(jql) {
    return `${INSTANCE_URL}issues/?jql=${encodeURIComponent(jql)}`;
  }

  function scopeJqlToProject(projectKey, clause) {
    if (!projectKey || !clause) {
      return clause || '';
    }
    return `project = ${encodeJqlValue(projectKey)} AND ${clause}`;
  }

  function buildFilterChip(text, jql, extra = {}) {
    return {
      text,
      linkUrl: jql ? buildJqlUrl(jql) : '',
      ...extra
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
    return (attachments || []).filter(attachment => {
      return !!attachment &&
        typeof attachment.mimeType === 'string' &&
        attachment.mimeType.toLowerCase().startsWith('image') &&
        !!attachment.thumbnail;
    });
  }

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

  const container = $('<div class="_JX_container">');
  const previewOverlay = $(`
    <div class="_JX_preview_overlay">
      <img class="_JX_preview_image" />
    </div>
  `);
  $(document.body).append(container);
  $(document.body).append(previewOverlay);
  new draggable({
    handle: '._JX_title, ._JX_status',
    cancel: 'a, button, input, textarea, img, ._JX_description, ._JX_comments, ._JX_comment_body, ._JX_description_text, ._JX_related_pr'
  }, container);
  
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

  $(document.body).on('click', '._JX_copy_link', function (e) {
    e.preventDefault();
    copyPrettyLink(e.currentTarget).catch(() => snackBar('There was an error!'));
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

  function hideContainer() {
    lastHoveredKey = '';
    discardCommentComposerDraft().catch(() => {});
    activeCommentContext = null;
    resetCommentMentionState();
    containerPinned = false;
    container.css({
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

  let cancelToken = {};

  function passiveCancel(cooldown) {
    // does not actually cancel xhr calls
    cancelToken.cancel = true;
    setTimeout(function () {
      cancelToken = {};
    }, cooldown);
  }

  let hideTimeOut;
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
  $(document.body).on('mousemove', debounce(function (e) {
    if (cancelToken.cancel) {
      return;
    }
    const element = document.elementFromPoint(e.clientX, e.clientY);
    if (element === container[0] || $.contains(container[0], element)) {
      showTip('tooltip_drag', 'Tip: You can pin the tooltip by dragging the title !');
      // cancel when hovering over the container it self
      return;
    }
    if (element) {
      let keys = getJiraKeys(getShallowText(element));
      if (!size(keys) && element.href) {
        keys = getJiraKeys(getRelativeHref(element.href));
      }
      if (!size(keys) && element.parentElement && element.parentElement.href) {
        keys = getJiraKeys(getRelativeHref(element.parentElement.href));
      }

      if (size(keys)) {
        clearTimeout(hideTimeOut);
        const key = keys[0].replace(' ', '-');
        if (lastHoveredKey === key && container.html()) {
          if (!containerPinned) {
            container.css(computeVisibleContainerPosition(e.pageX, e.pageY));
          }
          return;
        }
        lastHoveredKey = key;
        const pointerX = e.pageX;
        const pointerY = e.pageY;
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
          const customFieldChips = buildCustomFieldChips(issueData, customFields);
          const epicOrParent = await readEpicOrParent(issueData);
          const issueTypeName = issueData.fields.issuetype?.name;
          const statusName = issueData.fields.status?.name;
          const priorityName = issueData.fields.priority?.name;
          const projectKey = key.split('-')[0];

          const row1Chips = [
            displayFields.issueType ? buildFilterChip(
              issueTypeName || 'No type',
              issueTypeName ? `${scopeJqlToProject(projectKey, `issuetype = ${encodeJqlValue(issueTypeName)}`)}` : '',
              {iconUrl: issueData.fields.issuetype?.iconUrl || ''}
            ) : null,
            displayFields.status ? buildFilterChip(
              statusName || 'No status',
              statusName ? `${scopeJqlToProject(projectKey, `status = ${encodeJqlValue(statusName)}`)}` : '',
              {iconUrl: issueData.fields.status?.iconUrl || ''}
            ) : null,
            displayFields.priority ? buildFilterChip(
              priorityName || 'No priority',
              priorityName ? `${scopeJqlToProject(projectKey, `priority = ${encodeJqlValue(priorityName)}`)}` : '',
              {iconUrl: issueData.fields.priority?.iconUrl || ''}
            ) : null,
            displayFields.epicParent ? {
              text: epicOrParent
                ? `Parent: [${epicOrParent.key}] ${epicOrParent.summary}`
                : 'Parent: --',
              linkUrl: epicOrParent?.url || ''
            } : null,
            ...customFieldChips[1]
          ].filter(Boolean);

          const singleAffectsVersion = affectsVersions.length === 1 ? affectsVersions[0]?.name : '';
          const singleFixVersion = fixVersions.length === 1 ? fixVersions[0]?.name : '';
          const row2Chips = [
            displayFields.sprint ? buildFilterChip(
              `Sprint: ${formatSprintText(sprints) || '--'}`,
              ''
            ) : null,
            displayFields.affects ? buildFilterChip(
              `Affects: ${affectsVersions.map(version => version.name).filter(Boolean).join(', ') || '--'}`,
              singleAffectsVersion ? `${scopeJqlToProject(projectKey, `affectedVersion = ${encodeJqlValue(singleAffectsVersion)}`)}` : ''
            ) : null,
            displayFields.fixVersions ? buildFilterChip(
              `Fix version: ${formatFixVersionText(fixVersions) || '--'}`,
              singleFixVersion ? `${scopeJqlToProject(projectKey, `fixVersion = ${encodeJqlValue(singleFixVersion)}`)}` : ''
            ) : null,
            ...customFieldChips[2]
          ].filter(Boolean);

          const singleLabel = labels.length === 1 ? labels[0] : '';
          const row3Chips = [
            displayFields.labels ? buildFilterChip(
              `Labels: ${labels.filter(Boolean).join(', ') || '--'}`,
              singleLabel ? `${scopeJqlToProject(projectKey, `labels = ${encodeJqlValue(singleLabel)}`)}` : ''
            ) : null,
            ...customFieldChips[3]
          ].filter(Boolean);

          const copyTicketMeta = (ticket) => ({
            copyUrl: ticket.url,
            copyTicket: ticket.key,
            copyTitle: ticket.summary
          });

          const visibleCommentsTotal = displayFields.comments ? commentsTotal : 0;
          const visibleAttachments = displayFields.attachments ? previewAttachments : [];
          const displayData = {
            urlTitle: `[${key}] ${issueData.fields.summary}`,
            ticketKey: key,
            ticketTitle: issueData.fields.summary,
            url: INSTANCE_URL + 'browse/' + key,
            ...copyTicketMeta({
              key,
              summary: issueData.fields.summary,
              url: INSTANCE_URL + 'browse/' + key
            }),
            prs: [],
            description: displayFields.description ? normalizedDescription : '',
            hasBodyContent: true,
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
            assignee: displayFields.assignee ? issueData.fields.assignee : null,
            commentUrl: INSTANCE_URL + 'browse/' + key,
            hasFieldSummary: row1Chips.length > 0 || row2Chips.length > 0 || row3Chips.length > 0,
            activityIndicators: [],
            loaderGifUrl,
          };
          if (issueData.fields.comment?.comments?.[0]?.id) {
            displayData.commentUrl = `${displayData.url}#comment-${issueData.fields.comment.comments[0].id}`;
          }
          if (displayFields.pullRequests && size(pullRequests)) {
            const filteredPullRequests = pullRequests.filter(function (pr) {
              return pr && pr.url !== location.href;
            });
            displayData.prs = filteredPullRequests.map(function (pr) {
              return {
                id: pr.id,
                url: pr.url,
                linkUrl: pr.url,
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
          // TODO: fix scrolling in google docs
          if (activeCommentContext?.issueKey && activeCommentContext.issueKey !== key) {
            discardCommentComposerDraft().catch(() => {});
          }
          container.html(Mustache.render(annotationTemplate, displayData));
          activeCommentContext = displayFields.comments ? { issueKey: key, issueId: issueData.id } : null;
          syncCommentComposerState();
          if (!containerPinned) {
            container.css(computeVisibleContainerPosition(pointerX, pointerY));
          }
        })(cancelToken).catch((error) => {
          notifyJiraConnectionFailure(INSTANCE_URL, error);
          lastHoveredKey = '';
        });
      } else if (!containerPinned) {
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



