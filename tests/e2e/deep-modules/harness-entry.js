import {createBrowserMessageJiraAdapter} from 'src/browser-message-jira-adapter';
import {createCommentLifecycle} from 'src/comment-lifecycle';
import {createJiraFieldEditing} from 'src/jira-field-editing';
import {createQuickViewIssueData} from 'src/quickview-issue-data';
import {createPopupSession} from 'src/popup-session';
import {createDeferred, createMockJiraAdapter} from './mock-jira-adapter';
import {createFixturePopupSurface} from './fixture-popup-surface';

window.JiraQuickViewDeepModules = {
  createBrowserMessageJiraAdapter,
  createCommentLifecycle,
  createDeferred,
  createFixturePopupSurface,
  createJiraFieldEditing,
  createMockJiraAdapter,
  createPopupSession,
  createQuickViewIssueData,
};
