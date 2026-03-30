export function createContentCommentHelpers(options) {
  const mentionContextWindow = Number(options?.mentionContextWindow) || 24;
  const jiraUserDisplayNameCache = options?.jiraUserDisplayNameCache;
  const escapeHtml = options?.escapeHtml;
  const normalizeHistoryAttachmentName = options?.normalizeHistoryAttachmentName;

  function getMentionDisplayText(rawValue) {
    const normalized = String(rawValue || '').trim();
    const identity = normalized.replace(/^accountid:/i, '');
    const displayName = jiraUserDisplayNameCache?.get(identity) || jiraUserDisplayNameCache?.get(normalized);
    if (displayName) {
      return `@${displayName}`;
    }
    return identity ? `@${identity}` : '@mention';
  }

  function replaceMentionMarkupWithDisplayText(input) {
    return String(input || '').replace(/\[~([^[\]\r\n]+?)\]/g, (match, mentionValue) => {
      return getMentionDisplayText(mentionValue);
    });
  }

  function normalizeCommentImageReference(value) {
    return String(value || '').trim().split('|')[0].trim();
  }

  function countSharedPrefixLength(left, right) {
    const leftText = String(left || '');
    const rightText = String(right || '');
    const maxLength = Math.min(leftText.length, rightText.length);
    let index = 0;
    while (index < maxLength && leftText[index] === rightText[index]) {
      index += 1;
    }
    return index;
  }

  function countSharedSuffixLength(left, right) {
    const leftText = String(left || '');
    const rightText = String(right || '');
    const maxLength = Math.min(leftText.length, rightText.length);
    let index = 0;
    while (
      index < maxLength &&
      leftText[leftText.length - 1 - index] === rightText[rightText.length - 1 - index]
    ) {
      index += 1;
    }
    return index;
  }

  function buildEditableCommentDraft(rawText) {
    const sourceText = String(rawText || '');
    const mentionMappings = [];
    const mentionPattern = /\[~([^[\]\r\n]+?)\]/g;
    let draft = '';
    let lastIndex = 0;
    let match = mentionPattern.exec(sourceText);
    while (match) {
      const matchText = String(match[0] || '');
      const mentionValue = String(match[1] || '');
      const matchOffset = Number(match.index || 0);
      const displayText = getMentionDisplayText(mentionValue);
      draft += sourceText.slice(lastIndex, matchOffset);
      const start = draft.length;
      draft += displayText;
      mentionMappings.push({
        displayText,
        markup: matchText,
        start,
      });
      lastIndex = matchOffset + matchText.length;
      match = mentionPattern.exec(sourceText);
    }
    draft += sourceText.slice(lastIndex);
    mentionMappings.forEach(mapping => {
      const start = Number.isFinite(Number(mapping.start)) ? Number(mapping.start) : draft.indexOf(mapping.displayText);
      const end = start + String(mapping.displayText || '').length;
      mapping.start = start;
      mapping.beforeContext = draft.slice(Math.max(0, start - mentionContextWindow), start);
      mapping.afterContext = draft.slice(end, end + mentionContextWindow);
    });
    return {draft, mentionMappings};
  }

  function buildDraftMentionMapping(draftText, start, displayText, markup) {
    const normalizedDraftText = String(draftText || '');
    const normalizedDisplayText = String(displayText || '');
    const normalizedStart = Number.isFinite(Number(start)) ? Number(start) : normalizedDraftText.indexOf(normalizedDisplayText);
    const safeStart = Math.max(0, normalizedStart);
    const end = safeStart + normalizedDisplayText.length;
    return {
      afterContext: normalizedDraftText.slice(end, end + mentionContextWindow),
      beforeContext: normalizedDraftText.slice(Math.max(0, safeStart - mentionContextWindow), safeStart),
      displayText: normalizedDisplayText,
      markup: String(markup || ''),
      start: safeStart,
    };
  }

  function restoreEditableCommentMentions(draftText, mentionMappings = []) {
    const sourceText = String(draftText || '');
    const replacements = [];
    let searchFloor = 0;
    [...(Array.isArray(mentionMappings) ? mentionMappings : [])]
      .filter(mapping => mapping?.displayText && mapping?.markup)
      .forEach(mapping => {
        const displayText = String(mapping.displayText || '');
        const markup = String(mapping.markup || '');
        if (!displayText || !markup) {
          return;
        }
        let bestMatch = null;
        let nextIndex = Math.max(0, searchFloor);
        while (nextIndex <= sourceText.length) {
          const matchIndex = sourceText.indexOf(displayText, nextIndex);
          if (matchIndex === -1) {
            break;
          }
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
            markup,
            contextScore,
            distanceScore: Math.abs(matchIndex - preferredStart),
          };
          if (
            !bestMatch ||
            candidate.contextScore > bestMatch.contextScore ||
            (candidate.contextScore === bestMatch.contextScore && candidate.distanceScore < bestMatch.distanceScore)
          ) {
            bestMatch = candidate;
          }
          nextIndex = matchIndex + displayText.length;
        }
        if (!bestMatch) {
          return;
        }
        if (!bestMatch.contextScore && (mapping.beforeContext || mapping.afterContext)) {
          return;
        }
        replacements.push(bestMatch);
        searchFloor = bestMatch.end;
      });
    if (!replacements.length) {
      return sourceText;
    }
    let restored = '';
    let cursor = 0;
    replacements.forEach(replacement => {
      restored += sourceText.slice(cursor, replacement.start);
      restored += replacement.markup;
      cursor = replacement.end;
    });
    restored += sourceText.slice(cursor);
    return restored;
  }

  function buildAttachmentImagesByName(attachmentLookup = new Map(), imageMaxHeight = 100) {
    const imagesByName = {};
    attachmentLookup.forEach((attachmentView, normalizedName) => {
      const fileName = String(attachmentView?.filename || '').trim();
      const imageSrc = attachmentView?.inlineDisplaySrc || attachmentView?.thumbnail || '';
      const previewSrc = attachmentView?.previewDisplaySrc || imageSrc;
      if (!fileName || !imageSrc) {
        return;
      }
      const markup = `<img class="_JX_previewable" src="${escapeHtml(imageSrc)}" data-jx-preview-src="${escapeHtml(previewSrc)}" alt="${escapeHtml(fileName)}" style="max-height: ${Number(imageMaxHeight) || 100}px;" />`;
      imagesByName[normalizedName] = markup;
      imagesByName[fileName] = markup;
    });
    return imagesByName;
  }

  function textToLinkedHtml(input, options = {}) {
    const {attachmentImagesByName = {}} = options;
    const mentionHtml = [];
    const inputWithMentions = String(input || '').replace(/\[~([^[\]\r\n]+?)\]/g, (match, mentionValue) => {
      const placeholderIndex = mentionHtml.length;
      mentionHtml.push(`<span class="_JX_mention">${escapeHtml(getMentionDisplayText(mentionValue))}</span>`);
      return `__JX_COMMENT_MENTION_${placeholderIndex}__`;
    });
    const imageHtml = [];
    const inputWithImages = inputWithMentions.replace(/!([^!\r\n]+)!/g, (match, imageName) => {
      const normalizedName = normalizeCommentImageReference(imageName);
      const imageMarkup = attachmentImagesByName[normalizedName];
      if (!imageMarkup) {
        return match;
      }
      const placeholderIndex = imageHtml.length;
      imageHtml.push(imageMarkup);
      return `__JX_COMMENT_IMAGE_${placeholderIndex}__`;
    });
    const escaped = escapeHtml(inputWithImages);
    const withLinks = escaped.replace(
      /(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    return withLinks
      .replace(/__JX_COMMENT_IMAGE_(\d+)__/g, (match, index) => imageHtml[Number(index)] || '')
      .replace(/__JX_COMMENT_MENTION_(\d+)__/g, (match, index) => mentionHtml[Number(index)] || '')
      .replace(/\n/g, '<br/>');
  }

  function buildHistoryPreviewText(value, options = {}) {
    const {attachments = [], fallbackText = 'View details'} = options;
    const text = replaceMentionMarkupWithDisplayText(value || '')
      .split(/\r?\n/)
      .map(line => line.replace(/\s+/g, ' ').trim())
      .find(Boolean);
    if (text) {
      return text.length > 140 ? `${text.slice(0, 137)}...` : text;
    }
    if (attachments.length === 1) {
      return attachments[0].filename;
    }
    if (attachments.length > 1) {
      return `${attachments.length} attachments`;
    }
    return fallbackText;
  }

  function formatRelativeDate(created) {
    const createdAt = new Date(created);
    if (Number.isNaN(createdAt.getTime())) {
      return '--';
    }
    const diffMs = Date.now() - createdAt.getTime();
    const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
    if (diffMs >= 0 && diffMs < twoDaysMs) {
      const minuteMs = 60 * 1000;
      const hourMs = 60 * minuteMs;
      const dayMs = 24 * hourMs;
      if (diffMs < hourMs) {
        const minutes = Math.max(1, Math.floor(diffMs / minuteMs));
        return `${minutes}m ago`;
      }
      if (diffMs < dayMs) {
        const hours = Math.max(1, Math.floor(diffMs / hourMs));
        return `${hours}h ago`;
      }
      const days = Math.max(1, Math.floor(diffMs / dayMs));
      return `${days}d ago`;
    }
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(createdAt);
  }

  return {
    buildAttachmentImagesByName,
    buildDraftMentionMapping,
    buildEditableCommentDraft,
    buildHistoryPreviewText,
    formatRelativeDate,
    getMentionDisplayText,
    normalizeCommentImageReference,
    replaceMentionMarkupWithDisplayText,
    restoreEditableCommentMentions,
    textToLinkedHtml,
  };
}
