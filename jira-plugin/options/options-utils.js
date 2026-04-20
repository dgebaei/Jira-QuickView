export const BUILT_IN_FIELD_IDS = new Set([
  'issuetype', 'status', 'priority', 'labels', 'environment',
  'versions', 'fixVersions', 'parent', 'assignee', 'reporter',
  'summary', 'description', 'attachment', 'comment', 'timetracking',
  'project', 'id'
]);

export function normalizeInstanceUrl(instanceUrl) {
  let normalized = String(instanceUrl || '').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.indexOf('://') === -1) {
    normalized = 'https://' + normalized;
  }
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return '';
    }
    parsed.hash = '';
    parsed.search = '';
    if (!parsed.pathname) {
      parsed.pathname = '/';
    }
    if (!parsed.pathname.endsWith('/')) {
      parsed.pathname += '/';
    }
    return parsed.toString();
  } catch (error) {
    return '';
  }
}

const ROOT_LEVEL_JIRA_SEGMENTS = new Set([
  'browse',
  'issues',
  'login',
  'logout',
  'plugins',
  'projects',
  'rest',
  'secure',
  'servicedesk',
]);

const CONTEXT_LEVEL_JIRA_SEGMENTS = new Set([
  ...ROOT_LEVEL_JIRA_SEGMENTS,
  'software',
]);

function isAtlassianCloudHost(hostname) {
  return String(hostname || '').toLowerCase().endsWith('.atlassian.net');
}

export function resolveInstanceUrl(instanceUrl) {
  const normalized = normalizeInstanceUrl(instanceUrl);
  if (!normalized) {
    return '';
  }

  try {
    const parsed = new URL(normalized);
    const segments = String(parsed.pathname || '')
      .split('/')
      .filter(Boolean);
    const loweredSegments = segments.map(segment => String(segment || '').toLowerCase());

    if (!segments.length || isAtlassianCloudHost(parsed.hostname)) {
      parsed.pathname = '/';
      return parsed.toString();
    }

    if (segments.length === 1) {
      parsed.pathname = ROOT_LEVEL_JIRA_SEGMENTS.has(loweredSegments[0])
        ? '/'
        : `/${segments[0]}/`;
      return parsed.toString();
    }

    if (ROOT_LEVEL_JIRA_SEGMENTS.has(loweredSegments[0])) {
      parsed.pathname = '/';
      return parsed.toString();
    }

    if (CONTEXT_LEVEL_JIRA_SEGMENTS.has(loweredSegments[1])) {
      parsed.pathname = `/${segments[0]}/`;
      return parsed.toString();
    }

    return '';
  } catch (error) {
    return '';
  }
}

export function getCustomFieldLayoutKey(field) {
  const fieldId = typeof field === 'string'
    ? String(field || '').trim()
    : String(field?.fieldId || '').trim();
  if (fieldId) {
    return `custom_${fieldId}`;
  }
  const uid = typeof field === 'string' ? '' : String(field?._uid || '').trim();
  return uid ? `custom_${uid}` : '';
}

export function getCustomFieldRowFromLayout(fieldId, tooltipLayout) {
  const layoutKey = getCustomFieldLayoutKey(fieldId);
  if (!layoutKey) {
    return null;
  }
  if (tooltipLayout?.row1?.includes(layoutKey)) {
    return 1;
  }
  if (tooltipLayout?.row2?.includes(layoutKey)) {
    return 2;
  }
  if (tooltipLayout?.row3?.includes(layoutKey)) {
    return 3;
  }
  return null;
}

export function normalizeCustomFields(customFields, tooltipLayout) {
  if (!Array.isArray(customFields)) {
    return [];
  }
  const seen = {};
  return customFields
    .map(field => {
      const fieldId = String(field && field.fieldId || '').trim();
      const rowFromLayout = getCustomFieldRowFromLayout(fieldId, tooltipLayout);
      return {
        fieldId,
        row: rowFromLayout || Math.min(3, Math.max(1, Number(field && field.row) || 3))
      };
    })
    .filter(field => {
      if (!field.fieldId || seen[field.fieldId]) {
        return false;
      }
      seen[field.fieldId] = true;
      return true;
    });
}

export function updateCustomFieldRow(customFields, layoutKey, zone) {
  const row = Number(String(zone || '').replace('row', ''));
  if (!layoutKey?.startsWith('custom_') || ![1, 2, 3].includes(row)) {
    return customFields;
  }
  return customFields.map(field => {
    if (getCustomFieldLayoutKey(field) !== layoutKey) {
      return field;
    }
    return {
      ...field,
      row,
    };
  });
}

export function buildOptionsSnapshot({instanceUrl, domainsText, themeMode, hoverDepth, hoverModifierKey, tooltipLayout, customFields}) {
  return JSON.stringify({
    instanceUrl,
    domainsText,
    themeMode,
    hoverDepth,
    hoverModifierKey,
    tooltipLayout,
    customFields: normalizeCustomFields(customFields, tooltipLayout),
  });
}

export async function fetchFieldCatalog(instanceUrl) {
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

export function getCustomFieldError(fieldId, fieldCatalog) {
  const trimmed = String(fieldId || '').trim();
  if (!trimmed) {
    return '';
  }
  if (BUILT_IN_FIELD_IDS.has(trimmed)) {
    return 'This field is already part of the built-in layout.';
  }
  if (Object.keys(fieldCatalog).length && !fieldCatalog[trimmed]) {
    return 'This field ID was not found in Jira.';
  }
  return '';
}
