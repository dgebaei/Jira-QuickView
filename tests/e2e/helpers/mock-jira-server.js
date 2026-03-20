const http = require('http');

const PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64'
);

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

function noContent(res) {
  res.writeHead(204, {'access-control-allow-origin': '*'});
  res.end();
}

function issueDescriptionHtml(origin) {
  return `
    <p>The mock issue exercises rich rendering, quick actions, and edit flows.</p>
    <p><a href="${origin}/browse/JRACLOUD-97846">Open issue</a></p>
    <p><img src="${origin}/assets/inline-image.png" alt="inline evidence" /></p>
  `;
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
    ],
    labels: ['needs-triage', 'ux-bug', 'release-candidate'],
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
          content: `${origin}/assets/evidence.png`,
          thumbnail: `${origin}/assets/evidence.png`,
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
      ],
      timetracking: {
        originalEstimate: '1w',
        remainingEstimate: '1d',
        timeSpent: '2h',
      },
      customFields: {
        customfield_12345: 'Customer impact: High',
      },
    },
    issueSearchCatalog: [
      {
        id: '10002',
        key: 'JRACLOUD-97000',
        fields: {
          summary: 'Editor backlog umbrella',
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
        },
      },
      {
        id: '10003',
        key: 'JRACLOUD-98123',
        fields: {
          summary: 'Improve slash command cursor stability',
          issuetype: {
            id: '1',
            name: 'Bug',
            iconUrl: `${origin}/assets/issuetype-bug.png`,
          },
          status: {
            id: '10000',
            name: 'To Do',
            iconUrl: `${origin}/assets/status-todo.png`,
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
  };
}

function buildIssueResponse(origin, state) {
  const issue = state.issue;
  const names = {
    customfield_10020: 'Sprint',
    customfield_12345: 'Customer Impact',
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
    timetracking: issue.timetracking,
  };
  return {
    id: issue.id,
    key: issue.key,
    fields,
    names,
    renderedFields: {
      description: issueDescriptionHtml(origin),
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
  return {
    fields: {
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
    },
  };
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
  };

  const scenarioIn = (...names) => names.includes(state.scenario);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const pathname = url.pathname;

    if (pathname.startsWith('/assets/')) {
      res.writeHead(200, {
        'access-control-allow-origin': '*',
        'content-type': 'image/png',
      });
      res.end(PNG_BUFFER);
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

    if (pathname === '/rest/api/2/field' && req.method === 'GET') {
      json(res, 200, [
        {id: 'customfield_10020', name: 'Sprint', schema: {custom: 'com.pyxis.greenhopper.jira:gh-sprint', type: 'array'}},
        {id: 'customfield_12345', name: 'Customer Impact'},
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
      json(res, 200, buildIssueResponse(origin, state));
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
        author: {displayName: state.currentUser.displayName},
        created: new Date().toISOString(),
        body: body?.body || '',
        renderedBody: `<p>${String(body?.body || '').replace(/\n/g, '<br/>')}</p>`,
      };
      state.issue.comments.push(newComment);
      json(res, 201, {id: newComment.id});
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
      const attachment = {
        id: `attachment-${Date.now()}`,
        filename: 'pasted-image.png',
        mimeType: 'image/png',
        content: `${origin}/assets/uploaded-image.png`,
        thumbnail: `${origin}/assets/uploaded-image.png`,
      };
      state.uploadedAttachments.push(attachment);
      json(res, 200, [attachment]);
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

    if (pathname === '/rest/api/2/user/assignable/search' && req.method === 'GET') {
      const query = String(url.searchParams.get('query') || url.searchParams.get('username') || '').toLowerCase();
      const users = state.assignableUsers.filter(user => !query || user.displayName.toLowerCase().includes(query) || user.name.toLowerCase().includes(query));
      json(res, 200, users);
      return;
    }

    if (pathname === '/rest/api/2/user/picker' && req.method === 'GET') {
      if (scenarioIn('mention-search-fails')) {
        json(res, 500, {errorMessages: ['Could not load people']});
        return;
      }
      const query = String(url.searchParams.get('query') || '').toLowerCase();
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

    if (pathname === '/rest/api/2/search' && req.method === 'GET') {
      if (scenarioIn('issue-search-fails')) {
        json(res, 500, {errorMessages: ['Could not search issues']});
        return;
      }
      json(res, 200, {issues: state.issueSearchCatalog});
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
            url: 'https://github.com/dgebaei/Jira-Hot-Linker/pull/1',
            name: 'Fix slash command cursor behavior',
            author: {name: 'Morgan Agent'},
            source: {branch: 'fix/slash-command-end-key'},
            status: 'OPEN',
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
      json(res, 200, {summary: [{pullrequest: {overall: {count: 1}}}]});
      return;
    }

    text(res, 404, `Unhandled ${req.method} ${pathname}`);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}/`;
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
