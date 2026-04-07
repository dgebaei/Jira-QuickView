const http = require('http');

function createHtml(title, body) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: sans-serif; margin: 24px; line-height: 1.5; }
      main { max-width: 960px; }
      .card { border: 1px solid #ccd; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
      .stack { display: grid; gap: 12px; }
      .deep-1, .deep-2, .deep-3, .deep-4, .deep-5 { padding: 6px; border: 1px dashed #ccd; }
      .target { display: inline-block; padding: 6px 10px; border-radius: 8px; background: #eef3ff; }
      .marker { font-weight: 700; color: #0b5fff; }
      img.demo-image { width: 80px; height: 80px; object-fit: cover; border-radius: 8px; }
    </style>
  </head>
  <body>
    <main>${body}</main>
  </body>
</html>`;
}

function defaultRouteContent(origin) {
  return {
    '/': createHtml('HotLinker Fixture', `
      <h1>Jira QuickView Fixture</h1>
      <div class="card">
        <p id="issue-inline">Release review references <span class="marker">JRACLOUD-97846</span> directly in the text.</p>
        <p id="issue-link"><a href="${origin}/browse/JRACLOUD-97846">Linked ticket JRACLOUD-97846</a></p>
      </div>
    `),
    '/hover-depth': createHtml('Hover Depth Fixture', `
      <h1>Hover Depth</h1>
      <div class="stack">
        <div class="card">
          <div id="exact-target" class="target">JRACLOUD-97846</div>
        </div>
        <div class="card" id="shallow-parent">
          Shallow parent contains JRACLOUD-97846
          <span id="shallow-child" class="target">hover child</span>
        </div>
        <div class="card deep-1" id="deep-parent">Deep ancestor contains JRACLOUD-97846
          <div class="deep-2">
            <div class="deep-3">
              <div class="deep-4">
                <span id="deep-child" class="target">hover deep child</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `),
    '/popup-actions': createHtml('Popup Actions Fixture', `
      <h1>Popup Actions</h1>
      <div class="card">
        <p>Hover <span id="popup-key" class="marker">JRACLOUD-97846</span> to load the mock issue.</p>
      </div>
    `),
    '/multi-key': createHtml('Multi Key Fixture', `
      <h1>Multiple Jira Keys</h1>
      <div class="stack">
        <div class="card" style="min-height: 140px;">
          <p>First mention: <span id="multi-key-first" class="marker">JRACLOUD-97846</span></p>
        </div>
        <div class="card" style="min-height: 280px; margin-top: 180px;">
          <p>Second mention: <span id="multi-key-second" class="marker">JRACLOUD-97846</span></p>
        </div>
      </div>
    `),
    '/modifier-input': createHtml('Modifier Input Fixture', `
      <h1>Modifier Input Fixture</h1>
      <div style="display: grid; grid-template-columns: 220px 1fr; gap: 32px; align-items: start; min-height: 360px;">
        <aside class="card">
          <p>Sidebar ticket: <span id="sidebar-key" class="marker">JRACLOUD-97846</span></p>
        </aside>
        <section class="card">
          <label for="subject-input" style="display:block; font-weight:700; margin-bottom:8px;">Subject</label>
          <input id="subject-input" type="text" value="Typing here should not open the popup" style="width: 100%; padding: 10px 12px; border: 1px solid #99a; border-radius: 8px;" />
        </section>
      </div>
    `),
    '/repeated-key-list': createHtml('Repeated Key List', `
      <h1>Repeated Key List</h1>
      <div class="stack" style="gap: 14px; max-width: 640px;">
        <div class="card" id="repeated-row-1" style="display:grid; grid-template-columns: 120px 1fr 70px; gap: 12px; align-items: center;">
          <span class="row-author">alice@example.com</span>
          <span class="row-subject" id="repeated-row-1-subject">Investigate JRACLOUD-97846 rollout issue</span>
          <span class="row-count" id="repeated-row-1-count">123</span>
        </div>
        <div class="card" id="repeated-row-2" style="display:grid; grid-template-columns: 120px 1fr 70px; gap: 12px; align-items: center;">
          <span class="row-author" id="repeated-row-2-author">bob@example.com</span>
          <span class="row-subject" id="repeated-row-2-subject">Follow-up for JRACLOUD-98123 report</span>
          <span class="row-count" id="repeated-row-2-count">445</span>
        </div>
      </div>
    `),
    '/modifier-same-container': createHtml('Modifier Same Container Fixture', `
      <h1>Modifier Same Container Fixture</h1>
      <div class="card" id="same-container-parent" style="display: flex; align-items: center; gap: 32px; min-height: 120px;">
        <span id="same-container-key" class="marker">JRACLOUD-97846</span>
        <span id="same-container-blank" style="display: inline-block; min-width: 260px; min-height: 48px; border: 1px dashed #ccd; border-radius: 8px; padding: 12px;">blank zone</span>
      </div>
    `),
    '/adjacent-message-list': createHtml('Adjacent Message List Fixture', `
      <h1>Adjacent Message List Fixture</h1>
      <div class="stack" style="gap: 0; max-width: 720px; border: 1px solid #ccd; border-radius: 12px; overflow: hidden;">
        <div id="message-row-top" style="display:grid; grid-template-columns: 160px 1fr; gap: 16px; padding: 18px 20px; border-bottom: 1px solid #eef; background: #fff;">
          <span>top@example.com</span>
          <span>No Jira reference here</span>
        </div>
        <div id="message-row-middle" style="display:grid; grid-template-columns: 160px 1fr; gap: 16px; padding: 18px 20px; border-bottom: 1px solid #eef; background: #f9fbff;">
          <span>jira@example.com</span>
          <span id="message-row-middle-subject">Release note for JRACLOUD-97846</span>
        </div>
        <div id="message-row-bottom" style="display:grid; grid-template-columns: 160px 1fr; gap: 16px; padding: 18px 20px; background: #fff;">
          <span>bottom@example.com</span>
          <span>No Jira reference here either</span>
        </div>
      </div>
    `),
    '/modifier-near-token': createHtml('Modifier Near Token Fixture', `
      <h1>Modifier Near Token Fixture</h1>
      <div class="card" style="font-size: 18px; line-height: 1.8;">
        <span id="near-token-key" class="marker">JRACLOUD-97846</span><span id="near-token-gap" style="display:inline-block; width: 28px; height: 1.8em;"></span><span>adjacent blank area</span>
      </div>
    `),
  };
}

async function createFixtureServer() {
  let origin = '';
  let routes = {};

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, origin);
    const content = routes[url.pathname];
    if (!content) {
      res.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
      res.end('Not found');
      return;
    }
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    res.end(content);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
  routes = defaultRouteContent(origin);

  return {
    origin,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

module.exports = {
  createFixtureServer,
};
