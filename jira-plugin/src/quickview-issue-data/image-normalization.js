function isDataUrl(url) {
  return /^data:image\//i.test(String(url || ''));
}

function absoluteUrl(instanceUrl, url) {
  const value = String(url || '').trim();
  if (!value || isDataUrl(value)) return value;
  try {
    return new URL(value, instanceUrl).toString();
  } catch (error) {
    return value;
  }
}

function attachmentProxyUrl(instanceUrl, url) {
  const resolved = absoluteUrl(instanceUrl, url);
  try {
    const parsed = new URL(resolved);
    const instance = new URL(instanceUrl);
    if (parsed.origin === instance.origin && /^\/rest\/api\/(?:2|3)\/attachment\/(?:content|thumbnail)\//i.test(parsed.pathname)) {
      parsed.searchParams.set('redirect', 'false');
      return parsed.toString();
    }
  } catch (error) {
    return resolved;
  }
  return resolved;
}

function isLikelyDefaultUserAvatar(user, avatarUrl) {
  if (user?.isDefaultAvatar === true) return true;
  const normalizedUrl = String(avatarUrl || '').toLowerCase();
  if (!normalizedUrl) return false;
  return normalizedUrl.startsWith('data:image/svg+xml;base64,phn2zybpzd0iv2fyc3r3yvgx') ||
    normalizedUrl.includes('defaultavatar') ||
    normalizedUrl.includes('/avatar.png') ||
    normalizedUrl.includes('avatar/default') ||
    normalizedUrl.includes('initials=') ||
    (normalizedUrl.includes('/initials/') && normalizedUrl.includes('avatar')) ||
    (/\buseravatar\b/.test(normalizedUrl) && !normalizedUrl.includes('ownerid='));
}

function hasInitialsSource(user) {
  return !!String(user?.displayName || user?.name || user?.username || user?.emailAddress || '').trim();
}

export function createImageNormalization(options = {}) {
  const cache = options.cache;
  const instanceUrl = options.instanceUrl;
  const jira = options.jira;
  const ttlMs = options.ttlMs;

  async function resolve(url, mimeType = '', signal) {
    const resolved = absoluteUrl(instanceUrl, url);
    if (!resolved || isDataUrl(resolved)) return resolved;
    try {
      if (new URL(resolved).origin !== new URL(instanceUrl).origin) return resolved;
    } catch (error) {
      return resolved;
    }
    const path = attachmentProxyUrl(instanceUrl, resolved);
    try {
      return await cache.read({
        family: 'image',
        key: path,
        ttlMs,
        load: () => jira.image({url: path, mimeType, signal}),
      });
    } catch (error) {
      return resolved;
    }
  }

  async function normalizeUser(user, signal) {
    if (!user || typeof user !== 'object') return user;
    const raw = user?.avatarUrls?.['48x48'] || user?.avatarUrl || '';
    if (!raw) return user;
    const isDefaultAvatar = isLikelyDefaultUserAvatar(user, raw);
    user.isDefaultAvatar = isDefaultAvatar;
    if (isDefaultAvatar && hasInitialsSource(user)) {
      user.defaultAvatarUrl = raw;
      user.avatarUrls = {...(user.avatarUrls || {}), '48x48': ''};
      user.avatarUrl = '';
      return user;
    }
    const avatarUrl = await resolve(raw, '', signal);
    user.avatarUrls = {...(user.avatarUrls || {}), '48x48': avatarUrl};
    user.avatarUrl = avatarUrl;
    return user;
  }

  async function normalizeUsers(users, signal) {
    await Promise.all((users || []).map(user => normalizeUser(user, signal)));
    return users;
  }

  async function normalizeAttachment(attachment, signal) {
    if (!attachment || typeof attachment !== 'object') return attachment;
    const mimeType = String(attachment.mimeType || '');
    const content = absoluteUrl(instanceUrl, attachment.rawContentUrl || attachment.content);
    const thumbnail = absoluteUrl(instanceUrl, attachment.rawThumbnailUrl || attachment.thumbnail || content);
    if (!mimeType.toLowerCase().startsWith('image/')) {
      Object.assign(attachment, {
        rawContentUrl: content,
        rawThumbnailUrl: thumbnail,
        content,
        inlineDataUrl: '',
        previewDataUrl: '',
        displayContent: '',
        previewDisplaySrc: '',
        thumbnail: '',
      });
      return attachment;
    }
    const inline = isDataUrl(attachment.inlineDataUrl)
      ? attachment.inlineDataUrl
      : await resolve(thumbnail || content, mimeType, signal);
    const preview = isDataUrl(attachment.previewDataUrl)
      ? attachment.previewDataUrl
      : await resolve(content || thumbnail, mimeType, signal);
    Object.assign(attachment, {
      rawContentUrl: content,
      rawThumbnailUrl: thumbnail,
      content,
      inlineDataUrl: isDataUrl(inline) ? inline : '',
      previewDataUrl: isDataUrl(preview) ? preview : (isDataUrl(inline) ? inline : ''),
      displayContent: isDataUrl(inline) ? inline : '',
      previewDisplaySrc: isDataUrl(preview) ? preview : (isDataUrl(inline) ? inline : ''),
      thumbnail: isDataUrl(inline) ? inline : thumbnail,
    });
    return attachment;
  }

  async function normalizeCore(issue, signal) {
    const fields = issue?.fields || {};
    const users = [fields.reporter, fields.assignee, ...(fields.comment?.comments || []).map(comment => comment?.author)].filter(Boolean);
    Object.keys(fields).filter(key => key.startsWith('customfield_')).forEach(key => {
      const values = Array.isArray(fields[key]) ? fields[key] : [fields[key]];
      values.filter(value => value?.avatarUrls).forEach(value => users.push(value));
    });
    const icons = [fields.issuetype, fields.status, fields.priority].filter(item => item?.iconUrl);
    await Promise.all([
      normalizeUsers(users, signal),
      ...icons.map(async item => { item.iconUrl = await resolve(item.iconUrl, '', signal); }),
      ...(fields.attachment || []).map(attachment => normalizeAttachment(attachment, signal)),
    ]);
    return issue;
  }

  async function normalizeIssues(issues, signal) {
    const users = [];
    const promises = [];
    (issues || []).forEach(issue => {
      if (issue?.fields?.assignee) users.push(issue.fields.assignee);
      if (issue?.fields?.issuetype?.iconUrl) {
        promises.push(resolve(issue.fields.issuetype.iconUrl, '', signal).then(url => { issue.fields.issuetype.iconUrl = url; }));
      }
    });
    await Promise.all([...promises, normalizeUsers(users, signal)]);
    return issues;
  }

  async function normalizePullRequests(items, signal) {
    await normalizeUsers((items || []).map(item => item?.author).filter(Boolean), signal);
    return items;
  }

  return {normalizeCore, normalizeIssues, normalizePullRequests, normalizeUsers, resolve};
}
