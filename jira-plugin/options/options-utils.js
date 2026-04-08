import {hasPathSlash} from 'options/declarative';

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
  if (!hasPathSlash.test(normalized)) {
    normalized += '/';
  }
  if (normalized.indexOf('://') === -1) {
    normalized = 'https://' + normalized;
  }
  return normalized;
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
