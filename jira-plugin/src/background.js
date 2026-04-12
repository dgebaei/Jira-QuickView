/*global chrome */
import regexEscape from 'escape-string-regexp';
import defaultConfig from 'options/config.js';
import {storageGet, storageSet, storageLocalGet, storageLocalSet, permissionsContains, promisifyChrome} from 'src/chrome';
import {contentScript, resetDeclarativeMapping, toMatchUrl} from 'options/declarative';
import {
  getConfigPermissionOrigins,
  hashString,
  isVersionAtLeast,
  mergeSyncedConfig,
  normalizeSettingsPayload,
  normalizeSimpleSyncState,
  SIMPLE_SYNC_ALARM_NAME,
  SIMPLE_SYNC_POLL_MINUTES,
  SIMPLE_SYNC_SOURCE_TYPES,
  SIMPLE_SYNC_STORAGE_KEY,
} from 'src/settings-sync';

const executeScript = promisifyChrome(chrome.scripting, 'executeScript');
const sendMessage = promisifyChrome(chrome.tabs, 'sendMessage');
const setActionTitle = promisifyChrome(chrome.action, 'setTitle');
const setBadgeText = promisifyChrome(chrome.action, 'setBadgeText');
const setBadgeBackgroundColor = promisifyChrome(chrome.action, 'setBadgeBackgroundColor');

var SEND_RESPONSE_IS_ASYNC = true;
const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
const FETCH_TIMEOUT_MS = 10000;

async function getInstanceOrigin() {
  const {instanceUrl} = await storageGet(defaultConfig);
  if (!instanceUrl) {
    return null;
  }
  try {
    return new URL(instanceUrl).origin;
  } catch (ex) {
    return null;
  }
}

async function assertAllowedRequestUrl(rawUrl, {allowExtension = false} = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (ex) {
    throw new Error('Invalid request URL');
  }

  if (allowExtension && parsed.origin === EXTENSION_ORIGIN) {
    return parsed.toString();
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Unsupported URL protocol');
  }

  const instanceOrigin = await getInstanceOrigin();
  if (!instanceOrigin || parsed.origin !== instanceOrigin) {
    throw new Error('URL is outside configured Jira instance');
  }

  return parsed.toString();
}

function validateMessageSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) {
    throw new Error('Rejected sender');
  }
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function uniqueList(values) {
  return values.filter((value, index) => value && values.indexOf(value) === index);
}

function hasTabId(tab) {
  return tab && typeof tab.id === 'number' && tab.id >= 0;
}

function hasConfiguredDomain(configDomains, candidate) {
  const normalizedCandidate = toMatchUrl(candidate);
  return (configDomains || []).some(existingDomain => toMatchUrl(existingDomain) === normalizedCandidate);
}

function getRelatedActivationOrigins(tabUrl) {
  let hostname = '';
  let origin = '';

  try {
    const parsedUrl = new URL(tabUrl);
    hostname = parsedUrl.hostname.toLowerCase();
    origin = parsedUrl.origin + '/';
  } catch (ex) {
    return [];
  }

  const relatedOrigins = [origin];

  if (hostname.endsWith('.sharepoint.com') || hostname.endsWith('.office.com') || hostname.endsWith('.officeapps.live.com') || hostname.endsWith('.cloud.microsoft')) {
    relatedOrigins.push(
      'https://*.sharepoint.com/*',
      'https://*.office.com/*',
      'https://*.officeapps.live.com/*',
      'https://*.cloud.microsoft/*'
    );
  }

  if (hostname === 'docs.google.com' || hostname.endsWith('.docs.google.com') || hostname.endsWith('.googleusercontent.com')) {
    relatedOrigins.push(
      'https://docs.google.com/*',
      'https://*.googleusercontent.com/*'
    );
  }

  return uniqueList(relatedOrigins);
}

function matchPatternToRegex(pattern) {
  const wildcardToken = '__JX_WILDCARD__';
  return new RegExp('^' + regexEscape(toMatchUrl(pattern).replace(/\*/g, wildcardToken)).replace(new RegExp(wildcardToken, 'g'), '.*') + '$', 'i');
}

async function shouldInjectIntoUrl(rawUrl) {
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
    return false;
  }

  const config = await storageGet(defaultConfig);
  return (config.domains || []).some(pattern => {
    try {
      return matchPatternToRegex(pattern).test(rawUrl);
    } catch (ex) {
      return false;
    }
  });
}

async function ensureFrameContentScriptReady(tabId, frameId) {
  await executeScript({
    target: {tabId, frameIds: [frameId]},
    files: [contentScript]
  });
}

async function ensureContentScriptReady(tabId) {
  await executeScript({
    target: {tabId, allFrames: true},
    files: [contentScript]
  });
}

async function notifyTab(tabId, message) {
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      if (attempt > 0) {
        await ensureContentScriptReady(tabId);
      }
      await sendMessage(tabId, {
        action: 'message',
        message
      });
      return true;
    } catch (ex) {
      await delay(80);
    }
  }
  return false;
}

async function injectActionFeedback(tabId, message) {
  await executeScript({
    target: {tabId},
    func: (text) => {
      const existing = document.getElementById('__JX_action_feedback__');
      if (existing) {
        existing.remove();
      }

      const toast = document.createElement('div');
      toast.id = '__JX_action_feedback__';
      toast.textContent = text;
      toast.style.position = 'fixed';
      toast.style.right = '20px';
      toast.style.bottom = '20px';
      toast.style.zIndex = '2147483647';
      toast.style.maxWidth = '420px';
      toast.style.padding = '12px 16px';
      toast.style.borderRadius = '12px';
      toast.style.background = 'rgba(22, 28, 45, 0.96)';
      toast.style.color = '#fff';
      toast.style.font = '600 14px/1.4 sans-serif';
      toast.style.boxShadow = '0 12px 32px rgba(0, 0, 0, 0.25)';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      toast.style.transition = 'opacity 120ms ease, transform 120ms ease';

      document.documentElement.appendChild(toast);
      requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
      });

      window.setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
        window.setTimeout(() => toast.remove(), 180);
      }, 2800);
    },
    args: [message]
  });
}

async function setActionStatus(tabId, message) {
  await setActionTitle({tabId, title: message});
  await setBadgeBackgroundColor({tabId, color: '#1f6feb'});
  await setBadgeText({tabId, text: 'ON'});
  setTimeout(() => {
    chrome.action.setBadgeText({tabId, text: ''});
  }, 3000);
}

async function setActionBadge(tabId, text, color, title) {
  if (!hasTabId({id: tabId})) {
    return;
  }
  if (title) {
    await setActionTitle({tabId, title});
  }
  if (color) {
    await setBadgeBackgroundColor({tabId, color});
  }
  await setBadgeText({tabId, text});
}

function clearActionBadgeLater(tabId, delayMs = 3000) {
  setTimeout(() => {
    chrome.action.setBadgeText({tabId, text: ''});
  }, delayMs);
}

function requestActionOrigins(origins) {
  return new Promise((resolve, reject) => {
    chrome.permissions.request({origins: origins.map(toMatchUrl)}, granted => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(!!granted);
    });
  });
}

async function showActionFeedback(tabId, message) {
  try {
    await injectActionFeedback(tabId, message);
    await setActionStatus(tabId, message).catch(() => {});
    return true;
  } catch (error) {
    const delivered = await notifyTab(tabId, message).catch(() => false);
    if (delivered) {
      await setActionStatus(tabId, message).catch(() => {});
      return true;
    }
    await setActionStatus(tabId, message).catch(() => {});
    return false;
  }
}

async function fetchWithPolicy(url, init = {}, {credentials = 'include'} = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      credentials,
      ...init,
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} - ${response.statusText}`);
    }
    return response;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchWithCredentials(url, init = {}) {
  return fetchWithPolicy(url, init, {credentials: 'include'});
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

function attachmentBytesToBlob(bytes, type = 'application/octet-stream') {
  if (Array.isArray(bytes)) {
    return new Blob([Uint8Array.from(bytes)], {type});
  }
  if (ArrayBuffer.isView(bytes)) {
    return new Blob([bytes], {type});
  }
  if (bytes instanceof ArrayBuffer) {
    return new Blob([bytes], {type});
  }
  throw new Error('Attachment payload must be a byte array');
}

async function getSimpleSyncState() {
  const result = await storageLocalGet({[SIMPLE_SYNC_STORAGE_KEY]: {}});
  return normalizeSimpleSyncState(result[SIMPLE_SYNC_STORAGE_KEY]);
}

async function setSimpleSyncState(nextState) {
  await storageLocalSet({[SIMPLE_SYNC_STORAGE_KEY]: normalizeSimpleSyncState(nextState)});
}

async function fetchSimpleSyncUrl(state) {
  const response = await fetchWithCredentials(state.source.url, {
    headers: {'Accept': 'application/json, text/plain, */*'}
  });
  return response.text();
}

function isJiraDuplicateAttachmentFileName(actualFileName, expectedFileName) {
  const actual = String(actualFileName || '').trim();
  const expected = String(expectedFileName || '').trim();
  if (!actual || !expected) {
    return false;
  }
  if (actual === expected) {
    return true;
  }

  const expectedMatch = expected.match(/^(.*?)(\.[^.]+)?$/);
  const actualMatch = actual.match(/^(.*?)(\.[^.]+)?$/);
  if (!expectedMatch || !actualMatch) {
    return false;
  }

  const expectedBase = expectedMatch[1];
  const expectedExt = expectedMatch[2] || '';
  const actualBase = actualMatch[1];
  const actualExt = actualMatch[2] || '';

  if (actualExt !== expectedExt) {
    return false;
  }

  return new RegExp(`^${regexEscape(expectedBase)} \\([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\)$`, 'i')
    .test(actualBase);
}

function selectLatestSettingsAttachment(attachments, fileName) {
  const candidates = (Array.isArray(attachments) ? attachments : [])
    .filter(attachment => isJiraDuplicateAttachmentFileName(attachment?.filename, fileName));
  candidates.sort((left, right) => {
    const leftTime = Date.parse(left.created || left.createdDate || '') || 0;
    const rightTime = Date.parse(right.created || right.createdDate || '') || 0;
    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }
    return String(right.id || '').localeCompare(String(left.id || ''));
  });
  return candidates[0] || null;
}

function buildJiraAttachmentDownloadUrl(attachment, instanceUrl) {
  if (attachment?.id) {
    return `${instanceUrl}rest/api/2/attachment/content/${encodeURIComponent(String(attachment.id))}?redirect=false`;
  }

  const contentUrl = String(attachment?.content || '').trim();
  if (!contentUrl) {
    throw new Error('Settings attachment metadata did not include a download URL.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(contentUrl);
  } catch (ex) {
    throw new Error('Settings attachment download URL is invalid.');
  }
  parsedUrl.searchParams.set('redirect', 'false');
  return parsedUrl.toString();
}

async function fetchSimpleSyncJiraAttachment(state, currentConfig) {
  if (!currentConfig.instanceUrl) {
    throw new Error('Save your Jira instance URL before using Jira attachment sync.');
  }
  const issueKey = state.source.issueKey;
  const fileName = state.source.fileName;
  const instanceUrl = String(currentConfig.instanceUrl || '').endsWith('/')
    ? currentConfig.instanceUrl
    : currentConfig.instanceUrl + '/';
  const issueUrl = instanceUrl + 'rest/api/2/issue/' + encodeURIComponent(issueKey) + '?fields=attachment';
  let issueResponse;
  try {
    issueResponse = await fetchWithCredentials(await assertAllowedRequestUrl(issueUrl));
  } catch (error) {
    if (error?.message?.startsWith('HTTP 404')) {
      throw new Error(`Could not find Jira issue ${issueKey}. Check the issue key and that you can access it.`);
    }
    if (error?.message?.startsWith('HTTP 403')) {
      throw new Error(`Could not read Jira issue ${issueKey}. Check that you are signed in to Jira and have access to the issue.`);
    }
    throw error;
  }
  const issue = await issueResponse.json();
  const attachment = selectLatestSettingsAttachment(issue?.fields?.attachment, fileName);
  if (!attachment) {
    throw new Error(`No settings attachment named ${fileName} was found on ${issueKey}.`);
  }
  const attachmentUrl = await assertAllowedRequestUrl(buildJiraAttachmentDownloadUrl(attachment, instanceUrl));
  try {
    const attachmentResponse = await fetchWithCredentials(attachmentUrl, {
      headers: {'Accept': 'application/json, text/plain, */*'}
    });
    return attachmentResponse.text();
  } catch (error) {
    if (error?.message === 'Failed to fetch') {
      throw new Error('Could not download the settings attachment from Jira. Check that you are signed in to Jira and that the attachment can be read.');
    }
    throw error;
  }
}

async function fetchSimpleSyncSettingsText(state, currentConfig) {
  if (state.sourceType === SIMPLE_SYNC_SOURCE_TYPES.URL) {
    return fetchSimpleSyncUrl(state);
  }
  return fetchSimpleSyncJiraAttachment(state, currentConfig);
}

async function hasConfigPermissions(config) {
  const origins = getConfigPermissionOrigins(config);
  if (!origins.length) {
    return true;
  }
  try {
    return await permissionsContains({origins});
  } catch (ex) {
    return false;
  }
}

async function runSimpleSettingsSync() {
  const state = await getSimpleSyncState();
  if (!state.enabled) {
    return {
      status: 'disabled',
      message: 'Team Sync is not connected.'
    };
  }

  const checkedAt = new Date().toISOString();
  const currentConfig = await storageGet(defaultConfig);

  try {
    const rawText = await fetchSimpleSyncSettingsText(state, currentConfig);
    const payload = normalizeSettingsPayload(JSON.parse(rawText));
    if (!isVersionAtLeast(chrome.runtime.getManifest().version, payload.minimumExtensionVersion)) {
      throw new Error(`Settings revision ${payload.settingsRevision} requires Jira QuickView ${payload.minimumExtensionVersion} or newer.`);
    }
    const nextHash = await hashString(rawText);

    if (payload.settingsRevision <= state.lastRevision && nextHash === state.lastHash) {
      const unchangedState = {
        ...state,
        lastSchemaVersion: payload.schemaVersion,
        lastMinimumExtensionVersion: payload.minimumExtensionVersion,
        lastPolicy: payload.policy,
        lastCheckedAt: checkedAt,
        status: 'synced',
        message: `Already synced at revision ${state.lastRevision}.`,
      };
      await setSimpleSyncState(unchangedState);
      return {
        status: unchangedState.status,
        message: unchangedState.message,
        revision: unchangedState.lastRevision,
      };
    }

    const merged = mergeSyncedConfig(currentConfig, payload, state.lastAppliedSettings);
    await storageSet(merged.config);
    await resetDeclarativeMapping();

    const hasPermissions = await hasConfigPermissions(merged.config);
    const syncedState = {
      ...state,
      lastSchemaVersion: payload.schemaVersion,
      lastRevision: payload.settingsRevision,
      lastHash: nextHash,
      lastCheckedAt: checkedAt,
      lastAppliedAt: checkedAt,
      lastMinimumExtensionVersion: payload.minimumExtensionVersion,
      lastPolicy: payload.policy,
      lastAppliedSettings: merged.lastAppliedSettings,
      status: hasPermissions ? 'synced' : 'permissionsRequired',
      message: hasPermissions
        ? `Synced revision ${payload.settingsRevision}.`
        : `Synced revision ${payload.settingsRevision}. Grant permissions for new pages before they activate.`,
    };
    await setSimpleSyncState(syncedState);

    return {
      status: syncedState.status,
      message: syncedState.message,
      revision: syncedState.lastRevision,
    };
  } catch (error) {
    const failedState = {
      ...state,
      lastCheckedAt: checkedAt,
      status: 'error',
      message: error?.message || 'Team Sync failed.',
    };
    await setSimpleSyncState(failedState);
    return {
      status: failedState.status,
      message: failedState.message,
      revision: failedState.lastRevision,
    };
  }
}

function scheduleSimpleSettingsSync() {
  if (!chrome.alarms) {
    return;
  }
  chrome.alarms.create(SIMPLE_SYNC_ALARM_NAME, {
    delayInMinutes: SIMPLE_SYNC_POLL_MINUTES,
    periodInMinutes: SIMPLE_SYNC_POLL_MINUTES,
  });
}

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  try {
    validateMessageSender(sender);
  } catch (error) {
    sendResponse({error: error.message});
    return false;
  }

  if (request.action === 'get') {
    assertAllowedRequestUrl(request.url, {allowExtension: true})
      .then(fetchWithCredentials)
      .then(async response => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} – ${response.statusText}`);
        }

        const contentType = response.headers.get('Content-Type') || '';
        const isJson = contentType.includes('application/json');

        const result = isJson
          ? await response.json()
          : await response.text();
        sendResponse({ result });
      })
      .catch(error => {
        sendResponse({ error: error.message });
      });
    return SEND_RESPONSE_IS_ASYNC;
  }

  if (request.action === 'getImageDataUrl') {
    assertAllowedRequestUrl(request.url)
      .then(fetchWithCredentials)
      .then(async response => {
        const fallbackMimeType = String(request.mimeType || '').trim().toLowerCase();
        const responseContentType = String(response.headers.get('Content-Type') || '').trim().toLowerCase();
        const responseBlob = await response.blob();
        const blobMimeType = String(responseBlob.type || '').trim().toLowerCase();
        const effectiveMimeType = responseContentType.startsWith('image/')
          ? responseContentType
          : (blobMimeType.startsWith('image/') ? blobMimeType : fallbackMimeType);
        if (!effectiveMimeType.startsWith('image/')) {
          throw new Error(`Expected image content but got: ${responseContentType || blobMimeType || 'unknown'}`);
        }
        const normalizedBlob = responseBlob.type === effectiveMimeType
          ? responseBlob
          : new Blob([await responseBlob.arrayBuffer()], {type: effectiveMimeType});
        const dataUrl = await blobToDataUrl(normalizedBlob);
        sendResponse({ result: dataUrl });
      })
      .catch(error => {
        sendResponse({ error: error.message });
      });
    return SEND_RESPONSE_IS_ASYNC;
  }

  if (request.action === 'uploadAttachment') {
    assertAllowedRequestUrl(request.url)
      .then(url => {
        const formData = new FormData();
        formData.append(
          'file',
          attachmentBytesToBlob(request.bytes, request.contentType || 'application/octet-stream'),
          request.fileName || 'pasted-image.png'
        );
        return fetchWithCredentials(url, {
          method: 'POST',
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'X-Atlassian-Token': 'no-check'
          },
          body: formData
        });
      })
      .then(async response => {
        const raw = await response.text();
        if (!raw) {
          sendResponse({ result: null });
          return;
        }

        try {
          sendResponse({ result: JSON.parse(raw) });
        } catch (ex) {
          sendResponse({ result: raw });
        }
      })
      .catch(error => {
        sendResponse({ error: error.message });
      });
    return SEND_RESPONSE_IS_ASYNC;
  }

  if (request.action === 'requestJson') {
    const method = String(request.method || 'POST').toUpperCase();
    const allowedMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
    if (allowedMethods.indexOf(method) === -1) {
      sendResponse({error: 'Unsupported request method'});
      return false;
    }

    assertAllowedRequestUrl(request.url)
      .then(url => fetchWithCredentials(url, {
        method,
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          ...(request.headers || {})
        },
        body: typeof request.body === 'undefined' ? undefined : JSON.stringify(request.body)
      }))
      .then(async response => {
        const raw = await response.text();
        if (!raw) {
          sendResponse({ result: null });
          return;
        }

        try {
          sendResponse({ result: JSON.parse(raw) });
        } catch (ex) {
          sendResponse({ result: raw });
        }
      })
      .catch(error => {
        sendResponse({ error: error.message });
      });
    return SEND_RESPONSE_IS_ASYNC;
  }

  if (request.action === 'openOptionsPage') {
    chrome.runtime.openOptionsPage();
    sendResponse({result: true});
    return false;
  }

  if (request.action === 'runSimpleSettingsSync') {
    runSimpleSettingsSync()
      .then(result => sendResponse({result}))
      .catch(error => sendResponse({error: error.message}));
    return SEND_RESPONSE_IS_ASYNC;
  }

  return false;
});

chrome.webNavigation.onCommitted.addListener(details => {
  if (details.tabId < 0 || details.frameId === 0) {
    return;
  }

  shouldInjectIntoUrl(details.url)
    .then(shouldInject => {
      if (!shouldInject) {
        return;
      }
      return ensureFrameContentScriptReady(details.tabId, details.frameId).catch(() => {});
    })
    .catch(() => {});
});

async function browserOnClicked (tab) {
  if (!hasTabId(tab) || !tab.url || !/^https?:\/\//i.test(tab.url)) {
    return;
  }

  const origins = getRelatedActivationOrigins(tab.url);
  const origin = origins[0];

  const granted = await requestActionOrigins(origins);
  if (!granted) {
    await showActionFeedback(tab.id, 'Jira QuickView was not enabled because the permission request was cancelled.').catch(() => {});
    clearActionBadgeLater(tab.id);
    return;
  }

  await setActionBadge(tab.id, '...', '#6b7280', 'Jira QuickView is checking this page').catch(() => {});

  const config = await storageGet(defaultConfig);
  if (!config.instanceUrl || !config.v15upgrade) {
    await showActionFeedback(tab.id, 'Open Jira QuickView options and save your Jira instance before enabling pages.').catch(() => {});
    chrome.runtime.openOptionsPage();
    clearActionBadgeLater(tab.id);
    return;
  }

  if (granted) {
    const config = await storageGet(defaultConfig);
    const domainsToAdd = origins.filter(candidate => !hasConfiguredDomain(config.domains, candidate));
    if (!domainsToAdd.length) {
      await showActionFeedback(tab.id, origin + ' is already enabled for Jira QuickView.');
      clearActionBadgeLater(tab.id);
      return;
    }
    config.domains.push(...domainsToAdd);
    await storageSet(config);
    await resetDeclarativeMapping();
    await ensureContentScriptReady(tab.id);
    const extraOriginsAdded = domainsToAdd.length > 1;
    await showActionFeedback(tab.id, extraOriginsAdded
      ? origin + ' added successfully with Office/Google editor support.'
      : origin + ' added successfully.');
    clearActionBadgeLater(tab.id);
  }
}

(function () {
  chrome.runtime.onInstalled.addListener(async () => {
    scheduleSimpleSettingsSync();
    runSimpleSettingsSync().catch(() => {});
    const config = await storageGet(defaultConfig);
    if (!config.instanceUrl || !config.v15upgrade) {
      chrome.runtime.openOptionsPage();
      return;
    }
    resetDeclarativeMapping();
  });

  chrome.runtime.onStartup.addListener(() => {
    scheduleSimpleSettingsSync();
    runSimpleSettingsSync().catch(() => {});
  });

  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === SIMPLE_SYNC_ALARM_NAME) {
      runSimpleSettingsSync().catch(() => {});
    }
  });

  chrome.action.onClicked.addListener(tab => {
    browserOnClicked(tab).catch(async error => {
      console.error('Jira QuickView action click failed', error);
      if (hasTabId(tab)) {
        const message = error?.message || 'Jira QuickView failed to enable this page.';
        await showActionFeedback(tab.id, message).catch(() => {});
        await setActionBadge(tab.id, 'ERR', '#b42318', message).catch(() => {});
        clearActionBadgeLater(tab.id, 5000);
      }
    });
  });
})();
