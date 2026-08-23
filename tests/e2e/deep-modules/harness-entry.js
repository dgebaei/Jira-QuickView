import {createBrowserMessageJiraAdapter} from 'src/browser-message-jira-adapter';
import {createCommentLifecycle} from 'src/comment-lifecycle';
import {createJiraFieldEditing} from 'src/jira-field-editing';
import {createQuickViewIssueData} from 'src/quickview-issue-data';
import {createDeferred, createMockJiraAdapter} from './mock-jira-adapter';

window.JiraQuickViewDeepModules = {
  createBrowserMessageJiraAdapter,
  createCommentLifecycle,
  createDeferred,
  createJiraFieldEditing,
  createMockJiraAdapter,
  createQuickViewIssueData,
};
