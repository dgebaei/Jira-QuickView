export function createContentCommentHelpers(options) {
  const resolveMentionDisplayName = options?.resolveMentionDisplayName;
  const escapeHtml = options?.escapeHtml;
  const normalizeHistoryAttachmentName = options?.normalizeHistoryAttachmentName;

  function getMentionDisplayText(rawValue) {
    const normalized = String(rawValue || '').trim();
    const identity = normalized.replace(/^accountid:/i, '');
    const displayName = resolveMentionDisplayName?.(identity) || resolveMentionDisplayName?.(normalized);
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

  return {
    buildAttachmentImagesByName,
    buildHistoryPreviewText,
    getMentionDisplayText,
    normalizeCommentImageReference,
    replaceMentionMarkupWithDisplayText,
    textToLinkedHtml,
  };
}
