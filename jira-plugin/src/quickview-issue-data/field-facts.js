import {isEpicLinkField, isParentLinkField, isSprintField} from 'src/jira-issue-helpers';

function mergeField(catalogField, editMetaField) {
  if (!catalogField && !editMetaField) {
    return null;
  }
  return {
    ...(catalogField || {}),
    ...(editMetaField || {}),
    schema: editMetaField?.schema || catalogField?.schema || {},
  };
}

function fieldIdsBy(catalog, editMetaFields, predicate) {
  const fields = [
    ...(Array.isArray(catalog) ? catalog : []),
    ...Object.entries(editMetaFields || {}).map(([id, field]) => ({id, ...field})),
  ];
  return [...new Set(fields.filter(predicate).map(field => field?.id).filter(Boolean))];
}

export function createFieldFacts(options = {}) {
  const cache = options.cache;
  const jira = options.jira;
  const instanceUrl = options.instanceUrl;
  const ttlMs = options.ttlMs;

  async function loadCatalog(signal) {
    return cache.read({
      family: 'fieldCatalog',
      key: instanceUrl,
      ttlMs,
      load: async () => {
        const response = await jira.read({path: `${instanceUrl}rest/api/2/field`, signal});
        if (!Array.isArray(response) || response.length === 0) {
          throw new Error('Jira returned an empty field catalog');
        }
        return response;
      },
    });
  }

  async function loadEditMeta(issueKey, signal) {
    return cache.read({
      family: 'editMeta',
      key: issueKey,
      ttlMs,
      load: async () => {
        const response = await jira.read({
          path: `${instanceUrl}rest/api/2/issue/${encodeURIComponent(issueKey)}/editmeta`,
          signal,
        });
        return {fields: response?.fields || {}};
      },
    });
  }

  async function loadTransitions(issueKey, signal) {
    return cache.read({
      family: 'transitions',
      key: issueKey,
      ttlMs,
      load: async () => {
        const response = await jira.read({
          path: `${instanceUrl}rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`,
          signal,
        });
        return Array.isArray(response?.transitions) ? response.transitions : [];
      },
    });
  }

  async function getCatalogFieldIds(kind, signal) {
    const catalog = await loadCatalog(signal);
    const predicates = {
      epicLink: isEpicLinkField,
      parentLink: isParentLinkField,
      sprint: isSprintField,
    };
    const predicate = predicates[kind];
    return predicate ? catalog.filter(predicate).map(field => field.id).filter(Boolean) : [];
  }

  async function loadFieldContext({issueKey, fieldId, includeTransitions = false, signal} = {}) {
    const normalizedIssueKey = String(issueKey || '').trim();
    const requestedFieldId = String(fieldId || '').trim();
    if (!normalizedIssueKey || !requestedFieldId) {
      throw new Error('Issue key and field id are required');
    }

    const requests = [loadCatalog(signal), loadEditMeta(normalizedIssueKey, signal)];
    if (includeTransitions) {
      requests.push(loadTransitions(normalizedIssueKey, signal));
    }
    const [catalogResult, editMetaResult, transitionsResult] = await Promise.allSettled(requests);
    const catalog = catalogResult.status === 'fulfilled' ? catalogResult.value : [];
    const editMeta = editMetaResult.status === 'fulfilled' ? editMetaResult.value : {fields: {}};
    const editMetaFields = editMeta.fields || {};
    const sprintFieldIds = fieldIdsBy(catalog, editMetaFields, isSprintField);
    const epicLinkFieldIds = fieldIdsBy(catalog, editMetaFields, isEpicLinkField);
    const parentLinkFieldIds = fieldIdsBy(catalog, editMetaFields, isParentLinkField);
    const resolvedFieldId = requestedFieldId === 'sprint'
      ? (sprintFieldIds.find(candidate => editMetaFields[candidate]) || sprintFieldIds[0] || '')
      : requestedFieldId;
    const catalogField = catalog.find(field => field?.id === resolvedFieldId) || null;
    const editMetaField = editMetaFields[resolvedFieldId] || null;

    return {
      catalog,
      catalogError: catalogResult.status === 'rejected' ? catalogResult.reason : null,
      editMeta,
      editMetaError: editMetaResult.status === 'rejected' ? editMetaResult.reason : null,
      context: {
        issueKey: normalizedIssueKey,
        requestedFieldId,
        fieldId: resolvedFieldId,
        field: mergeField(catalogField, editMetaField),
        editable: !!editMetaField,
        operations: Array.isArray(editMetaField?.operations) ? editMetaField.operations : [],
        allowedValues: Array.isArray(editMetaField?.allowedValues) ? editMetaField.allowedValues : [],
        editMeta,
        fieldIds: {epicLink: epicLinkFieldIds, parentLink: parentLinkFieldIds, sprint: sprintFieldIds},
        transitions: transitionsResult?.status === 'fulfilled' ? transitionsResult.value : [],
      },
      transitionsError: transitionsResult?.status === 'rejected' ? transitionsResult.reason : null,
    };
  }

  function invalidateIssue(issueKey, mutation = {}) {
    const fieldId = String(mutation.fieldId || '').toLowerCase();
    if (['capabilityRetry', 'fieldChanged', 'issueChanged', 'quickAction'].includes(mutation.kind)) {
      cache.invalidate('editMeta', issueKey);
    }
    if (mutation.kind === 'issueChanged' || mutation.kind === 'capabilityRetry' ||
      mutation.kind === 'quickAction' ||
      (mutation.kind === 'fieldChanged' && ['issuetype', 'status'].includes(fieldId))) {
      cache.invalidate('transitions', issueKey);
    }
    if (mutation.kind === 'capabilityRetry') {
      cache.invalidate('fieldCatalog', instanceUrl);
    }
  }

  return {getCatalogFieldIds, invalidateIssue, loadFieldContext};
}
