function requireOperation(owner, operation) {
  if (typeof owner?.[operation] !== 'function') {
    throw new TypeError(`Browser popup shell requires ${operation}()`);
  }
}

export function createBrowserPopupShell({
  announce = () => {},
  close,
  container,
  media,
  previewOverlay,
  scheduler = {set: setTimeout, clear: clearTimeout},
  viewport = window,
}) {
  if (typeof close !== 'function') throw new TypeError('Browser popup shell requires close()');
  requireOperation(container, 'html');
  requireOperation(media, 'displayUrl');
  requireOperation(previewOverlay, 'find');
  requireOperation(scheduler, 'set');
  requireOperation(scheduler, 'clear');

  let cooldownActive = false;
  let cooldownTimer = null;
  let hideTimer = null;
  let pinned = false;
  let previewOpen = false;
  let previewRequest = 0;
  let previewSource = '';

  function outcome(kind, details = {}) {
    return {kind, ...details};
  }

  function view() {
    return {cooldownActive, pinned, previewOpen, previewSource};
  }

  function cancelCooldown() {
    if (cooldownTimer !== null) scheduler.clear(cooldownTimer);
    cooldownTimer = null;
    cooldownActive = false;
  }

  function cancelHide() {
    if (hideTimer !== null) scheduler.clear(hideTimer);
    hideTimer = null;
  }

  function clamp(left, top) {
    const margin = 8;
    const width = container.outerWidth() || 0;
    const height = container.outerHeight() || 0;
    const viewportLeft = viewport.scrollX + margin;
    const viewportTop = viewport.scrollY + margin;
    const viewportRight = viewport.scrollX + viewport.innerWidth - margin;
    const viewportBottom = viewport.scrollY + viewport.innerHeight - margin;
    return {
      left: Math.min(Math.max(left, viewportLeft), Math.max(viewportLeft, viewportRight - width)),
      top: Math.min(Math.max(top, viewportTop), Math.max(viewportTop, viewportBottom - height)),
    };
  }

  function position(anchor = {}) {
    const pointerX = Number(anchor.x) || 0;
    const pointerY = Number(anchor.y) || 0;
    const width = container.outerWidth() || 0;
    const height = container.outerHeight() || 0;
    const viewportRight = viewport.scrollX + viewport.innerWidth - 8;
    const viewportBottom = viewport.scrollY + viewport.innerHeight - 8;
    let left = pointerX + 20;
    let top = pointerY + 25;
    if (left + width > viewportRight) left = pointerX - width - 15;
    if (top + height > viewportBottom) top = pointerY - height - 15;
    return clamp(left, top);
  }

  function pin({announce: shouldAnnounce = true} = {}) {
    cancelHide();
    if (pinned || !container.html()) return outcome('ignored', {reason: pinned ? 'already-pinned' : 'empty-popup'});
    const scrollingElement = viewport.document?.scrollingElement || viewport.document?.documentElement;
    const scrollLeft = scrollingElement?.scrollLeft || viewport.scrollX || 0;
    const scrollTop = scrollingElement?.scrollTop || viewport.scrollY || 0;
    const currentPosition = container.position();
    container.addClass('container-pinned').css({
      left: currentPosition.left - scrollLeft,
      top: currentPosition.top - scrollTop,
    });
    pinned = true;
    if (shouldAnnounce) announce('Ticket Pinned! Hit esc to close !');
    return outcome('pinned');
  }

  function closePreview() {
    previewRequest += 1;
    previewOpen = false;
    previewSource = '';
    previewOverlay.removeClass('is-open');
    previewOverlay.find('img').attr('src', '');
    return outcome('preview-closed');
  }

  async function dispatch(intent = {}) {
    if (intent.type === 'pin') return pin(intent);
    if (intent.type === 'keep-visible') {
      if (pinned || !container.html()) return outcome('ignored', {reason: pinned ? 'pinned' : 'empty-popup'});
      const currentLeft = Number.parseFloat(container.css('left'));
      const currentTop = Number.parseFloat(container.css('top'));
      container.css(clamp(
        Number.isFinite(currentLeft) ? currentLeft : viewport.scrollX + 8,
        Number.isFinite(currentTop) ? currentTop : viewport.scrollY + 8
      ));
      return outcome('positioned');
    }
    if (intent.type === 'open-preview') {
      const source = String(intent.source || '');
      if (!source) return outcome('ignored', {reason: 'missing-preview-source'});
      cancelHide();
      pin({announce: false});
      const requestId = ++previewRequest;
      const displaySource = await media.displayUrl(source);
      if (requestId !== previewRequest) return outcome('ignored', {reason: 'stale-preview'});
      previewOpen = true;
      previewSource = source;
      previewOverlay.find('img').attr('src', displaySource || source);
      previewOverlay.addClass('is-open');
      return outcome('preview-opened');
    }
    if (intent.type === 'close-preview') return closePreview();
    if (intent.type === 'schedule-hide') {
      cancelHide();
      if (pinned) return outcome('ignored', {reason: 'pinned'});
      const reason = String(intent.reason || 'pointer-exit');
      const delay = Math.max(0, Number(intent.delay) || 0);
      hideTimer = scheduler.set(() => {
        hideTimer = null;
        Promise.resolve(close({reason})).catch(() => {});
      }, delay);
      return outcome('hide-scheduled', {delay});
    }
    if (intent.type === 'cancel-hide') {
      cancelHide();
      return outcome('hide-cancelled');
    }
    if (intent.type === 'begin-cooldown') {
      cancelCooldown();
      const delay = Math.max(0, Number(intent.delay) || 0);
      cooldownActive = true;
      cooldownTimer = scheduler.set(() => {
        cooldownTimer = null;
        cooldownActive = false;
      }, delay);
      return outcome('cooldown-started', {delay});
    }
    if (intent.type === 'clear') {
      cancelCooldown();
      cancelHide();
      closePreview();
      pinned = false;
      container.html('').css({left: -5000, top: -5000, position: 'absolute'}).removeClass('container-pinned');
      return outcome('cleared');
    }
    return outcome('ignored', {reason: 'unsupported-intent'});
  }

  return {dispatch, position, view};
}
