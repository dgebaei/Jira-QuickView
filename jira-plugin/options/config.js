export function buildTooltipLayoutFromDisplayFields(displayFields) {
  const row1Defaults = ['issueType', 'status', 'priority'];
  const row2Defaults = ['epicParent', 'sprint', 'affects', 'fixVersions'];
  const row3Defaults = ['environment', 'labels'];
  const contentDefaults = ['description', 'timeTracking', 'pullRequests', 'comments'];
  const peopleDefaults = ['reporter', 'assignee'];

  const row1 = row1Defaults.filter(f => displayFields[f]);
  const row2 = row2Defaults.filter(f => displayFields[f]);
  const row3 = row3Defaults.filter(f => displayFields[f]);
  const contentBlocks = contentDefaults.filter(f => displayFields[f]);
  const people = peopleDefaults.filter(f => displayFields[f]);

  return { row1, row2, row3, contentBlocks, people };
}

export default {
  domains: [],
  instanceUrl: '',
  themeMode: 'system',
  v15upgrade: false,
  customFields: [],
  hoverDepth: 'exact',
  hoverModifierKey: 'any',
  displayFields: {
    issueType: true,
    status: true,
    priority: true,
    sprint: true,
    fixVersions: true,
    affects: true,
    environment: true,
    labels: true,
    epicParent: true,
    attachments: false,
    comments: true,
    description: true,
    reporter: true,
    assignee: true,
    pullRequests: true,
    timeTracking: true
  },
  tooltipLayout: {
    row1: ['issueType', 'status', 'priority'],
    row2: ['epicParent', 'sprint', 'affects', 'fixVersions'],
    row3: ['environment', 'labels'],
    contentBlocks: ['description', 'timeTracking', 'pullRequests', 'comments'],
    people: ['reporter', 'assignee']
  }
};
