export function buildTooltipLayoutFromDisplayFields(displayFields) {
  const row1Defaults = ['issueType', 'status', 'priority'];
  const row2Defaults = ['epicParent', 'sprint', 'affects', 'fixVersions'];
  const row3Defaults = ['environment', 'labels'];
  const contentDefaults = ['description', 'timeTracking', 'children', 'pullRequests', 'attachments', 'comments'];
  const peopleDefaults = ['reporter', 'assignee'];

  const row1 = row1Defaults.filter(f => displayFields[f]);
  const row2 = row2Defaults.filter(f => displayFields[f]);
  const row3 = row3Defaults.filter(f => displayFields[f]);
  const contentBlocks = contentDefaults.filter(f => displayFields[f]);
  const people = peopleDefaults.filter(f => displayFields[f]);

  return { row1, row2, row3, contentBlocks, people };
}

export const QUICKVIEW_ACTIVATION_MODES = ['hover', 'hover-modifier', 'click'];

export function resolveQuickViewActivationMode(settings = {}) {
  const configuredMode = String(settings.activationMode || '').trim();
  if (QUICKVIEW_ACTIVATION_MODES.includes(configuredMode)) return configuredMode;
  if (settings.openQuickViewOnClick === true) return 'click';
  const hasLegacyActivation = Object.prototype.hasOwnProperty.call(settings, 'openQuickViewOnClick')
    || Object.prototype.hasOwnProperty.call(settings, 'hoverModifierKey');
  if (hasLegacyActivation) {
    return String(settings.hoverModifierKey || '').trim() === 'none' ? 'hover' : 'hover-modifier';
  }
  return 'click';
}

export default {
  domains: [],
  instanceUrl: '',
  themeMode: 'system',
  v15upgrade: false,
  customFields: [],
  activationMode: 'click',
  hoverDepth: 'exact',
  hoverModifierKey: 'any',
  inlineCopyButtons: true,
  openQuickViewOnClick: false,
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
    children: true,
    reporter: true,
    assignee: true,
    pullRequests: true,
    timeTracking: true
  },
  tooltipLayout: {
    row1: ['issueType', 'status', 'priority'],
    row2: ['epicParent', 'sprint', 'affects', 'fixVersions'],
    row3: ['environment', 'labels'],
    contentBlocks: ['description', 'timeTracking', 'children', 'pullRequests', 'attachments', 'comments'],
    people: ['reporter', 'assignee']
  }
};
