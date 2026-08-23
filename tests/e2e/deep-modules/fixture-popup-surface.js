function copyValue(value) {
  if (Array.isArray(value)) return value.map(copyValue);
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce((copy, [key, entry]) => {
      copy[key] = copyValue(entry);
      return copy;
    }, {});
  }
  return value;
}

export function createFixturePopupSurface(options = {}) {
  const frames = [];
  const hides = [];
  return {
    async render(frame, context = {}) {
      if (typeof options.beforeRender === 'function') await options.beforeRender(frame, context);
      if (typeof context.isCurrent === 'function' && !context.isCurrent()) return {kind: 'stale'};
      frames.push(copyValue(frame));
      return {kind: 'committed', renderRevision: frame.renderRevision};
    },
    async hide(details = {}) {
      hides.push(copyValue(details));
      return {kind: 'hidden'};
    },
    getFrames() {
      return copyValue(frames);
    },
    getHides() {
      return copyValue(hides);
    },
  };
}
