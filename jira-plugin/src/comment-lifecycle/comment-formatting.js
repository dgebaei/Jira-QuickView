function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function countSharedPrefixLength(left, right) {
  const leftText = String(left || '');
  const rightText = String(right || '');
  const maxLength = Math.min(leftText.length, rightText.length);
  let index = 0;
  while (index < maxLength && leftText[index] === rightText[index]) index += 1;
  return index;
}

function countSharedSuffixLength(left, right) {
  const leftText = String(left || '');
  const rightText = String(right || '');
  const maxLength = Math.min(leftText.length, rightText.length);
  let index = 0;
  while (index < maxLength && leftText[leftText.length - 1 - index] === rightText[rightText.length - 1 - index]) index += 1;
  return index;
}

function knownJiraUsers(issueSnapshot) {
  const users = [];
  const seenObjects = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object' || seenObjects.has(value)) return;
    seenObjects.add(value);
    if (value.displayName && (value.accountId || value.name || value.username || value.key)) users.push(value);
    if (Array.isArray(value)) value.forEach(visit);
    else Object.values(value).forEach(visit);
  }
  visit(issueSnapshot?.core?.fields || {});
  visit(issueSnapshot?.viewer?.user || null);
  return users;
}

function mentionDisplayText(rawValue, issueSnapshot) {
  const normalized = String(rawValue || '').trim();
  const identity = normalized.replace(/^accountid:/i, '');
  const user = knownJiraUsers(issueSnapshot).find(candidate => [candidate.accountId, candidate.name, candidate.username, candidate.key]
    .some(value => String(value || '').trim() === identity || String(value || '').trim() === normalized));
  const displayName = String(user?.displayName || user?.name || user?.username || user?.key || identity).trim();
  return displayName ? `@${displayName}` : '@mention';
}

function buildEditableDraft(rawText, issueSnapshot) {
  const sourceText = String(rawText || '');
  const mentionMappings = [];
  const mentionPattern = /\[~([^[\]\r\n]+?)\]/g;
  let draft = '';
  let lastIndex = 0;
  let match = mentionPattern.exec(sourceText);
  while (match) {
    draft += sourceText.slice(lastIndex, match.index);
    const displayText = mentionDisplayText(match[1], issueSnapshot);
    const start = draft.length;
    draft += displayText;
    mentionMappings.push({displayText, markup: match[0], start});
    lastIndex = match.index + match[0].length;
    match = mentionPattern.exec(sourceText);
  }
  draft += sourceText.slice(lastIndex);
  mentionMappings.forEach(mapping => {
    const end = mapping.start + mapping.displayText.length;
    mapping.beforeContext = draft.slice(Math.max(0, mapping.start - 24), mapping.start);
    mapping.afterContext = draft.slice(end, end + 24);
  });
  return {draft, mentionMappings};
}

function restoreMentionMarkup(draftText, mentionMappings = []) {
  const sourceText = String(draftText || '');
  const replacements = [];
  let searchFloor = 0;
  (Array.isArray(mentionMappings) ? mentionMappings : []).filter(mapping => mapping?.displayText && mapping?.markup).forEach(mapping => {
    const displayText = String(mapping.displayText);
    let bestMatch = null;
    let nextIndex = Math.max(0, searchFloor);
    while (nextIndex <= sourceText.length) {
      const matchIndex = sourceText.indexOf(displayText, nextIndex);
      if (matchIndex === -1) break;
      const beforeContext = String(mapping.beforeContext || '');
      const afterContext = String(mapping.afterContext || '');
      const beforeSample = sourceText.slice(Math.max(0, matchIndex - beforeContext.length), matchIndex);
      const afterStart = matchIndex + displayText.length;
      const afterSample = sourceText.slice(afterStart, afterStart + afterContext.length);
      const contextScore = countSharedSuffixLength(beforeSample, beforeContext) + countSharedPrefixLength(afterSample, afterContext);
      const preferredStart = Number.isFinite(Number(mapping.start)) ? Number(mapping.start) : matchIndex;
      const candidate = {
        start: matchIndex,
        end: afterStart,
        markup: String(mapping.markup),
        contextScore,
        distanceScore: Math.abs(matchIndex - preferredStart),
      };
      if (!bestMatch || candidate.contextScore > bestMatch.contextScore ||
        (candidate.contextScore === bestMatch.contextScore && candidate.distanceScore < bestMatch.distanceScore)) {
        bestMatch = candidate;
      }
      nextIndex = matchIndex + displayText.length;
    }
    if (!bestMatch || (!bestMatch.contextScore && (mapping.beforeContext || mapping.afterContext))) return;
    replacements.push(bestMatch);
    searchFloor = bestMatch.end;
  });
  if (!replacements.length) return sourceText;
  let restored = '';
  let cursor = 0;
  replacements.forEach(replacement => {
    restored += sourceText.slice(cursor, replacement.start);
    restored += replacement.markup;
    cursor = replacement.end;
  });
  return restored + sourceText.slice(cursor);
}

function normalizeAttachmentName(value) {
  return String(value || '').trim().toLowerCase();
}

function attachmentImageMarkup(attachments) {
  const imagesByName = {};
  (attachments || []).forEach(attachment => {
    const fileName = String(attachment?.filename || '').trim();
    const inlineSrc = attachment?.inlineDataUrl || attachment?.displayContent || attachment?.thumbnail || '';
    const previewSrc = attachment?.previewDataUrl || attachment?.previewDisplaySrc || inlineSrc;
    if (!fileName || !inlineSrc) return;
    const markup = `<img class="_JX_previewable" src="${escapeHtml(inlineSrc)}" data-jx-preview-src="${escapeHtml(previewSrc)}" alt="${escapeHtml(fileName)}" style="max-height: 100px;" />`;
    imagesByName[normalizeAttachmentName(fileName)] = markup;
    imagesByName[fileName] = markup;
  });
  return imagesByName;
}

function rawCommentHtml(rawBody, issueSnapshot, attachments) {
  const mentions = [];
  const withMentionPlaceholders = String(rawBody || '').replace(/\[~([^[\]\r\n]+?)\]/g, (match, mentionValue) => {
    const index = mentions.length;
    mentions.push(`<span class="_JX_mention">${escapeHtml(mentionDisplayText(mentionValue, issueSnapshot))}</span>`);
    return `__JX_COMMENT_MENTION_${index}__`;
  });
  const images = [];
  const imagesByName = attachmentImageMarkup(attachments);
  const withImagePlaceholders = withMentionPlaceholders.replace(/!([^!\r\n]+)!/g, (match, imageName) => {
    const markup = imagesByName[normalizeAttachmentName(String(imageName || '').split('|')[0])];
    if (!markup) return match;
    const index = images.length;
    images.push(markup);
    return `__JX_COMMENT_IMAGE_${index}__`;
  });
  return escapeHtml(withImagePlaceholders)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/__JX_COMMENT_IMAGE_(\d+)__/g, (match, index) => images[Number(index)] || '')
    .replace(/__JX_COMMENT_MENTION_(\d+)__/g, (match, index) => mentions[Number(index)] || '')
    .replace(/\n/g, '<br/>');
}

function sameJiraUser(left, right) {
  if (!left || !right) return false;
  const leftIds = [left.accountId, left.name, left.username, left.key].filter(Boolean);
  const rightIds = [right.accountId, right.name, right.username, right.key].filter(Boolean);
  return leftIds.some(value => rightIds.includes(value));
}

function initials(displayName) {
  const tokens = String(displayName || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return '--';
  if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase();
  return `${tokens[0][0] || ''}${tokens[tokens.length - 1][0] || ''}`.toUpperCase();
}

function isLikelyDefaultAvatar(user, avatarUrl) {
  if (!avatarUrl || user?.isDefaultAvatar === true) return true;
  const normalizedUrl = String(avatarUrl).toLowerCase();
  return normalizedUrl.startsWith('data:image/svg+xml;base64,phn2zybpzd0iv2fyc3r3yvgx') ||
    normalizedUrl.includes('defaultavatar') || normalizedUrl.includes('/avatar.png') ||
    normalizedUrl.includes('avatar/default') || normalizedUrl.includes('initials=') ||
    (/\buseravatar\b/.test(normalizedUrl) && !normalizedUrl.includes('ownerid='));
}

function userView(user) {
  const displayName = user?.displayName || user?.name || user?.username || user?.emailAddress || '';
  const rawAvatarUrl = user?.avatarUrls?.['48x48'] || user?.avatarUrl || '';
  return {
    displayName,
    avatarUrl: isLikelyDefaultAvatar(user, rawAvatarUrl) ? '' : rawAvatarUrl,
    initials: initials(displayName),
  };
}

function relativeDate(created, now) {
  const createdAt = new Date(created);
  if (Number.isNaN(createdAt.getTime())) return '--';
  const diffMs = now.getTime() - createdAt.getTime();
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
  if (diffMs >= 0 && diffMs < twoDaysMs) {
    const minuteMs = 60 * 1000;
    const hourMs = 60 * minuteMs;
    const dayMs = 24 * hourMs;
    if (diffMs < hourMs) return `${Math.max(1, Math.floor(diffMs / minuteMs))}m ago`;
    if (diffMs < dayMs) return `${Math.max(1, Math.floor(diffMs / hourMs))}h ago`;
    return `${Math.max(1, Math.floor(diffMs / dayMs))}d ago`;
  }
  return new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(createdAt);
}

function sentence(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function hoverTitle(action, detail) {
  return [action, detail].map(sentence).filter(Boolean).join('\n');
}

export function createCommentFormatting(options = {}) {
  const instanceUrl = String(options.instanceUrl || '');
  const clock = typeof options.clock === 'function' ? options.clock : () => new Date();
  const normalizer = options.formatting && typeof options.formatting.normalizeHtml === 'function'
    ? options.formatting
    : {async normalizeHtml(html) { return html; }};

  async function projectComments(issueSnapshot) {
    const core = issueSnapshot?.core || {};
    const comments = core.fields?.comment?.comments || [];
    const attachments = core.fields?.attachment || [];
    const renderedById = {};
    (core.renderedFields?.comment?.comments || []).forEach(comment => {
      if (comment?.id) renderedById[String(comment.id)] = comment.body;
    });
    const viewer = issueSnapshot?.viewer?.user || null;
    const issueKey = String(issueSnapshot?.issueKey || core.key || '');
    const summary = String(core.fields?.summary || '');
    return Promise.all(comments.map(async comment => {
      const id = String(comment?.id || '');
      const sourceHtml = renderedById[id] || rawCommentHtml(comment?.body || '', issueSnapshot, attachments);
      let bodyHtml = sourceHtml;
      try {
        bodyHtml = await normalizer.normalizeHtml(sourceHtml, {attachments, imageMaxHeight: 100});
      } catch (error) {
        bodyHtml = sourceHtml;
      }
      const author = userView(comment?.author);
      const permalink = id && issueKey
        ? `${instanceUrl}browse/${issueKey}?focusedCommentId=${id}&page=com.atlassian.jira.plugin.system.issuetabpanels:comment-tabpanel#comment-${id}`
        : '';
      const linkDetail = `[${issueKey}] ${summary}`.trim();
      const owned = sameJiraUser(comment?.author, viewer);
      return {
        id,
        author: author.displayName || 'Unknown',
        authorAvatarUrl: author.avatarUrl,
        authorInitials: author.initials,
        authorIdentity: {
          accountId: comment?.author?.accountId || '',
          key: comment?.author?.key || '',
          name: comment?.author?.name || comment?.author?.username || '',
          username: comment?.author?.username || comment?.author?.name || '',
        },
        bodyHtml,
        bodyRaw: String(comment?.body || ''),
        commentCopyLabel: linkDetail,
        commentCopyTitle: hoverTitle('Copy comment link', linkDetail),
        commentLinkTitle: hoverTitle('Open comment in Jira', linkDetail),
        commentPermalink: permalink,
        created: relativeDate(comment?.created, clock()),
        createdTimestamp: new Date(comment?.created || 0).getTime() || 0,
        isOwnedByCurrentUser: owned,
        showCommentActions: owned,
      };
    }));
  }

  return {buildEditableDraft, projectComments, restoreMentionMarkup};
}
