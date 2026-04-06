export function createContentFieldCapabilityHelpers(options) {
  const editMetaCache = options?.editMetaCache;
  const get = options?.get;
  const getBuildEditOption = options?.getBuildEditOption;
  const getAllFields = options?.getAllFields;
  const getCachedValue = options?.getCachedValue;
  const getSprintFieldIds = options?.getSprintFieldIds;
  const instanceUrl = options?.instanceUrl;
  const transitionOptionsCache = options?.transitionOptionsCache;

  function pickSprintFieldId(issueData, sprintFieldIds) {
    const populatedFieldId = (sprintFieldIds || []).find(fieldId => {
      const value = issueData?.fields?.[fieldId];
      return Array.isArray(value) ? value.length > 0 : !!value;
    });
    return populatedFieldId || sprintFieldIds?.[0] || '';
  }

  async function getIssueEditMeta(issueKey) {
    if (!issueKey) {
      return {fields: {}};
    }
    return getCachedValue(editMetaCache, issueKey, async () => {
      const data = await get(`${instanceUrl}rest/api/2/issue/${issueKey}/editmeta`);
      return {
        fields: data?.fields || {}
      };
    });
  }

  async function getEditableFieldCapability(issueData, fieldKey) {
    if (!issueData?.key || !fieldKey) {
      return {
        editable: false,
        operations: [],
        allowedValues: []
      };
    }
    const editMeta = await getIssueEditMeta(issueData.key);
    const names = issueData.names || {};
    let resolvedFieldKey = fieldKey;
    if (fieldKey === 'sprint') {
      const sprintFieldIds = await getSprintFieldIds(instanceUrl);
      resolvedFieldKey = pickSprintFieldId(issueData, sprintFieldIds);
    }
    const editMetaField = editMeta.fields?.[resolvedFieldKey];
    if (!editMetaField) {
      return {
        editable: false,
        fieldKey: resolvedFieldKey,
        operations: [],
        allowedValues: []
      };
    }
    const catalogField = (await getAllFields(instanceUrl)).find(field => field?.id === resolvedFieldKey) || null;
    const mergedFieldMeta = {
      ...(catalogField || {}),
      ...editMetaField,
      schema: editMetaField?.schema || catalogField?.schema || {}
    };
    const schemaCustom = String(mergedFieldMeta?.schema?.custom || '').toLowerCase();
    const schemaType = String(mergedFieldMeta?.schema?.type || '').toLowerCase();
    const displayName = String(names[resolvedFieldKey] || mergedFieldMeta?.name || '').toLowerCase();
    const looksLikeSprint = fieldKey === 'sprint' ||
      schemaCustom.includes('gh-sprint') ||
      schemaType === 'sprint' ||
      displayName.includes('sprint');
    if (fieldKey === 'sprint' && !looksLikeSprint) {
      return {
        editable: false,
        fieldKey: resolvedFieldKey,
        operations: [],
        allowedValues: []
      };
    }
    return {
      editable: true,
      fieldKey: resolvedFieldKey,
      fieldMeta: mergedFieldMeta,
      operations: Array.isArray(editMetaField.operations) ? editMetaField.operations : [],
      allowedValues: Array.isArray(editMetaField.allowedValues) ? editMetaField.allowedValues : []
    };
  }

  async function getTransitionOptions(issueKey) {
    if (!issueKey) {
      return [];
    }
    const buildEditOption = getBuildEditOption?.();
    if (typeof buildEditOption !== 'function') {
      throw new Error('Missing buildEditOption helper');
    }
    return getCachedValue(transitionOptionsCache, issueKey, async () => {
      const response = await get(`${instanceUrl}rest/api/2/issue/${issueKey}/transitions`);
      const transitions = Array.isArray(response?.transitions) ? response.transitions : [];
      return transitions
        .filter(transition => transition?.id && transition?.to?.name)
        .map(transition => {
          const targetName = transition.to?.name || '';
          const transitionName = transition.name && transition.name !== targetName
            ? transition.name
            : '';
          const label = transitionName
            ? `${transitionName} -> ${targetName}`
            : targetName;
          const metaText = transitionName || '';
          return buildEditOption(transition.id, label, {
            iconUrl: transition.to?.iconUrl || '',
            metaText,
            searchText: `${label} ${targetName} ${transitionName}`,
            transitionName,
            targetStatusName: targetName
          });
        });
    });
  }

  return {
    getEditableFieldCapability,
    getIssueEditMeta,
    getTransitionOptions,
    pickSprintFieldId,
  };
}
