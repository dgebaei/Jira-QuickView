import {createPopupShortcutWorkflow} from 'src/popup-shortcut-workflow';

// [key, action, Alt + key action, other key for the same action], numbered in
// help order and grouped: one field, sprint planning, then the issue itself.
// Alt+0 toggles the help.
export const POPUP_SHORTCUT_GROUPS = [
  [
    ['1', 'Reassign', 'Assign to me', 'A'],
    ['2', 'Change sprint', 'Move to current sprint', 'S'],
    ['3', 'Change status', 'Resolve / close'],
    ['4', 'Change fix version', 'Add next unreleased version'],
  ],
  [
    ['5', 'Current sprint + reassign', 'Current sprint + assign to me'],
    ['6', 'Next sprint + reassign', 'Next sprint + assign to me'],
  ],
  [
    ['7', 'Add comment', '', 'C'],
    ['8', 'Copy issue reference', 'Copy plain issue URL', 'Ctrl+C'],
    ['9', 'Open in Jira', ''],
  ],
];

export function matchPopupShortcut(event) {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 ||
    event.getModifierState?.('AltGraph')) return null;
  if (event.target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]')) return null;
  const key = String(event.key || '');
  const letter = /^[a-z]$/i.test(key) ? key.toLowerCase() : /^Key[A-Z]$/.test(event.code || '') ? event.code.slice(3).toLowerCase() : '';
  // Ctrl/Cmd+C copies the issue link, unless text is selected: then it stays the browser's copy.
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && letter === 'c') {
    const selection = event.target?.ownerDocument?.getSelection?.();
    return selection && !selection.isCollapsed && String(selection).trim() ? null : {digit: '8', alternate: false};
  }
  if (event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (!event.altKey && letter === 'a') return {digit: '1', alternate: false};
  if (!event.altKey && letter === 's') return {digit: '2', alternate: false};
  if (!event.altKey && letter === 'c') return {digit: '7', alternate: false};
  // Option on macOS changes event.key; use the physical digit for Alt variants only.
  const digit = /^[0-9]$/.test(key) ? key : event.altKey && /^Digit[0-9]$/.test(event.code) ? event.code.slice(-1) : '';
  if (!digit || (digit === '0' && !event.altKey) || (event.altKey && ['7', '9'].includes(digit))) return null;
  return {digit, alternate: !!event.altKey};
}

// Owns the browser interaction; workflow owns validation, cancellation and writes.
// The native dialog lives outside replaceable popup markup so background renders cannot drop a draft.
// The help is a non-modal popover anchored to the toolbar button, so focus stays
// in QuickView and a digit pressed while it is open runs that shortcut.
export function createBrowserPopupShortcuts(deps) {
  const {container, getSession, isBusy, pin, beginFieldEdit, quickAction, copy, openIssue, focusComment, onSaved, announce} = deps;
  const documentRef = container.ownerDocument;
  const workflow = createPopupShortcutWorkflow(deps);
  let dialog = null;
  let help = null;
  let helpObserver = null;
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

  function helpToggle() {
    return container.querySelector('._JX_shortcuts_help');
  }

  // Help and workflows drop down from the toolbar, right-aligned to the keyboard
  // button, so they read as part of QuickView rather than a page dialog.
  function anchorBelowToolbar(node, {grows = false} = {}) {
    const toggle = helpToggle();
    if (!node || !toggle) return;
    const anchor = toggle.getBoundingClientRect();
    const panel = node.getBoundingClientRect();
    const viewport = documentRef.documentElement;
    const below = anchor.bottom + 6;
    node.style.left = `${Math.max(8, Math.min(anchor.right - panel.width, viewport.clientWidth - panel.width - 8))}px`;
    if (grows) {
      // A workflow's height changes as results load: keep its top fixed and let it scroll.
      const top = Math.max(8, Math.min(below, viewport.clientHeight - 320));
      node.style.top = `${top}px`;
      node.style.maxBlockSize = `${viewport.clientHeight - top - 8}px`;
      return;
    }
    node.style.top = `${below + panel.height + 8 <= viewport.clientHeight ? below : Math.max(8, anchor.top - panel.height - 6)}px`;
  }

  function positionHelp() {
    anchorBelowToolbar(help);
  }

  function closeHelp() {
    if (!help) return;
    helpObserver?.disconnect();
    helpObserver = null;
    if (help.matches(':popover-open')) help.hidePopover();
    help.remove();
    help = null;
    helpToggle()?.setAttribute('aria-expanded', 'false');
  }

  function showHelp() {
    if (dialog || help) return;
    help = element('div', '', documentRef.body, {
      class: '_JX_shortcuts_panel', popover: 'manual', role: 'dialog',
      'aria-labelledby': 'jqv-shortcuts-help-title', 'data-testid': 'jira-shortcut-help',
    });
    const heading = element('div', '', help, {class: '_JX_shortcuts_panel_heading'});
    element('h2', 'Keyboard shortcuts', heading, {id: 'jqv-shortcuts-help-title'});
    element('kbd', 'Alt+0', heading, {title: 'Toggles this list'});
    const table = element('table', '', help);
    const header = element('tr', '', element('thead', '', table));
    ['Key', 'Action', 'Alt + key'].forEach(text => element('th', text, header, {scope: 'col'}));
    POPUP_SHORTCUT_GROUPS.forEach(group => {
      const body = element('tbody', '', table);
      group.forEach(([key, normal, alternate, other]) => {
        const row = element('tr', '', body);
        const keys = element('th', '', row, {scope: 'row'});
        element('kbd', key, keys);
        if (other) element('kbd', other, keys);
        element('td', normal, row);
        element('td', alternate || '—', row);
      });
    });
    element('p', 'Works while QuickView has focus, outside text fields. Sprint planning and resolve confirm first; Alt+1, Alt+2 and Alt+4 apply at once. Ctrl+C copies the link only when no text is selected. Alt is Option and Ctrl is ⌘ on macOS.', help);
    // Clicks inside must not reach the page-level outside-click dismissal.
    help.addEventListener('click', event => event.stopPropagation());
    help.showPopover();
    positionHelp();
    helpToggle()?.setAttribute('aria-expanded', 'true');
    // Background renders replace the toolbar; keep the new button's state and the anchor.
    helpObserver = new MutationObserver(() => {
      helpToggle()?.setAttribute('aria-expanded', 'true');
      positionHelp();
    });
    helpObserver.observe(container, {childList: true, subtree: true});
  }

  function close(force = false) {
    closeHelp();
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
    anchorBelowToolbar(dialog, {grows: true});
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

  // Sprints as a compact single-choice list with state dots, like QuickView's own pickers.
  function sprintChoices(state) {
    element('div', 'Sprint', form, {class: '_JX_shortcuts_label', id: 'jqv-shortcut-sprint-label'});
    const group = element('div', '', form, {
      role: 'radiogroup', 'aria-labelledby': 'jqv-shortcut-sprint-label', class: '_JX_shortcuts_choices', 'data-testid': 'jira-shortcut-sprints',
    });
    const choose = id => {
      workflow.update({sprintId: id});
      render();
    };
    state.sprints.forEach((item, index) => {
      const id = String(item.id);
      const sprintState = String(item.state || '').toLowerCase();
      const checked = state.sprintId === id;
      const option = button(item.name, group, () => choose(id), {
        role: 'radio', 'aria-checked': String(checked), 'data-sprint-id': id,
        tabindex: checked || (!state.sprintId && index === 0) ? '0' : '-1',
      });
      element('span', '', option, {
        class: `_JX_chip_state _JX_chip_state_${sprintState}`, title: `${sprintState[0]?.toUpperCase() || ''}${sprintState.slice(1)} sprint`,
      });
    });
    group.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      const options = [...group.querySelectorAll('[role="radio"]')];
      const current = Math.max(0, options.indexOf(documentRef.activeElement));
      const next = options[(current + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length];
      choose(next.getAttribute('data-sprint-id'));
      form.querySelector(`[data-sprint-id="${next.getAttribute('data-sprint-id')}"]`)?.focus();
    });
  }

  function checkbox(text, name, checked) {
    const label = element('label', '', form, {class: '_JX_shortcuts_check', for: `jqv-shortcut-${name}`});
    const input = element('input', '', label, {type: 'checkbox', id: `jqv-shortcut-${name}`, 'data-testid': `jira-shortcut-${name}`});
    input.checked = checked;
    element('span', text, label);
    input.addEventListener('change', () => workflow.update({[name]: input.checked}));
  }

  // Open in Jira only where the dialog cannot finish the job itself.
  function footer(submitLabel, inJira = false) {
    const actions = element('div', '', form, {class: '_JX_shortcuts_footer'});
    if (inJira) button('Open in Jira', actions, openIssue);
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
      if (!state.sprints.length) { footer('', true); return; }
      sprintChoices(state);
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
      if (!state.sprintId) form.querySelector('[role="radio"]').focus();
      else if (searchInput) searchInput.focus();
      else form.querySelector('[type="submit"]').focus();
    } else {
      if (!state.transitions.length) { footer('', true); return; }
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
      footer(state.unsupported.length ? '' : 'Resolve issue', !!state.unsupported.length);
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
      announce(result.notice, 'success');
    } else render();
  }

  async function showWorkflow(kind, alternate, sprintTarget = 'current') {
    if (dialog) return;
    const session = getSession();
    shell(kind === 'plan' ? `${sprintTarget === 'next' ? 'Next' : 'Current'} sprint + ${alternate ? 'assign to me' : 'reassign'}`
      : 'Resolve / close issue');
    const openedDialog = dialog;
    const pending = workflow.begin({...session, kind, alternate, sprintTarget});
    if (dialog === openedDialog) render();
    await pending;
    if (dialog === openedDialog) render();
  }

  // Alt+2 and Alt+4 have one obvious target, so they write without a dialog.
  async function applyNow(kind) {
    const result = await workflow.apply({...getSession(), kind});
    if (result.kind === 'choose') {
      announce(result.notice, 'info');
      await beginFieldEdit('sprint');
    } else if (result.kind === 'unchanged') announce(result.notice, 'info');
    else if (result.kind === 'saved') {
      await onSaved(result);
      announce(result.notice, 'success');
    }
  }

  async function invoke({digit, alternate}) {
    const helpWasOpen = !!help;
    closeHelp();
    if (digit === '0' && helpWasOpen) return;
    if (invoking || dialog || isBusy() || workflow.busy()) return;
    const request = ++invocation;
    invoking = true;
    try {
      await pin();
      if (!getSession()?.issueSnapshot?.core) return;
      if (digit === '0') showHelp();
      if (digit === '1') await (alternate ? quickAction('assign-to-me') : beginFieldEdit('assignee'));
      if (digit === '2') await (alternate ? applyNow('current-sprint') : beginFieldEdit('sprint'));
      // Closing prefills the remembered defaults; the dialog still confirms.
      if (digit === '3') await (alternate ? showWorkflow('resolve', true) : beginFieldEdit('status'));
      if (digit === '4') await (alternate ? applyNow('next-fix-version') : beginFieldEdit('fixVersions'));
      if (digit === '5') await showWorkflow('plan', alternate);
      if (digit === '6') await showWorkflow('plan', alternate, 'next');
      if (digit === '7') focusComment();
      if (digit === '8') await copy(alternate);
      if (digit === '9') openIssue();
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
    if (help && event.key === 'Escape' && !event.isComposing) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeHelp();
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
    const onToggle = !!event.target.closest?.('._JX_shortcuts_help') && container.contains(event.target);
    if (help && !onToggle && !help.contains(event.target)) closeHelp();
    if (!onToggle) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    invoke({digit: '0', alternate: true}).catch(error => announce(error.message));
  }

  function install() {
    if (installed) return;
    documentRef.addEventListener('keydown', keydown, true);
    documentRef.addEventListener('click', click, true);
    documentRef.addEventListener('scroll', positionHelp, true);
    documentRef.defaultView?.addEventListener('resize', closeHelp);
    installed = true;
  }

  return {install, close, busy: workflow.busy};
}
