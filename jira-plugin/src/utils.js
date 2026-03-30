export function waitForDocument(cb) {
  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    cb();
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      cb();
    });
  }
}
