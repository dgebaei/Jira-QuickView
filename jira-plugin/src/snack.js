// One toast for every QuickView message. While a popup is open it floats just
// under the popup's header, next to what was edited; otherwise it sits at the
// bottom of the viewport. As a popover it is in the top layer, so neither the
// page nor the popup can stack over it.
let toast = null;
let hideTimer = null;

function toastElement() {
  if (toast?.isConnected) return toast;
  toast = document.createElement('div');
  toast.className = '_JX_toast';
  toast.setAttribute('data-testid', 'jira-toast');
  if (typeof toast.showPopover === 'function') toast.setAttribute('popover', 'manual');
  toast.hidden = true;
  document.body.append(toast);
  return toast;
}

function place(node) {
  const header = [...document.querySelectorAll('._JX_container ._JX_title')].find(item => item.getClientRects().length);
  const popup = header?.closest('._JX_annotation')?.getBoundingClientRect();
  const viewport = document.documentElement;
  const width = node.offsetWidth;
  const center = popup ? popup.left + popup.width / 2 : viewport.clientWidth / 2;
  node.style.insetInlineStart = `${Math.max(8, Math.min(center - width / 2, viewport.clientWidth - width - 8))}px`;
  node.style.insetBlockStart = popup
    ? `${header.getBoundingClientRect().bottom + 8}px`
    : `${viewport.clientHeight - node.offsetHeight - 20}px`;
}

export function hideToast() {
  clearTimeout(hideTimer);
  hideTimer = null;
  if (!toast?.isConnected) return;
  if (toast.matches(':popover-open')) toast.hidePopover();
  toast.hidden = true;
}

// kind: 'success' and 'error' carry a mark; 'info' is neutral. A timeout of 0
// keeps a progress message until the next toast replaces it.
export function showToast(message, {kind = 'info', timeout = 2000} = {}) {
  if (!message) return;
  const node = toastElement();
  clearTimeout(hideTimer);
  node.className = `_JX_toast _JX_toast_${kind}`;
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  node.textContent = message;
  node.hidden = false;
  if (node.matches(':popover-open')) node.hidePopover();
  node.showPopover?.();
  place(node);
  if (timeout) hideTimer = setTimeout(hideToast, timeout);
}
