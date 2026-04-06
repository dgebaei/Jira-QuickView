export function createContentPeopleHelpers(options) {
  const areSameJiraUser = options?.areSameJiraUser;
  const buildEditOption = options?.buildEditOption;
  const cacheKnownJiraUser = options?.cacheKnownJiraUser;
  const cacheKnownJiraUsers = options?.cacheKnownJiraUsers;
  const getDisplayImageUrl = options?.getDisplayImageUrl;
  const sharedAvatarUrls = options?.sharedAvatarUrls;

  function getUserInitials(displayName, fallbackInitials = '--') {
    const tokens = String(displayName || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!tokens.length) {
      return fallbackInitials;
    }
    if (tokens.length === 1) {
      return tokens[0].slice(0, 2).toUpperCase();
    }
    return `${tokens[0][0] || ''}${tokens[tokens.length - 1][0] || ''}`.toUpperCase();
  }

  function isLikelyDefaultAvatar(user, avatarUrl) {
    if (!avatarUrl) {
      return true;
    }
    if (user?.isDefaultAvatar === true) {
      return true;
    }
    const jiraDefaultAvatarDataUri = 'data:image/svg+xml;base64,PHN2ZyBpZD0iV2Fyc3R3YV8xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+CiAgPHN0eWxlPgogICAgLnN0MHtmaWxsOiNjMWM3ZDB9CiAgPC9zdHlsZT4KICA8cGF0aCBjbGFzcz0ic3QwIiBkPSJNMTIgMjRDNS40IDI0IDAgMTguNiAwIDEyUzUuNCAwIDEyIDBzMTIgNS40IDEyIDEyLTUuNCAxMi0xMiAxMnoiLz4KICA8cGF0aCBkPSJNMTkuNSAxMmMwLS45LS42LTEuNy0xLjUtMS45LS4yLTMuMS0yLjgtNS42LTYtNS42UzYuMiA3IDYgMTAuMWMtLjkuMi0xLjUgMS0xLjUgMS45IDAgMSAuNyAxLjggMS43IDIgLjYgMi44IDMgNS41IDUuOCA1LjVzNS4yLTIuNyA1LjgtNS41YzEtLjIgMS43LTEgMS43LTJ6IiBmaWxsPSIjZjRmNWY3Ii8+CiAgPHBhdGggY2xhc3M9InN0MCIgZD0iTTEyIDE2LjljLTEgMC0yLS43LTIuMy0xLjYtLjEtLjMgMC0uNS4zLS42LjMtLjEuNSAwIC42LjMuMi42LjggMSAxLjQgMSAuNiAwIDEuMi0uNCAxLjQtMSAuMS0uMy40LS40LjYtLjMuMy4xLjQuNC4zLjYtLjMuOS0xLjMgMS42LTIuMyAxLjZ6Ii8+Cjwvc3ZnPg==';
    const normalizedUrl = String(avatarUrl || '').toLowerCase();
    if (avatarUrl === jiraDefaultAvatarDataUri ||
      normalizedUrl.includes('defaultavatar') ||
      normalizedUrl.includes('/avatar.png') ||
      normalizedUrl.includes('avatar/default') ||
      normalizedUrl.includes('initials=')) {
      return true;
    }
    if (/\buseravatar\b/.test(normalizedUrl) && !normalizedUrl.includes('ownerid=')) {
      return true;
    }
    if (avatarUrl && sharedAvatarUrls.has(avatarUrl)) {
      return true;
    }
    return false;
  }

  function detectSharedAvatarUrls(users) {
    if (!Array.isArray(users) || users.length < 2) {
      return;
    }
    const urlCounts = new Map();
    for (const user of users) {
      const url = user?.avatarUrls?.['48x48'] || '';
      if (url) {
        urlCounts.set(url, (urlCounts.get(url) || 0) + 1);
      }
    }
    for (const [url, count] of urlCounts) {
      if (count >= 2) {
        sharedAvatarUrls.add(url);
      }
    }
  }

  function buildUserView(user) {
    const displayName = user?.displayName || user?.name || user?.username || user?.emailAddress || '';
    const rawAvatarUrl = user?.avatarUrls?.['48x48'] || '';
    const useInitials = isLikelyDefaultAvatar(user, rawAvatarUrl);
    return {
      displayName,
      avatarUrl: useInitials ? '' : rawAvatarUrl,
      initials: getUserInitials(displayName, '--'),
      accountId: user?.accountId || '',
      name: user?.name || user?.username || '',
      key: user?.key || '',
      emailAddress: user?.emailAddress || '',
    };
  }

  async function proxyUserAvatars(users) {
    const beforeUrls = new Map();
    (users || []).forEach(user => {
      const url = user?.avatarUrls?.['48x48'];
      if (url) beforeUrls.set(user, url);
    });
    await Promise.all((users || []).map(user => {
      const url = user?.avatarUrls?.['48x48'];
      if (!url) return Promise.resolve();
      return getDisplayImageUrl(url).then(src => { user.avatarUrls['48x48'] = src; }).catch(() => {});
    }));
    for (const [user, rawUrl] of beforeUrls) {
      const proxiedUrl = user?.avatarUrls?.['48x48'];
      if (proxiedUrl && proxiedUrl !== rawUrl && sharedAvatarUrls.has(rawUrl)) {
        sharedAvatarUrls.add(proxiedUrl);
      }
    }
    return users;
  }

  function normalizeAssignableUsers(users) {
    const uniqueById = new Map();
    cacheKnownJiraUsers(users);
    (Array.isArray(users) ? users : []).forEach(user => {
      const view = buildUserView(user);
      const id = view.accountId || view.name || view.key;
      if (!id || uniqueById.has(id)) {
        return;
      }
      const option = buildEditOption(id, view.displayName || id, {
        avatarUrl: view.avatarUrl,
        initials: view.initials,
        metaText: view.emailAddress || view.name || view.key || '',
        searchText: `${view.displayName} ${view.name} ${view.key} ${view.emailAddress}`,
        rawValue: {
          accountId: view.accountId,
          name: view.name,
          key: view.key
        }
      });
      if (option.id && option.label) {
        uniqueById.set(id, option);
      }
    });
    return [...uniqueById.values()];
  }

  function getJiraUserIdentityCandidates(user) {
    return [user?.accountId, user?.name, user?.username, user?.key]
      .map(value => String(value || '').trim())
      .filter((value, index, array) => value && array.indexOf(value) === index);
  }

  function buildWatcherUserView(user, currentUser = null) {
    const view = buildUserView(user);
    const displayName = view.displayName || 'Unknown user';
    const identityCandidates = getJiraUserIdentityCandidates(user);
    const id = identityCandidates[0] || '';
    return {
      id,
      accountId: view.accountId,
      name: view.name,
      key: view.key,
      displayName,
      avatarUrl: view.avatarUrl,
      initials: view.initials,
      metaText: view.emailAddress || view.name || view.key || '',
      titleText: `Watcher: ${displayName}`,
      isCurrentUser: areSameJiraUser(user, currentUser),
      rawValue: {
        accountId: view.accountId,
        name: view.name,
        key: view.key,
      }
    };
  }

  function compareWatcherUsers(left, right) {
    if (!!left?.isCurrentUser !== !!right?.isCurrentUser) {
      return left?.isCurrentUser ? -1 : 1;
    }
    const displayNameComparison = String(left?.displayName || '').localeCompare(
      String(right?.displayName || ''),
      undefined,
      {sensitivity: 'base'}
    );
    if (displayNameComparison !== 0) {
      return displayNameComparison;
    }
    return String(left?.id || '').localeCompare(String(right?.id || ''), undefined, {sensitivity: 'base'});
  }

  function normalizeWatcherUsers(users, currentUser = null) {
    cacheKnownJiraUsers(users);
    cacheKnownJiraUser(currentUser);
    const uniqueById = new Map();
    (Array.isArray(users) ? users : []).forEach(user => {
      const watcher = buildWatcherUserView(user, currentUser);
      if (watcher.id && !uniqueById.has(watcher.id)) {
        uniqueById.set(watcher.id, watcher);
      }
    });
    return [...uniqueById.values()].sort(compareWatcherUsers);
  }

  return {
    buildUserView,
    detectSharedAvatarUrls,
    normalizeAssignableUsers,
    normalizeWatcherUsers,
    proxyUserAvatars,
  };
}
