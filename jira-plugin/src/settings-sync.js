import defaultConfig from 'options/config.js';
import {toMatchUrl} from 'options/declarative';
import {normalizeCustomFields, normalizeInstanceUrl} from 'options/options-utils';
import {normalizeThemeMode} from 'src/theme';

export const SIMPLE_SYNC_STORAGE_KEY = 'jqv.simpleSync';
export const SIMPLE_SYNC_ALARM_NAME = 'jqv.simpleSettingsSync';
export const SIMPLE_SYNC_POLL_MINUTES = 30;
export const SIMPLE_SYNC_DEFAULT_FILE_NAME = 'jira-quickview-settings.json';

export const SIMPLE_SYNC_SOURCE_TYPES = {
  URL: 'url',
  JIRA_ATTACHMENT: 'jiraAttachment',
};

export const DEFAULT_SYNC_POLICY = {
  instanceUrl: 'locked',
  domains: 'default',
  themeMode: 'unmanaged',
  hoverDepth: 'default',
  hoverModifierKey: 'default',
  displayFields: 'default',
  tooltipLayout: 'default',
  customFields: 'default',
};

const VALID_POLICY_VALUES = ['locked', 'default', 'unmanaged'];
const VALID_HOVER_DEPTHS = ['exact', 'shallow', 'deep'];
const VALID_HOVER_MODIFIER_KEYS = ['none', 'alt', 'ctrl', 'shift', 'any'];
const SYNCABLE_SETTING_KEYS = Object.keys(DEFAULT_SYNC_POLICY);
const TOOLTIP_LAYOUT_ZONES = ['row1', 'row2', 'row3', 'contentBlocks', 'people'];

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(values) {
  const seen = {};
  return (Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim())
    .filter(value => {
      if (!value || seen[value]) {
        return false;
      }
      seen[value] = true;
      return true;
    });
}

function cloneValue(value) {
  if (typeof value === 'undefined') {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizePolicy(policy = {}) {
  const normalized = {...DEFAULT_SYNC_POLICY};
  Object.keys(policy || {}).forEach(key => {
    const value = String(policy[key] || '').trim();
    if (SYNCABLE_SETTING_KEYS.includes(key) && VALID_POLICY_VALUES.includes(value)) {
      normalized[key] = value;
    }
  });
  return normalized;
}

function normalizeTooltipLayout(tooltipLayout) {
  if (!isObject(tooltipLayout)) {
    return undefined;
  }

  return TOOLTIP_LAYOUT_ZONES.reduce((acc, zone) => {
    if (Array.isArray(tooltipLayout[zone])) {
      acc[zone] = uniqueStrings(tooltipLayout[zone]);
    } else {
      acc[zone] = cloneValue(defaultConfig.tooltipLayout[zone] || []);
    }
    return acc;
  }, {});
}

export function getDefaultSimpleSyncState() {
  return {
    enabled: false,
    sourceType: SIMPLE_SYNC_SOURCE_TYPES.JIRA_ATTACHMENT,
    source: {
      issueKey: '',
      fileName: SIMPLE_SYNC_DEFAULT_FILE_NAME,
    },
    lastRevision: 0,
    lastHash: '',
    lastCheckedAt: '',
    lastAppliedAt: '',
    status: 'disabled',
    message: '',
    lastSchemaVersion: 0,
    lastMinimumExtensionVersion: '',
    lastPolicy: {...DEFAULT_SYNC_POLICY},
    lastAppliedSettings: {},
  };
}

export function normalizeSimpleSyncState(rawState) {
  const raw = isObject(rawState) ? rawState : {};
  const sourceType = raw.sourceType === SIMPLE_SYNC_SOURCE_TYPES.URL
    ? SIMPLE_SYNC_SOURCE_TYPES.URL
    : SIMPLE_SYNC_SOURCE_TYPES.JIRA_ATTACHMENT;
  const source = isObject(raw.source) ? raw.source : {};
  const defaults = getDefaultSimpleSyncState();

  return {
    ...defaults,
    ...raw,
    enabled: !!raw.enabled,
    sourceType,
    source: sourceType === SIMPLE_SYNC_SOURCE_TYPES.URL
      ? {url: String(source.url || '').trim()}
      : {
          issueKey: String(source.issueKey || '').trim().toUpperCase(),
          fileName: String(source.fileName || SIMPLE_SYNC_DEFAULT_FILE_NAME).trim() || SIMPLE_SYNC_DEFAULT_FILE_NAME,
        },
    lastRevision: Math.max(0, Number(raw.lastRevision) || 0),
    lastHash: String(raw.lastHash || ''),
    lastCheckedAt: String(raw.lastCheckedAt || ''),
    lastAppliedAt: String(raw.lastAppliedAt || ''),
    status: String(raw.status || defaults.status),
    message: String(raw.message || ''),
    lastSchemaVersion: Math.max(0, Number(raw.lastSchemaVersion) || 0),
    lastMinimumExtensionVersion: String(raw.lastMinimumExtensionVersion || ''),
    lastPolicy: normalizePolicy(raw.lastPolicy),
    lastAppliedSettings: isObject(raw.lastAppliedSettings) ? raw.lastAppliedSettings : {},
  };
}

export function buildSimpleSyncState(input, previousState = {}) {
  const previous = normalizeSimpleSyncState(previousState);
  const sourceType = input.sourceType === SIMPLE_SYNC_SOURCE_TYPES.URL
    ? SIMPLE_SYNC_SOURCE_TYPES.URL
    : SIMPLE_SYNC_SOURCE_TYPES.JIRA_ATTACHMENT;

  if (sourceType === SIMPLE_SYNC_SOURCE_TYPES.URL) {
    const url = String(input.url || '').trim();
    if (!url) {
      throw new Error('Enter a settings file URL.');
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch (ex) {
      throw new Error('Enter a valid settings file URL.');
    }
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      throw new Error('Settings file URL must use HTTP or HTTPS.');
    }
    return {
      ...previous,
      enabled: true,
      sourceType,
      source: {url: parsed.toString()},
      status: 'configured',
      message: 'Team Sync source saved.',
    };
  }

  const issueKey = String(input.issueKey || '').trim().toUpperCase();
  const fileName = String(input.fileName || SIMPLE_SYNC_DEFAULT_FILE_NAME).trim();
  if (!issueKey) {
    throw new Error('Enter the Jira issue key that contains the settings attachment.');
  }
  if (!fileName) {
    throw new Error('Enter the settings attachment filename.');
  }
  return {
    ...previous,
    enabled: true,
    sourceType,
    source: {issueKey, fileName},
    status: 'configured',
    message: 'Team Sync source saved.',
  };
}

export function getSimpleSyncSourceDescription(state) {
  const normalized = normalizeSimpleSyncState(state);
  if (!normalized.enabled) {
    return 'Team Sync is not connected.';
  }
  if (normalized.sourceType === SIMPLE_SYNC_SOURCE_TYPES.URL) {
    return normalized.source.url || 'Settings URL';
  }
  return `${normalized.source.issueKey || 'Jira issue'} / ${normalized.source.fileName || SIMPLE_SYNC_DEFAULT_FILE_NAME}`;
}

export function getSimpleSyncSourcePermissionOrigins(state, config = {}) {
  const normalized = normalizeSimpleSyncState(state);
  if (!normalized.enabled) {
    return [];
  }
  if (normalized.sourceType === SIMPLE_SYNC_SOURCE_TYPES.URL) {
    try {
      return [new URL(normalized.source.url).origin + '/'];
    } catch (ex) {
      return [];
    }
  }
  const instanceUrl = normalizeInstanceUrl(config.instanceUrl || '');
  return instanceUrl ? [instanceUrl] : [];
}

export function getConfigPermissionOrigins(config = {}) {
  const origins = [];
  const instanceUrl = normalizeInstanceUrl(config.instanceUrl || '');
  if (instanceUrl) {
    origins.push(instanceUrl);
  }
  (config.domains || []).forEach(domain => origins.push(domain));
  return uniqueStrings(origins).map(toMatchUrl);
}

export function normalizeSettingsPayload(payload) {
  if (!isObject(payload)) {
    throw new Error('Settings file must contain a JSON object.');
  }

  const schemaVersion = Number(payload.schemaVersion || 1);
  if (schemaVersion !== 1) {
    throw new Error(`Unsupported settings schema version: ${schemaVersion}`);
  }

  const settingsRevision = Number(payload.settingsRevision || 0);
  if (!Number.isInteger(settingsRevision) || settingsRevision <= 0) {
    throw new Error('Settings file must include a positive settingsRevision.');
  }

  const rawSettings = isObject(payload.settings) ? payload.settings : payload;
  const settings = {};

  if (Object.prototype.hasOwnProperty.call(rawSettings, 'instanceUrl')) {
    const normalizedInstanceUrl = normalizeInstanceUrl(rawSettings.instanceUrl);
    if (!normalizedInstanceUrl) {
      throw new Error('Settings file includes an invalid Jira instance URL.');
    }
    settings.instanceUrl = normalizedInstanceUrl;
  }

  if (Object.prototype.hasOwnProperty.call(rawSettings, 'domains')) {
    settings.domains = uniqueStrings(rawSettings.domains);
  }

  if (Object.prototype.hasOwnProperty.call(rawSettings, 'themeMode')) {
    settings.themeMode = normalizeThemeMode(rawSettings.themeMode || defaultConfig.themeMode);
  }

  if (Object.prototype.hasOwnProperty.call(rawSettings, 'hoverDepth')) {
    const hoverDepth = String(rawSettings.hoverDepth || '').trim();
    settings.hoverDepth = VALID_HOVER_DEPTHS.includes(hoverDepth) ? hoverDepth : defaultConfig.hoverDepth;
  }

  if (Object.prototype.hasOwnProperty.call(rawSettings, 'hoverModifierKey')) {
    const hoverModifierKey = String(rawSettings.hoverModifierKey || '').trim();
    settings.hoverModifierKey = VALID_HOVER_MODIFIER_KEYS.includes(hoverModifierKey) ? hoverModifierKey : defaultConfig.hoverModifierKey;
  }

  if (isObject(rawSettings.displayFields)) {
    settings.displayFields = {
      ...defaultConfig.displayFields,
      ...rawSettings.displayFields,
    };
  }

  const rawTooltipLayout = isObject(rawSettings.tooltipLayout)
    ? rawSettings.tooltipLayout
    : undefined;
  const customFields = Object.prototype.hasOwnProperty.call(rawSettings, 'customFields')
    ? normalizeCustomFields(rawSettings.customFields, rawTooltipLayout || defaultConfig.tooltipLayout)
    : undefined;
  if (customFields) {
    settings.customFields = customFields;
  }

  const tooltipLayout = normalizeTooltipLayout(rawTooltipLayout);
  if (tooltipLayout) {
    settings.tooltipLayout = tooltipLayout;
  }

  if (!Object.keys(settings).length) {
    throw new Error('Settings file does not include any supported settings.');
  }

  return {
    schemaVersion,
    settingsRevision,
    publishedAt: String(payload.publishedAt || ''),
    minimumExtensionVersion: String(payload.minimumExtensionVersion || ''),
    policy: normalizePolicy(payload.policy),
    settings,
  };
}

export function extractSettingsConfig(payload) {
  if (!isObject(payload)) {
    return null;
  }
  const config = isObject(payload.settings) ? payload.settings : payload;
  return isObject(config) ? cloneValue(config) : null;
}

export function buildExportedSettingsPayload(config, syncState = {}, extensionVersion = '') {
  const normalizedState = normalizeSimpleSyncState(syncState);
  return {
    version: String(extensionVersion || ''),
    exportedAt: new Date().toISOString(),
    publishedAt: new Date().toISOString(),
    schemaVersion: normalizedState.lastSchemaVersion || 1,
    settingsRevision: normalizedState.lastRevision || 1,
    minimumExtensionVersion: normalizedState.lastMinimumExtensionVersion || String(extensionVersion || ''),
    policy: cloneValue(normalizedState.lastPolicy || DEFAULT_SYNC_POLICY),
    settings: cloneValue(config || {}),
  };
}

function mergeDefaultDomains(currentValue, syncedValue, previousValue) {
  if (!Array.isArray(previousValue)) {
    return cloneValue(syncedValue);
  }
  const previousMatches = new Set(previousValue.map(toMatchUrl));
  const additions = (Array.isArray(currentValue) ? currentValue : [])
    .filter(value => !previousMatches.has(toMatchUrl(value)));
  return uniqueStrings([...(syncedValue || []), ...additions]);
}

function mergeDefaultCustomFields(currentValue, syncedValue, previousValue) {
  if (!Array.isArray(previousValue)) {
    return cloneValue(syncedValue);
  }
  const previousIds = new Set(previousValue.map(field => field.fieldId));
  const fieldsById = {};
  (syncedValue || []).forEach(field => {
    fieldsById[field.fieldId] = field;
  });
  (Array.isArray(currentValue) ? currentValue : [])
    .filter(field => field?.fieldId && !previousIds.has(field.fieldId))
    .forEach(field => {
      fieldsById[field.fieldId] = field;
    });
  return Object.keys(fieldsById).map(fieldId => fieldsById[fieldId]);
}

function mergeDefaultDisplayFields(currentValue, syncedValue, previousValue) {
  if (!isObject(previousValue)) {
    return cloneValue(syncedValue);
  }
  const next = {...(isObject(currentValue) ? currentValue : {})};
  Object.keys(syncedValue || {}).forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(previousValue, key) || valuesEqual(currentValue?.[key], previousValue[key])) {
      next[key] = syncedValue[key];
    }
  });
  return next;
}

function mergeDefaultValue(key, currentValue, syncedValue, previousValue) {
  if (key === 'domains') {
    return mergeDefaultDomains(currentValue, syncedValue, previousValue);
  }
  if (key === 'customFields') {
    return mergeDefaultCustomFields(currentValue, syncedValue, previousValue);
  }
  if (key === 'displayFields') {
    return mergeDefaultDisplayFields(currentValue, syncedValue, previousValue);
  }
  if (typeof previousValue === 'undefined' || valuesEqual(currentValue, previousValue)) {
    return cloneValue(syncedValue);
  }
  return cloneValue(currentValue);
}

export function mergeSyncedConfig(currentConfig, normalizedPayload, lastAppliedSettings = {}) {
  const nextConfig = {
    ...defaultConfig,
    ...(currentConfig || {}),
    displayFields: {
      ...defaultConfig.displayFields,
      ...(currentConfig?.displayFields || {}),
    },
    tooltipLayout: {
      ...defaultConfig.tooltipLayout,
      ...(currentConfig?.tooltipLayout || {}),
    },
    customFields: Array.isArray(currentConfig?.customFields) ? currentConfig.customFields : [],
  };

  Object.keys(normalizedPayload.settings).forEach(key => {
    const policy = normalizedPayload.policy[key] || DEFAULT_SYNC_POLICY[key] || 'default';
    const syncedValue = normalizedPayload.settings[key];
    if (policy === 'unmanaged') {
      return;
    }
    if (policy === 'locked') {
      nextConfig[key] = cloneValue(syncedValue);
      return;
    }
    nextConfig[key] = mergeDefaultValue(key, nextConfig[key], syncedValue, lastAppliedSettings[key]);
  });

  nextConfig.v15upgrade = true;

  return {
    config: nextConfig,
    lastAppliedSettings: cloneValue(normalizedPayload.settings),
  };
}

export async function hashString(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return 'sha256:' + Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function isVersionAtLeast(currentVersion, minimumVersion) {
  const minimum = String(minimumVersion || '').trim();
  if (!minimum) {
    return true;
  }
  const currentParts = String(currentVersion || '').split('.').map(value => Number(value) || 0);
  const minimumParts = minimum.split('.').map(value => Number(value) || 0);
  const length = Math.max(currentParts.length, minimumParts.length);
  for (let index = 0; index < length; index += 1) {
    const current = currentParts[index] || 0;
    const required = minimumParts[index] || 0;
    if (current > required) {
      return true;
    }
    if (current < required) {
      return false;
    }
  }
  return true;
}
