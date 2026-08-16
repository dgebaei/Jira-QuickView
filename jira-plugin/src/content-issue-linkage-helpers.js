export function createContentIssueLinkageHelpers(options) {
  const buildEditOption = options?.buildEditOption;
  const getIssueSummary = options?.getIssueSummary;
  const instanceUrl = options?.instanceUrl;
  const issueDataModule = options?.issueData;

  function extractIssueKeyFromLinkageValue(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'object') return String(value.key || value.value || value.id || '').trim();
    return '';
  }

  function findEpicLinkFieldId(issueData, fieldContext) {
    const names = issueData?.names || {};
    const editMetaFields = fieldContext?.editMeta?.fields || {};
    const fromNames = Object.keys(names).find(fieldId => {
      const fieldName = String(names[fieldId] || '').toLowerCase();
      return fieldName === 'epic link' || fieldName === 'epic';
    });
    if (fromNames) return fromNames;
    const fromEditMeta = Object.keys(editMetaFields).find(fieldId => {
      const fieldName = String(editMetaFields[fieldId]?.name || '').toLowerCase();
      return fieldName === 'epic link' || fieldName === 'epic';
    });
    return fromEditMeta || fieldContext?.fieldIds?.epicLink?.[0] || '';
  }

  async function resolveIssueLinkage(issueData) {
    if (!issueData?.key) {
      return {mode: '', label: 'Parent', editable: false, fieldKey: '', currentLink: null};
    }
    const outcome = await issueDataModule.loadFieldContext({issueKey: issueData.key, fieldId: 'parent'});
    const fieldContext = outcome.context || {editMeta: {fields: {}}, fieldIds: {epicLink: []}};
    const editMetaFields = fieldContext.editMeta?.fields || {};
    const parentValue = issueData?.fields?.parent;
    const parentFieldMeta = editMetaFields.parent;
    if (parentValue?.key || parentFieldMeta) {
      const currentKey = parentValue?.key || '';
      const currentSummary = parentValue?.fields?.summary || currentKey;
      return {
        mode: 'parent',
        label: 'Parent',
        editable: !!parentFieldMeta,
        fieldKey: 'parent',
        currentLink: currentKey ? {key: currentKey, summary: currentSummary, url: `${instanceUrl}browse/${currentKey}`} : null,
      };
    }

    const epicFieldId = findEpicLinkFieldId(issueData, fieldContext);
    const epicKey = extractIssueKeyFromLinkageValue(issueData?.fields?.[epicFieldId]);
    if (!epicFieldId && !epicKey) {
      return {mode: '', label: 'Parent', editable: false, fieldKey: '', currentLink: null};
    }
    let epicSummary = epicKey;
    if (epicKey) {
      try {
        epicSummary = (await getIssueSummary(epicKey))?.summary || epicKey;
      } catch (error) {
        epicSummary = epicKey;
      }
    }
    return {
      mode: 'epicLink',
      label: 'Parent',
      editable: !!editMetaFields[epicFieldId],
      fieldKey: epicFieldId,
      currentLink: epicKey ? {key: epicKey, summary: epicSummary, url: `${instanceUrl}browse/${epicKey}`} : null,
    };
  }

  function buildIssueSearchOption(issue, issueData) {
    const issueKey = String(issue?.key || '').trim();
    const issueSummary = String(issue?.fields?.summary || issue?.summary || issueKey).trim();
    const statusName = issue?.fields?.status?.name || '';
    const projectKey = String(issueData?.key || '').split('-')[0];
    const candidateProjectKey = String(issue?.fields?.project?.key || issueKey).split('-')[0];
    const isLocalProject = candidateProjectKey === projectKey;
    return buildEditOption(issueKey, `[${issueKey}] ${issueSummary}`.trim(), {
      id: issueKey,
      iconUrl: issue?.fields?.issuetype?.iconUrl || issue?.issuetype?.iconUrl || '',
      metaText: statusName,
      rawValue: {key: issueKey, summary: issueSummary},
      searchText: `${issueKey} ${issueSummary} ${statusName}`,
      groupKey: isLocalProject ? `project:${projectKey}` : '__other_projects__',
      groupLabel: isLocalProject ? `${projectKey} project` : 'Other projects',
      groupSortKey: isLocalProject ? '0' : '1',
    });
  }

  function getRecentIssueSearchOptions() {
    return [];
  }

  async function searchParentCandidates(query, issueData, linkageMode) {
    const fieldId = linkageMode === 'parent'
      ? 'parent'
      : (await resolveIssueLinkage(issueData)).fieldKey;
    const outcome = await issueDataModule.search({
      purpose: 'parent',
      issueKey: issueData?.key,
      fieldId,
      query,
    });
    if (outcome.kind !== 'loaded') {
      throw new Error(outcome.failure?.message || 'Issue search failed');
    }
    return outcome.items.map(issue => buildIssueSearchOption(issue, issueData)).filter(option => option.id);
  }

  return {getRecentIssueSearchOptions, resolveIssueLinkage, searchParentCandidates};
}
