// The issue Jira itself shows on this page: its issue view, or the issue open in the
// issue navigator. Boards are left out: Jira Agile binds 1–3 there.
export function readJiraPageIssueKey(href, instanceUrl) {
  let page;
  let instance;
  try {
    page = new URL(href);
    instance = new URL(instanceUrl);
  } catch (error) {
    return '';
  }
  if (page.origin !== instance.origin || !page.pathname.startsWith(instance.pathname)) return '';
  const match = page.pathname.match(/\/(?:browse|issues)\/([A-Z][A-Z0-9_]{1,14}-\d+)\/?$/i);
  return match ? match[1].toUpperCase() : '';
}

const ISSUE_KEY = /\b([A-Z][A-Z0-9_]{1,14}-\d+)\b/;
const HEADING_SELECTOR = 'h1, h2, h3, [role="heading"]';
// Lists, grids and menus repeat many issues: a heading there is one entry, not what the page is about.
const COLLECTION_SELECTOR = [
  '[role="listbox"]', '[role="option"]', '[role="grid"]', '[role="treegrid"]', '[role="tree"]',
  '[role="menu"]', '[role="navigation"]', 'nav', '[aria-hidden="true"]',
].join(', ');

function isShown(element) {
  if (typeof element.checkVisibility === 'function') return element.checkVisibility({visibilityProperty: true});
  return element.getClientRects().length > 0;
}

// The issue a page outside Jira is about, such as an open mail whose subject names it:
// the first key in a visible heading that is not part of a list, menu or QuickView itself.
function readHeadingIssueKey(documentRef, ignore) {
  for (const heading of documentRef.querySelectorAll(HEADING_SELECTOR)) {
    if (ignore?.contains(heading) || heading.closest(COLLECTION_SELECTOR) || !isShown(heading)) continue;
    const match = String(heading.textContent || '').match(ISSUE_KEY);
    if (match) return match[1];
  }
  return '';
}

// The issue number-key shortcuts act on when QuickView does not have focus, or null.
// On Jira only its issue view counts; Jira binds number keys on its other pages.
export function readPageIssue(href, instanceUrl, documentRef, {ignore} = {}) {
  const jiraKey = readJiraPageIssueKey(href, instanceUrl);
  if (jiraKey) return {key: jiraKey, onJira: true};
  try {
    if (new URL(href).origin === new URL(instanceUrl).origin) return null;
  } catch (error) {
    return null;
  }
  const key = readHeadingIssueKey(documentRef, ignore);
  return key ? {key, onJira: false} : null;
}
