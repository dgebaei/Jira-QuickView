/*global chrome */
import defaultConfig from 'options/config.js';
import {storageGet, storageSet, permissionsRequest, promisifyChrome} from 'src/chrome';
import {contentScript, resetDeclarativeMapping} from 'options/declarative';

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

async function ensureContentScriptReady(tabId) {
  await executeScript({
    target: {tabId},
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

async function browserOnClicked (tab) {
  if (!tab || !tab.id || !tab.url || !/^https?:\/\//i.test(tab.url)) {
    return;
  }
  const config = await storageGet(defaultConfig);
  if (!config.instanceUrl || !config.v15upgrade) {
    chrome.runtime.openOptionsPage();
    return;
  }
  const origin = new URL(tab.url).origin + '/';
  const granted = await permissionsRequest({origins: [origin]});
  if (granted) {
    const config = await storageGet(defaultConfig);
    if (config.domains.indexOf(origin) !== -1) {
      await notifyTab(tab.id, origin + ' is already added.');
      return;
    }
    config.domains.push(origin);
    await storageSet(config);
    await resetDeclarativeMapping();
    await ensureContentScriptReady(tab.id);
    await notifyTab(tab.id, origin + ' added successfully !');
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

