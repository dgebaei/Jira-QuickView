import {createPopupShortcutWorkflow} from 'src/popup-shortcut-workflow';

export const POPUP_SHORTCUTS = [
  ['1', 'Reassign', 'Assign to me'],
  ['2', 'Current sprint + reassign', 'Current sprint + assign to me'],
  ['3', 'Resolve / close', 'Resolve with saved defaults'],
  ['4', 'Choose status transition', 'Start progress'],
  ['5', 'Add comment', ''],
  ['6', 'Copy formatted issue reference', 'Copy plain issue URL'],
  ['7', 'Open issue in Jira', ''],
  ['0', '', 'Show keyboard shortcuts'],
];

export function matchPopupShortcut(event) {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 ||
    event.ctrlKey || event.metaKey || event.shiftKey || event.getModifierState?.('AltGraph')) return null;
  if (event.target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]')) return null;
  // Option on macOS changes event.key; use the physical digit for Alt variants only.
  const digit = /^[0-7]$/.test(event.key) ? event.key : event.altKey && /^Digit[0-7]$/.test(event.code) ? event.code.slice(-1) : '';
  if (!digit || (digit === '0' && !event.altKey) || (event.altKey && ['5', '7'].includes(digit))) return null;
  return {digit, alternate: !!event.altKey};
}

// Owns the browser interaction; workflow owns validation, cancellation and writes.
// The native dialog lives outside replaceable popup markup so background renders cannot drop a draft.
export function createBrowserPopupShortcuts(deps) {
  const {container, getSession, isBusy, pin, beginFieldEdit, quickAction, copy, openIssue, focusComment, onSaved, announce} = deps;
  const documentRef = container.ownerDocument;
  const workflow = createPopupShortcutWorkflow(deps);
  let dialog = null;
  let form = null;
  let status = null;
  let results = null;
  let searchInput = null;
  let highlight = 0;
  let activeSessionId = '';
  let installed = false;
  let invoking = false;
  let invocation = 0;

  function element(tag, text, parent, attributes = {}) {
    const node = documentRef.createElement(tag);
    if (text) node.textContent = text;
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
    if (parent) parent.append(node);
    return node;
  }

  function close(force = false) {
    if (workflow.busy() && !force) return;
    invocation += 1;
    invoking = false;
    workflow.reset();
    if (dialog) {
      dialog.close();
      dialog.remove();
      dialog = null;
      if (!force && container.isConnected) container.focus({preventScroll: true});
    }
    activeSessionId = '';
  }

  function isCurrent() {
    return dialog?.open && getSession()?.sessionId === activeSessionId;
  }

  function shell(title) {
    const session = getSession();
    activeSessionId = session.sessionId;
    dialog = element('dialog', '', documentRef.body, {
      class: '_JX_shortcuts_dialog', 'aria-labelledby': 'jqv-shortcuts-title', 'data-testid': 'jira-shortcut-dialog',
    });
    element('h2', title, dialog, {id: 'jqv-shortcuts-title', tabindex: '-1'});
    element('p', `${session.issueSnapshot.core.key} — ${session.issueSnapshot.core.fields.summary}`, dialog, {class: '_JX_shortcuts_context'});
    status = element('p', '', dialog, {'role': 'status', 'data-testid': 'jira-shortcut-status'});
    form = element('form', '', dialog);
    form.addEventListener('submit', event => {
      event.preventDefault();
      submit().catch(error => announce(error.message));
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter' && (event.repeat || event.isComposing || event.keyCode === 229)) event.preventDefault();
    });
    dialog.addEventListener('click', event => {
      event.stopPropagation();
      if (event.target === dialog) {
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
      }
    });
    dialog.showModal();
  }

  function button(text, parent, handler, attributes = {}) {
    const node = element('button', text, parent, {type: 'button', ...attributes});
    if (handler) node.addEventListener('click', handler);
    return node;
  }

  function field(label, tag, name) {
    const id = `jqv-shortcut-${name}`;
    const wrapper = element('div', '', form, {class: '_JX_shortcuts_field'});
    element('label', label, wrapper, {for: id});
    return element(tag, '', wrapper, {id, name, 'data-testid': `jira-shortcut-${name}`});
  }

  function selectField(label, name, options, value) {
    const select = field(label, 'select', name);
    element('option', 'Choose…', select, {value: ''});
    options.forEach(item => element('option', item.name || item.displayName, select, {value: String(item.id)}));
    select.value = value;
    select.addEventListener('change', () => {
      workflow.update({[name]: select.value});
      if (name === 'transitionId') render();
    });
    return select;
  }

  function checkbox(text, name, checked) {
    const label = element('label', '', form, {class: '_JX_shortcuts_check', for: `jqv-shortcut-${name}`});
    const input = element('input', '', label, {type: 'checkbox', id: `jqv-shortcut-${name}`, 'data-testid': `jira-shortcut-${name}`});
    input.checked = checked;
    element('span', text, label);
    input.addEventListener('change', () => workflow.update({[name]: input.checked}));
  }

  function footer(submitLabel) {
    const actions = element('div', '', form, {class: '_JX_shortcuts_footer'});
    button('Open in Jira', actions, openIssue);
    button('Cancel (Esc)', actions, () => close());
    if (submitLabel) button(submitLabel, actions, null, {type: 'submit', 'data-testid': 'jira-shortcut-submit'});
  }

  function renderResults() {
    if (!isCurrent() || !results) return;
    const state = workflow.view();
    results.replaceChildren();
    status.textContent = state.error || (state.searching ? 'Searching assignees…' : '');
    searchInput.setAttribute('aria-busy', String(state.searching));
    highlight = Math.max(0, Math.min(highlight, state.users.length - 1));
    state.users.forEach((user, index) => {
      const id = String(user.accountId || user.name || user.key);
      const option = button(user.displayName || user.name || user.key, results, () => {
        workflow.update({userId: id});
        highlight = index;
        renderResults();
        form.querySelector('[type="submit"]').focus();
      }, {role: 'option', id: `jqv-shortcut-user-${index}`, 'aria-selected': String(state.userId === id), tabindex: '-1'});
      option.classList.toggle('is-highlighted', index === highlight);
    });
    const active = state.users.length ? `jqv-shortcut-user-${highlight}` : '';
    if (active) searchInput.setAttribute('aria-activedescendant', active);
    else searchInput.removeAttribute('aria-activedescendant');
    if (!state.searching && !state.users.length) element('p', 'No matching assignees', results, {role: 'presentation'});
  }

  function render() {
    if (!isCurrent()) return;
    const state = workflow.view();
    form.replaceChildren();
    results = null;
    searchInput = null;
    status.textContent = state.error || state.hint || (state.phase === 'loading' ? 'Loading…' : '');
    if (state.phase === 'loading') { footer(); return; }
    if (state.kind === 'plan') {
      if (!state.sprints.length) { footer(); return; }
      selectField('Active sprint', 'sprintId', state.sprints, state.sprintId);
      if (state.alternate) {
        element('p', `Assign to: ${state.users[0]?.displayName || state.users[0]?.name || 'you'}`, form);
      } else {
        searchInput = field('Assignee — type to search', 'input', 'assignee');
        searchInput.autocomplete = 'off';
        searchInput.value = state.query;
        searchInput.setAttribute('role', 'combobox');
        searchInput.setAttribute('aria-autocomplete', 'list');
        searchInput.setAttribute('aria-expanded', 'true');
        searchInput.setAttribute('aria-controls', 'jqv-shortcut-users');
        results = element('div', '', form, {role: 'listbox', id: 'jqv-shortcut-users', 'aria-label': 'Assignable users'});
        searchInput.addEventListener('input', async () => {
          const query = searchInput.value;
          const pending = workflow.search(query);
          highlight = 0;
          renderResults();
          await pending;
          renderResults();
        });
        searchInput.addEventListener('keydown', event => {
          if (event.isComposing || event.keyCode === 229 || event.repeat) return;
          const current = workflow.view();
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            highlight = Math.max(0, Math.min(current.users.length - 1, highlight + (event.key === 'ArrowDown' ? 1 : -1)));
            renderResults();
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            if (current.searching || !current.users[highlight]) return;
            const user = current.users[highlight];
            workflow.update({userId: String(user.accountId || user.name || user.key)});
            form.requestSubmit();
          }
        });
        renderResults();
      }
      footer('Apply sprint + assignee');
      if (!state.sprintId) form.querySelector('select').focus();
      else if (searchInput) searchInput.focus();
      else form.querySelector('[type="submit"]').focus();
    } else {
      if (!state.transitions.length) { footer(); return; }
      selectField('Transition', 'transitionId', state.transitions.map(item => ({...item, name: `${item.name} → ${item.to.name}`})), state.transitionId);
      if (state.hasResolution) {
        const resolution = selectField(`Resolution${state.resolutionRequired ? ' (required)' : ''}`, 'resolutionId', state.resolutions, state.resolutionId);
        resolution.required = state.resolutionRequired;
      }
      const comment = field(`Comment${state.commentRequired ? ' (required)' : ' (optional)'}`, 'textarea', 'comment');
      comment.value = state.comment;
      comment.required = state.commentRequired;
      comment.addEventListener('input', () => workflow.update({comment: comment.value}));
      if (state.kind === 'resolve') {
        checkbox('Remember transition and resolution for Alt+3 in this project and issue type', 'remember', state.remember);
        checkbox('For Alt+3, use “.” only when Jira requires a comment', 'useDot', state.useDot);
      }
      if (state.unsupported.length) element('p', `Complete in Jira: ${state.unsupported.join(', ')}.`, form);
      footer(state.unsupported.length ? '' : state.kind === 'resolve' ? 'Resolve issue' : 'Start progress');
      if (state.alternate && state.transitionId && !state.unsupported.length) form.querySelector('[type="submit"]').focus();
      else form.querySelector('select').focus();
    }
  }

  async function submit() {
    if (!isCurrent()) { close(true); return; }
    const pending = workflow.submit({sessionId: getSession().sessionId});
    if (workflow.busy()) {
      status.textContent = 'Saving… Escape cannot undo a submitted update.';
      form.querySelectorAll('input, select, textarea, button').forEach(node => { node.disabled = true; });
    }
    const result = await pending;
    if (!isCurrent()) return;
    if (result.kind === 'saved') {
      close();
      await onSaved(result);
      announce(result.notice);
    } else render();
  }

  async function showWorkflow(kind, alternate) {
    if (dialog) return;
    const session = getSession();
    shell(kind === 'plan' ? 'Current sprint + reassign' : kind === 'resolve' ? 'Resolve / close issue' : 'Start progress');
    const openedDialog = dialog;
    const pending = workflow.begin({...session, kind, alternate});
    if (dialog === openedDialog) render();
    await pending;
    if (dialog === openedDialog) render();
  }

  function showHelp() {
    if (dialog) return;
    shell('Keyboard shortcuts');
    const table = element('table', '', form);
    element('caption', 'Available while QuickView has focus, outside text fields.', table);
    const header = element('tr', '', element('thead', '', table));
    ['Key', 'Action', 'Alt + key'].forEach(text => element('th', text, header, {scope: 'col'}));
    const body = element('tbody', '', table);
    POPUP_SHORTCUTS.forEach(([key, normal, alternate]) => {
      const row = element('tr', '', body);
      element('th', key, row, {scope: 'row'});
      element('td', normal || '—', row);
      element('td', alternate || '—', row);
    });
    element('p', 'Esc cancels the pending workflow; press Esc again to close QuickView. Alt+2 and Alt+3 require confirmation. Alt is Option on macOS.', form);
    button('Close', form, () => close());
    dialog.querySelector('h2').focus({preventScroll: true});
    dialog.scrollTop = 0;
  }

  async function invoke({digit, alternate}) {
    if (invoking || dialog || isBusy() || workflow.busy()) return;
    const request = ++invocation;
    invoking = true;
    try {
      await pin();
      if (!getSession()?.issueSnapshot?.core) return;
      if (digit === '0') showHelp();
      if (digit === '1') await (alternate ? quickAction('assign-to-me') : beginFieldEdit('assignee'));
      if (digit === '2') await showWorkflow('plan', alternate);
      if (digit === '3') await showWorkflow('resolve', alternate);
      if (digit === '4') await (alternate ? showWorkflow('progress', true) : beginFieldEdit('status'));
      if (digit === '5') focusComment();
      if (digit === '6') await copy(alternate);
      if (digit === '7') openIssue();
    } catch (error) { announce(error.message || 'Action unavailable'); }
    finally { if (request === invocation) invoking = false; }
  }

  function keydown(event) {
    if (dialog?.open) {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      }
      return;
    }
    if (!container.contains(documentRef.activeElement) || !container.contains(event.target) || !getSession()?.issueSnapshot?.core) return;
    const shortcut = matchPopupShortcut(event);
    if (!shortcut) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    invoke(shortcut).catch(error => announce(error.message));
  }

  function click(event) {
    if (!event.target.closest?.('._JX_shortcuts_help')) return;
    if (!container.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    invoke({digit: '0', alternate: true}).catch(error => announce(error.message));
  }

  function install() {
    if (installed) return;
    documentRef.addEventListener('keydown', keydown, true);
    documentRef.addEventListener('click', click, true);
    installed = true;
  }

  return {install, close, busy: workflow.busy};
}
