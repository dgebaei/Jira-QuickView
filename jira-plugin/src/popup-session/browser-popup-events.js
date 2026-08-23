const EVENT_NAMESPACE = '.jiraQuickViewPopupPresentation';

const PRESENTATION_EVENTS = [
  {selector: '._JX_actions_toggle', intent: () => ({type: 'toggle-actions'})},
  {selector: '._JX_pin_button', intent: () => ({type: 'pin'})},
  {selector: '._JX_close_button', intent: () => ({type: 'close-popup'})},
  {
    selector: '._JX_children_sort',
    intent: element => ({type: 'sort-children', column: element.getAttribute('data-sort-column') || ''}),
  },
  {
    selector: '._JX_pr_sort',
    intent: element => ({type: 'sort-pull-requests', column: element.getAttribute('data-sort-column') || ''}),
  },
  {selector: '._JX_comment_sort_toggle', intent: () => ({type: 'toggle-comment-sort'})},
  {selector: '._JX_watchers_trigger', intent: () => ({type: 'toggle-watchers'})},
  {selector: '._JX_watchers_close', intent: () => ({type: 'close-watchers'})},
  {selector: '._JX_linked_issues_trigger', intent: () => ({type: 'toggle-linkedIssues'})},
  {selector: '._JX_linked_issues_close', intent: () => ({type: 'close-linkedIssues'})},
  {selector: '._JX_history_toggle', intent: () => ({type: 'toggle-history'})},
  {selector: '._JX_history_close', intent: () => ({type: 'close-history'})},
  {
    selector: '._JX_previewable',
    intent: element => ({
      type: 'open-preview',
      source: element.getAttribute('data-jx-preview-src') || element.getAttribute('src') || '',
    }),
  },
  {
    selector: '._JX_thumb',
    intent: (element, event) => typeof event.target?.closest === 'function' && event.target.closest('img._JX_previewable')
      ? null
      : {type: 'open-preview', source: element.getAttribute('data-preview-src') || element.getAttribute('data-url') || ''},
  },
  {
    selector: '._JX_history_attachment_preview',
    intent: element => ({type: 'open-preview', source: element.getAttribute('data-jx-preview-src') || ''}),
  },
  {
    selector: '._JX_preview_overlay',
    intent: (element, event) => event.target === element ? {type: 'close-preview'} : null,
  },
  {event: 'dragstop', selector: '._JX_container', intent: () => ({type: 'pin-after-drag'})},
];
const PRESENTATION_CLICK_SELECTOR = PRESENTATION_EVENTS
  .filter(definition => !definition.event || definition.event === 'click')
  .map(definition => definition.selector)
  .join(', ');

export function createBrowserPopupEvents({root, emit}) {
  if (typeof root?.on !== 'function' || typeof root?.off !== 'function') {
    throw new TypeError('Browser popup events require a delegated event root');
  }
  if (typeof emit !== 'function') {
    throw new TypeError('Browser popup events require emit()');
  }
  let installed = false;

  function publish(intent) {
    if (!intent) return;
    try {
      Promise.resolve(emit(intent)).catch(() => {});
    } catch (error) {
      // A browser event must not break unrelated host-page handlers.
    }
  }

  function install() {
    if (installed) return {kind: 'unchanged'};
    PRESENTATION_EVENTS.forEach(definition => {
      root.on(`${definition.event || 'click'}${EVENT_NAMESPACE}`, definition.selector, function (event) {
        event.preventDefault();
        event.stopPropagation();
        publish(definition.intent(event.currentTarget, event));
      });
    });
    root.on(`mousedown${EVENT_NAMESPACE}`, function (event) {
      const target = event.target;
      const closest = selector => typeof target?.closest === 'function' && target.closest(selector);
      if (!closest('._JX_watchers_group, ._JX_history_toggle, ._JX_linked_issues_group')) {
        publish({type: 'dismiss-watchers'});
      }
      if (!closest('._JX_linked_issues_group, ._JX_history_toggle, ._JX_watchers_group')) {
        publish({type: 'dismiss-linkedIssues'});
      }
    });
    root.on(`click${EVENT_NAMESPACE}`, function (event) {
      const target = event.target;
      const closest = selector => typeof target?.closest === 'function' && target.closest(selector);
      if (!closest('._JX_actions')) publish({type: 'dismiss-actions'});
      if (!closest('._JX_history_flyout, ._JX_history_toggle')) publish({type: 'dismiss-history'});
      if (!closest('._JX_container') && !closest(PRESENTATION_CLICK_SELECTOR)) publish({type: 'dismiss-popup'});
    });
    root.on(`keydown${EVENT_NAMESPACE}`, function (event) {
      if (event.key === 'Escape' || event.keyCode === 27) publish({type: 'escape'});
    });
    installed = true;
    return {kind: 'installed'};
  }

  function dispose() {
    if (!installed) return {kind: 'unchanged'};
    root.off(EVENT_NAMESPACE);
    installed = false;
    return {kind: 'disposed'};
  }

  return {install, dispose};
}
