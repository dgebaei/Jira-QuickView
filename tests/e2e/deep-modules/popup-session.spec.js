const path = require('path');
const {test, expect} = require('@playwright/test');

const harnessPath = path.resolve(__dirname, '../../output/playwright/deep-modules/harness.js');

test.beforeEach(async ({page}) => {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({path: harnessPath});
});

test('a reversed older issue load cannot attach features or replace the newer popup session', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createDeferred, createFixturePopupSurface, createPopupSession} = window.JiraQuickViewDeepModules;
    const oldIssue = createDeferred();
    const newIssue = createDeferred();
    const requests = [];
    const featureCalls = [];
    const issueData = {
      openIssue(request) {
        requests.push({issueKey: request.issueKey, aborted: () => request.signal.aborted});
        return request.issueKey === 'OLD-1' ? oldIssue.promise : newIssue.promise;
      },
    };
    const fieldEditing = {
      attach(request) { featureCalls.push({feature: 'fields', operation: 'attach', issueKey: request.issueSnapshot.issueKey}); },
      detach(request) { featureCalls.push({feature: 'fields', operation: 'detach', sessionId: request.sessionId}); },
      view() { return {edit: null}; },
    };
    const comments = {
      async attach(request) { featureCalls.push({feature: 'comments', operation: 'attach', issueKey: request.issueSnapshot.issueKey}); },
      async detach(request) { featureCalls.push({feature: 'comments', operation: 'detach', sessionId: request.sessionId}); },
      view() { return {comments: [], protectFromAutoHide: false}; },
    };
    const surface = createFixturePopupSurface();
    const popup = createPopupSession({issueData, fieldEditing, comments, surface});
    const oldActivation = popup.activate({issueKey: 'OLD-1', anchor: {x: 10, y: 20}, activation: 'hover'});
    while (requests.length < 1) await Promise.resolve();
    const newActivation = popup.activate({issueKey: 'NEW-2', anchor: {x: 30, y: 40}, activation: 'modifier'});
    while (requests.length < 2) await Promise.resolve();
    newIssue.resolve({
      kind: 'loaded',
      snapshot: {issueKey: 'NEW-2', core: {key: 'NEW-2', fields: {}}, sections: {}},
      failures: {},
    });
    const newOutcome = await newActivation;
    oldIssue.resolve({
      kind: 'loaded',
      snapshot: {issueKey: 'OLD-1', core: {key: 'OLD-1', fields: {}}, sections: {}},
      failures: {},
    });
    const oldOutcome = await oldActivation;
    return {
      oldOutcome: oldOutcome.kind,
      newOutcome: newOutcome.kind,
      oldAborted: requests[0].aborted(),
      featureCalls,
      frames: surface.getFrames().map(frame => ({kind: frame.kind, issueKey: frame.issueKey})),
      view: popup.view(),
    };
  });

  expect(result).toEqual({
    oldOutcome: 'ignored',
    newOutcome: 'visible',
    oldAborted: true,
    featureCalls: [
      {feature: 'fields', operation: 'detach', sessionId: 'popup-1'},
      {feature: 'comments', operation: 'detach', sessionId: 'popup-1'},
      {feature: 'fields', operation: 'attach', issueKey: 'NEW-2'},
      {feature: 'comments', operation: 'attach', issueKey: 'NEW-2'},
    ],
    frames: [
      {kind: 'loading', issueKey: 'OLD-1'},
      {kind: 'loading', issueKey: 'NEW-2'},
      {kind: 'visible', issueKey: 'NEW-2'},
    ],
    view: {status: 'visible', sessionId: 'popup-2', issueKey: 'NEW-2', stateRevision: 3},
  });
});

test('a slow surface projection cannot commit after a newer popup session starts', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createDeferred, createFixturePopupSurface, createPopupSession} = window.JiraQuickViewDeepModules;
    const oldRender = createDeferred();
    let oldRenderStarted = false;
    const surface = createFixturePopupSurface({
      async beforeRender(frame) {
        if (frame.kind === 'visible' && frame.issueKey === 'OLD-1') {
          oldRenderStarted = true;
          await oldRender.promise;
        }
      },
    });
    const popup = createPopupSession({
      issueData: {async openIssue(request) {
        return {
          kind: 'loaded',
          snapshot: {issueKey: request.issueKey, core: {key: request.issueKey, fields: {}}, sections: {}},
          failures: {},
        };
      }},
      fieldEditing: {attach() {}, detach() {}, view() { return {}; }},
      comments: {async attach() {}, async detach() {}, view() { return {}; }},
      surface,
    });
    const oldActivation = popup.activate({issueKey: 'OLD-1'});
    while (!oldRenderStarted) await Promise.resolve();
    const newOutcome = await popup.activate({issueKey: 'NEW-2'});
    oldRender.resolve();
    const oldOutcome = await oldActivation;
    return {
      oldOutcome: oldOutcome.kind,
      newOutcome: newOutcome.kind,
      frames: surface.getFrames().map(frame => ({kind: frame.kind, issueKey: frame.issueKey})),
      view: popup.view(),
    };
  });

  expect(result).toEqual({
    oldOutcome: 'ignored',
    newOutcome: 'visible',
    frames: [
      {kind: 'loading', issueKey: 'OLD-1'},
      {kind: 'loading', issueKey: 'NEW-2'},
      {kind: 'visible', issueKey: 'NEW-2'},
    ],
    view: {status: 'visible', sessionId: 'popup-2', issueKey: 'NEW-2', stateRevision: 4},
  });
});

test('close while loading aborts acquisition and prevents a late popup commit', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createDeferred, createFixturePopupSurface, createPopupSession} = window.JiraQuickViewDeepModules;
    const issue = createDeferred();
    let signal;
    const surface = createFixturePopupSurface();
    const popup = createPopupSession({
      issueData: {openIssue(request) { signal = request.signal; return issue.promise; }},
      fieldEditing: {attach() {}, detach() {}, view() { return {}; }},
      comments: {async attach() {}, async detach() {}, view() { return {}; }},
      surface,
    });
    const activation = popup.activate({issueKey: 'ABC-1'});
    while (!signal) await Promise.resolve();
    const closed = await popup.close({reason: 'explicit'});
    issue.resolve({kind: 'loaded', snapshot: {issueKey: 'ABC-1', core: {key: 'ABC-1', fields: {}}, sections: {}}});
    const late = await activation;
    return {
      aborted: signal.aborted,
      closed: closed.kind,
      late: late.kind,
      frames: surface.getFrames().map(frame => frame.kind),
      hides: surface.getHides(),
      view: popup.view(),
    };
  });

  expect(result).toEqual({
    aborted: true,
    closed: 'hidden',
    late: 'ignored',
    frames: ['loading'],
    hides: [{reason: 'explicit', sessionId: 'popup-1'}],
    view: {status: 'hidden', sessionId: '', issueKey: '', stateRevision: 2},
  });
});

test('a core failure is observable and the same issue can retry in a fresh session', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createFixturePopupSurface, createPopupSession} = window.JiraQuickViewDeepModules;
    let attempts = 0;
    const surface = createFixturePopupSurface();
    const popup = createPopupSession({
      issueData: {async openIssue(request) {
        attempts += 1;
        if (attempts === 1) return {kind: 'failed', snapshot: null, failures: {core: {message: 'Jira unavailable'}}};
        return {kind: 'loaded', snapshot: {issueKey: request.issueKey, core: {key: request.issueKey, fields: {}}, sections: {}}, failures: {}};
      }},
      fieldEditing: {attach() {}, detach() {}, view() { return {edit: null}; }},
      comments: {async attach() {}, async detach() {}, view() { return {comments: []}; }},
      surface,
    });
    const failed = await popup.activate({issueKey: 'ABC-1'});
    const retried = await popup.activate({issueKey: 'ABC-1'});
    return {
      failed: {kind: failed.kind, failure: failed.failure},
      retried: retried.kind,
      frames: surface.getFrames().map(frame => ({kind: frame.kind, issueKey: frame.issueKey, message: frame.failure?.message || ''})),
      view: popup.view(),
    };
  });

  expect(result).toEqual({
    failed: {kind: 'error', failure: {message: 'Jira unavailable'}},
    retried: 'visible',
    frames: [
      {kind: 'loading', issueKey: 'ABC-1', message: ''},
      {kind: 'error', issueKey: 'ABC-1', message: 'Jira unavailable'},
      {kind: 'loading', issueKey: 'ABC-1', message: ''},
      {kind: 'visible', issueKey: 'ABC-1', message: ''},
    ],
    view: {status: 'visible', sessionId: 'popup-2', issueKey: 'ABC-1', stateRevision: 4},
  });
});

test('feature rerenders advance the session revision and publish current feature views', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createFixturePopupSurface, createPopupSession} = window.JiraQuickViewDeepModules;
    let fieldValue = 'idle';
    let commentValue = 'draft-one';
    const surface = createFixturePopupSurface();
    const popup = createPopupSession({
      issueData: {async openIssue(request) {
        return {
          kind: 'loaded',
          snapshot: {issueKey: request.issueKey, core: {key: request.issueKey, fields: {}}, sections: {}},
          failures: {},
        };
      }},
      fieldEditing: {attach() {}, detach() {}, view() { return {value: fieldValue}; }},
      comments: {async attach() {}, async detach() {}, view() { return {value: commentValue}; }},
      surface,
    });
    await popup.activate({issueKey: 'ABC-1'});
    fieldValue = 'editing';
    commentValue = 'draft-two';
    const rendered = await popup.dispatch({type: 'render', reason: 'feature-changed'});
    return {
      rendered: rendered.kind,
      frames: surface.getFrames().map(frame => ({
        kind: frame.kind,
        reason: frame.reason || '',
        fieldValue: frame.fieldEditing.value,
        commentValue: frame.comments.value,
      })),
      view: popup.view(),
    };
  });

  expect(result).toEqual({
    rendered: 'rendered',
    frames: [
      {kind: 'loading', reason: '', fieldValue: 'idle', commentValue: 'draft-one'},
      {kind: 'visible', reason: '', fieldValue: 'idle', commentValue: 'draft-one'},
      {kind: 'update', reason: 'feature-changed', fieldValue: 'editing', commentValue: 'draft-two'},
    ],
    view: {status: 'visible', sessionId: 'popup-1', issueKey: 'ABC-1', stateRevision: 3},
  });
});

test('synchronous feature rerenders coalesce into one current surface commit', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createFixturePopupSurface, createPopupSession} = window.JiraQuickViewDeepModules;
    let featureRevision = 0;
    const surface = createFixturePopupSurface();
    const popup = createPopupSession({
      issueData: {async openIssue(request) {
        return {
          kind: 'loaded',
          snapshot: {issueKey: request.issueKey, core: {key: request.issueKey, fields: {}}, sections: {}},
          failures: {},
        };
      }},
      fieldEditing: {attach() {}, detach() {}, view() { return {revision: featureRevision}; }},
      comments: {async attach() {}, async detach() {}, view() { return {}; }},
      surface,
    });
    await popup.activate({issueKey: 'ABC-1'});
    const pending = [];
    for (let index = 1; index <= 10; index += 1) {
      featureRevision = index;
      pending.push(popup.dispatch({type: 'render', reason: `feature-${index}`}));
    }
    const outcomes = await Promise.all(pending);
    return {
      outcomes: [...new Set(outcomes.map(item => item.kind))],
      updates: surface.getFrames().filter(frame => frame.kind === 'update').map(frame => ({
        reason: frame.reason,
        featureRevision: frame.fieldEditing.revision,
      })),
      view: popup.view(),
    };
  });

  expect(result).toEqual({
    outcomes: ['rendered'],
    updates: [{reason: 'feature-10', featureRevision: 10}],
    view: {status: 'visible', sessionId: 'popup-1', issueKey: 'ABC-1', stateRevision: 3},
  });
});

test('popup session owns sorting transitions and publishes their observable presentation', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createFixturePopupSurface, createPopupSession} = window.JiraQuickViewDeepModules;
    const surface = createFixturePopupSurface();
    const popup = createPopupSession({
      issueData: {async openIssue(request) {
        return {
          kind: 'loaded',
          snapshot: {issueKey: request.issueKey, core: {key: request.issueKey, fields: {}}, sections: {}},
          failures: {},
        };
      }},
      fieldEditing: {attach() {}, detach() {}, view() { return {}; }},
      comments: {async attach() {}, async detach() {}, view() { return {}; }},
      surface,
    });
    await popup.activate({
      issueKey: 'ABC-1',
      preferences: {commentSortOrder: 'oldest'},
    });
    const children = await popup.dispatch({type: 'sort-children', column: 'status'});
    const childrenReversed = await popup.dispatch({type: 'sort-children', column: 'status'});
    const pullRequests = await popup.dispatch({type: 'sort-pull-requests', column: 'status'});
    const comments = await popup.dispatch({type: 'toggle-comment-sort'});
    const sorting = presentation => ({
      childrenSort: presentation.childrenSort,
      pullRequestsSort: presentation.pullRequestsSort,
      commentSortOrder: presentation.commentSortOrder,
    });
    return {
      outcomes: {
        children: sorting(children.presentation),
        childrenReversed: sorting(childrenReversed.presentation),
        pullRequests: sorting(pullRequests.presentation),
        comments: sorting(comments.presentation),
      },
      frames: surface.getFrames().filter(frame => frame.kind !== 'loading').map(frame => ({
        kind: frame.kind,
        reason: frame.reason || '',
        presentation: sorting(frame.presentation),
      })),
    };
  });

  expect(result).toEqual({
    outcomes: {
      children: {
        childrenSort: {column: 'status', direction: 'asc'},
        pullRequestsSort: {column: 'title', direction: 'asc'},
        commentSortOrder: 'oldest',
      },
      childrenReversed: {
        childrenSort: {column: 'status', direction: 'desc'},
        pullRequestsSort: {column: 'title', direction: 'asc'},
        commentSortOrder: 'oldest',
      },
      pullRequests: {
        childrenSort: {column: 'status', direction: 'desc'},
        pullRequestsSort: {column: 'status', direction: 'asc'},
        commentSortOrder: 'oldest',
      },
      comments: {
        childrenSort: {column: 'status', direction: 'desc'},
        pullRequestsSort: {column: 'status', direction: 'asc'},
        commentSortOrder: 'newest',
      },
    },
    frames: [
      {
        kind: 'visible',
        reason: '',
        presentation: {
          childrenSort: {column: 'key', direction: 'asc'},
          pullRequestsSort: {column: 'title', direction: 'asc'},
          commentSortOrder: 'oldest',
        },
      },
      {
        kind: 'update',
        reason: 'children-sort-changed',
        presentation: {
          childrenSort: {column: 'status', direction: 'asc'},
          pullRequestsSort: {column: 'title', direction: 'asc'},
          commentSortOrder: 'oldest',
        },
      },
      {
        kind: 'update',
        reason: 'children-sort-changed',
        presentation: {
          childrenSort: {column: 'status', direction: 'desc'},
          pullRequestsSort: {column: 'title', direction: 'asc'},
          commentSortOrder: 'oldest',
        },
      },
      {
        kind: 'update',
        reason: 'pull-request-sort-changed',
        presentation: {
          childrenSort: {column: 'status', direction: 'desc'},
          pullRequestsSort: {column: 'status', direction: 'asc'},
          commentSortOrder: 'oldest',
        },
      },
      {
        kind: 'update',
        reason: 'comment-sort-changed',
        presentation: {
          childrenSort: {column: 'status', direction: 'desc'},
          pullRequestsSort: {column: 'status', direction: 'asc'},
          commentSortOrder: 'newest',
        },
      },
    ],
  });
});

test('popup session owns mutually exclusive panel transitions', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createFixturePopupSurface, createPopupSession} = window.JiraQuickViewDeepModules;
    const surface = createFixturePopupSurface();
    const popup = createPopupSession({
      issueData: {async openIssue(request) {
        return {
          kind: 'loaded',
          snapshot: {issueKey: request.issueKey, core: {key: request.issueKey, fields: {}}, sections: {}},
          failures: {},
        };
      }},
      fieldEditing: {attach() {}, detach() {}, view() { return {}; }},
      comments: {async attach() {}, async detach() {}, view() { return {}; }},
      surface,
    });
    await popup.activate({issueKey: 'ABC-1'});
    const history = await popup.dispatch({type: 'open-panel', panel: 'history'});
    const watchers = await popup.dispatch({type: 'open-panel', panel: 'watchers'});
    const watchersClosed = await popup.dispatch({type: 'toggle-panel', panel: 'watchers'});
    const linkedIssues = await popup.dispatch({type: 'open-panel', panel: 'linkedIssues'});
    const linkedIssuesClosed = await popup.dispatch({type: 'close-panel', panel: 'linkedIssues'});
    const invalid = await popup.dispatch({type: 'open-panel', panel: 'unknown'});
    return {
      outcomes: [history, watchers, watchersClosed, linkedIssues, linkedIssuesClosed]
        .map(item => item.presentation.activePanel),
      invalid: {kind: invalid.kind, reason: invalid.reason},
      frames: surface.getFrames().filter(frame => frame.kind !== 'loading').map(frame => ({
        kind: frame.kind,
        reason: frame.reason || '',
        activePanel: frame.presentation.activePanel,
      })),
    };
  });

  expect(result).toEqual({
    outcomes: ['history', 'watchers', '', 'linkedIssues', ''],
    invalid: {kind: 'ignored', reason: 'invalid-panel'},
    frames: [
      {kind: 'visible', reason: '', activePanel: ''},
      {kind: 'update', reason: 'panel-opened', activePanel: 'history'},
      {kind: 'update', reason: 'panel-opened', activePanel: 'watchers'},
      {kind: 'update', reason: 'panel-closed', activePanel: ''},
      {kind: 'update', reason: 'panel-opened', activePanel: 'linkedIssues'},
      {kind: 'update', reason: 'panel-closed', activePanel: ''},
    ],
  });
});

test('popup session owns quick-action menu visibility', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createFixturePopupSurface, createPopupSession} = window.JiraQuickViewDeepModules;
    const surface = createFixturePopupSurface();
    const popup = createPopupSession({
      issueData: {async openIssue(request) {
        return {
          kind: 'loaded',
          snapshot: {issueKey: request.issueKey, core: {key: request.issueKey, fields: {}}, sections: {}},
          failures: {},
        };
      }},
      fieldEditing: {attach() {}, detach() {}, view() { return {}; }},
      comments: {async attach() {}, async detach() {}, view() { return {}; }},
      surface,
    });
    await popup.activate({issueKey: 'ABC-1'});
    const opened = await popup.dispatch({type: 'toggle-actions'});
    const closed = await popup.dispatch({type: 'close-actions'});
    const unchanged = await popup.dispatch({type: 'close-actions'});
    return {
      outcomes: [opened.presentation.actionsOpen, closed.presentation.actionsOpen],
      unchanged: {kind: unchanged.kind, reason: unchanged.reason},
      frames: surface.getFrames().filter(frame => frame.kind !== 'loading').map(frame => ({
        kind: frame.kind,
        reason: frame.reason || '',
        actionsOpen: frame.presentation.actionsOpen,
      })),
    };
  });

  expect(result).toEqual({
    outcomes: [true, false],
    unchanged: {kind: 'ignored', reason: 'actions-unchanged'},
    frames: [
      {kind: 'visible', reason: '', actionsOpen: false},
      {kind: 'update', reason: 'actions-opened', actionsOpen: true},
      {kind: 'update', reason: 'actions-closed', actionsOpen: false},
    ],
  });
});

test('browser popup events translate presentation DOM interactions into semantic intents', async ({page}) => {
  const result = await page.evaluate(() => {
    const {createBrowserPopupEvents, jquery: $} = window.JiraQuickViewDeepModules;
    document.body.innerHTML = `
      <div class="_JX_actions"><button class="_JX_actions_toggle">Actions</button></div>
      <button class="_JX_pin_button">Pin</button>
      <button class="_JX_children_sort" data-sort-column="status">Children</button>
      <button class="_JX_pr_sort" data-sort-column="author">Pull requests</button>
      <button class="_JX_comment_sort_toggle">Comments</button>
      <div class="_JX_watchers_group">
        <button class="_JX_watchers_trigger">Watchers</button>
        <button class="_JX_watchers_close">Close watchers</button>
      </div>
      <div class="_JX_linked_issues_group">
        <button class="_JX_linked_issues_trigger">Linked issues</button>
        <button class="_JX_linked_issues_close">Close linked issues</button>
      </div>
      <button class="_JX_history_toggle">History</button>
      <div class="_JX_history_flyout"><button class="_JX_history_close">Close history</button></div>
      <button id="outside">Outside</button>
    `;
    const intents = [];
    const events = createBrowserPopupEvents({
      root: $(document.body),
      emit(intent) { intents.push(intent); },
    });
    events.install();
    $('._JX_actions_toggle').trigger('click');
    $('._JX_pin_button').trigger('click');
    $('._JX_children_sort').trigger('click');
    $('._JX_pr_sort').trigger('click');
    $('._JX_comment_sort_toggle').trigger('click');
    $('._JX_watchers_trigger').trigger('click');
    $('._JX_watchers_close').trigger('click');
    $('._JX_linked_issues_trigger').trigger('click');
    $('._JX_linked_issues_close').trigger('click');
    $('._JX_history_toggle').trigger('click');
    $('._JX_history_close').trigger('click');
    const direct = intents.slice();
    intents.length = 0;
    $('#outside').trigger('mousedown').trigger('click');
    const dismissals = intents.slice();
    events.dispose();
    $('#outside').trigger('mousedown').trigger('click');
    return {direct, dismissals, afterDispose: intents};
  });

  expect(result).toEqual({
    direct: [
      {type: 'toggle-actions'},
      {type: 'pin'},
      {type: 'sort-children', column: 'status'},
      {type: 'sort-pull-requests', column: 'author'},
      {type: 'toggle-comment-sort'},
      {type: 'toggle-watchers'},
      {type: 'close-watchers'},
      {type: 'toggle-linkedIssues'},
      {type: 'close-linkedIssues'},
      {type: 'toggle-history'},
      {type: 'close-history'},
    ],
    dismissals: [
      {type: 'dismiss-watchers'},
      {type: 'dismiss-linkedIssues'},
      {type: 'dismiss-actions'},
      {type: 'dismiss-history'},
    ],
    afterDispose: [
      {type: 'dismiss-watchers'},
      {type: 'dismiss-linkedIssues'},
      {type: 'dismiss-actions'},
      {type: 'dismiss-history'},
    ],
  });
});

test('browser popup shell owns pinning, preview identity, hide scheduling, and viewport position', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createBrowserPopupShell, createDeferred, jquery: $} = window.JiraQuickViewDeepModules;
    document.body.innerHTML = `
      <div id="popup" style="position:absolute;left:100px;top:120px;width:200px;height:100px">Issue</div>
      <div id="preview"><img></div>
    `;
    const oldPreview = createDeferred();
    const closeCalls = [];
    const announcements = [];
    let scheduled = null;
    const shell = createBrowserPopupShell({
      announce(message) { announcements.push(message); },
      close(details) { closeCalls.push(details); },
      container: $('#popup'),
      media: {displayUrl(source) {
        return source === 'old.png' ? oldPreview.promise : Promise.resolve(`display:${source}`);
      }},
      previewOverlay: $('#preview'),
      scheduler: {
        clear(id) { if (scheduled?.id === id) scheduled = null; },
        set(callback, delay) { scheduled = {callback, delay, id: 7}; return 7; },
      },
    });
    const initial = shell.view();
    const nearEdge = shell.position({x: -100, y: -100});
    const farEdge = shell.position({x: 100000, y: 100000});
    await shell.dispatch({type: 'schedule-hide', delay: 250, reason: 'pointer-exit'});
    const scheduledDelay = scheduled?.delay;
    scheduled.callback();
    await Promise.resolve();
    await shell.dispatch({type: 'begin-cooldown', delay: 200});
    const cooldown = {delay: scheduled?.delay, activeBefore: shell.view().cooldownActive};
    scheduled.callback();
    cooldown.activeAfter = shell.view().cooldownActive;
    const pinned = await shell.dispatch({type: 'pin', announce: true});
    const pinnedState = {
      outcome: pinned.kind,
      className: $('#popup').attr('class') || '',
      announcements: announcements.slice(),
    };
    const oldPending = shell.dispatch({type: 'open-preview', source: 'old.png'});
    const currentPreview = await shell.dispatch({type: 'open-preview', source: 'new.png'});
    oldPreview.resolve('display:old.png');
    const oldOutcome = await oldPending;
    const preview = {
      outcome: currentPreview.kind,
      oldOutcome: oldOutcome.kind,
      className: $('#preview').attr('class') || '',
      src: $('#preview img').attr('src'),
      view: shell.view(),
    };
    const cleared = await shell.dispatch({type: 'clear'});
    return {
      initial,
      nearEdge,
      farEdgeInsideViewport: farEdge.left >= 8 && farEdge.top >= 8 &&
        farEdge.left + 200 <= window.innerWidth - 8 && farEdge.top + 100 <= window.innerHeight - 8,
      pinned: pinnedState,
      preview,
      scheduledDelay,
      cooldown,
      closeCalls,
      cleared: {
        outcome: cleared.kind,
        html: $('#popup').html(),
        previewClassName: $('#preview').attr('class') || '',
        view: shell.view(),
      },
    };
  });

  expect(result).toEqual({
    initial: {cooldownActive: false, pinned: false, previewOpen: false, previewSource: ''},
    nearEdge: {left: 8, top: 8},
    farEdgeInsideViewport: true,
    pinned: {
      outcome: 'pinned',
      className: 'container-pinned',
      announcements: ['Ticket Pinned! Hit esc to close !'],
    },
    preview: {
      outcome: 'preview-opened',
      oldOutcome: 'ignored',
      className: 'is-open',
      src: 'display:new.png',
      view: {cooldownActive: false, pinned: true, previewOpen: true, previewSource: 'new.png'},
    },
    scheduledDelay: 250,
    cooldown: {delay: 200, activeBefore: true, activeAfter: false},
    closeCalls: [{reason: 'pointer-exit'}],
    cleared: {
      outcome: 'cleared',
      html: '',
      previewClassName: '',
      view: {cooldownActive: false, pinned: false, previewOpen: false, previewSource: ''},
    },
  });
});

test('browser renderer commits one deterministic DOM path and restores continuity', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createBrowserPopupRenderer, jquery: $} = window.JiraQuickViewDeepModules;
    document.body.innerHTML = '<div id="popup"></div>';
    const container = $('#popup');
    const continuityCalls = [];
    let fieldView = null;
    const renderer = createBrowserPopupRenderer({
      comments: {dispatch() { return Promise.resolve(); }, view() { return {issueKey: 'ABC-1', rowAction: null}; }},
      container,
      contentBlockOrder: ['first', 'second'],
      continuity: {
        constrainPopovers() { continuityCalls.push('constrain'); },
        renderComposeMentions() { continuityCalls.push('composeMentions'); },
        renderEditMentions() { continuityCalls.push('editMentions'); },
        renderUploads() { continuityCalls.push('uploads'); },
        restoreComposer() { continuityCalls.push('restore'); },
        syncComposer() { continuityCalls.push('sync'); },
      },
      fieldEditing: {view() { return fieldView; }},
      shell: {position() { return {left: 15, top: 25}; }, view() { return {pinned: false}; }},
      projectState(state) { return {value: state.value}; },
      template: '<div class="_JX_content_blocks" style="width:50px;height:20px;overflow:scroll"><div data-content-block="second">second</div><div data-content-block="first">first</div><div style="width:200px;height:100px"></div></div><input class="_JX_edit_input" value="{{value}}">',
    });
    const context = {isCurrent() { return true; }};
    await renderer.render({issueData: {key: 'ABC-1'}, key: 'ABC-1', pointerX: 1, pointerY: 2, value: 'initial'}, context);
    container.find('._JX_content_blocks').scrollLeft(12).scrollTop(18);
    continuityCalls.length = 0;
    fieldView = {fieldKey: 'summary', selectionStart: 2, selectionEnd: 5};
    const receipt = await renderer.render({issueData: {key: 'ABC-1'}, key: 'ABC-1', pointerX: 1, pointerY: 2, value: 'updated'}, context);
    const input = container.find('._JX_edit_input').get(0);
    return {
      receipt,
      blockOrder: container.find('[data-content-block]').map((index, element) => element.getAttribute('data-content-block')).get(),
      scroll: {
        left: container.find('._JX_content_blocks').scrollLeft(),
        top: container.find('._JX_content_blocks').scrollTop(),
      },
      selection: {start: input.selectionStart, end: input.selectionEnd, active: document.activeElement === input},
      position: {left: container.css('left'), top: container.css('top')},
      continuityCalls,
    };
  });

  expect(result).toEqual({
    receipt: {kind: 'committed'},
    blockOrder: ['first', 'second'],
    scroll: {left: 12, top: 18},
    selection: {start: 2, end: 5, active: true},
    position: {left: '15px', top: '25px'},
    continuityCalls: ['restore', 'uploads', 'composeMentions', 'sync', 'editMentions', 'constrain'],
  });
});

test('browser renderer rejects a stale asynchronous projection before DOM commit', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createBrowserPopupRenderer, createDeferred, jquery: $} = window.JiraQuickViewDeepModules;
    document.body.innerHTML = '<div id="popup">current</div>';
    const projection = createDeferred();
    let current = true;
    const renderer = createBrowserPopupRenderer({
      comments: {dispatch() { return Promise.resolve(); }, view() { return {}; }},
      container: $('#popup'),
      contentBlockOrder: [],
      continuity: {
        constrainPopovers() {}, renderComposeMentions() {}, renderEditMentions() {}, renderUploads() {}, restoreComposer() {}, syncComposer() {},
      },
      fieldEditing: {view() { return null; }},
      shell: {position() { return {}; }, view() { return {pinned: true}; }},
      projectState() { return projection.promise; },
      template: '<div>{{value}}</div>',
    });
    const pending = renderer.render({issueData: {key: 'OLD-1'}, key: 'OLD-1'}, {isCurrent() { return current; }});
    current = false;
    projection.resolve({value: 'stale'});
    const receipt = await pending;
    return {receipt, html: $('#popup').html()};
  });

  expect(result).toEqual({receipt: {kind: 'stale'}, html: 'current'});
});
