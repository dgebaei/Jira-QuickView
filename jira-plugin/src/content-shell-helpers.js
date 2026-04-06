export function createContentShellHelpers(options) {
  const container = options?.container;
  const previewOverlay = options?.previewOverlay;
  const getDisplayImageUrl = options?.getDisplayImageUrl;
  const isContainerPinned = options?.isContainerPinned || (() => false);
  const clearHideTimeout = options?.clearHideTimeout || (() => {});
  const pinContainer = options?.pinContainer || (() => false);

  function clampContainerPosition(left, top) {
    const margin = 8;
    const width = container?.outerWidth() || 0;
    const height = container?.outerHeight() || 0;
    const viewportLeft = window.scrollX + margin;
    const viewportTop = window.scrollY + margin;
    const viewportRight = window.scrollX + window.innerWidth - margin;
    const viewportBottom = window.scrollY + window.innerHeight - margin;
    const maxLeft = Math.max(viewportLeft, viewportRight - width);
    const maxTop = Math.max(viewportTop, viewportBottom - height);

    return {
      left: Math.min(Math.max(left, viewportLeft), maxLeft),
      top: Math.min(Math.max(top, viewportTop), maxTop)
    };
  }

  function keepContainerVisible() {
    if (isContainerPinned() || !container?.html()) {
      return;
    }
    const currentLeft = Number.parseFloat(container.css('left'));
    const currentTop = Number.parseFloat(container.css('top'));
    const fallbackLeft = window.scrollX + 8;
    const fallbackTop = window.scrollY + 8;
    container.css(clampContainerPosition(
      Number.isFinite(currentLeft) ? currentLeft : fallbackLeft,
      Number.isFinite(currentTop) ? currentTop : fallbackTop
    ));
  }

  function computeVisibleContainerPosition(pointerX, pointerY) {
    const preferredLeft = pointerX + 20;
    const preferredTop = pointerY + 25;
    const width = container?.outerWidth() || 0;
    const height = container?.outerHeight() || 0;
    const viewportRight = window.scrollX + window.innerWidth - 8;
    const viewportBottom = window.scrollY + window.innerHeight - 8;

    let left = preferredLeft;
    let top = preferredTop;

    if (left + width > viewportRight) {
      left = pointerX - width - 15;
    }

    if (top + height > viewportBottom) {
      top = pointerY - height - 15;
    }

    return clampContainerPosition(left, top);
  }

  function closePreviewOverlay() {
    previewOverlay?.removeClass('is-open');
    previewOverlay?.find('img').attr('src', '');
  }

  async function openPreviewOverlay(imageUrl) {
    if (!imageUrl) {
      return;
    }
    clearHideTimeout();
    pinContainer({showNotice: false});
    const displaySrc = await getDisplayImageUrl(imageUrl);
    previewOverlay?.find('img').attr('src', displaySrc || imageUrl);
    previewOverlay?.addClass('is-open');
  }

  return {
    clampContainerPosition,
    keepContainerVisible,
    computeVisibleContainerPosition,
    closePreviewOverlay,
    openPreviewOverlay,
  };
}
