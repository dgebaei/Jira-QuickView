// One tooltip style for the whole popup. PR cells point at prepared detail
// popovers (data-pr-details); every other element's native title is shown in a
// shared popover. The title is set aside while hovered so the browser's own
// tooltip, which looks different on every platform, never appears.
// Native popovers escape the popup's scrolling/clipping ancestors. Positioning is
// measured rather than requiring a CSS-anchor polyfill on older Chrome versions.
const TITLE_DELAY_MS = 400;

export function installPopupTooltips(root, namespace) {
  let active = null;
  let activeTrigger = null;
  let hideTimer = null;
  let showTimer = null;
  let shared = null;
  let stashed = [];
  const detailsSelector = '[data-pr-details]';
  const titleSelector = '._JX_container [title]';
  const tooltipSelector = '._JX_tooltip';
  const documentRef = root[0]?.ownerDocument;
  const windowRef = documentRef?.defaultView;

  function cancelHide() {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  function restoreTitles() {
    clearTimeout(showTimer);
    showTimer = null;
    stashed.forEach(node => {
      node.setAttribute('title', node.getAttribute('data-jx-title') || '');
      node.removeAttribute('data-jx-title');
    });
    stashed = [];
  }

  function hide() {
    cancelHide();
    restoreTitles();
    if (active?.isConnected && active.matches(':popover-open')) active.hidePopover();
    if (active) active.hidden = true;
    active = null;
    activeTrigger = null;
  }

  function open(trigger, tooltip) {
    tooltip.hidden = false;
    tooltip.showPopover();
    active = tooltip;
    activeTrigger = trigger;
    position(trigger, tooltip);
  }

  function showDetails(trigger) {
    const tooltip = trigger.ownerDocument.getElementById(trigger.getAttribute('data-pr-details'));
    if (!tooltip) return;
    if (typeof tooltip.showPopover !== 'function') {
      trigger.setAttribute('title', tooltip.textContent);
      return;
    }
    cancelHide();
    if (active === tooltip) return;
    hide();
    open(trigger, tooltip);
  }

  function sharedTooltip() {
    if (!shared?.isConnected) {
      shared = documentRef.createElement('span');
      shared.className = '_JX_tooltip is-plain';
      shared.setAttribute('popover', 'manual');
      shared.setAttribute('role', 'tooltip');
      shared.setAttribute('data-testid', 'jira-popup-tooltip');
      shared.hidden = true;
      documentRef.body.append(shared);
    }
    return shared;
  }

  function showTitle(trigger) {
    if (typeof documentRef.body.showPopover !== 'function' || trigger.closest(detailsSelector)) return;
    if (activeTrigger === trigger) return;
    hide();
    // Every titled ancestor too: the browser would fall back to the nearest one.
    const container = trigger.closest('._JX_container');
    for (let node = trigger; node && node !== container.parentNode; node = node.parentElement) {
      if (!node.hasAttribute('title')) continue;
      node.setAttribute('data-jx-title', node.getAttribute('title'));
      node.removeAttribute('title');
      stashed.push(node);
    }
    const text = trigger.getAttribute('data-jx-title').trim();
    // An open dropdown already sits where the tooltip would.
    if (!text || trigger.matches('[aria-expanded="true"]')) return;
    activeTrigger = trigger;
    showTimer = setTimeout(() => {
      showTimer = null;
      if (activeTrigger !== trigger || !trigger.isConnected) return;
      const tooltip = sharedTooltip();
      tooltip.replaceChildren(...text.split('\n').map(line => {
        const span = documentRef.createElement('span');
        span.textContent = line;
        return span;
      }));
      open(trigger, tooltip);
    }, TITLE_DELAY_MS);
  }

  function position(trigger, tooltip) {
    const bounds = trigger.getBoundingClientRect();
    const popup = tooltip.getBoundingClientRect();
    const viewport = trigger.ownerDocument.documentElement;
    tooltip.style.insetInlineStart = `${Math.max(8, Math.min(bounds.left, viewport.clientWidth - popup.width - 8))}px`;
    tooltip.style.insetBlockStart = `${bounds.bottom + popup.height + 8 < viewport.clientHeight ? bounds.bottom + 6 : Math.max(8, bounds.top - popup.height - 6)}px`;
  }

  root.on(`mouseenter${namespace} focusin${namespace}`, detailsSelector, event => showDetails(event.currentTarget));
  root.on(`mouseleave${namespace} focusout${namespace}`, `${detailsSelector}, ${tooltipSelector}`, () => {
    if (active === shared) return;
    cancelHide();
    hideTimer = setTimeout(() => {
      if (active?.matches(':hover') || activeTrigger?.matches(':focus, :hover')) return;
      hide();
    }, 160);
  });
  root.on(`mouseenter${namespace}`, tooltipSelector, cancelHide);
  root.on(`mouseover${namespace}`, event => {
    const trigger = event.target.closest?.(`${titleSelector}, ._JX_container [data-jx-title]`);
    if (trigger && !trigger.closest(detailsSelector)) {
      showTitle(trigger);
      return;
    }
    // Leaving a titled element, or it was re-rendered away under the pointer.
    if (stashed.length && !event.target.closest?.(detailsSelector)) hide();
  });
  root.on(`mousedown${namespace}`, () => {
    if (stashed.length) hide();
  });
  root.on(`keydown${namespace}`, event => {
    if (event.key !== 'Escape' || !active?.isConnected || !active.matches(':popover-open')) return;
    hide();
    event.preventDefault();
    event.stopImmediatePropagation();
  });
  function handleScroll() {
    // Hovering can scroll the target into view just after mouseover; a pending
    // title tooltip must survive that, so only a visible one is dismissed.
    if (!active) return;
    // Focusing a row can scroll it into view after focusin. Keep its keyboard
    // details open and positioned; pointer-only tooltips can safely dismiss.
    if (active?.isConnected && active !== shared && activeTrigger?.matches(':focus')) position(activeTrigger, active);
    else hide();
  }
  documentRef?.addEventListener('scroll', handleScroll, true);
  windowRef?.addEventListener('resize', hide);
  return () => {
    hide();
    shared?.remove();
    documentRef?.removeEventListener('scroll', handleScroll, true);
    windowRef?.removeEventListener('resize', hide);
  };
}
