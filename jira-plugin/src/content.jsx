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
  const fieldOptionsCache = new Map();
  let popupState = null;

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

  function textToLinkedHtml(input) {
    const escaped = escapeHtml(input || '');
    const withLinks = escaped.replace(
      /(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    return withLinks.replace(/\n/g, '<br/>');
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
      anchor.setAttribute('title', buildLinkHoverTitle(
        'Open link',
        anchor.textContent || absoluteHref || href,
        absoluteHref || href
      ));
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

    const pushSprint = (name, state, id) => {
      if (!name) {
        return;
      }
      const key = id ? `id:${id}` : `${name}__${state || ''}`;
      if (seen[key]) {
        return;
      }
      seen[key] = true;
      sprints.push({
        id: id ? String(id) : '',
        name,
        state: state || ''
      });
    };

    sprintValues.forEach(value => {
      const entries = Array.isArray(value) ? value : [value];
      entries.forEach(entry => {
        if (!entry) {
          return;
        }
        if (typeof entry === 'string') {
          const idMatch = entry.match(/id=([^,\]]+)/i);
          const nameMatch = entry.match(/name=([^,\]]+)/i);
          const stateMatch = entry.match(/state=([^,\]]+)/i);
          pushSprint(
            nameMatch && nameMatch[1] ? nameMatch[1] : entry,
            stateMatch && stateMatch[1],
            idMatch && idMatch[1] ? idMatch[1] : ''
          );
          return;
        }
        pushSprint(entry.name || entry.goal || entry.id, entry.state, entry.id);
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

  function buildLinkHoverTitle(actionText, detailText, url) {
    return [actionText, detailText, url]
      .map(part => String(part || '').trim())
      .filter(Boolean)
      .join('\n');
  }

  function scopeJqlToProject(projectKey, clause) {
    if (!projectKey || !clause) {
      return clause || '';
    }
    return `project = ${encodeJqlValue(projectKey)} AND ${clause}`;
  }

  function buildFilterChip(text, jql, extra = {}) {
    const linkUrl = jql ? buildJqlUrl(jql) : '';
    return {
      text,
      linkUrl,
      linkTitle: linkUrl ? buildLinkHoverTitle(extra.linkAction || 'Search Jira', text, linkUrl) : '',
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

  function buildEditFieldError(error) {
    return error?.message || error?.inner || 'Update failed';
  }

  function pickSprintFieldId(issueData, sprintFieldIds) {
    const populatedFieldId = (sprintFieldIds || []).find(fieldId => {
      const value = issueData?.fields?.[fieldId];
      return Array.isArray(value) ? value.length > 0 : !!value;
    });
    return populatedFieldId || sprintFieldIds?.[0] || '';
  }

  function buildEditOption(id, label, extra = {}) {
    return {
      id: id === '' ? '' : String(id || ''),
      label: String(label || ''),
      searchText: String(label || '').toLowerCase(),
      ...extra
    };
  }

  function formatSprintOptionLabel(sprint) {
    if (!sprint) {
      return '';
    }
    return sprint.state ? `${sprint.name} (${sprint.state})` : sprint.name;
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

  async function getFixVersionOptions(issueData) {
    const projectKey = String(issueData?.key || '').split('-')[0];
    if (!projectKey) {
      return [];
    }
    return getCachedValue(fieldOptionsCache, `fixVersions__${projectKey}`, async () => {
      const versions = await get(`${INSTANCE_URL}rest/api/2/project/${encodeURIComponent(projectKey)}/versions`);
      const options = (Array.isArray(versions) ? versions : [])
        .filter(version => version?.name && !version?.archived)
        .sort(compareFixVersionOptions)
        .map(version => buildEditOption(version.id, version.name, {rawValue: version}));
      return [buildEditOption('', 'No fix version'), ...options];
    });
  }

  function compareSprintState(left, right) {
    const order = {
      active: 0,
      future: 1,
      closed: 2
    };
    return (order[String(left || '').toLowerCase()] ?? 99) - (order[String(right || '').toLowerCase()] ?? 99);
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
    return getCachedValue(fieldOptionsCache, `sprint__${projectKey}`, async () => {
      const boardResponse = await get(`${INSTANCE_URL}rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&maxResults=50`);
      const boards = Array.isArray(boardResponse?.values) ? boardResponse.values : [];
      const sprintMap = new Map();
      const sprintResponses = await Promise.allSettled(boards.map(board => {
        return get(`${INSTANCE_URL}rest/agile/1.0/board/${board.id}/sprint?state=active,future&maxResults=50`);
      }));

      sprintResponses.forEach(result => {
        if (result.status !== 'fulfilled') {
          return;
        }
        const sprints = Array.isArray(result.value?.values) ? result.value.values : [];
        sprints.forEach(sprint => {
          if (sprint?.id && sprint?.name) {
            sprintMap.set(String(sprint.id), sprint);
          }
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

  function getEditableFieldDefinition(fieldKey, issueData) {
    if (fieldKey === 'fixVersions') {
      const currentFixVersions = issueData?.fields?.fixVersions || [];
      return {
        fieldKey,
        label: 'Fix version',
        currentText: formatFixVersionText(currentFixVersions),
        currentOptionId: currentFixVersions.length === 1 ? String(currentFixVersions[0]?.id || '') : null,
        loadOptions: () => getFixVersionOptions(issueData),
        save: option => {
          return requestJson('PUT', `${INSTANCE_URL}rest/api/2/issue/${issueData.key}`, {
            fields: {
              fixVersions: option.id ? [{id: option.id}] : []
            }
          });
        },
        successMessage: option => option.id ? `Fix version set to ${option.label}` : 'Fix version cleared'
      };
    }

    if (fieldKey === 'sprint') {
      const currentSprints = readSprintsFromIssue(issueData);
      return {
        fieldKey,
        label: 'Sprint',
        currentText: formatSprintText(currentSprints),
        currentOptionId: currentSprints.length === 1 ? String(currentSprints[0]?.id || '') : null,
        loadOptions: () => getSprintOptions(issueData),
        save: async option => {
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
        successMessage: option => option.id ? `Sprint set to ${option.label}` : 'Sprint cleared'
      };
    }

    return null;
  }

  function filterEditOptions(options, inputValue) {
    const normalizedInput = String(inputValue || '').trim().toLowerCase();
    const list = Array.isArray(options) ? options : [];
    const filtered = normalizedInput
      ? list.filter(option => option.searchText.includes(normalizedInput))
      : list;
    return filtered;
  }

  function buildEditableFieldChip(fieldKey, baseChip, state) {
    const editState = state?.editState;
    if (editState?.fieldKey === fieldKey) {
      const options = filterEditOptions(editState.options, editState.inputValue).map(option => ({
        ...option,
        fieldKey,
        isSelected: editState.selectedOptionId === option.id,
        title: option.label
      }));
      return {
        ...baseChip,
        isEditable: true,
        isEditing: true,
        isRightAligned: fieldKey === 'fixVersions',
        fieldKey,
        editLabel: editState.label,
        inputValue: editState.inputValue,
        inputPlaceholder: `Type to filter ${editState.label.toLowerCase()} values`,
        inputDisabled: !!(editState.loadingOptions || editState.saving),
        loadingText: editState.loadingOptions
          ? `Loading ${editState.label.toLowerCase()} values...`
          : editState.saving
            ? `Saving ${editState.label.toLowerCase()}...`
            : '',
        options,
        hasOptions: options.length > 0,
        editEmptyText: editState.loadingOptions ? 'Loading values...' : 'No matching values',
        editError: editState.errorMessage || ''
      };
    }
    return {
      ...baseChip,
      isEditable: true,
      fieldKey,
      editTitle: `Edit ${baseChip.text}`
    };
  }

  function getRelativeHref(href) {
    const documentHref = document.location.href.split('#')[0];
    if (href.startsWith(documentHref)) {
      return href.slice(documentHref.length);
    }
    return href;
  }

  function computeVisibleContainerPosition(pointerX, pointerY) {
    const margin = 8;
    const preferredLeft = pointerX + 20;
    const preferredTop = pointerY + 25;
    const width = container.outerWidth();
    const height = container.outerHeight();
    const viewportLeft = window.scrollX + margin;
    const viewportTop = window.scrollY + margin;
    const viewportRight = window.scrollX + window.innerWidth - margin;
    const viewportBottom = window.scrollY + window.innerHeight - margin;

    let left = preferredLeft;
    let top = preferredTop;

    if (left + width > viewportRight) {
      left = pointerX - width - 15;
    }
    if (left < viewportLeft) {
      left = viewportLeft;
    }

    if (top + height > viewportBottom) {
      top = pointerY - height - 15;
    }
    if (top < viewportTop) {
      top = viewportTop;
    }

    return {left, top};
  }

  const container = $('<div class="_JX_container">');
  const previewOverlay = $(`
    <div class="_JX_preview_overlay">
      <img class="_JX_preview_image" />
    </div>
  `);
  $(document.body).append(container);
  $(document.body).append(previewOverlay);

  async function resolvePullRequestsForIssue(issueData) {
    if (!displayFields.pullRequests) {
      return [];
    }
    try {
      const pullRequestResponse = await getPullRequestDataCached(issueData.id);
      return normalizePullRequests(pullRequestResponse);
    } catch (ex) {
      console.log('[Jira HotLinker] Pull request fetch failed', {
        issueKey: issueData?.key,
        issueId: issueData?.id,
        error: ex?.message || String(ex)
      });
      return [];
    }
  }

  async function buildPopupDisplayData(state) {
    const {key, issueData, pullRequests} = state;
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
        linkUrl: epicOrParent?.url || '',
        linkTitle: epicOrParent ? buildLinkHoverTitle('Open parent issue', epicOrParent.key, epicOrParent.url) : ''
      } : null,
      ...customFieldChips[1]
    ].filter(Boolean);

    const singleAffectsVersion = affectsVersions.length === 1 ? affectsVersions[0]?.name : '';
    const singleFixVersion = fixVersions.length === 1 ? fixVersions[0]?.name : '';
    const row2Chips = [
      displayFields.sprint ? buildEditableFieldChip('sprint', buildFilterChip(
        `Sprint: ${formatSprintText(sprints) || '--'}`,
        ''
      ), state) : null,
      displayFields.affects ? buildFilterChip(
        `Affects: ${affectsVersions.map(version => version.name).filter(Boolean).join(', ') || '--'}`,
        singleAffectsVersion ? `${scopeJqlToProject(projectKey, `affectedVersion = ${encodeJqlValue(singleAffectsVersion)}`)}` : ''
      ) : null,
      displayFields.fixVersions ? buildEditableFieldChip('fixVersions', buildFilterChip(
        `Fix version: ${formatFixVersionText(fixVersions) || '--'}`,
        singleFixVersion ? `${scopeJqlToProject(projectKey, `fixVersion = ${encodeJqlValue(singleFixVersion)}`)}` : ''
      ), state) : null,
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

    const copyTicketMeta = ticket => ({
      copyUrl: ticket.url,
      copyTicket: ticket.key,
      copyTitle: ticket.summary
    });
    const issueUrl = INSTANCE_URL + 'browse/' + key;

    const visibleCommentsTotal = displayFields.comments ? commentsTotal : 0;
    const visibleAttachments = displayFields.attachments ? previewAttachments : [];
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
      commentUrl: issueUrl,
      hasFieldSummary: row1Chips.length > 0 || row2Chips.length > 0 || row3Chips.length > 0,
      activityIndicators: [],
      loaderGifUrl,
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

  async function renderIssuePopup(state) {
    if (!state?.issueData) {
      return;
    }
    const displayData = await buildPopupDisplayData(state);
    if (state !== popupState) {
      return;
    }
    container.html(Mustache.render(annotationTemplate, displayData));
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
  }

  function invalidatePopupCaches() {
    if (!popupState?.key) {
      return;
    }
    issueCache.delete(popupState.key);
    if (popupState.issueData?.id) {
      const issueId = String(popupState.issueData.id);
      [...pullRequestCache.keys()].forEach(cacheKey => {
        if (String(cacheKey).includes(issueId)) {
          pullRequestCache.delete(cacheKey);
        }
      });
    }
  }

  async function refreshPopupIssueState(successMessage = '') {
    if (!popupState?.key) {
      return;
    }
    const popupKey = popupState.key;
    invalidatePopupCaches();
    const refreshedIssueData = await getIssueMetaData(popupKey);
    await normalizeIssueImages(refreshedIssueData);
    const refreshedPullRequests = await resolvePullRequestsForIssue(refreshedIssueData);
    if (!popupState || popupState.key !== popupKey) {
      return;
    }
    popupState = {
      ...popupState,
      issueData: refreshedIssueData,
      pullRequests: refreshedPullRequests,
      editState: null
    };
    await renderIssuePopup(popupState);
    if (successMessage) {
      snackBar(successMessage);
    }
  }

  async function startFieldEdit(fieldKey) {
    if (!popupState?.issueData) {
      return;
    }
    if (popupState.editState?.fieldKey === fieldKey) {
      return;
    }
    const definition = getEditableFieldDefinition(fieldKey, popupState.issueData);
    if (!definition) {
      return;
    }
    const initialValue = definition.currentText || '';
    popupState = {
      ...popupState,
      editState: {
        fieldKey,
        label: definition.label,
        inputValue: initialValue,
        options: [],
        selectedOptionId: definition.currentOptionId,
        loadingOptions: true,
        saving: false,
        errorMessage: '',
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
      const selectedOption = (Array.isArray(options) ? options : []).find(option => option.id === popupState.editState.selectedOptionId);
      const nextInputValue = selectedOption ? selectedOption.label : popupState.editState.inputValue;
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
      await renderIssuePopup(popupState);
    } catch (error) {
      const errorMessage = buildEditFieldError(error);
      if (!popupState?.editState || popupState.editState.fieldKey !== fieldKey) {
        return;
      }
      popupState = {
        ...popupState,
        editState: {
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
    const exactOption = (popupState.editState.options || []).find(option => {
      return option.label.toLowerCase() === normalizedValue.trim().toLowerCase();
    });
    popupState = {
      ...popupState,
      editState: {
        ...popupState.editState,
        inputValue: normalizedValue,
        selectedOptionId: exactOption ? exactOption.id : null,
        errorMessage: '',
        selectionStart,
        selectionEnd
      }
    };
    renderIssuePopup(popupState).catch(() => {});
  }

  function selectFieldEditOption(optionId) {
    if (!popupState?.editState) {
      return;
    }
    const option = (popupState.editState.options || []).find(candidate => candidate.id === optionId);
    if (!option) {
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
  }

  function resolveSelectedEditOption(editState) {
    if (!editState) {
      return null;
    }
    if (editState.selectedOptionId !== null && typeof editState.selectedOptionId !== 'undefined') {
      const selectedOption = (editState.options || []).find(option => option.id === editState.selectedOptionId);
      if (selectedOption) {
        return selectedOption;
      }
    }
    const normalizedInput = String(editState.inputValue || '').trim().toLowerCase();
    if (!normalizedInput) {
      return null;
    }
    return (editState.options || []).find(option => option.label.toLowerCase() === normalizedInput) || null;
  }

  async function submitFieldEdit(fieldKey) {
    if (!popupState?.editState || popupState.editState.fieldKey !== fieldKey || popupState.editState.loadingOptions || popupState.editState.saving) {
      return;
    }
    const definition = getEditableFieldDefinition(fieldKey, popupState.issueData);
    if (!definition) {
      return;
    }
    const selectedOption = resolveSelectedEditOption(popupState.editState);
    if (!selectedOption) {
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
      editState: {
        ...popupState.editState,
        saving: true,
        errorMessage: ''
      }
    };
    await renderIssuePopup(popupState);

    try {
      await definition.save(selectedOption);
      await refreshPopupIssueState(definition.successMessage(selectedOption));
    } catch (error) {
      const errorMessage = buildEditFieldError(error);
      if (!popupState?.editState || popupState.editState.fieldKey !== fieldKey) {
        return;
      }
      popupState = {
        ...popupState,
        editState: {
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

  $(document.body).on('click', '._JX_field_chip_edit', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const fieldKey = e.currentTarget.getAttribute('data-field-key') || '';
    startFieldEdit(fieldKey).catch(() => {});
  });

  $(document.body).on('click', '._JX_edit_cancel', function (e) {
    e.preventDefault();
    e.stopPropagation();
    cancelFieldEdit();
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
    if (e.key === 'Enter') {
      e.preventDefault();
      submitFieldEdit(fieldKey).catch(() => {});
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
    popupState = null;
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
          popupState = {
            key,
            issueData,
            pullRequests,
            pointerX,
            pointerY,
            editState: null
          };
          await renderIssuePopup(popupState);
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































