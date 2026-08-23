import {createBrowserMessageJiraAdapter} from 'src/browser-message-jira-adapter';
import {createCommentLifecycle} from 'src/comment-lifecycle';
import {createJiraFieldEditing} from 'src/jira-field-editing';
import {createQuickViewIssueData} from 'src/quickview-issue-data';
import {createPopupSession} from 'src/popup-session';
import {createBrowserPopupRenderer} from 'src/popup-session/browser-popup-renderer';
import {createBrowserPopupEvents} from 'src/popup-session/browser-popup-events';
import {createDeferred, createMockJiraAdapter} from './mock-jira-adapter';
import {createFixturePopupSurface} from './fixture-popup-surface';
import jquery from 'jquery';

window.JiraQuickViewDeepModules = {
  createBrowserMessageJiraAdapter,
  createBrowserPopupEvents,
  createBrowserPopupRenderer,
  createCommentLifecycle,
  createDeferred,
  createFixturePopupSurface,
  createJiraFieldEditing,
  createMockJiraAdapter,
  createPopupSession,
  createQuickViewIssueData,
  jquery,
};
