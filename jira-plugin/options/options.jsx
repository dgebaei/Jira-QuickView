/*global chrome */
import React, {useEffect, useState, useCallback} from 'react';
import ReactDOM from 'react-dom';
import defaultConfig from 'options/config';
import {storageGet, storageSet, permissionsRequest} from 'src/chrome';
import {hasPathSlash, resetDeclarativeMapping, toMatchUrl} from 'options/declarative';
import {DEFAULT_THEME_MODE, SUPPORTED_THEME_MODES, normalizeThemeMode, syncDocumentTheme} from 'src/theme';

import 'options/options.scss';

const FIELD_OPTIONS = [
  {key: 'issueType', label: 'Issue Type'},
  {key: 'status', label: 'Status'},
  {key: 'priority', label: 'Priority'},
  {key: 'sprint', label: 'Sprint'},
  {key: 'fixVersions', label: 'Fix Version'},
  {key: 'affects', label: 'Affects Version'},
  {key: 'environment', label: 'Environment'},
  {key: 'labels', label: 'Labels'},
  {key: 'epicParent', label: 'Epic/Parent'},
  {key: 'attachments', label: 'Attachments'},
  {key: 'comments', label: 'Comments'},
  {key: 'description', label: 'Description'},
  {key: 'reporter', label: 'Reporter'},
  {key: 'assignee', label: 'Assignee'},
  {key: 'pullRequests', label: 'Related Pull Requests'}
];

const FIELD_GROUPS = [
  {
    title: 'Top bar - row 1',
    description: 'Issue identity and triage context shown in the first summary row.',
    keys: ['issueType', 'status', 'priority', 'epicParent']
  },
  {
    title: 'Top bar - row 2',
    description: 'Planning and release context shown in the second summary row.',
    keys: ['sprint', 'affects', 'fixVersions']
  },
  {
    title: 'Top bar - row 3',
    description: 'Metadata chips shown in the third summary row.',
    keys: ['environment', 'labels']
  },
  {
    title: 'Description block',
    description: 'Rich issue description shown below the summary rows.',
    keys: ['description']
  },
  {
    title: 'Attachments block',
    description: 'Image previews and attachment indicators in the body area.',
    keys: ['attachments']
  },
  {
    title: 'Comments block',
    description: 'Rendered Jira comments in the body area.',
    keys: ['comments']
  },
  {
    title: 'People',
    description: 'Reporter and assignee avatars shown in the title area.',
    keys: ['reporter', 'assignee']
  },
  {
    title: 'Related development',
    description: 'Pull request summary table appended beneath the issue content.',
    keys: ['pullRequests']
  }
];

function normalizeInstanceUrl(instanceUrl) {
  let normalized = String(instanceUrl || '').trim();
  if (!normalized) {
    return '';
  }
  if (!hasPathSlash.test(normalized)) {
    normalized += '/';
  }
  if (normalized.indexOf('://') === -1) {
    normalized = 'https://' + normalized;
  }
  return normalized;
}

function normalizeCustomFields(customFields) {
  if (!Array.isArray(customFields)) {
    return [];
  }
  const seen = {};
  return customFields
    .map(field => ({
      fieldId: String(field && field.fieldId || '').trim(),
      row: Math.min(3, Math.max(1, Number(field && field.row) || 3))
    }))
    .filter(field => {
      if (!field.fieldId || seen[field.fieldId]) {
        return false;
      }
      seen[field.fieldId] = true;
      return true;
    });
}

async function fetchFieldCatalog(instanceUrl) {
  if (!instanceUrl) {
    return {};
  }
  try {
    const response = await fetch(instanceUrl + 'rest/api/2/field', {
      credentials: 'include'
    });
    if (!response.ok) {
      return {};
    }
    const fields = await response.json();
    if (!Array.isArray(fields)) {
      return {};
    }
    return fields.reduce((acc, field) => {
      if (field && field.id) {
        acc[field.id] = field.name || field.id;
      }
      return acc;
    }, {});
  } catch (ex) {
    return {};
  }
}

function getCustomFieldError(fieldId, fieldCatalog) {
  const trimmed = String(fieldId || '').trim();
  if (!trimmed) {
    return '';
  }
  if (!/^customfield_\d+$/i.test(trimmed)) {
    return 'Use a Jira custom field ID in the form customfield_12345.';
  }
  if (Object.keys(fieldCatalog).length && !fieldCatalog[trimmed]) {
    return 'This field ID was not found in Jira.';
  }
  return '';
}

async function main() {
  const storedConfig = await storageGet(defaultConfig);
  syncDocumentTheme(document, storedConfig.themeMode || DEFAULT_THEME_MODE);
  ReactDOM.render(
    <ConfigPage {...storedConfig} />,
    document.getElementById('container')
  );
}

function ConfigPage(props) {
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
    normalizeCustomFields(props.customFields).map((f, i) => ({...f, _uid: f._uid || `cf-${Date.now()}-${i}`}))
  );
  const [fieldCatalog, setFieldCatalog] = useState({});
  const [status, setStatus] = useState('');
  const [statusTone, setStatusTone] = useState('neutral');
  const [isSaving, setIsSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(
    () => sessionStorage.getItem('jhl_adv') === '1'
  );
  const customFieldErrors = customFields.map(field => getCustomFieldError(field.fieldId, fieldCatalog));
  const hasInvalidCustomFields = customFieldErrors.some(Boolean);

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

  const updateCustomField = (index, patch) => {
    setCustomFields(current => current.map((field, fieldIndex) => {
      if (fieldIndex !== index) {
        return field;
      }
      return {
        ...field,
        ...patch
      };
    }));
  };

  const addCustomField = () => {
    setCustomFields(current => current.concat({fieldId: '', row: 3}));
  };

  const removeCustomField = (index) => {
    setCustomFields(current => current.filter((_, fieldIndex) => fieldIndex !== index));
  };

  const handleThemeChange = (mode) => {
    setThemeMode(normalizeThemeMode(mode));
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
      customFields: normalizeCustomFields(customFields)
    });
    resetDeclarativeMapping();
    setDomainsText(domains.join(', '));
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
    <div className='optionsPage'>
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
          <div className='statusPill'>
            <span className={`statusPillDot ${statusTone === 'success' ? 'statusPillDotActive' : ''}`} />
            {statusMessage}
          </div>
        </div>
      </header>

      {/* ── Settings Grid ───────────────────────────────── */}
      <div className='settingsGrid'>

        {/* ── BASIC: Connection ─────────────────────────── */}
        <div className='sectionEyebrow'>Basic</div>

        <section className='settingsCard'>
          <div className='cardHeader'>
            <h2>Connection</h2>
            <p>Tell the extension where Jira lives and which pages it should activate on.</p>
          </div>
          <div className='cardBody'>
            <label className='formField'>
              <span className='fieldLabel'>Jira instance URL</span>
              <input
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
          <div className='sectionEyebrow sectionEyebrowMuted'>Advanced</div>

          {/* ── Hover Behavior ───────────────────────────── */}
          <section className='settingsCard settingsGridFull'>
            <div className='cardHeader'>
              <h2>Hover Behavior</h2>
              <p>Control when the tooltip appears as you move the mouse over Jira issue keys.</p>
            </div>
            <div className='cardBody'>
              <div className='hoverRow'>
                <label className='formField'>
                  <span className='fieldLabel'>Trigger depth</span>
                  <select value={hoverDepth} onChange={event => setHoverDepth(event.target.value)}>
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
                  <select value={hoverModifierKey} onChange={event => setHoverModifierKey(event.target.value)}>
                    <option value='none'>None — hover alone triggers the tooltip</option>
                    <option value='alt'>Alt — press Alt after hovering</option>
                    <option value='ctrl'>Ctrl — press Ctrl after hovering</option>
                    <option value='shift'>Shift — press Shift after hovering</option>
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
              <p>Choose which built-in Jira fields appear in each part of the hover card.</p>
            </div>
            <div className='cardBody'>
              <div className='fieldLayoutGroups'>
                {FIELD_GROUPS.map(group => (
                  <div key={group.title} className='fieldGroupCard'>
                    <div className='fieldGroupHeader'>
                      <h3>{group.title}</h3>
                      <p>{group.description}</p>
                    </div>
                    <div className='displayFields'>
                      {group.keys.map(key => {
                        const option = FIELD_OPTIONS.find(field => field.key === key);
                        return (
                          <label key={key} className='displayFieldOption'>
                            <input
                              id={'displayField_' + key}
                              type='checkbox'
                              checked={!!displayFields[key]}
                              onChange={event => setDisplayFieldValue(key, event.target.checked)}
                            />
                            <span>{option ? option.label : key}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* ── Custom Fields ────────────────────────────── */}
          <section className='settingsCard settingsGridFull'>
            <div className='cardHeader' style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
              <div>
                <h2>Custom Fields</h2>
                <p>Add Jira field IDs and choose where each one appears in the hover summary.</p>
              </div>
              <button type='button' className='secondaryButton' onClick={addCustomField}>
                + Add field
              </button>
            </div>
            <div className='cardBody'>
              {customFields.length === 0 ? (
                <div className='emptyState'>
                  No custom fields configured yet. Add one if you want to surface plugin-provided Jira data in the hover card.
                </div>
              ) : (
                <div className='customFieldsSection'>
                  {customFields.map((field) => (
                    <div key={field._uid} className='customFieldRow'>
                      <div className='customFieldHeader'>Custom field {index + 1}</div>
                      <label className='customFieldLabel'>
                        <span className='fieldLabel'>Field ID</span>
                        <input
                          type='text'
                          value={field.fieldId}
                          onChange={event => updateCustomField(index, {fieldId: event.target.value})}
                          placeholder='customfield_12345' />
                      </label>
                      <label className='customFieldLabel'>
                        <span className='fieldLabel'>Location</span>
                        <select
                          value={field.row}
                          onChange={event => updateCustomField(index, {row: Number(event.target.value)})}>
                          <option value={1}>Top bar - row 1</option>
                          <option value={2}>Top bar - row 2</option>
                          <option value={3}>Top bar - row 3</option>
                        </select>
                      </label>
                      <div className={`customFieldMeta ${customFieldErrors[index] ? 'customFieldMetaError' : ''}`}>
                        {customFieldErrors[index]
                          ? customFieldErrors[index]
                          : field.fieldId
                            ? `Resolved field name: ${fieldCatalog[field.fieldId] || 'Waiting for Jira field metadata.'}`
                            : 'The field name will appear here after Jira returns metadata for this ID.'}
                      </div>
                      <button
                        type='button'
                        className='dangerButton ghostButton customFieldRemove'
                        onClick={() => removeCustomField(index)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
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
                <button type='button' className='syncBtn' onClick={() => {}}>
                  &#10132; Export Settings (.json)
                </button>
                <button type='button' className='syncBtn' onClick={() => {}}>
                  &#10132; Import Settings (.json)
                </button>
                <button type='button' className='syncBtn proButton' onClick={() => {}}>
                  &#10022; Team Sync (Pro)
                </button>
              </div>
              <p className='syncProHint'>auto-sync config across your team</p>
            </div>
          </section>

        </div>
      )}

      {/* ── Footer Action Bar ────────────────────────────── */}
      <footer className='actionBar'>
        <div className='actionCopy'>
          <strong>Save changes</strong>
          <span>Applies the Jira URL, allowed pages, appearance, and field settings.</span>
        </div>
        <div className='actionControls'>
          {(status || hasInvalidCustomFields) && (
            <div className={`saveNotice saveNotice${statusTone.charAt(0).toUpperCase() + statusTone.slice(1)}`}>
              {status || 'Fix invalid custom field IDs before saving.'}
            </div>
          )}
          <div className='actionControlsRow'>
            <button type='button' className='ghostButton' onClick={discardOptions} disabled={isSaving}>
              Discard
            </button>
            <button
              type='button'
              className='saveBtn primaryButton'
              onClick={saveOptions}
              disabled={isSaving || hasInvalidCustomFields}
            >
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}

document.addEventListener('DOMContentLoaded', main);
