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
