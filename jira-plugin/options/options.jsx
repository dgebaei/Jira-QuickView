/*global chrome */
import React, {useEffect, useState, useCallback, useRef} from 'react';
import ReactDOM from 'react-dom';
import defaultConfig, {buildTooltipLayoutFromDisplayFields} from 'options/config';
import {storageGet, storageSet, storageLocalGet, storageLocalSet, storageLocalRemove, permissionsRequest, sendMessage} from 'src/chrome';
import {resetDeclarativeMapping, toMatchUrl} from 'options/declarative';
import {DEFAULT_THEME_MODE, SUPPORTED_THEME_MODES, normalizeThemeMode, syncDocumentTheme} from 'src/theme';
import {TooltipLayoutEditor} from 'options/tooltip-layout-editor';
import {
  buildExportedSettingsPayload,
  buildSimpleSyncState,
  extractSettingsConfig,
  getConfigPermissionOrigins,
  getSimpleSyncSourcePermissionOrigins,
  normalizeSimpleSyncState,
  SIMPLE_SYNC_DEFAULT_FILE_NAME,
  SIMPLE_SYNC_SOURCE_TYPES,
  SIMPLE_SYNC_STORAGE_KEY,
} from 'src/settings-sync';
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
const HERO_LINKS = [
  {
    key: 'download',
    href: 'https://chromewebstore.google.com/detail/jira-quickview/oddgjhpfjkeckcppcldgjomlnablfkia',
    label: 'Download extension',
  },
  {
    key: 'website',
    href: 'https://dgebaei.github.io/Jira-QuickView/',
    label: 'Extension website',
  },
  {
    key: 'guide',
    href: 'https://dgebaei.github.io/Jira-QuickView/user-guide.html',
    label: 'User guide',
  },
  {
    key: 'repo',
    href: 'https://github.com/dgebaei/Jira-QuickView',
    label: 'GitHub repository',
  },
  {
    key: 'issues',
    href: 'https://github.com/dgebaei/Jira-QuickView/issues',
    label: 'Issue tracker',
  },
  {
    key: 'new-issue',
    href: 'https://github.com/dgebaei/Jira-QuickView/issues/new/choose',
    label: 'New issue',
  },
];

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
  const [isSyncing, setIsSyncing] = useState(false);
  const [simpleSyncState, setSimpleSyncState] = useState(() => normalizeSimpleSyncState({}));
  const [syncSourceType, setSyncSourceType] = useState(SIMPLE_SYNC_SOURCE_TYPES.JIRA_ATTACHMENT);
  const [syncUrl, setSyncUrl] = useState('');
  const [syncIssueKey, setSyncIssueKey] = useState('');
  const [syncFileName, setSyncFileName] = useState(SIMPLE_SYNC_DEFAULT_FILE_NAME);
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
  const isUrlSyncSource = syncSourceType === SIMPLE_SYNC_SOURCE_TYPES.URL;
  const draftSyncUrl = String(syncUrl || '').trim();
  const draftSyncIssueKey = String(syncIssueKey || '').trim().toUpperCase();
  const draftSyncFileName = String(syncFileName || SIMPLE_SYNC_DEFAULT_FILE_NAME).trim() || SIMPLE_SYNC_DEFAULT_FILE_NAME;
  const hasSimpleSyncDraftSource = isUrlSyncSource
    ? !!draftSyncUrl
    : !!draftSyncIssueKey && !!draftSyncFileName;
  const draftSimpleSyncMatchesStored = isUrlSyncSource
    ? simpleSyncState.sourceType === SIMPLE_SYNC_SOURCE_TYPES.URL && (simpleSyncState.source.url || '') === draftSyncUrl
    : simpleSyncState.sourceType === SIMPLE_SYNC_SOURCE_TYPES.JIRA_ATTACHMENT
      && (simpleSyncState.source.issueKey || '') === draftSyncIssueKey
      && (simpleSyncState.source.fileName || SIMPLE_SYNC_DEFAULT_FILE_NAME) === draftSyncFileName;
  const canRunSimpleSyncNow = hasSimpleSyncDraftSource;

  const toggleAdvanced = useCallback(() => {
    setShowAdvanced(prev => {
      const next = !prev;
      sessionStorage.setItem('jhl_adv', next ? '1' : '0');
      return next;
    });
  }, []);

  const applyConfigToForm = useCallback((config) => {
    const nextTooltipLayout = config.tooltipLayout || buildTooltipLayoutFromDisplayFields({
      ...defaultConfig.displayFields,
      ...(config.displayFields || {})
    });
    const nextInstanceUrl = config.instanceUrl || '';
    const nextDomainsText = (config.domains || []).join(', ');
    const nextThemeMode = normalizeThemeMode(config.themeMode || DEFAULT_THEME_MODE);
    const nextHoverDepth = config.hoverDepth || 'shallow';
    const nextHoverModifierKey = config.hoverModifierKey || 'none';
    const nextCustomFields = normalizeCustomFields(config.customFields, nextTooltipLayout)
      .map((f, i) => ({...f, _uid: f._uid || `cf-${Date.now()}-${i}`}));

    setInstanceUrl(nextInstanceUrl);
    setDomainsText(nextDomainsText);
    setThemeMode(nextThemeMode);
    setHoverDepth(nextHoverDepth);
    setHoverModifierKey(nextHoverModifierKey);
    setDisplayFields({
      ...defaultConfig.displayFields,
      ...(config.displayFields || {})
    });
    setTooltipLayout(nextTooltipLayout);
    setCustomFields(nextCustomFields);
    savedJsonRef.current = buildOptionsSnapshot({
      instanceUrl: nextInstanceUrl,
      domainsText: nextDomainsText,
      themeMode: nextThemeMode,
      hoverDepth: nextHoverDepth,
      hoverModifierKey: nextHoverModifierKey,
      tooltipLayout: nextTooltipLayout,
      customFields: nextCustomFields,
    });
  }, []);

  const applySimpleSyncStateToForm = useCallback((state) => {
    const normalized = normalizeSimpleSyncState(state);
    setSimpleSyncState(normalized);
    setSyncSourceType(normalized.sourceType);
    if (normalized.sourceType === SIMPLE_SYNC_SOURCE_TYPES.URL) {
      setSyncUrl(normalized.source.url || '');
    } else {
      setSyncIssueKey(normalized.source.issueKey || '');
      setSyncFileName(normalized.source.fileName || SIMPLE_SYNC_DEFAULT_FILE_NAME);
    }
  }, []);

  const refreshSimpleSyncState = useCallback(async () => {
    const result = await storageLocalGet({[SIMPLE_SYNC_STORAGE_KEY]: {}});
    const normalized = normalizeSimpleSyncState(result[SIMPLE_SYNC_STORAGE_KEY]);
    applySimpleSyncStateToForm(normalized);
    return normalized;
  }, [applySimpleSyncStateToForm]);

  useEffect(() => {
    let cancelled = false;
    storageLocalGet({[SIMPLE_SYNC_STORAGE_KEY]: {}}).then(result => {
      if (!cancelled) {
        applySimpleSyncStateToForm(result[SIMPLE_SYNC_STORAGE_KEY]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [applySimpleSyncStateToForm]);

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
      instanceUrl,
      domains: domainsText.split(',').map(x => x.trim()).filter(x => !!x),
      themeMode,
      hoverDepth,
      hoverModifierKey,
      displayFields,
      tooltipLayout,
      customFields: normalizeCustomFields(customFields, tooltipLayout)
    };
    const payload = buildExportedSettingsPayload(config, simpleSyncState, chrome.runtime.getManifest().version);

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'jira-quickview-settings.json';
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
        const payload = JSON.parse(text);
        const config = extractSettingsConfig(payload);

        if (!config || (!config.instanceUrl && !config.domains)) {
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

  const runSimpleSyncNow = async () => {
    setIsSyncing(true);
    try {
      const currentConfig = await storageGet(defaultConfig);
      const savedInstanceUrl = normalizeInstanceUrl(currentConfig.instanceUrl || '');
      const draftInstanceUrl = normalizeInstanceUrl(instanceUrl || '');
      const effectiveInstanceUrl = draftInstanceUrl || savedInstanceUrl;
      const nextSimpleSyncState = buildSimpleSyncState({
        sourceType: syncSourceType,
        url: draftSyncUrl,
        issueKey: draftSyncIssueKey,
        fileName: draftSyncFileName,
      }, simpleSyncState);

      if (nextSimpleSyncState.sourceType === SIMPLE_SYNC_SOURCE_TYPES.JIRA_ATTACHMENT && !effectiveInstanceUrl) {
        throw new Error('Enter your Jira instance URL before syncing from a Jira attachment.');
      }

      const permissionOrigins = getSimpleSyncSourcePermissionOrigins(nextSimpleSyncState, {
        instanceUrl: effectiveInstanceUrl,
      });
      if (permissionOrigins.length) {
        const granted = await permissionsRequest({origins: permissionOrigins.map(toMatchUrl)});
        if (!granted) {
          throw new Error('Team Sync was not run because permission was not granted.');
        }
      }

      const shouldPersistSyncState = simpleSyncState.enabled && draftSimpleSyncMatchesStored;
      const response = await sendMessage({
        action: 'runSimpleSettingsSync',
        stateOverride: nextSimpleSyncState,
        configOverride: nextSimpleSyncState.sourceType === SIMPLE_SYNC_SOURCE_TYPES.JIRA_ATTACHMENT
          ? {instanceUrl: effectiveInstanceUrl}
          : null,
        persistState: shouldPersistSyncState,
      });
      if (response?.error) {
        throw new Error(response.error);
      }
      const result = response?.result || {};
      if (shouldPersistSyncState) {
        await refreshSimpleSyncState();
      } else {
        const transientState = normalizeSimpleSyncState({
          ...simpleSyncState,
          status: result.status || 'synced',
          message: result.message || '',
          lastRevision: result?.state?.lastRevision ?? simpleSyncState.lastRevision,
          lastHash: result?.state?.lastHash ?? simpleSyncState.lastHash,
          lastCheckedAt: result?.state?.lastCheckedAt ?? simpleSyncState.lastCheckedAt,
          lastAppliedAt: result?.state?.lastAppliedAt ?? simpleSyncState.lastAppliedAt,
          lastSchemaVersion: result?.state?.lastSchemaVersion ?? simpleSyncState.lastSchemaVersion,
          lastMinimumExtensionVersion: result?.state?.lastMinimumExtensionVersion ?? simpleSyncState.lastMinimumExtensionVersion,
          lastPolicy: result?.state?.lastPolicy ?? simpleSyncState.lastPolicy,
          lastAppliedSettings: result?.state?.lastAppliedSettings ?? simpleSyncState.lastAppliedSettings,
        });
        setSimpleSyncState(transientState);
      }
      const nextConfig = await storageGet(defaultConfig);
      applyConfigToForm(nextConfig);
    } catch (error) {
      setSimpleSyncState(current => normalizeSimpleSyncState({
        ...current,
        status: 'error',
        message: error.message || 'Team settings sync failed.',
      }));
    } finally {
      setIsSyncing(false);
    }
  };

  const disconnectSimpleSync = async () => {
    await storageLocalRemove(SIMPLE_SYNC_STORAGE_KEY);
    applySimpleSyncStateToForm({});
  };

  const grantSimpleSyncPermissions = async () => {
    setIsSyncing(true);
    try {
      const currentConfig = await storageGet(defaultConfig);
      const origins = getConfigPermissionOrigins(currentConfig);
      if (!origins.length) {
        return;
      }
      const granted = await permissionsRequest({origins});
      if (!granted) {
        return;
      }
      await storageLocalSet({
        [SIMPLE_SYNC_STORAGE_KEY]: {
          ...simpleSyncState,
          status: 'synced',
          message: 'Required permissions granted.',
        }
      });
      await resetDeclarativeMapping();
      await refreshSimpleSyncState();
    } catch (error) {
      setSimpleSyncState(current => normalizeSimpleSyncState({
        ...current,
        status: 'error',
        message: error.message || 'Could not request synced page permissions.',
      }));
    } finally {
      setIsSyncing(false);
    }
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

    const shouldPersistSimpleSyncSource = simpleSyncState.enabled || (isUrlSyncSource
      ? !!String(syncUrl || '').trim()
      : !!String(syncIssueKey || '').trim());

    let nextSimpleSyncState = null;
    if (shouldPersistSimpleSyncSource) {
      try {
        nextSimpleSyncState = buildSimpleSyncState({
          sourceType: syncSourceType,
          url: syncUrl,
          issueKey: syncIssueKey,
          fileName: syncFileName,
        }, simpleSyncState);
      } catch (error) {
        setStatusTone('error');
        setStatus(error.message || 'Team Sync source could not be saved.');
        return;
      }
    }

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

    if (nextSimpleSyncState) {
      try {
        const permissionOrigins = getSimpleSyncSourcePermissionOrigins(nextSimpleSyncState, {
          instanceUrl: normalizedInstanceUrl,
        });
        if (permissionOrigins.length) {
          const sourceGranted = await permissionsRequest({origins: permissionOrigins.map(toMatchUrl)});
          if (!sourceGranted) {
            setIsSaving(false);
            setStatusTone('error');
            setStatus('Team Sync source was not saved because permission was not granted.');
            return;
          }
        }
      } catch (error) {
        setIsSaving(false);
        setStatusTone('error');
        setStatus(error.message || 'Team Sync source could not be saved.');
        return;
      }
    }

    try {
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

      if (nextSimpleSyncState) {
        await storageLocalSet({[SIMPLE_SYNC_STORAGE_KEY]: nextSimpleSyncState});
        applySimpleSyncStateToForm(nextSimpleSyncState);
      }

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

      if (nextSimpleSyncState?.enabled) {
        try {
          const response = await sendMessage({action: 'runSimpleSettingsSync'});
          if (response?.error) {
            throw new Error(response.error);
          }
          await refreshSimpleSyncState();
          const nextConfig = await storageGet(defaultConfig);
          applyConfigToForm(nextConfig);
        } catch (error) {
          await refreshSimpleSyncState();
        }
        setStatusTone('success');
        setStatus('Options saved successfully.');
        setTimeout(() => {
          setStatusTone('neutral');
          setStatus('');
        }, 2500);
      } else {
        setStatusTone('success');
        setStatus('Options saved successfully.');
        setTimeout(() => {
          setStatusTone('neutral');
          setStatus('');
        }, 2500);
      }
    } catch (error) {
      setStatusTone('error');
      setStatus(error.message || 'Options could not be saved.');
    } finally {
      setIsSaving(false);
    }
  };

  const discardOptions = () => {
    window.location.reload();
  };

  const statusMessage = status || (
    hasInvalidCustomFields
      ? 'Fix invalid custom field IDs before saving.'
      : (isDirty ? 'Unsaved changes.' : 'No unsaved changes.')
  );
  const statusPillIsSaved = !status && !hasInvalidCustomFields && !isDirty;
  const showTeamSyncMessage = !!simpleSyncState.message && ['error', 'permissionsRequired'].includes(simpleSyncState.status);

  return (
    <div className='optionsPage' data-testid='options-root'>
      {/* ── Hero ─────────────────────────────────────────── */}
      <header className='heroCard'>
        <div className='heroLeft'>
          <div className='heroEyebrow'>Jira QuickView</div>
          <h1 className='heroTitle'>Extension Options</h1>
          <p className='heroCopy'>
            Configure your Jira connection, theme, and which fields appear in the hover popup.
          </p>
          <nav className='heroLinks' aria-label='Jira QuickView resources' data-testid='options-hero-links'>
            {HERO_LINKS.map(link => (
              <a
                key={link.key}
                className='heroLink'
                data-testid={`options-hero-link-${link.key}`}
                href={link.href}
                target='_blank'
                rel='noopener noreferrer'
              >
                {link.label}
              </a>
            ))}
          </nav>
        </div>
        <div className='heroRight'>
          <div className={`statusPill${statusPillIsSaved ? ' statusPillActive' : ''}`} data-testid='options-status-pill'>
            <span className={`statusPillDot ${statusTone === 'success' || statusPillIsSaved ? 'statusPillDotActive' : ''}`} />
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
                placeholder='github.com, mail.google.com, outlook.office.com' />
              <span className='fieldHelp'>
                Comma-separated domains, URLs, or valid{' '}
                <a href='https://developer.chrome.com/extensions/match_patterns' target='_blank' rel='noopener noreferrer'>
                  match patterns
                </a>.
                Suggested starting points: github.com, mail.google.com, and outlook.office.com.
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

      {/* ── Advanced ────────────────────────────────────── */}
      <section className={`advancedPanel${showAdvanced ? ' advancedPanelOpen' : ''}`}>
        <div className='advancedPanelHeader'>
          <svg className='advToggleIcon' viewBox='0 0 24 24' aria-hidden='true' focusable='false'>
            <circle cx='12' cy='12' r='3.5' />
            <path d='M12 3v3M12 18v3M4.9 4.9 7 7M17 17l2.1 2.1M3 12h3M18 12h3M4.9 19.1 7 17M17 7l2.1-2.1' />
          </svg>
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

        {showAdvanced && (
          <div className='advancedPanelBody'>
            <div className='settingsGrid advancedSettingsGrid'>
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
            <div className='cardHeader cardHeaderWithStatus'>
              <div className='cardHeaderCopy'>
                <h2>Settings Sync</h2>
                <p>Export, import, or auto-sync your extension configuration across your team.</p>
              </div>
              <span className={`teamSyncStatus teamSyncStatus-${simpleSyncState.status}`} data-testid='options-team-sync-status'>
                {simpleSyncState.enabled ? simpleSyncState.status : 'not connected'}
              </span>
            </div>
            <div className='cardBody'>
              <div className='teamSyncPanel' data-testid='options-team-sync-panel'>
                <div className='teamSyncSourceRow'>
                  <label className='formField teamSyncSourceTypeField'>
                    <div className='fieldLabelRow'>
                      <span className='fieldLabel'>Sync source</span>
                      <button type='button' className='teamSyncHint' aria-label='If a sync check fails, Jira QuickView keeps the last applied team settings and shows the error here.'>
                        <span className='teamSyncHintIcon' aria-hidden='true'>i</span>
                        <span className='teamSyncTooltip'>
                          If a sync check fails, Jira QuickView keeps the last applied team settings and shows the error here.
                        </span>
                      </button>
                    </div>
                    <select data-testid='options-team-sync-source-type' value={syncSourceType} onChange={event => setSyncSourceType(event.target.value)}>
                      <option value={SIMPLE_SYNC_SOURCE_TYPES.JIRA_ATTACHMENT}>Jira attachment</option>
                      <option value={SIMPLE_SYNC_SOURCE_TYPES.URL}>Settings file URL</option>
                    </select>
                  </label>

                  {isUrlSyncSource ? (
                    <label className='formField teamSyncFieldSpanTwo'>
                      <span className='fieldLabel'>Settings file URL</span>
                      <input
                        data-testid='options-team-sync-url'
                        type='url'
                        value={syncUrl}
                        onChange={event => setSyncUrl(event.target.value)}
                        placeholder='https://intranet.example.com/jira-quickview-settings.json' />
                    </label>
                  ) : (
                    <>
                      <label className='formField'>
                        <span className='fieldLabel'>Jira issue key</span>
                        <input
                          data-testid='options-team-sync-issue-key'
                          type='text'
                          value={syncIssueKey}
                          onChange={event => setSyncIssueKey(event.target.value)}
                          placeholder='OPS-123' />
                      </label>
                      <label className='formField'>
                        <div className='fieldLabelRow'>
                          <span className='fieldLabel'>Attachment filename</span>
                          <button type='button' className='teamSyncHint teamSyncHintAlignRight' aria-label='Jira attachment sync uses the newest attachment with the same filename. Increment settingsRevision inside the JSON when publishing a new version.'>
                            <span className='teamSyncHintIcon' aria-hidden='true'>i</span>
                            <span className='teamSyncTooltip'>
                              Jira attachment sync uses the newest attachment with the same filename. Increment settingsRevision inside the JSON when publishing a new version.
                            </span>
                          </button>
                        </div>
                        <input
                          data-testid='options-team-sync-file-name'
                          type='text'
                          value={syncFileName}
                          onChange={event => setSyncFileName(event.target.value)}
                          placeholder={SIMPLE_SYNC_DEFAULT_FILE_NAME} />
                      </label>
                    </>
                  )}
                </div>
                <div className='teamSyncActions'>
                  <div className='teamSyncPrimaryColumn'>
                    <div className='syncButtons teamSyncActionGroup teamSyncActionGroupPrimary'>
                      <button type='button' data-testid='options-team-sync-now' className='syncBtn proButton' onClick={runSimpleSyncNow} disabled={isSyncing || isSaving || !canRunSimpleSyncNow}>
                        Sync Now
                      </button>
                      {simpleSyncState.status === 'permissionsRequired' && (
                        <button type='button' data-testid='options-team-sync-grant-permissions' className='syncBtn' onClick={grantSimpleSyncPermissions} disabled={isSyncing || isSaving}>
                          Grant Permissions
                        </button>
                      )}
                      <button type='button' data-testid='options-team-sync-disconnect' className='syncBtn' onClick={disconnectSimpleSync} disabled={isSyncing || isSaving || !simpleSyncState.enabled}>
                        Disconnect
                      </button>
                    </div>
                  </div>
                  <div className='syncButtons teamSyncActionGroup teamSyncActionGroupSecondary'>
                    <button type='button' data-testid='options-import-settings' className='syncBtn' onClick={importSettings}>
                      &larr; Import (.json)
                    </button>
                    <button type='button' data-testid='options-export-settings' className='syncBtn' onClick={exportSettings}>
                      &rarr; Export (.json)
                    </button>
                  </div>
                </div>
                {showTeamSyncMessage && (
                  <p
                    className={`teamSyncInlineMessage teamSyncStatus teamSyncStatus-${simpleSyncState.status}`}
                    data-testid='options-team-sync-message'>
                    {simpleSyncState.message}
                  </p>
                )}
              </div>
            </div>
          </section>

            </div>
          </div>
        )}
      </section>

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
