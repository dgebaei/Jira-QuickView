import {createBrowserMessageJiraAdapter} from 'src/browser-message-jira-adapter';
import {createCommentLifecycle} from 'src/comment-lifecycle';
import {createJiraFieldEditing} from 'src/jira-field-editing';
import {createLinkedIssueLifecycle} from 'src/linked-issue-lifecycle';
import {createQuickViewIssueData} from 'src/quickview-issue-data';
import {createWatcherLifecycle} from 'src/watcher-lifecycle';
import {createPopupSession} from 'src/popup-session';
import {createPopupQuickActions} from 'src/popup-quick-actions';
import {createPopupShortcutWorkflow} from 'src/popup-shortcut-workflow';
import {matchPopupShortcut} from 'src/popup-session/browser-popup-shortcuts';
import {createBrowserPopupRenderer} from 'src/popup-session/browser-popup-renderer';
import {createBrowserPopupEvents} from 'src/popup-session/browser-popup-events';
import {createBrowserPopupModel} from 'src/popup-session/browser-popup-model';
import {createBrowserPopupShell} from 'src/popup-session/browser-popup-shell';
import {createBrowserCommentPresentation} from 'src/popup-session/browser-comment-presentation';
import {createDeferred, createMockJiraAdapter} from './mock-jira-adapter';
import {createFixturePopupSurface} from './fixture-popup-surface';
import {installJiraInlineCopyButtons} from 'src/jira-inline-copy';
import {describeJiraConnectionFailure} from 'src/jira-connection-errors';
import jquery from 'jquery';
import {loadGitLabPullRequest, parseGitLabMergeRequestUrl} from 'src/gitlab-pull-requests';
import {buildPullRequestView} from 'src/popup-session/pull-request-view';
import {installPopupTooltips} from 'src/popup-session/popup-tooltips';
import {withEmbeddedContentDomains} from 'options/options-utils';

window.JiraQuickViewDeepModules = {
  describeJiraConnectionFailure,
  loadGitLabPullRequest,
  parseGitLabMergeRequestUrl,
  buildPullRequestView,
  installPopupTooltips,
  withEmbeddedContentDomains,
  createPopupShortcutWorkflow,
  matchPopupShortcut,
  createBrowserMessageJiraAdapter,
  createBrowserCommentPresentation,
  createBrowserPopupEvents,
  createBrowserPopupModel,
  createBrowserPopupShell,
  createBrowserPopupRenderer,
  createCommentLifecycle,
  createDeferred,
  createFixturePopupSurface,
  createJiraFieldEditing,
  createLinkedIssueLifecycle,
  createMockJiraAdapter,
  createPopupSession,
  createPopupQuickActions,
  createQuickViewIssueData,
  createWatcherLifecycle,
  installJiraInlineCopyButtons,
  jquery,
};
