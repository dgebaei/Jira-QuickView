function createAbortError() {
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  return error;
}

function unwrapResponse(response, defaultError = 'Request failed') {
  if (response && Object.prototype.hasOwnProperty.call(response, 'result')) {
    return response.result;
  }
  const message = response?.error || defaultError;
  const error = new Error(message);
  error.inner = message;
  throw error;
}

function appendQuery(path, query) {
  if (!query || typeof query !== 'object') {
    return path;
  }
  const params = new URLSearchParams();
  Object.entries(query).forEach(([name, rawValue]) => {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    values.forEach(value => {
      if (value !== null && typeof value !== 'undefined') {
        params.append(name, String(value));
      }
    });
  });
  const queryString = params.toString();
  if (!queryString) {
    return path;
  }
  return `${path}${String(path).includes('?') ? '&' : '?'}${queryString}`;
}

function observeSignal(run, signal) {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  const request = Promise.resolve().then(run);
  if (!signal) {
    return request;
  }

  return new Promise((resolve, reject) => {
    const handleAbort = () => reject(createAbortError());
    signal.addEventListener('abort', handleAbort, {once: true});
    request.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', handleAbort);
    });
  });
}

export function createBrowserMessageJiraAdapter(options = {}) {
  const sendMessage = options.sendMessage;
  if (typeof sendMessage !== 'function') {
    throw new Error('BrowserMessageJiraAdapter requires sendMessage');
  }

  return {
    read({path, query, signal} = {}) {
      const url = appendQuery(path, query);
      return observeSignal(
        async () => unwrapResponse(await sendMessage({action: 'get', url})),
        signal
      );
    },

    write({method = 'POST', path, body, headers, signal} = {}) {
      return observeSignal(
        async () => unwrapResponse(await sendMessage({
          action: 'requestJson',
          method: String(method).toUpperCase(),
          url: path,
          body,
          headers,
        })),
        signal
      );
    },

    upload({path, file, signal} = {}) {
      return observeSignal(async () => {
        const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
        return unwrapResponse(await sendMessage({
          action: 'uploadAttachment',
          bytes,
          contentType: file.type,
          fileName: file.name,
          url: path,
        }), 'Attachment upload failed');
      }, signal);
    },

    image({url, mimeType = '', signal} = {}) {
      return observeSignal(
        async () => unwrapResponse(await sendMessage({action: 'getImageDataUrl', url, mimeType})),
        signal
      );
    },
  };
}
