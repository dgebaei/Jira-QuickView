import {createBrowserMessageJiraAdapter} from 'src/browser-message-jira-adapter';
import {createCommentLifecycle} from 'src/comment-lifecycle';
import {createJiraFieldEditing} from 'src/jira-field-editing';
import {createQuickViewIssueData} from 'src/quickview-issue-data';
import {createPopupSession} from 'src/popup-session';
import {createPopupQuickActions} from 'src/popup-quick-actions';
import {createBrowserPopupRenderer} from 'src/popup-session/browser-popup-renderer';
import {createBrowserPopupEvents} from 'src/popup-session/browser-popup-events';
import {createBrowserPopupShell} from 'src/popup-session/browser-popup-shell';
import {createBrowserCommentPresentation} from 'src/popup-session/browser-comment-presentation';
import {createDeferred, createMockJiraAdapter} from './mock-jira-adapter';
import {createFixturePopupSurface} from './fixture-popup-surface';
import jquery from 'jquery';

window.JiraQuickViewDeepModules = {
  createBrowserMessageJiraAdapter,
  createBrowserCommentPresentation,
  createBrowserPopupEvents,
  createBrowserPopupShell,
  createBrowserPopupRenderer,
  createCommentLifecycle,
  createDeferred,
  createFixturePopupSurface,
  createJiraFieldEditing,
  createMockJiraAdapter,
  createPopupSession,
  createPopupQuickActions,
  createQuickViewIssueData,
  jquery,
};
