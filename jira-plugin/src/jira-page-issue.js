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
