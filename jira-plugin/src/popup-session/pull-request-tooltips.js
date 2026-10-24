// Native popovers escape the popup's scrolling/clipping ancestors. Positioning is
// measured rather than requiring a CSS-anchor polyfill on older Chrome versions.
export function installPullRequestTooltips(root, namespace) {
  let active = null;
  let activeTrigger = null;
  let hideTimer = null;
  const triggerSelector = '[data-pr-details]';
  const tooltipSelector = '._JX_pr_tooltip';

  function cancelHide() {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  function hide() {
    cancelHide();
    if (active?.isConnected && active.matches(':popover-open')) active.hidePopover();
    if (active) active.hidden = true;
    active = null;
    activeTrigger = null;
  }

  function show(trigger) {
    const tooltip = trigger.ownerDocument.getElementById(trigger.getAttribute('data-pr-details'));
    if (!tooltip) return;
    if (typeof tooltip.showPopover !== 'function') {
      trigger.setAttribute('title', tooltip.textContent);
      return;
    }
    cancelHide();
    if (active === tooltip) return;
    hide();
    active = tooltip;
    activeTrigger = trigger;
    tooltip.hidden = false;
    tooltip.showPopover();
    position(trigger, tooltip);
  }

  function position(trigger, tooltip) {
    const bounds = trigger.getBoundingClientRect();
    const popup = tooltip.getBoundingClientRect();
    const viewport = trigger.ownerDocument.documentElement;
    tooltip.style.insetInlineStart = `${Math.max(8, Math.min(bounds.left, viewport.clientWidth - popup.width - 8))}px`;
    tooltip.style.insetBlockStart = `${bounds.bottom + popup.height + 8 < viewport.clientHeight ? bounds.bottom + 6 : Math.max(8, bounds.top - popup.height - 6)}px`;
  }

  root.on(`mouseenter${namespace} focusin${namespace}`, triggerSelector, event => show(event.currentTarget));
  root.on(`mouseleave${namespace} focusout${namespace}`, `${triggerSelector}, ${tooltipSelector}`, () => {
    cancelHide();
    hideTimer = setTimeout(() => {
      if (active?.matches(':hover') || activeTrigger?.matches(':focus, :hover')) return;
      hide();
    }, 160);
  });
  root.on(`mouseenter${namespace}`, tooltipSelector, cancelHide);
  root.on(`keydown${namespace}`, event => {
    if (event.key !== 'Escape' || !active?.isConnected || !active.matches(':popover-open')) return;
    hide();
    event.preventDefault();
    event.stopImmediatePropagation();
  });
  const documentRef = root[0]?.ownerDocument;
  const windowRef = documentRef?.defaultView;
  function handleScroll() {
    // Focusing a row can scroll it into view after focusin. Keep its keyboard
    // details open and positioned; pointer-only tooltips can safely dismiss.
    if (active?.isConnected && activeTrigger?.matches(':focus')) position(activeTrigger, active);
    else hide();
  }
  documentRef?.addEventListener('scroll', handleScroll, true);
  windowRef?.addEventListener('resize', hide);
  return () => {
    hide();
    documentRef?.removeEventListener('scroll', handleScroll, true);
    windowRef?.removeEventListener('resize', hide);
  };
}
