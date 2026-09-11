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
const SCOPED_SUMMARY_SELECTORS = [
  ...SUMMARY_SELECTORS,
  'h1[data-testid*="summary"]',
  '[role="heading"][aria-level="1"][data-testid*="summary"]',
  '.issue-summary',
  '.ghx-summary',
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
const RESULT_CONTAINER_SELECTOR = [
  '[data-issue-key]',
  '[data-issuekey]',
  '[data-testid*="issue-details-panel"]',
  '[data-testid*="issue-detail-panel"]',
  '[role="dialog"]',
  '.ghx-detail-view',
  '.ghx-detail-issue',
  'tr',
  '[role="row"]',
  'article',
  'li',
].join(', ');
const DROPDOWN_SELECTOR = [
  '[role="menu"]',
  '[role="listbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '.aui-dropdown',
  '.aui-dropdown2',
].join(', ');

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

function getSummaryFromScope(scope, selectors = SCOPED_SUMMARY_SELECTORS) {
  for (const selector of selectors) {
    const summary = String(scope?.querySelector?.(selector)?.textContent || '').trim();
    if (summary) {
      return summary;
    }
  }
  return '';
}

function getIssueSummary(documentRef, issueElement) {
  const scopedDetails = issueElement?.closest?.([
    '[role="dialog"]',
    '[data-testid*="issue-details"]',
    '[data-testid*="issue-detail"]',
    '[data-issue-key]',
    '[data-issuekey]',
  ].join(', '));
  return getSummaryFromScope(scopedDetails) || getSummaryFromScope(documentRef, SUMMARY_SELECTORS);
}

function getResultContainer(issueElement) {
  const container = issueElement?.closest?.(RESULT_CONTAINER_SELECTOR);
  if (container !== issueElement || !issueElement?.matches?.('a, span, strong')) {
    return container;
  }
  return issueElement.parentElement?.closest(RESULT_CONTAINER_SELECTOR)
    || issueElement.parentElement;
}

function getResultSummary(issueElement, key) {
  const container = getResultContainer(issueElement);
  if (!container) {
    return '';
  }
  const preciseSummary = getSummaryFromScope(container);
  if (preciseSummary) {
    return preciseSummary;
  }
  const explicitSummary = Array.from(container.querySelectorAll('[data-testid*="summary"], .summary'))
    .find(candidate => !/development|branch|commit|pull.request/i.test(String(candidate.getAttribute('data-testid') || '')));
  if (explicitSummary) {
    return String(explicitSummary.textContent || '').trim();
  }
  const directText = String(issueElement.textContent || '').replace(/\s+/g, ' ').trim();
  if (directText && directText.toUpperCase() !== key) {
    return directText;
  }
  const relatedLink = Array.from(container.querySelectorAll(RESULT_LINK_SELECTOR)).find(link => {
    const text = String(link.textContent || '').trim();
    return link !== issueElement && text && text !== key;
  });
  return String(relatedLink?.textContent || '').trim();
}

function findResultCopyTarget(container) {
  const row = container?.matches?.('tr, [role="row"]')
    ? container
    : container?.closest?.('tr, [role="row"]');
  if (!row) return null;
  return row.querySelector('[data-testid*="summary"], .summary, td:nth-child(3)') || null;
}

function isIssueHeaderLink(issueElement) {
  return HEADER_LINK_SELECTORS.some(selector => issueElement?.matches?.(selector));
}

function isOwnCopyButtonAddition(record) {
  if (record.type !== 'childList' || record.removedNodes.length > 0) return false;
  const changedNodes = [...record.addedNodes];
  return changedNodes.length > 0 && changedNodes.every(node => (
    node.nodeType === 1 && node.matches('._JX_inline_copy_button')
  ));
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
  button.dataset.jxInlineCopySummary = reference.summary;
  button.dataset.testid = `jira-inline-copy-${reference.key}`;
  // Global copy buttons sit in arbitrary host-page themes. Keep their accessible
  // name without invoking the browser's unstyleable light tooltip on hover.
  const copyLabel = variant === 'comment'
    ? `Copy ${reference.key} comment link`
    : `Copy ${reference.key} issue link`;
  button.title = variant === 'global' ? '' : copyLabel;
  button.setAttribute('aria-label', copyLabel);
  button.appendChild(buildCopyIcon(documentRef));
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    Promise.resolve().then(() => copy(reference)).catch(() => {
      button.title = `Could not copy ${reference.key}. Click to retry.`;
    }).finally(() => {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    });
  });
  return button;
}

function removeStaleCopyButtons(issueElement, key, summary) {
  if (!issueElement.matches('a, span, strong')) {
    for (const button of issueElement.querySelectorAll('._JX_inline_copy_button')) {
      if (button.dataset.jxInlineCopyKey !== key || button.dataset.jxInlineCopySummary !== summary) {
        button.remove();
      }
    }
    return;
  }
  let sibling = issueElement.nextElementSibling;
  while (sibling?.classList.contains('_JX_inline_copy_button')) {
    const nextSibling = sibling.nextElementSibling;
    if (sibling.dataset.jxInlineCopyKey !== key || sibling.dataset.jxInlineCopySummary !== summary) {
      sibling.remove();
    }
    sibling = nextSibling;
  }
}

function reconcileResultCopyButton(documentRef, issueElement, reference, copy) {
  const container = getResultContainer(issueElement);
  if (!container) {
    return null;
  }
  const resultButtons = Array.from(container.querySelectorAll('._JX_inline_copy_button_result'));
  const matchingButton = resultButtons.find(button => (
    button.dataset.jxInlineCopyKey === reference.key
    && button.dataset.jxInlineCopySummary === reference.summary
  ));
  for (const button of resultButtons) {
    if (button !== matchingButton) {
      button.remove();
    }
  }
  if (issueElement.matches('a, span, strong')) {
    const pairOwner = issueElement.parentElement;
    pairOwner?.classList.toggle(
      '_JX_inline_copy_dropdown_pair',
      !!pairOwner.closest(DROPDOWN_SELECTOR)
    );
  }
  if (matchingButton) {
    return matchingButton;
  }
  container.classList.add('_JX_inline_copy_scope');
  const button = createCopyButton(documentRef, reference, copy, 'result');
  if (issueElement.matches('a, span, strong')) {
    issueElement.classList.add('_JX_inline_copy_anchor');
    issueElement.insertAdjacentElement('afterend', button);
  } else {
    issueElement.append(button);
  }
  return button;
}

function installNativeCommentCopyButtons(documentRef, copy) {
  const issueElement = documentRef.querySelector('#key-val, [data-testid*="issue.views.issue-base.foundation.breadcrumbs.breadcrumb-current-issue-container"] a[href]');
  const key = getIssueKey(issueElement);
  const summary = getIssueSummary(documentRef, issueElement);
  if (!key || !summary) return;

  for (const commentLink of documentRef.querySelectorAll('a[href*="focusedCommentId"], a[href*="#comment-"]')) {
    if (commentLink.closest('._JX_container') || commentLink.nextElementSibling?.matches('._JX_inline_copy_button_comment')) {
      continue;
    }
    const href = commentLink.getAttribute('href') || '';
    if (!href || href.startsWith('#')) continue;
    commentLink.insertAdjacentElement('afterend', createCopyButton(documentRef, {
      key,
      summary,
      url: new URL(href, documentRef.location.href).toString(),
    }, copy, 'comment'));
  }
}

function installAllowedPageCopyButtons(documentRef, instanceUrl, copy) {
  const excluded = 'a, button, input, textarea, select, option, script, style, noscript, svg, code, pre, [contenteditable], [role="button"], [role="menu"], [role="menuitem"], [role="textbox"], ._JX_container, ._JX_global_copy_reference, ._JX_inline_copy_button';
  const references = new Map();
  let frame = 0;
  const makeButton = key => createCopyButton(documentRef, {
    key, summary: '', url: buildIssueUrl(instanceUrl, key),
  }, copy, 'global');
  const scan = () => {
    frame = 0;
    observer.disconnect();
    for (const wrapper of documentRef.querySelectorAll('._JX_global_copy_reference')) {
      const key = wrapper.firstChild?.textContent || '';
      const button = wrapper.querySelector('._JX_inline_copy_button');
      if (button?.dataset.jxInlineCopyKey !== key) {
        wrapper.replaceWith(documentRef.createTextNode(key));
      }
    }
    for (const [link, entry] of references) {
      if (!link.isConnected || link.href !== entry.href) {
        entry.button.remove();
        references.delete(link);
      }
    }
    const base = new URL(instanceUrl);
    for (const link of documentRef.querySelectorAll('a[href]')) {
      if (references.has(link) || link.parentElement?.closest(excluded)
          || link.matches('[role="button"], [role="menuitem"], [download], [contenteditable]')) continue;
      const href = link.getAttribute('href') || '';
      if (!href || href.startsWith('#')) continue;
      let url;
      try { url = new URL(href, documentRef.location.href); } catch (error) { continue; }
      if (url.origin !== base.origin) continue;
      const key = url.pathname.match(/\/(?:browse|issues)\/([A-Z][A-Z0-9]{1,14}-\d+)\/?$/i)?.[1]?.toUpperCase();
      // Only decorate a link when the visible link itself identifies the issue.
      // Jira action links such as “View issue” and “Add comment” can point at
      // an issue URL but are not issue references users should copy.
      if (!key || !new RegExp(`\\b${key}\\b`, 'i').test(link.textContent || '')) continue;
      const button = makeButton(key);
      link.after(button);
      references.set(link, {href: link.href, button});
    }
    const walker = documentRef.createTreeWalker(documentRef.body, 4);
    const nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.parentElement?.closest(excluded) && ISSUE_KEY_PATTERN.test(node.nodeValue || '')) nodes.push(node);
    }
    for (const node of nodes) {
      const fragment = documentRef.createDocumentFragment();
      const text = node.nodeValue;
      let offset = 0;
      for (const match of text.matchAll(/\b[A-Z][A-Z0-9]{1,14}-\d+\b/g)) {
        fragment.append(text.slice(offset, match.index));
        const wrapper = documentRef.createElement('span');
        wrapper.className = '_JX_global_copy_reference';
        const key = documentRef.createElement('span');
        key.textContent = match[0];
        wrapper.append(key, makeButton(match[0]));
        fragment.append(wrapper);
        offset = match.index + match[0].length;
      }
      fragment.append(text.slice(offset));
      node.replaceWith(fragment);
    }
    observer.observe(documentRef.body, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href']});
  };
  const observer = new documentRef.defaultView.MutationObserver(records => {
    const relevant = records.some(record => {
      const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      return !element?.closest('._JX_container, ._JX_snack, ._JX_inline_copy_button');
    });
    if (!relevant) return;
    if (!frame) frame = documentRef.defaultView.requestAnimationFrame(scan);
  });
  scan();
  return () => {
    observer.disconnect();
    if (frame) documentRef.defaultView.cancelAnimationFrame(frame);
    for (const {button} of references.values()) button.remove();
    for (const wrapper of documentRef.querySelectorAll('._JX_global_copy_reference')) {
      wrapper.replaceWith(documentRef.createTextNode(wrapper.firstChild.textContent));
    }
  };
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
    return installAllowedPageCopyButtons(documentRef, instanceUrl, copy);
  }

  let scanFrame = 0;
  const scan = () => {
    scanFrame = 0;
    for (const selector of HEADER_LINK_SELECTORS) {
      const issueElement = documentRef.querySelector(selector);
      const key = getIssueKey(issueElement);
      const summary = getIssueSummary(documentRef, issueElement);
      if (!issueElement || !key || !summary || issueElement.closest('._JX_container')) {
        continue;
      }
      removeStaleCopyButtons(issueElement, key, summary);
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
    installNativeCommentCopyButtons(documentRef, copy);

    for (const issueElement of documentRef.querySelectorAll(RESULT_LINK_SELECTOR)) {
      const key = getIssueKey(issueElement);
      const elementText = String(issueElement.textContent || '').trim();
      const resultContainer = getResultContainer(issueElement);
      const isKeyOnlyLink = elementText.toUpperCase() === key;
      const hasSeparateKey = !!resultContainer && !!findResultKeyElement(resultContainer, key);
      const copyTarget = isKeyOnlyLink
        ? (findResultCopyTarget(resultContainer) || issueElement)
        : issueElement;
      if (!key || isIssueHeaderLink(issueElement)
        || (!elementText.toUpperCase().includes(key) && !hasSeparateKey)
        || issueElement.closest('._JX_container')) {
        continue;
      }
      const resultSummary = getResultSummary(copyTarget, key);
      reconcileResultCopyButton(documentRef, copyTarget, {
        key,
        summary: resultSummary,
        url: buildIssueUrl(instanceUrl, key),
      }, copy);
    }

    for (const candidate of documentRef.querySelectorAll(RESULT_KEY_SELECTOR)) {
      const key = getIssueKey(candidate);
      const issueElement = findResultKeyElement(candidate, key) || candidate;
      const resultContainer = getResultContainer(issueElement);
      const hasSeparateSummaryLink = !!resultContainer && Array.from(resultContainer.querySelectorAll(RESULT_LINK_SELECTOR))
        .some(link => String(link.textContent || '').trim().toUpperCase() !== key);
      if (!key || !issueElement || hasSeparateSummaryLink || issueElement.closest('._JX_container')) {
        continue;
      }
      const resultSummary = getResultSummary(issueElement, key);
      if (!resultSummary) {
        continue;
      }
      reconcileResultCopyButton(documentRef, issueElement, {
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
      const resultSummary = getResultSummary(issueElement, key);
      if (!resultSummary) {
        continue;
      }
      reconcileResultCopyButton(documentRef, issueElement, {
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
  const observer = new MutationObserver(records => {
    if (!records.every(isOwnCopyButtonAddition)) {
      scheduleScan();
    }
  });
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
