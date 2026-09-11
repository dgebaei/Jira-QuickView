function copyRequest(request) {
  return {
    ...request,
    body: request.body && typeof request.body === 'object'
      ? JSON.parse(JSON.stringify(request.body))
      : request.body,
  };
}

function createAbortError() {
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  return error;
}

function normalizeError(error) {
  const normalized = error instanceof Error
    ? error
    : new Error(String(error || 'Request failed'));
  if (!normalized.inner) {
    normalized.inner = normalized.message;
  }
  return normalized;
}

function matchesScript(script, request) {
  if (script.operation && script.operation !== request.operation) {
    return false;
  }
  if (script.method && script.method !== request.method) {
    return false;
  }
  if (typeof script.match === 'function') {
    return !!script.match(request);
  }
  if (script.path && script.path !== request.path) {
    return false;
  }
  return true;
}

function settleWithSignal(promise, signal, request) {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    request.aborted = true;
    return Promise.reject(createAbortError());
  }
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      request.aborted = true;
      reject(createAbortError());
    };
    signal.addEventListener('abort', handleAbort, {once: true});
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', handleAbort);
    });
  });
}

export function createDeferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, reject, resolve};
}

export function createMockJiraAdapter(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const requests = [];
  const scripts = [...(options.scripts || [])];
  let sequence = 0;

  function enqueue(script) {
    scripts.push(script);
  }

  function run(operation, details, signal) {
    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }
    const request = {
      id: ++sequence,
      operation,
      startedAt: clock(),
      aborted: false,
      ...copyRequest(details),
    };
    requests.push(request);

    const scriptIndex = scripts.findIndex(script => matchesScript(script, request));
    if (scriptIndex === -1) {
      return Promise.reject(new Error(`No mock Jira response for ${operation} ${details.path || ''}`.trim()));
    }
    const [script] = scripts.splice(scriptIndex, 1);
    let response;
    if (script.deferred) {
      response = script.deferred.promise;
    } else if (Object.prototype.hasOwnProperty.call(script, 'error')) {
      response = Promise.reject(normalizeError(script.error));
    } else {
      response = Promise.resolve(script.result);
    }
    return settleWithSignal(response, signal, request);
  }

  return {
    read({path, query, signal} = {}) {
      return run('read', {path, query}, signal);
    },
    write({method = 'POST', path, body, headers, signal} = {}) {
      return run('write', {method: String(method).toUpperCase(), path, body, headers}, signal);
    },
    upload({path, file, signal} = {}) {
      return run('upload', {
        path,
        fileName: file?.name || '',
        contentType: file?.type || '',
        size: Number(file?.size) || 0,
      }, signal);
    },
    image({url, mimeType, signal} = {}) {
      return run('image', {path: url, mimeType}, signal);
    },
    enqueue,
    getRequests() {
      return requests.map(copyRequest);
    },
    getPendingScriptCount() {
      return scripts.length;
    },
  };
}
