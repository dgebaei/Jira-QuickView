export function createBrowserAttachmentMediaAdapter(options = {}) {
  const objectUrl = options.objectUrl || URL;
  if (typeof objectUrl?.createObjectURL !== 'function' || typeof objectUrl?.revokeObjectURL !== 'function') {
    throw new Error('BrowserAttachmentMediaAdapter requires object URL support');
  }
  return {
    createPreview(file) {
      return objectUrl.createObjectURL(file);
    },
    revokePreview(url) {
      if (String(url || '').startsWith('blob:')) objectUrl.revokeObjectURL(url);
    },
  };
}
