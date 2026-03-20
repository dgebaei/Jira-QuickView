require('./load-env-defaults');

const http = require('http');
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');

const repoRoot = path.resolve(__dirname, '../..');
const outputRoot = path.join(repoRoot, 'tests/output/playwright');
const resetScript = path.join(repoRoot, 'scripts/playwright/reset-reports.js');
const commands = {
  all: ['npm', ['run', 'test:e2e:all']],
  'mock-edge': ['npm', ['run', 'test:e2e:mock-edge']],
  'public-smoke': ['npm', ['run', 'test:e2e:public-smoke']],
  'live-authenticated': ['npm', ['run', 'test:e2e:live-authenticated']],
};

let currentRun = null;
let lastCompletedRun = null;
const defaultPort = Number(process.env.PLAYWRIGHT_DASHBOARD_PORT || 9323);
const faviconHref = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231263d6'/%3E%3Cpath d='M20 18h24a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4V22a4 4 0 0 1 4-4Z' fill='%23ffffff' opacity='.18'/%3E%3Cpath d='M24 22h16v6H24zm0 10h16v4H24zm0 8h10v4H24z' fill='%23ffffff'/%3E%3Ccircle cx='45' cy='41' r='7' fill='%232cc881'/%3E%3Cpath d='m42 41 2 2 4-5' fill='none' stroke='%230f1115' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";

function stripAnsi(value) {
  const ansiPattern = new RegExp('[\\u001B\\u009B][[\\]()#;?]*(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~])', 'g');
  return String(value || '')
    .replace(ansiPattern, '')
    .replace(/\r/g, '');
}

function emptyDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Test Automation Dashboard</title>
  <link rel="icon" href="${faviconHref}" />
  <style>
    body {
      margin: 0;
      font-family: "Segoe UI", Helvetica, Arial, sans-serif;
      background: linear-gradient(180deg, #111827, #0f1115);
      color: #edf2ff;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .card {
      width: min(780px, 100%);
      background: rgba(24, 31, 43, 0.98);
      border: 1px solid #283246;
      border-radius: 22px;
      padding: 28px;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.28);
    }
    h1 { margin: 0 0 12px; font-size: 30px; }
    p { margin: 0; color: #9eadc5; line-height: 1.6; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 20px; }
    button {
      cursor: pointer;
      border: 1px solid #283246;
      border-radius: 999px;
      padding: 10px 16px;
      background: rgba(35, 44, 60, 0.7);
      color: #edf2ff;
      font-weight: 700;
    }
    button.primary { background: linear-gradient(180deg, #58b6ff, #257bd8); border-color: transparent; }
    pre {
      margin-top: 18px;
      border-radius: 14px;
      background: #0c1118;
      color: #dbe5f6;
      padding: 14px;
      min-height: 60px;
      white-space: pre-wrap;
      font-family: Consolas, Monaco, monospace;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Test Automation Dashboard</h1>
    <p>No stored test history exists yet. Run a suite to create the first dashboard entry.</p>
    <div class="actions">
      <button class="primary" data-target="all">Run All Tests</button>
      <button data-target="mock-edge">Run Mock Failure Coverage</button>
      <button data-target="public-smoke">Run Public Jira Smoke</button>
      <button data-target="live-authenticated">Run Authenticated Jira Cloud</button>
    </div>
    <pre id="log">No active test run.</pre>
  </div>
  <script>
    const log = document.getElementById('log');
    let sawRunningState = false;
    let lastFinishedAt = '';
    async function refreshState() {
      const response = await fetch('/api/state', {cache: 'no-store'});
      const state = await response.json();
      if (sawRunningState && !state.running && state.finishedAt && state.finishedAt !== lastFinishedAt) {
        lastFinishedAt = state.finishedAt;
        window.location.assign('/');
        return;
      }
      sawRunningState = !!state.running;
      log.textContent = state.log || (state.running ? 'Test run in progress...' : 'No active test run.');
    }
    for (const button of document.querySelectorAll('[data-target]')) {
      button.addEventListener('click', async () => {
        await fetch('/api/run', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({target: button.dataset.target}),
        });
        refreshState();
      });
    }
    refreshState();
    setInterval(refreshState, 4000);
  </script>
</body>
</html>`;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {'content-type': 'application/json; charset=utf-8'});
  response.end(JSON.stringify(payload));
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  if (filePath.endsWith('.webm')) return 'video/webm';
  if (filePath.endsWith('.zip')) return 'application/zip';
  return 'application/octet-stream';
}

function getState() {
  const source = currentRun || lastCompletedRun;
  return {
    running: !!currentRun,
    command: source?.command || '',
    startedAt: source?.startedAt || '',
    finishedAt: source?.finishedAt || '',
    exitCode: source?.exitCode,
    log: source?.log || '',
  };
}

function appendLog(chunk) {
  if (!currentRun) {
    return;
  }
  currentRun.log = `${currentRun.log}${stripAnsi(chunk)}`.slice(-24000);
}

function runCommand(target) {
  if (currentRun) {
    throw new Error('A Playwright run is already in progress.');
  }
  const definition = commands[target];
  if (!definition) {
    throw new Error(`Unknown run target: ${target}`);
  }

  const [command, args] = definition;
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  currentRun = {
    target,
    command: `${command} ${args.join(' ')}`,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    exitCode: null,
    log: '',
  };

  child.stdout.on('data', chunk => appendLog(chunk.toString()));
  child.stderr.on('data', chunk => appendLog(chunk.toString()));
  child.on('close', exitCode => {
    if (!currentRun) {
      return;
    }
    currentRun.exitCode = exitCode;
    currentRun.finishedAt = new Date().toISOString();
    appendLog(`\nProcess exited with code ${exitCode}.\n`);
    lastCompletedRun = {...currentRun};
    setTimeout(() => {
      if (currentRun && currentRun.finishedAt) {
        currentRun = null;
      }
    }, 10000);
  });
}

function resetHistory() {
  if (currentRun) {
    throw new Error('Cannot clear history while a Playwright run is in progress.');
  }
  lastCompletedRun = null;
  const child = spawn(process.execPath, [resetScript], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  return new Promise((resolve, reject) => {
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Reset script exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function serveFile(response, filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    response.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
    response.end('Not found');
    return;
  }
  response.writeHead(200, {'content-type': contentType(filePath)});
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');

  if (request.method === 'GET' && url.pathname === '/api/state') {
    sendJson(response, 200, getState());
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/run') {
    try {
      const body = await readRequestBody(request);
      runCommand(body.target);
      sendJson(response, 200, getState());
    } catch (error) {
      sendJson(response, 400, {error: String(error.message || error)});
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/reset') {
    try {
      const body = await readRequestBody(request);
      if (!body.confirm) {
        throw new Error('Confirmation required.');
      }
      await resetHistory();
      sendJson(response, 200, {ok: true});
    } catch (error) {
      sendJson(response, 400, {error: String(error.message || error)});
    }
    return;
  }

  const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(outputRoot, requestedPath));
  if (!filePath.startsWith(outputRoot)) {
    response.writeHead(403, {'content-type': 'text/plain; charset=utf-8'});
    response.end('Forbidden');
    return;
  }

  if ((requestedPath === '/index.html' || requestedPath === '/') && !fs.existsSync(filePath)) {
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    response.end(emptyDashboardHtml());
    return;
  }

  serveFile(response, filePath);
});

server.listen(defaultPort, '127.0.0.1', () => {
  console.log(`Playwright dashboard server: http://127.0.0.1:${defaultPort}`);
});
