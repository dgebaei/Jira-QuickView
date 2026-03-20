export function buildTooltipLayoutFromDisplayFields(displayFields) {
  const row1Defaults = ['issueType', 'status', 'priority', 'epicParent'];
  const row2Defaults = ['sprint', 'affects', 'fixVersions'];
  const row3Defaults = ['environment', 'labels'];
  const contentDefaults = ['description', 'attachments', 'comments', 'pullRequests'];
  const peopleDefaults = ['reporter', 'assignee'];

  const row1 = row1Defaults.filter(f => displayFields[f]);
  const row2 = row2Defaults.filter(f => displayFields[f]);
  const row3 = row3Defaults.filter(f => displayFields[f]);
  const contentBlocks = contentDefaults.filter(f => displayFields[f]);
  const people = peopleDefaults.filter(f => displayFields[f]);

  return { row1, row2, row3, contentBlocks, people };
}

export default {
  domains: [
    'https://github.com/'
  ],
  instanceUrl: '',
  themeMode: 'system',
  v15upgrade: false,
  customFields: [],
  hoverDepth: 'shallow',
  hoverModifierKey: 'none',
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
    attachments: true,
    comments: true,
    description: true,
    reporter: true,
    assignee: true,
    pullRequests: true
  },
  tooltipLayout: {
    row1: ['issueType', 'status', 'priority', 'epicParent'],
    row2: ['sprint', 'affects', 'fixVersions'],
    row3: ['environment', 'labels'],
    contentBlocks: ['description', 'attachments', 'comments', 'pullRequests'],
    people: ['reporter', 'assignee']
  }
};
