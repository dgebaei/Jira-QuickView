function uniqueStrings(values) {
  return [...new Set((values || []).filter(Boolean).map(value => String(value).trim()).filter(Boolean))];
}

export function isSprintField(field) {
  const name = String(field?.name || '').toLowerCase();
  const schemaCustom = String(field?.schema?.custom || '').toLowerCase();
  const schemaType = String(field?.schema?.type || '').toLowerCase();
  return name.includes('sprint') ||
    schemaCustom.includes('gh-sprint') ||
    schemaType === 'sprint';
}

export function isEpicLinkField(field) {
  const name = String(field?.name || '').toLowerCase();
  const schemaCustom = String(field?.schema?.custom || '').toLowerCase();
  return name === 'epic link' || name === 'epic' || schemaCustom.includes('gh-epic-link');
}

export function isParentLinkField(field) {
  const name = String(field?.name || '').toLowerCase();
  return name === 'parent link';
}

export function buildPopupIssueFieldList({sprintFieldIds = [], epicLinkFieldIds = [], customFields = []} = {}) {
  return uniqueStrings([
    'description',
    'id',
    'project',
    'reporter',
    'assignee',
    'summary',
    'timetracking',
    'attachment',
    'comment',
    'issuetype',
    'status',
    'priority',
    'labels',
    'environment',
    'versions',
    'parent',
    'fixVersions',
    'watches',
    'issuelinks',
    'subtasks',
    ...sprintFieldIds,
    ...epicLinkFieldIds,
    ...(customFields || []).map(field => field?.fieldId)
  ]);
}

export function buildPopupIssueMetadataUrl(instanceUrl, issueKey, options = {}) {
  const fields = buildPopupIssueFieldList(options);
  return `${instanceUrl}rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=${fields.join(',')}&expand=renderedFields,names`;
}

export function buildJiraSearchRequestUrls(instanceUrl, {maxResults = 20, fields = [], jql = ''} = {}) {
  const params = new URLSearchParams();
  params.set('maxResults', String(maxResults));
  params.set('fields', Array.isArray(fields) ? fields.join(',') : String(fields || ''));
  params.set('jql', String(jql || ''));

  return uniqueStrings([
    `${instanceUrl}rest/api/latest/search?${params.toString()}`,
    `${instanceUrl}rest/api/3/search/jql?${params.toString()}`,
    `${instanceUrl}rest/api/2/search?${params.toString()}`,
  ]);
}
