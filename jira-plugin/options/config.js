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
export const QUICKVIEW_HOVER_MODES = ['off', 'automatic', 'modifier'];
export const QUICKVIEW_MODIFIER_KEYS = ['alt', 'ctrl', 'shift', 'any'];

export function resolveQuickViewActivation(settings = {}) {
  const hasOwn = key => Object.prototype.hasOwnProperty.call(settings, key);
  const legacyMode = String(settings.activationMode || '').trim();
  const configuredHoverMode = String(settings.hoverActivationMode || '').trim();
  const configuredModifier = String(settings.hoverModifierKey || '').trim();

  let hoverActivationMode = 'automatic';
  if (hasOwn('hoverActivationMode') && QUICKVIEW_HOVER_MODES.includes(configuredHoverMode)) {
    hoverActivationMode = configuredHoverMode;
  } else if (QUICKVIEW_ACTIVATION_MODES.includes(legacyMode)) {
    hoverActivationMode = legacyMode === 'hover'
      ? 'automatic'
      : legacyMode === 'hover-modifier' ? 'modifier' : 'off';
  } else if (hasOwn('hoverModifierKey')) {
    hoverActivationMode = configuredModifier === 'none' ? 'automatic' : 'modifier';
  }

  let openQuickViewOnClick = true;
  if (hasOwn('openQuickViewOnClick')) {
    openQuickViewOnClick = settings.openQuickViewOnClick === true;
  } else if (QUICKVIEW_ACTIVATION_MODES.includes(legacyMode)) {
    openQuickViewOnClick = legacyMode === 'click';
  } else if (hasOwn('hoverModifierKey')) {
    openQuickViewOnClick = false;
  }

  return {
    openQuickViewOnClick,
    hoverActivationMode,
    hoverModifierKey: QUICKVIEW_MODIFIER_KEYS.includes(configuredModifier) ? configuredModifier : 'any',
  };
}

export default {
  domains: [],
  instanceUrl: '',
  themeMode: 'system',
  v15upgrade: false,
  customFields: [],
  openQuickViewOnClick: true,
  hoverActivationMode: 'automatic',
  hoverDepth: 'exact',
  hoverModifierKey: 'any',
  inlineCopyButtons: true,
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
