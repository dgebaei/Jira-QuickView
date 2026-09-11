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

  function attachmentTypeLabel(attachment) {
    const mimeType = String(attachment?.mimeType || '').toLowerCase();
    if (mimeType === 'application/pdf') return 'PDF';
    const extension = String(attachment?.filename || '').split('.').pop();
    if (extension && extension !== attachment?.filename && extension.length <= 5) return extension.toUpperCase();
    if (mimeType.startsWith('text/')) return 'TXT';
    return 'FILE';
  }

  function attachmentSizeLabel(size) {
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function buildSectionAttachments(attachments) {
    const images = [];
    const files = [];
    (attachments || []).filter(Boolean).forEach(attachment => {
      const view = buildHistoryAttachmentView(attachment);
      const common = {
        ...attachment,
        id: String(attachment.id || attachment.filename || ''),
        content: view.url,
        filename: view.filename || 'Attachment',
        linkTitle: view.linkTitle,
        mimeType: view.mimeType,
      };
      if (view.isPreviewable) {
        images.push({
          ...common,
          previewDisplaySrc: view.previewDisplaySrc,
          thumbnail: view.thumbnail,
        });
      } else {
        files.push({
          ...common,
          fileTypeLabel: attachmentTypeLabel(attachment),
          sizeLabel: attachmentSizeLabel(attachment.size),
        });
      }
    });
    return {files, images};
  }

  return {
    buildHistoryAttachmentLookup,
    buildHistoryAttachmentView,
    buildSectionAttachments,
    collectReferencedHistoryAttachmentNames,
    dedupeHistoryAttachments,
    normalizeHistoryAttachmentName,
  };
}
