import {positionMentionMenuAtCaret} from 'src/mention-menu-positioning';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function createBrowserCommentPresentation({comments, container, shell}) {
  if (typeof comments?.view !== 'function') throw new TypeError('Browser comment presentation requires comments.view()');
  if (typeof container?.find !== 'function') throw new TypeError('Browser comment presentation requires a popup container');
  if (typeof shell?.dispatch !== 'function') throw new TypeError('Browser comment presentation requires shell.dispatch()');

  function elements() {
    return {
      root: container.find('._JX_comment_compose'),
      input: container.find('._JX_comment_input'),
      mentions: container.find('._JX_comment_mentions'),
      uploads: container.find('._JX_comment_uploads'),
      save: container.find('._JX_comment_save'),
      discard: container.find('._JX_comment_discard'),
      error: container.find('._JX_comment_error'),
    };
  }

  function keepVisible() {
    shell.dispatch({type: 'keep-visible'}).catch(() => {});
  }

  function capture() {
    const current = elements();
    const input = current.input.get(0);
    const value = String(input?.value || '');
    return {
      present: !!current.root.length,
      saving: current.root.attr('data-saving') === 'true',
      selection: {
        start: typeof input?.selectionStart === 'number' ? input.selectionStart : value.length,
        end: typeof input?.selectionEnd === 'number' ? input.selectionEnd : value.length,
      },
      value,
    };
  }

  function clipboardImages(event) {
    const clipboardData = event?.originalEvent?.clipboardData || event?.clipboardData;
    if (!clipboardData) return [];
    const itemFiles = Array.from(clipboardData.items || [])
      .filter(item => item?.kind === 'file' && String(item.type || '').toLowerCase().startsWith('image/'))
      .map(item => item.getAsFile())
      .filter(Boolean);
    return itemFiles.length
      ? itemFiles
      : Array.from(clipboardData.files || []).filter(file => String(file?.type || '').toLowerCase().startsWith('image/'));
  }

  function showError(message) {
    const current = elements();
    if (current.error.length) current.error.text(message || '');
  }

  function renderUploads(composeView, current) {
    const uploads = composeView.uploads || [];
    if (!current.uploads.length) return;
    if (!uploads.length) {
      current.uploads.attr('hidden', 'hidden').empty();
      keepVisible();
      return;
    }
    current.uploads.removeAttr('hidden').html(uploads.map(item => {
      const stateClass = item.status === 'error' ? ' is-error' : '';
      const statusText = item.status === 'uploading'
        ? 'Uploading to Jira...'
        : (item.status === 'uploaded' ? 'Attached to issue' : (item.errorMessage || 'Upload failed'));
      const previewHtml = item.previewUrl
        ? `<img class="_JX_comment_upload_preview" src="${escapeHtml(item.previewUrl)}" alt="${escapeHtml(item.fileName)}" />`
        : '<span class="_JX_comment_upload_preview"></span>';
      const retryHtml = item.canRetry
        ? `<button class="_JX_comment_upload_retry" type="button" data-upload-id="${escapeHtml(item.localId)}">Retry</button>`
        : '';
      return `<div class="_JX_comment_upload${stateClass}" data-upload-id="${escapeHtml(item.localId)}">
        ${previewHtml}<span><span class="_JX_comment_upload_name">${escapeHtml(item.fileName)}</span>
        <span class="_JX_comment_upload_status">${escapeHtml(statusText)}</span>${retryHtml}</span></div>`;
    }).join(''));
    keepVisible();
  }

  function renderMentions(composeView, current) {
    const mention = composeView.mention || {visible: false, suggestions: []};
    const menu = current.mentions.get(0);
    const input = current.input.get(0);
    if (!current.mentions.length || !menu) return;
    if (!mention.visible) {
      current.mentions.attr('hidden', 'hidden').empty();
      keepVisible();
      return;
    }
    let html = '';
    if (mention.loading) html = '<div class="_JX_comment_mentions_status">Searching people...</div>';
    else if (mention.errorMessage) html = `<div class="_JX_comment_mentions_status">${escapeHtml(mention.errorMessage)}</div>`;
    else if (!mention.suggestions?.length) html = '<div class="_JX_comment_mentions_status">No people found.</div>';
    else html = mention.suggestions.map((candidate, index) => {
      const selectedClass = index === mention.selectedIndex ? ' is-selected' : '';
      const secondary = candidate.secondaryText
        ? `<span class="_JX_comment_mention_secondary">${escapeHtml(candidate.secondaryText)}</span>`
        : '';
      return `<button class="_JX_comment_mention_option${selectedClass}" type="button" data-mention-index="${index}">
        <span><span class="_JX_comment_mention_primary">${escapeHtml(candidate.displayName)}</span>${secondary}</span></button>`;
    }).join('');
    current.mentions.removeAttr('hidden').html(html);
    if (input) {
      positionMentionMenuAtCaret({
        caretIndex: typeof input.selectionStart === 'number' ? input.selectionStart : mention.range?.start,
        hostElement: current.input.closest('._JX_comment_input_wrap').get(0),
        inputElement: input,
        menuElement: menu,
      });
    }
    keepVisible();
  }

  function render({applyValue = false, restoreFocus = false} = {}) {
    const current = elements();
    const composeView = comments.view().compose;
    if (!current.root.length || !composeView) return {kind: 'ignored'};
    const input = current.input.get(0);
    if (applyValue && input && input.value !== composeView.value) current.input.val(composeView.value);
    showError(composeView.errorMessage);
    const uploads = composeView.uploads || [];
    const uploading = uploads.some(item => item.status === 'uploading');
    current.root.attr('data-saving', composeView.saving ? 'true' : 'false');
    current.input.prop('disabled', !!composeView.saving);
    current.save.prop('disabled', !composeView.canSave).text(composeView.saving ? 'Saving...' : (uploading ? 'Uploading...' : 'Save'));
    current.discard.prop('disabled', (!String(composeView.value || '').trim() && !uploads.length) || !!composeView.saving);
    renderUploads(composeView, current);
    renderMentions(composeView, current);
    if (input && restoreFocus && composeView.focused && !composeView.saving) {
      input.focus();
      const max = input.value.length;
      input.setSelectionRange(Math.min(max, composeView.selection?.start ?? max), Math.min(max, composeView.selection?.end ?? max));
    }
    return {kind: 'rendered'};
  }

  return {capture, clipboardImages, render, showError};
}
