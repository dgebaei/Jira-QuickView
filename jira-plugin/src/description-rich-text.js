function isRichTextDescriptionDocument(value) {
  return !!value && typeof value === 'object' && value.type === 'doc' && Array.isArray(value.content);
}

function normalizeDescriptionText(value) {
  return String(value || '').replace(/\r\n?/g, '\n');
}

function hasDescriptionImageMarkup(value) {
  return /!([^!\n]+)!/.test(String(value || ''));
}

function cloneValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeImageMarkup(markup) {
  const text = String(markup || '').trim();
  if (!text) {
    return '';
  }
  const match = text.match(/^!([^!\n]+)!$/);
  if (!match) {
    return '';
  }
  const rawBody = String(match[1] || '').trim();
  const fileName = rawBody.split('|')[0].trim();
  if (!fileName) {
    return '';
  }
  return `!${fileName}!`;
}

function buildMediaSingleNodeFromAttachment(attachment) {
  if (!attachment || !attachment.id) {
    return null;
  }
  const fileName = String(attachment.fileName || attachment.filename || '').trim();
  return {
    type: 'mediaSingle',
    content: [
      {
        type: 'media',
        attrs: {
          alt: fileName,
          collection: '',
          fileName,
          id: String(attachment.id),
          type: 'file',
        },
      },
    ],
  };
}

function appendTextNode(nodes, text, marks = []) {
  if (!text) {
    return;
  }
  const nextMarks = Array.isArray(marks) && marks.length ? marks : undefined;
  const previous = nodes[nodes.length - 1];
  if (previous && previous.type === 'text') {
    const previousMarks = JSON.stringify(previous.marks || []);
    const currentMarks = JSON.stringify(nextMarks || []);
    if (previousMarks === currentMarks) {
      previous.text += text;
      return;
    }
  }
  const node = {type: 'text', text};
  if (nextMarks) {
    node.marks = nextMarks;
  }
  nodes.push(node);
}

function addMarkToInlineNodes(nodes, markType, attrs) {
  return nodes.map(node => {
    if (!node || node.type !== 'text') {
      return node;
    }
    const marks = Array.isArray(node.marks) ? node.marks.slice() : [];
    if (!marks.some(mark => mark.type === markType)) {
      marks.push(attrs ? {type: markType, attrs} : {type: markType});
    }
    return {
      ...node,
      marks,
    };
  });
}

function parseBracketLink(text, startIndex) {
  if (text[startIndex] !== '[') {
    return null;
  }
  const separatorIndex = text.indexOf('|', startIndex + 1);
  if (separatorIndex === -1) {
    return null;
  }
  const closingIndex = text.indexOf(']', separatorIndex + 1);
  if (closingIndex === -1) {
    return null;
  }
  return {
    endIndex: closingIndex + 1,
    label: text.slice(startIndex + 1, separatorIndex),
    url: text.slice(separatorIndex + 1, closingIndex),
  };
}

function findClosingInlineMarker(text, startIndex, marker) {
  for (let index = startIndex; index < text.length; index += 1) {
    if (text[index] === '\n') {
      return -1;
    }
    if (text[index] === marker) {
      return index;
    }
  }
  return -1;
}

function parseInlineTextToAdf(text) {
  const source = String(text || '');
  const nodes = [];
  let buffer = '';
  let index = 0;

  const flush = () => {
    appendTextNode(nodes, buffer);
    buffer = '';
  };

  while (index < source.length) {
    if (source.startsWith('{{', index)) {
      const closingIndex = source.indexOf('}}', index + 2);
      if (closingIndex !== -1) {
        flush();
        appendTextNode(nodes, source.slice(index + 2, closingIndex), [{type: 'code'}]);
        index = closingIndex + 2;
        continue;
      }
    }

    const linkMatch = parseBracketLink(source, index);
    if (linkMatch) {
      flush();
      const linkNodes = addMarkToInlineNodes(
        parseInlineTextToAdf(linkMatch.label),
        'link',
        {href: linkMatch.url}
      );
      nodes.push(...linkNodes);
      index = linkMatch.endIndex;
      continue;
    }

    const markerType = source[index] === '*'
      ? 'strong'
      : (source[index] === '_' ? 'em' : (source[index] === '+' ? 'underline' : ''));
    if (markerType) {
      const closingIndex = findClosingInlineMarker(source, index + 1, source[index]);
      if (closingIndex > index + 1) {
        flush();
        const innerNodes = addMarkToInlineNodes(
          parseInlineTextToAdf(source.slice(index + 1, closingIndex)),
          markerType
        );
        nodes.push(...innerNodes);
        index = closingIndex + 1;
        continue;
      }
    }

    buffer += source[index];
    index += 1;
  }

  flush();
  return nodes;
}

function buildParagraphNode(lines) {
  const content = [];
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) {
      content.push({type: 'hardBreak'});
    }
    content.push(...parseInlineTextToAdf(line));
  });
  return {type: 'paragraph', content};
}

function buildListNode(type, lines, prefixLength) {
  return {
    type,
    content: lines.map(line => ({
      type: 'listItem',
      content: [buildParagraphNode([line.slice(prefixLength)])],
    })),
  };
}

function buildRichTextDescriptionDocument(value, options = {}) {
  const text = normalizeDescriptionText(value);
  if (!text.trim()) {
    return {document: null, unresolvedImageMarkup: []};
  }

  const lines = text.split('\n');
  const content = [];
  const attachmentByMarkup = options.attachmentByMarkup || {};
  const mediaNodesByMarkup = options.mediaNodesByMarkup || {};
  const unresolvedImageMarkup = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }

    if (/^\{(?:noformat|code)\}$/i.test(lines[index].trim())) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^\{(?:noformat|code)\}$/i.test(lines[index].trim())) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      content.push({
        type: 'codeBlock',
        content: [{type: 'text', text: codeLines.join('\n')}],
      });
      continue;
    }

    if (/^\* /.test(lines[index])) {
      const listLines = [];
      while (index < lines.length && /^\* /.test(lines[index])) {
        listLines.push(lines[index]);
        index += 1;
      }
      content.push(buildListNode('bulletList', listLines, 2));
      continue;
    }

    if (/^# /.test(lines[index])) {
      const listLines = [];
      while (index < lines.length && /^# /.test(lines[index])) {
        listLines.push(lines[index]);
        index += 1;
      }
      content.push(buildListNode('orderedList', listLines, 2));
      continue;
    }

    const imageMarkup = normalizeImageMarkup(lines[index]);
    if (imageMarkup) {
      const mediaNode = mediaNodesByMarkup[imageMarkup] || buildMediaSingleNodeFromAttachment(attachmentByMarkup[imageMarkup]);
      if (mediaNode) {
        content.push(cloneValue(mediaNode));
      } else {
        unresolvedImageMarkup.push(imageMarkup);
        content.push(buildParagraphNode([lines[index]]));
      }
      index += 1;
      continue;
    }

    const paragraphLines = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\{(?:noformat|code)\}$/i.test(lines[index].trim()) &&
      !/^[*#] /.test(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    content.push(buildParagraphNode(paragraphLines));
  }

  return {
    document: {
      type: 'doc',
      version: 1,
      content,
    },
    unresolvedImageMarkup,
  };
}

function applyMarksToEditorText(text, marks) {
  const markList = Array.isArray(marks) ? marks : [];
  const linkMark = markList.find(mark => mark?.type === 'link' && mark?.attrs?.href);
  let nextText = String(text || '');

  const wrappers = [
    {type: 'code', prefix: '{{', suffix: '}}'},
    {type: 'strong', prefix: '*', suffix: '*'},
    {type: 'em', prefix: '_', suffix: '_'},
    {type: 'underline', prefix: '+', suffix: '+'},
  ];

  wrappers.forEach(wrapper => {
    if (markList.some(mark => mark?.type === wrapper.type)) {
      nextText = `${wrapper.prefix}${nextText}${wrapper.suffix}`;
    }
  });

  if (linkMark) {
    if (nextText === linkMark.attrs.href) {
      return nextText;
    }
    return `[${nextText}|${linkMark.attrs.href}]`;
  }

  return nextText;
}

function inlineNodesToEditorText(nodes) {
  return (Array.isArray(nodes) ? nodes : []).map(node => {
    if (!node) {
      return '';
    }
    if (node.type === 'text') {
      return applyMarksToEditorText(node.text, node.marks);
    }
    if (node.type === 'hardBreak') {
      return '\n';
    }
    if (node.type === 'emoji') {
      return String(node?.attrs?.text || '');
    }
    if (node.type === 'mention') {
      return String(node?.attrs?.text || node?.attrs?.id || '');
    }
    if (node.type === 'inlineCard') {
      return String(node?.attrs?.url || '');
    }
    if (node.type === 'mediaInline') {
      const fileName = String(node?.attrs?.alt || node?.attrs?.fileName || '');
      return fileName ? `!${fileName}!` : '';
    }
    return '';
  }).join('');
}

function listItemToEditorText(node, prefix) {
  const blocks = (Array.isArray(node?.content) ? node.content : []).map(blockToEditorText).filter(Boolean);
  if (!blocks.length) {
    return '';
  }
  const [firstBlock, ...restBlocks] = blocks;
  return [prefix + firstBlock, ...restBlocks].join('\n');
}

function blockToEditorText(node, mediaNodesByMarkup = null) {
  if (!node) {
    return '';
  }
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return inlineNodesToEditorText(node.content);
    case 'bulletList':
      return (Array.isArray(node.content) ? node.content : [])
        .map(item => listItemToEditorText(item, '* '))
        .filter(Boolean)
        .join('\n');
    case 'orderedList':
      return (Array.isArray(node.content) ? node.content : [])
        .map(item => listItemToEditorText(item, '# '))
        .filter(Boolean)
        .join('\n');
    case 'codeBlock': {
      const codeText = (Array.isArray(node.content) ? node.content : [])
        .map(item => String(item?.text || ''))
        .join('');
      return `{noformat}\n${codeText}\n{noformat}`;
    }
    case 'mediaSingle': {
      const mediaNode = Array.isArray(node.content) ? node.content[0] : null;
      const fileName = String(mediaNode?.attrs?.alt || mediaNode?.attrs?.fileName || '');
      const markup = fileName ? `!${fileName}!` : '';
      if (markup && mediaNodesByMarkup) {
        mediaNodesByMarkup[markup] = cloneValue(node);
      }
      return markup;
    }
    default:
      return '';
  }
}

function buildDescriptionEditorState(value) {
  if (typeof value === 'string') {
    return {
      mediaNodesByMarkup: {},
      prefersRichText: false,
      text: value,
    };
  }
  if (!isRichTextDescriptionDocument(value)) {
    return {
      mediaNodesByMarkup: {},
      prefersRichText: false,
      text: '',
    };
  }
  const mediaNodesByMarkup = {};
  return {
    mediaNodesByMarkup,
    prefersRichText: true,
    text: value.content.map(block => blockToEditorText(block, mediaNodesByMarkup)).filter(Boolean).join('\n\n'),
  };
}

function descriptionFieldToEditorText(value) {
  return buildDescriptionEditorState(value).text;
}

function buildDescriptionSaveFieldValue(value, options = {}) {
  const text = normalizeDescriptionText(value);
  if (!text.trim()) {
    return {value: null};
  }
  const preferRichText = !!options.preferRichText;
  if (!preferRichText) {
    return {value: text};
  }
  const result = buildRichTextDescriptionDocument(text, {
    attachmentByMarkup: options.attachmentByMarkup || {},
    mediaNodesByMarkup: options.mediaNodesByMarkup || {},
  });
  if (result.unresolvedImageMarkup.length) {
    return {error: 'New pasted images cannot be saved in rich-text descriptions yet'};
  }
  return {value: result.document};
}

module.exports = {
  buildDescriptionEditorState,
  buildMediaSingleNodeFromAttachment,
  buildDescriptionSaveFieldValue,
  buildRichTextDescriptionDocument,
  descriptionFieldToEditorText,
  hasDescriptionImageMarkup,
  isRichTextDescriptionDocument,
};
