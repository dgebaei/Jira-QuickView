const IMAGE_MIME_BY_EXTENSION = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
};

const NON_IMAGE_EXTENSIONS = new Set([
  '7z',
  'avi',
  'csv',
  'doc',
  'docm',
  'docx',
  'gz',
  'log',
  'mkv',
  'mov',
  'mp3',
  'mp4',
  'mpeg',
  'mpg',
  'odp',
  'ods',
  'odt',
  'pdf',
  'potx',
  'ppsx',
  'ppt',
  'pptm',
  'pptx',
  'rar',
  'rtf',
  'tar',
  'tgz',
  'txt',
  'wav',
  'webm',
  'xls',
  'xlsb',
  'xlsm',
  'xlsx',
  'xml',
  'zip',
]);

function safelyDecode(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch (error) {
    return String(value || '');
  }
}

function getFilenameExtension(filename) {
  const normalized = String(filename || '').trim().toLowerCase();
  const base = normalized.split(/[?#]/, 1)[0];
  const dotIndex = base.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === base.length - 1) {
    return '';
  }
  return base.slice(dotIndex + 1);
}

export function getAttachmentFilenameExtension(filename) {
  return getFilenameExtension(filename);
}

export function guessAttachmentMimeType(filename) {
  const extension = getFilenameExtension(filename);
  return IMAGE_MIME_BY_EXTENSION[extension] || '';
}

export function isImageAttachmentFilename(filename) {
  return !!guessAttachmentMimeType(filename);
}

export function isKnownNonImageAttachmentFilename(filename) {
  return NON_IMAGE_EXTENSIONS.has(getFilenameExtension(filename));
}

export function unwrapKnownRedirectUrl(rawUrl, {maxDepth = 3} = {}) {
  let current = String(rawUrl || '').trim();
  for (let depth = 0; depth < maxDepth; depth += 1) {
    let parsed;
    try {
      parsed = new URL(current);
    } catch (error) {
      return current;
    }

    const hostname = parsed.hostname.toLowerCase();
    let wrappedUrl = '';

    if ((hostname === 'google.com' || hostname === 'www.google.com')
        && /^\/url\/?$/i.test(parsed.pathname)) {
      wrappedUrl = parsed.searchParams.get('q') || parsed.searchParams.get('url') || '';
    } else if (hostname.endsWith('.safelinks.protection.outlook.com')) {
      wrappedUrl = parsed.searchParams.get('url') || '';
    }

    if (!wrappedUrl) {
      return current;
    }

    let nextUrl;
    try {
      nextUrl = new URL(wrappedUrl);
    } catch (error) {
      return current;
    }
    if (!['http:', 'https:'].includes(nextUrl.protocol)) {
      return current;
    }
    current = nextUrl.toString();
  }
  return current;
}

function parseInstanceOrigin(instanceUrl) {
  try {
    const parsed = new URL(String(instanceUrl || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return '';
    }
    return parsed.origin;
  } catch (error) {
    return '';
  }
}

function buildAttachmentUrl(instanceUrl, path) {
  const base = String(instanceUrl || '').trim();
  if (!base) {
    return '';
  }
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  return `${normalizedBase}${path}`;
}

export function buildAttachmentPreviewUrls(instanceUrl, attachmentId) {
  const encodedId = encodeURIComponent(String(attachmentId || '').trim());
  if (!encodedId) {
    return {contentUrl: '', metadataUrl: '', thumbnailUrl: ''};
  }
  return {
    contentUrl: buildAttachmentUrl(instanceUrl, `rest/api/2/attachment/content/${encodedId}`),
    metadataUrl: buildAttachmentUrl(instanceUrl, `rest/api/2/attachment/${encodedId}`),
    thumbnailUrl: buildAttachmentUrl(instanceUrl, `rest/api/2/attachment/thumbnail/${encodedId}`),
  };
}

export function parseJiraAttachmentLink(rawHref, {baseUrl = '', instanceUrl = ''} = {}) {
  const declaredHref = String(rawHref || '').trim();
  if (!declaredHref || declaredHref.startsWith('#')) {
    return null;
  }

  const instanceOrigin = parseInstanceOrigin(instanceUrl);
  if (!instanceOrigin) {
    return null;
  }

  let resolvedUrl;
  try {
    resolvedUrl = new URL(declaredHref, baseUrl || undefined);
  } catch (error) {
    return null;
  }
  if (!['http:', 'https:'].includes(resolvedUrl.protocol)) {
    return null;
  }

  const unwrappedUrl = unwrapKnownRedirectUrl(resolvedUrl.toString());
  let jiraUrl;
  try {
    jiraUrl = new URL(unwrappedUrl);
  } catch (error) {
    return null;
  }
  if (jiraUrl.origin !== instanceOrigin) {
    return null;
  }

  const contentTypeMatch = jiraUrl.pathname.match(
    /(?:^|\/)rest\/api\/(?:2|3)\/attachment\/(content|thumbnail)\/(\d+)\/?$/i
  );
  if (contentTypeMatch) {
    return {
      attachmentId: contentTypeMatch[2],
      filename: '',
      isImageHint: contentTypeMatch[1].toLowerCase() === 'thumbnail',
      isKnownNonImage: false,
      jiraUrl: jiraUrl.toString(),
      kind: contentTypeMatch[1].toLowerCase(),
    };
  }

  const secureMatch = jiraUrl.pathname.match(/(?:^|\/)secure\/attachment\/(\d+)(?:\/([^/?#]+))?\/?$/i);
  if (!secureMatch) {
    return null;
  }

  const filename = safelyDecode(secureMatch[2] || '');
  return {
    attachmentId: secureMatch[1],
    filename,
    isImageHint: isImageAttachmentFilename(filename),
    isKnownNonImage: isKnownNonImageAttachmentFilename(filename),
    jiraUrl: jiraUrl.toString(),
    kind: 'secure',
  };
}
