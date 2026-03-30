/*global chrome */
import React, {useEffect, useState, useCallback, useRef} from 'react';
import ReactDOM from 'react-dom';
import defaultConfig, {buildTooltipLayoutFromDisplayFields} from 'options/config';
import {storageGet, storageSet, permissionsRequest} from 'src/chrome';
import {resetDeclarativeMapping, toMatchUrl} from 'options/declarative';
import {DEFAULT_THEME_MODE, SUPPORTED_THEME_MODES, normalizeThemeMode, syncDocumentTheme} from 'src/theme';
import {TooltipLayoutEditor} from 'options/tooltip-layout-editor';
import {
  normalizeInstanceUrl,
  normalizeCustomFields,
  updateCustomFieldRow,
  buildOptionsSnapshot,
  fetchFieldCatalog,
  getCustomFieldError,
} from 'options/options-utils';

import 'options/options.scss';

const TOOLTIP_LAYOUT_ZONES = ['row1', 'row2', 'row3'];

async function main() {
  const storedConfig = await storageGet(defaultConfig);
  syncDocumentTheme(document, storedConfig.themeMode || DEFAULT_THEME_MODE);
  ReactDOM.render(
    <ConfigPage {...storedConfig} />,
    document.getElementById('container')
  );
}


function ConfigPage(props) {
  const initialTooltipLayout = props.tooltipLayout || buildTooltipLayoutFromDisplayFields({
    ...defaultConfig.displayFields,
    ...(props.displayFields || {})
  });
  const [instanceUrl, setInstanceUrl] = useState(props.instanceUrl || '');
  const [domainsText, setDomainsText] = useState((props.domains || []).join(', '));
  const [themeMode, setThemeMode] = useState(normalizeThemeMode(props.themeMode || DEFAULT_THEME_MODE));
  const [displayFields, setDisplayFields] = useState({
    ...defaultConfig.displayFields,
    ...(props.displayFields || {})
  });
  const [hoverDepth, setHoverDepth] = useState(props.hoverDepth || 'shallow');
  const [hoverModifierKey, setHoverModifierKey] = useState(props.hoverModifierKey || 'none');
  const [customFields, setCustomFields] = useState(() =>
    normalizeCustomFields(props.customFields, initialTooltipLayout).map((f, i) => ({...f, _uid: f._uid || `cf-${Date.now()}-${i}`}))
  );
  const [tooltipLayout, setTooltipLayout] = useState(initialTooltipLayout);
  const [fieldCatalog, setFieldCatalog] = useState({});
  const [status, setStatus] = useState('');
  const [statusTone, setStatusTone] = useState('neutral');
  const [isSaving, setIsSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(
    () => sessionStorage.getItem('jhl_adv') === '1'
  );
  const customFieldErrors = customFields.map(field => getCustomFieldError(field.fieldId, fieldCatalog));
  const hasInvalidCustomFields = customFieldErrors.some(Boolean);

  const savedJsonRef = useRef(buildOptionsSnapshot({
    instanceUrl: props.instanceUrl || '',
    domainsText: (props.domains || []).join(', '),
    themeMode: normalizeThemeMode(props.themeMode || DEFAULT_THEME_MODE),
    hoverDepth: props.hoverDepth || 'shallow',
    hoverModifierKey: props.hoverModifierKey || 'none',
    tooltipLayout,
    customFields,
  }));
  const currentJson = buildOptionsSnapshot({
    instanceUrl,
    domainsText,
    themeMode,
    hoverDepth,
    hoverModifierKey,
    tooltipLayout,
    customFields,
  });
  const isDirty = currentJson !== savedJsonRef.current;

  const toggleAdvanced = useCallback(() => {
    setShowAdvanced(prev => {
      const next = !prev;
      sessionStorage.setItem('jhl_adv', next ? '1' : '0');
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const normalizedInstanceUrl = normalizeInstanceUrl(instanceUrl || props.instanceUrl);
    fetchFieldCatalog(normalizedInstanceUrl).then(catalog => {
      if (!cancelled) {
        setFieldCatalog(catalog);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [instanceUrl, props.instanceUrl]);

  useEffect(() => syncDocumentTheme(document, themeMode), [themeMode]);

  const setDisplayFieldValue = (key, checked) => {
    setDisplayFields(current => ({
      ...current,
      [key]: checked
    }));
  };

  const addCustomField = (fieldId) => {
    const newField = { fieldId, row: 3, _uid: `cf-${Date.now()}` };
    setCustomFields(current => current.concat(newField));
  };

  const removeCustomFieldByKey = (layoutKey) => {
    const fieldId = layoutKey.replace('custom_', '');
    if (!window.confirm('Remove this custom field from the extension?')) return;
    setCustomFields(current => current.filter(f => f.fieldId !== fieldId));
    setTooltipLayout(prev => ({
      ...prev,
      row1: prev.row1.filter(k => k !== layoutKey),
      row2: prev.row2.filter(k => k !== layoutKey),
      row3: prev.row3.filter(k => k !== layoutKey),
    }));
  };

  const handleThemeChange = (mode) => {
    setThemeMode(normalizeThemeMode(mode));
  };

  const moveContentBlock = useCallback((blockKey, toIndex) => {
    setTooltipLayout(prev => {
      const currentBlocks = Array.isArray(prev.contentBlocks) ? [...prev.contentBlocks] : [];
      const currentIndex = currentBlocks.indexOf(blockKey);
      if (currentIndex === -1) {
        return prev;
      }

      currentBlocks.splice(currentIndex, 1);
      const nextIndex = Math.max(0, Math.min(Number(toIndex) || 0, currentBlocks.length));
      currentBlocks.splice(nextIndex, 0, blockKey);
      return {
        ...prev,
        contentBlocks: currentBlocks,
      };
    });
  }, []);

  const moveTooltipField = useCallback((fieldKey, toZone, toIndex) => {
    if (!TOOLTIP_LAYOUT_ZONES.includes(toZone)) {
      return;
    }

    setTooltipLayout(prev => {
      const nextLayout = {
        ...prev,
        row1: [...(prev.row1 || [])],
        row2: [...(prev.row2 || [])],
        row3: [...(prev.row3 || [])],
      };

      TOOLTIP_LAYOUT_ZONES.forEach(zone => {
        nextLayout[zone] = nextLayout[zone].filter(key => key !== fieldKey);
      });

      const requestedIndex = Number(toIndex);
      const nextIndex = Number.isInteger(requestedIndex)
        ? Math.max(0, Math.min(requestedIndex, nextLayout[toZone].length))
        : nextLayout[toZone].length;
      nextLayout[toZone].splice(nextIndex, 0, fieldKey);
      return nextLayout;
    });

    setCustomFields(current => updateCustomFieldRow(current, fieldKey, toZone));
  }, []);

  useEffect(() => {
    window.__JHL_TEST_API__ = {
      moveContentBlock,
      moveTooltipField,
      getTooltipLayout: () => tooltipLayout,
      getCustomFields: () => normalizeCustomFields(customFields, tooltipLayout),
    };

    return () => {
      delete window.__JHL_TEST_API__;
    };
  }, [customFields, moveContentBlock, moveTooltipField, tooltipLayout]);

  const exportSettings = () => {
    const config = {
      version: '2.3.0-beta',
      exportedAt: new Date().toISOString(),
      instanceUrl,
      domains: domainsText.split(',').map(x => x.trim()).filter(x => !!x),
      themeMode,
      hoverDepth,
      hoverModifierKey,
      displayFields,
      tooltipLayout,
      customFields: normalizeCustomFields(customFields, tooltipLayout)
    };

    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'jira-hotlinker-settings.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const importSettings = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      try {
        const text = await file.text();
        const config = JSON.parse(text);

        if (!config.instanceUrl && !config.domains) {
          setStatusTone('error');
          setStatus('Invalid settings file.');
          return;
        }

        setInstanceUrl(config.instanceUrl || '');
        setDomainsText((config.domains || []).join(', '));
        setThemeMode(normalizeThemeMode(config.themeMode || 'system'));
        setHoverDepth(config.hoverDepth || 'shallow');
        setHoverModifierKey(config.hoverModifierKey || 'none');
        setDisplayFields(config.displayFields || defaultConfig.displayFields);
        const nextTooltipLayout = config.tooltipLayout || defaultConfig.tooltipLayout;
        setTooltipLayout(nextTooltipLayout);
        setCustomFields(normalizeCustomFields(config.customFields, nextTooltipLayout).map((f, i) => ({...f, _uid: f._uid || `cf-${Date.now()}-${i}`})));

        setStatusTone('success');
        setStatus('Settings imported. Click Save to apply.');
      } catch (err) {
        setStatusTone('error');
        setStatus('Failed to import settings file.');
      }
    };
    input.click();
  };

  const showProModal = () => {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999;';
    modal.innerHTML = `
      <div style="background:white;border-radius:12px;padding:24px;max-width:400px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.2);">
        <h3 style="margin:0 0 12px;color:#1e40af;">Team Sync (Pro)</h3>
        <p style="color:#64748b;margin:0 0 16px;">Auto-sync your Jira HotLinker settings across your team. Coming soon!</p>
        <p style="color:#94a3b8;font-size:12px;margin:0 0 16px;">Join the waitlist to get early access.</p>
        <a href="mailto:dgebaei@gmail.com?subject=Team Sync Pro Waitlist" style="display:inline-block;background:#7c3aed;color:white;padding:8px 16px;border-radius:8px;text-decoration:none;font-weight:600;">Join Waitlist</a>
        <button onclick="this.closest('div').parentElement.remove()" style="display:block;margin:12px auto 0;background:transparent;border:none;color:#64748b;cursor:pointer;">Close</button>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });
  };

  const saveOptions = async () => {
    const domains = domainsText
      .split(',')
      .map(x => x.trim())
      .filter(x => !!x);
    const normalizedInstanceUrl = normalizeInstanceUrl(instanceUrl);

    if (!normalizedInstanceUrl) {
      setStatusTone('error');
      setStatus('You must provide your Jira instance URL.');
      return;
    }

    setInstanceUrl(normalizedInstanceUrl);

    const permissionDomains = domains.concat([normalizedInstanceUrl]);
    const currentInstanceUrl = await storageGet(defaultConfig);
    if (!currentInstanceUrl.instanceUrl) {
      domains.push(normalizedInstanceUrl);
    }

    setIsSaving(true);
    setStatusTone('neutral');
    setStatus('Saving changes...');

    let granted;
    try {
      granted = await permissionsRequest({'origins': permissionDomains.map(toMatchUrl)});
    } catch (ex) {
      setIsSaving(false);
      setStatusTone('error');
      setStatus(ex.message);
      return;
    }

    if (!granted) {
      setIsSaving(false);
      setStatusTone('error');
      setStatus('Options not saved.');
      return;
    }

    await storageSet({
      instanceUrl: normalizedInstanceUrl,
      domains,
      themeMode: normalizeThemeMode(themeMode),
      v15upgrade: true,
      hoverDepth,
      hoverModifierKey,
      displayFields,
      tooltipLayout,
      customFields: normalizeCustomFields(customFields, tooltipLayout)
    });
    resetDeclarativeMapping();
    setDomainsText(domains.join(', '));
    savedJsonRef.current = buildOptionsSnapshot({
      instanceUrl: normalizedInstanceUrl,
      domainsText: domains.join(', '),
      themeMode: normalizeThemeMode(themeMode),
      hoverDepth,
      hoverModifierKey,
      tooltipLayout,
      customFields,
    });
    setIsSaving(false);
    setStatusTone('success');
    setStatus('Options saved successfully.');
    setTimeout(() => {
      setStatusTone('neutral');
      setStatus('');
    }, 2500);
  };

  const discardOptions = () => {
    window.location.reload();
  };

  const statusMessage = status || (hasInvalidCustomFields ? 'Fix invalid custom field IDs before saving.' : 'Changes are local until you save them.');

  return (
    <div className='optionsPage' data-testid='options-root'>
      {/* ── Hero ─────────────────────────────────────────── */}
      <header className='heroCard'>
        <div className='heroLeft'>
          <div className='heroEyebrow'>Jira HotLinker</div>
          <h1 className='heroTitle'>Extension Options</h1>
          <p className='heroCopy'>
            Configure your Jira connection, theme, and which fields appear in the hover popup.
          </p>
        </div>
        <div className='heroRight'>
          <div className='statusPill' data-testid='options-status-pill'>
            <span className={`statusPillDot ${statusTone === 'success' ? 'statusPillDotActive' : ''}`} />
            {statusMessage}
          </div>
        </div>
      </header>

      {/* ── Settings Grid ───────────────────────────────── */}
      <div className='settingsGrid'>

        {/* ── BASIC: Connection ─────────────────────────── */}
        <section className='settingsCard'>
          <div className='cardHeader'>
            <div className='sectionEyebrow'>Basic</div>
            <h2>Connection</h2>
            <p>Tell the extension where Jira lives and which pages it should activate on.</p>
          </div>
          <div className='cardBody'>
            <label className='formField'>
              <span className='fieldLabel'>Jira instance URL</span>
                <input
                  data-testid='options-instance-url'
                  id='instanceUrl'
                type='text'
                value={instanceUrl}
                onChange={event => setInstanceUrl(event.target.value)}
                placeholder='https://your-company.atlassian.net/' />
              <span className='fieldHelp'>Used for issue metadata, field discovery, and link targets.</span>
            </label>

            <label className='formField'>
              <span className='fieldLabel'>Allowed pages</span>
                <textarea
                  data-testid='options-domains'
                  id='domains'
                value={domainsText}
                onChange={event => setDomainsText(event.target.value)}
                placeholder='github.com, outlook.office.com' />
              <span className='fieldHelp'>
                Comma-separated domains, URLs, or valid{' '}
                <a href='https://developer.chrome.com/extensions/match_patterns' target='_blank' rel='noopener noreferrer'>
                  match patterns
                </a>.
                You can also add a page directly from the extension icon.
              </span>
            </label>
          </div>
        </section>

        {/* ── BASIC: Appearance ──────────────────────────── */}
        <section className='settingsCard'>
          <div className='cardHeader'>
            <h2>Appearance</h2>
            <p>Choose how the options page and hover popup look across light and dark environments.</p>
          </div>
          <div className='cardBody'>
            <span className='fieldLabel'>Color mode</span>
            <div className='themePills'>
              {SUPPORTED_THEME_MODES.map(mode => (
                  <button
                    key={mode}
                    type='button'
                    data-testid={`options-theme-mode-${mode}`}
                    className={`themePill ${themeMode === mode ? 'themePillSelected' : 'themePillUnselected'}`}
                  onClick={() => handleThemeChange(mode)}
                >
                  {mode === 'system' ? 'System' : mode.charAt(0).toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>
            <div className='tipBox'>
              Tip: Most users keep the default System setting. Switch to Light or Dark only if you prefer a fixed appearance regardless of your OS theme.
            </div>
          </div>
        </section>

      </div>

      {/* ── Advanced Toggle ──────────────────────────────── */}
      <div className='advToggleCard'>
        <span className='advToggleIcon' aria-hidden='true'>&#9881;</span>
        <div className='advToggleText'>
          <h3>Show advanced settings</h3>
          <p>Hover trigger depth, modifier keys, field layout editor, custom fields, and settings sync.</p>
        </div>
        <button
          type='button'
          data-testid='options-advanced-toggle'
          className='advToggleBtn'
          onClick={toggleAdvanced}
          aria-expanded={showAdvanced}
        >
          {showAdvanced ? 'Hide' : 'Show'}
        </button>
      </div>

      {/* ── ADVANCED Sections ───────────────────────────── */}
      {showAdvanced && (
        <div className='settingsGrid'>
          {/* ── Hover Behavior ───────────────────────────── */}
          <section className='settingsCard settingsGridFull'>
            <div className='cardHeader'>
              <div className='sectionEyebrow sectionEyebrowMuted'>Advanced</div>
              <h2>Hover Behavior</h2>
              <p>Control when the tooltip appears as you move the mouse over Jira issue keys.</p>
            </div>
            <div className='cardBody'>
              <div className='hoverRow'>
                <label className='formField'>
                  <span className='fieldLabel'>Trigger depth</span>
                  <select data-testid='options-hover-depth' value={hoverDepth} onChange={event => setHoverDepth(event.target.value)}>
                    <option value='exact'>Exact — only the hovered element itself</option>
                    <option value='shallow'>Shallow — hovered element + immediate parent</option>
                    <option value='deep'>Deep — walk up to 5 ancestor levels (most sensitive)</option>
                  </select>
                  <span className='fieldHelp'>
                    How aggressively the extension searches surrounding DOM elements for Jira keys.
                    Use &ldquo;Exact&rdquo; if the tooltip triggers too often on pages with dense text.
                  </span>
                </label>

                <label className='formField'>
                  <span className='fieldLabel'>Modifier key</span>
                  <select data-testid='options-hover-modifier' value={hoverModifierKey} onChange={event => setHoverModifierKey(event.target.value)}>
                    <option value='none'>None — hover alone triggers the tooltip</option>
                    <option value='alt'>Alt — press Alt after hovering</option>
                    <option value='ctrl'>Ctrl — press Ctrl after hovering</option>
                    <option value='shift'>Shift — press Shift after hovering</option>
                    <option value='any'>Any — press Alt, Ctrl, or Shift after hovering</option>
                  </select>
                  <span className='fieldHelp'>
                    When set, hover over a Jira key and then press the chosen key to reveal the tooltip.
                    Useful for on-demand activation instead of automatic popups.
                  </span>
                </label>
              </div>
            </div>
          </section>

          {/* ── Tooltip Layout ───────────────────────────── */}
          <section className='settingsCard settingsGridFull'>
            <div className='cardHeader'>
              <h2>Tooltip Layout</h2>
              <p>Drag fields to customize which Jira data appears in each row of the hover card.</p>
            </div>
            <div className='cardBody'>
              <TooltipLayoutEditor
                tooltipLayout={tooltipLayout}
                setTooltipLayout={setTooltipLayout}
                customFields={customFields}
                setCustomFields={setCustomFields}
                fieldCatalog={fieldCatalog}
                onAddField={addCustomField}
                onRemoveCustomField={removeCustomFieldByKey}
              />
            </div>
          </section>

          {/* ── Settings Sync ────────────────────────────── */}
          <section className='settingsCard settingsGridFull'>
            <div className='cardHeader'>
              <h2>Settings Sync</h2>
              <p>Export, import, or auto-sync your extension configuration across your team.</p>
            </div>
            <div className='cardBody'>
              <div className='syncButtons'>
                <button type='button' data-testid='options-export-settings' className='syncBtn' onClick={exportSettings}>
                  &#10132; Export Settings (.json)
                </button>
                <button type='button' data-testid='options-import-settings' className='syncBtn' onClick={importSettings}>
                  &#10132; Import Settings (.json)
                </button>
                <button type='button' data-testid='options-team-sync' className='syncBtn proButton' onClick={showProModal}>
                  &#10022; Team Sync (Pro)
                </button>
              </div>
              <p className='syncProHint'>auto-sync config across your team</p>
            </div>
          </section>

        </div>
      )}

      {/* ── Footer Action Bar ────────────────────────────── */}
      <footer className={`actionBar${isDirty ? ' actionBarDirty' : ''}`}>
        <div className='actionCopy'>
          <strong>Save changes</strong>
          <span>Applies the Jira URL, allowed pages, appearance, and field settings.</span>
        </div>
        <div className='actionControlsRow'>
          {(status || hasInvalidCustomFields) && (
              <span data-testid='options-save-notice' className={`saveNotice saveNotice${statusTone.charAt(0).toUpperCase() + statusTone.slice(1)}`}>
                {status || 'Fix invalid custom field IDs before saving.'}
              </span>
            )}
          <button type='button' data-testid='options-discard' className='ghostButton' onClick={discardOptions} disabled={isSaving}>
            Discard
          </button>
          <button
            type='button'
            data-testid='options-save'
            className={`saveBtn primaryButton${isDirty ? ' saveBtnDirty' : ''}`}
            onClick={saveOptions}
            disabled={isSaving || hasInvalidCustomFields}
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </footer>
    </div>
  );
}

document.addEventListener('DOMContentLoaded', main);
