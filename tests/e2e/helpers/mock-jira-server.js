const fs = require('fs');
const http = require('http');
const path = require('path');
const {descriptionFieldToEditorText} = require('../../../jira-plugin/src/description-rich-text');

const PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAuklEQVR42u3RMQEAIAzAsPnBCeqmBD+4wAGI2A6OHDXQxMx99U9hAhABASIgQAQEiIAAMQKIgAARECACAkRAgAiIgAARECACAkRAgAiIgAARECACAkRAgAiIgAApNdZpDwgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECRECACAgQAREQIAICRECACAgQAREQIAICRECACAgQAQFiAhABASIgQAQEiIAAERABASIgQNTcA6yedS4u1mgqAAAAAElFTkSuQmCC',
  'base64'
);

const MOCK_ASSET_DIR = path.resolve(__dirname, '..', 'fixtures', 'mock-assets');
const ATTACHMENT_FIXTURE_BY_ID = {
  '900': 'evidence.png',
  '901': 'history-image-1.png',
  '902': 'history-image-2.png',
  '903': 'standalone-graph.png',
};
const ISSUE_LINK_TYPES = [
  {id: '10000', name: 'Blocks', outward: 'blocks', inward: 'is blocked by'},
  {id: '10001', name: 'Cloners', outward: 'clones', inward: 'is cloned by'},
  {id: '10002', name: 'Duplicate', outward: 'duplicates', inward: 'is duplicated by'},
  {id: '10003', name: 'Relates', outward: 'relates to', inward: 'relates to'},
];

function guessImageContentType(fileName = '') {
  return /\.jpe?g$/i.test(fileName) ? 'image/jpeg' : 'image/png';
}

function readMockAsset(fileName = '') {
  const normalizedName = path.basename(String(fileName || ''));
  if (!normalizedName) {
    return null;
  }

  const assetPath = path.join(MOCK_ASSET_DIR, normalizedName);
  if (!fs.existsSync(assetPath)) {
    return null;
  }

  return {
    buffer: fs.readFileSync(assetPath),
    contentType: guessImageContentType(normalizedName),
  };
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'access-control-allow-origin': '*',
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload));
}

function text(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'access-control-allow-origin': '*',
    'content-type': 'text/plain; charset=utf-8',
  });
  res.end(payload);
}

function html(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
  });
  res.end(payload);
}

function buildCloudIssuePage(state) {
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>${escapeHtml(state.issue.key)} - ${escapeHtml(state.issue.summary)}</title>
        <style>
          body { background: #f7f8f9; color: #172b4d; font: 14px Arial, sans-serif; margin: 0; }
          main { background: #fff; margin: 48px auto; max-width: 920px; padding: 32px 40px; }
          .breadcrumbs { align-items: center; display: flex; gap: 6px; }
          .breadcrumbs a { color: #44546f; font-weight: 600; text-decoration: none; }
          h1 { font-size: 24px; margin: 20px 0 8px; }
          p { color: #5e6c84; }
        </style>
      </head>
      <body>
        <main>
          <div class="breadcrumbs" data-testid="issue.views.issue-base.foundation.breadcrumbs.breadcrumb-current-issue-container">
            <a href="/browse/${escapeHtml(state.issue.key)}" data-testid="issue-key-link">${escapeHtml(state.issue.key)}</a>
          </div>
          <h1 data-testid="issue.views.issue-base.foundation.summary.heading">${escapeHtml(state.issue.summary)}</h1>
          <p>Mock Jira Cloud issue details</p>
        </main>
      </body>
    </html>`;
}

function buildCloudIssueSearchPage(state) {
  const issues = [state.issue, ...state.issueSearchCatalog.slice(0, 2).map(issue => ({
    key: issue.key,
    summary: issue.fields.summary,
  }))];
  const rows = issues.map(issue => `
    <article class="issue-row" data-issue-key="${escapeHtml(issue.key)}">
      <span class="issue-key-cell"><a class="issue-key" href="/browse/${escapeHtml(issue.key)}">${escapeHtml(issue.key)}</a></span>
      <a class="issue-summary" href="/browse/${escapeHtml(issue.key)}">${escapeHtml(issue.summary)}</a>
      <span class="status">To Do</span>
    </article>`).join('');
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Issue navigator</title>
        <style>
          body { background: #f1f2f4; color: #172b4d; font: 14px Arial, sans-serif; margin: 0; }
          main { background: #fff; margin: 42px auto; max-width: 980px; padding: 28px 34px; }
          h1 { font-size: 24px; margin: 0 0 20px; }
          .issue-row { align-items: center; border-top: 1px solid #dfe1e6; display: grid; gap: 12px; grid-template-columns: 170px 1fr 90px; min-height: 50px; }
          .issue-key { color: #0c66e4; font-weight: 600; text-decoration: none; }
          .issue-key-cell { align-items: center; display: inline-flex; }
          .issue-summary { color: #172b4d; text-decoration: none; }
          .status { color: #5e6c84; font-size: 12px; }
        </style>
      </head>
      <body><main><h1>Issues</h1><section id="issue-results">${rows}</section></main></body>
    </html>`;
}

function buildCloudBoardPage(state) {
  const issues = [state.issue, ...state.issueSearchCatalog.slice(0, 2).map(issue => ({
    key: issue.key,
    summary: issue.fields.summary,
  }))];
  const cards = issues.map(issue => `
    <article class="board-card" data-issue-key="${escapeHtml(issue.key)}">
      <div class="card-key-row"><span class="card-key" data-testid="platform-card.ui.key.key">${escapeHtml(issue.key)}</span></div>
      <strong class="card-summary" data-testid="platform-card.ui.summary">${escapeHtml(issue.summary)}</strong>
      <span class="card-meta">To Do</span>
    </article>`).join('');
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>JRACLOUD board</title>
        <style>
          body { background: #f1f2f4; color: #172b4d; font: 14px Arial, sans-serif; margin: 0; }
          main { margin: 38px auto; max-width: 1040px; }
          h1 { font-size: 24px; }
          .board-column { background: #dfe1e6; border-radius: 10px; display: grid; gap: 12px; padding: 16px; width: 320px; }
          .board-card { background: #fff; border-radius: 6px; box-shadow: 0 1px 2px rgba(9, 30, 66, .2); display: grid; gap: 10px; padding: 14px; }
          .card-key-row { align-items: center; display: flex; }
          .card-key { color: #44546f; font-size: 12px; font-weight: 600; }
          .card-summary { font-size: 14px; line-height: 1.35; }
          .card-meta { color: #6b778c; font-size: 11px; }
        </style>
      </head>
      <body><main><h1>JRACLOUD board</h1><section class="board-column">${cards}</section></main></body>
    </html>`;
}

function buildDataCenterIssuePage(state) {
  const childIssue = state.childIssues[0];
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>${escapeHtml(state.issue.key)} - ${escapeHtml(state.issue.summary)}</title>
        <style>
          body { background: #f4f5f7; color: #172b4d; font: 14px Arial, sans-serif; margin: 0; }
          main { background: #fff; margin: 48px auto; max-width: 920px; padding: 32px 40px; }
          .issue-header-content { align-items: center; display: flex; gap: 8px; }
          #key-val { color: #42526e; font-weight: 600; text-decoration: none; }
          #summary-val { font-size: 24px; margin-top: 22px; }
          .module { margin-top: 28px; }
          .mod-header { align-items: center; border-bottom: 1px solid #b7bec8; display: flex; justify-content: space-between; }
          .toggle-header { font-size: 14px; margin: 0; }
          .toggle-title { background: transparent; border: 0; color: #172b4d; font: inherit; font-weight: 600; padding: 10px 0; }
          .ops { align-items: center; display: flex; gap: 10px; list-style: none; margin: 0; padding: 0; }
          .icon-add16 { color: #44546f; font-size: 20px; text-decoration: none; }
          .ghx-issuetable { border-collapse: collapse; width: 100%; }
          .ghx-issuetable td { border-bottom: 1px solid #dfe1e6; padding: 11px 8px; }
          .ghx-summary { width: 55%; }
          .status { color: #44546f; }
        </style>
      </head>
      <body>
        <main>
          <div class="issue-header-content"><a id="key-val" href="/jira/browse/${escapeHtml(state.issue.key)}">${escapeHtml(state.issue.key)}</a></div>
          <h1 id="summary-val">${escapeHtml(state.issue.summary)}</h1>
          <p>Mock Jira Data Center issue details</p>
          <div id="greenhopper-epics-issue-web-panel" class="module toggle-wrap">
            <div id="greenhopper-epics-issue-web-panel_heading" class="mod-header">
              <h3 class="toggle-header" id="greenhopper-epics-issue-web-panel-label">
                <button class="aui-button toggle-title" type="button"><span class="aui-toggle-header-button-label">Issues in epic</span></button>
              </h3>
              <ul class="ops"><li><a id="gh-create-issue-in-epic-lnk" href="/jira/secure/CreateIssue!default.jspa" class="icon icon-add16"><span>+</span></a></li></ul>
            </div>
            <div class="mod-content">
              <table id="ghx-issues-in-epic-table" class="ghx-issuetable">
                <tbody>
                  <tr data-issuekey="${escapeHtml(childIssue.key)}" class="issuerow">
                    <td class="nav ghx-minimal"><a href="/jira/browse/${escapeHtml(childIssue.key)}">${escapeHtml(childIssue.key)}</a></td>
                    <td class="nav ghx-summary">${escapeHtml(childIssue.fields.summary)}</td>
                    <td class="nav status"><span class="jira-issue-status-lozenge">${escapeHtml(childIssue.fields.status.name)}</span></td>
                    <td class="nav assignee">Morgan Agent</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </main>
      </body>
    </html>`;
}

function noContent(res) {
  res.writeHead(204, {'access-control-allow-origin': '*'});
  res.end();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildRenderedCommentBody(body) {
  return `<p>${escapeHtml(body).replace(/\n/g, '<br/>')}</p>`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildAttachmentContentUrl(origin, attachmentId) {
  return `${origin}/rest/api/2/attachment/content/${attachmentId}`;
}

function buildAttachmentThumbnailUrl(origin, attachmentId) {
  return `${origin}/rest/api/2/attachment/thumbnail/${attachmentId}`;
}

function normalizeAttachmentMarkupName(reference) {
  return String(reference || '')
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split('|')[0]
    .trim();
}

function renderWikiInlineText(text) {
  const source = String(text || '');
  const tokens = [];
  let html = escapeHtml(source);

  html = html.replace(/\[([^\]|]+)\|([^\]]+)\]/g, (match, label, url) => {
    const token = `__JHL_LINK_${tokens.length}__`;
    tokens.push(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`);
    return token;
  });

  html = html.replace(/\bhttps?:\/\/[^\s<]+/g, url => {
    const token = `__JHL_LINK_${tokens.length}__`;
    tokens.push(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
    return token;
  });

  html = html.replace(/\*([^*\n][^*]*?)\*/g, '<strong>$1</strong>');
  html = html.replace(/_([^_\n]+)_/g, '<em>$1</em>');
  html = html.replace(/\+([^+\n]+)\+/g, '<u>$1</u>');
  html = html.replace(/-([^\-\n]+)-/g, '<del>$1</del>');

  tokens.forEach((tokenHtml, index) => {
    html = html.replace(`__JHL_LINK_${index}__`, tokenHtml);
  });
  return html.replace(/\n/g, '<br/>');
}

function buildRenderedDescriptionBody(body, attachments = []) {
  const source = String(body || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  if (!source.trim()) {
    return '';
  }

  const attachmentByName = new Map(
    (attachments || [])
      .filter(attachment => attachment?.filename)
      .map(attachment => [normalizeAttachmentMarkupName(attachment.filename), attachment])
  );

  return source
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const noformatMatch = block.match(/^\{(?:noformat|code)\}([\s\S]*?)\{(?:noformat|code)\}$/i);
      if (noformatMatch) {
        return `<p><code>${escapeHtml(noformatMatch[1])}</code></p>`;
      }

      const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
      if (lines.length > 0 && lines.every(line => line.startsWith('* '))) {
        return `<ul>${lines.map(line => `<li>${renderWikiInlineText(line.slice(2))}</li>`).join('')}</ul>`;
      }
      if (lines.length > 0 && lines.every(line => line.startsWith('# '))) {
        return `<ol>${lines.map(line => `<li>${renderWikiInlineText(line.slice(2))}</li>`).join('')}</ol>`;
      }

      const imageMatch = block.match(/^!([^!]+)!$/);
      if (imageMatch) {
        const fileName = normalizeAttachmentMarkupName(imageMatch[1]);
        const attachment = attachmentByName.get(fileName);
        if (!attachment) {
          return `<p>${escapeHtml(block)}</p>`;
        }
        return `<p><img src="${escapeHtml(attachment.content)}" alt="${escapeHtml(fileName)}" /></p>`;
      }

      return `<p>${renderWikiInlineText(block)}</p>`;
    })
    .join('');
}

function issueDescriptionHtml(origin, state) {
  return buildRenderedDescriptionBody(
    descriptionFieldToEditorText(state.issue.description),
    state.issue.attachments.concat(state.uploadedAttachments)
  );
}

function createState(origin) {
  const now = new Date('2026-03-18T10:00:00.000Z').toISOString();
  return {
    scenario: 'editable',
    currentUser: {
      accountId: 'user-me',
      name: 'me',
      key: 'me',
      displayName: 'Morgan Agent',
      avatarUrls: {'48x48': `${origin}/assets/avatar-me.png`},
    },
    assignableUsers: [
      {
        accountId: 'user-me',
        name: 'me',
        key: 'me',
        displayName: 'Morgan Agent',
        emailAddress: 'morgan@example.com',
        avatarUrls: {'48x48': `${origin}/assets/avatar-me.png`},
      },
      {
        accountId: 'user-alex',
        name: 'alex',
        key: 'alex',
        displayName: 'Alex Reviewer',
        emailAddress: 'alex@example.com',
        avatarUrls: {'48x48': `${origin}/assets/avatar-alex.png`},
      },
      {
        accountId: 'user-casey',
        name: 'casey',
        key: 'casey',
        displayName: 'Casey Commenter',
        emailAddress: 'casey@example.com',
        avatarUrls: {'48x48': `${origin}/assets/avatar-commenter.png`},
      },
      {
        accountId: 'user-darko',
        name: 'darko',
        key: 'darko',
        displayName: 'Darko Gebaei',
        emailAddress: 'darko@example.com',
        avatarUrls: {'48x48': `${origin}/assets/avatar-darko.png`},
      },
    ],
    labels: ['needs-triage', 'ux-bug', 'release-candidate'],
    reactions: {},
    boards: [{id: 77, name: 'Mock Board'}],
    sprints: [
      {id: 42, name: 'Sprint 42', state: 'active'},
      {id: 43, name: 'Sprint 43', state: 'future'},
    ],
    issue: {
      id: '10001',
      key: 'JRACLOUD-97846',
      summary: 'Pressing END removes non-command text starting with "/" in multi line text fields',
      issuetype: {
        id: '1',
        name: 'Bug',
        description: 'A problem which impairs product behavior.',
        iconUrl: `${origin}/assets/issuetype-bug.png`,
      },
      status: {
        id: '10000',
        name: 'To Do',
        iconUrl: `${origin}/assets/status-todo.png`,
        statusCategory: {key: 'new', name: 'To Do'},
      },
      priority: {
        id: '2',
        name: 'Medium',
        iconUrl: `${origin}/assets/priority-medium.png`,
      },
      description: `The mock issue exercises rich rendering, quick actions, and edit flows.\n\n[Open issue|${origin}/browse/JRACLOUD-97846]\n\n!evidence.png!`,
      reporter: {
        accountId: 'user-reporter',
        name: 'reporter',
        key: 'reporter',
        displayName: 'Riley Reporter',
        avatarUrls: {'48x48': `${origin}/assets/avatar-reporter.png`},
      },
      assignee: {
        accountId: 'user-alex',
        name: 'alex',
        key: 'alex',
        displayName: 'Alex Reviewer',
        avatarUrls: {'48x48': `${origin}/assets/avatar-alex.png`},
      },
      labels: ['needs-triage', 'ux-bug'],
      versions: [{id: '301', name: '2026.03'}],
      fixVersions: [{id: '401', name: '2026.04'}],
      parent: {key: 'JRACLOUD-97000', fields: {summary: 'Editor backlog umbrella'}},
      sprintEntries: [{id: 42, name: 'Sprint 42', state: 'active', boardId: 77}],
      attachments: [
        {
          id: '900',
          filename: 'evidence.png',
          mimeType: 'image/png',
          content: buildAttachmentContentUrl(origin, '900'),
          thumbnail: buildAttachmentThumbnailUrl(origin, '900'),
        },
        {
          id: '901',
          filename: 'image-2026-03-17-10-47-20-728.png',
          mimeType: 'image/png',
          content: buildAttachmentContentUrl(origin, '901'),
          thumbnail: buildAttachmentThumbnailUrl(origin, '901'),
        },
        {
          id: '902',
          filename: 'image-2026-03-17-10-48-30-600.png',
          mimeType: 'image/png',
          content: buildAttachmentContentUrl(origin, '902'),
          thumbnail: buildAttachmentThumbnailUrl(origin, '902'),
        },
        {
          id: '903',
          filename: 'standalone-graph.png',
          mimeType: 'image/png',
          content: buildAttachmentContentUrl(origin, '903'),
          thumbnail: buildAttachmentThumbnailUrl(origin, '903'),
        },
      ],
      comments: [
        {
          id: '5001',
          author: {
            displayName: 'Casey Commenter',
            avatarUrls: {'48x48': `${origin}/assets/avatar-commenter.png`},
          },
          created: now,
          body: 'Initial comment with a link https://example.com/docs',
          renderedBody: '<p>Initial comment with a link <a href="https://example.com/docs">https://example.com/docs</a></p>',
        },
        {
          id: '5002',
          author: {
            accountId: 'user-alex',
            name: 'alex',
            key: 'alex',
            displayName: 'Alex Reviewer',
            avatarUrls: {'48x48': `${origin}/assets/avatar-alex.png`},
          },
          created: '2026-03-17T10:48:00.000Z',
          body: 'Testirano na internom testnom okruzenju. Sada se report moze generirati, ali prikaz nije dobar.\n!image-2026-03-17-10-47-20-728.png|width=590,height=575!\nPrikaz bi trebao biti izjednacen s ostalim opcijama (npr. Email)\n!image-2026-03-17-10-48-30-600.png|width=1051,height=225!',
          renderedBody: '<p>Testirano na internom testnom okruzenju. Sada se report moze generirati, ali prikaz <strong>nije dobar</strong>.</p><p><img src="/assets/history-image-1.png" alt="image-2026-03-17-10-47-20-728.png" /></p><p>Prikaz bi trebao biti izjednacen s ostalim opcijama (npr. Email)</p><p><img src="/assets/history-image-2.png" alt="image-2026-03-17-10-48-30-600.png" /></p>',
        },
      ],
      changelog: {
        histories: [
          {
            id: 'history-1',
            created: '2026-03-17T10:48:00.000Z',
            author: {
              displayName: 'Alex Reviewer',
              accountId: 'user-alex',
            },
            items: [
              {
                field: 'Worklog ID',
                fieldId: 'worklogId',
                fromString: '',
                toString: '1940828',
              },
              {
                field: 'Attachment',
                fieldId: 'attachment',
                fromString: '',
                toString: 'image-2026-03-17-10-48-30-600.png',
              },
            ],
          },
          {
            id: 'history-2',
            created: '2026-03-17T10:47:00.000Z',
            author: {
              displayName: 'Alex Reviewer',
              accountId: 'user-alex',
            },
            items: [
              {
                field: 'Attachment',
                fieldId: 'attachment',
                fromString: '',
                toString: 'image-2026-03-17-10-47-20-728.png',
              },
              {
                field: 'Description',
                fieldId: 'description',
                fromString: '',
                toString: 'This task needs - what?\n\n*A DESCRIPTION*, of course!\n\nAnd here it is - +_and a rich one!_+\n\n{noformat}With images:{noformat}\n\n!standalone-graph.png!\n\nUpdated rollout checklist for JRACLOUD-97000.\nCapture final screenshots before release.',
              },
            ],
          },
          {
            id: 'history-3',
            created: '2026-03-17T10:30:00.000Z',
            author: {
              displayName: 'Morgan Agent',
              accountId: 'user-me',
            },
            items: [
              {
                field: 'timeestimate',
                fieldId: 'timeestimate',
                fromString: '',
                toString: '600',
              },
              {
                field: 'Attachment',
                fieldId: 'attachment',
                fromString: '',
                toString: 'standalone-graph.png',
              },
            ],
          },
        ],
      },
      timetracking: {
        originalEstimate: '1w',
        remainingEstimate: '1d',
        timeSpent: '2h',
      },
      watchers: [
        {
          accountId: 'user-me',
          name: 'me',
          key: 'me',
          displayName: 'Morgan Agent',
          emailAddress: 'morgan@example.com',
          avatarUrls: {'48x48': `${origin}/assets/avatar-me.png`},
        },
        {
          accountId: 'user-alex',
          name: 'alex',
          key: 'alex',
          displayName: 'Alex Reviewer',
          emailAddress: 'alex@example.com',
          avatarUrls: {'48x48': `${origin}/assets/avatar-alex.png`},
        },
      ],
      issueLinks: [
        {
          id: 'link-1',
          type: ISSUE_LINK_TYPES[0],
          outwardIssue: {key: 'JRACLOUD-98123'},
        },
        {
          id: 'link-2',
          type: ISSUE_LINK_TYPES[0],
          inwardIssue: {key: 'PLATFORM-101'},
        },
        {
          id: 'link-3',
          type: ISSUE_LINK_TYPES[3],
          outwardIssue: {key: 'JRACLOUD-97000'},
        },
      ],
      customFields: {
        customfield_12345: 'Customer impact: High',
        customfield_67890: {
          accountId: 'user-alex',
          name: 'alex',
          key: 'alex',
          displayName: 'Alex Reviewer',
          emailAddress: 'alex@example.com',
          avatarUrls: {'48x48': `${origin}/assets/avatar-alex.png`},
        },
      },
    },
    issueSearchCatalog: [
      {
        id: '10002',
        key: 'JRACLOUD-97000',
        fields: {
          summary: 'Editor backlog umbrella',
          project: {key: 'JRACLOUD', id: '10000'},
          issuetype: {
            id: '10000',
            name: 'Epic',
            iconUrl: `${origin}/assets/issuetype-task.png`,
          },
          status: {
            id: '3',
            name: 'In Progress',
            iconUrl: `${origin}/assets/status-in-progress.png`,
          },
        },
      },
      {
        id: '10003',
        key: 'JRACLOUD-98123',
        fields: {
          summary: 'Improve slash command cursor stability',
          project: {key: 'JRACLOUD', id: '10000'},
          issuetype: {
            id: '10000',
            name: 'Epic',
            iconUrl: `${origin}/assets/issuetype-bug.png`,
          },
          status: {
            id: '10000',
            name: 'To Do',
            iconUrl: `${origin}/assets/status-todo.png`,
          },
          assignee: {
            accountId: 'user-me',
            name: 'me',
            key: 'me',
            displayName: 'Morgan Agent',
            avatarUrls: {'48x48': `${origin}/assets/avatar-me.png`},
          },
        },
      },
      {
        id: '20001',
        key: 'PLATFORM-101',
        fields: {
          summary: 'Cross-project platform initiative',
          project: {key: 'PLATFORM', id: '20000'},
          issuetype: {
            id: '10000',
            name: 'Epic',
            iconUrl: `${origin}/assets/issuetype-task.png`,
          },
          status: {
            id: '10000',
            name: 'To Do',
            iconUrl: `${origin}/assets/status-todo.png`,
          },
        },
      },
      {
        id: '10004',
        key: 'JRACLOUD-99999',
        fields: {
          summary: 'A story cannot parent another story',
          project: {key: 'JRACLOUD', id: '10000'},
          issuetype: {
            id: '2',
            name: 'Task',
            iconUrl: `${origin}/assets/issuetype-task.png`,
          },
          status: {
            id: '10000',
            name: 'To Do',
            iconUrl: `${origin}/assets/status-todo.png`,
          },
        },
      },
      {
        id: '10005',
        key: 'JRACLOUD-99001',
        fields: {
          summary: 'Track API retry exhaustion in quick view',
          project: {key: 'JRACLOUD', id: '10000'},
          issuetype: {
            id: '2',
            name: 'Task',
            iconUrl: `${origin}/assets/issuetype-task.png`,
          },
          status: {
            id: '10000',
            name: 'To Do',
            iconUrl: `${origin}/assets/status-todo.png`,
          },
          assignee: {
            accountId: 'user-alex',
            name: 'alex',
            key: 'alex',
            displayName: 'Alex Reviewer',
            avatarUrls: {'48x48': `${origin}/assets/avatar-alex.png`},
          },
        },
      },
      {
        id: '20002',
        key: 'API-204',
        fields: {
          summary: 'Add idempotency to the API link command',
          project: {key: 'API', id: '20001'},
          issuetype: {
            id: '1',
            name: 'Bug',
            iconUrl: `${origin}/assets/issuetype-bug.png`,
          },
          status: {
            id: '3',
            name: 'In Progress',
            iconUrl: `${origin}/assets/status-in-progress.png`,
          },
          assignee: null,
        },
      },
      {
        id: '30001',
        key: 'OPS-110',
        fields: {
          summary: 'Capture API latency alerts for support',
          project: {key: 'OPS', id: '30000'},
          issuetype: {
            id: '2',
            name: 'Task',
            iconUrl: `${origin}/assets/issuetype-task.png`,
          },
          status: {
            id: '10000',
            name: 'To Do',
            iconUrl: `${origin}/assets/status-todo.png`,
          },
          assignee: null,
        },
      },
    ],
    childIssues: [
      {
        id: '10011',
        key: 'JRACLOUD-97847',
        fields: {
          summary: 'Stabilize slash command parsing in multiline editor fields',
          issuetype: {
            id: '2',
            name: 'Task',
            iconUrl: `${origin}/assets/issuetype-task.png`,
          },
          status: {
            id: '3',
            name: 'In Progress',
            iconUrl: `${origin}/assets/status-in-progress.png`,
          },
          assignee: {
            accountId: 'user-me',
            name: 'me',
            key: 'me',
            displayName: 'Morgan Agent',
            avatarUrls: {'48x48': `${origin}/assets/avatar-me.png`},
          },
        },
      },
      {
        id: '10012',
        key: 'JRACLOUD-97848',
        fields: {
          summary: 'Handle caret edge cases for slash commands inside nested blocks',
          issuetype: {
            id: '4',
            name: 'Sub-task',
            iconUrl: `${origin}/assets/issuetype-subtask.png`,
          },
          status: {
            id: '10000',
            name: 'To Do',
            iconUrl: `${origin}/assets/status-todo.png`,
          },
          assignee: null,
        },
      },
      {
        id: '10013',
        key: 'JRACLOUD-97849',
        fields: {
          summary: 'Audit mention command interactions around END key handling',
          issuetype: {
            id: '1',
            name: 'Bug',
            iconUrl: `${origin}/assets/issuetype-bug.png`,
          },
          status: {
            id: '5',
            name: 'Done',
            iconUrl: `${origin}/assets/status-done.png`,
          },
          assignee: {
            accountId: 'user-alex',
            name: 'alex',
            key: 'alex',
            displayName: 'Alex Reviewer',
            avatarUrls: {'48x48': `${origin}/assets/avatar-alex.png`},
          },
        },
      },
    ],
    transitions: [
      {
        id: '31',
        name: 'Start progress',
        to: {
          id: '3',
          name: 'In Progress',
          iconUrl: `${origin}/assets/status-in-progress.png`,
          statusCategory: {key: 'indeterminate', name: 'In Progress'},
        },
      },
      {
        id: '41',
        name: 'Done',
        to: {
          id: '5',
          name: 'Done',
          iconUrl: `${origin}/assets/status-done.png`,
          statusCategory: {key: 'done', name: 'Done'},
        },
      },
    ],
    uploadedAttachments: [],
    issueLinkSequence: 4,
  };
}

function buildIssueResponse(origin, state, options = {}) {
  const issue = state.issue;
  const names = {
    customfield_10020: 'Sprint',
    customfield_12345: 'Customer Impact',
    customfield_67890: 'Reviewer',
  };
  const fields = {
    id: issue.id,
    project: {key: 'JRACLOUD', id: '10000'},
    summary: issue.summary,
    description: issue.description,
    reporter: issue.reporter,
    assignee: issue.assignee,
    issuetype: issue.issuetype,
    status: issue.status,
    priority: issue.priority,
    labels: issue.labels,
    versions: issue.versions,
    fixVersions: issue.fixVersions,
    parent: issue.parent,
    attachment: issue.attachments.concat(state.uploadedAttachments),
    comment: {comments: issue.comments.map(comment => ({
      id: comment.id,
      author: comment.author,
      created: comment.created,
      body: comment.body,
    }))},
    customfield_10020: issue.sprintEntries,
    customfield_12345: issue.customFields.customfield_12345,
    customfield_67890: issue.customFields.customfield_67890,
    timetracking: issue.timetracking,
    watches: {
      watchCount: issue.watchers.length,
      isWatching: issue.watchers.some(user => user.accountId === state.currentUser.accountId),
    },
    issuelinks: issue.issueLinks,
  };
  return {
    id: issue.id,
    key: issue.key,
    fields,
    names,
    ...(options.includeChangelog ? {changelog: issue.changelog} : {}),
    renderedFields: {
      description: issueDescriptionHtml(origin, state),
      comment: {
        comments: issue.comments.map(comment => ({id: comment.id, body: comment.renderedBody})),
      },
    },
  };
}

function buildEditmeta(state) {
  if (state.scenario === 'readonly' || state.scenario === 'anonymous-readonly') {
    return {fields: {}};
  }
  const editmeta = {
    fields: {
      summary: {
        name: 'Summary',
        operations: ['set'],
      },
      assignee: {
        name: 'Assignee',
        operations: ['set'],
        schema: {type: 'user'},
      },
      priority: {
        name: 'Priority',
        operations: ['set'],
        allowedValues: [
          {id: '1', name: 'Highest', iconUrl: `${state.origin}/assets/priority-highest.png`},
          {id: '2', name: 'Medium', iconUrl: `${state.origin}/assets/priority-medium.png`},
        ],
      },
      issuetype: {
        name: 'Issue Type',
        operations: ['set'],
        allowedValues: [
          {id: '1', name: 'Bug', description: 'Bug', iconUrl: `${state.origin}/assets/issuetype-bug.png`},
          {id: '2', name: 'Task', description: 'Task', iconUrl: `${state.origin}/assets/issuetype-task.png`},
        ],
      },
      parent: {
        name: 'Parent',
        operations: ['set'],
        schema: {type: 'issuelink'},
      },
      labels: {
        name: 'Labels',
        operations: ['set'],
      },
      description: {
        name: 'Description',
        operations: ['set'],
        schema: {type: 'string'},
      },
      versions: {
        name: 'Affects versions',
        operations: ['set'],
      },
      fixVersions: {
        name: 'Fix versions',
        operations: ['set'],
      },
      customfield_10020: {
        name: 'Sprint',
        operations: ['set'],
        schema: {custom: 'com.pyxis.greenhopper.jira:gh-sprint', type: 'array'},
      },
      timetracking: {
        name: 'Time Tracking',
        operations: ['set'],
        schema: {type: 'timetracking'},
      },
      customfield_67890: {
        name: 'Reviewer',
        operations: ['set'],
        schema: {type: 'user', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:userpicker'},
      },
    },
  };

  if (state.scenario === 'empty-user-field-missing-editmeta') {
    delete editmeta.fields.customfield_67890;
  }

  return editmeta;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      if (!body) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function createMockJiraServer() {
  let origin = '';
  const state = {};

  const reset = scenario => {
    const next = createState(origin);
    next.origin = origin;
    next.scenario = scenario || 'editable';
    Object.keys(state).forEach(key => {
      delete state[key];
    });
    Object.assign(state, next);
    if (state.scenario === 'anonymous-readonly') {
      state.issue.assignee = null;
      state.boards = [];
      state.sprints = state.issue.sprintEntries.map(entry => ({
        id: entry.id,
        name: entry.name,
        state: entry.state,
      }));
    }
    if (state.scenario === 'readonly') {
      state.boards = [];
    }
    if (state.scenario === 'already-assigned-to-me') {
      state.issue.assignee = {...state.currentUser};
    }
    if (state.scenario === 'in-progress-no-sprint-actions') {
      state.issue.assignee = {...state.currentUser};
      state.issue.status = {
        id: '3',
        name: 'In Progress',
        iconUrl: `${origin}/assets/status-in-progress.png`,
        statusCategory: {key: 'indeterminate', name: 'In Progress'},
      };
      state.transitions = [{
        id: '41',
        name: 'Done',
        to: {
          id: '5',
          name: 'Done',
          iconUrl: `${origin}/assets/status-done.png`,
          statusCategory: {key: 'done', name: 'Done'},
        },
      }];
      state.boards = [];
      state.sprints = state.issue.sprintEntries.map(entry => ({
        id: entry.id,
        name: entry.name,
        state: entry.state,
      }));
    }
    if (state.scenario === 'empty-optional-fields') {
      state.issue.labels = [];
      state.issue.fixVersions = [];
      state.issue.parent = null;
      state.labels = [];
      state.issueSearchCatalog = [];
    }
    if (state.scenario === 'child-issues-empty') {
      state.childIssues = [];
    }
    if (state.scenario === 'empty-user-field' || state.scenario === 'empty-user-field-missing-editmeta' || state.scenario === 'empty-user-field-empty-picker-defaults') {
      state.issue.customFields.customfield_67890 = null;
    }
    if (state.scenario === 'watcher-self-off') {
      state.issue.watchers = state.issue.watchers.filter(user => user.accountId !== state.currentUser.accountId);
    }
  };

  const scenarioIn = (...names) => names.includes(state.scenario);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const pathname = url.pathname;

    if (pathname === `/browse/${state.issue.key}` && req.method === 'GET') {
      html(res, 200, buildCloudIssuePage(state));
      return;
    }

    if (pathname === '/issues/' && req.method === 'GET') {
      html(res, 200, buildCloudIssueSearchPage(state));
      return;
    }

    if (pathname === '/jira/software/projects/JRACLOUD/boards/77' && req.method === 'GET') {
      html(res, 200, buildCloudBoardPage(state));
      return;
    }

    if (pathname === `/jira/browse/${state.issue.key}` && req.method === 'GET') {
      html(res, 200, buildDataCenterIssuePage(state));
      return;
    }

    if (pathname.startsWith('/assets/')) {
      const asset = readMockAsset(pathname.split('/').pop());
      res.writeHead(200, {
        'access-control-allow-origin': '*',
        'content-type': asset?.contentType || 'image/png',
      });
      res.end(asset?.buffer || PNG_BUFFER);
      return;
    }

    if (pathname === '/__scenario' && req.method === 'POST') {
      const body = await parseJsonBody(req).catch(() => null);
      reset(body?.scenario || 'editable');
      json(res, 200, {ok: true, scenario: state.scenario});
      return;
    }

    if (pathname === '/rest/api/2/project' && req.method === 'GET') {
      json(res, 200, [{id: '10000', key: 'JRACLOUD', name: 'Jira Cloud'}]);
      return;
    }

    if (pathname === '/rest/api/2/issueLinkType' && req.method === 'GET') {
      json(res, 200, {issueLinkTypes: ISSUE_LINK_TYPES});
      return;
    }

    if ((pathname === '/rest/api/2/issue/picker' || pathname === '/rest/api/3/issue/picker') && req.method === 'GET') {
      const query = String(url.searchParams.get('query') || '').trim().toLowerCase();
      const issues = state.issueSearchCatalog
        .filter(issue => {
          const searchText = `${issue.key} ${issue.fields.summary}`.toLowerCase();
          return query.length < 2 || searchText.includes(query);
        })
        .map(issue => ({
          id: issue.id,
          key: issue.key,
          summary: issue.fields.summary,
          label: `${issue.key} - ${issue.fields.summary}`,
          fields: issue.fields,
        }));
      json(res, 200, {sections: [{id: 'issues', label: 'Issues', issues}]});
      return;
    }

    if (pathname === '/rest/api/2/issueLink' && req.method === 'POST') {
      if (state.scenario === 'readonly' || state.scenario === 'anonymous-readonly') {
        json(res, 403, {errorMessages: ['Issue linking is not permitted']});
        return;
      }
      const body = await parseJsonBody(req);
      const type = ISSUE_LINK_TYPES.find(candidate => candidate.name === body?.type?.name);
      const currentIsOutward = body?.outwardIssue?.key === state.issue.key;
      const currentIsInward = body?.inwardIssue?.key === state.issue.key;
      const targetKey = currentIsOutward ? body?.inwardIssue?.key : body?.outwardIssue?.key;
      const targetIssue = state.issueSearchCatalog.find(issue => issue.key === targetKey);
      if (!type || (!currentIsOutward && !currentIsInward) || !targetIssue) {
        json(res, 400, {errorMessages: ['Invalid issue link']});
        return;
      }
      if (scenarioIn('linked-issues-partial-add-fails') && targetKey === 'API-204') {
        json(res, 500, {errorMessages: ['Could not create issue link']});
        return;
      }
      const issueLink = {
        id: `link-${state.issueLinkSequence++}`,
        type,
        ...(currentIsOutward
          ? {outwardIssue: {key: targetIssue.key}}
          : {inwardIssue: {key: targetIssue.key}}),
      };
      state.issue.issueLinks.push(issueLink);
      json(res, 201, issueLink);
      return;
    }

    if (/^\/rest\/api\/2\/issueLink\/[^/]+$/.test(pathname) && req.method === 'DELETE') {
      if (state.scenario === 'readonly' || state.scenario === 'anonymous-readonly') {
        json(res, 403, {errorMessages: ['Issue linking is not permitted']});
        return;
      }
      const linkId = pathname.split('/').pop();
      const originalLength = state.issue.issueLinks.length;
      state.issue.issueLinks = state.issue.issueLinks.filter(link => String(link.id) !== String(linkId));
      if (state.issue.issueLinks.length === originalLength) {
        json(res, 404, {errorMessages: ['Issue link not found']});
        return;
      }
      noContent(res);
      return;
    }

    if (pathname === '/rest/api/2/field' && req.method === 'GET') {
      const fields = [
        {id: 'customfield_10020', name: 'Sprint', schema: {custom: 'com.pyxis.greenhopper.jira:gh-sprint', type: 'array'}},
        {id: 'customfield_12345', name: 'Customer Impact'},
        {id: 'customfield_67890', name: 'Reviewer', schema: {type: 'user', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:userpicker'}},
      ];
      if (scenarioIn('epic-link-children')) {
        fields.push({
          id: 'customfield_10014',
          name: 'Epic Link',
          schema: {custom: 'com.pyxis.greenhopper.jira:gh-epic-link'},
        });
      }
      json(res, 200, fields);
      return;
    }

    if ((pathname === '/rest/api/3/issuetype' || pathname === '/rest/api/2/issuetype') && req.method === 'GET') {
      json(res, 200, [
        {id: '1', name: 'Bug', subtask: false, hierarchyLevel: 0},
        {id: '2', name: 'Task', subtask: false, hierarchyLevel: 0},
        {id: '4', name: 'Sub-task', subtask: true, hierarchyLevel: -1},
        {id: '10000', name: 'Epic', subtask: false, hierarchyLevel: 1},
      ]);
      return;
    }

    if (pathname === '/rest/api/2/myself' && req.method === 'GET') {
      if (state.scenario === 'anonymous-readonly' || state.scenario === 'logged-out' || state.scenario === 'unauthorized') {
        json(res, 401, {errorMessages: ['Not logged in']});
        return;
      }
      json(res, 200, state.currentUser);
      return;
    }

    if (pathname === '/rest/auth/1/session' && req.method === 'GET') {
      if (state.scenario === 'anonymous-readonly' || state.scenario === 'logged-out' || state.scenario === 'unauthorized') {
        json(res, 401, {errorMessages: ['Not logged in']});
        return;
      }
      json(res, 200, {user: state.currentUser});
      return;
    }

    if (pathname === `/rest/api/2/issue/${state.issue.key}` && req.method === 'GET') {
      if (state.scenario === 'unauthorized') {
        json(res, 401, {errorMessages: ['Unauthorized']});
        return;
      }
      const expand = String(url.searchParams.get('expand') || '');
      if (state.scenario === 'editable-slow-changelog' && expand.split(',').includes('changelog')) {
        await sleep(300);
      }
      json(res, 200, buildIssueResponse(origin, state, {
        includeChangelog: expand.split(',').includes('changelog'),
      }));
      return;
    }

    if (pathname === `/rest/api/2/issue/${state.issue.key}/editmeta` && req.method === 'GET') {
      json(res, 200, buildEditmeta(state));
      return;
    }

    if (pathname === `/rest/api/2/issue/${state.issue.key}/transitions` && req.method === 'GET') {
      if (state.scenario === 'readonly' || state.scenario === 'anonymous-readonly') {
        json(res, 200, {transitions: []});
        return;
      }
      json(res, 200, {transitions: state.transitions});
      return;
    }

    if (pathname === `/rest/api/2/issue/${state.issue.key}/transitions` && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const transitionId = body?.transition?.id;
      const transition = state.transitions.find(candidate => candidate.id === transitionId);
      if (!transition) {
        json(res, 400, {errorMessages: ['Unknown transition']});
        return;
      }
      state.issue.status = transition.to;
      noContent(res);
      return;
    }

    if (pathname === `/rest/api/2/issue/${state.issue.key}/assignee` && req.method === 'PUT') {
      const body = await parseJsonBody(req);
      const nextAssignee = state.assignableUsers.find(user => {
        return user.accountId === body?.accountId || user.name === body?.name || user.key === body?.key;
      }) || null;
      state.issue.assignee = nextAssignee;
      noContent(res);
      return;
    }

    if (pathname === `/rest/api/2/issue/${state.issue.key}/watchers` && req.method === 'GET') {
      json(res, 200, {
        watchCount: state.issue.watchers.length,
        isWatching: state.issue.watchers.some(user => user.accountId === state.currentUser.accountId),
        watchers: state.issue.watchers,
      });
      return;
    }

    if (pathname === `/rest/api/2/issue/${state.issue.key}/watchers` && req.method === 'POST') {
      if (scenarioIn('watchers-add-fails')) {
        json(res, 500, {errorMessages: ['Could not add watcher']});
        return;
      }
      const body = await parseJsonBody(req);
      const nextWatcher = state.assignableUsers.find(user => {
        return user.accountId === body || user.name === body || user.key === body;
      });
      if (!nextWatcher) {
        json(res, 400, {errorMessages: ['Unknown watcher']});
        return;
      }
      if (!state.issue.watchers.some(user => user.accountId === nextWatcher.accountId)) {
        state.issue.watchers.push(nextWatcher);
      }
      noContent(res);
      return;
    }

    if (pathname === `/rest/api/2/issue/${state.issue.key}/watchers` && req.method === 'DELETE') {
      if (scenarioIn('watchers-remove-fails')) {
        json(res, 500, {errorMessages: ['Could not remove watcher']});
        return;
      }
      const accountId = String(url.searchParams.get('accountId') || '');
      const username = String(url.searchParams.get('username') || '');
      const key = String(url.searchParams.get('key') || '');
      state.issue.watchers = state.issue.watchers.filter(user => {
        return user.accountId !== accountId && user.name !== username && user.key !== key;
      });
      noContent(res);
      return;
    }

    if (pathname === '/rest/internal/2/reactions/view' && req.method === 'POST') {
      if (scenarioIn('reaction-unsupported')) {
        json(res, 404, {errorMessages: ['Reactions are not available']});
        return;
      }
      const body = await parseJsonBody(req);
      const requestedIds = new Set((body?.commentIds || []).map(String));
      const entries = [];
      Object.entries(state.reactions).forEach(([commentId, byEmojiId]) => {
        if (!requestedIds.has(String(commentId))) return;
        Object.entries(byEmojiId || {}).forEach(([emojiId, entry]) => {
          entries.push({commentId, emojiId, count: entry.count, reacted: entry.reacted});
        });
      });
      json(res, 200, entries);
      return;
    }

    if (pathname === '/rest/internal/2/reactions' && req.method === 'POST') {
      if (scenarioIn('reaction-unsupported')) {
        json(res, 404, {errorMessages: ['Reactions are not available']});
        return;
      }
      if (scenarioIn('reaction-update-fails')) {
        json(res, 500, {errorMessages: ['Could not update reaction']});
        return;
      }
      const body = await parseJsonBody(req);
      const commentId = String(body?.commentId || '');
      const emojiId = String(body?.emojiId || '');
      state.reactions[commentId] = state.reactions[commentId] || {};
      const current = state.reactions[commentId][emojiId] || {count: 0, reacted: false};
      state.reactions[commentId][emojiId] = {
        count: current.reacted ? current.count : current.count + 1,
        reacted: true,
      };
      json(res, 200, state.reactions[commentId][emojiId]);
      return;
    }

    if (pathname === '/rest/internal/2/reactions' && req.method === 'DELETE') {
      if (scenarioIn('reaction-update-fails')) {
        json(res, 500, {errorMessages: ['Could not update reaction']});
        return;
      }
      const commentId = String(url.searchParams.get('commentId') || '');
      const emojiId = String(url.searchParams.get('emojiId') || '');
      const current = state.reactions[commentId]?.[emojiId] || {count: 0, reacted: false};
      state.reactions[commentId] = state.reactions[commentId] || {};
      state.reactions[commentId][emojiId] = {
        count: current.reacted ? Math.max(0, current.count - 1) : current.count,
        reacted: false,
      };
      noContent(res);
      return;
    }

    if (pathname === `/rest/api/2/issue/${state.issue.key}/comment` && req.method === 'POST') {
      if (state.scenario === 'anonymous-readonly' || state.scenario === 'logged-out') {
        json(res, 401, {errorMessages: ['Login required']});
        return;
      }
      if (scenarioIn('comment-save-fails')) {
        json(res, 500, {errorMessages: ['Could not save comment']});
        return;
      }
      const body = await parseJsonBody(req);
      const newComment = {
        id: `comment-${Date.now()}`,
        author: {...state.currentUser},
        created: new Date().toISOString(),
        body: body?.body || '',
        renderedBody: buildRenderedCommentBody(body?.body || ''),
      };
      state.issue.comments.push(newComment);
      json(res, 201, newComment);
      return;
    }

    if (pathname.startsWith(`/rest/api/2/issue/${state.issue.key}/comment/`) && req.method === 'PUT') {
      if (state.scenario === 'anonymous-readonly' || state.scenario === 'logged-out') {
        json(res, 401, {errorMessages: ['Login required']});
        return;
      }
      const commentId = pathname.split('/').pop();
      const comment = state.issue.comments.find(entry => String(entry.id || '') === String(commentId || ''));
      if (!comment) {
        json(res, 404, {errorMessages: ['Comment not found']});
        return;
      }
      const body = await parseJsonBody(req);
      comment.body = String(body?.body || '');
      comment.renderedBody = buildRenderedCommentBody(comment.body);
      json(res, 200, {id: comment.id});
      return;
    }

    if (pathname.startsWith(`/rest/api/2/issue/${state.issue.key}/comment/`) && req.method === 'DELETE') {
      if (state.scenario === 'anonymous-readonly' || state.scenario === 'logged-out') {
        json(res, 401, {errorMessages: ['Login required']});
        return;
      }
      const commentId = pathname.split('/').pop();
      const commentIndex = state.issue.comments.findIndex(entry => String(entry.id || '') === String(commentId || ''));
      if (commentIndex === -1) {
        json(res, 404, {errorMessages: ['Comment not found']});
        return;
      }
      state.issue.comments.splice(commentIndex, 1);
      noContent(res);
      return;
    }

    if (pathname === `/rest/api/2/issue/${state.issue.key}/attachments` && req.method === 'POST') {
      if (state.scenario === 'anonymous-readonly' || state.scenario === 'logged-out') {
        json(res, 401, {errorMessages: ['Login required']});
        return;
      }
      if (scenarioIn('attachment-upload-fails')) {
        json(res, 500, {errorMessages: ['Could not upload pasted image']});
        return;
      }
      const fileNameHeader = String(req.headers['x-atlassian-token-filename'] || '').trim();
      const requestBody = await new Promise(resolve => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
      });
      const multipartFileNameMatch = requestBody.match(/filename="([^"]+)"/i);
      const uploadedFileName = multipartFileNameMatch?.[1] || fileNameHeader || 'pasted-image.png';
      const attachmentId = `attachment-${Date.now()}`;
      const attachment = {
        id: attachmentId,
        filename: uploadedFileName,
        mimeType: 'image/png',
        content: buildAttachmentContentUrl(origin, attachmentId),
        thumbnail: buildAttachmentThumbnailUrl(origin, attachmentId),
      };
      state.uploadedAttachments.push(attachment);
      state.issue.changelog.histories.unshift({
        id: `history-upload-${Date.now()}`,
        created: new Date().toISOString(),
        author: {
          displayName: state.currentUser.displayName,
          accountId: state.currentUser.accountId,
        },
        items: [
          {
            field: 'Attachment',
            fieldId: 'attachment',
            fromString: '',
            toString: uploadedFileName,
          },
        ],
      });
      json(res, 200, [attachment]);
      return;
    }

    if (/^\/rest\/api\/2\/attachment\/(?:content|thumbnail)\/[^/]+$/.test(pathname) && req.method === 'GET') {
      const attachmentId = pathname.split('/').pop();
      const attachment = state.issue.attachments.concat(state.uploadedAttachments).find(candidate => {
        return String(candidate.id || '') === String(attachmentId || '');
      });
      if (!attachment) {
        json(res, 404, {errorMessages: ['Attachment not found']});
        return;
      }
      res.writeHead(200, {
        'access-control-allow-origin': '*',
        'content-type': attachment.mimeType || 'image/png',
      });
      const asset = readMockAsset(ATTACHMENT_FIXTURE_BY_ID[String(attachmentId || '')] || attachment.filename);
      res.end(asset?.buffer || PNG_BUFFER);
      return;
    }

    if (pathname.startsWith('/rest/api/2/attachment/') && req.method === 'DELETE') {
      const attachmentId = pathname.split('/').pop();
      state.uploadedAttachments = state.uploadedAttachments.filter(attachment => attachment.id !== attachmentId);
      noContent(res);
      return;
    }

    if (pathname === `/rest/api/2/issue/${state.issue.key}` && req.method === 'PUT') {
      const body = await parseJsonBody(req);
      const fields = body?.fields || {};
      if (Object.prototype.hasOwnProperty.call(fields, 'summary')) {
        const nextSummary = String(fields.summary || '').trim();
        if (!nextSummary) {
          json(res, 400, {errors: {summary: 'Summary is required'}});
          return;
        }
        state.issue.summary = nextSummary;
      }
      if (Object.prototype.hasOwnProperty.call(fields, 'description')) {
        const previousDescription = descriptionFieldToEditorText(state.issue.description);
        state.issue.description = fields.description == null
          ? ''
          : fields.description;
        state.issue.changelog.histories.unshift({
          id: `history-description-${Date.now()}`,
          created: new Date().toISOString(),
          author: {
            displayName: state.currentUser.displayName,
            accountId: state.currentUser.accountId,
          },
          items: [
            {
              field: 'Description',
              fieldId: 'description',
              fromString: previousDescription,
              toString: descriptionFieldToEditorText(state.issue.description),
            },
          ],
        });
      }
      if (fields.priority?.id) {
        state.issue.priority = {
          id: String(fields.priority.id),
          name: fields.priority.id === '1' ? 'Highest' : 'Medium',
          iconUrl: fields.priority.id === '1' ? `${origin}/assets/priority-highest.png` : `${origin}/assets/priority-medium.png`,
        };
      }
      if (fields.issuetype?.id) {
        state.issue.issuetype = {
          id: String(fields.issuetype.id),
          name: fields.issuetype.id === '2' ? 'Task' : 'Bug',
          description: fields.issuetype.id === '2' ? 'Task' : 'Bug',
          iconUrl: fields.issuetype.id === '2' ? `${origin}/assets/issuetype-task.png` : `${origin}/assets/issuetype-bug.png`,
        };
      }
      if (Array.isArray(fields.labels)) {
        state.issue.labels = fields.labels;
      }
      if (Object.prototype.hasOwnProperty.call(fields, 'customfield_10020')) {
        const sprintId = Number(fields.customfield_10020);
        state.issue.sprintEntries = sprintId
          ? state.sprints.filter(sprint => sprint.id === sprintId).map(sprint => ({...sprint, boardId: 77}))
          : [];
      }
      if (Array.isArray(fields.versions)) {
        state.issue.versions = fields.versions.map(entry => ({id: String(entry.id), name: entry.id === '302' ? '2026.05' : '2026.03'}));
      }
      if (Array.isArray(fields.fixVersions)) {
        state.issue.fixVersions = fields.fixVersions.map(entry => ({id: String(entry.id), name: entry.id === '402' ? '2026.06' : '2026.04'}));
      }
      if (fields.parent?.key) {
        const match = state.issueSearchCatalog.find(issue => issue.key === fields.parent.key);
        state.issue.parent = match
          ? {key: match.key, fields: {summary: match.fields.summary}}
          : {key: fields.parent.key, fields: {summary: fields.parent.key}};
      }
      if (Object.prototype.hasOwnProperty.call(fields, 'customfield_67890')) {
        if (fields.customfield_67890 === null) {
          state.issue.customFields.customfield_67890 = null;
        } else {
          const userId = fields.customfield_67890?.accountId || fields.customfield_67890?.name || fields.customfield_67890?.key;
          state.issue.customFields.customfield_67890 = state.assignableUsers.find(u => u.accountId === userId || u.name === userId || u.key === userId) || null;
        }
      }
      if (Object.prototype.hasOwnProperty.call(fields, 'customfield_12345')) {
        state.issue.customFields.customfield_12345 = fields.customfield_12345 === null
          ? null
          : String(fields.customfield_12345);
      }
      if (fields.timetracking) {
        const tt = fields.timetracking;
        state.issue.timetracking = {
          originalEstimate: tt.originalEstimate != null ? tt.originalEstimate : state.issue.timetracking.originalEstimate,
          remainingEstimate: tt.remainingEstimate != null ? tt.remainingEstimate : state.issue.timetracking.remainingEstimate,
          timeSpent: tt.timeSpent != null ? tt.timeSpent : state.issue.timetracking.timeSpent,
        };
      }
      noContent(res);
      return;
    }

    if ((pathname === '/rest/api/2/user/assignable/search' || pathname === '/rest/api/2/user/search') && req.method === 'GET') {
      if (pathname === '/rest/api/2/user/search' && scenarioIn('mention-search-fails')) {
        json(res, 500, {errorMessages: ['Could not load people']});
        return;
      }
      const query = String(url.searchParams.get('query') || url.searchParams.get('username') || '').toLowerCase();
      const users = state.assignableUsers.filter(user => !query || user.displayName.toLowerCase().includes(query) || user.name.toLowerCase().includes(query));
      json(res, 200, users);
      return;
    }

    if (pathname === '/rest/internal/2/users/assignee' && req.method === 'GET') {
      const query = String(url.searchParams.get('query') || '').toLowerCase();
      const users = state.assignableUsers
        .filter(user => !query || user.displayName.toLowerCase().includes(query) || user.name.toLowerCase().includes(query))
        .map(user => ({
          accountId: user.accountId,
          name: user.name,
          key: user.key,
          displayName: user.displayName,
          emailAddress: user.emailAddress || '',
          avatarUrl: user.avatarUrls?.['48x48'] || '',
        }));
      json(res, 200, users);
      return;
    }

    if (pathname === '/rest/api/2/user/picker' && req.method === 'GET') {
      if (scenarioIn('mention-search-fails')) {
        json(res, 500, {errorMessages: ['Could not load people']});
        return;
      }
      const query = String(url.searchParams.get('query') || '').toLowerCase();
      if (state.scenario === 'empty-user-field-empty-picker-defaults' && !query) {
        json(res, 200, {users: []});
        return;
      }
      const users = state.assignableUsers.filter(user => !query || user.displayName.toLowerCase().includes(query) || user.name.toLowerCase().includes(query));
      json(res, 200, {users});
      return;
    }

    if (pathname === '/rest/api/2/jql/autocompletedata/suggestions' && req.method === 'GET') {
      if (scenarioIn('label-search-fails')) {
        json(res, 500, {errorMessages: ['Could not load labels']});
        return;
      }
      const query = String(url.searchParams.get('fieldValue') || '').toLowerCase();
      const labels = state.labels.filter(label => !query || label.toLowerCase().includes(query));
      json(res, 200, labels);
      return;
    }

    if ((pathname === '/rest/api/2/search' || pathname === '/rest/api/3/search/jql' || pathname === '/rest/api/latest/search') && req.method === 'GET') {
      if (scenarioIn('issue-search-fails')) {
        json(res, 500, {errorMessages: ['Could not search issues']});
        return;
      }
      const jql = String(url.searchParams.get('jql') || '');
      const isChildSearch = /\bparent\s*=/.test(jql) || /cf\[\d+\]\s*=/.test(jql);
      if (isChildSearch && scenarioIn('child-issues-fail')) {
        json(res, 500, {errorMessages: ['Could not load child issues']});
        return;
      }
      let issues = isChildSearch ? state.childIssues : state.issueSearchCatalog;
      if (isChildSearch && scenarioIn('epic-link-children') && /\bparent\s*=/.test(jql)) {
        issues = [];
      }
      if (!isChildSearch) {
        const projectEquals = jql.match(/\bproject\s*=\s*"?([A-Z][A-Z0-9_]*)"?/i);
        const projectNotEquals = jql.match(/\bproject\s*!=\s*"?([A-Z][A-Z0-9_]*)"?/i);
        if (projectEquals) {
          issues = issues.filter(issue => String(issue?.fields?.project?.key || issue?.key || '').split('-')[0] === projectEquals[1]);
        } else if (projectNotEquals) {
          issues = issues.filter(issue => String(issue?.fields?.project?.key || issue?.key || '').split('-')[0] !== projectNotEquals[1]);
        }
        if (/\bissuetype\s*=\s*Epic\b/i.test(jql)) {
          issues = issues.filter(issue => String(issue?.fields?.issuetype?.name || '').toLowerCase() === 'epic');
        }
        const issueTypeIds = jql.match(/\bissuetype\s+in\s*\(([^)]+)\)/i)?.[1]
          ?.split(',')
          .map(value => value.trim().replace(/^"|"$/g, ''))
          .filter(value => /^\d+$/.test(value));
        if (issueTypeIds?.length) {
          issues = issues.filter(issue => issueTypeIds.includes(String(issue?.fields?.issuetype?.id || '')));
        }
      }
      json(res, 200, {issues});
      return;
    }

    if (pathname === '/rest/api/2/project/JRACLOUD/versions' && req.method === 'GET') {
      json(res, 200, [
        {id: '301', name: '2026.03'},
        {id: '302', name: '2026.05'},
        {id: '401', name: '2026.04'},
        {id: '402', name: '2026.06'},
      ]);
      return;
    }

    if (pathname === '/rest/agile/1.0/board' && req.method === 'GET') {
      json(res, 200, {values: state.boards});
      return;
    }

    if (pathname === '/rest/agile/1.0/board/77/sprint' && req.method === 'GET') {
      json(res, 200, {values: state.sprints});
      return;
    }

    if (pathname === '/rest/dev-status/1.0/issue/detail' && req.method === 'GET') {
      if (scenarioIn('pr-data-fails')) {
        json(res, 500, {errorMessages: ['Dev status unavailable']});
        return;
      }
      if (scenarioIn('pr-data-malformed')) {
        json(res, 200, {detail: [{pullRequests: [{id: 'pr-1'}]}]});
        return;
      }
      json(res, 200, {
        detail: [{
          pullRequests: [{
            id: 'pr-1',
            url: 'https://github.com/dgebaei/Jira-QuickView/pull/1',
            name: 'Fix slash command cursor behavior',
            author: {
              name: 'Morgan Agent',
              avatarUrl: `${origin}/assets/avatar-me.png`,
            },
            source: {branch: 'fix/slash-command-end-key'},
            status: 'OPEN',
          }, {
            id: 'pr-2',
            url: 'https://github.com/dgebaei/Jira-QuickView/pull/2',
            name: 'Add inline custom field editing',
            author: {
              name: 'Alex Reviewer',
              avatarUrl: `${origin}/assets/avatar-alex.png`,
            },
            source: {branch: 'feat/custom-field-inline-editing'},
            status: 'MERGED',
          }, {
            id: 'pr-3',
            url: 'https://github.com/dgebaei/Jira-QuickView/pull/3',
            name: 'Prototype release evidence gallery',
            author: {
              name: 'Casey Commenter',
              avatarUrl: `${origin}/assets/avatar-commenter.png`,
            },
            source: {branch: 'spike/release-evidence-gallery'},
            status: 'DECLINED',
          }],
        }],
      });
      return;
    }

    if (pathname === '/rest/dev-status/1.0/issue/summary' && req.method === 'GET') {
      if (scenarioIn('pr-data-fails')) {
        json(res, 500, {errorMessages: ['Dev status unavailable']});
        return;
      }
      if (scenarioIn('pr-data-malformed')) {
        json(res, 200, {summary: []});
        return;
      }
      json(res, 200, {summary: [{pullrequest: {overall: {count: 3}}}]});
      return;
    }

    text(res, 404, `Unhandled ${req.method} ${pathname}`);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
  reset('editable');

  return {
    origin,
    setScenario: async scenario => {
      reset(scenario);
    },
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

module.exports = {
  createMockJiraServer,
};
