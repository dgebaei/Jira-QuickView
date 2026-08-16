export function createContentFieldCapabilityHelpers(options) {
  const buildEditOption = options?.buildEditOption;
  const issueDataModule = options?.issueData;

  function looksLikeSprintField(fieldId, fieldMeta, names = {}) {
    const schemaCustom = String(fieldMeta?.schema?.custom || '').toLowerCase();
    const schemaType = String(fieldMeta?.schema?.type || '').toLowerCase();
    const displayName = String(names[fieldId] || fieldMeta?.name || '').toLowerCase();
    return schemaCustom.includes('gh-sprint') ||
      schemaType === 'sprint' ||
      displayName.includes('sprint');
  }

  function pickSprintFieldId(issueData, sprintFieldIds, editMetaFields = {}) {
    const names = issueData?.names || {};
    const editMetaSprintFieldIds = Object.keys(editMetaFields || {}).filter(fieldId => {
      return looksLikeSprintField(fieldId, editMetaFields[fieldId], names);
    });
    const candidateFieldIds = [...new Set([
      ...(sprintFieldIds || []),
      ...editMetaSprintFieldIds,
    ].filter(Boolean))];
    const populatedFieldId = candidateFieldIds.find(fieldId => {
      const value = issueData?.fields?.[fieldId];
      return Array.isArray(value) ? value.length > 0 : !!value;
    });
    const editableFieldId = candidateFieldIds.find(fieldId => !!editMetaFields?.[fieldId]);
    return populatedFieldId || editableFieldId || candidateFieldIds[0] || '';
  }

  async function getEditableFieldCapability(issueData, fieldKey) {
    if (!issueData?.key || !fieldKey) {
      return {
        editable: false,
        operations: [],
        allowedValues: []
      };
    }
    let outcome = await issueDataModule.loadFieldContext({issueKey: issueData.key, fieldId: fieldKey});
    if (!outcome.context) {
      throw new Error(outcome.failures?.fieldContext?.message || 'Could not load field context');
    }
    let context = outcome.context;
    const editMeta = context.editMeta || {fields: {}};
    const names = issueData.names || {};
    let resolvedFieldKey = fieldKey;
    if (fieldKey === 'sprint') {
      const sprintFieldIds = context.fieldIds?.sprint || [];
      resolvedFieldKey = pickSprintFieldId(issueData, sprintFieldIds, editMeta.fields);
      if (resolvedFieldKey && resolvedFieldKey !== context.fieldId) {
        outcome = await issueDataModule.loadFieldContext({issueKey: issueData.key, fieldId: resolvedFieldKey});
        context = outcome.context || context;
      }
    }
    const editMetaField = editMeta.fields?.[resolvedFieldKey];
    if (!editMetaField) {
      return {
        editable: false,
        fieldKey: resolvedFieldKey,
        fieldMeta: context.field,
        operations: [],
        allowedValues: []
      };
    }
    const mergedFieldMeta = context.field || editMetaField;
    if (fieldKey === 'sprint' && !looksLikeSprintField(resolvedFieldKey, mergedFieldMeta, names)) {
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
    if (typeof buildEditOption !== 'function') {
      throw new Error('Missing buildEditOption helper');
    }
    const outcome = await issueDataModule.loadFieldContext({issueKey, fieldId: 'status', includeTransitions: true});
    if (!outcome.context) {
      throw new Error(outcome.failures?.fieldContext?.message || 'Could not load transitions');
    }
    return (outcome.context.transitions || [])
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
  }

  return {
    getEditableFieldCapability,
    getTransitionOptions,
    pickSprintFieldId,
  };
}
