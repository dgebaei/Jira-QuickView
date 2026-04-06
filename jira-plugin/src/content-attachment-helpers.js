export function createContentAttachmentHelpers(options) {
  const buildLinkHoverTitle = options?.buildLinkHoverTitle;

  function normalizeHistoryAttachmentName(fileName) {
    return String(fileName || '').trim().toLowerCase();
  }

  function buildHistoryAttachmentView(attachment, fallbackName = '') {
    const filename = String(attachment?.filename || fallbackName || '').trim();
    const url = attachment?.rawContentUrl || attachment?.content || '';
    const inlineDisplaySrc = attachment?.inlineDataUrl || attachment?.displayContent || '';
    const previewDisplaySrc = attachment?.previewDataUrl || attachment?.previewDisplaySrc || inlineDisplaySrc;
    const thumbnail = inlineDisplaySrc;
    const mimeType = String(attachment?.mimeType || '').toLowerCase();
    return {
      filename,
      hasUrl: !!url,
      url,
      inlineDisplaySrc,
      previewDisplaySrc,
      thumbnail,
      mimeType,
      isImage: mimeType.startsWith('image') && !!inlineDisplaySrc,
      isPreviewable: mimeType.startsWith('image') && !!previewDisplaySrc,
      linkTitle: url ? buildLinkHoverTitle('Open attachment', filename || 'Attachment', url) : '',
      previewTitle: previewDisplaySrc ? buildLinkHoverTitle('Preview attachment', filename || 'Attachment', url || previewDisplaySrc) : ''
    };
  }

  function buildHistoryAttachmentLookup(attachments) {
    const attachmentLookup = new Map();
    (attachments || []).forEach(attachment => {
      const filename = String(attachment?.filename || '').trim();
      const normalizedName = normalizeHistoryAttachmentName(filename);
      if (!normalizedName || attachmentLookup.has(normalizedName)) {
        return;
      }
      attachmentLookup.set(normalizedName, buildHistoryAttachmentView(attachment));
    });
    return attachmentLookup;
  }

  function dedupeHistoryAttachments(attachments) {
    const deduped = new Map();
    (attachments || []).forEach(attachment => {
      const normalizedName = normalizeHistoryAttachmentName(attachment?.filename);
      if (!normalizedName || deduped.has(normalizedName)) {
        return;
      }
      deduped.set(normalizedName, attachment);
    });
    return [...deduped.values()];
  }

  function collectReferencedHistoryAttachmentNames(value, attachmentLookup) {
    const normalizedText = normalizeHistoryAttachmentName(value);
    if (!normalizedText) {
      return new Set();
    }
    return new Set([...attachmentLookup.keys()].filter(fileName => {
      return normalizedText.includes(fileName);
    }));
  }

  function buildPreviewAttachments(attachments) {
    return (attachments || [])
      .filter(attachment => {
        return !!attachment &&
          typeof attachment.mimeType === 'string' &&
          attachment.mimeType.toLowerCase().startsWith('image') &&
          !!(attachment.inlineDataUrl || attachment.displayContent);
      })
      .map(attachment => ({
        ...attachment,
        thumbnail: attachment.inlineDataUrl || attachment.displayContent,
        previewDisplaySrc: attachment.previewDataUrl || attachment.previewDisplaySrc || attachment.inlineDataUrl || attachment.displayContent,
        linkTitle: buildLinkHoverTitle('Open attachment', attachment.filename || 'Attachment', attachment.content)
      }));
  }

  return {
    buildHistoryAttachmentLookup,
    buildHistoryAttachmentView,
    buildPreviewAttachments,
    collectReferencedHistoryAttachmentNames,
    dedupeHistoryAttachments,
    normalizeHistoryAttachmentName,
  };
}
