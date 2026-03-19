/*global chrome */
import regexEscape from 'escape-string-regexp';
import defaultConfig from 'options/config.js';
import {storageGet, storageSet, permissionsRequest, promisifyChrome} from 'src/chrome';
import {contentScript, resetDeclarativeMapping, toMatchUrl} from 'options/declarative';

const executeScript = promisifyChrome(chrome.scripting, 'executeScript');
const sendMessage = promisifyChrome(chrome.tabs, 'sendMessage');

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

async function fetchWithCredentials(url, init = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      credentials: 'include',
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
        const contentType = response.headers.get('Content-Type') || '';
        if (!contentType.startsWith('image/')) {
          throw new Error(`Expected image content but got: ${contentType || 'unknown'}`);
        }
        const dataUrl = await blobToDataUrl(await response.blob());
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
  if (!tab || !tab.id || !tab.url || !/^https?:\/\//i.test(tab.url)) {
    return;
  }
  const config = await storageGet(defaultConfig);
  if (!config.instanceUrl || !config.v15upgrade) {
    chrome.runtime.openOptionsPage();
    return;
  }
  const origins = getRelatedActivationOrigins(tab.url);
  const origin = origins[0];
  const granted = await permissionsRequest({origins});
  if (granted) {
    const config = await storageGet(defaultConfig);
    const domainsToAdd = origins.filter(candidate => config.domains.indexOf(candidate) === -1);
    if (!domainsToAdd.length) {
      await notifyTab(tab.id, origin + ' is already added.');
      return;
    }
    config.domains.push(...domainsToAdd);
    await storageSet(config);
    await resetDeclarativeMapping();
    await ensureContentScriptReady(tab.id);
    const extraOriginsAdded = domainsToAdd.length > 1;
    await notifyTab(tab.id, extraOriginsAdded
      ? origin + ' added successfully with Office/Google editor support.'
      : origin + ' added successfully !');
  }
}

(function () {
  chrome.runtime.onInstalled.addListener(async () => {
    const config = await storageGet(defaultConfig);
    if (!config.instanceUrl || !config.v15upgrade) {
      chrome.runtime.openOptionsPage();
      return;
    }
    resetDeclarativeMapping();
  });

  chrome.action.onClicked.addListener(tab => {
    browserOnClicked(tab).catch(() => {});
  });
})();

