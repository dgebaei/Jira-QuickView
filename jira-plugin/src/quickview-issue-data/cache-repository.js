export function createIssueDataCacheRepository(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const epochs = new Map();
  const inFlight = new Map();
  const resolved = new Map();

  function buildKey(family, key) {
    return `${family}::${key}`;
  }

  function getEpoch(logicalKey) {
    return epochs.get(logicalKey) || 0;
  }

  function invalidate(family, key) {
    const logicalKey = buildKey(family, key);
    epochs.set(logicalKey, getEpoch(logicalKey) + 1);
    resolved.delete(logicalKey);
    inFlight.delete(logicalKey);
  }

  function invalidateFamily(family) {
    const prefix = `${family}::`;
    const logicalKeys = new Set([
      ...epochs.keys(),
      ...resolved.keys(),
      ...inFlight.keys(),
    ]);
    logicalKeys.forEach(logicalKey => {
      if (!logicalKey.startsWith(prefix)) return;
      epochs.set(logicalKey, getEpoch(logicalKey) + 1);
      resolved.delete(logicalKey);
      inFlight.delete(logicalKey);
    });
  }

  async function read({family, key, load, ttlMs}) {
    const logicalKey = buildKey(family, key);
    const now = clock();
    const existing = resolved.get(logicalKey);
    if (existing && now < existing.expiresAt) {
      return existing.value;
    }

    const pending = inFlight.get(logicalKey);
    if (pending) {
      return pending.promise;
    }

    const epoch = getEpoch(logicalKey);
    const promise = Promise.resolve().then(load);
    inFlight.set(logicalKey, {epoch, promise});

    try {
      const value = await promise;
      const currentPending = inFlight.get(logicalKey);
      if (getEpoch(logicalKey) === epoch && currentPending?.promise === promise) {
        const loadedAt = clock();
        resolved.set(logicalKey, {
          expiresAt: loadedAt + Math.max(0, Number(ttlMs) || 0),
          loadedAt,
          value,
        });
      }
      return value;
    } finally {
      if (inFlight.get(logicalKey)?.promise === promise) {
        inFlight.delete(logicalKey);
      }
    }
  }

  return {invalidate, invalidateFamily, read};
}
