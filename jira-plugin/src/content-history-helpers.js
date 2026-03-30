export function createContentHistoryHelpers(options) {
  const areSameJiraUser = options?.areSameJiraUser;
  const buildAttachmentImagesByName = options?.buildAttachmentImagesByName;
  const buildHistoryAttachmentLookup = options?.buildHistoryAttachmentLookup;
  const buildHistoryAttachmentView = options?.buildHistoryAttachmentView;
  const buildHistoryPreviewText = options?.buildHistoryPreviewText;
  const buildLinkHoverTitle = options?.buildLinkHoverTitle;
  const collectReferencedHistoryAttachmentNames = options?.collectReferencedHistoryAttachmentNames;
  const dedupeHistoryAttachments = options?.dedupeHistoryAttachments;
  const escapeHtml = options?.escapeHtml;
  const fallbackJiraKeyPattern = options?.fallbackJiraKeyPattern;
  const instanceUrl = options?.instanceUrl;
  const normalizeHistoryAttachmentName = options?.normalizeHistoryAttachmentName;
  const normalizeIssueKey = options?.normalizeIssueKey;
  const normalizeRichHtml = options?.normalizeRichHtml;

  const HISTORY_GROUP_WINDOW_MS = 5 * 60 * 1000;
  const HISTORY_ATTACHMENT_MATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

  function normalizeHistoryFieldName(fieldName) {
    return String(fieldName || '').trim().toLowerCase();
  }

  function toHistoryTitleCase(value) {
    return String(value || '')
      .split(' ')
      .filter(Boolean)
      .map(word => {
        const lowerWord = word.toLowerCase();
        if (lowerWord === 'id') {
          return 'ID';
        }
        return lowerWord.charAt(0).toUpperCase() + lowerWord.slice(1);
      })
      .join(' ');
  }

  function buildHistoryFieldLabel(fieldName, fieldId, fieldNames = {}) {
    const normalizedFieldId = normalizeHistoryFieldName(fieldId).replace(/[\s_-]+/g, '');
    const mappedFieldNames = {
      attachment: 'Attachment',
      comment: 'Comment',
      description: 'Description',
      epiclink: 'Epic Link',
      fixversions: 'Fix versions',
      issuetype: 'Issue type',
      link: 'Link',
      priority: 'Priority',
      resolution: 'Resolution',
      sprint: 'Sprint',
      status: 'Status',
      timeestimate: 'Time estimate',
      timeoriginalestimate: 'Original estimate',
      timespent: 'Time spent',
      version: 'Version',
      versions: 'Versions',
      worklogid: 'Worklog ID'
    };
    const explicitFieldName = fieldNames?.[fieldId] || fieldNames?.[fieldName];
    if (explicitFieldName) {
      return explicitFieldName;
    }
    if (mappedFieldNames[normalizedFieldId]) {
      return mappedFieldNames[normalizedFieldId];
    }
    const rawLabel = String(fieldName || fieldId || 'Unknown field')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return toHistoryTitleCase(rawLabel || 'Unknown field');
  }

  function isHistoryCommentField(fieldName) {
    return normalizeHistoryFieldName(fieldName) === 'comment';
  }

  function isHistoryDescriptionField(fieldName) {
    return normalizeHistoryFieldName(fieldName) === 'description';
  }

  function isHistoryAttachmentField(fieldName) {
    return normalizeHistoryFieldName(fieldName) === 'attachment';
  }

  function isHistorySuppressedField(fieldName) {
    const normalized = normalizeHistoryFieldName(fieldName).replace(/\s+/g, '');
    return normalized === 'worklogid';
  }

  function looksLikeHtmlFragment(value) {
    return /<\/?[a-z][\s\S]*>/i.test(String(value || ''));
  }

  function stripHistoryAttachmentMarkup(value) {
    return String(value || '')
      .replace(/!\s*([^!\r\n]+?)(?:\|[^!\r\n]*)?!/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function buildHistoryHtmlPlaceholderStore() {
    const values = [];
    return {
      restore(text) {
        return String(text || '').replace(/__JX_HISTORY_HTML_(\d+)__/g, (match, index) => {
          return values[Number(index)] || '';
        });
      },
      stash(html) {
        const token = `__JX_HISTORY_HTML_${values.length}__`;
        values.push(html);
        return token;
      }
    };
  }

  function toAbsoluteHistoryHref(href) {
    const normalizedHref = String(href || '').trim();
    if (!normalizedHref) {
      return '';
    }
    try {
      return new URL(normalizedHref, instanceUrl).toString();
    } catch (ex) {
      return normalizedHref;
    }
  }

  function buildHistoryExternalLinkHtml(label, href) {
    const normalizedHref = toAbsoluteHistoryHref(href);
    const linkText = String(label || normalizedHref).trim();
    if (!normalizedHref || !linkText) {
      return escapeHtml(linkText || href || '');
    }
    return `<a href="${escapeHtml(normalizedHref)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(buildLinkHoverTitle('Open link', linkText, normalizedHref))}">${escapeHtml(linkText)}</a>`;
  }

  function renderHistoryInlineWikiHtml(input) {
    const placeholders = buildHistoryHtmlPlaceholderStore();
    const withPlaceholders = String(input || '')
      .replace(/\{noformat\}([\s\S]+?)\{noformat\}/gi, (match, value) => {
        return placeholders.stash(`<code>${escapeHtml(value)}</code>`);
      })
      .replace(/\{code(?::[^}]*)?\}([\s\S]+?)\{code\}/gi, (match, value) => {
        return placeholders.stash(`<code>${escapeHtml(value)}</code>`);
      })
      .replace(/\{\{([^{}\n]+)\}\}/g, (match, value) => {
        return placeholders.stash(`<code>${escapeHtml(value)}</code>`);
      })
      .replace(/\[([^|\]\r\n]+?)\|([^]\r\n]+?)\]/g, (match, label, href) => {
        return placeholders.stash(buildHistoryExternalLinkHtml(label, href));
      })
      .replace(/\[(https?:\/\/[^[\]\r\n]+?)\]/g, (match, href) => {
        return placeholders.stash(buildHistoryExternalLinkHtml(href, href));
      })
      .replace(/(https?:\/\/[^\s<]+)/g, (match, href) => {
        return placeholders.stash(buildHistoryExternalLinkHtml(href, href));
      });

    let html = escapeHtml(withPlaceholders);
    const applyWrappedTag = (source, marker, tagName) => {
      const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return source.replace(
        new RegExp(`(^|[\\s([{"'])${escapedMarker}([^\\n]+?)${escapedMarker}(?=($|[\\s).,!?;:\\]}'"]))`, 'gm'),
        (match, prefix, content, suffix) => `${prefix}<${tagName}>${content}</${tagName}>${suffix}`
      );
    };

    html = applyWrappedTag(html, '*', 'strong');
    html = applyWrappedTag(html, '_', 'em');
    html = applyWrappedTag(html, '+', 'u');
    html = applyWrappedTag(html, '-', 'del');
    return placeholders.restore(html);
  }

  function renderHistoryWikiMarkupHtml(input) {
    const lines = String(input || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n');
    const blocks = [];
    let paragraphLines = [];
    let listType = '';
    let listItems = [];
    let preLines = null;

    const flushParagraph = () => {
      if (!paragraphLines.length) {
        return;
      }
      blocks.push(`<p>${paragraphLines.map(renderHistoryInlineWikiHtml).join('<br/>')}</p>`);
      paragraphLines = [];
    };

    const flushList = () => {
      if (!listItems.length || !listType) {
        return;
      }
      blocks.push(`<${listType}>${listItems.map(item => `<li>${renderHistoryInlineWikiHtml(item)}</li>`).join('')}</${listType}>`);
      listItems = [];
      listType = '';
    };

    const flushPre = () => {
      if (!preLines) {
        return;
      }
      blocks.push(`<pre>${escapeHtml(preLines.join('\n'))}</pre>`);
      preLines = null;
    };

    lines.forEach(line => {
      const trimmedLine = String(line || '').trim();

      if (preLines) {
        if (/^\{(?:noformat|code(?::[^}]*)?)\}$/i.test(trimmedLine)) {
          flushPre();
        } else {
          preLines.push(String(line || ''));
        }
        return;
      }

      if (!trimmedLine) {
        flushParagraph();
        flushList();
        return;
      }

      if (/^\{(?:noformat|code(?::[^}]*)?)\}$/i.test(trimmedLine)) {
        flushParagraph();
        flushList();
        preLines = [];
        return;
      }

      const headingMatch = trimmedLine.match(/^h([1-6])\.\s+([\s\S]+)$/i);
      if (headingMatch) {
        flushParagraph();
        flushList();
        blocks.push(`<h${headingMatch[1]}>${renderHistoryInlineWikiHtml(headingMatch[2])}</h${headingMatch[1]}>`);
        return;
      }

      const quoteMatch = trimmedLine.match(/^bq\.\s+([\s\S]+)$/i);
      if (quoteMatch) {
        flushParagraph();
        flushList();
        blocks.push(`<blockquote>${renderHistoryInlineWikiHtml(quoteMatch[1])}</blockquote>`);
        return;
      }

      const listMatch = trimmedLine.match(/^([*#]+)\s+([\s\S]+)$/);
      if (listMatch) {
        flushParagraph();
        const nextListType = listMatch[1][0] === '#' ? 'ol' : 'ul';
        if (listType && listType !== nextListType) {
          flushList();
        }
        listType = nextListType;
        listItems.push(listMatch[2]);
        return;
      }

      flushList();
      paragraphLines.push(String(line || ''));
    });

    flushParagraph();
    flushList();
    flushPre();
    return blocks.join('');
  }

  function buildHistoryTimestampParts(created) {
    const createdAt = new Date(created);
    if (Number.isNaN(createdAt.getTime())) {
      return {
        createdAt,
        createdMs: 0,
        full: '--',
        short: '--'
      };
    }
    const dateStr = createdAt.toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
    const timeStr = createdAt.toLocaleTimeString('en-US', {hour: '2-digit', minute: '2-digit', hour12: false});
    return {
      createdAt,
      createdMs: createdAt.getTime(),
      full: `${dateStr}, ${timeStr}`,
      short: timeStr
    };
  }

  function buildHistoryAttachmentActionHtml(attachmentView, options = {}) {
    const {className = '_JX_history_attachment_link'} = options;
    const filename = String(attachmentView?.filename || '').trim();
    const previewSrc = attachmentView?.previewDisplaySrc || attachmentView?.previewSrc || '';
    if (!filename) {
      return '--';
    }
    if (attachmentView?.isPreviewable) {
      return `<button class="_JX_history_attachment_preview ${escapeHtml(className)}" type="button" data-jx-preview-src="${escapeHtml(previewSrc)}" title="${escapeHtml(attachmentView.previewTitle)}">${escapeHtml(filename)}</button>`;
    }
    if (attachmentView?.hasUrl) {
      return `<a class="${escapeHtml(className)}" href="${escapeHtml(attachmentView.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(attachmentView.linkTitle)}">${escapeHtml(filename)}</a>`;
    }
    return `<span class="_JX_history_attachment_name">${escapeHtml(filename)}</span>`;
  }

  async function renderHistoryRichTextHtml(value, attachmentLookup = new Map()) {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) {
      return '';
    }
    const baseHtml = looksLikeHtmlFragment(normalizedValue)
      ? await normalizeRichHtml(normalizedValue, {imageMaxHeight: 120, attachmentLookup})
      : await normalizeRichHtml(renderHistoryWikiMarkupHtml(normalizedValue), {imageMaxHeight: 120, attachmentLookup});
    return linkifyHistoryIssueKeysInHtml(baseHtml);
  }

  function isChangelogTimeField(fieldName) {
    const normalizedFieldName = String(fieldName || '').toLowerCase().replace(/[\s_]+/g, '');
    return [
      'timeestimate',
      'timeoriginalestimate',
      'timespent',
      'aggregatetimeestimate',
      'aggregatetimeoriginalestimate',
      'aggregatetimespent'
    ].includes(normalizedFieldName);
  }

  function formatChangelogDuration(value) {
    const normalizedValue = String(value || '').trim();
    if (!/^-?\d+$/.test(normalizedValue)) {
      return normalizedValue;
    }
    const totalSeconds = Number(normalizedValue);
    if (!Number.isFinite(totalSeconds)) {
      return normalizedValue;
    }
    if (totalSeconds === 0) {
      return '0h';
    }
    const absoluteSeconds = Math.abs(totalSeconds);
    const totalMinutes = Math.round(absoluteSeconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    const parts = [];
    if (hours) {
      parts.push(`${hours}h`);
    }
    if (minutes || !parts.length) {
      parts.push(`${minutes}m`);
    }
    return `${totalSeconds < 0 ? '-' : ''}${parts.join(' ')}`;
  }

  function formatChangelogFieldValue(fieldName, value) {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) {
      return '';
    }
    return isChangelogTimeField(fieldName)
      ? formatChangelogDuration(normalizedValue)
      : normalizedValue;
  }

  function buildHistoryAttachmentHtml(value, attachmentLookup) {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) {
      return '--';
    }
    const attachmentView = attachmentLookup.get(normalizeHistoryAttachmentName(normalizedValue));
    if (!attachmentView?.hasUrl) {
      return historyTextToHtml(normalizedValue);
    }
    return buildHistoryAttachmentActionHtml(attachmentView);
  }

  function formatHistoryFieldHtml(fieldName, value, attachmentLookup) {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) {
      return '--';
    }
    if (isHistoryAttachmentField(fieldName)) {
      return buildHistoryAttachmentHtml(normalizedValue, attachmentLookup);
    }
    return historyTextToHtml(normalizedValue);
  }

  function historyTextToHtml(input) {
    const rawText = String(input || '');
    const issueKeyPattern = new RegExp(fallbackJiraKeyPattern, 'g');
    let html = '';
    let lastIndex = 0;
    let match;
    while ((match = issueKeyPattern.exec(rawText)) !== null) {
      const matchedText = match[0];
      const normalizedIssueKey = normalizeIssueKey(matchedText);
      const issueUrl = `${instanceUrl}browse/${normalizedIssueKey}`;
      html += escapeHtml(rawText.slice(lastIndex, match.index));
      html += `<a class="_JX_history_issue_link" href="${escapeHtml(issueUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(buildLinkHoverTitle('Open issue in Jira', normalizedIssueKey, issueUrl))}">${escapeHtml(matchedText)}</a>`;
      lastIndex = match.index + matchedText.length;
    }
    html += escapeHtml(rawText.slice(lastIndex));
    return html.replace(/\n/g, '<br/>');
  }

  function linkifyHistoryIssueKeysInHtml(html) {
    const temp = document.createElement('div');
    temp.innerHTML = html || '';
    const textNodes = [];
    const walker = document.createTreeWalker(temp, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node?.nodeValue || !node.nodeValue.trim()) {
          return NodeFilter.FILTER_REJECT;
        }
        if (node.parentElement?.closest('a')) {
          return NodeFilter.FILTER_REJECT;
        }
        return new RegExp(fallbackJiraKeyPattern, 'g').test(node.nodeValue)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    });
    let nextNode = walker.nextNode();
    while (nextNode) {
      textNodes.push(nextNode);
      nextNode = walker.nextNode();
    }
    textNodes.forEach(textNode => {
      const rawText = textNode.nodeValue || '';
      const issueKeyPattern = new RegExp(fallbackJiraKeyPattern, 'g');
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      let match;
      while ((match = issueKeyPattern.exec(rawText)) !== null) {
        const matchedText = match[0];
        const normalizedIssueKey = normalizeIssueKey(matchedText);
        const issueUrl = `${instanceUrl}browse/${normalizedIssueKey}`;
        fragment.appendChild(document.createTextNode(rawText.slice(lastIndex, match.index)));
        const anchor = document.createElement('a');
        anchor.className = '_JX_history_issue_link';
        anchor.href = issueUrl;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.title = buildLinkHoverTitle('Open issue in Jira', normalizedIssueKey, issueUrl);
        anchor.textContent = matchedText;
        fragment.appendChild(anchor);
        lastIndex = match.index + matchedText.length;
      }
      fragment.appendChild(document.createTextNode(rawText.slice(lastIndex)));
      textNode.parentNode?.replaceChild(fragment, textNode);
    });
    return temp.innerHTML;
  }

  async function buildHistoryRichSections(fieldLabel, fromValue, toValue, attachmentLookup = new Map()) {
    const hasFromValue = !!fromValue;
    const hasToValue = !!toValue;
    const sectionSpecs = [];
    if (hasFromValue && hasToValue && fromValue !== toValue) {
      sectionSpecs.push({label: 'Before', showLabel: true, value: fromValue});
      sectionSpecs.push({label: 'After', showLabel: true, value: toValue});
    } else if (hasToValue || hasFromValue) {
      sectionSpecs.push({label: fieldLabel, showLabel: false, value: toValue || fromValue});
    }
    return Promise.all(sectionSpecs.map(async section => ({
      ...section,
      bodyHtml: await renderHistoryRichTextHtml(section.value, attachmentLookup)
    })));
  }

  async function buildHistoryEvent(item, entryMeta, attachmentLookup, itemIndex, fieldNames = {}) {
    const fieldKey = item.fieldId || item.field || 'Unknown field';
    const field = buildHistoryFieldLabel(item.field, fieldKey, fieldNames);
    if (isHistorySuppressedField(fieldKey)) {
      return null;
    }
    const rawFromString = String(item.fromString || '').trim();
    const rawToString = String(item.toString || '').trim();
    const eventId = `${entryMeta.createdMs}-${itemIndex}-${normalizeHistoryFieldName(fieldKey)}`;
    if (isHistoryCommentField(fieldKey) || isHistoryDescriptionField(fieldKey)) {
      const richKind = isHistoryCommentField(fieldKey) ? 'comment' : 'description';
      const referencedAttachmentNames = richKind === 'comment'
        ? collectReferencedHistoryAttachmentNames([rawToString, rawFromString].filter(Boolean).join('\n'), attachmentLookup)
        : new Set();
      const attachments = dedupeHistoryAttachments([...referencedAttachmentNames].map(fileName => {
        return attachmentLookup.get(fileName) || buildHistoryAttachmentView(null, fileName);
      }).filter(Boolean));
      const cleanedFromValue = richKind === 'comment'
        ? stripHistoryAttachmentMarkup(rawFromString)
        : rawFromString;
      const cleanedToValue = richKind === 'comment'
        ? stripHistoryAttachmentMarkup(rawToString)
        : rawToString;
      const previewValue = cleanedToValue || cleanedFromValue;
      return {
        eventId,
        eventCreatedMs: entryMeta.createdMs,
        field,
        subTimestamp: entryMeta.timestamp.short,
        isRichTextEvent: true,
        isGenericEvent: false,
        richKind,
        richIcon: richKind === 'comment' ? '💬' : '📝',
        previewSourceText: previewValue,
        previewFallbackText: richKind === 'comment' ? 'View comment' : 'View description',
        previewText: buildHistoryPreviewText(previewValue, {
          attachments,
          fallbackText: richKind === 'comment' ? 'View comment' : 'View description'
        }),
        sections: await buildHistoryRichSections(field, cleanedFromValue, cleanedToValue, attachmentLookup),
        hasSections: !!(cleanedFromValue || cleanedToValue),
        attachments,
        hasAttachments: attachments.length > 0,
        attachmentCountLabel: attachments.length === 1 ? '1 attachment' : `${attachments.length} attachments`,
        referencedAttachmentNames
      };
    }

    const fromString = formatChangelogFieldValue(fieldKey, rawFromString);
    const toString = formatChangelogFieldValue(fieldKey, rawToString);
    const attachmentName = isHistoryAttachmentField(fieldKey)
      ? normalizeHistoryAttachmentName(toString || fromString)
      : '';
    return {
      eventId,
      eventCreatedMs: entryMeta.createdMs,
      field,
      subTimestamp: entryMeta.timestamp.short,
      isRichTextEvent: false,
      isGenericEvent: true,
      isAttachmentEvent: isHistoryAttachmentField(fieldKey),
      attachmentName,
      attachmentView: attachmentName
        ? (attachmentLookup.get(attachmentName) || buildHistoryAttachmentView(null, toString || fromString))
        : null,
      fromString: fromString || '--',
      toString: toString || '--',
      fromHtml: formatHistoryFieldHtml(fieldKey, fromString, attachmentLookup),
      toHtml: formatHistoryFieldHtml(fieldKey, toString, attachmentLookup),
      isLong: fromString.length > 80 || toString.length > 80,
      isShort: !(fromString.length > 80 || toString.length > 80)
    };
  }

  function mergeHistoryAttachmentEventsIntoComments(events, attachmentLookup) {
    const nextEvents = [...(events || [])];
    const commentEvents = nextEvents.filter(event => event.isRichTextEvent && event.richKind === 'comment');
    const attachedEventIds = new Set();
    commentEvents.forEach(commentEvent => {
      commentEvent.attachments = dedupeHistoryAttachments(commentEvent.attachments || []);
    });
    nextEvents.forEach(event => {
      if (!event.isAttachmentEvent || !event.attachmentName) {
        return;
      }
      const matchingComment = commentEvents.find(commentEvent => {
        return commentEvent.referencedAttachmentNames?.has(event.attachmentName);
      });
      if (!matchingComment) {
        return;
      }
      matchingComment.attachments = dedupeHistoryAttachments([
        ...(matchingComment.attachments || []),
        event.attachmentView || buildHistoryAttachmentView(null, event.attachmentName)
      ]);
      matchingComment.hasAttachments = matchingComment.attachments.length > 0;
      matchingComment.attachmentCountLabel = matchingComment.attachments.length === 1
        ? '1 attachment'
        : `${matchingComment.attachments.length} attachments`;
      matchingComment.previewText = buildHistoryPreviewText(matchingComment.previewSourceText, {
        attachments: matchingComment.attachments,
        fallbackText: matchingComment.previewFallbackText
      });
      attachedEventIds.add(event.eventId);
    });
    return nextEvents.filter(event => !attachedEventIds.has(event.eventId));
  }

  function buildCurrentHistoryCommentCandidates(issueData, attachmentLookup) {
    return (issueData?.fields?.comment?.comments || []).map(comment => {
      const body = String(comment?.body || '').trim();
      return {
        id: String(comment?.id || ''),
        author: comment?.author || null,
        created: comment?.created || '',
        createdMs: new Date(comment?.created).getTime(),
        body,
        strippedBody: stripHistoryAttachmentMarkup(body),
        referencedAttachmentNames: collectReferencedHistoryAttachmentNames(body, attachmentLookup)
      };
    }).filter(candidate => {
      return !!candidate.id && !!candidate.body && Number.isFinite(candidate.createdMs);
    });
  }

  function countHistoryAttachmentMatches(leftSet, rightSet) {
    let count = 0;
    leftSet.forEach(value => {
      if (rightSet.has(value)) {
        count += 1;
      }
    });
    return count;
  }

  function normalizeHistoryComparableText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function historyCommentEventMatchesCandidate(event, candidate) {
    const eventText = normalizeHistoryComparableText(event?.previewSourceText || '');
    const candidateText = normalizeHistoryComparableText(candidate?.strippedBody || candidate?.body || '');
    if (!eventText || !candidateText) {
      return false;
    }
    return eventText === candidateText || eventText.includes(candidateText) || candidateText.includes(eventText);
  }

  function isHistoryCandidateWithinWindow(candidateCreatedMs, startMs, endMs, windowMs = HISTORY_GROUP_WINDOW_MS) {
    return !(candidateCreatedMs < startMs - windowMs || candidateCreatedMs > endMs + windowMs);
  }

  function getGroupAttachmentNames(group) {
    return new Set((group?.events || [])
      .filter(event => event.isAttachmentEvent && event.attachmentName)
      .map(event => event.attachmentName));
  }

  function countGroupCandidateAttachmentMatches(group, candidate) {
    return countHistoryAttachmentMatches(candidate?.referencedAttachmentNames || new Set(), getGroupAttachmentNames(group));
  }

  function groupRepresentsCommentCandidate(group, candidate) {
    if (!group || !candidate) {
      return false;
    }
    if (!areSameJiraUser(candidate.author, group.author) && String(candidate.author?.displayName || '') !== String(group.authorName || '')) {
      return false;
    }
    const attachmentMatches = countGroupCandidateAttachmentMatches(group, candidate);
    const isWithinStandardWindow = isHistoryCandidateWithinWindow(candidate.createdMs, group.earliestCreatedMs, group.latestCreatedMs);
    const isWithinAttachmentWindow = attachmentMatches > 0 &&
      isHistoryCandidateWithinWindow(candidate.createdMs, group.earliestCreatedMs, group.latestCreatedMs, HISTORY_ATTACHMENT_MATCH_WINDOW_MS);
    if (!isWithinStandardWindow && !isWithinAttachmentWindow) {
      return false;
    }
    const commentEvents = group.events.filter(event => event.isRichTextEvent && event.richKind === 'comment');
    if (!commentEvents.length) {
      return false;
    }
    return commentEvents.some(event => historyCommentEventMatchesCandidate(event, candidate));
  }

  async function buildSyntheticHistoryCommentEvent(commentCandidate, attachmentLookup) {
    const attachments = dedupeHistoryAttachments([...commentCandidate.referencedAttachmentNames].map(fileName => {
      return attachmentLookup.get(fileName) || buildHistoryAttachmentView(null, fileName);
    }).filter(Boolean));
    const previewSourceText = commentCandidate.strippedBody || commentCandidate.body;
    return {
      eventId: `synthetic-comment-${commentCandidate.id}`,
      eventCreatedMs: commentCandidate.createdMs,
      field: 'Comment',
      subTimestamp: buildHistoryTimestampParts(commentCandidate.created).short,
      isRichTextEvent: true,
      isGenericEvent: false,
      richKind: 'comment',
      richIcon: '💬',
      previewSourceText,
      previewFallbackText: 'View comment',
      previewText: buildHistoryPreviewText(previewSourceText, {
        attachments,
        fallbackText: 'View comment'
      }),
      sections: await buildHistoryRichSections('Comment', '', previewSourceText, attachmentLookup),
      hasSections: !!previewSourceText,
      attachments,
      hasAttachments: attachments.length > 0,
      attachmentCountLabel: attachments.length === 1 ? '1 attachment' : `${attachments.length} attachments`,
      referencedAttachmentNames: commentCandidate.referencedAttachmentNames
    };
  }

  async function buildSyntheticHistoryCommentGroup(commentCandidate, attachmentLookup) {
    const timestamp = buildHistoryTimestampParts(commentCandidate.created);
    return {
      authorKey: String(commentCandidate.author?.accountId || commentCandidate.author?.key || commentCandidate.author?.name || commentCandidate.author?.displayName || commentCandidate.id),
      author: commentCandidate.author || null,
      authorName: commentCandidate.author?.displayName || commentCandidate.author?.name || 'Unknown',
      latestCreatedMs: commentCandidate.createdMs,
      earliestCreatedMs: commentCandidate.createdMs,
      timestamp: timestamp.full,
      events: [await buildSyntheticHistoryCommentEvent(commentCandidate, attachmentLookup)]
    };
  }

  async function injectSyntheticHistoryComment(group, commentCandidates, attachmentLookup, usedCommentIds) {
    const hasCommentEvent = group.events.some(event => event.isRichTextEvent && event.richKind === 'comment');
    if (hasCommentEvent) {
      return;
    }
    const groupAttachmentNames = getGroupAttachmentNames(group);
    if (!groupAttachmentNames.size) {
      return;
    }
    const matchingComment = commentCandidates
      .filter(candidate => {
        if (usedCommentIds.has(candidate.id)) {
          return false;
        }
        if (!areSameJiraUser(candidate.author, group.author) && String(candidate.author?.displayName || '') !== String(group.authorName || '')) {
          return false;
        }
        const attachmentMatches = countHistoryAttachmentMatches(candidate.referencedAttachmentNames, groupAttachmentNames);
        if (!attachmentMatches) {
          return false;
        }
        if (!isHistoryCandidateWithinWindow(candidate.createdMs, group.earliestCreatedMs, group.latestCreatedMs, HISTORY_ATTACHMENT_MATCH_WINDOW_MS)) {
          return false;
        }
        return true;
      })
      .sort((left, right) => {
        const rightMatches = countHistoryAttachmentMatches(right.referencedAttachmentNames, groupAttachmentNames);
        const leftMatches = countHistoryAttachmentMatches(left.referencedAttachmentNames, groupAttachmentNames);
        if (rightMatches !== leftMatches) {
          return rightMatches - leftMatches;
        }
        const leftWithinTightWindow = isHistoryCandidateWithinWindow(left.createdMs, group.earliestCreatedMs, group.latestCreatedMs);
        const rightWithinTightWindow = isHistoryCandidateWithinWindow(right.createdMs, group.earliestCreatedMs, group.latestCreatedMs);
        if (leftWithinTightWindow !== rightWithinTightWindow) {
          return Number(rightWithinTightWindow) - Number(leftWithinTightWindow);
        }
        return Math.abs(left.createdMs - group.latestCreatedMs) - Math.abs(right.createdMs - group.latestCreatedMs);
      })[0];
    if (!matchingComment) {
      return;
    }
    group.events.unshift(await buildSyntheticHistoryCommentEvent(matchingComment, attachmentLookup));
    usedCommentIds.add(matchingComment.id);
  }

  function coalesceHistoryGroups(groups) {
    const sortedGroups = [...groups].sort((left, right) => right.latestCreatedMs - left.latestCreatedMs);
    return sortedGroups.reduce((mergedGroups, group) => {
      const previousGroup = mergedGroups[mergedGroups.length - 1];
      const shouldMerge = !!previousGroup && previousGroup.authorKey === group.authorKey && (previousGroup.earliestCreatedMs - group.latestCreatedMs) <= HISTORY_GROUP_WINDOW_MS;
      if (!shouldMerge) {
        mergedGroups.push({...group, events: [...group.events]});
        return mergedGroups;
      }
      previousGroup.earliestCreatedMs = Math.min(previousGroup.earliestCreatedMs, group.earliestCreatedMs);
      previousGroup.latestCreatedMs = Math.max(previousGroup.latestCreatedMs, group.latestCreatedMs);
      previousGroup.events.push(...group.events);
      return mergedGroups;
    }, []);
  }

  async function formatChangelogForDisplay(changelog, issueData) {
    const histories = changelog?.histories || [];
    const attachmentLookup = buildHistoryAttachmentLookup(issueData?.fields?.attachment || []);
    const commentCandidates = buildCurrentHistoryCommentCandidates(issueData, attachmentLookup);
    const usedCommentIds = new Set();
    const sorted = histories.slice().sort((a, b) => new Date(b.created) - new Date(a.created));
    const groups = [];
    for (const entry of sorted) {
      const timestamp = buildHistoryTimestampParts(entry.created);
      const authorName = entry.author?.displayName || entry.author?.name || 'Unknown';
      const authorKey = String(entry.author?.accountId || entry.author?.key || entry.author?.name || authorName);
      const events = (await Promise.all((entry.items || []).map((item, itemIndex) => {
        return buildHistoryEvent(item, {
          createdMs: timestamp.createdMs,
          timestamp,
          authorName
        }, attachmentLookup, itemIndex, issueData?.names || {});
      }))).filter(Boolean);
      if (!events.length) {
        continue;
      }
      const currentGroup = groups[groups.length - 1];
      const shouldMerge = !!currentGroup &&
        currentGroup.authorKey === authorKey &&
        (currentGroup.earliestCreatedMs - timestamp.createdMs) <= HISTORY_GROUP_WINDOW_MS;
      if (shouldMerge) {
        currentGroup.earliestCreatedMs = timestamp.createdMs;
        currentGroup.events.push(...events);
        continue;
      }
      groups.push({
        authorKey,
        author: entry.author || null,
        authorName,
        latestCreatedMs: timestamp.createdMs,
        earliestCreatedMs: timestamp.createdMs,
        timestamp: timestamp.full,
        events
      });
    }
    commentCandidates.forEach(candidate => {
      if (groups.some(group => groupRepresentsCommentCandidate(group, candidate))) {
        usedCommentIds.add(candidate.id);
      }
    });
    for (const group of groups) {
      await injectSyntheticHistoryComment(group, commentCandidates, attachmentLookup, usedCommentIds);
    }
    const syntheticGroups = [];
    for (const candidate of commentCandidates) {
      if (usedCommentIds.has(candidate.id)) {
        continue;
      }
      syntheticGroups.push(await buildSyntheticHistoryCommentGroup(candidate, attachmentLookup));
      usedCommentIds.add(candidate.id);
    }
    const normalizedGroups = coalesceHistoryGroups([...groups, ...syntheticGroups]);
    return normalizedGroups.map(group => {
      const events = mergeHistoryAttachmentEventsIntoComments(
        [...group.events].sort((left, right) => (right.eventCreatedMs || 0) - (left.eventCreatedMs || 0)),
        attachmentLookup
      );
      const distinctTimes = new Set(events.map(event => event.subTimestamp).filter(Boolean)).size;
      return {
        timestamp: group.timestamp,
        authorName: group.authorName,
        events: events.map(event => ({
          ...event,
          showSubTimestamp: distinctTimes > 1
        })),
        hasEvents: events.length > 0
      };
    });
  }

  return {
    formatChangelogForDisplay,
  };
}
