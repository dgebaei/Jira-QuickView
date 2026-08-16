import {createBrowserMessageJiraAdapter} from 'src/browser-message-jira-adapter';
import {createQuickViewIssueData} from 'src/quickview-issue-data';
import {createDeferred, createMockJiraAdapter} from './mock-jira-adapter';

window.JiraQuickViewDeepModules = {
  createBrowserMessageJiraAdapter,
  createDeferred,
  createMockJiraAdapter,
  createQuickViewIssueData,
};
