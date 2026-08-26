const ISSUE_KEY_PATTERN = /\b[A-Z][A-Z0-9]{1,14}-\d+\b/;
const HEADER_LINK_SELECTORS = [
  '[data-testid="issue.views.issue-base.foundation.breadcrumbs.breadcrumb-current-issue-container"] a[href]',
  '#key-val',
];
const SUMMARY_SELECTORS = [
  '[data-testid="issue.views.issue-base.foundation.summary.heading"]',
  'h1[data-test-id="issue.views.issue-base.foundation.summary.heading"]',
  '#summary-val',
  '.issue-header-content h1',
];
const DC_CHILD_PANEL_CONFIGS = [
  {selector: '#greenhopper-epics-issue-web-panel', field: '"Epic Link"'},
  {selector: '#subtasks-module, #subtasksmodule, #subtaskmodule', field: 'parent'},
];
const RESULT_LINK_SELECTOR = 'a[href*="/browse/"]';
const RESULT_KEY_SELECTORS = [
  '[data-testid*="key"]',
  '.issue-key',
  '.issuekey',
  '.card-key',
];
const RESULT_KEY_SELECTOR = RESULT_KEY_SELECTORS.join(', ');
const RESULT_CONTAINER_SELECTOR = '[data-issue-key], [data-issuekey], tr, [role="row"], article, li';

function getIssueKey(element) {
  const dataKey = String(
    element?.getAttribute?.('data-issue-key')
    || element?.getAttribute?.('data-issuekey')
    || ''
  ).trim();
  if (ISSUE_KEY_PATTERN.test(dataKey)) {
    return dataKey.match(ISSUE_KEY_PATTERN)[0];
  }
  const href = String(element?.getAttribute?.('href') || '');
  const hrefMatch = href.match(/\/browse\/([A-Z][A-Z0-9]{1,14}-\d+)\b/i);
  if (hrefMatch) {
    return hrefMatch[1].toUpperCase();
  }
  return String(element?.textContent || '').match(ISSUE_KEY_PATTERN)?.[0] || '';
}

function getIssueSummary(documentRef) {
  for (const selector of SUMMARY_SELECTORS) {
    const summary = String(documentRef.querySelector(selector)?.textContent || '').trim();
    if (summary) {
      return summary;
    }
  }
  return '';
}

function getResultContainer(issueElement) {
  return issueElement.closest(RESULT_CONTAINER_SELECTOR);
}

function getResultSummary(issueElement, key) {
  const container = getResultContainer(issueElement);
  if (!container) {
    return '';
  }
  const explicitSummary = container.querySelector('[data-testid*="summary"], .issue-summary, .summary, .ghx-summary');
  if (explicitSummary) {
    return String(explicitSummary.textContent || '').trim();
  }
  const relatedLink = Array.from(container.querySelectorAll(RESULT_LINK_SELECTOR)).find(link => {
    const text = String(link.textContent || '').trim();
    return link !== issueElement && text && text !== key;
  });
  return String(relatedLink?.textContent || '').trim();
}

function findResultKeyElement(container, key) {
  for (const selector of RESULT_KEY_SELECTORS) {
    const element = container.querySelector(selector);
    if (String(element?.textContent || '').includes(key)) {
      return element;
    }
  }

  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let textNode = walker.nextNode();
  while (textNode) {
    if (String(textNode.nodeValue || '').trim() === key) {
      return textNode.parentElement;
    }
    textNode = walker.nextNode();
  }
  return null;
}

function buildIssueUrl(instanceUrl, key) {
  const baseUrl = String(instanceUrl || '').endsWith('/') ? instanceUrl : `${instanceUrl}/`;
  return new URL(`browse/${key}`, baseUrl).toString();
}

function buildIssueSearchUrl(instanceUrl, jql) {
  const baseUrl = String(instanceUrl || '').endsWith('/') ? instanceUrl : `${instanceUrl}/`;
  const url = new URL('issues/', baseUrl);
  url.searchParams.set('jql', jql);
  return url.toString();
}

function buildCopyIcon(documentRef) {
  const svg = documentRef.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<g fill="currentColor"><path d="M10 19h8V8h-8v11zM8 7.992C8 6.892 8.902 6 10.009 6h7.982C19.101 6 20 6.893 20 7.992v11.016c0 1.1-.902 1.992-2.009 1.992H10.01A2.001 2.001 0 0 1 8 19.008V7.992z"></path><path d="M5 16V4.992C5 3.892 5.902 3 7.009 3H15v13H5zm2 0h8V5H7v11z"></path></g>';
  return svg;
}

function buildExternalLinkIcon(documentRef) {
  const svg = documentRef.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<path d="M9.5 2.5h4v4M13.5 2.5l-7 7M12.5 8.5v4h-9v-9h4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"></path>';
  return svg;
}

function resolveChildPanelField(panel, configuredField) {
  if (configuredField) {
    return configuredField;
  }
  const heading = String(panel?.querySelector?.('.aui-toggle-header-button-label, .toggle-header')?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (heading === 'issues in epic') {
    return '"Epic Link"';
  }
  if (['children', 'child issues', 'sub-tasks', 'subtasks'].includes(heading)) {
    return 'parent';
  }
  return '';
}

function findNativeChildPanels(documentRef) {
  const panels = new Map();
  for (const config of DC_CHILD_PANEL_CONFIGS) {
    const panel = documentRef.querySelector(config.selector);
    if (panel) {
      panels.set(panel, config.field);
    }
  }
  for (const panel of documentRef.querySelectorAll('.module.toggle-wrap')) {
    if (!panels.has(panel)) {
      const field = resolveChildPanelField(panel, '');
      if (field) {
        panels.set(panel, field);
      }
    }
  }
  return panels;
}

function installNativeChildrenJqlLinks(documentRef, instanceUrl, currentIssueKey) {
  if (!currentIssueKey) {
    return;
  }
  for (const [panel, configuredField] of findNativeChildPanels(documentRef)) {
    const field = resolveChildPanelField(panel, configuredField);
    const headerActions = panel.querySelector('.mod-header .ops');
    if (!field || !headerActions) {
      continue;
    }
    for (const staleLink of headerActions.querySelectorAll('._JX_native_children_jql_link')) {
      if (staleLink.dataset.jxNativeChildrenJqlKey !== currentIssueKey) {
        staleLink.closest('li')?.remove();
      }
    }
    if (headerActions.querySelector(`._JX_native_children_jql_link[data-jx-native-children-jql-key="${currentIssueKey}"]`)) {
      continue;
    }
    const jql = `${field} = "${currentIssueKey}"`;
    const item = documentRef.createElement('li');
    item.className = '_JX_native_children_jql_item';
    const link = documentRef.createElement('a');
    link.className = '_JX_native_children_jql_link';
    link.dataset.jxNativeChildrenJqlKey = currentIssueKey;
    link.dataset.testid = 'jira-dc-children-jql-link';
    link.href = buildIssueSearchUrl(instanceUrl, jql);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = 'View all child issues in Jira';
    link.setAttribute('aria-label', link.title);
    const label = documentRef.createElement('span');
    label.textContent = 'View all';
    link.append(label, buildExternalLinkIcon(documentRef));
    item.appendChild(link);
    headerActions.insertBefore(item, headerActions.firstElementChild);
  }
}

function createCopyButton(documentRef, reference, copy, variant) {
  const button = documentRef.createElement('button');
  button.type = 'button';
  button.className = `_JX_inline_copy_button _JX_inline_copy_button_${variant}`;
  button.dataset.jxInlineCopyKey = reference.key;
  button.dataset.testid = `jira-inline-copy-${reference.key}`;
  button.title = `Copy ${reference.key} issue link`;
  button.setAttribute('aria-label', button.title);
  button.appendChild(buildCopyIcon(documentRef));
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    Promise.resolve(copy(reference)).catch(() => {});
  });
  return button;
}

function removeStaleCopyButtons(issueElement, key) {
  let sibling = issueElement.nextElementSibling;
  while (sibling?.classList.contains('_JX_inline_copy_button')) {
    const nextSibling = sibling.nextElementSibling;
    if (sibling.dataset.jxInlineCopyKey !== key) {
      sibling.remove();
    }
    sibling = nextSibling;
  }
}

function insertResultCopyButton(documentRef, issueElement, reference, copy) {
  const container = getResultContainer(issueElement);
  if (!container) {
    return;
  }
  container.classList.add('_JX_inline_copy_scope');
  issueElement.classList.add('_JX_inline_copy_anchor');
  issueElement.insertAdjacentElement('afterend', createCopyButton(documentRef, reference, copy, 'result'));
}

export function installJiraInlineCopyButtons({document: documentRef, instanceUrl, enabled = true, copy}) {
  if (!enabled || !documentRef?.body || typeof copy !== 'function') {
    return () => {};
  }

  let instanceOrigin = '';
  try {
    instanceOrigin = new URL(instanceUrl).origin;
  } catch (error) {
    return () => {};
  }
  if (documentRef.location.origin !== instanceOrigin) {
    return () => {};
  }

  let scanFrame = 0;
  const scan = () => {
    scanFrame = 0;
    const summary = getIssueSummary(documentRef);
    for (const selector of HEADER_LINK_SELECTORS) {
      const issueElement = documentRef.querySelector(selector);
      const key = getIssueKey(issueElement);
      if (!issueElement || !key || !summary || issueElement.closest('._JX_container')) {
        continue;
      }
      removeStaleCopyButtons(issueElement, key);
      const existing = issueElement.nextElementSibling;
      if (existing?.matches(`._JX_inline_copy_button[data-jx-inline-copy-key="${key}"]`)) {
        break;
      }
      issueElement.insertAdjacentElement('afterend', createCopyButton(documentRef, {
        key,
        summary,
        url: buildIssueUrl(instanceUrl, key),
      }, copy, 'header'));
      break;
    }

    const currentIssueKey = getIssueKey(documentRef.querySelector('#key-val'));
    installNativeChildrenJqlLinks(documentRef, instanceUrl, currentIssueKey);

    for (const issueElement of documentRef.querySelectorAll(RESULT_LINK_SELECTOR)) {
      const key = getIssueKey(issueElement);
      const elementText = String(issueElement.textContent || '').trim();
      if (!key || !elementText.includes(key) || issueElement.closest('._JX_container')) {
        continue;
      }
      removeStaleCopyButtons(issueElement, key);
      const existing = issueElement.nextElementSibling;
      if (existing?.matches(`._JX_inline_copy_button[data-jx-inline-copy-key="${key}"]`)) {
        continue;
      }
      const resultSummary = getResultSummary(issueElement, key);
      if (!resultSummary) {
        continue;
      }
      insertResultCopyButton(documentRef, issueElement, {
        key,
        summary: resultSummary,
        url: buildIssueUrl(instanceUrl, key),
      }, copy);
    }

    for (const candidate of documentRef.querySelectorAll(RESULT_KEY_SELECTOR)) {
      const key = getIssueKey(candidate);
      const issueElement = findResultKeyElement(candidate, key) || candidate;
      if (!key || !issueElement || issueElement.closest('._JX_container')) {
        continue;
      }
      removeStaleCopyButtons(issueElement, key);
      const existing = issueElement.nextElementSibling;
      if (existing?.matches(`._JX_inline_copy_button[data-jx-inline-copy-key="${key}"]`)) {
        continue;
      }
      const resultSummary = getResultSummary(issueElement, key);
      if (!resultSummary) {
        continue;
      }
      insertResultCopyButton(documentRef, issueElement, {
        key,
        summary: resultSummary,
        url: buildIssueUrl(instanceUrl, key),
      }, copy);
    }

    for (const container of documentRef.querySelectorAll('[data-issue-key], [data-issuekey]')) {
      const key = getIssueKey(container);
      const issueElement = findResultKeyElement(container, key);
      if (!key || !issueElement || issueElement.closest('._JX_container')) {
        continue;
      }
      removeStaleCopyButtons(issueElement, key);
      const existing = issueElement.nextElementSibling;
      if (existing?.matches(`._JX_inline_copy_button[data-jx-inline-copy-key="${key}"]`)) {
        continue;
      }
      const resultSummary = getResultSummary(issueElement, key);
      if (!resultSummary) {
        continue;
      }
      insertResultCopyButton(documentRef, issueElement, {
        key,
        summary: resultSummary,
        url: buildIssueUrl(instanceUrl, key),
      }, copy);
    }
  };
  const scheduleScan = () => {
    if (!scanFrame) {
      scanFrame = documentRef.defaultView.requestAnimationFrame(scan);
    }
  };
  const observer = new MutationObserver(scheduleScan);
  observer.observe(documentRef.body, {
    attributes: true,
    attributeFilter: ['data-issue-key', 'data-issuekey', 'href'],
    childList: true,
    subtree: true,
  });
  scan();

  return () => {
    observer.disconnect();
    if (scanFrame) {
      documentRef.defaultView.cancelAnimationFrame(scanFrame);
    }
  };
}
